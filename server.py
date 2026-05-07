"""Shifty backend — Flask + (SQLite | Firestore) + Auth + Multi-week

ストレージは環境変数 STORAGE_BACKEND で切替:
  - STORAGE_BACKEND=sqlite  (default for local dev) — shifty.db を使用
  - STORAGE_BACKEND=firestore (Cloud Run) — Firestore を使用

Firestore レイアウト（VOIXA と同じ命名規則 'shifty/' プレフィクス）:
  shifty/state          (single doc) ... 全 state を JSON 化して保存
  shifty/config         (single doc) ... admin_pass_hash 等
  shifty_tokens/{sid}   (collection) ... staff_id をdoc id、{token: ...}
"""
import json
import os
import secrets
import sqlite3
import time as _time
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash

ROOT = Path(__file__).parent
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "sqlite").lower()
DB_PATH = Path(os.environ.get("DATABASE_PATH", ROOT / "shifty.db"))
# テナント分離用プレフィックス（multi-tenancy by deployment）
# 同一プロジェクト内で複数 Cloud Run サービスを別テナントとして運用するために使用
COLL_PREFIX = os.environ.get("STORAGE_COLLECTION_PREFIX", "shifty").strip().rstrip("/")
TENANT_NAME = os.environ.get("TENANT_NAME", "default")  # 表示用テナント名

app = Flask(__name__, static_folder=str(ROOT), static_url_path="")

# Sentry エラーモニタリング (DSN 未設定時は no-op)
SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
if SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.flask import FlaskIntegration
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            integrations=[FlaskIntegration()],
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
            environment=os.environ.get("FLASK_ENV", "production"),
            release=os.environ.get("APP_VERSION", "shifty"),
        )
        print(f"[sentry] enabled (env={os.environ.get('FLASK_ENV')})")
    except ImportError:
        print("[sentry] sentry-sdk not installed, skipping")

app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-CHANGE-IN-PRODUCTION")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
if os.environ.get("FLASK_ENV") == "production":
    app.config["SESSION_COOKIE_SECURE"] = True


# ============================================================
# Storage abstraction
# ============================================================

