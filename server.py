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

# SECRET_KEY: 本番では必須。未設定なら起動を失敗させる（音もなく弱い既知デフォルトを使うのは危険）
_secret_key = os.environ.get("SECRET_KEY")
if not _secret_key:
    if os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("SECRET_KEY env var must be set in production. Refusing to start with dev fallback.")
    _secret_key = "dev-secret-CHANGE-IN-PRODUCTION"
    print("[warning] using insecure development SECRET_KEY (set FLASK_ENV=production for hard fail)")
app.config["SECRET_KEY"] = _secret_key
app.config["SESSION_COOKIE_HTTPONLY"] = True
# Strict にして CSRF 攻撃を構造的に防ぐ (admin 操作はアプリ内クリックのみ)
app.config["SESSION_COOKIE_SAMESITE"] = "Strict"
# セッション寿命を 7 日に短縮（デフォルト 31 日は長すぎる）
from datetime import timedelta as _td
app.config["PERMANENT_SESSION_LIFETIME"] = _td(days=7)
# リクエストボディ上限 5 MiB (大量 prefs / state 注入 DoS 対策)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
if os.environ.get("FLASK_ENV") == "production":
    app.config["SESSION_COOKIE_SECURE"] = True

# Cloud Run の GFE プロキシを 1 段挟む想定で X-Forwarded-* を信頼
# 信頼境界外で X-Forwarded-For を勝手に書ける構造を排除（H4 対策）
try:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
except Exception as _e:
    print(f"[warning] ProxyFix unavailable: {_e}")


# ============================================================
# Storage abstraction
# ============================================================

class _SQLiteStorage:
    def transactional_update(self, fn):
        # SQLite は単一プロセスなのでトランザクション簡略版で OK
        current = self.get_state()
        new_state = fn(current)
        self.save_state(new_state)
        return new_state

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

    def transactional_update(self, fn):
        """Firestore transaction で state を read-modify-write する。
        fn(current_state_dict_or_None) -> new_state_dict
        ロストアップデート防止 (Critical #4)。
        """
        from google.cloud import firestore as _fs
        client = self._fs
        ref = self._state_ref

        @_fs.transactional
        def _do(tx):
            snap = ref.get(transaction=tx)
            current = (snap.to_dict() or {}).get("data") if snap.exists else None
            new_state = fn(current)
            tx.set(ref, {"data": new_state})
            return new_state

        return _do(client.transaction())

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


class _FirestoreStorageScoped:
    """テナント単位で名前空間を分離した Firestore Storage."""

    def __init__(self, slug):
        from google.cloud import firestore
        self._fs = firestore.Client()
        self.slug = slug
        # tenants/{slug}/state, tenants/{slug}/config, tenants/{slug}_tokens
        # collection group が深いとクエリ複雑化するため、slug をプレフィックスに
        prefix = f"shifty_t_{slug}"
        self._state_ref = self._fs.collection(prefix).document("state")
        self._config_ref = self._fs.collection(prefix).document("config")
        self._tokens_col = self._fs.collection(f"{prefix}_tokens")

    def get_state(self):
        snap = self._state_ref.get()
        if not snap.exists:
            return None
        return (snap.to_dict() or {}).get("data")

    def save_state(self, state):
        self._state_ref.set({"data": state})

    def transactional_update(self, fn):
        from google.cloud import firestore as _fs
        client = self._fs
        ref = self._state_ref
        @_fs.transactional
        def _do(tx):
            snap = ref.get(transaction=tx)
            current = (snap.to_dict() or {}).get("data") if snap.exists else None
            new_state = fn(current)
            tx.set(ref, {"data": new_state})
            return new_state
        return _do(client.transaction())

    def reset(self):
        self._state_ref.delete()
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
        for doc in self._tokens_col.stream():
            doc.reference.delete()
        for sid, tok in mapping.items():
            self._tokens_col.document(sid).set({"token": tok})


