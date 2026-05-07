// staff-portal.js v2 — 希望入力モード(draft) ⇔ シフト閲覧モード(published)
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const params = new URLSearchParams(location.search);
  const token = params.get("t");

  const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  let data = null;
  let prefs = {};
  let dirty = false;
  const DRAFT_KEY = `shifty.portal.draft.${token || "anon"}`;

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ prefs, savedAt: Date.now() })); } catch (_) {}
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      // 14 日以上前のドラフトは廃棄
      if (Date.now() - (j.savedAt || 0) > 14 * 86400000) return null;
      return j;
    } catch (_) { return null; }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  }

  function toast(msg, type = "") {
    const t = document.createElement("div");
    t.className = `toast-item ${type}`;
    t.textContent = msg;
    $("#toast").appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }
  function fmtDate(s) { return s.slice(5); }
  function dayOfWeek(s) { return new Date(s).getDay(); }
  function addDays(s, n) {
    const d = new Date(s); d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function timeToMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
  function calcHours(start, end) { return (timeToMin(end) - timeToMin(start)) / 60; }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }
  function fmtYen(n) { return "¥" + Math.round(n).toLocaleString(); }

  function showError(msg) {
    $("#app").innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-red-900 mt-8">
      <div class="font-semibold mb-1">⚠️ ${escapeHtml(msg)}</div></div>`;
  }

  async function init() {
    if (!token) return showError("リンクが無効です。店長から正しい URL を受け取ってください。");
    try {
      data = await window.ShiftyAPI.portalGet(token);
    } catch (e) {
      return showError("リンクが無効・期限切れの可能性があります。店長にご確認ください。");
    }

    if (data.weekStatus === "published") {
      renderPublished();
    } else {
      // load existing prefs from server
      for (const p of (data.preferences || [])) {
        const sess = (data.sessions || []).find(s => s.startTime === p.startTime && s.endTime === p.endTime);
        if (sess) prefs[`${p.date}|${sess.id}`] = p.priority;
      }
      // restore localStorage draft if newer
      const draft = loadDraft();
      if (draft && Object.keys(draft.prefs || {}).length > 0) {
        const keys = Object.keys(draft.prefs);
        const hasUnsavedChange = keys.some(k => draft.prefs[k] !== prefs[k]);
        if (hasUnsavedChange && confirm(
          "前回未送信の入力があります。復元しますか？\n\n" +
          "「キャンセル」を押すと送信済みの内容を表示します。"
        )) {
          prefs = { ...prefs, ...draft.prefs };
          dirty = true;
        } else {
          clearDraft();
        }
      }
      renderDraft();
    }
  }

  // ===== Draft mode (希望入力) =====
  // 4 ボタン並列方式 (must/want/avoid/null) — タップ 1 回で確定
  const PRIORITIES = [
    { id: "must",  label: "必須", emoji: "🔥",   activeCls: "bg-red-500 text-white border-red-500",       inactiveCls: "bg-white text-red-600 border-red-200" },
    { id: "want",  label: "希望", emoji: "✅",   activeCls: "bg-emerald-500 text-white border-emerald-500", inactiveCls: "bg-white text-emerald-600 border-emerald-200" },
    { id: "avoid", label: "不可", emoji: "🚫",   activeCls: "bg-slate-600 text-white border-slate-600",   inactiveCls: "bg-white text-slate-500 border-slate-200" },
    { id: null,    label: "未定", emoji: "—",    activeCls: "bg-slate-100 text-slate-500 border-slate-300", inactiveCls: "bg-white text-slate-400 border-slate-200" },
  ];

  function renderDraft() {
    const days = Array.from({ length: 7 }, (_, i) => addDays(data.weekStart, i));
    const sessions = data.sessions || [];
    const totalCells = 7 * sessions.length;
    const filledCells = Object.values(prefs).filter(v => v).length;
    const progress = totalCells ? Math.round((filledCells / totalCells) * 100) : 0;

    $("#app").innerHTML = `
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="text-xs text-slate-500">${escapeHtml(data.restaurantName)}</div>
        <h1 class="text-xl font-bold mt-1">${escapeHtml(data.staff.name)}さん</h1>
        <div class="text-sm text-slate-600 mt-1">${data.weekStart} 〜 のシフト希望</div>
        <div class="mt-2 inline-block bg-amber-100 text-amber-800 text-xs px-2 py-1 rounded">📝 希望入力期間</div>
        <div class="mt-3">
          <div class="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span>入力進捗</span><span>${filledCells}/${totalCells} (${progress}%)</span>
          </div>
          <div class="gauge-bar"><div style="width:${progress}%;background:#4f46e5"></div></div>
        </div>
        <div class="text-xs text-slate-500 mt-3">各セッションの 4 ボタンから希望を選択（必須＝絶対入りたい / 希望＝入れたら入りたい / 不可＝避けたい / 未定＝任せる）</div>
      </div>
      <div id="grid" class="space-y-3"></div>
      <div class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 shadow-2xl pb-safe">
        <div class="max-w-md mx-auto">
          <button id="saveBtn" class="w-full bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-semibold disabled:bg-slate-300">送信</button>
          <div id="dirtyHint" class="text-center text-xs text-slate-500 mt-1 hidden">未送信の変更があります（自動下書き保存中）</div>
        </div>
      </div>`;

    const grid = $("#grid");
    for (const date of days) {
      const dow = dayOfWeek(date);
      const dayLabel = DAY_LABELS[dow];
      const dowColor = dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "text-slate-700";
      const dayCard = document.createElement("div");
      dayCard.className = "bg-white rounded-xl border border-slate-200 overflow-hidden";
      dayCard.innerHTML = `
        <div class="px-3 py-2 bg-slate-50 border-b border-slate-200 ${dowColor} font-semibold text-sm">${fmtDate(date)} (${dayLabel})</div>
        <div class="p-3 space-y-3"></div>`;
      const inner = dayCard.querySelector(".p-3");
      for (const sess of sessions) {
        const key = `${date}|${sess.id}`;
        const cur = prefs[key] || null;

        const sessRow = document.createElement("div");
        sessRow.className = "border border-slate-100 rounded-lg p-2";
        // 全ユーザ入力 (sess.icon, sess.startTime/endTime) を escape して XSS を防ぐ
        sessRow.innerHTML = `
          <div class="flex items-center gap-2 mb-2 px-1">
            <span class="text-lg">${escapeHtml(sess.icon || "")}</span>
            <div class="flex-1">
              <span class="font-medium text-sm">${escapeHtml(sess.label)}</span>
              <span class="text-xs text-slate-500 ml-2">${escapeHtml(sess.startTime || "")}〜${escapeHtml(sess.endTime || "")}</span>
            </div>
          </div>
          <div class="grid grid-cols-4 gap-1.5"></div>`;
        const btnRow = sessRow.querySelector(".grid");
        for (const p of PRIORITIES) {
          const isActive = (cur ?? null) === p.id;
          const btn = document.createElement("button");
          btn.className = `text-xs font-semibold py-2.5 rounded-md border-2 transition active:scale-95 ${isActive ? p.activeCls : p.inactiveCls}`;
          btn.innerHTML = `<div class="text-base leading-none">${p.emoji}</div><div class="mt-0.5">${p.label}</div>`;
          btn.setAttribute("aria-pressed", isActive ? "true" : "false");
          btn.setAttribute("aria-label", `${escapeHtml(sess.label)} を「${p.label}」に設定`);
          btn.onclick = () => {
            // 同じものを再度押した場合は未定にトグル（誤タップで戻せる）
            if ((cur ?? null) === p.id && p.id !== null) prefs[key] = null;
            else prefs[key] = p.id;
            dirty = true;
            saveDraft();
            renderDraft();
          };
          btnRow.appendChild(btn);
        }
        inner.appendChild(sessRow);
      }
      grid.appendChild(dayCard);
    }

    if (dirty) $("#dirtyHint").classList.remove("hidden");

    $("#saveBtn").onclick = async () => {
      const out = [];
      for (const [key, prio] of Object.entries(prefs)) {
        if (!prio) continue;
        const [date, sessId] = key.split("|");
        const sess = sessions.find(s => s.id === sessId);
        if (!sess) continue;
        out.push({
          id: "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          staffId: data.staff.id,
          date, startTime: sess.startTime, endTime: sess.endTime, priority: prio,
        });
      }
      const btn = $("#saveBtn");
      btn.disabled = true;
      btn.textContent = "送信中...";
      try {
        await window.ShiftyAPI.portalSavePrefs(token, out);
        toast("✅ 送信完了。お疲れ様でした", "success");
        btn.textContent = "✓ 送信完了 (もう一度送信できます)";
        btn.disabled = false;
        dirty = false;
        clearDraft();
        $("#dirtyHint").classList.add("hidden");
      } catch (e) {
        btn.textContent = "送信失敗 - 再試行";
        btn.disabled = false;
        toast("送信失敗: " + e.message, "error");
      }
    };
  }

  // ===== Published mode (シフト確認) =====
  function renderPublished() {
    const days = Array.from({ length: 7 }, (_, i) => addDays(data.weekStart, i));
    const assignments = (data.assignments || []).slice().sort((a, b) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    const byDate = {};
    for (const a of assignments) (byDate[a.date] = byDate[a.date] || []).push(a);

    let totalH = 0, totalPay = 0;
    for (const a of assignments) {
      const h = calcHours(a.startTime, a.endTime);
      totalH += h;
      totalPay += a.cost || (data.staff.hourlyWage * h);
    }

    const publishedAt = data.publishedAt ? new Date(data.publishedAt).toLocaleString("ja-JP") : "";

    $("#app").innerHTML = `
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="text-xs text-slate-500">${escapeHtml(data.restaurantName)}</div>
        <h1 class="text-xl font-bold mt-1">${escapeHtml(data.staff.name)}さん</h1>
        <div class="text-sm text-slate-600 mt-1">${data.weekStart} 〜 のシフト</div>
        <div class="mt-2 inline-block bg-emerald-100 text-emerald-800 text-xs px-2 py-1 rounded">✓ 確定済 ${publishedAt ? `(${publishedAt})` : ""}</div>
        <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div class="bg-slate-50 rounded p-2">
            <div class="text-xs text-slate-500">合計時間</div>
            <div class="text-lg font-bold">${totalH.toFixed(1)}h</div>
          </div>
          <div class="bg-slate-50 rounded p-2">
            <div class="text-xs text-slate-500">予定給与</div>
            <div class="text-lg font-bold">${fmtYen(totalPay)}</div>
          </div>
        </div>
      </div>
      <div id="grid" class="space-y-3"></div>
      <div class="mt-6 text-center">
        <button id="msgBtn" class="bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-5 py-3 text-sm font-semibold">
          💬 店長に連絡する
        </button>
        <div class="text-xs text-slate-400 mt-2">変更希望・質問・報告などお気軽に</div>
      </div>`;

    const grid = $("#grid");
    for (const date of days) {
      const dow = dayOfWeek(date);
      const list = byDate[date] || [];
      const dowColor = dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "text-slate-700";
      const card = document.createElement("div");
      card.className = "bg-white rounded-xl border border-slate-200 overflow-hidden";
      card.innerHTML = `
        <div class="px-3 py-2 bg-slate-50 border-b border-slate-200 ${dowColor} font-semibold text-sm flex items-center justify-between">
          <span>${fmtDate(date)} (${DAY_LABELS[dow]})</span>
          ${list.length === 0 ? '<span class="text-xs text-slate-400 font-normal">休み</span>' : ''}
        </div>
        <div class="p-3 space-y-2"></div>`;
      const inner = card.querySelector(".p-3");
      if (list.length === 0) {
        inner.innerHTML = '<div class="text-slate-400 text-sm py-2">— お休み —</div>';
      } else {
        for (const a of list) {
          const pos = (data.positions || []).find(p => p.id === a.position) || { color: "#64748b", label: a.position };
          const h = calcHours(a.startTime, a.endTime);
          const div = document.createElement("div");
          div.className = "border-l-4 pl-3 py-2";
          // pos.color は管理者入力 — style に直接埋めるとCSS injection 余地。色形式チェック
          const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(pos.color || "") ? pos.color : "#64748b";
          div.style.borderColor = safeColor;
          div.innerHTML = `
            <div class="flex items-center justify-between">
              <div>
                <div class="text-base font-semibold">${escapeHtml(pos.label)}</div>
                <div class="text-sm text-slate-700">${escapeHtml(a.startTime || "")}〜${escapeHtml(a.endTime || "")} <span class="text-xs text-slate-500">(${h.toFixed(1)}h)</span></div>
              </div>
              <div class="text-right text-xs text-slate-500">${fmtYen(a.cost || (data.staff.hourlyWage * h))}</div>
            </div>`;
          inner.appendChild(div);
        }
      }
      grid.appendChild(card);
    }

    // メッセージ送信ボタン
    const msgBtn = document.getElementById("msgBtn");
    if (msgBtn) msgBtn.onclick = openMessageDialog;
  }

  // ===== 店長への連絡ダイアログ =====
  function openMessageDialog() {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md p-5 space-y-3">
        <h3 class="font-bold text-lg">💬 店長に連絡</h3>
        <label class="block text-sm">
          <span class="text-slate-600">用件</span>
          <select id="msgKind" class="mt-1 w-full border rounded-md px-3 py-2">
            <option value="change_request">シフト変更希望</option>
            <option value="question">質問</option>
            <option value="report">報告</option>
            <option value="general">その他</option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-slate-600">メッセージ</span>
          <textarea id="msgText" class="mt-1 w-full border rounded-md px-3 py-2 h-24" placeholder="例: 5/10 の夕方シフトを別日に変更したい..."></textarea>
        </label>
        <div class="flex gap-2 justify-end">
          <button id="msgCancel" class="px-3 py-1.5 text-sm">キャンセル</button>
          <button id="msgSend" class="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-md font-semibold">送信</button>
        </div>
        <div id="msgStatus" class="text-xs text-center hidden"></div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector("#msgCancel").onclick = () => overlay.remove();
    overlay.querySelector("#msgSend").onclick = async () => {
      const kind = overlay.querySelector("#msgKind").value;
      const message = overlay.querySelector("#msgText").value.trim();
      if (!message) { toast("メッセージを入力してください", "error"); return; }
      const status = overlay.querySelector("#msgStatus");
      const btn = overlay.querySelector("#msgSend");
      btn.disabled = true; btn.textContent = "送信中…";
      try {
        await window.ShiftyAPI.portalSendMessage(token, kind, message);
        status.textContent = "✅ 送信完了。店長から折り返しご連絡があります。";
        status.className = "text-xs text-center text-emerald-600";
        status.classList.remove("hidden");
        setTimeout(() => overlay.remove(), 1800);
      } catch (e) {
        status.textContent = "送信失敗: " + e.message;
        status.className = "text-xs text-center text-red-600";
        status.classList.remove("hidden");
        btn.disabled = false; btn.textContent = "送信";
      }
    };
  }

  init();
})();