class _SQLiteStorage:
    def __init__(self):
        self._init()

    def _conn(self):
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        return c

    def _init(self):
        with self._conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS state (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS config (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS staff_tokens (
                  staff_id TEXT PRIMARY KEY,
                  token TEXT UNIQUE NOT NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                """
            )

    def get_state(self):
        with self._conn() as c:
            row = c.execute("SELECT value FROM state WHERE key='main'").fetchone()
        return json.loads(row["value"]) if row else None

    def save_state(self, state):
        with self._conn() as c:
            c.execute(
                "INSERT INTO state (key, value, updated_at) VALUES ('main', ?, datetime('now')) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (json.dumps(state, ensure_ascii=False),),
            )

    def reset(self):
        with self._conn() as c:
            c.execute("DELETE FROM state")
            c.execute("DELETE FROM staff_tokens")

    def get_config(self, key, default=None):
        with self._conn() as c:
            row = c.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_config(self, key, value):
        with self._conn() as c:
            c.execute(
                "INSERT INTO config (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def get_token(self, staff_id):
        with self._conn() as c:
            row = c.execute("SELECT token FROM staff_tokens WHERE staff_id=?", (staff_id,)).fetchone()
        return row["token"] if row else None

    def lookup_staff_by_token(self, token):
        with self._conn() as c:
            row = c.execute("SELECT staff_id FROM staff_tokens WHERE token=?", (token,)).fetchone()
        return row["staff_id"] if row else None

    def add_token(self, staff_id, token):
        with self._conn() as c:
            c.execute("INSERT INTO staff_tokens (staff_id, token) VALUES (?, ?)", (staff_id, token))

    def list_tokens(self):
        with self._conn() as c:
            rows = c.execute("SELECT staff_id, token FROM staff_tokens").fetchall()
        return {r["staff_id"]: r["token"] for r in rows}

    def delete_token(self, staff_id):
        with self._conn() as c:
            c.execute("DELETE FROM staff_tokens WHERE staff_id=?", (staff_id,))

    def replace_tokens(self, mapping):
        with self._conn() as c:
            c.execute("DELETE FROM staff_tokens")
            for sid, tok in mapping.items():
                c.execute("INSERT OR REPLACE INTO staff_tokens (staff_id, token) VALUES (?, ?)", (sid, tok))


class _FirestoreStorage:
    """VOIXA と同じく google-cloud-firestore を使用"""

    def __init__(self):
        from google.cloud import firestore
        self._fs = firestore.Client()
        # COLL_PREFIX により同一プロジェクトで複数テナントを分離
        self._state_ref = self._fs.collection(COLL_PREFIX).document("state")
        self._config_ref = self._fs.collection(COLL_PREFIX).document("config")
        self._tokens_col = self._fs.collection(COLL_PREFIX + "_tokens")

    def get_state(self):
        snap = self._state_ref.get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        return data.get("data")

    def save_state(self, state):
        self._state_ref.set({"data": state})

    def reset(self):
        self._state_ref.delete()
        # Delete all tokens
        for doc in self._tokens_col.stream():
            doc.reference.delete()

    def get_config(self, key, default=None):
        snap = self._config_ref.get()
        if not snap.exists:
            return default
        return (snap.to_dict() or {}).get(key, default)

    def set_config(self, key, value):
        self._config_ref.set({key: value}, merge=True)

    def get_token(self, staff_id):
        snap = self._tokens_col.document(staff_id).get()
        return (snap.to_dict() or {}).get("token") if snap.exists else None

    def lookup_staff_by_token(self, token):
        # 双方向引きが必要な場合は逆引きクエリ
        q = self._tokens_col.where("token", "==", token).limit(1).stream()
        for doc in q:
            return doc.id
        return None

    def add_token(self, staff_id, token):
        self._tokens_col.document(staff_id).set({"token": token})

    def list_tokens(self):
        return {doc.id: (doc.to_dict() or {}).get("token") for doc in self._tokens_col.stream()}

    def delete_token(self, staff_id):
        self._tokens_col.document(staff_id).delete()

    def replace_tokens(self, mapping):
        # 既存全削除→挿入
        for doc in self._tokens_col.stream():
            doc.reference.delete()
        for sid, tok in mapping.items():
            self._tokens_col.document(sid).set({"token": tok})


def _make_storage():
    if STORAGE_BACKEND == "firestore":
        return _FirestoreStorage()
    return _SQLiteStorage()


storage = _make_storage()


def bootstrap_admin_pass():
    if storage.get_config("admin_pass_hash"):
        return
    env_pass = os.environ.get("ADMIN_PASS")
    if env_pass:
        storage.set_config("admin_pass_hash", generate_password_hash(env_pass))


# ============================================================
# Email (Gmail SMTP) — 問い合わせ通知 + 自動返信
# ============================================================
GMAIL_USER = os.environ.get("GMAIL_USER", "support@in-dx.jp")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD")
NOTIFY_TO = os.environ.get("NOTIFY_TO", "support@in-dx.jp")


def send_email(to_addr: str, subject: str, body: str, reply_to: str = None) -> bool:
    """Gmail SMTP で送信。GMAIL_APP_PASSWORD 未設定なら no-op."""
    if not GMAIL_APP_PASSWORD:
        print(f"[email] skipped (no GMAIL_APP_PASSWORD): to={to_addr} subject={subject}")
        return False
    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.utils import formataddr

        msg = MIMEText(body, "plain", "utf-8")
        msg["From"] = formataddr(("飲DX Shifty", GMAIL_USER))
        msg["To"] = to_addr
        msg["Subject"] = subject
        if reply_to:
            msg["Reply-To"] = reply_to

        with smtplib.SMTP("smtp.gmail.com", 587, timeout=10) as s:
            s.starttls()
            s.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            s.send_message(msg)
        print(f"[email] sent to {to_addr}: {subject}")
        return True
    except Exception as e:
        print(f"[email] send failed to {to_addr}: {e}")
        return False


# ============================================================
# Template rendering (環境変数を HTML に注入)
# ============================================================
def _render_html(filename: str) -> str:
    text = (ROOT / filename).read_text(encoding="utf-8")
    text = text.replace("__GA_ID__", os.environ.get("GA_MEASUREMENT_ID", ""))
    text = text.replace("__SITE_URL__", os.environ.get("SITE_URL", "https://shifty.in-dx.jp"))
    text = text.replace("__SENTRY_DSN_FRONTEND__", os.environ.get("SENTRY_DSN_FRONTEND", ""))
    return text


# ============================================================
# Security headers
# ============================================================
@app.after_request
def add_security_headers(resp):
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' "
        "  https://cdn.tailwindcss.com https://cdn.jsdelivr.net "
        "  https://www.googletagmanager.com https://www.google-analytics.com "
        "  https://js.stripe.com; "
        "script-src-elem 'self' 'unsafe-inline' "
        "  https://cdn.tailwindcss.com https://cdn.jsdelivr.net "
        "  https://www.googletagmanager.com https://www.google-analytics.com "
        "  https://js.stripe.com; "
        "style-src 'self' 'unsafe-inline' "
        "  https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "style-src-elem 'self' 'unsafe-inline' "
        "  https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "img-src 'self' data: https:; "
        "connect-src 'self' "
        "  https://cdn.tailwindcss.com https://cdn.jsdelivr.net "
        "  https://www.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com "
        "  https://api.stripe.com "
        "  https://*.ingest.sentry.io https://*.sentry.io; "
        "frame-src 'self' https://js.stripe.com https://hooks.stripe.com; "
        "worker-src 'self' blob:; "
        "child-src 'self' blob:; "
        "frame-ancestors 'none';"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    return resp


# ============================================================
# Login attempt rate limit (in-memory; Cloud Run cold start で消えるが許容)
# ============================================================
_login_attempts = {}
LOCK_AFTER = 5
LOCK_DURATION_SEC = 300


def _client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()


def _is_locked(ip):
    rec = _login_attempts.get(ip)
    if not rec:
        return False, 0
    cnt, locked_until = rec
    if locked_until and _time.time() < locked_until:
        return True, int(locked_until - _time.time())
    return False, 0


def _record_failure(ip):
    rec = _login_attempts.get(ip, (0, 0))
    cnt = rec[0] + 1
    locked_until = _time.time() + LOCK_DURATION_SEC if cnt >= LOCK_AFTER else 0
    _login_attempts[ip] = (cnt, locked_until)


def _record_success(ip):
    _login_attempts.pop(ip, None)


# ============================================================
# Auth
# ============================================================
def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("authenticated"):
            return jsonify({"error": "unauthenticated"}), 401
        return f(*args, **kwargs)
    return wrapper


@app.get("/api/auth/status")
def auth_status():
    bootstrap_admin_pass()
    return jsonify({
        "authenticated": bool(session.get("authenticated")),
        "setupRequired": storage.get_config("admin_pass_hash") is None,
    })


@app.post("/api/auth/setup")
def auth_setup():
    if storage.get_config("admin_pass_hash"):
        return jsonify({"error": "already_setup"}), 400
    payload = request.get_json(force=True)
    pwd = payload.get("password", "")
    if len(pwd) < 6:
        return jsonify({"error": "password_too_short", "minLength": 6}), 400
    storage.set_config("admin_pass_hash", generate_password_hash(pwd))
    session["authenticated"] = True
    return jsonify({"ok": True})


@app.post("/api/auth/login")
def auth_login():
    ip = _client_ip()
    locked, remaining = _is_locked(ip)
    if locked:
        return jsonify({"error": "locked", "retryAfter": remaining}), 429
    payload = request.get_json(force=True)
    pwd = payload.get("password", "")
    stored = storage.get_config("admin_pass_hash")
    if not stored or not check_password_hash(stored, pwd):
        _record_failure(ip)
        rec = _login_attempts.get(ip, (0, 0))
        return jsonify({
            "error": "invalid_password",
            "attemptsLeft": max(0, LOCK_AFTER - rec[0]),
        }), 401
    _record_success(ip)
    session["authenticated"] = True
    session.permanent = True
    return jsonify({"ok": True})


@app.post("/api/auth/logout")
def auth_logout():
    session.pop("authenticated", None)
    return jsonify({"ok": True})


@app.post("/api/auth/change-password")
@require_auth
def auth_change_pass():
    payload = request.get_json(force=True)
    cur = payload.get("current", "")
    new = payload.get("new", "")
    stored = storage.get_config("admin_pass_hash")
    if not stored or not check_password_hash(stored, cur):
        return jsonify({"error": "invalid_current"}), 401
    if len(new) < 6:
        return jsonify({"error": "password_too_short", "minLength": 6}), 400
    storage.set_config("admin_pass_hash", generate_password_hash(new))
    return jsonify({"ok": True})


# ============================================================
# 自動スナップショット（Cloud Scheduler から呼ばれる内部 API）
# ============================================================
INTERNAL_SECRET_TOKEN = os.environ.get("SYNC_SECRET_TOKEN", "")


def _check_internal_token():
    """Cloud Scheduler のリクエストかチェック"""
    return request.headers.get("X-Sync-Token", "") == INTERNAL_SECRET_TOKEN if INTERNAL_SECRET_TOKEN else True


@app.post("/internal/snapshot")
def api_snapshot():
    """日次スナップショット（Cloud Scheduler から呼ばれる）"""
    if not _check_internal_token():
        return jsonify({"error": "unauthorized"}), 401
    state = storage.get_state()
    if state is None:
        return jsonify({"ok": True, "skipped": "no_state"})
    import datetime as _dt
    today = _dt.datetime.utcnow().strftime("%Y-%m-%d")
    record = {
        "date": today,
        "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
        "state": state,
        "tokens": storage.list_tokens(),
    }
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            _client.collection(COLL_PREFIX + "_snapshots").document(today).set(record)
            # 30日より古い snapshot を削除
            cutoff = (_dt.datetime.utcnow() - _dt.timedelta(days=30)).strftime("%Y-%m-%d")
            old_docs = _client.collection(COLL_PREFIX + "_snapshots").where("date", "<", cutoff).stream()
            deleted = 0
            for d in old_docs:
                d.reference.delete()
                deleted += 1
            return jsonify({"ok": True, "snapshotDate": today, "deletedOld": deleted})
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("CREATE TABLE IF NOT EXISTS snapshots (date TEXT PRIMARY KEY, data TEXT)")
                c.execute("INSERT OR REPLACE INTO snapshots (date, data) VALUES (?, ?)",
                          (today, json.dumps(record, ensure_ascii=False)))
            return jsonify({"ok": True, "snapshotDate": today})
    except Exception as e:
        print(f"[snapshot] failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.get("/api/admin/snapshots")
@require_auth
def api_list_snapshots():
    """過去スナップショット一覧を取得"""
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            docs = _client.collection(COLL_PREFIX + "_snapshots").order_by("date", direction=_fs.Query.DESCENDING).limit(30).stream()
            return jsonify([
                {"date": d.id, "createdAt": (d.to_dict() or {}).get("createdAt")}
                for d in docs
            ])
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.row_factory = sqlite3.Row
                rows = c.execute("SELECT date FROM snapshots ORDER BY date DESC LIMIT 30").fetchall()
            return jsonify([{"date": r["date"]} for r in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/admin/snapshots/<date>/restore")
@require_auth
def api_restore_snapshot(date):
    """過去スナップショットから復元"""
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            doc = _client.collection(COLL_PREFIX + "_snapshots").document(date).get()
            if not doc.exists:
                return jsonify({"error": "not_found"}), 404
            data = doc.to_dict() or {}
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.row_factory = sqlite3.Row
                row = c.execute("SELECT data FROM snapshots WHERE date = ?", (date,)).fetchone()
            if not row:
                return jsonify({"error": "not_found"}), 404
            data = json.loads(row["data"])
        if data.get("state"):
            storage.save_state(data["state"])
        if data.get("tokens"):
            storage.replace_tokens(data["tokens"])
        return jsonify({"ok": True, "restoredFrom": date})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# スタッフ → 店長 メッセージ
# ============================================================
@app.post("/api/portal/<token>/message")
def api_portal_message(token):
    """スタッフポータルから店長への連絡"""
    staff_id = storage.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    payload = request.get_json(force=True) or {}
    msg = (payload.get("message") or "").strip()
    kind = (payload.get("kind") or "general").strip()  # general / change_request / question / report
    if not msg or len(msg) > 2000:
        return jsonify({"error": "invalid_message"}), 400

    state = storage.get_state()
    staff = next((s for s in (state.get("staff") or []) if s["id"] == staff_id), None) if state else None
    if not staff:
        return jsonify({"error": "staff_not_found"}), 404

    import datetime as _dt
    record = {
        "staffId": staff_id,
        "staffName": staff.get("name", ""),
        "kind": kind,
        "message": msg,
        "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
        "read": False,
    }
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            _client.collection(COLL_PREFIX + "_staff_messages").add(record)
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("CREATE TABLE IF NOT EXISTS staff_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, created_at TEXT DEFAULT (datetime('now')))")
                c.execute("INSERT INTO staff_messages (data) VALUES (?)", (json.dumps(record, ensure_ascii=False),))
    except Exception as e:
        print(f"[staff-msg] persist failed: {e}")

    # 店長へメール通知
    KIND_LABEL = {"general": "連絡", "change_request": "シフト変更希望", "question": "質問", "report": "報告"}
    send_email(
        to_addr=NOTIFY_TO,
        subject=f"【Shifty】{KIND_LABEL.get(kind, '連絡')}: {staff.get('name', '?')}",
        body=f"スタッフ「{staff.get('name', '?')}」から{KIND_LABEL.get(kind, '連絡')}が届きました。\n\n{msg}\n\n---\n受信日時: {record['createdAt']}",
    )
    return jsonify({"ok": True})


@app.get("/api/admin/staff_messages")
@require_auth
def api_list_staff_messages():
    """店長: 受信したスタッフメッセージ一覧"""
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            docs = _client.collection(COLL_PREFIX + "_staff_messages").order_by("createdAt", direction=_fs.Query.DESCENDING).limit(100).stream()
            return jsonify([{**(d.to_dict() or {}), "id": d.id} for d in docs])
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.row_factory = sqlite3.Row
                rows = c.execute("SELECT id, data FROM staff_messages ORDER BY id DESC LIMIT 100").fetchall()
            out = []
            for r in rows:
                rec = json.loads(r["data"])
                rec["id"] = r["id"]
                out.append(rec)
            return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# Stripe Checkout (環境変数未設定時は dormant)
# ============================================================
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICES = {
    "starter":  os.environ.get("STRIPE_PRICE_STARTER",  ""),
    "standard": os.environ.get("STRIPE_PRICE_STANDARD", ""),
    "pro":      os.environ.get("STRIPE_PRICE_PRO",      ""),
}


def _stripe_client():
    """stripe ライブラリを遅延 import。未インストール / 未設定なら None を返す。"""
    if not STRIPE_SECRET_KEY:
        return None
    try:
        import stripe
        stripe.api_key = STRIPE_SECRET_KEY
        return stripe
    except ImportError:
        return None


@app.post("/api/checkout/session")
def api_checkout_session():
    """LP の「無料トライアル」CTA から呼ばれる。Stripe Checkout Session を作成して URL を返す。"""
    stripe_lib = _stripe_client()
    if not stripe_lib:
        return jsonify({"error": "stripe_not_configured", "fallback": "/#contact"}), 503
    payload = request.get_json(force=True) or {}
    plan = payload.get("plan", "standard")
    price_id = STRIPE_PRICES.get(plan)
    if not price_id:
        return jsonify({"error": "invalid_plan"}), 400
    site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
    try:
        sess = stripe_lib.checkout.Session.create(
            mode="subscription",
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            subscription_data={"trial_period_days": 14},
            success_url=site + "/app?welcome=1",
            cancel_url=site + "/#pricing",
            customer_email=payload.get("email"),
            metadata={
                "restaurantName": payload.get("restaurantName", ""),
                "contactName": payload.get("contactName", ""),
                "plan": plan,
            },
        )
        return jsonify({"url": sess.url})
    except Exception as e:
        print(f"[stripe] checkout failed: {e}")
        return jsonify({"error": "stripe_error", "detail": str(e)}), 500


@app.post("/api/stripe/webhook")
def api_stripe_webhook():
    """Stripe からの subscription イベントを Firestore に記録。"""
    stripe_lib = _stripe_client()
    if not stripe_lib or not STRIPE_WEBHOOK_SECRET:
        return jsonify({"error": "stripe_not_configured"}), 503
    payload = request.data
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe_lib.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        print(f"[stripe] webhook signature failed: {e}")
        return jsonify({"error": "invalid_signature"}), 400

    obj = event["data"]["object"]
    et = event["type"]
    record = {
        "type": et,
        "customerId": obj.get("customer", ""),
        "subscriptionId": obj.get("id") if et.startswith("customer.subscription") else obj.get("subscription", ""),
        "email": obj.get("customer_email", "") or (obj.get("customer_details") or {}).get("email", ""),
        "status": obj.get("status", ""),
        "metadata": obj.get("metadata", {}) or {},
        "raw_event_id": event.get("id"),
        "received_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            _client.collection(COLL_PREFIX + "_subscriptions").add(record)
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("CREATE TABLE IF NOT EXISTS subs (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, created_at TEXT DEFAULT (datetime('now')))")
                c.execute("INSERT INTO subs (data) VALUES (?)", (json.dumps(record, ensure_ascii=False),))
    except Exception as e:
        print(f"[stripe] persist failed: {e}")

    # 重要イベントなら通知
    if et in ("checkout.session.completed", "customer.subscription.deleted"):
        send_email(
            to_addr=NOTIFY_TO,
            subject=f"【Shifty/Stripe】{et}: {record['email']}",
            body=f"Stripe イベント: {et}\nメール: {record['email']}\n顧客ID: {record['customerId']}\nstatus: {record['status']}\nmetadata: {record['metadata']}\n",
        )

    return jsonify({"ok": True})


# ============================================================
# Shift change notification (公開: 確定後にスタッフへメール送信)
# ============================================================
@app.post("/api/admin/notify_shifts")
@require_auth
def api_notify_shifts():
    """指定週のシフトを各スタッフ（email 設定者のみ）に送信。"""
    payload = request.get_json(force=True) or {}
    week_start = payload.get("weekStart")
    if not week_start:
        return jsonify({"error": "missing_weekStart"}), 400
    state = storage.get_state()
    if not state:
        return jsonify({"error": "no_state"}), 404
    week = (state.get("weeks") or {}).get(week_start)
    if not week:
        return jsonify({"error": "week_not_found"}), 404

    meta = state.get("meta", {})
    restaurant = meta.get("restaurantName", "")
    positions = {p["id"]: p for p in meta.get("positions", [])}
    sessions = meta.get("sessions", [])

    DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"]
    import datetime as _dt

    def fmt_date(s):
        d = _dt.datetime.strptime(s, "%Y-%m-%d")
        return f"{s} ({DAY_LABELS[d.weekday() if d.weekday() < 6 else (d.weekday() + 1) % 7]})"  # ISO Mon=0
    # 上の曜日計算は雑なので、再計算
    def jp_dow(s):
        d = _dt.datetime.strptime(s, "%Y-%m-%d")
        return DAY_LABELS[d.isoweekday() % 7]  # Sun=0

    sent, skipped, errors = 0, 0, []
    for s in state.get("staff", []):
        email = (s.get("email") or "").strip()
        if not email:
            skipped += 1
            continue
        my = [a for a in week.get("assignments", []) if a.get("staffId") == s["id"]]
        my.sort(key=lambda a: (a.get("date", ""), a.get("startTime", "")))
        if not my:
            # 「今週はお休み」のメールも送る（任意）
            body_lines = [
                f"{s['name']} 様",
                "",
                f"{restaurant} の {week_start} 週シフトが確定いたしました。",
                "今週は出勤予定がありません（お休み）。",
                "",
                "ご質問は店長までお気軽にお声掛けください。",
            ]
        else:
            total_h = 0.0
            total_pay = 0.0
            lines = []
            for a in my:
                pos = positions.get(a["position"], {}).get("label", a["position"])
                start_h, start_m = map(int, a["startTime"].split(":"))
                end_h, end_m = map(int, a["endTime"].split(":"))
                h = ((end_h * 60 + end_m) - (start_h * 60 + start_m)) / 60
                total_h += h
                total_pay += a.get("cost", 0) or (s.get("hourlyWage", 0) * h)
                lines.append(
                    f"  {a['date']} ({jp_dow(a['date'])}) {a['startTime']}-{a['endTime']} {pos} ({h:.1f}h)"
                )
            body_lines = [
                f"{s['name']} 様",
                "",
                f"{restaurant} の {week_start} 週シフトが確定いたしました。",
                "",
                "【あなたの今週のシフト】",
                *lines,
                "",
                f"合計時間: {total_h:.1f}h",
                f"予定給与: ¥{int(total_pay):,}",
                "",
                "詳細はスタッフ用ポータルからご確認いただけます（店長から共有された URL）。",
                "ご質問は店長までお気軽にお声掛けください。",
            ]
        ok = send_email(
            to_addr=email,
            subject=f"【{restaurant}】{week_start} 週のシフトが確定しました",
            body="\n".join(body_lines),
        )
        if ok:
            sent += 1
        else:
            errors.append(email)

    return jsonify({"ok": True, "sent": sent, "skipped_no_email": skipped, "errors": errors})


# ============================================================
# State
# ============================================================
@app.get("/api/state")
@require_auth
def api_get_state():
    return jsonify(storage.get_state())


@app.post("/api/state")
@require_auth
def api_save_state():
    payload = request.get_json(force=True)
    storage.save_state(payload)
    return jsonify({"ok": True})


@app.post("/api/admin/reset")
@require_auth
def api_reset():
    storage.reset()
    return jsonify({"ok": True})


@app.get("/api/admin/backup")
@require_auth
def api_backup():
    import datetime as _dt
    return jsonify({
        "version": 1,
        "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
        "state": storage.get_state(),
        "tokens": storage.list_tokens(),
        "backend": STORAGE_BACKEND,
    })


@app.post("/api/admin/restore")
@require_auth
def api_restore():
    payload = request.get_json(force=True)
    if not isinstance(payload, dict) or "state" not in payload:
        return jsonify({"error": "invalid_backup"}), 400
    state = payload["state"]
    if not isinstance(state, dict) or "meta" not in state or "staff" not in state:
        return jsonify({"error": "invalid_state"}), 400
    storage.save_state(state)
    tokens = payload.get("tokens") or {}
    storage.replace_tokens(tokens)
    return jsonify({"ok": True, "tokensRestored": len(tokens)})


# ============================================================
# Tokens
# ============================================================
@app.post("/api/admin/staff/<staff_id>/token")
@require_auth
def api_gen_token(staff_id):
    existing = storage.get_token(staff_id)
    if existing:
        return jsonify({"token": existing, "created": False})
    token = secrets.token_urlsafe(10)
    storage.add_token(staff_id, token)
    return jsonify({"token": token, "created": True})


@app.get("/api/admin/staff/tokens")
@require_auth
def api_list_tokens():
    return jsonify(storage.list_tokens())


@app.delete("/api/admin/staff/<staff_id>/token")
@require_auth
def api_revoke_token(staff_id):
    storage.delete_token(staff_id)
    return jsonify({"ok": True})


# ============================================================
# Public portal (token-auth)
# ============================================================
@app.get("/api/portal/<token>")
def api_portal_get(token):
    staff_id = storage.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    state = storage.get_state()
    if state is None:
        return jsonify({"error": "no_state"}), 404
    staff = next((s for s in state.get("staff", []) if s["id"] == staff_id), None)
    if not staff:
        return jsonify({"error": "staff_not_found"}), 404
    meta = state.get("meta", {})
    current_wk = meta.get("currentWeekStart")
    weeks = state.get("weeks") or {}
    week_data = weeks.get(current_wk, {})
    prefs = [p for p in week_data.get("preferences", []) if p["staffId"] == staff_id]
    assignments = [a for a in week_data.get("assignments", []) if a["staffId"] == staff_id]
    return jsonify({
        "staff": staff,
        "preferences": prefs,
        "assignments": assignments,
        "weekStart": current_wk,
        "weekStatus": week_data.get("status", "draft"),
        "publishedAt": week_data.get("publishedAt"),
        "restaurantName": meta.get("restaurantName", ""),
        "sessions": meta.get("sessions", []),
        "positions": meta.get("positions", []),
    })


@app.post("/api/portal/<token>/preferences")
def api_portal_save_prefs(token):
    staff_id = storage.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    new_prefs = request.get_json(force=True)
    if not isinstance(new_prefs, list):
        return jsonify({"error": "expected_list"}), 400
    state = storage.get_state()
    if state is None:
        return jsonify({"error": "no_state"}), 404
    meta = state.get("meta", {})
    current_wk = meta.get("currentWeekStart")
    weeks = state.setdefault("weeks", {})
    week = weeks.get(current_wk)
    if not week:
        return jsonify({"error": "no_current_week"}), 404
    if week.get("status") == "published":
        return jsonify({"error": "week_published_readonly"}), 403
    week["preferences"] = [p for p in week.get("preferences", []) if p["staffId"] != staff_id]
    for p in new_prefs:
        p["staffId"] = staff_id
    week["preferences"].extend(new_prefs)
    storage.save_state(state)
    return jsonify({"ok": True, "saved": len(new_prefs)})


# ============================================================
# Inquiry (公開: 問い合わせ受付)
# ============================================================
@app.post("/api/inquiry")
def api_inquiry():
    """ランディングページからの問い合わせを Firestore / SQLite に保存"""
    payload = request.get_json(force=True) or {}
    required = ["restaurantName", "contactName", "email"]
    if not all(payload.get(k) for k in required):
        return jsonify({"error": "missing_required_fields", "required": required}), 400
    # 簡易メール形式チェック
    email = (payload.get("email") or "").strip()
    if "@" not in email or "." not in email.split("@")[-1]:
        return jsonify({"error": "invalid_email"}), 400

    import datetime as _dt
    record = {
        "restaurantName": payload.get("restaurantName", "").strip()[:200],
        "contactName": payload.get("contactName", "").strip()[:100],
        "email": email[:200],
        "phone": (payload.get("phone") or "").strip()[:50],
        "staffCount": (payload.get("staffCount") or "").strip()[:20],
        "message": (payload.get("message") or "").strip()[:2000],
        "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
        "ip": _client_ip(),
        "userAgent": request.headers.get("User-Agent", "")[:300],
    }
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            _client.collection(COLL_PREFIX + "_inquiries").add(record)
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("""
                    CREATE TABLE IF NOT EXISTS inquiries (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        data TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                """)
                c.execute("INSERT INTO inquiries (data) VALUES (?)", (json.dumps(record, ensure_ascii=False),))
    except Exception as e:
        print(f"[inquiry] failed to persist: {e}")
        # 永続失敗してもメール送信は試みる

    # オーナーへ通知
    notify_body = (
        f"新規お問合せが届きました。\n\n"
        f"店舗名: {record['restaurantName']}\n"
        f"お名前: {record['contactName']}\n"
        f"メール: {record['email']}\n"
        f"電話  : {record['phone']}\n"
        f"スタッフ数: {record['staffCount']}\n\n"
        f"メッセージ:\n{record['message'] or '(なし)'}\n\n"
        f"---\n受信日時: {record['createdAt']}\n"
        f"IP      : {record['ip']}\nUA      : {record['userAgent']}\n"
    )
    send_email(
        to_addr=NOTIFY_TO,
        subject=f"【Shifty】お問合せ: {record['restaurantName']} / {record['contactName']}",
        body=notify_body,
        reply_to=record["email"],
    )

    # 応募者へ自動返信
    autoreply = (
        f"{record['contactName']} 様\n\n"
        f"このたびは Shifty にお問合せいただき、誠にありがとうございます。\n"
        f"内容を確認のうえ、1 営業日以内に support@in-dx.jp よりご連絡いたします。\n\n"
        f"――― 受付内容 ―――\n"
        f"店舗名 : {record['restaurantName']}\n"
        f"スタッフ数: {record['staffCount']}\n"
        f"メッセージ: {record['message'] or '(なし)'}\n"
        f"――――――――――――――\n\n"
        f"なお、その間にデモ環境を触っていただくこともできます:\n"
        f"https://shifty.in-dx.jp/demo\n\n"
        f"ご質問・お急ぎの場合は support@in-dx.jp までお気軽にご連絡ください。\n\n"
        f"飲DX\n"
        f"代表 柳下 征二郎\n"
        f"https://shifty.in-dx.jp\n"
    )
    send_email(
        to_addr=record["email"],
        subject="【Shifty】お問合せありがとうございます（受付完了）",
        body=autoreply,
    )
    return jsonify({"ok": True}), 201


@app.get("/api/admin/inquiries")
@require_auth
def api_list_inquiries():
    """オーナー専用: 問合せ一覧"""
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            _client = _fs.Client()
            docs = _client.collection(COLL_PREFIX + "_inquiries").order_by("createdAt", direction=_fs.Query.DESCENDING).limit(200).stream()
            return jsonify([{**(d.to_dict() or {}), "id": d.id} for d in docs])
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.row_factory = sqlite3.Row
                rows = c.execute("SELECT id, data, created_at FROM inquiries ORDER BY id DESC LIMIT 200").fetchall()
            out = []
            for r in rows:
                rec = json.loads(r["data"])
                rec["id"] = r["id"]
                out.append(rec)
            return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# Static — ルーティング: / = LP, /app = 管理画面, /staff = ポータル, /demo = デモ
# ============================================================
@app.get("/")
def index():
    html = _render_html("landing.html")
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@app.get("/app")
def admin_app():
    html = _render_html("index.html")
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@app.get("/demo")
def demo_app():
    html = _render_html("demo.html")
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@app.get("/staff")
def staff_portal():
    return send_from_directory(str(ROOT), "staff.html")


@app.get("/tos")
def tos_page():
    return send_from_directory(str(ROOT), "tos.html")


@app.get("/privacy")
def privacy_page():
    return send_from_directory(str(ROOT), "privacy.html")


@app.get("/tokushoho")
def tokushoho_page():
    return send_from_directory(str(ROOT), "tokushoho.html")


@app.get("/help")
def help_page():
    return send_from_directory(str(ROOT), "help.html")


# ============================================================
# SEO: sitemap.xml + robots.txt
# ============================================================
@app.get("/sitemap.xml")
def sitemap():
    site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
    paths = [
        ("/", "1.0", "weekly"),
        ("/tos", "0.3", "monthly"),
        ("/privacy", "0.3", "monthly"),
        ("/tokushoho", "0.3", "monthly"),
    ]
    items = "".join(
        f"<url><loc>{site}{p}</loc><priority>{pr}</priority><changefreq>{cf}</changefreq></url>"
        for p, pr, cf in paths
    )
    xml = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{items}</urlset>'
    return xml, 200, {"Content-Type": "application/xml; charset=utf-8"}


@app.get("/robots.txt")
def robots():
    site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
    txt = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /app\n"
        "Disallow: /staff\n"
        "Disallow: /demo\n"
        f"Sitemap: {site}/sitemap.xml\n"
    )
    return txt, 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.get("/tests/algorithm.test.html")
def test_page():
    """アルゴリズム自動テスト（オーナー検証用、URL直接でアクセス可）"""
    return send_from_directory(str(ROOT / "tests"), "algorithm.test.html")


@app.get("/docs/algorithm.md")
def algo_doc():
    """アルゴリズム仕様書（マークダウン素配信）"""
    return send_from_directory(str(ROOT / "docs"), "algorithm.md", mimetype="text/markdown; charset=utf-8")


@app.get("/healthz")
def healthz():
    return jsonify({
        "ok": True,
        "backend": STORAGE_BACKEND,
        "tenant": TENANT_NAME,
        "prefix": COLL_PREFIX,
    })


# ============================================================
# Boot
# ============================================================
bootstrap_admin_pass()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5173))
    app.run(host="127.0.0.1", port=port, debug=False)