# ============================================================
# Tenant Manager
# - Tenant 一覧 / 作成 / マジックリンク
# - tenants コレクションに各テナントの metadata を保持
# ============================================================
class TenantManager:
    def __init__(self):
        self._fs = None
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore
            self._fs = firestore.Client()
            self._col = self._fs.collection("tenants")
            # マジックリンクトークン用
            self._magic_col = self._fs.collection("magic_links")
        else:
            # SQLite はローカル開発用。tenants テーブル作成
            with sqlite3.connect(DB_PATH) as c:
                c.execute("""CREATE TABLE IF NOT EXISTS tenants (
                    slug TEXT PRIMARY KEY,
                    email TEXT NOT NULL,
                    contact_name TEXT,
                    restaurant_name TEXT,
                    status TEXT DEFAULT 'active',
                    plan TEXT DEFAULT 'free',
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT,
                    paid_until TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )""")
                c.execute("""CREATE TABLE IF NOT EXISTS magic_links (
                    token TEXT PRIMARY KEY,
                    slug TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used INTEGER DEFAULT 0
                )""")

    def get(self, slug):
        if not slug:
            return None
        if self._fs is not None:
            snap = self._col.document(slug).get()
            return snap.to_dict() if snap.exists else None
        with sqlite3.connect(DB_PATH) as c:
            c.row_factory = sqlite3.Row
            row = c.execute("SELECT * FROM tenants WHERE slug=?", (slug,)).fetchone()
            return dict(row) if row else None

    def create(self, slug, email, contact_name="", restaurant_name="", plan="free", stripe_customer_id="", stripe_subscription_id=""):
        import datetime as _dt
        rec = {
            "slug": slug,
            "email": email,
            "contactName": contact_name,
            "restaurantName": restaurant_name,
            "status": "active",
            "plan": plan,
            "stripeCustomerId": stripe_customer_id,
            "stripeSubscriptionId": stripe_subscription_id,
            "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
        }
        if self._fs is not None:
            self._col.document(slug).set(rec)
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute(
                    "INSERT OR REPLACE INTO tenants (slug,email,contact_name,restaurant_name,status,plan,stripe_customer_id,stripe_subscription_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (slug, email, contact_name, restaurant_name, "active", plan, stripe_customer_id, stripe_subscription_id, rec["createdAt"]),
                )
        return rec

    def list_all(self, limit=100):
        if self._fs is not None:
            return [doc.to_dict() for doc in self._col.limit(limit).stream()]
        with sqlite3.connect(DB_PATH) as c:
            c.row_factory = sqlite3.Row
            rows = c.execute("SELECT * FROM tenants ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    def issue_magic_link(self, slug, ttl_seconds=1800):
        """マジックリンクトークンを発行（30 分有効）。返値はトークン文字列。"""
        import datetime as _dt
        token = secrets.token_urlsafe(32)
        expires_at = int(_time.time()) + ttl_seconds
        if self._fs is not None:
            self._magic_col.document(token).set({
                "slug": slug,
                "expiresAt": expires_at,
                "used": False,
                "createdAt": _dt.datetime.utcnow().isoformat() + "Z",
            })
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("INSERT INTO magic_links (token,slug,expires_at,used) VALUES (?,?,?,0)",
                          (token, slug, expires_at))
        return token

    def consume_magic_link(self, token):
        """トークンを検証して slug を返す。Firestore transaction で atomic に 1 回限り消費 (Round 4 C4)。"""
        if not token:
            return None
        now = int(_time.time())
        if self._fs is not None:
            from google.cloud import firestore as _fs
            doc_ref = self._magic_col.document(token)
            client = self._fs

            # Firestore Transaction で TOCTOU 防止
            @_fs.transactional
            def _consume(tx):
                snap = doc_ref.get(transaction=tx)
                if not snap.exists:
                    return None
                data = snap.to_dict() or {}
                if data.get("used") or data.get("expiresAt", 0) < now:
                    return None
                tx.update(doc_ref, {
                    "used": True,
                    "usedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                })
                return data.get("slug")

            return _consume(client.transaction())
        # SQLite: BEGIN IMMEDIATE で行ロック
        with sqlite3.connect(DB_PATH) as c:
            c.row_factory = sqlite3.Row
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT * FROM magic_links WHERE token=? AND used=0 AND expires_at > ?", (token, now)).fetchone()
            if not row:
                return None
            c.execute("UPDATE magic_links SET used=1 WHERE token=?", (token,))
            return row["slug"]


_tenant_manager = None
def get_tenant_manager():
    global _tenant_manager
    if _tenant_manager is None:
        _tenant_manager = TenantManager()
    return _tenant_manager


def get_tenant_storage(slug):
    """slug 指定でテナント別 Storage を取得。"""
    if STORAGE_BACKEND == "firestore":
        return _FirestoreStorageScoped(slug)
    # SQLite はローカル開発用なので default のみサポート（slug 無視）
    return _SQLiteStorage()


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
    # ヘッダ injection (CRLF) 防止
    to_addr = (str(to_addr or "")).replace("\r", "").replace("\n", "")[:200]
    subject = (str(subject or "")).replace("\r", " ").replace("\n", " ")[:200]
    if reply_to:
        reply_to = (str(reply_to)).replace("\r", "").replace("\n", "")[:200]
    if not to_addr:
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
    # API は no-store、静的アセットは長めの cache (Flask デフォルトの no-cache を明示的に上書き)
    path = request.path or ""
    if path.startswith("/api/") or path.startswith("/auth/") or path.startswith("/internal/"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    elif path == "/og.png":
        resp.headers["Cache-Control"] = "public, max-age=86400"  # 24h
    elif path.endswith((".css", ".js", ".png", ".svg", ".webp", ".ico", ".woff2")):
        resp.headers["Cache-Control"] = "public, max-age=3600, must-revalidate"  # 1h
    return resp


# ============================================================
# Response 圧縮 (gzip)
# Cloud Run 自体は自動圧縮しないため Flask 側で。
# 1 KB 以上 + 圧縮対象 Content-Type のみ。
# ============================================================
import gzip as _gzip
import io as _io
@app.after_request
def gzip_response(resp):
    accept = (request.headers.get("Accept-Encoding") or "")
    if "gzip" not in accept:
        return resp
    if resp.status_code < 200 or resp.status_code >= 300:
        return resp
    if resp.headers.get("Content-Encoding"):
        return resp
    ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
    compressible = (
        ctype.startswith("text/")
        or ctype in ("application/javascript", "application/json", "application/xml", "image/svg+xml")
    )
    if not compressible:
        return resp
    # Flask の send_file は direct_passthrough=True なので解除して全データ取得
    resp.direct_passthrough = False
    try:
        data = resp.get_data()
    except Exception:
        return resp
    if len(data) < 1024:
        return resp
    buf = _io.BytesIO()
    with _gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        gz.write(data)
    compressed = buf.getvalue()
    resp.set_data(compressed)
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Content-Length"] = str(len(compressed))
    # Vary に Accept-Encoding 追加（中間 cache 用）
    vary = resp.headers.get("Vary", "")
    if "Accept-Encoding" not in vary:
        resp.headers["Vary"] = ("Accept-Encoding, " + vary) if vary else "Accept-Encoding"
    return resp


# ============================================================
# Login attempt rate limit (in-memory; Cloud Run cold start で消えるが許容)
# ============================================================
_login_attempts = {}
LOCK_AFTER = 5
LOCK_DURATION_SEC = 300

# 未セットアップ時の timing 等化用ダミーハッシュ (起動時に 1 回計算)
_DUMMY_PASS_HASH = generate_password_hash("__shifty_timing_equalize_dummy__")


def _client_ip():
    # ProxyFix が ProxyFix(x_for=1) で 1 段だけの XFF を信頼するように補正済。
    # Cloud Run の前段 GFE が信頼でき、それより外側の偽装ヘッダは捨てられる。
    return (request.remote_addr or "?")


# ============================================================
# 公開エンドポイント用の汎用レート制限 (in-memory)
# 攻撃面: /api/inquiry, /api/portal/{token}/message, /api/checkout/session
# ============================================================
_rate_buckets = {}  # key=(name, ip) -> [count, window_start]
RATE_DEFAULTS = {
    "inquiry": (5, 60),     # 60 秒に 5 回
    "portal_msg": (10, 60), # 60 秒に 10 回
    "checkout": (10, 60),   # 60 秒に 10 回
}


def _rate_check(name, limit_window=None):
    """超過時 True を返す（=拒否）"""
    if limit_window is None:
        limit_window = RATE_DEFAULTS.get(name, (30, 60))
    limit, window = limit_window
    ip = _client_ip()
    key = (name, ip)
    now = _time.time()
    rec = _rate_buckets.get(key)
    if not rec or now - rec[1] > window:
        _rate_buckets[key] = [1, now]
        return False
    rec[0] += 1
    if rec[0] > limit:
        return True
    return False


# ============================================================
# メールヘッダ injection 防止
# ============================================================
def _safe_header(s, maxlen=200):
    """件名・宛先などに使う文字列から CR/LF を除去"""
    return (str(s or "")).replace("\r", " ").replace("\n", " ")[:maxlen]


# ============================================================
# 安全な JSON ペイロード取得
# ============================================================
def _get_json(silent=True, default=None):
    """request.get_json の安全ラッパ。型が dict 以外なら default にフォールバック。"""
    try:
        v = request.get_json(force=True, silent=silent)
        if isinstance(v, dict):
            return v
    except Exception:
        pass
    return default if default is not None else {}


# ============================================================
# テナント slug バリデーション
# ============================================================
import re as _re
_SLUG_RE = _re.compile(r"^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$")


def _valid_slug(slug):
    return bool(slug) and bool(_SLUG_RE.match(slug))


def _generate_slug(seed=""):
    """利用可能な slug を生成（衝突回避）。"""
    base = _re.sub(r"[^a-z0-9-]", "-", (seed or "").lower())[:20].strip("-")
    if len(base) < 3:
        base = "shop"
    tm = get_tenant_manager()
    for _ in range(50):
        suffix = secrets.token_urlsafe(4).lower().replace("_", "").replace("-", "")[:6]
        candidate = f"{base}-{suffix}" if base else suffix
        candidate = candidate[:32].strip("-")
        if _valid_slug(candidate) and tm.get(candidate) is None:
            return candidate
    # Fallback - random
    return "shop-" + secrets.token_urlsafe(6).lower().replace("_", "").replace("-", "")[:8]


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
    """legacy single-tenant 管理 API 用認証。
    重要: tenant_slug を持つセッション（multi-tenant ユーザ）は拒否する。
    Round 4 監査 C1: クロステナント特権昇格防止。"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("authenticated"):
            return jsonify({"error": "unauthenticated"}), 401
        # tenant 経由でログインしたユーザは legacy admin API にアクセス不可
        if session.get("tenant_slug"):
            return jsonify({"error": "forbidden_legacy_admin"}), 403
        return f(*args, **kwargs)
    return wrapper


def require_tenant_admin(slug_param="slug"):
    """tenant 用認証デコレータ。指定 tenant のセッションでなければ 401/403。
    URL パスから slug を受け取り、session の tenant_slug と照合。"""
    def deco(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            slug = kwargs.get(slug_param)
            if not _valid_slug(slug or ""):
                return jsonify({"error": "invalid_slug"}), 400
            if not session.get("authenticated"):
                return jsonify({"error": "unauthenticated"}), 401
            if session.get("tenant_slug") != slug:
                return jsonify({"error": "tenant_mismatch"}), 403
            # tenant の active 状態確認 (H2 修正)
            tm = get_tenant_manager()
            tenant = tm.get(slug)
            if not tenant:
                return jsonify({"error": "tenant_not_found"}), 404
            if tenant.get("status") not in (None, "active"):
                return jsonify({"error": "tenant_disabled"}), 403
            return f(*args, **kwargs)
        return wrapper
    return deco


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
    payload = _get_json()
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
    payload = _get_json()
    pwd = payload.get("password", "")
    stored = storage.get_config("admin_pass_hash")
    if not stored:
        # 真の bcrypt 計算で timing 一致させる（不正フォーマット dummy では即 False で時間漏洩する）
        check_password_hash(_DUMMY_PASS_HASH, pwd)
        _record_failure(ip)
        rec = _login_attempts.get(ip, (0, 0))
        return jsonify({"error": "setup_required", "attemptsLeft": max(0, LOCK_AFTER - rec[0])}), 401
    if not check_password_hash(stored, pwd):
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
    session.pop("tenant_slug", None)
    return jsonify({"ok": True})


# ============================================================
# Magic link 認証 (multi-tenant 対応)
# ============================================================

@app.post("/api/auth/magic-link/request")
def auth_magic_link_request():
    """email を受け取り、紐づく tenant にマジックリンクを送る。
    tenant が無い場合も同じレスポンスで返して enumeration 防止 (Round 4 C5: 時間差吸収)。"""
    if _rate_check("magic_link", limit_window=(5, 60)):
        return jsonify({"error": "rate_limited"}), 429
    payload = _get_json()
    email = (payload.get("email") or "").strip().lower()[:200]
    if not email or "@" not in email:
        return jsonify({"error": "invalid_email"}), 400
    tm = get_tenant_manager()
    # email から tenant を検索 (Firestore index で O(1)、SQLite は line scan)
    target_tenant = None
    if STORAGE_BACKEND == "firestore":
        from google.cloud import firestore as _fs
        client = _fs.Client()
        q = client.collection("tenants").where(filter=_fs.FieldFilter("email", "==", email)).limit(1).stream()
        for doc in q:
            target_tenant = doc.to_dict()
            break
    else:
        for t in tm.list_all(limit=500):
            if (t.get("email") or "").strip().lower() == email:
                target_tenant = t
                break

    # enumeration 対策: メール送信は非同期にして応答時間を一定化
    def _async_send():
        if target_tenant:
            try:
                token = tm.issue_magic_link(target_tenant["slug"])
                site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
                link = f"{site}/auth/verify?token={token}"
                send_email(
                    to_addr=_safe_header(email),
                    subject=_safe_header(f"【Shifty】ログインリンク（30 分有効）"),
                    body=(
                        f"{target_tenant.get('contactName', '') or 'お客様'} 様\n\n"
                        f"Shifty へのログインリンクをお送りします（30 分以内に開いてください）。\n\n"
                        f"{link}\n\n"
                        f"このメールに心当たりがない場合は無視していただいて問題ありません。\n"
                        f"---\n飲DX Shifty\nsupport@in-dx.jp\n"
                    ),
                )
            except Exception as e:
                print(f"[magic-link] async send failed: {e}")
    if target_tenant:
        import threading
        threading.Thread(target=_async_send, daemon=True).start()
    # 一定遅延 (200ms) を入れて enumeration 用タイミング攻撃の解像度を下げる
    _time.sleep(0.2)
    return jsonify({"ok": True, "message": "メールアドレスにログインリンクをお送りしました（届かない場合は迷惑メールフォルダもご確認ください）"})


@app.get("/auth/verify")
def auth_verify_get():
    """マジックリンクを開いた時の処理。検証 → セッション設定 → tenant ページへリダイレクト。"""
    token = request.args.get("token", "")
    tm = get_tenant_manager()
    slug = tm.consume_magic_link(token)
    if not slug:
        from flask import make_response
        body = '<!doctype html><html><head><meta charset="utf-8"><title>無効なリンク - Shifty</title><style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:24px;text-align:center;background:#f8fafc;color:#0f172a}.box{background:white;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:18px;margin-bottom:12px}p{font-size:13px;color:#475569;line-height:1.6}a{color:#4f46e5;text-decoration:underline}</style></head><body><div class="box"><div style="font-size:48px">⚠️</div><h1>このログインリンクは無効です</h1><p>リンクが期限切れ（30 分超過）または既に使用済みです。<br><a href="/login">ログイン画面でメールアドレスを再入力</a>してください。</p></div></body></html>'
        return make_response(body, 401)
    session.clear()
    session["authenticated"] = True
    session["tenant_slug"] = slug
    session.permanent = True
    return _redirect(f"/t/{slug}/app")


def _redirect(url, status=302):
    from flask import redirect
    return redirect(url, code=status)


@app.get("/login")
def login_page():
    """マジックリンク要求ページ"""
    return send_from_directory(str(ROOT), "login.html")


# ============================================================
# Tenant 専用 routes (path-based)
# ============================================================
@app.get("/t/<slug>/app")
def tenant_app(slug):
    if not _valid_slug(slug):
        return "Invalid tenant slug", 400
    return send_from_directory(str(ROOT), "index.html")


@app.get("/api/t/<slug>/auth/status")
def tenant_auth_status(slug):
    if not _valid_slug(slug):
        return jsonify({"error": "invalid_slug"}), 400
    tm = get_tenant_manager()
    tenant = tm.get(slug)
    if not tenant:
        return jsonify({"error": "tenant_not_found"}), 404
    authenticated = (
        session.get("authenticated")
        and session.get("tenant_slug") == slug
        and tenant.get("status") in (None, "active")
    )
    return jsonify({
        "authenticated": bool(authenticated),
        "tenant": {
            "slug": slug,
            "restaurantName": tenant.get("restaurantName", ""),
            "plan": tenant.get("plan", "free"),
            "status": tenant.get("status", "active"),
        },
    })


@app.get("/api/t/<slug>/state")
@require_tenant_admin()
def tenant_get_state(slug):
    s = get_tenant_storage(slug)
    return jsonify(s.get_state() or {})


@app.post("/api/t/<slug>/state")
@require_tenant_admin()
def tenant_save_state(slug):
    payload = _get_json()
    if not payload:
        return jsonify({"error": "expected_object"}), 400
    if "meta" in payload and not isinstance(payload["meta"], dict):
        return jsonify({"error": "invalid_meta"}), 400
    if "staff" in payload and not isinstance(payload["staff"], list):
        return jsonify({"error": "invalid_staff"}), 400
    if "weeks" in payload and not isinstance(payload["weeks"], dict):
        return jsonify({"error": "invalid_weeks"}), 400
    if "staff" in payload and len(payload["staff"]) > 1000:
        return jsonify({"error": "too_many_staff"}), 400
    s = get_tenant_storage(slug)
    expected_version = payload.get("_version")
    def _mutate(current):
        if expected_version is not None and current and current.get("_version") != expected_version:
            raise _ConflictError(current.get("_version"))
        new_state = dict(payload)
        new_state["_version"] = ((current or {}).get("_version", 0) + 1)
        return new_state
    try:
        result = s.transactional_update(_mutate)
        return jsonify({"ok": True, "version": result.get("_version")})
    except _ConflictError as ce:
        return jsonify({"error": "version_conflict", "currentVersion": ce.current_version}), 409


@app.post("/api/t/<slug>/auth/logout")
def tenant_logout(slug):
    if not _valid_slug(slug):
        return jsonify({"error": "invalid_slug"}), 400
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/auth/change-password")
@require_auth
def auth_change_pass():
    payload = _get_json()
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
    """Cloud Scheduler のリクエストかチェック (deny-by-default)。
    SYNC_SECRET_TOKEN 未設定時は常に拒否。本番で誤って公開されることを防ぐ。"""
    if not INTERNAL_SECRET_TOKEN:
        return False
    # 定数時間比較
    import hmac
    return hmac.compare_digest(
        request.headers.get("X-Sync-Token", ""),
        INTERNAL_SECRET_TOKEN,
    )


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
    if _rate_check("portal_msg"):
        return jsonify({"error": "rate_limited", "retry_after": 60}), 429
    staff_id = storage.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    payload = _get_json()
    msg = (payload.get("message") or "").strip()
    kind = (payload.get("kind") or "general").strip()
    # ホワイトリスト外は general に正規化（store-and-display 系 XSS 防止）
    if kind not in {"general", "change_request", "question", "report"}:
        kind = "general"
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
        to_addr=_safe_header(NOTIFY_TO),
        subject=_safe_header(f"【Shifty】{KIND_LABEL.get(kind, '連絡')}: {staff.get('name', '?')}"),
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
# Free + Pro モデルへ移行 (旧 starter/standard は archived)
STRIPE_PRICES = {
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
    """LP の「無料トライアル」CTA から呼ばれる。Stripe Checkout Session を作成して URL を返す。
    LP の「クレカ不要・自動課金なし」表記と一致させるため:
      - payment_method_collection="if_required" (カード入力スキップ可)
      - trial_settings.end_behavior.missing_payment_method="cancel"
        (トライアル終了時にカードがなければ自動解約・課金なし)
    """
    if _rate_check("checkout"):
        return jsonify({"error": "rate_limited", "retry_after": 60}), 429
    stripe_lib = _stripe_client()
    if not stripe_lib:
        return jsonify({"error": "stripe_not_configured", "fallback": "/#contact"}), 503
    payload = _get_json()
    plan = payload.get("plan", "standard")
    price_id = STRIPE_PRICES.get(plan)
    if not price_id:
        return jsonify({"error": "invalid_plan"}), 400

    # 入力サニタイズ (Stripe API への DoS / エラー詳細漏洩対策)
    raw_email = (payload.get("email") or "").strip()[:254]
    if raw_email and ("@" not in raw_email or "." not in raw_email.split("@")[-1]):
        return jsonify({"error": "invalid_email"}), 400
    restaurant = (payload.get("restaurantName") or "").strip()[:100]
    contact = (payload.get("contactName") or "").strip()[:100]

    site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
    try:
        sess_kwargs = {
            "mode": "subscription",
            "payment_method_types": ["card"],
            "line_items": [{"price": price_id, "quantity": 1}],
            "subscription_data": {
                "trial_period_days": 14,
                "trial_settings": {
                    "end_behavior": {"missing_payment_method": "cancel"}
                },
            },
            # クレカ未入力でもサインアップ可
            "payment_method_collection": "if_required",
            # 怖くない誘導文言 (Stripe Checkout 画面に表示される)
            "custom_text": {
                "submit": {
                    "message": "💡 14 日間の無料トライアル中はカード未登録のまま使えます。期間中は自動課金されません。"
                },
            },
            "success_url": site + "/app?welcome=1",
            "cancel_url": site + "/#pricing",
            "metadata": {
                "restaurantName": restaurant,
                "contactName": contact,
                "plan": plan,
            },
        }
        if raw_email:
            sess_kwargs["customer_email"] = raw_email
        sess = stripe_lib.checkout.Session.create(**sess_kwargs)
        return jsonify({"url": sess.url})
    except Exception as e:
        # エラー詳細はクライアントへ漏らさない (内部ログのみ)
        print(f"[stripe] checkout failed for plan={plan}: {e}")
        return jsonify({"error": "stripe_error"}), 502


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
    # 冪等性: event id ごとに provisioning 完了状態を管理 (Round 4 C6 修正)
    # フロー: 受信 → record 保存 → provisioning 試行 → 成功時のみ status='completed' に更新
    # provisioning 失敗時は 5xx 返却 → Stripe が retry → 再受信時 status!='completed' なので再試行
    event_id = event.get("id") or ""
    persisted = False
    already_provisioned = False
    try:
        if STORAGE_BACKEND == "firestore":
            from google.cloud import firestore as _fs
            from google.api_core import exceptions as _gcexc
            _client = _fs.Client()
            doc_ref = _client.collection(COLL_PREFIX + "_subscriptions").document(event_id or "evt_" + secrets.token_urlsafe(8))
            existing_snap = doc_ref.get()
            if existing_snap.exists:
                # 既存 doc がある場合: provisioning が完了していれば即 return、未完了ならリトライ
                existing_data = existing_snap.to_dict() or {}
                if existing_data.get("provisioned"):
                    return jsonify({"ok": True, "duplicate": True})
                # 未完了 → 再試行 (record は更新)
                doc_ref.update({**record, "lastRetryAt": __import__("datetime").datetime.utcnow().isoformat() + "Z"})
                persisted = True
            else:
                doc_ref.create({**record, "provisioned": False})
                persisted = True
        else:
            with sqlite3.connect(DB_PATH) as c:
                c.execute("CREATE TABLE IF NOT EXISTS subs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, data TEXT, provisioned INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))")
                row = c.execute("SELECT provisioned FROM subs WHERE event_id=?", (event_id,)).fetchone()
                if row:
                    if row[0]:
                        return jsonify({"ok": True, "duplicate": True})
                    # 再試行
                    c.execute("UPDATE subs SET data=? WHERE event_id=?", (json.dumps(record, ensure_ascii=False), event_id))
                    persisted = True
                else:
                    c.execute("INSERT INTO subs (event_id, data, provisioned) VALUES (?, ?, 0)", (event_id, json.dumps(record, ensure_ascii=False)))
                    persisted = True
    except Exception as e:
        print(f"[stripe] persist failed: {e}")
        return jsonify({"error": "persist_failed"}), 500


    def _mark_provisioned():
        """provisioning 成功時に呼ぶ。次回 Stripe retry 時にスキップさせる。"""
        try:
            if STORAGE_BACKEND == "firestore":
                from google.cloud import firestore as _fs
                _client = _fs.Client()
                doc_ref = _client.collection(COLL_PREFIX + "_subscriptions").document(event_id)
                doc_ref.update({"provisioned": True, "provisionedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z"})
            else:
                with sqlite3.connect(DB_PATH) as c:
                    c.execute("UPDATE subs SET provisioned=1 WHERE event_id=?", (event_id,))
        except Exception as e:
            print(f"[stripe] mark provisioned failed: {e}")

    # checkout.session.completed: tenant 自動プロビジョニング + マジックリンクメール送信
    if persisted and et == "checkout.session.completed":
        try:
            tm = get_tenant_manager()
            email = record.get("email", "")
            metadata = record.get("metadata", {}) or {}
            restaurant_name = metadata.get("restaurantName", "")
            contact_name = metadata.get("contactName", "")
            customer_id = record.get("customerId", "")
            sub_id = record.get("subscriptionId", "")

            # 既存 tenant か確認 (重複サインアップ防止)
            existing = None
            for t in tm.list_all(limit=500):
                if (t.get("email") or "").strip().lower() == email.strip().lower():
                    existing = t
                    break

            if existing:
                slug = existing["slug"]
                # Stripe ID 更新
                if customer_id and not existing.get("stripeCustomerId"):
                    if STORAGE_BACKEND == "firestore":
                        from google.cloud import firestore as _fs
                        _fs.Client().collection("tenants").document(slug).update({
                            "stripeCustomerId": customer_id,
                            "stripeSubscriptionId": sub_id,
                            "plan": "pro_trial",
                        })
            else:
                slug = _generate_slug(restaurant_name)
                tm.create(
                    slug=slug,
                    email=email,
                    contact_name=contact_name,
                    restaurant_name=restaurant_name,
                    plan="pro_trial",
                    stripe_customer_id=customer_id,
                    stripe_subscription_id=sub_id,
                )

            # マジックリンクを送信
            token = tm.issue_magic_link(slug)
            site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")
            magic_link = f"{site}/auth/verify?token={token}"
            send_email(
                to_addr=_safe_header(email),
                subject=_safe_header(f"【Shifty】{restaurant_name} 様 - セットアップ完了のご案内"),
                body=(
                    f"{contact_name or 'お客様'} 様\n\n"
                    f"このたびは Shifty へお申込みいただきありがとうございます。\n"
                    f"{restaurant_name} 様専用の管理画面をご用意いたしました。\n\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n"
                    f"  ▼ ログイン用リンク（30 分有効）\n"
                    f"  {magic_link}\n"
                    f"━━━━━━━━━━━━━━━━━━━━\n\n"
                    f"以後のログインは下記より行ってください:\n"
                    f"  {site}/login\n\n"
                    f"【次のステップ】\n"
                    f"1. 上記リンクをクリックしてログイン\n"
                    f"2. スタッフ情報を登録（CSV 取込もできます）\n"
                    f"3. 「希望リンク全員生成」で LINE 配布\n"
                    f"4. 希望が集まったら「AI 自動生成」\n\n"
                    f"分からないことがあれば、このメールに返信してご質問ください。\n"
                    f"飲DX サポートチームより 24 時間以内にお返事いたします。\n\n"
                    f"---\n飲DX Shifty\nsupport@in-dx.jp\n{site}/help\n"
                ),
            )
            # 管理者にも通知
            send_email(
                to_addr=_safe_header(NOTIFY_TO),
                subject=_safe_header(f"【新規 Tenant】{restaurant_name} ({slug})"),
                body=f"新規 Pro tenant 作成完了\n\nslug: {slug}\nemail: {email}\nrestaurant: {restaurant_name}\ncontact: {contact_name}\nstripe_customer: {customer_id}\nstripe_sub: {sub_id}\n\n管理画面: {site}/t/{slug}/app",
            )
            # provisioning 成功 → 次回 Stripe retry 時にスキップさせる
            _mark_provisioned()
        except Exception as e:
            print(f"[tenant-provision] failed: {e}")
            # 失敗時は管理者に通知 + 5xx 返却で Stripe retry に任せる (Round 4 C6)
            try:
                send_email(
                    to_addr=_safe_header(NOTIFY_TO),
                    subject=_safe_header("【!!!】Tenant 自動プロビジョニング失敗 (リトライ予定)"),
                    body=f"イベント ID: {event_id}\nrecord: {record}\nerror: {e}\n\nStripe が自動リトライします。手動対応が必要な場合は subscriptions コレクションの provisioned フラグを確認。",
                )
            except Exception:
                pass
            return jsonify({"error": "provisioning_failed", "willRetry": True}), 500

    elif persisted and et == "customer.subscription.deleted":
        # 解約時: 該当 tenant を disabled 化 (Round 4 H3)
        try:
            tm = get_tenant_manager()
            email = record.get("email", "")
            customer_id = record.get("customerId", "")
            target = None
            if STORAGE_BACKEND == "firestore" and customer_id:
                from google.cloud import firestore as _fs
                client = _fs.Client()
                q = client.collection("tenants").where(filter=_fs.FieldFilter("stripeCustomerId", "==", customer_id)).limit(1).stream()
                for doc in q:
                    target = (doc.id, doc.to_dict())
                    break
            if not target and email:
                for t in tm.list_all(limit=500):
                    if (t.get("email") or "").strip().lower() == email.strip().lower():
                        target = (t["slug"], t)
                        break
            if target and STORAGE_BACKEND == "firestore":
                from google.cloud import firestore as _fs
                _fs.Client().collection("tenants").document(target[0]).update({
                    "status": "disabled",
                    "disabledAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                    "plan": "cancelled",
                })
        except Exception as e:
            print(f"[tenant-disable] failed: {e}")
        send_email(
            to_addr=_safe_header(NOTIFY_TO),
            subject=_safe_header(f"【Shifty/Stripe】解約: {record['email']}"),
            body=f"Stripe イベント: {et}\nメール: {record['email']}\n顧客ID: {record['customerId']}\nstatus: {record['status']}\nmetadata: {record['metadata']}\n",
        )
        _mark_provisioned()

    return jsonify({"ok": True})


# ============================================================
# Shift change notification (公開: 確定後にスタッフへメール送信)
# ============================================================
@app.post("/api/admin/notify_shifts")
@require_auth
def api_notify_shifts():
    """指定週のシフトを各スタッフ（email 設定者のみ）に送信。
    payload.staffIds: 配列で渡すと該当スタッフのみに限定送信 (Round 8 変更通知用)
    payload.subjectPrefix: 件名 prefix を追加 (例: '【シフト変更】')
    """
    payload = _get_json()
    week_start = payload.get("weekStart")
    target_staff_ids = payload.get("staffIds")  # None = 全員
    subject_prefix = payload.get("subjectPrefix", "")
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
        # 限定送信モード: target_staff_ids 指定があれば該当スタッフ以外スキップ
        if target_staff_ids and s["id"] not in target_staff_ids:
            continue
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
            to_addr=_safe_header(email),
            subject=_safe_header(f"{subject_prefix}【{restaurant}】{week_start} 週のシフトが確定しました"),
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


class _ConflictError(Exception):
    def __init__(self, current_version):
        self.current_version = current_version


@app.post("/api/state")
@require_auth
def api_save_state():
    payload = _get_json()
    if not payload:
        return jsonify({"error": "expected_object"}), 400
    # 型バリデーション (任意のオブジェクトを受け取るので最低限の防衛)
    if "meta" in payload and not isinstance(payload["meta"], dict):
        return jsonify({"error": "invalid_meta"}), 400
    if "staff" in payload and not isinstance(payload["staff"], list):
        return jsonify({"error": "invalid_staff"}), 400
    if "weeks" in payload and not isinstance(payload["weeks"], dict):
        return jsonify({"error": "invalid_weeks"}), 400
    if "staff" in payload and len(payload["staff"]) > 1000:
        return jsonify({"error": "too_many_staff"}), 400
    # クライアントのバージョン番号（楽観的ロック）。クライアントが送ってこない場合は強制上書き
    expected_version = payload.get("_version")
    # トランザクションでロストアップデート防止 (Critical #4 完全適用)
    def _mutate(current):
        if expected_version is not None and current and current.get("_version") != expected_version:
            raise _ConflictError(current.get("_version"))
        new_state = dict(payload)
        new_state["_version"] = ((current or {}).get("_version", 0) + 1)
        return new_state
    try:
        result = storage.transactional_update(_mutate)
        return jsonify({"ok": True, "version": result.get("_version")})
    except _ConflictError as ce:
        return jsonify({"error": "version_conflict", "currentVersion": ce.current_version}), 409


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
    # ?force=1 を渡すと旧トークンを失効させて新規発行（再発行 = 旧 URL の無効化）
    force = request.args.get("force", "").lower() in ("1", "true", "yes")
    # staff_id の存在確認
    state = storage.get_state() or {}
    if not any(s.get("id") == staff_id for s in (state.get("staff") or [])):
        return jsonify({"error": "staff_not_found"}), 404
    existing = storage.get_token(staff_id)
    if existing and not force:
        return jsonify({"token": existing, "created": False, "regenerated": False})
    if existing and force:
        storage.delete_token(staff_id)
    # 128 bit エントロピー (16 byte). 監査推奨値。
    token = secrets.token_urlsafe(16)
    storage.add_token(staff_id, token)
    return jsonify({"token": token, "created": True, "regenerated": bool(existing)})


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
# Tenant-scoped staff token endpoints (Round 4 C2)
# ============================================================
@app.post("/api/t/<slug>/admin/staff/<staff_id>/token")
@require_tenant_admin()
def api_t_gen_token(slug, staff_id):
    force = request.args.get("force", "").lower() in ("1", "true", "yes")
    s = get_tenant_storage(slug)
    state = s.get_state() or {}
    if not any(st.get("id") == staff_id for st in (state.get("staff") or [])):
        return jsonify({"error": "staff_not_found"}), 404
    existing = s.get_token(staff_id)
    if existing and not force:
        return jsonify({"token": existing, "created": False, "regenerated": False})
    if existing and force:
        s.delete_token(staff_id)
    token = secrets.token_urlsafe(16)
    s.add_token(staff_id, token)
    return jsonify({"token": token, "created": True, "regenerated": bool(existing)})


@app.get("/api/t/<slug>/admin/staff/tokens")
@require_tenant_admin()
def api_t_list_tokens(slug):
    s = get_tenant_storage(slug)
    return jsonify(s.list_tokens())


@app.delete("/api/t/<slug>/admin/staff/<staff_id>/token")
@require_tenant_admin()
def api_t_revoke_token(slug, staff_id):
    s = get_tenant_storage(slug)
    s.delete_token(staff_id)
    return jsonify({"ok": True})


# ============================================================
# Tenant-scoped public portal (Round 4 C2)
# ============================================================
@app.get("/api/t/<slug>/portal/<token>")
def api_t_portal_get(slug, token):
    if not _valid_slug(slug):
        return jsonify({"error": "invalid_slug"}), 400
    s = get_tenant_storage(slug)
    staff_id = s.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    state = s.get_state()
    if state is None:
        return jsonify({"error": "no_state"}), 404
    staff = next((st for st in state.get("staff", []) if st["id"] == staff_id), None)
    if not staff:
        return jsonify({"error": "staff_not_found"}), 404
    meta = state.get("meta", {})
    current_wk = meta.get("currentWeekStart")
    weeks = state.get("weeks") or {}
    week_data = weeks.get(current_wk, {})
    prefs = [p for p in week_data.get("preferences", []) if p["staffId"] == staff_id]
    assignments = [a for a in week_data.get("assignments", []) if a["staffId"] == staff_id]
    comments = (week_data.get("staffComments", {}) or {}).get(staff_id, {})

    # 同シフトメンバー (Round 5) — 自分の各 assignment と時間が重なる他スタッフ
    coworkers = {}  # assignment_id -> [{staffId, name, position}, ...]
    other_assignments = [a for a in week_data.get("assignments", []) if a.get("staffId") != staff_id]
    def _ovl(a, b):
        try:
            def _t(s): h, m = s.split(":"); return int(h) * 60 + int(m)
            return a.get("date") == b.get("date") and _t(a["startTime"]) < _t(b["endTime"]) and _t(b["startTime"]) < _t(a["endTime"])
        except Exception:
            return False
    staff_lookup = {s["id"]: s for s in (state.get("staff") or [])}
    for ma in assignments:
        ows = []
        for oa in other_assignments:
            if _ovl(ma, oa):
                cs = staff_lookup.get(oa.get("staffId"))
                if cs:
                    ows.append({"name": cs.get("name"), "position": cs.get("position"), "startTime": oa.get("startTime"), "endTime": oa.get("endTime")})
        coworkers[ma.get("id")] = ows
    public_staff = {
        "id": staff.get("id"),
        "name": staff.get("name"),
        "position": staff.get("position"),
        "hourlyWage": staff.get("hourlyWage"),
        "email": staff.get("email", ""),
    }

    # 月次サマリ (Round 3): 当月内の確定シフトを集計
    import datetime as _dt
    def _calc_hours(st, et):
        try:
            sh, sm = map(int, st.split(":"))
            eh, em = map(int, et.split(":"))
            return ((eh * 60 + em) - (sh * 60 + sm)) / 60
        except Exception:
            return 0
    if current_wk:
        try:
            cur_dt = _dt.datetime.strptime(current_wk, "%Y-%m-%d")
            month_key = cur_dt.strftime("%Y-%m")
        except Exception:
            month_key = ""
    else:
        month_key = ""
    month_assignments = []
    month_total_h = 0.0
    month_total_pay = 0.0
    history_assignments = []  # 過去 4 週の assignment (確定済のみ)
    # Round 10: 休憩時間 (6h 超勤務時に控除)
    break_min = int(staff.get("breakMinutes", 0) or 0)
    if isinstance(weeks, dict):
        for wk_start, wk_data in weeks.items():
            if wk_data.get("status") != "published":
                continue
            for a in wk_data.get("assignments", []):
                if a.get("staffId") != staff_id:
                    continue
                hours = _calc_hours(a.get("startTime", ""), a.get("endTime", ""))
                # 6h 超なら休憩時間を控除
                eff_hours = hours - (break_min / 60.0) if (hours > 6 and break_min > 0) else hours
                pay = staff.get("hourlyWage", 0) * eff_hours
                # 当月集計
                if month_key and a.get("date", "").startswith(month_key):
                    month_assignments.append(a)
                    month_total_h += eff_hours
                    month_total_pay += pay
                # 履歴 (過去 4 週)
                if current_wk and wk_start <= current_wk:
                    history_assignments.append({
                        "date": a.get("date"),
                        "startTime": a.get("startTime"),
                        "endTime": a.get("endTime"),
                        "position": a.get("position"),
                        "hours": round(eff_hours, 2),
                        "pay": int(pay),
                    })
    history_assignments.sort(key=lambda x: (x.get("date", ""), x.get("startTime", "")), reverse=True)
    history_assignments = history_assignments[:30]

    # 過去の希望提出履歴 (Round 12) — 過去 4 週分
    pref_history = []
    if isinstance(weeks, dict) and current_wk:
        for wk_start in sorted(weeks.keys(), reverse=True):
            if wk_start > current_wk: continue
            wk_data = weeks[wk_start]
            mine = [p for p in wk_data.get("preferences", []) if p.get("staffId") == staff_id]
            if mine:
                pref_history.append({
                    "weekStart": wk_start,
                    "count": len(mine),
                    "must": sum(1 for p in mine if p.get("priority") == "must"),
                    "want": sum(1 for p in mine if p.get("priority") == "want"),
                    "avoid": sum(1 for p in mine if p.get("priority") == "avoid"),
                })
            if len(pref_history) >= 4: break

    # 希望提出締切の計算 (Round 4)
    deadline_iso = None
    deadline_setting = meta.get("preferenceDeadline")
    if isinstance(deadline_setting, dict) and current_wk:
        try:
            wk_dt = _dt.datetime.strptime(current_wk, "%Y-%m-%d")
            days_before = int(deadline_setting.get("daysBefore", 3))
            hour = int(deadline_setting.get("hour", 18))
            deadline_dt = wk_dt - _dt.timedelta(days=days_before)
            deadline_dt = deadline_dt.replace(hour=hour, minute=0, second=0)
            # JST タイムゾーン情報を含めた ISO
            deadline_iso = deadline_dt.isoformat() + "+09:00"
        except Exception:
            pass

    return jsonify({
        "staff": public_staff,
        "preferences": prefs,
        "comments": comments,
        "assignments": assignments,
        "coworkers": coworkers,
        "weekStart": current_wk,
        "weekStatus": week_data.get("status", "draft"),
        "publishedAt": week_data.get("publishedAt"),
        "preferenceDeadline": deadline_iso,
        "ownerNotice": week_data.get("ownerNotice", ""),
        "restaurantName": meta.get("restaurantName", ""),
        "sessions": meta.get("sessions", []),
        "positions": meta.get("positions", []),
        "monthlyStats": {
            "monthKey": month_key,
            "shiftCount": len(month_assignments),
            "totalHours": round(month_total_h, 2),
            "totalPay": int(month_total_pay),
        },
        "history": history_assignments,
        "prefHistory": pref_history,
    })


@app.post("/api/t/<slug>/portal/<token>/preferences")
def api_t_portal_save_prefs(slug, token):
    if not _valid_slug(slug):
        return jsonify({"error": "invalid_slug"}), 400
    s = get_tenant_storage(slug)
    staff_id = s.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    try:
        body = request.get_json(force=True, silent=True)
    except Exception:
        return jsonify({"error": "invalid_json"}), 400
    # 後方互換: list でも dict でも受け付ける
    # 新形式: {"preferences":[...], "comments":{date: text, ...}}
    # 旧形式: [{...}, ...]
    new_prefs = body if isinstance(body, list) else (body.get("preferences") if isinstance(body, dict) else None)
    new_comments = body.get("comments") if isinstance(body, dict) else None
    if not isinstance(new_prefs, list):
        return jsonify({"error": "expected_list"}), 400
    if len(new_prefs) > 100:
        return jsonify({"error": "too_many_preferences"}), 400
    valid_priorities = {"must", "want", "avoid"}
    cleaned = []
    import re as _re
    date_re = _re.compile(r"^\d{4}-\d{2}-\d{2}$")
    time_re = _re.compile(r"^\d{2}:\d{2}$")
    for p in new_prefs:
        if not isinstance(p, dict): continue
        if not date_re.match(str(p.get("date", ""))): continue
        if not time_re.match(str(p.get("startTime", ""))): continue
        if not time_re.match(str(p.get("endTime", ""))): continue
        if p.get("priority") not in valid_priorities: continue
        cleaned.append({
            "id": str(p.get("id", ""))[:64] or ("p_" + secrets.token_urlsafe(6)),
            "staffId": staff_id,
            "date": p["date"],
            "startTime": p["startTime"],
            "endTime": p["endTime"],
            "priority": p["priority"],
        })
    # コメント (日付ごとに 100 文字まで)
    cleaned_comments = {}
    if isinstance(new_comments, dict):
        for k, v in list(new_comments.items())[:14]:  # 最大2週間分
            if not date_re.match(str(k)): continue
            text = str(v or "")[:200]
            if text:
                cleaned_comments[k] = text
    state_after = {"published": False, "no_state": False, "no_week": False}

    def _mutate(current):
        if current is None:
            state_after["no_state"] = True
            return current or {}
        meta = current.get("meta", {})
        current_wk = meta.get("currentWeekStart")
        weeks = current.setdefault("weeks", {})
        week = weeks.get(current_wk)
        if not week:
            state_after["no_week"] = True
            return current
        if week.get("status") == "published":
            state_after["published"] = True
            return current
        week["preferences"] = [p for p in week.get("preferences", []) if p.get("staffId") != staff_id]
        week["preferences"].extend(cleaned)
        # コメント保存 (週内 staffComments[staffId][date] = text)
        if cleaned_comments or isinstance(new_comments, dict):
            sc = week.setdefault("staffComments", {})
            sc[staff_id] = cleaned_comments
        return current

    s.transactional_update(_mutate)
    if state_after["no_state"]:
        return jsonify({"error": "no_state"}), 404
    if state_after["no_week"]:
        return jsonify({"error": "no_current_week"}), 404
    if state_after["published"]:
        return jsonify({"error": "week_published_readonly"}), 403
    return jsonify({"ok": True, "saved": len(cleaned), "comments": len(cleaned_comments)})


@app.post("/api/t/<slug>/portal/<token>/message")
def api_t_portal_message(slug, token):
    if _rate_check("portal_msg"):
        return jsonify({"error": "rate_limited", "retry_after": 60}), 429
    if not _valid_slug(slug):
        return jsonify({"error": "invalid_slug"}), 400
    s = get_tenant_storage(slug)
    staff_id = s.lookup_staff_by_token(token)
    if not staff_id:
        return jsonify({"error": "invalid_token"}), 404
    payload = _get_json()
    msg = (payload.get("message") or "").strip()
    kind = (payload.get("kind") or "general").strip()
    if kind not in {"general", "change_request", "question", "report"}:
        kind = "general"
    if not msg or len(msg) > 2000:
        return jsonify({"error": "invalid_message"}), 400
    state = s.get_state()
    staff = next((st for st in (state.get("staff") or []) if st["id"] == staff_id), None) if state else None
    if not staff:
        return jsonify({"error": "staff_not_found"}), 404
    # tenant 情報取得 (オーナーへの通知先)
    tm = get_tenant_manager()
    tenant = tm.get(slug)
    notify_to = tenant.get("email") if tenant else NOTIFY_TO

    import datetime as _dt
    record = {
        "tenantSlug": slug,
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
            _fs.Client().collection(f"shifty_t_{slug}_messages").add(record)
    except Exception as e:
        print(f"[t-msg] persist failed: {e}")

    KIND_LABEL = {"general": "連絡", "change_request": "シフト変更希望", "question": "質問", "report": "報告"}
    send_email(
        to_addr=_safe_header(notify_to),
        subject=_safe_header(f"【Shifty】{KIND_LABEL.get(kind, '連絡')}: {staff.get('name', '?')}"),
        body=f"スタッフ「{staff.get('name', '?')}」から{KIND_LABEL.get(kind, '連絡')}が届きました。\n\n{msg}\n\n---\n受信日時: {record['createdAt']}\n店舗: {tenant.get('restaurantName') if tenant else slug}",
    )
    return jsonify({"ok": True})


# ============================================================
# Tenant 用スタッフポータル HTML
# /t/{slug}/staff?t={token}
# ============================================================
@app.get("/t/<slug>/staff")
def tenant_staff_portal(slug):
    if not _valid_slug(slug):
        return "Invalid tenant slug", 400
    return send_from_directory(str(ROOT), "staff.html")


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
    # スタッフポータルに返すフィールドは限定（notes は店長プライベートメモなので除外）
    public_staff = {
        "id": staff.get("id"),
        "name": staff.get("name"),
        "position": staff.get("position"),
        "hourlyWage": staff.get("hourlyWage"),  # 給与計算表示に使用
        "email": staff.get("email", ""),
    }
    return jsonify({
        "staff": public_staff,
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
    try:
        new_prefs = request.get_json(force=True, silent=True)
    except Exception:
        return jsonify({"error": "invalid_json"}), 400
    if not isinstance(new_prefs, list):
        return jsonify({"error": "expected_list"}), 400
    # サイズ・形式バリデーション (各 pref が dict / 必要項目 / 範囲チェック)
    if len(new_prefs) > 100:  # 7 days × 10 sessions max + safety
        return jsonify({"error": "too_many_preferences"}), 400
    valid_priorities = {"must", "want", "avoid"}
    cleaned = []
    import re as _re
    date_re = _re.compile(r"^\d{4}-\d{2}-\d{2}$")
    time_re = _re.compile(r"^\d{2}:\d{2}$")
    for p in new_prefs:
        if not isinstance(p, dict): continue
        if not date_re.match(str(p.get("date", ""))): continue
        if not time_re.match(str(p.get("startTime", ""))): continue
        if not time_re.match(str(p.get("endTime", ""))): continue
        if p.get("priority") not in valid_priorities: continue
        cleaned.append({
            "id": str(p.get("id", ""))[:64] or ("p_" + secrets.token_urlsafe(6)),
            "staffId": staff_id,  # 強制上書き (forge 防止)
            "date": p["date"],
            "startTime": p["startTime"],
            "endTime": p["endTime"],
            "priority": p["priority"],
        })
    # Firestore トランザクションで read-modify-write (lost update 防止)
    state_after = {"published": False, "no_state": False, "no_week": False}

    def _mutate(current):
        if current is None:
            state_after["no_state"] = True
            return current or {}
        meta = current.get("meta", {})
        current_wk = meta.get("currentWeekStart")
        weeks = current.setdefault("weeks", {})
        week = weeks.get(current_wk)
        if not week:
            state_after["no_week"] = True
            return current
        if week.get("status") == "published":
            state_after["published"] = True
            return current
        week["preferences"] = [p for p in week.get("preferences", []) if p.get("staffId") != staff_id]
        week["preferences"].extend(cleaned)
        return current

    storage.transactional_update(_mutate)
    if state_after["no_state"]:
        return jsonify({"error": "no_state"}), 404
    if state_after["no_week"]:
        return jsonify({"error": "no_current_week"}), 404
    if state_after["published"]:
        return jsonify({"error": "week_published_readonly"}), 403
    return jsonify({"ok": True, "saved": len(cleaned)})


# ============================================================
# Inquiry (公開: 問い合わせ受付)
# ============================================================
@app.post("/api/inquiry")
def api_inquiry():
    """ランディングページからの問い合わせを Firestore / SQLite に保存"""
    if _rate_check("inquiry"):
        return jsonify({"error": "rate_limited", "retry_after": 60}), 429
    payload = _get_json()
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
        to_addr=_safe_header(NOTIFY_TO),
        subject=_safe_header(f"【Shifty】お問合せ: {record['restaurantName']} / {record['contactName']}"),
        body=notify_body,
        reply_to=_safe_header(record["email"]),
    )

    # Free プランからの直接申込みかどうか判定
    is_free_signup = "Free" in (record.get("message") or "") or "8 名以下" in (record.get("staffCount") or "") or "8名以下" in (record.get("staffCount") or "")
    site = os.environ.get("SITE_URL", "https://shifty.in-dx.jp")

    if is_free_signup and STORAGE_BACKEND == "firestore":
        # Free プラン自動プロビジョニング
        try:
            tm = get_tenant_manager()
            existing = None
            for t in tm.list_all(limit=500):
                if (t.get("email") or "").strip().lower() == record["email"].strip().lower():
                    existing = t
                    break
            slug = existing["slug"] if existing else _generate_slug(record["restaurantName"])
            if not existing:
                tm.create(
                    slug=slug,
                    email=record["email"],
                    contact_name=record["contactName"],
                    restaurant_name=record["restaurantName"],
                    plan="free",
                )
            magic_token = tm.issue_magic_link(slug)
            magic_link = f"{site}/auth/verify?token={magic_token}"
            autoreply = (
                f"{record['contactName']} 様\n\n"
                f"このたびは Shifty にお申込みいただきありがとうございます。\n"
                f"{record['restaurantName']} 様専用の管理画面をご用意いたしました。\n\n"
                f"━━━━━━━━━━━━━━━━━━━━\n"
                f"  ▼ ログイン用リンク（30 分有効）\n"
                f"  {magic_link}\n"
                f"━━━━━━━━━━━━━━━━━━━━\n\n"
                f"以後のログインは下記より行ってください:\n"
                f"  {site}/login\n\n"
                f"【次のステップ】\n"
                f"1. 上記リンクをクリックしてログイン\n"
                f"2. スタッフ情報を登録（CSV 取込もできます）\n"
                f"3. 「希望リンク全員生成」で LINE 配布\n"
                f"4. 希望が集まったら「AI 自動生成」\n\n"
                f"分からないことがあれば、このメールに返信してご質問ください。\n"
                f"飲DX サポートチームより 24 時間以内にお返事いたします。\n\n"
                f"---\n飲DX Shifty\nsupport@in-dx.jp\n{site}/help\n"
            )
            # 管理者通知
            send_email(
                to_addr=_safe_header(NOTIFY_TO),
                subject=_safe_header(f"【新規 Free Tenant】{record['restaurantName']} ({slug})"),
                body=f"slug: {slug}\nemail: {record['email']}\nrestaurant: {record['restaurantName']}\ncontact: {record['contactName']}\nstaff count: {record['staffCount']}\n\n管理画面: {site}/t/{slug}/app",
            )
        except Exception as e:
            print(f"[free-signup-provision] failed: {e}")
            # フォールバック: 従来通りのメッセージ
            autoreply = (
                f"{record['contactName']} 様\n\n"
                f"このたびは Shifty にお問合せいただき、誠にありがとうございます。\n"
                f"内容を確認のうえ、1 営業日以内に support@in-dx.jp よりご連絡いたします。\n\n"
                f"その間にデモ環境を触っていただけます:\n{site}/demo\n\n"
                f"飲DX\n代表 柳下 征二郎\n{site}\n"
            )
    else:
        # 通常のお問合せフォーム経由（手動対応）
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
            f"{site}/demo\n\n"
            f"ご質問・お急ぎの場合は support@in-dx.jp までお気軽にご連絡ください。\n\n"
            f"飲DX\n"
            f"代表 柳下 征二郎\n"
            f"{site}\n"
        )
    send_email(
        to_addr=_safe_header(record["email"]),
        subject=_safe_header("【Shifty】お申込みありがとうございます" if is_free_signup else "【Shifty】お問合せありがとうございます（受付完了）"),
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


# ヘルスチェック (Cloud Run の `/healthz` は GFE が予約しているため `/api/healthz` を使用)
@app.get("/api/healthz")
def api_healthz():
    # 偵察情報を漏らさない最小ヘルスチェック
    return jsonify({"ok": True})


@app.get("/internal/healthz")
def internal_healthz():
    """詳細版ヘルスチェック - SYNC_SECRET_TOKEN による保護"""
    if not _check_internal_token():
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({
        "ok": True,
        "backend": STORAGE_BACKEND,
        "tenant": TENANT_NAME,
        "prefix": COLL_PREFIX,
        "version": os.environ.get("APP_VERSION", "shifty"),
    })


# ============================================================
# Boot
# ============================================================
bootstrap_admin_pass()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5173))
    app.run(host="127.0.0.1", port=port, debug=False)
