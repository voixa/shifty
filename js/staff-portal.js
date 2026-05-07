// staff-portal.js v2 — 希望入力モード(draft) ⇔ シフト閲覧モード(published)
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const params = new URLSearchParams(location.search);
  const token = params.get("t");

  const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  let data = null;
  let prefs = {};
  let dirty = false;

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
      // load existing prefs
      for (const p of (data.preferences || [])) {
        const sess = (data.sessions || []).find(s => s.startTime === p.startTime && s.endTime === p.endTime);
        if (sess) prefs[`${p.date}|${sess.id}`] = p.priority;
      }
      renderDraft();
    }
  }

  // ===== Draft mode (希望入力) =====
  function priorityNext(cur) {
    const order = ["want", "must", "avoid", null];
    const i = order.indexOf(cur ?? null);
    return order[(i + 1) % 4];
  }
  function priorityStyle(p) {
    if (p === "must")  return { cls: "bg-red-100 border-red-300 text-red-800",                        label: "必須",   sub: "絶対入りたい" };
    if (p === "want")  return { cls: "bg-emerald-100 border-emerald-300 text-emerald-800",            label: "希望",   sub: "入れたら入りたい" };
    if (p === "avoid") return { cls: "bg-slate-200 border-slate-300 text-slate-600 line-through",     label: "不可",   sub: "避けたい" };
    return                     { cls: "bg-white border-slate-300 text-slate-400",                     label: "未入力", sub: "タップで切替" };
  }

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
        <div class="text-xs text-slate-500 mt-3">タップで <span class="text-emerald-700 font-semibold">希望</span> → <span class="text-red-700 font-semibold">必須</span> → <span class="text-slate-500 font-semibold line-through">不可</span> → 未入力 を切替</div>
      </div>
      <div id="grid" class="space-y-3"></div>
      <div class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 shadow-2xl">
        <div class="max-w-md mx-auto">
          <button id="saveBtn" class="w-full bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-3 font-semibold disabled:bg-slate-300">送信</button>
          <div id="dirtyHint" class="text-center text-xs text-slate-500 mt-1 hidden">未送信の変更があります</div>
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
        <div class="p-3 space-y-2"></div>`;
      const inner = dayCard.querySelector(".p-3");
      for (const sess of sessions) {
        const key = `${date}|${sess.id}`;
        const cur = prefs[key] || null;
        const sty = priorityStyle(cur);
        const btn = document.createElement("button");
        btn.className = `w-full text-left flex items-center justify-between gap-2 px-4 py-3 rounded-lg border transition ${sty.cls}`;
        btn.innerHTML = `
          <span class="flex items-center gap-2">
            <span class="text-xl">${sess.icon || ""}</span>
            <span>
              <span class="font-medium block">${escapeHtml(sess.label)}</span>
              <span class="text-[11px] block opacity-70">${sess.startTime}〜${sess.endTime}</span>
            </span>
          </span>
          <span class="text-right">
            <span class="text-sm font-semibold block">${sty.label}</span>
            <span class="text-[10px] opacity-60 block">${sty.sub}</span>
          </span>`;
        btn.onclick = () => {
          prefs[key] = priorityNext(cur);
          dirty = true;
          renderDraft();
        };
        inner.appendChild(btn);
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
          div.style.borderColor = pos.color;
          div.innerHTML = `
            <div class="flex items-center justify-between">
              <div>
                <div class="text-base font-semibold">${escapeHtml(pos.label)}</div>
                <div class="text-sm text-slate-700">${a.startTime}〜${a.endTime} <span class="text-xs text-slate-500">(${h.toFixed(1)}h)</span></div>
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
