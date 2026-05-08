// staff-portal.js v2 — 希望入力モード(draft) ⇔ シフト閲覧モード(published)
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const params = new URLSearchParams(location.search);
  const token = params.get("t");

  const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  // 祝日マッピング (data.js の JP_HOLIDAYS と整合)
  const HOLIDAY_NAMES = {
    "2026-01-01":"元日","2026-01-12":"成人の日","2026-02-11":"建国記念の日","2026-02-23":"天皇誕生日",
    "2026-03-20":"春分の日","2026-04-29":"昭和の日","2026-05-03":"憲法記念日","2026-05-04":"みどりの日",
    "2026-05-05":"こどもの日","2026-05-06":"振替休日","2026-07-20":"海の日","2026-08-11":"山の日",
    "2026-09-21":"敬老の日","2026-09-22":"国民の休日","2026-09-23":"秋分の日","2026-10-12":"スポーツの日",
    "2026-11-03":"文化の日","2026-11-23":"勤労感謝の日","2027-01-01":"元日","2027-01-11":"成人の日",
    "2027-02-11":"建国記念の日","2027-02-23":"天皇誕生日","2027-03-21":"春分の日","2027-03-22":"振替休日",
    "2027-04-29":"昭和の日","2027-05-03":"憲法記念日","2027-05-04":"みどりの日","2027-05-05":"こどもの日",
    "2027-07-19":"海の日","2027-08-11":"山の日","2027-09-20":"敬老の日","2027-09-23":"秋分の日",
    "2027-10-11":"スポーツの日","2027-11-03":"文化の日","2027-11-23":"勤労感謝の日",
  };

  let data = null;
  let prefs = {};       // {`${date}|${sessId}`: priority}
  let customTimes = {}; // {`${date}|${sessId}`: {startTime, endTime}}  時間範囲指定がある場合
  let comments = {};    // {date: text}
  let dirty = false;
  const DRAFT_KEY = `shifty.portal.draft.${token || "anon"}`;
  // 希望テンプレート (Round 8) — 曜日 × セッション の優先度をローカル保存
  // {`${dow}|${sessId}`: priority}
  const PREF_TEMPLATE_KEY = `shifty.portal.template.${token || "anon"}`;
  function loadPrefTemplate() {
    try { const raw = localStorage.getItem(PREF_TEMPLATE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function savePrefTemplate(tpl) {
    try { localStorage.setItem(PREF_TEMPLATE_KEY, JSON.stringify(tpl)); } catch (_) {}
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        prefs, customTimes, comments, savedAt: Date.now()
      }));
    } catch (_) {}
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
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
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
        if (sess) {
          prefs[`${p.date}|${sess.id}`] = p.priority;
        } else {
          // 時間が一致するセッションがない = カスタム時間
          // セッション枠を探す: 開始時刻が含まれるセッション
          const owner = (data.sessions || []).find(s =>
            timeToMin(p.startTime) >= timeToMin(s.startTime) &&
            timeToMin(p.endTime) <= timeToMin(s.endTime)
          );
          if (owner) {
            const k = `${p.date}|${owner.id}`;
            prefs[k] = p.priority;
            customTimes[k] = { startTime: p.startTime, endTime: p.endTime };
          }
        }
      }
      // load comments
      comments = data.comments || {};
      // restore localStorage draft if newer
      const draft = loadDraft();
      if (draft && (Object.keys(draft.prefs || {}).length > 0 || Object.keys(draft.comments || {}).length > 0)) {
        const keys = Object.keys(draft.prefs || {});
        const hasUnsavedChange = keys.some(k => draft.prefs[k] !== prefs[k])
          || Object.keys(draft.comments || {}).some(k => (draft.comments[k] || "") !== (comments[k] || ""))
          || Object.keys(draft.customTimes || {}).some(k => JSON.stringify(draft.customTimes[k]) !== JSON.stringify(customTimes[k]));
        if (hasUnsavedChange && confirm(
          "前回未送信の入力があります。復元しますか？\n\n" +
          "「キャンセル」を押すと送信済みの内容を表示します。"
        )) {
          prefs = { ...prefs, ...(draft.prefs || {}) };
          customTimes = { ...customTimes, ...(draft.customTimes || {}) };
          comments = { ...comments, ...(draft.comments || {}) };
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

    const m = data.monthlyStats || {};
    const monthLabel = m.monthKey ? m.monthKey.replace("-", "年") + "月" : "今月";
    const monthCard = m.shiftCount > 0 ? `
      <div class="bg-gradient-to-br from-emerald-50 to-brand-50 rounded-xl border border-emerald-200 p-3 mb-3">
        <div class="text-xs font-semibold text-emerald-900 mb-1.5">📊 ${escapeHtml(monthLabel)} の集計（確定済シフトのみ）</div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div><div class="text-[10px] text-slate-500">シフト数</div><div class="text-lg font-bold text-slate-900">${m.shiftCount}</div></div>
          <div><div class="text-[10px] text-slate-500">勤務時間</div><div class="text-lg font-bold text-emerald-700">${m.totalHours}h</div></div>
          <div><div class="text-[10px] text-slate-500">給与目安</div><div class="text-lg font-bold text-brand-700">${fmtYen(m.totalPay)}</div></div>
        </div>
        <div class="text-[10px] text-slate-500 mt-1.5">※ 給与は時給×時間の概算です。実際の支給額とは異なる場合があります</div>
      </div>` : "";

    // 希望テンプレートカード (Round 8)
    const tpl = loadPrefTemplate();
    const tplCard = `
      <div class="bg-white border border-slate-200 rounded-xl p-3 mb-3">
        <details>
          <summary class="text-sm font-semibold cursor-pointer select-none">⚡ 希望テンプレート (毎週同じパターンの方向け)</summary>
          <div class="mt-2 flex flex-col sm:flex-row gap-2">
            <button id="tpl-apply" class="text-xs bg-emerald-500 hover:bg-emerald-600 text-white rounded-md px-3 py-2 font-semibold ${tpl ? "" : "hidden"}">
              📋 保存済テンプレを当週に適用
            </button>
            <button id="tpl-save" class="text-xs bg-blue-500 hover:bg-blue-600 text-white rounded-md px-3 py-2 font-semibold">
              💾 今の入力をテンプレ保存
            </button>
            <button id="tpl-clear" class="text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-md px-3 py-2 ${tpl ? "" : "hidden"}">
              🗑 テンプレを削除
            </button>
          </div>
          <div class="text-[10px] text-slate-500 mt-2">
            テンプレは「曜日 × セッション」単位で保存されます。例: 「毎週月曜のランチ希望」など。<br>
            保存はお使いのブラウザに保管されます (送信時にサーバへは送られません)。
          </div>
        </details>
      </div>`;

    // 希望提出締切 (Round 4)
    let deadlineCard = "";
    if (data.preferenceDeadline) {
      const dl = new Date(data.preferenceDeadline);
      const now = new Date();
      const diffMs = dl - now;
      const isExpired = diffMs <= 0;
      const diffH = Math.floor(diffMs / 3600000);
      const diffMin = Math.floor((diffMs % 3600000) / 60000);
      const fmt = (d) => `${d.getMonth()+1}/${d.getDate()}(${["日","月","火","水","木","金","土"][d.getDay()]}) ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      if (isExpired) {
        deadlineCard = `
        <div class="bg-red-50 border border-red-300 rounded-xl p-3 mb-3 text-sm">
          <div class="font-bold text-red-700">⏰ 希望提出期限を過ぎています</div>
          <div class="text-xs text-red-600 mt-1">期限: ${fmt(dl)}　既にシフト編成中の可能性があります。今からの提出は店長に直接ご連絡ください。</div>
        </div>`;
      } else if (diffH < 24) {
        deadlineCard = `
        <div class="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3 text-sm">
          <div class="font-bold text-amber-800">⏰ 提出期限まで <span class="text-amber-900 text-lg">あと ${diffH > 0 ? diffH + "時間" + diffMin + "分" : diffMin + "分"}</span></div>
          <div class="text-xs text-amber-700 mt-1">期限: ${fmt(dl)}　お早めにご提出ください</div>
        </div>`;
      } else {
        const days = Math.floor(diffH / 24);
        deadlineCard = `
        <div class="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-3 text-sm">
          <div class="font-semibold text-blue-900">⏰ 提出期限: ${fmt(dl)} <span class="text-xs">(あと ${days} 日)</span></div>
        </div>`;
      }
    }

    const draftNoticeCard = (data.ownerNotice && data.ownerNotice.trim()) ? `
      <div class="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3">
        <div class="text-xs font-semibold text-amber-900 mb-1">📢 店長からのお知らせ</div>
        <div class="text-sm text-amber-900 whitespace-pre-wrap">${escapeHtml(data.ownerNotice.trim())}</div>
      </div>` : "";

    $("#app").innerHTML = `
      ${draftNoticeCard}
      ${deadlineCard}
      ${tplCard}
      ${monthCard}
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
      ${(data.history && data.history.length) ? `
      <div class="bg-white rounded-xl border border-slate-200 p-3 mt-4">
        <details>
          <summary class="text-sm font-semibold cursor-pointer select-none">📜 過去シフト履歴（直近 ${data.history.length} 件）</summary>
          <div class="mt-2 space-y-1 text-xs">
            ${data.history.map(h => `
              <div class="flex items-center justify-between bg-slate-50 rounded p-1.5">
                <div>
                  <span class="font-mono">${escapeHtml(h.date)}</span>
                  <span class="text-slate-600">${escapeHtml(h.startTime)}〜${escapeHtml(h.endTime)}</span>
                </div>
                <div class="text-right">
                  <div class="text-slate-700">${h.hours}h</div>
                  <div class="text-[10px] text-slate-500">${fmtYen(h.pay)}</div>
                </div>
              </div>`).join("")}
          </div>
        </details>
      </div>` : ""}
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
      // 通し勤務ボタン (lunch + dinner 両方を一括 "want" に)
      const allDayBtn = sessions.length > 1
        ? `<button class="all-day-btn text-[10px] bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 rounded px-2 py-1 font-semibold ml-auto" data-date="${date}" aria-label="この日を通し勤務希望">⏩ 1日通し希望</button>`
        : "";
      // 祝日チェック (data.js の JP_HOLIDAYS 簡易版を staff-portal でも持つ)
      const holiday = HOLIDAY_NAMES[date];
      const holidayBadge = holiday ? `<span class="text-[9px] text-red-600 bg-red-50 border border-red-200 rounded px-1 py-0.5 ml-1">🎌 ${escapeHtml(holiday)}</span>` : "";
      dayCard.innerHTML = `
        <div class="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 flex-wrap">
          <span class="${holiday ? 'text-red-600' : dowColor} font-semibold text-sm">${fmtDate(date)} (${dayLabel})</span>
          ${holidayBadge}
          ${allDayBtn}
        </div>
        <div class="p-3 space-y-3"></div>`;
      const inner = dayCard.querySelector(".p-3");
      for (const sess of sessions) {
        const key = `${date}|${sess.id}`;
        const cur = prefs[key] || null;
        const ct = customTimes[key];
        const displayStart = (ct && ct.startTime) || sess.startTime;
        const displayEnd = (ct && ct.endTime) || sess.endTime;
        const isCustom = !!ct;

        const sessRow = document.createElement("div");
        sessRow.className = "border border-slate-100 rounded-lg p-2";
        // 全ユーザ入力 (sess.icon, sess.startTime/endTime) を escape して XSS を防ぐ
        sessRow.innerHTML = `
          <div class="flex items-center gap-2 mb-2 px-1">
            <span class="text-lg">${escapeHtml(sess.icon || "")}</span>
            <div class="flex-1">
              <span class="font-medium text-sm">${escapeHtml(sess.label)}</span>
              <span class="text-xs ${isCustom ? "text-amber-600 font-semibold" : "text-slate-500"} ml-2">
                ${escapeHtml(displayStart)}〜${escapeHtml(displayEnd)}${isCustom ? " ⚙️" : ""}
              </span>
            </div>
            <button class="time-adjust-btn text-[10px] text-slate-400 hover:text-slate-700 px-1.5 py-1 rounded border border-slate-200 hover:border-slate-400"
              data-key="${key}" data-sess-start="${escapeAttr(sess.startTime)}" data-sess-end="${escapeAttr(sess.endTime)}"
              aria-label="時間を調整">⚙️ 時間調整</button>
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
            if ((cur ?? null) === p.id && p.id !== null) {
              prefs[key] = null;
              delete customTimes[key]; // 解除時はカスタム時間もクリア
            } else {
              prefs[key] = p.id;
            }
            dirty = true;
            saveDraft();
            renderDraft();
          };
          btnRow.appendChild(btn);
        }
        inner.appendChild(sessRow);
      }
      // コメント欄 (日付ごと)
      const commentRow = document.createElement("div");
      commentRow.className = "px-1";
      const cmtId = `cmt-${date}`;
      commentRow.innerHTML = `
        <details class="text-xs">
          <summary class="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
            ✏️ メモ${comments[date] ? ' (記入あり)' : ' (店長への伝達)'}
          </summary>
          <textarea id="${cmtId}" data-date="${date}" maxlength="200"
            class="comment-input mt-1 w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 h-16 resize-none"
            placeholder="例: 16時以降なら通し可・家族の用事で15時で上がりたい・電車遅延の可能性あり 等">${escapeHtml(comments[date] || "")}</textarea>
          <div class="text-[10px] text-slate-400 text-right">最大 200 文字</div>
        </details>`;
      inner.appendChild(commentRow);

      grid.appendChild(dayCard);
    }

    // 通し勤務ボタン
    grid.querySelectorAll(".all-day-btn").forEach(btn => {
      btn.onclick = () => {
        const date = btn.getAttribute("data-date");
        for (const sess of sessions) {
          prefs[`${date}|${sess.id}`] = "want";
        }
        dirty = true;
        saveDraft();
        renderDraft();
        toast(`${date.slice(5)} 全セッションを「希望」に設定`, "success");
      };
    });

    // 時間調整ボタン
    grid.querySelectorAll(".time-adjust-btn").forEach(btn => {
      btn.onclick = () => {
        const key = btn.getAttribute("data-key");
        const sessStart = btn.getAttribute("data-sess-start");
        const sessEnd = btn.getAttribute("data-sess-end");
        openTimeAdjustModal(key, sessStart, sessEnd);
      };
    });

    // 希望テンプレート操作 (Round 8)
    const tplApplyBtn = document.getElementById("tpl-apply");
    const tplSaveBtn = document.getElementById("tpl-save");
    const tplClearBtn = document.getElementById("tpl-clear");
    if (tplApplyBtn) tplApplyBtn.onclick = () => {
      const t = loadPrefTemplate();
      if (!t) return;
      if (!confirm("保存されたテンプレートを当週に適用しますか？\n現在の希望入力は上書きされます (送信していなければ復元可能)。")) return;
      const days = Array.from({ length: 7 }, (_, i) => addDays(data.weekStart, i));
      let applied = 0;
      for (const date of days) {
        const dow = dayOfWeek(date);
        for (const sess of (data.sessions || [])) {
          const tplKey = `${dow}|${sess.id}`;
          if (t[tplKey]) {
            const k = `${date}|${sess.id}`;
            prefs[k] = t[tplKey];
            applied++;
          }
        }
      }
      dirty = true; saveDraft(); renderDraft();
      toast(`テンプレート適用: ${applied} 件の希望を設定`, "success");
    };
    if (tplSaveBtn) tplSaveBtn.onclick = () => {
      // 当週の入力を曜日 × セッション に圧縮 (同じ曜日に複数日があれば最初の値を採用)
      const tpl = {};
      for (const [key, prio] of Object.entries(prefs)) {
        if (!prio) continue;
        const [date, sessId] = key.split("|");
        const dow = dayOfWeek(date);
        const tplKey = `${dow}|${sessId}`;
        if (!tpl[tplKey]) tpl[tplKey] = prio; // 最初の値を採用
      }
      if (Object.keys(tpl).length === 0) {
        toast("先に希望を入力してから保存してください", "error");
        return;
      }
      savePrefTemplate(tpl);
      toast(`テンプレートを保存しました (${Object.keys(tpl).length} 件)`, "success");
      renderDraft();
    };
    if (tplClearBtn) tplClearBtn.onclick = () => {
      if (!confirm("保存済テンプレートを削除しますか？")) return;
      try { localStorage.removeItem(PREF_TEMPLATE_KEY); } catch (_) {}
      toast("テンプレートを削除しました", "info");
      renderDraft();
    };

    // コメント入力 (debounce 保存)
    let commentTimer;
    grid.querySelectorAll(".comment-input").forEach(el => {
      el.addEventListener("input", () => {
        const d = el.getAttribute("data-date");
        comments[d] = el.value.slice(0, 200);
        dirty = true;
        if (commentTimer) clearTimeout(commentTimer);
        commentTimer = setTimeout(() => {
          saveDraft();
          if (dirty) $("#dirtyHint").classList.remove("hidden");
        }, 400);
      });
    });

    if (dirty) $("#dirtyHint").classList.remove("hidden");

    $("#saveBtn").onclick = async () => {
      const out = [];
      for (const [key, prio] of Object.entries(prefs)) {
        if (!prio) continue;
        const [date, sessId] = key.split("|");
        const sess = sessions.find(s => s.id === sessId);
        if (!sess) continue;
        // カスタム時間があればそちらを優先
        const ct = customTimes[key];
        const startTime = (ct && ct.startTime) || sess.startTime;
        const endTime = (ct && ct.endTime) || sess.endTime;
        out.push({
          id: "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          staffId: data.staff.id,
          date, startTime, endTime, priority: prio,
        });
      }
      const btn = $("#saveBtn");
      btn.disabled = true;
      btn.textContent = "送信中...";
      try {
        await window.ShiftyAPI.portalSavePrefs(token, { preferences: out, comments });
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

  // ===== 時間調整モーダル =====
  function openTimeAdjustModal(key, sessStart, sessEnd) {
    const ct = customTimes[key];
    const curStart = (ct && ct.startTime) || sessStart;
    const curEnd = (ct && ct.endTime) || sessEnd;

    // 30 分刻みで sessStart〜sessEnd の範囲内オプションを生成
    function timeOptions(min, max) {
      const out = [];
      for (let m = timeToMin(min); m <= timeToMin(max); m += 30) {
        const h = String(Math.floor(m / 60)).padStart(2, "0");
        const mm = String(m % 60).padStart(2, "0");
        out.push(`${h}:${mm}`);
      }
      return out;
    }
    const opts = timeOptions(sessStart, sessEnd);

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-base">⚙️ 時間を調整</h3>
          <button id="ta-close" class="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <p class="text-xs text-slate-600">
          このセッション (${escapeHtml(sessStart)}〜${escapeHtml(sessEnd)}) の中で、希望する時間帯を指定できます。<br>
          例: 11:00〜13:00 だけ・14:00 以降のみ 等
        </p>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs font-semibold text-slate-700">開始時刻</span>
            <select id="ta-start" class="mt-1 w-full border rounded-md px-3 py-2 text-base">
              ${opts.map(t => `<option value="${t}" ${t === curStart ? "selected" : ""}>${t}</option>`).join("")}
            </select>
          </label>
          <label class="block">
            <span class="text-xs font-semibold text-slate-700">終了時刻</span>
            <select id="ta-end" class="mt-1 w-full border rounded-md px-3 py-2 text-base">
              ${opts.map(t => `<option value="${t}" ${t === curEnd ? "selected" : ""}>${t}</option>`).join("")}
            </select>
          </label>
        </div>
        <div id="ta-error" class="text-xs text-red-600 hidden"></div>
        <div class="flex gap-2 pt-2">
          ${ct ? '<button id="ta-reset" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm py-2 rounded-md">フル時間に戻す</button>' : ""}
          <button id="ta-save" class="flex-1 bg-brand-600 hover:bg-brand-700 text-white text-sm py-2 rounded-md font-semibold">適用</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#ta-close").onclick = close;
    if (ct) overlay.querySelector("#ta-reset").onclick = () => {
      delete customTimes[key];
      dirty = true; saveDraft(); close(); renderDraft();
      toast("時間範囲を解除しました", "info");
    };
    overlay.querySelector("#ta-save").onclick = () => {
      const s = overlay.querySelector("#ta-start").value;
      const e = overlay.querySelector("#ta-end").value;
      const err = overlay.querySelector("#ta-error");
      if (timeToMin(s) >= timeToMin(e)) {
        err.textContent = "終了時刻は開始時刻より後にしてください";
        err.classList.remove("hidden");
        return;
      }
      // 全範囲と一致なら customTimes 削除
      if (s === sessStart && e === sessEnd) {
        delete customTimes[key];
      } else {
        customTimes[key] = { startTime: s, endTime: e };
      }
      // 同時に「希望」優先度がない場合は自動的に "want" に設定
      if (!prefs[key]) prefs[key] = "want";
      dirty = true; saveDraft(); close(); renderDraft();
      toast(`時間を ${s}〜${e} に設定しました`, "success");
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

    const m = data.monthlyStats || {};
    const monthLabel = m.monthKey ? m.monthKey.replace("-", "年") + "月" : "今月";
    const monthCard = m.shiftCount > 0 ? `
      <div class="bg-gradient-to-br from-emerald-50 to-brand-50 rounded-xl border border-emerald-200 p-3 mb-3">
        <div class="text-xs font-semibold text-emerald-900 mb-1.5">📊 ${escapeHtml(monthLabel)} の集計（確定済シフトのみ）</div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div><div class="text-[10px] text-slate-500">シフト数</div><div class="text-lg font-bold text-slate-900">${m.shiftCount}</div></div>
          <div><div class="text-[10px] text-slate-500">勤務時間</div><div class="text-lg font-bold text-emerald-700">${m.totalHours}h</div></div>
          <div><div class="text-[10px] text-slate-500">給与目安</div><div class="text-lg font-bold text-brand-700">${fmtYen(m.totalPay)}</div></div>
        </div>
      </div>` : "";

    // 次の出勤カウントダウン (Round 7)
    const upcomingShifts = (data.assignments || [])
      .map(a => ({ ...a, dt: new Date(`${a.date}T${a.startTime}:00`) }))
      .filter(a => a.dt > new Date())
      .sort((a, b) => a.dt - b.dt);
    let nextShiftCard = "";
    if (upcomingShifts.length > 0) {
      const next = upcomingShifts[0];
      const diffMs = next.dt - new Date();
      const diffH = Math.floor(diffMs / 3600000);
      const diffMin = Math.floor((diffMs % 3600000) / 60000);
      const days = Math.floor(diffH / 24);
      const remainH = diffH % 24;
      let countdown;
      if (days > 0) {
        countdown = `あと ${days} 日 ${remainH} 時間`;
      } else if (diffH > 0) {
        countdown = `あと ${diffH} 時間 ${diffMin} 分`;
      } else {
        countdown = `あと ${diffMin} 分 ⚡ 出勤前`;
      }
      const pos = (data.positions || []).find(p => p.id === next.position) || { label: next.position };
      const dowLabel = ["日","月","火","水","木","金","土"][next.dt.getDay()];
      nextShiftCard = `
        <div class="bg-gradient-to-br from-blue-500 to-brand-600 rounded-xl p-4 mb-3 text-white shadow-lg">
          <div class="text-xs opacity-90">⏰ 次のシフト</div>
          <div class="font-bold text-lg mt-1">${next.date.slice(5)} (${dowLabel}) ${escapeHtml(next.startTime || "")}〜${escapeHtml(next.endTime || "")}</div>
          <div class="text-sm opacity-90 mt-0.5">${escapeHtml(pos.label)}</div>
          <div class="text-2xl font-bold mt-2">${countdown}</div>
        </div>`;
    }

    // 店長お知らせ (Round 9)
    const noticeCard = (data.ownerNotice && data.ownerNotice.trim()) ? `
      <div class="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3">
        <div class="text-xs font-semibold text-amber-900 mb-1">📢 店長からのお知らせ</div>
        <div class="text-sm text-amber-900 whitespace-pre-wrap">${escapeHtml(data.ownerNotice.trim())}</div>
      </div>` : "";

    $("#app").innerHTML = `
      ${nextShiftCard}
      ${noticeCard}
      ${monthCard}
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="text-xs text-slate-500">${escapeHtml(data.restaurantName)}</div>
        <h1 class="text-xl font-bold mt-1">${escapeHtml(data.staff.name)}さん</h1>
        <div class="text-sm text-slate-600 mt-1">${data.weekStart} 〜 のシフト</div>
        <div class="mt-2 inline-block bg-emerald-100 text-emerald-800 text-xs px-2 py-1 rounded">✓ 確定済 ${publishedAt ? `(${publishedAt})` : ""}</div>
        <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div class="bg-slate-50 rounded p-2">
            <div class="text-xs text-slate-500">今週の合計</div>
            <div class="text-lg font-bold">${totalH.toFixed(1)}h</div>
          </div>
          <div class="bg-slate-50 rounded p-2">
            <div class="text-xs text-slate-500">予定給与</div>
            <div class="text-lg font-bold">${fmtYen(totalPay)}</div>
          </div>
        </div>
      </div>
      <div id="grid" class="space-y-3"></div>
      ${(data.history && data.history.length) ? `
      <div class="bg-white rounded-xl border border-slate-200 p-3 mt-4">
        <details>
          <summary class="text-sm font-semibold cursor-pointer select-none">📜 過去シフト履歴（直近 ${data.history.length} 件）</summary>
          <div class="mt-2 space-y-1 text-xs">
            ${data.history.map(h => `
              <div class="flex items-center justify-between bg-slate-50 rounded p-1.5">
                <div>
                  <span class="font-mono">${escapeHtml(h.date)}</span>
                  <span class="text-slate-600">${escapeHtml(h.startTime)}〜${escapeHtml(h.endTime)}</span>
                </div>
                <div class="text-right">
                  <div class="text-slate-700">${h.hours}h</div>
                  <div class="text-[10px] text-slate-500">${fmtYen(h.pay)}</div>
                </div>
              </div>`).join("")}
          </div>
        </details>
      </div>` : ""}
      <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button id="msgBtn" class="bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-5 py-3 text-sm font-semibold">
          💬 店長に連絡する
        </button>
        <button id="icalBtn" class="bg-blue-500 hover:bg-blue-600 text-white rounded-lg px-5 py-3 text-sm font-semibold">
          📅 カレンダーに追加 (.ics)
        </button>
      </div>
      <div class="text-xs text-slate-400 mt-2 text-center">変更希望・質問・報告などお気軽に</div>`;

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
          const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(pos.color || "") ? pos.color : "#64748b";
          div.style.borderColor = safeColor;

          // 当日かつ未来かどうか (Round 7)
          const isToday = a.date === new Date().toISOString().slice(0,10);
          const isFuture = new Date(`${a.date}T${a.endTime}:00`) > new Date();
          // 同シフトメンバー (Round 5)
          const cws = (data.coworkers || {})[a.id] || [];
          const cwHtml = cws.length ? `
            <div class="mt-1.5 text-[11px] bg-blue-50 border border-blue-100 rounded px-2 py-1">
              <span class="text-blue-700 font-semibold">👥 同シフト:</span>
              ${cws.map(c => {
                const cpos = (data.positions || []).find(p => p.id === c.position) || { label: c.position };
                return `<span class="inline-block bg-white border border-blue-200 rounded px-1.5 py-0.5 ml-1">${escapeHtml(c.name)}<span class="text-blue-500 text-[10px]"> (${escapeHtml(cpos.label)})</span></span>`;
              }).join("")}
            </div>` : `
            <div class="mt-1 text-[11px] text-slate-400">👥 この時間帯はあなた一人です</div>`;

          // 緊急休み申請ボタン (Round 7) — 当日かつ未来のシフトのみ
          const emergencyBtn = (isToday && isFuture) ? `
            <button class="emergency-absence-btn mt-2 text-xs bg-red-50 border border-red-300 hover:bg-red-100 text-red-700 rounded-md px-3 py-1.5 font-semibold w-full"
              data-shift-id="${escapeAttr(a.id)}"
              data-shift-time="${escapeAttr(a.startTime + "〜" + a.endTime)}"
              aria-label="今日のシフトを緊急で休みたい">
              ⛔ 今日休みたい（緊急連絡）
            </button>` : "";

          div.innerHTML = `
            <div class="flex items-center justify-between">
              <div>
                <div class="text-base font-semibold">${escapeHtml(pos.label)}</div>
                <div class="text-sm text-slate-700">${escapeHtml(a.startTime || "")}〜${escapeHtml(a.endTime || "")} <span class="text-xs text-slate-500">(${h.toFixed(1)}h)</span></div>
              </div>
              <div class="text-right text-xs text-slate-500">${fmtYen(a.cost || (data.staff.hourlyWage * h))}</div>
            </div>
            ${cwHtml}
            ${emergencyBtn}`;
          inner.appendChild(div);
        }
      }
      grid.appendChild(card);
    }

    // メッセージ送信ボタン
    const msgBtn = document.getElementById("msgBtn");
    if (msgBtn) msgBtn.onclick = openMessageDialog;

    // iCal ダウンロードボタン (Round 6)
    const icalBtn = document.getElementById("icalBtn");
    if (icalBtn) icalBtn.onclick = () => downloadIcs();

    // 緊急休み申請ボタン (Round 7)
    document.querySelectorAll(".emergency-absence-btn").forEach(btn => {
      btn.onclick = () => {
        const shiftTime = btn.getAttribute("data-shift-time");
        if (!confirm(
          `今日のシフト (${shiftTime}) を緊急で休みたい旨を店長にメールします。\n\n` +
          `件名に「【緊急】当日休み連絡」が付きます。\n` +
          `送信前に LINE / 電話でも直接連絡することをお勧めします。`
        )) return;
        openEmergencyAbsenceDialog(shiftTime);
      };
    });
  }

  // 緊急休み申請ダイアログ (Round 7)
  function openEmergencyAbsenceDialog(shiftTime) {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md p-5 space-y-3">
        <h3 class="font-bold text-lg text-red-700">⛔ 今日のシフト休み申請</h3>
        <p class="text-sm text-slate-600">対象シフト: <strong>${escapeHtml(shiftTime)}</strong></p>
        <label class="block text-sm">
          <span class="text-slate-700 font-medium">理由を選択</span>
          <select id="abs-reason" class="mt-1 w-full border rounded-md px-3 py-2">
            <option value="">選択してください</option>
            <option>体調不良（発熱・倦怠感等）</option>
            <option>家族の急病・介護</option>
            <option>交通機関の遅延・運休</option>
            <option>事故・けが</option>
            <option>その他緊急事情</option>
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-slate-700 font-medium">補足（任意）</span>
          <textarea id="abs-detail" maxlength="500" class="mt-1 w-full border rounded-md px-3 py-2 h-20"
            placeholder="例: 朝から熱があり病院に行きます / 電車が運転見合わせ"></textarea>
        </label>
        <div class="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900">
          ⚠️ メール送信後も、念のため LINE / 電話でも店長にご連絡ください。
        </div>
        <div class="flex gap-2 justify-end">
          <button id="abs-cancel" class="px-3 py-1.5 text-sm">キャンセル</button>
          <button id="abs-send" class="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-md font-semibold">送信</button>
        </div>
        <div id="abs-status" class="text-xs text-center hidden"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#abs-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#abs-send").onclick = async () => {
      const reason = overlay.querySelector("#abs-reason").value;
      const detail = overlay.querySelector("#abs-detail").value.trim();
      if (!reason) { toast("理由を選んでください", "error"); return; }
      const message = `【緊急】当日休み連絡\n対象: ${shiftTime}\n理由: ${reason}` + (detail ? `\n補足: ${detail}` : "");
      const status = overlay.querySelector("#abs-status");
      const btn = overlay.querySelector("#abs-send");
      btn.disabled = true; btn.textContent = "送信中…";
      try {
        await window.ShiftyAPI.portalSendMessage(token, "report", message);
        status.textContent = "✅ 送信完了。店長から確認のご連絡があります。LINE/電話でも念のためご連絡を。";
        status.className = "text-xs text-center text-emerald-600";
        status.classList.remove("hidden");
        setTimeout(() => overlay.remove(), 3500);
      } catch (e) {
        status.textContent = "送信失敗: " + e.message + "（LINE/電話でご連絡ください）";
        status.className = "text-xs text-center text-red-600";
        status.classList.remove("hidden");
        btn.disabled = false; btn.textContent = "送信";
      }
    };
  }

  // .ics ファイル生成 (RFC 5545 準拠の最小限) — Round 6
  function downloadIcs() {
    const myAss = (data.assignments || []).slice().sort((a, b) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    if (!myAss.length) { toast("シフトがありません", "error"); return; }

    function pad(n) { return String(n).padStart(2, "0"); }
    function dtJst(date, time) {
      // date "YYYY-MM-DD", time "HH:MM" → JST 表記
      // iCal の DTSTART;TZID=Asia/Tokyo:YYYYMMDDTHHmmSS
      return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
    }
    function nowUtc() {
      const d = new Date();
      return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    }
    const restaurant = data.restaurantName || "Shifty";
    const staffName = data.staff?.name || "";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Shifty//JP//JA",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${restaurant} - ${staffName}`,
      "X-WR-TIMEZONE:Asia/Tokyo",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "TZNAME:JST",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
    for (const a of myAss) {
      const pos = (data.positions || []).find(p => p.id === a.position) || { label: a.position };
      const uid = `${a.id || `${a.date}-${a.startTime}-${a.staffId}`}@shifty.in-dx.jp`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${nowUtc()}`,
        `DTSTART;TZID=Asia/Tokyo:${dtJst(a.date, a.startTime)}`,
        `DTEND;TZID=Asia/Tokyo:${dtJst(a.date, a.endTime)}`,
        `SUMMARY:${escapeIcs(restaurant + " " + (pos.label || ""))}`,
        `LOCATION:${escapeIcs(restaurant)}`,
        `DESCRIPTION:${escapeIcs(`${staffName} さんのシフト\\n${restaurant}\\n\\n勤務時間: ${a.startTime}〜${a.endTime}\\nポジション: ${pos.label}`)}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:出勤の 1 時間前です",
        "TRIGGER:-PT1H",
        "END:VALARM",
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    const ics = lines.join("\r\n");

    function escapeIcs(s) {
      return String(s || "").replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
    }

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${restaurant}_${data.weekStart || "shift"}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`${myAss.length} 件のシフトを .ics でダウンロード。カレンダーアプリで開いてください`, "success", 5000);
  }

  // ===== 店長への連絡ダイアログ =====
  function openMessageDialog() {
    // 確定済シフトのリストから「変更希望」をプルダウン選択可能に (Round 4)
    const myShifts = (data.assignments || []).slice().sort((a, b) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <h3 class="font-bold text-lg">💬 店長に連絡</h3>

        <div class="grid grid-cols-4 gap-1.5">
          <button class="msg-kind-btn text-xs font-semibold py-2 rounded border-2 active:scale-95" data-kind="change_request">🔄<br>変更希望</button>
          <button class="msg-kind-btn text-xs font-semibold py-2 rounded border-2 active:scale-95" data-kind="question">❓<br>質問</button>
          <button class="msg-kind-btn text-xs font-semibold py-2 rounded border-2 active:scale-95" data-kind="report">📌<br>報告</button>
          <button class="msg-kind-btn text-xs font-semibold py-2 rounded border-2 active:scale-95" data-kind="general">💬<br>その他</button>
        </div>

        <div id="changeRequestForm" class="hidden space-y-2">
          <label class="block text-sm">
            <span class="text-slate-600">変更したいシフト</span>
            <select id="msgShift" class="mt-1 w-full border rounded-md px-3 py-2">
              <option value="">選択してください</option>
              ${myShifts.map(a => `<option value="${a.id}">${a.date.slice(5)} ${a.startTime}〜${a.endTime}</option>`).join("")}
            </select>
          </label>
          <label class="block text-sm">
            <span class="text-slate-600">理由（必須）</span>
            <select id="msgReason" class="mt-1 w-full border rounded-md px-3 py-2">
              <option value="">選択してください</option>
              <option>体調不良</option>
              <option>家族の用事</option>
              <option>授業・試験</option>
              <option>他バイト</option>
              <option>急用</option>
              <option>その他（詳細を下に記入）</option>
            </select>
          </label>
          <label class="block text-sm">
            <span class="text-slate-600">代替案（任意）</span>
            <input id="msgAlt" class="mt-1 w-full border rounded-md px-3 py-2 text-sm"
              placeholder="例: 翌日同時間なら出れます / 14時以降なら可能" />
          </label>
        </div>

        <label class="block text-sm">
          <span class="text-slate-600">メッセージ <span id="msgTextHint" class="text-xs text-slate-400"></span></span>
          <textarea id="msgText" class="mt-1 w-full border rounded-md px-3 py-2 h-20" maxlength="2000" placeholder="補足があればこちらに..."></textarea>
        </label>

        <div class="flex gap-2 justify-end">
          <button id="msgCancel" class="px-3 py-1.5 text-sm">キャンセル</button>
          <button id="msgSend" class="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-md font-semibold">送信</button>
        </div>
        <div id="msgStatus" class="text-xs text-center hidden"></div>
      </div>`;
    document.body.appendChild(overlay);

    let selectedKind = "change_request";
    function refreshKindUI() {
      overlay.querySelectorAll(".msg-kind-btn").forEach(b => {
        const k = b.getAttribute("data-kind");
        if (k === selectedKind) {
          b.classList.add("bg-amber-500", "text-white", "border-amber-500");
          b.classList.remove("bg-white", "text-slate-600", "border-slate-200");
        } else {
          b.classList.remove("bg-amber-500", "text-white", "border-amber-500");
          b.classList.add("bg-white", "text-slate-600", "border-slate-200");
        }
      });
      const cr = overlay.querySelector("#changeRequestForm");
      if (selectedKind === "change_request") cr.classList.remove("hidden");
      else cr.classList.add("hidden");
      const ph = overlay.querySelector("#msgText");
      ph.placeholder = selectedKind === "change_request"
        ? "上記で選んだシフトについて、補足があればこちらに..."
        : selectedKind === "question" ? "例: 来週の希望提出はいつまでですか？"
        : selectedKind === "report" ? "例: 5/12 の終電が遅延した件の報告..."
        : "例: お知らせがあります";
    }
    refreshKindUI();

    overlay.querySelectorAll(".msg-kind-btn").forEach(b => {
      b.onclick = () => { selectedKind = b.getAttribute("data-kind"); refreshKindUI(); };
    });

    overlay.querySelector("#msgCancel").onclick = () => overlay.remove();
    overlay.querySelector("#msgSend").onclick = async () => {
      let message = overlay.querySelector("#msgText").value.trim();
      // change_request の場合は構造化テキストを生成
      if (selectedKind === "change_request") {
        const shiftId = overlay.querySelector("#msgShift").value;
        const reason = overlay.querySelector("#msgReason").value;
        const alt = overlay.querySelector("#msgAlt").value.trim();
        if (!shiftId) { toast("変更したいシフトを選んでください", "error"); return; }
        if (!reason) { toast("理由を選んでください", "error"); return; }
        const sh = myShifts.find(a => a.id === shiftId);
        const dt = sh ? `${sh.date} ${sh.startTime}〜${sh.endTime}` : "?";
        const lines = [
          "【シフト変更希望】",
          `対象: ${dt}`,
          `理由: ${reason}`,
        ];
        if (alt) lines.push(`代替案: ${alt}`);
        if (message) lines.push(`補足: ${message}`);
        message = lines.join("\n");
      }
      if (!message) { toast("メッセージを入力してください", "error"); return; }
      const status = overlay.querySelector("#msgStatus");
      const btn = overlay.querySelector("#msgSend");
      btn.disabled = true; btn.textContent = "送信中…";
      try {
        await window.ShiftyAPI.portalSendMessage(token, selectedKind, message);
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
