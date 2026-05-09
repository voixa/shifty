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
  let prefs = {};       // {`${date}|${sessId}`: priority}  — セッション 4 ボタンモード
  let customTimes = {}; // {`${date}|${sessId}`: {startTime, endTime}}  セッション内時間調整
  let freePrefs = {};   // {date: [{ id, startTime, endTime, priority }, ...]} — Round 18: 自由時間希望
  let comments = {};    // {date: text}
  let dirty = false;
  let activeWeek = null; // 複数週対応 (Round 15 TOP 2): 選択中の週 (YYYY-MM-DD)
  // 週別 draft key (Round 15: 複数週対応)
  function draftKeyFor(wk) { return `shifty.portal.draft.${token || "anon"}.${wk || "current"}`; }
  let DRAFT_KEY = `shifty.portal.draft.${token || "anon"}`;
  // 希望テンプレート (Round 8) — 曜日 × セッション の優先度をローカル保存
  // {`${dow}|${sessId}`: priority}
  const PREF_TEMPLATE_KEY = `shifty.portal.template.${token || "anon"}`;
  // 自動適用フラグ (Round 15 TOP 3)
  const PREF_AUTO_APPLY_KEY = `shifty.portal.autoapply.${token || "anon"}`;
  function loadPrefTemplate() {
    try { const raw = localStorage.getItem(PREF_TEMPLATE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function savePrefTemplate(tpl) {
    try { localStorage.setItem(PREF_TEMPLATE_KEY, JSON.stringify(tpl)); } catch (_) {}
  }
  function loadAutoApply() {
    try { return localStorage.getItem(PREF_AUTO_APPLY_KEY) === "1"; } catch (_) { return false; }
  }
  function saveAutoApply(on) {
    try { localStorage.setItem(PREF_AUTO_APPLY_KEY, on ? "1" : "0"); } catch (_) {}
  }
  // 自動適用済みの週を記録 (Round 15 TOP 3)
  // 同じ週で何度もテンプレが空白を埋めないように
  const PREF_AUTO_APPLIED_WEEKS_KEY = `shifty.portal.autoapplied.${token || "anon"}`;
  function isWeekAutoApplied(wk) {
    try {
      const raw = localStorage.getItem(PREF_AUTO_APPLIED_WEEKS_KEY);
      if (!raw) return false;
      return JSON.parse(raw).includes(wk);
    } catch (_) { return false; }
  }
  function markWeekAutoApplied(wk) {
    try {
      const raw = localStorage.getItem(PREF_AUTO_APPLIED_WEEKS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!arr.includes(wk)) arr.push(wk);
      // 最新 12 件のみ保持
      const trimmed = arr.slice(-12);
      localStorage.setItem(PREF_AUTO_APPLIED_WEEKS_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        prefs, customTimes, freePrefs, comments, savedAt: Date.now()
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

  function toast(msg, type = "", durationMs = 3000) {
    const t = document.createElement("div");
    t.className = `toast-item ${type}`;
    t.textContent = msg;
    $("#toast").appendChild(t);
    setTimeout(() => t.remove(), durationMs);
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

  // ===== PWA インストール促進 (Round 21 TOP 3) =====
  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
  }
  function isiOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }
  function isInstallDismissed() {
    try { return localStorage.getItem("shifty.installDismissed") === "1"; }
    catch (_) { return false; }
  }
  function markInstallDismissed() {
    try { localStorage.setItem("shifty.installDismissed", "1"); } catch (_) {}
  }
  function renderInstallBanner() {
    if (isStandalone() || isInstallDismissed()) return "";
    const hasNativePrompt = !!window.__SHIFTY_INSTALL_PROMPT__;
    if (!hasNativePrompt && !isiOS()) return ""; // 他環境は表示しない
    const ios = isiOS();
    return `
      <div id="install-banner" class="bg-gradient-to-br from-indigo-500 to-brand-700 rounded-xl p-3 mb-3 text-white shadow-lg">
        <div class="flex items-start gap-2">
          <div class="text-2xl">📱</div>
          <div class="flex-1">
            <div class="font-bold text-sm">ホーム画面に追加すると便利です</div>
            <div class="text-xs opacity-90 mt-0.5">アプリのように 1 タップで開けます。打刻もすぐ。${ios ? "(iPhone は手順説明)" : ""}</div>
            <div class="mt-2 flex gap-2 flex-wrap">
              ${hasNativePrompt ? `<button id="install-btn" class="bg-white text-indigo-700 rounded px-3 py-1.5 text-xs font-bold">📲 ホーム画面に追加</button>` : ""}
              ${ios ? `<button id="install-ios-btn" class="bg-white text-indigo-700 rounded px-3 py-1.5 text-xs font-bold">📲 iPhone での追加方法</button>` : ""}
              <button id="install-dismiss-btn" class="text-xs opacity-80 hover:opacity-100 px-2 py-1.5">後で</button>
            </div>
          </div>
        </div>
      </div>`;
  }
  function attachInstallBannerHandlers() {
    const installBtn = document.getElementById("install-btn");
    if (installBtn) installBtn.onclick = async () => {
      const p = window.__SHIFTY_INSTALL_PROMPT__;
      if (!p) return;
      try {
        p.prompt();
        const { outcome } = await p.userChoice;
        window.__SHIFTY_INSTALL_PROMPT__ = null;
        if (outcome === "accepted") {
          toast("✓ ホーム画面に追加されました", "success", 4000);
          const b = document.getElementById("install-banner"); if (b) b.remove();
        }
      } catch (e) { console.warn("install prompt failed", e); }
    };
    const iosBtn = document.getElementById("install-ios-btn");
    if (iosBtn) iosBtn.onclick = () => {
      const overlay = document.createElement("div");
      overlay.className = "fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4";
      overlay.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl max-w-sm w-full p-5 space-y-3">
          <h3 class="font-bold text-base">📱 iPhone でホーム画面に追加</h3>
          <ol class="text-sm space-y-2 list-decimal list-inside">
            <li>下部の <span class="inline-block bg-blue-50 border border-blue-200 rounded px-1.5">⬆️ 共有ボタン</span> をタップ</li>
            <li>「ホーム画面に追加」を選択</li>
            <li>右上の「追加」をタップ</li>
          </ol>
          <p class="text-xs text-slate-500">※ Safari でアクセスしている必要があります</p>
          <button id="ios-close" class="w-full bg-slate-200 rounded py-2 text-sm">閉じる</button>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#ios-close").onclick = () => overlay.remove();
    };
    const dismissBtn = document.getElementById("install-dismiss-btn");
    if (dismissBtn) dismissBtn.onclick = () => {
      markInstallDismissed();
      const b = document.getElementById("install-banner"); if (b) b.remove();
    };
  }
  // beforeinstallprompt イベント受信時に再描画
  window.addEventListener("shifty-install-available", () => {
    // 描画済みの場合のみ再描画
    if (data && $("#app").innerHTML.length > 0) {
      try {
        if (data.weekStatus === "published") renderPublished(); else renderDraft();
      } catch (_) {}
    }
  });

  async function init() {
    if (!token) return showError("リンクが無効です。店長から正しい URL を受け取ってください。");
    try {
      data = await window.ShiftyAPI.portalGet(token);
    } catch (e) {
      return showError("リンクが無効・期限切れの可能性があります。店長にご確認ください。");
    }

    activeWeek = data.weekStart || null;
    DRAFT_KEY = draftKeyFor(activeWeek);

    // 初回ガイドツアー (Round 10) — 一度だけ表示
    const tourKey = `shifty.portal.toured.${token || "anon"}`;
    if (!localStorage.getItem(tourKey)) {
      try { localStorage.setItem(tourKey, Date.now().toString()); } catch (_) {}
      setTimeout(showOnboardingTour, 300);
    }

    if (data.weekStatus === "published") {
      renderPublished();
    } else {
      loadPrefsFromData();
      renderDraft();
    }
  }

  function loadPrefsFromData() {
    prefs = {}; customTimes = {}; freePrefs = {}; comments = {};
    for (const p of (data.preferences || [])) {
      const sess = (data.sessions || []).find(s => s.startTime === p.startTime && s.endTime === p.endTime);
      if (sess) {
        // セッションぴったり一致 → 4 ボタンモード
        prefs[`${p.date}|${sess.id}`] = p.priority;
      } else {
        // セッションに収まる調整時間 → customTimes (1 セッションあたり 1 つだけ)
        const owner = (data.sessions || []).find(s =>
          timeToMin(p.startTime) >= timeToMin(s.startTime) &&
          timeToMin(p.endTime) <= timeToMin(s.endTime)
        );
        const k = owner ? `${p.date}|${owner.id}` : null;
        if (owner && !prefs[k]) {
          // セッション内収まり、かつ同セッションにまだ pref 無し → customTimes
          prefs[k] = p.priority;
          customTimes[k] = { startTime: p.startTime, endTime: p.endTime };
        } else {
          // セッション跨ぎ or 同セッション 2 件目 → 自由時間希望 (Round 18)
          if (!freePrefs[p.date]) freePrefs[p.date] = [];
          freePrefs[p.date].push({
            id: p.id || ("fp_" + Math.random().toString(36).slice(2, 9)),
            startTime: p.startTime,
            endTime: p.endTime,
            priority: p.priority,
          });
        }
      }
    }
    comments = data.comments || {};

    // 自動適用 (Round 15 TOP 3): テンプレが保存されていて、その週が空 & 未適用 なら自動で埋める
    const autoApply = loadAutoApply();
    if (autoApply && Object.keys(prefs).length === 0 && !isWeekAutoApplied(activeWeek)) {
      const tpl = loadPrefTemplate();
      if (tpl && Object.keys(tpl).length > 0) {
        const days = Array.from({ length: 7 }, (_, i) => addDays(activeWeek, i));
        let applied = 0;
        for (const date of days) {
          const dow = dayOfWeek(date);
          for (const sess of (data.sessions || [])) {
            const tplKey = `${dow}|${sess.id}`;
            if (tpl[tplKey]) {
              prefs[`${date}|${sess.id}`] = tpl[tplKey];
              applied++;
            }
          }
        }
        if (applied > 0) {
          dirty = true;
          saveDraft();
          markWeekAutoApplied(activeWeek);
          // 表示用フラグ — トーストは renderDraft 後に出す
          window.__SHIFTY_AUTO_APPLIED_COUNT__ = applied;
        }
      }
    }

    // restore localStorage draft if newer (週別キー)
    const draft = loadDraft();
    if (draft && (Object.keys(draft.prefs || {}).length > 0 || Object.keys(draft.comments || {}).length > 0 || Object.keys(draft.freePrefs || {}).length > 0)) {
      const keys = Object.keys(draft.prefs || {});
      const hasUnsavedChange = keys.some(k => draft.prefs[k] !== prefs[k])
        || Object.keys(draft.comments || {}).some(k => (draft.comments[k] || "") !== (comments[k] || ""))
        || Object.keys(draft.customTimes || {}).some(k => JSON.stringify(draft.customTimes[k]) !== JSON.stringify(customTimes[k]))
        || JSON.stringify(draft.freePrefs || {}) !== JSON.stringify(freePrefs);
      if (hasUnsavedChange && confirm(
        "前回未送信の入力があります。復元しますか？\n\n" +
        "「キャンセル」を押すと送信済みの内容を表示します。"
      )) {
        prefs = { ...prefs, ...(draft.prefs || {}) };
        customTimes = { ...customTimes, ...(draft.customTimes || {}) };
        freePrefs = { ...freePrefs, ...(draft.freePrefs || {}) };
        comments = { ...comments, ...(draft.comments || {}) };
        dirty = true;
      } else {
        clearDraft();
      }
    }
  }

  // 別の週に切替 (Round 15 TOP 2)
  async function switchWeek(weekStart) {
    if (weekStart === activeWeek) return;
    if (dirty && !confirm("未送信の変更を破棄して別の週に切り替えますか？\n\n（テンプレ保存済の場合は再適用できます）")) {
      return;
    }
    try {
      const newData = await window.ShiftyAPI.portalGet(token, weekStart);
      data = newData;
      activeWeek = newData.weekStart;
      DRAFT_KEY = draftKeyFor(activeWeek);
      dirty = false;
      if (newData.weekStatus === "published") {
        renderPublished();
      } else {
        loadPrefsFromData();
        renderDraft();
      }
    } catch (e) {
      toast("週の取得に失敗しました: " + (e?.message || ""), "error");
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
    const sessionFilled = Object.values(prefs).filter(v => v).length;
    const freeFilledDays = Object.keys(freePrefs).filter(d => (freePrefs[d] || []).length > 0).length;
    const filledCells = sessionFilled + freeFilledDays;
    // 自由時間希望は 1 日でカウント (= 7 日中 X 日に何かを入力)
    const progress = totalCells ? Math.min(100, Math.round((filledCells / totalCells) * 100)) : 0;

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

    // 過去の希望提出履歴 (Round 12)
    const prefHist = data.prefHistory || [];
    const prefHistCard = prefHist.length > 0 ? `
      <div class="bg-white border border-slate-200 rounded-xl p-3 mb-3">
        <details>
          <summary class="text-sm font-semibold cursor-pointer select-none">📊 過去の希望提出履歴 (${prefHist.length} 週分)</summary>
          <div class="mt-2 space-y-1 text-xs">
            ${prefHist.map(p => `
              <div class="flex items-center justify-between bg-slate-50 rounded p-1.5">
                <span class="font-mono">${escapeHtml(p.weekStart)} 週</span>
                <div class="text-right text-[11px]">
                  <span class="text-red-700">必須 ${p.must}</span>・<span class="text-emerald-700">希望 ${p.want}</span>・<span class="text-slate-600">不可 ${p.avoid}</span>
                </div>
              </div>`).join("")}
          </div>
        </details>
      </div>` : "";

    // 希望テンプレートカード (Round 8 + Round 15: auto-apply)
    const tpl = loadPrefTemplate();
    const autoApplyOn = loadAutoApply();
    const tplCard = `
      <div class="bg-white border border-slate-200 rounded-xl p-3 mb-3">
        <details ${tpl ? "open" : ""}>
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
          ${tpl ? `
          <label class="mt-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="checkbox" id="tpl-auto" ${autoApplyOn ? "checked" : ""} class="rounded">
            <span>🔁 <b>新しい週を開いたとき自動でテンプレを適用</b>
              <span class="block text-[10px] text-slate-500 ml-5">空の週を開くたびにテンプレが反映されます (送信は手動)。週切替時にも適用。</span>
            </span>
          </label>` : ""}
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

    // 複数週タブ (Round 15 TOP 2)
    let weekTabsHtml = "";
    if ((data.availableWeeks || []).length > 1) {
      const tabs = data.availableWeeks.map(w => {
        const isActive = w.weekStart === activeWeek;
        const label = w.offset === 0 ? "今週" : (w.offset === 1 ? "来週" : `+${w.offset}週`);
        const statusBadge = w.status === "published"
          ? `<span class="text-[9px] bg-emerald-100 text-emerald-800 rounded px-1 ml-1">確定</span>`
          : "";
        return `<button data-week="${escapeAttr(w.weekStart)}" class="week-tab-btn flex-1 py-2 px-2 text-xs font-semibold rounded-md ${isActive ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 border border-slate-200'}">
          ${label}<span class="block text-[10px] opacity-70">${escapeHtml(w.weekStart.slice(5))}</span>${statusBadge}
        </button>`;
      }).join("");
      weekTabsHtml = `
        <div class="bg-slate-50 rounded-xl p-2 mb-3">
          <div class="text-[10px] text-slate-500 mb-1.5 px-1">📆 週を切り替えて先まで希望提出できます</div>
          <div class="flex gap-1.5">${tabs}</div>
        </div>`;
    }

    // 長期休暇申請カード (Round 16 TOP 1)
    const vacCard = renderVacationCard();

    const installBannerHtmlD = renderInstallBanner();

    $("#app").innerHTML = `
      ${weekTabsHtml}
      ${installBannerHtmlD}
      ${draftNoticeCard}
      ${deadlineCard}
      ${tplCard}
      ${vacCard}
      ${prefHistCard}
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
              <div class="bg-slate-50 rounded p-1.5">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-mono">${escapeHtml(h.date)}</span>
                    <span class="text-slate-600">${escapeHtml(h.startTime)}〜${escapeHtml(h.endTime)}</span>
                  </div>
                  <div class="text-right">
                    <div class="text-slate-700">${h.hours}h</div>
                    <div class="text-[10px] text-slate-500">${fmtYen(h.pay)}</div>
                  </div>
                </div>
                ${(h.note && h.note.trim()) ? `<div class="mt-1 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">📝 ${escapeHtml(h.note.trim())}</div>` : ""}
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

      // 自由時間希望セクション (Round 18 TOP 1)
      const freeList = freePrefs[date] || [];
      const freeRow = document.createElement("div");
      freeRow.className = "border-t border-slate-100 pt-2 mt-1 px-1";
      const freeId = `free-${date}`;
      freeRow.innerHTML = `
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs font-semibold text-slate-700">⏰ 自由時間で希望</span>
          <button class="add-free-btn text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-300 rounded px-2 py-1 font-semibold"
            data-date="${date}" aria-label="自由時間希望を追加">＋ 時間を追加</button>
        </div>
        <div id="${freeId}" class="space-y-1"></div>
        ${freeList.length === 0 ? `<div class="text-[10px] text-slate-400">例: 17:00〜23:00 で入りたい・10:00〜14:00 のみ可、など細かく指定したい場合はこちら</div>` : ""}`;
      inner.appendChild(freeRow);
      // 既存の自由時間希望を描画
      const freeContainer = freeRow.querySelector(`#${CSS.escape(freeId)}`);
      for (const fp of freeList) {
        const PRIO_LABEL = {
          must: { label: "必須", cls: "bg-red-50 border-red-300 text-red-800", emoji: "🔥" },
          want: { label: "希望", cls: "bg-emerald-50 border-emerald-300 text-emerald-800", emoji: "✅" },
          avoid: { label: "不可", cls: "bg-slate-100 border-slate-300 text-slate-700", emoji: "🚫" },
        };
        const meta = PRIO_LABEL[fp.priority] || PRIO_LABEL.want;
        const item = document.createElement("div");
        item.className = `flex items-center justify-between border rounded px-2 py-1 text-xs ${meta.cls}`;
        item.innerHTML = `
          <span class="font-mono">${escapeHtml(fp.startTime)}〜${escapeHtml(fp.endTime)}</span>
          <span class="font-semibold">${meta.emoji} ${meta.label}</span>
          <button class="del-free-btn text-slate-400 hover:text-red-600 ml-2" data-date="${date}" data-id="${escapeAttr(fp.id)}" aria-label="削除">🗑</button>`;
        freeContainer.appendChild(item);
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

    // 自由時間希望ボタン (Round 18 TOP 1)
    grid.querySelectorAll(".add-free-btn").forEach(btn => {
      btn.onclick = () => openFreeTimeDialog(btn.getAttribute("data-date"));
    });
    grid.querySelectorAll(".del-free-btn").forEach(btn => {
      btn.onclick = () => {
        const date = btn.getAttribute("data-date");
        const id = btn.getAttribute("data-id");
        if (!freePrefs[date]) return;
        freePrefs[date] = freePrefs[date].filter(f => f.id !== id);
        if (freePrefs[date].length === 0) delete freePrefs[date];
        dirty = true; saveDraft(); renderDraft();
      };
    });

    // 週切替タブ (Round 15 TOP 2)
    document.querySelectorAll(".week-tab-btn").forEach(btn => {
      btn.onclick = () => {
        const wk = btn.getAttribute("data-week");
        if (wk) switchWeek(wk);
      };
    });

    // PWA インストールバナー (Round 21 TOP 3)
    attachInstallBannerHandlers();

    // 長期休暇申請ボタン (Round 16 TOP 1)
    const vacBtn = document.getElementById("vac-new-btn");
    if (vacBtn) vacBtn.onclick = openVacationDialog;

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
      try { localStorage.removeItem(PREF_AUTO_APPLY_KEY); } catch (_) {}
      try { localStorage.removeItem(PREF_AUTO_APPLIED_WEEKS_KEY); } catch (_) {}
      toast("テンプレートを削除しました", "info");
      renderDraft();
    };
    // 自動適用トグル (Round 15 TOP 3)
    const tplAutoEl = document.getElementById("tpl-auto");
    if (tplAutoEl) tplAutoEl.onchange = () => {
      saveAutoApply(tplAutoEl.checked);
      toast(tplAutoEl.checked
        ? "✓ 新しい週を開いたとき自動で適用します"
        : "自動適用をオフにしました",
        "success", 3000);
    };

    // 自動適用後の通知 (Round 15 TOP 3)
    if (window.__SHIFTY_AUTO_APPLIED_COUNT__ > 0) {
      const n = window.__SHIFTY_AUTO_APPLIED_COUNT__;
      delete window.__SHIFTY_AUTO_APPLIED_COUNT__;
      setTimeout(() => toast(`🔁 テンプレを自動適用: ${n} 件 (内容を確認して送信してください)`, "success", 5000), 100);
    }

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
      // 自由時間希望 (Round 18 TOP 1) も送信
      for (const [date, list] of Object.entries(freePrefs)) {
        for (const fp of list) {
          out.push({
            id: fp.id || ("p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
            staffId: data.staff.id,
            date,
            startTime: fp.startTime,
            endTime: fp.endTime,
            priority: fp.priority,
          });
        }
      }
      const btn = $("#saveBtn");
      btn.disabled = true;
      btn.textContent = "送信中...";
      try {
        await window.ShiftyAPI.portalSavePrefs(token, {
          preferences: out,
          comments,
          weekStart: activeWeek || data.weekStart,
        });
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
  // ===== 自由時間希望ダイアログ (Round 18 TOP 1) =====
  function openFreeTimeDialog(date) {
    // 営業時間の最小・最大時刻 (sessions の min/max)
    const sessions = data.sessions || [];
    let minMin = 6 * 60, maxMin = 24 * 60;
    if (sessions.length) {
      minMin = Math.min(...sessions.map(s => timeToMin(s.startTime)));
      maxMin = Math.max(...sessions.map(s => timeToMin(s.endTime)));
    }
    // 30 分刻みで選択肢生成
    const options = [];
    for (let m = minMin; m <= maxMin; m += 30) {
      const h = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      options.push(`${h}:${mm}`);
    }
    const defaultStart = options[Math.floor(options.length / 4)] || "11:00";
    const defaultEnd = options[Math.floor(options.length * 3 / 4)] || "20:00";
    const opts = (current) => options.map(o => `<option value="${o}" ${o === current ? "selected" : ""}>${o}</option>`).join("");

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 space-y-3">
        <h3 class="font-bold text-base">⏰ ${date.slice(5)} の自由時間希望</h3>
        <p class="text-xs text-slate-600">セッション(ランチ/ディナー)の枠に縛られず、自分の入れる時間を自由に登録できます。</p>
        <div class="grid grid-cols-2 gap-3">
          <label class="block text-sm">
            <span class="text-slate-700">開始</span>
            <select id="ft-start" class="mt-1 w-full border rounded-md px-3 py-2">${opts(defaultStart)}</select>
          </label>
          <label class="block text-sm">
            <span class="text-slate-700">終了</span>
            <select id="ft-end" class="mt-1 w-full border rounded-md px-3 py-2">${opts(defaultEnd)}</select>
          </label>
        </div>
        <div>
          <span class="text-sm text-slate-700">優先度</span>
          <div class="grid grid-cols-3 gap-2 mt-1">
            <button data-prio="must" class="ft-prio-btn text-xs font-semibold py-2 rounded-md border-2 bg-white text-red-600 border-red-200">🔥 必須</button>
            <button data-prio="want" class="ft-prio-btn text-xs font-semibold py-2 rounded-md border-2 bg-emerald-500 text-white border-emerald-500">✅ 希望</button>
            <button data-prio="avoid" class="ft-prio-btn text-xs font-semibold py-2 rounded-md border-2 bg-white text-slate-500 border-slate-200">🚫 不可</button>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button id="ft-cancel" class="px-3 py-1.5 text-sm bg-slate-200 rounded-md">キャンセル</button>
          <button id="ft-add" class="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md font-semibold">追加</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let chosenPrio = "want";
    overlay.querySelectorAll(".ft-prio-btn").forEach(b => {
      b.onclick = () => {
        chosenPrio = b.getAttribute("data-prio");
        overlay.querySelectorAll(".ft-prio-btn").forEach(x => {
          const p = x.getAttribute("data-prio");
          if (p === chosenPrio) {
            x.className = `ft-prio-btn text-xs font-semibold py-2 rounded-md border-2 ${
              p === "must" ? "bg-red-500 text-white border-red-500"
              : p === "want" ? "bg-emerald-500 text-white border-emerald-500"
              : "bg-slate-600 text-white border-slate-600"
            }`;
          } else {
            x.className = `ft-prio-btn text-xs font-semibold py-2 rounded-md border-2 ${
              p === "must" ? "bg-white text-red-600 border-red-200"
              : p === "want" ? "bg-white text-emerald-600 border-emerald-200"
              : "bg-white text-slate-500 border-slate-200"
            }`;
          }
        });
      };
    });
    overlay.querySelector("#ft-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#ft-add").onclick = () => {
      const start = overlay.querySelector("#ft-start").value;
      const end = overlay.querySelector("#ft-end").value;
      if (timeToMin(end) <= timeToMin(start)) {
        toast("終了時刻は開始時刻より後にしてください", "error"); return;
      }
      // 重複チェック (簡易): 同日の同優先度・同時間帯
      const list = freePrefs[date] || [];
      if (list.some(f => f.startTime === start && f.endTime === end)) {
        toast("同じ時間帯が既に登録されています", "error"); return;
      }
      const newItem = {
        id: "fp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        startTime: start,
        endTime: end,
        priority: chosenPrio,
      };
      if (!freePrefs[date]) freePrefs[date] = [];
      freePrefs[date].push(newItem);
      // 開始時刻でソート
      freePrefs[date].sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
      dirty = true; saveDraft();
      overlay.remove();
      renderDraft();
      toast(`✓ ${date.slice(5)} ${start}〜${end} を「${chosenPrio === "must" ? "必須" : chosenPrio === "want" ? "希望" : "不可"}」で追加`, "success");
    };
  }

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
    // 打刻カード (Round 19) — 今日のシフトに対する出勤/退勤打刻
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayShifts = (data.assignments || []).filter(a => a.date === todayStr)
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    let clockCard = "";
    if (todayShifts.length > 0) {
      clockCard = todayShifts.map(a => renderClockCard(a, data)).join("");
    }

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
      const nextNote = (next.note && next.note.trim()) ? `
          <div class="mt-2 bg-white/20 backdrop-blur-sm rounded px-2 py-1 text-xs flex items-start gap-1">
            <span class="font-semibold">📝</span>
            <span class="whitespace-pre-wrap">${escapeHtml(next.note.trim())}</span>
          </div>` : "";
      // Round 27 TOP 1: AI 配置理由
      const nextReason = (next.reason) ? `
          <div class="mt-2 bg-white/15 rounded px-2 py-1 text-[11px] flex items-start gap-1">
            <span>🧠</span>
            <span>店長があなたを選んだ理由: ${escapeHtml(next.reason)}</span>
          </div>` : "";
      nextShiftCard = `
        <div class="bg-gradient-to-br from-blue-500 to-brand-600 rounded-xl p-4 mb-3 text-white shadow-lg">
          <div class="text-xs opacity-90">⏰ 次のシフト</div>
          <div class="font-bold text-lg mt-1">${next.date.slice(5)} (${dowLabel}) ${escapeHtml(next.startTime || "")}〜${escapeHtml(next.endTime || "")}</div>
          <div class="text-sm opacity-90 mt-0.5">${escapeHtml(pos.label)}</div>
          <div class="text-2xl font-bold mt-2">${countdown}</div>
          ${nextNote}
          ${nextReason}
        </div>`;
    }

    // 店長お知らせ (Round 9)
    const noticeCard = (data.ownerNotice && data.ownerNotice.trim()) ? `
      <div class="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-3">
        <div class="text-xs font-semibold text-amber-900 mb-1">📢 店長からのお知らせ</div>
        <div class="text-sm text-amber-900 whitespace-pre-wrap">${escapeHtml(data.ownerNotice.trim())}</div>
      </div>` : "";

    // 複数週タブ (Round 15 TOP 2) — 確定済モードでも表示
    let weekTabsHtml2 = "";
    if ((data.availableWeeks || []).length > 1) {
      const tabs2 = data.availableWeeks.map(w => {
        const isActive = w.weekStart === activeWeek;
        const label = w.offset === 0 ? "今週" : (w.offset === 1 ? "来週" : `+${w.offset}週`);
        const statusBadge = w.status === "published"
          ? `<span class="text-[9px] bg-emerald-100 text-emerald-800 rounded px-1 ml-1">確定</span>`
          : `<span class="text-[9px] bg-amber-100 text-amber-800 rounded px-1 ml-1">下書き</span>`;
        return `<button data-week="${escapeAttr(w.weekStart)}" class="week-tab-btn flex-1 py-2 px-2 text-xs font-semibold rounded-md ${isActive ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 border border-slate-200'}">
          ${label}<span class="block text-[10px] opacity-70">${escapeHtml(w.weekStart.slice(5))}</span>${statusBadge}
        </button>`;
      }).join("");
      weekTabsHtml2 = `
        <div class="bg-slate-50 rounded-xl p-2 mb-3">
          <div class="flex gap-1.5">${tabs2}</div>
        </div>`;
    }

    // 長期休暇申請カード (Round 16 TOP 1) — 確定モードでも表示
    const vacCard2 = renderVacationCard();
    // シフト交換掲示板カード (Round 16 TOP 2)
    const swapCard2 = renderSwapBoardCard();
    // 代打打診カード (Round 27 TOP 3)
    const subOfferCard = renderSubOfferCard();

    const installBannerHtml = renderInstallBanner();

    $("#app").innerHTML = `
      ${weekTabsHtml2}
      ${installBannerHtml}
      ${subOfferCard}
      ${clockCard}
      ${nextShiftCard}
      ${noticeCard}
      ${swapCard2}
      ${vacCard2}
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
              <div class="bg-slate-50 rounded p-1.5">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-mono">${escapeHtml(h.date)}</span>
                    <span class="text-slate-600">${escapeHtml(h.startTime)}〜${escapeHtml(h.endTime)}</span>
                  </div>
                  <div class="text-right">
                    <div class="text-slate-700">${h.hours}h</div>
                    <div class="text-[10px] text-slate-500">${fmtYen(h.pay)}</div>
                  </div>
                </div>
                ${(h.note && h.note.trim()) ? `<div class="mt-1 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">📝 ${escapeHtml(h.note.trim())}</div>` : ""}
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
        <button id="statementBtn" class="bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg px-5 py-3 text-sm font-semibold sm:col-span-2">
          🧾 今月の給与明細を見る
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

          // シフト交換に出すボタン (Round 16 TOP 2) — 未来のシフト & まだ募集してない
          const isOpenSwap = (data.swapsOpen || []).some(sw => sw.assignmentId === a.id);
          const swapBtn = (isFuture && !isOpenSwap) ? `
            <button class="swap-create-btn mt-2 text-xs bg-blue-50 border border-blue-300 hover:bg-blue-100 text-blue-700 rounded-md px-3 py-1.5 font-semibold w-full"
              data-aid="${escapeAttr(a.id)}"
              aria-label="このシフトを交換に出す">
              🔄 このシフトを交換に出す
            </button>` : (isOpenSwap ? `
            <div class="mt-2 text-xs bg-amber-50 border border-amber-300 text-amber-800 rounded-md px-3 py-1.5 font-semibold text-center">
              📢 交換募集中
            </div>` : "");

          // 個別シフトメモ (Round 14 TOP 3) — 店長が設定した申し送り
          const noteHtml = (a.note && a.note.trim()) ? `
            <div class="mt-2 bg-amber-50 border border-amber-300 rounded-md px-2 py-1.5 text-[12px] text-amber-900 flex items-start gap-1.5">
              <span class="font-semibold whitespace-nowrap">📝 店長から:</span>
              <span class="whitespace-pre-wrap">${escapeHtml(a.note.trim())}</span>
            </div>` : "";

          div.innerHTML = `
            <div class="flex items-center justify-between">
              <div>
                <div class="text-base font-semibold">${escapeHtml(pos.label)}</div>
                <div class="text-sm text-slate-700">${escapeHtml(a.startTime || "")}〜${escapeHtml(a.endTime || "")} <span class="text-xs text-slate-500">(${h.toFixed(1)}h)</span></div>
              </div>
              <div class="text-right text-xs text-slate-500">${fmtYen(a.cost || (data.staff.hourlyWage * h))}</div>
            </div>
            ${noteHtml}
            ${cwHtml}
            ${swapBtn}
            ${emergencyBtn}`;
          inner.appendChild(div);
        }
      }
      grid.appendChild(card);
    }

    // 週切替タブ (Round 15 TOP 2 — 確定モード)
    document.querySelectorAll(".week-tab-btn").forEach(btn => {
      btn.onclick = () => {
        const wk = btn.getAttribute("data-week");
        if (wk) switchWeek(wk);
      };
    });

    // PWA インストールバナー (Round 21 TOP 3)
    attachInstallBannerHandlers();

    // 打刻ボタン (Round 19)
    document.querySelectorAll(".clock-in-btn").forEach(btn => {
      btn.onclick = () => handleClockClick("in");
    });
    document.querySelectorAll(".clock-out-btn").forEach(btn => {
      btn.onclick = () => handleClockClick("out");
    });

    // 代打打診応答ボタン (Round 27 TOP 3)
    document.querySelectorAll(".sub-accept-btn").forEach(btn => {
      btn.onclick = () => respondSubOffer(btn.getAttribute("data-offer-id"), "accept");
    });
    document.querySelectorAll(".sub-decline-btn").forEach(btn => {
      btn.onclick = () => respondSubOffer(btn.getAttribute("data-offer-id"), "decline");
    });

    // 長期休暇申請ボタン (Round 16 TOP 1 — 確定モード)
    const vacBtn2 = document.getElementById("vac-new-btn");
    if (vacBtn2) vacBtn2.onclick = openVacationDialog;

    // シフト交換掲示板 (Round 16 TOP 2)
    document.querySelectorAll(".swap-take-btn").forEach(btn => {
      btn.onclick = () => takeSwapClick(btn.getAttribute("data-sid"));
    });
    document.querySelectorAll(".swap-create-btn").forEach(btn => {
      btn.onclick = () => createSwapClick(btn.getAttribute("data-aid"));
    });

    // メッセージ送信ボタン
    const msgBtn = document.getElementById("msgBtn");
    if (msgBtn) msgBtn.onclick = openMessageDialog;

    // iCal ダウンロードボタン (Round 6)
    const icalBtn = document.getElementById("icalBtn");
    if (icalBtn) icalBtn.onclick = () => downloadIcs();

    // 給与明細ボタン (Round 24 TOP 2)
    const stmtBtn = document.getElementById("statementBtn");
    if (stmtBtn) stmtBtn.onclick = () => openMonthlyStatement();

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

  // ===== 打刻カード (Round 19) =====
  function renderClockCard(a, data) {
    const pos = (data.positions || []).find(p => p.id === a.position) || { label: a.position };
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDt = new Date(`${a.date}T${a.startTime}:00`);
    const endDt = new Date(`${a.date}T${a.endTime}:00`);
    const minBeforeStart = (startDt - now) / 60000;
    const minAfterEnd = (now - endDt) / 60000;

    // 状態判定
    const hasClockIn = !!a.clockIn;
    const hasClockOut = !!a.clockOut;
    const canClockIn = !hasClockIn && minBeforeStart < 240 && minBeforeStart > -240;
    const canClockOut = hasClockIn && !hasClockOut && minAfterEnd < 240 && minAfterEnd > -240;

    function fmtTime(iso) {
      try {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      } catch (_) { return iso; }
    }
    function diffMin(scheduled, actual) {
      try {
        const [sh, sm] = scheduled.split(":").map(Number);
        const sched = new Date(`${a.date}T${scheduled}:00`);
        const act = new Date(actual);
        return Math.round((act - sched) / 60000);
      } catch (_) { return 0; }
    }

    let bgClass = "bg-gradient-to-br from-amber-400 to-orange-500";
    let title = "🕐 今日のシフト";
    if (hasClockIn && !hasClockOut) {
      bgClass = "bg-gradient-to-br from-emerald-500 to-teal-600";
      title = "✅ 勤務中";
    } else if (hasClockIn && hasClockOut) {
      bgClass = "bg-gradient-to-br from-slate-500 to-slate-600";
      title = "🏁 本日の勤務終了";
    }

    let inStatus = "", outStatus = "";
    if (hasClockIn) {
      const dInMin = diffMin(a.startTime, a.clockIn);
      const dInLabel = dInMin === 0 ? "定刻" : dInMin > 0 ? `${dInMin}分遅刻` : `${-dInMin}分早出`;
      const dInColor = dInMin <= 5 && dInMin >= -10 ? "" : dInMin > 5 ? "text-red-200" : "text-blue-200";
      inStatus = `<div class="text-xs opacity-90 mt-1">出勤: <b>${fmtTime(a.clockIn)}</b> <span class="${dInColor}">(予定 ${a.startTime} / ${dInLabel})</span></div>`;
    }
    if (hasClockOut) {
      const dOutMin = diffMin(a.endTime, a.clockOut);
      const dOutLabel = dOutMin === 0 ? "定刻" : dOutMin > 0 ? `${dOutMin}分残業` : `${-dOutMin}分早退`;
      const dOutColor = Math.abs(dOutMin) <= 5 ? "" : dOutMin > 5 ? "text-amber-200" : "text-blue-200";
      outStatus = `<div class="text-xs opacity-90 mt-0.5">退勤: <b>${fmtTime(a.clockOut)}</b> <span class="${dOutColor}">(予定 ${a.endTime} / ${dOutLabel})</span></div>`;
    }
    let actualHoursNote = "";
    if (hasClockIn && hasClockOut) {
      try {
        const inDt = new Date(a.clockIn);
        const outDt = new Date(a.clockOut);
        const actualH = (outDt - inDt) / 3600000;
        const schedH = calcHours(a.startTime, a.endTime);
        actualHoursNote = `<div class="text-xs opacity-90 mt-1">実労働: <b>${actualH.toFixed(2)}h</b> / 予定 ${schedH.toFixed(1)}h</div>`;
      } catch (_) {}
    }

    let buttons = "";
    if (canClockIn) {
      buttons = `<button class="clock-in-btn mt-3 w-full bg-white text-emerald-700 rounded-lg py-3 text-base font-bold shadow active:scale-95">
        ⏱ 出勤打刻 (${fmtTime(now.toISOString())})
      </button>`;
    } else if (canClockOut) {
      buttons = `<button class="clock-out-btn mt-3 w-full bg-white text-slate-700 rounded-lg py-3 text-base font-bold shadow active:scale-95">
        ⏱ 退勤打刻 (${fmtTime(now.toISOString())})
      </button>`;
    } else if (!hasClockIn && minBeforeStart >= 240) {
      buttons = `<div class="mt-2 text-xs opacity-90">⏳ 打刻可能になるまで <b>${Math.floor(minBeforeStart/60)}時間${Math.round(minBeforeStart%60)}分</b></div>`;
    } else if (hasClockIn && hasClockOut) {
      buttons = `<div class="mt-2 text-xs opacity-90">本日のシフトは終了です。お疲れ様でした！</div>`;
    }

    return `
      <div class="${bgClass} rounded-xl p-4 mb-3 text-white shadow-lg" data-asgn-id="${escapeAttr(a.id)}">
        <div class="text-xs opacity-90">${title}</div>
        <div class="font-bold text-lg mt-0.5">${escapeHtml(a.startTime)}〜${escapeHtml(a.endTime)} <span class="text-sm opacity-80">${escapeHtml(pos.label)}</span></div>
        ${inStatus}
        ${outStatus}
        ${actualHoursNote}
        ${buttons}
      </div>`;
  }

  async function handleClockClick(kind) {
    if (!confirm(`${kind === "in" ? "出勤" : "退勤"}打刻しますか？\n\n打刻時刻はサーバ側で記録されます。`)) return;
    try {
      const r = kind === "in"
        ? await window.ShiftyAPI.portalClockIn(token)
        : await window.ShiftyAPI.portalClockOut(token);
      const tHHMM = (() => {
        try { const d = new Date(kind === "in" ? r.clockIn : r.clockOut); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
        catch (_) { return ""; }
      })();
      toast(`✓ ${kind === "in" ? "出勤" : "退勤"}打刻完了 ${tHHMM}`, "success", 4000);
      // データ再取得して反映
      data = await window.ShiftyAPI.portalGet(token, activeWeek);
      if (data.weekStatus === "published") renderPublished(); else renderDraft();
    } catch (e) {
      const m = String(e?.message || e);
      if (m.includes("no_clockable_shift")) {
        toast("打刻可能なシフトがありません (シフト時刻の前後 4 時間以内のみ可)", "error", 5000);
      } else {
        toast("打刻失敗: " + m, "error");
      }
    }
  }

  // ===== 代打打診カード (Round 27 TOP 3) =====
  function renderSubOfferCard() {
    const offers = (data && data.substituteOffers) || [];
    if (offers.length === 0) return "";
    const positions = data.positions || [];
    const posLabel = (pid) => (positions.find(p => p.id === pid) || {}).label || pid;
    return offers.map(o => {
      const dow = ["日","月","火","水","木","金","土"][new Date(o.date + "T00:00:00").getDay()];
      return `
        <div class="bg-gradient-to-br from-red-500 to-red-600 rounded-xl p-4 mb-3 text-white shadow-lg sub-offer-card" data-offer-id="${escapeAttr(o.id)}">
          <div class="text-xs opacity-95">🆘 緊急代打打診</div>
          <div class="font-bold text-base mt-1">${escapeHtml(o.originalStaffName || "?")}さんの代打を募集中</div>
          <div class="text-sm mt-1 bg-white/15 rounded p-2">
            📅 ${escapeHtml(o.date)} (${dow})<br>
            ⏰ ${escapeHtml(o.startTime)}〜${escapeHtml(o.endTime)}<br>
            💼 ${escapeHtml(posLabel(o.position))}
          </div>
          <div class="mt-3 flex gap-2">
            <button class="sub-accept-btn flex-1 bg-white text-red-700 rounded py-2 font-bold text-sm" data-offer-id="${escapeAttr(o.id)}">
              ✅ やります
            </button>
            <button class="sub-decline-btn px-4 bg-white/20 text-white rounded py-2 text-xs" data-offer-id="${escapeAttr(o.id)}">
              ✗ 不可
            </button>
          </div>
          <div class="text-[10px] opacity-80 mt-2">先着順で決定。他の方が先に応えた場合は自動取消されます。</div>
        </div>`;
    }).join("");
  }

  async function respondSubOffer(offerId, response) {
    if (response === "accept" && !confirm("この代打を引受けますか？\n\n受付後、店長承認は不要で自動的にあなたのシフトとして確定されます。")) return;
    if (response === "decline" && !confirm("不可で応答しますか？")) return;
    try {
      const r = await window.ShiftyAPI.portalRespondSubOffer(token, offerId, response);
      if (r.accepted) {
        toast(`✓ 代打を引受けました。シフトは自動的にあなたのものになっています`, "success", 6000);
      } else {
        toast(response === "accept" ? "応答しました" : "不可で応答しました", "info");
      }
      data = await window.ShiftyAPI.portalGet(token, activeWeek);
      if (data.weekStatus === "published") renderPublished(); else renderDraft();
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("already_taken")) {
        toast("他のスタッフが先に引受けました", "info", 4000);
        try {
          data = await window.ShiftyAPI.portalGet(token, activeWeek);
          if (data.weekStatus === "published") renderPublished(); else renderDraft();
        } catch (_) {}
      } else {
        toast("応答失敗: " + msg, "error");
      }
    }
  }

  // ===== シフト交換掲示板 (Round 16 TOP 2) =====
  function renderSwapBoardCard() {
    const open = (data && data.swapsOpen) || [];
    const mine = (data && data.swapsMine) || [];
    const myId = data?.staff?.id;
    // 自分以外が出した募集中のもの
    const others = open.filter(sw => sw.fromStaffId !== myId);
    if (others.length === 0 && mine.length === 0) return "";
    const STATUS_LABEL = {
      open: `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]">募集中</span>`,
      claimed: `<span class="bg-blue-100 text-blue-800 rounded px-1.5 py-0.5 text-[10px]">引受・店長承認待ち</span>`,
      approved: `<span class="bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5 text-[10px]">✓ 承認・交換済</span>`,
      rejected: `<span class="bg-red-100 text-red-800 rounded px-1.5 py-0.5 text-[10px]">✗ 却下</span>`,
      cancelled: `<span class="bg-slate-200 text-slate-700 rounded px-1.5 py-0.5 text-[10px]">取消</span>`,
    };
    const positions = data.positions || [];
    const posLabel = (pid) => (positions.find(p => p.id === pid) || {}).label || pid;
    const othersHtml = others.length > 0 ? `
      <div class="space-y-1 mt-2">
        <div class="text-[10px] text-slate-500">📢 他のスタッフが交換に出しているシフト (${others.length})</div>
        ${others.map(sw => `
          <div class="border border-blue-200 bg-blue-50 rounded-md p-2 text-xs">
            <div class="flex items-center justify-between">
              <div>
                <span class="font-semibold">${escapeHtml(sw.fromStaffName || "?")}</span>さん
                <span class="text-slate-500 ml-1">${escapeHtml(sw.date)} ${escapeHtml(sw.startTime)}〜${escapeHtml(sw.endTime)} (${escapeHtml(posLabel(sw.position))})</span>
              </div>
              <button class="swap-take-btn bg-emerald-500 hover:bg-emerald-600 text-white rounded px-2 py-1 text-[10px] font-semibold"
                data-sid="${escapeAttr(sw.id)}">
                ✋ 引受
              </button>
            </div>
            ${sw.note ? `<div class="text-[10px] text-slate-600 mt-1">伝言: ${escapeHtml(sw.note)}</div>` : ""}
          </div>`).join("")}
      </div>` : "";
    const mineHtml = mine.length > 0 ? `
      <div class="space-y-1 mt-2">
        <div class="text-[10px] text-slate-500">🗒 自分の交換履歴 (${mine.length})</div>
        ${mine.slice(0, 5).map(sw => `
          <div class="border border-slate-200 bg-slate-50 rounded p-1.5 text-xs">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-slate-600">${escapeHtml(sw.date)} ${escapeHtml(sw.startTime)}〜${escapeHtml(sw.endTime)}</span>
                ${sw.fromStaffId === myId ? "" : `<span class="text-slate-500 ml-1">(${escapeHtml(sw.fromStaffName)}さんから引受)</span>`}
              </div>
              ${STATUS_LABEL[sw.status] || ""}
            </div>
          </div>`).join("")}
      </div>` : "";
    return `
      <div class="bg-white border border-slate-200 rounded-xl p-3 mb-3">
        <details ${others.length > 0 ? "open" : ""}>
          <summary class="text-sm font-semibold cursor-pointer select-none flex items-center gap-2">
            🔄 シフト交換掲示板
            ${others.length > 0 ? `<span class="bg-blue-100 text-blue-800 rounded px-1.5 py-0.5 text-[10px]">${others.length} 件募集中</span>` : ""}
          </summary>
          <div class="text-xs text-slate-500 mt-2">他のスタッフが交換に出したシフトを引受できます。引受後は店長承認で正式交換になります。</div>
          ${othersHtml}
          ${mineHtml}
        </details>
      </div>`;
  }

  async function takeSwapClick(sid) {
    const sw = (data.swapsOpen || []).find(x => x.id === sid);
    if (!sw) { toast("対象が見つかりません", "error"); return; }
    if (!confirm(`${sw.fromStaffName} さんの ${sw.date} ${sw.startTime}〜${sw.endTime} を引受けますか？\n\n店長承認後、正式に交換されます。`)) return;
    try {
      await window.ShiftyAPI.portalTakeSwap(token, sid);
      toast("✓ 引受しました。店長承認をお待ちください", "success", 4000);
      data = await window.ShiftyAPI.portalGet(token, activeWeek);
      if (data.weekStatus === "published") renderPublished(); else renderDraft();
    } catch (e) {
      toast("引受失敗: " + (e?.message || ""), "error");
    }
  }

  async function createSwapClick(assignmentId) {
    const a = (data.assignments || []).find(x => x.id === assignmentId);
    if (!a) { toast("シフトが見つかりません", "error"); return; }
    const note = prompt(`このシフトを交換に出します:\n${a.date} ${a.startTime}〜${a.endTime}\n\n他のスタッフへの伝言があれば入力してください (任意・200 字以内):`, "");
    if (note === null) return; // キャンセル
    try {
      await window.ShiftyAPI.portalCreateSwap(token, {
        assignmentId,
        weekStart: data.weekStart,
        note: (note || "").slice(0, 200),
      });
      toast("✓ 交換掲示板に出しました。他のスタッフに通知メールが送信されます", "success", 5000);
      data = await window.ShiftyAPI.portalGet(token, activeWeek);
      if (data.weekStatus === "published") renderPublished(); else renderDraft();
    } catch (e) {
      toast("送信失敗: " + (e?.message || ""), "error");
    }
  }

  // ===== 長期休暇申請 (Round 16 TOP 1) =====
  function renderVacationCard() {
    const my = (data && data.vacationRequests) || [];
    const pending = my.filter(v => v.status === "pending");
    const approved = my.filter(v => v.status === "approved");
    const rejected = my.filter(v => v.status === "rejected");
    const STATUS_LABEL = {
      pending: `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]">⏳ 申請中</span>`,
      approved: `<span class="bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5 text-[10px]">✓ 承認</span>`,
      rejected: `<span class="bg-red-100 text-red-800 rounded px-1.5 py-0.5 text-[10px]">✗ 却下</span>`,
    };
    const items = my.slice(0, 5).map(v => `
      <div class="flex items-center justify-between bg-slate-50 rounded p-1.5 text-xs">
        <div>
          <span class="font-mono">${escapeHtml(v.startDate.slice(5))}〜${escapeHtml(v.endDate.slice(5))}</span>
          ${v.reason ? `<span class="ml-2 text-slate-500">「${escapeHtml(v.reason)}」</span>` : ""}
        </div>
        ${STATUS_LABEL[v.status] || ""}
      </div>`).join("");
    return `
      <div class="bg-white border border-slate-200 rounded-xl p-3 mb-3">
        <details>
          <summary class="text-sm font-semibold cursor-pointer select-none flex items-center gap-2">
            🏖 長期休暇申請
            ${pending.length > 0 ? `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]">承認待ち ${pending.length}</span>` : ""}
          </summary>
          <div class="mt-2 space-y-2">
            <div class="text-xs text-slate-500">帰省・旅行・体調管理など、まとまった期間の休みを申請できます。承認されると該当期間が自動的に「不可」希望になります。</div>
            <button id="vac-new-btn" class="w-full bg-blue-500 hover:bg-blue-600 text-white rounded-md px-3 py-2 text-sm font-semibold">
              📅 新規休暇申請
            </button>
            ${my.length > 0 ? `<div class="space-y-1 pt-1"><div class="text-[10px] text-slate-400">最近の申請 (${approved.length} 承認 / ${pending.length} 申請中 / ${rejected.length} 却下)</div>${items}</div>` : ""}
          </div>
        </details>
      </div>`;
  }

  function openVacationDialog() {
    const today = new Date().toISOString().slice(0, 10);
    // デフォルト: 1 週間後 〜 1 週間後 + 3日
    const baseDt = new Date(); baseDt.setDate(baseDt.getDate() + 7);
    const defStart = baseDt.toISOString().slice(0, 10);
    baseDt.setDate(baseDt.getDate() + 3);
    const defEnd = baseDt.toISOString().slice(0, 10);
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3">
        <h3 class="font-bold text-lg">🏖 長期休暇申請</h3>
        <p class="text-xs text-slate-600">承認されると、申請期間中の全シフト希望が自動的に「不可 (avoid)」に設定されます。AI 自動生成時にも反映されます。</p>
        <label class="block text-sm">
          <span class="text-slate-700">開始日</span>
          <input id="vac-start" type="date" class="mt-1 w-full border rounded-md px-3 py-2" min="${today}" value="${defStart}">
        </label>
        <label class="block text-sm">
          <span class="text-slate-700">終了日</span>
          <input id="vac-end" type="date" class="mt-1 w-full border rounded-md px-3 py-2" min="${today}" value="${defEnd}">
        </label>
        <label class="block text-sm">
          <span class="text-slate-700">理由 (任意)</span>
          <textarea id="vac-reason" maxlength="300" rows="2" class="mt-1 w-full border rounded-md px-3 py-2"
            placeholder="例: 帰省・体調回復・家族の用事 (300 字まで)"></textarea>
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <button id="vac-cancel" class="px-3 py-1.5 text-sm bg-slate-200 rounded-md">キャンセル</button>
          <button id="vac-submit" class="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md font-semibold">申請を送信</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#vac-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#vac-submit").onclick = async () => {
      const startDate = overlay.querySelector("#vac-start").value;
      const endDate = overlay.querySelector("#vac-end").value;
      const reason = overlay.querySelector("#vac-reason").value.trim().slice(0, 300);
      if (!startDate || !endDate) { toast("日付を入力してください", "error"); return; }
      if (endDate < startDate) { toast("終了日は開始日以降にしてください", "error"); return; }
      const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
      if (days > 90) { toast("申請期間は最大 90 日までです", "error"); return; }
      if (!confirm(`${startDate} 〜 ${endDate} (${days} 日間) の休暇を申請します。\n\n店長に通知メールが送信されます。`)) return;
      const submitBtn = overlay.querySelector("#vac-submit");
      submitBtn.disabled = true; submitBtn.textContent = "送信中…";
      try {
        await window.ShiftyAPI.portalSubmitVacation(token, { startDate, endDate, reason });
        toast("✓ 申請を送信しました。承認をお待ちください", "success", 4000);
        overlay.remove();
        // データ再取得して表示更新
        try {
          data = await window.ShiftyAPI.portalGet(token, activeWeek);
          if (data.weekStatus === "published") renderPublished(); else renderDraft();
        } catch (_) {}
      } catch (e) {
        submitBtn.disabled = false; submitBtn.textContent = "申請を送信";
        toast("送信失敗: " + (e?.message || ""), "error");
      }
    };
  }

  // ===== 月次給与明細 (Round 24 TOP 2) =====
  function openMonthlyStatement() {
    // 当月のシフト + 履歴シフトを集める
    const m = data.monthlyStats || {};
    const monthKey = m.monthKey || (data.weekStart || "").slice(0, 7);
    if (!monthKey) { toast("対象月が判定できません", "error"); return; }

    // history (確定済) + assignments (今週) を結合 — 重複は除去
    const allAss = [];
    const seen = new Set();
    for (const h of (data.history || [])) {
      const key = `${h.date}|${h.startTime}|${h.endTime}`;
      if (seen.has(key)) continue;
      if (!(h.date || "").startsWith(monthKey)) continue;
      allAss.push(h);
      seen.add(key);
    }
    for (const a of (data.assignments || [])) {
      const key = `${a.date}|${a.startTime}|${a.endTime}`;
      if (seen.has(key)) continue;
      if (!(a.date || "").startsWith(monthKey)) continue;
      allAss.push({
        date: a.date,
        startTime: a.startTime,
        endTime: a.endTime,
        position: a.position,
        hours: calcHours(a.startTime, a.endTime),
        pay: a.cost || 0,
        clockIn: a.clockIn,
        clockOut: a.clockOut,
        note: a.note,
      });
      seen.add(key);
    }
    allAss.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || "").localeCompare(b.startTime || ""));

    if (allAss.length === 0) {
      toast(`${monthKey} のシフトデータがありません`, "info"); return;
    }

    const positions = data.positions || [];
    const totalH = allAss.reduce((s, a) => s + (a.hours || 0), 0);
    const totalP = allAss.reduce((s, a) => s + (a.pay || 0), 0);

    // 実労働時間とのギャップ
    let actualH = 0, actualCount = 0;
    for (const a of allAss) {
      if (a.clockIn && a.clockOut) {
        try {
          const inDt = new Date(a.clockIn), outDt = new Date(a.clockOut);
          actualH += (outDt - inDt) / 3600000;
          actualCount++;
        } catch (_) {}
      }
    }

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 bg-black/40 z-50 overflow-y-auto p-3";
    overlay.innerHTML = `
      <div class="bg-white rounded-xl max-w-md mx-auto p-5 my-4 shadow-2xl">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-lg">🧾 ${escapeHtml(monthKey)} の給与明細</h3>
          <button id="stmt-close" class="text-2xl text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-xs text-slate-600 mb-3">
          ${escapeHtml(data.restaurantName || "")} / ${escapeHtml(data.staff?.name || "")} さん
        </div>
        <div class="grid grid-cols-3 gap-2 mb-3">
          <div class="bg-slate-50 rounded p-2 text-center">
            <div class="text-[10px] text-slate-500">出勤日数</div>
            <div class="text-lg font-bold">${new Set(allAss.map(a => a.date)).size}</div>
          </div>
          <div class="bg-slate-50 rounded p-2 text-center">
            <div class="text-[10px] text-slate-500">合計時間</div>
            <div class="text-lg font-bold text-emerald-700">${totalH.toFixed(1)}h</div>
          </div>
          <div class="bg-slate-50 rounded p-2 text-center">
            <div class="text-[10px] text-slate-500">予定給与</div>
            <div class="text-lg font-bold text-brand-700">${fmtYen(totalP)}</div>
          </div>
        </div>
        ${actualCount > 0 ? `
        <div class="bg-emerald-50 rounded p-2 mb-3 text-xs">
          ⏱ 実労働時間: <b>${actualH.toFixed(1)}h</b> (打刻 ${actualCount}/${allAss.length} 回)
          ${Math.abs(actualH - totalH) > 0.1 ? `<span class="${actualH > totalH ? 'text-amber-700' : 'text-blue-700'} ml-1">予定との差 ${(actualH - totalH > 0 ? "+" : "")}${(actualH - totalH).toFixed(1)}h</span>` : ""}
        </div>` : '<div class="bg-amber-50 rounded p-2 mb-3 text-xs text-amber-800">💡 打刻データなし — 予定時間で計算</div>'}
        <details class="mb-3" open>
          <summary class="text-sm font-semibold cursor-pointer">📋 日別明細 (${allAss.length} 件)</summary>
          <div class="mt-2 space-y-1 text-xs max-h-60 overflow-y-auto">
            ${allAss.map(a => {
              const pos = positions.find(p => p.id === a.position) || { label: a.position };
              const dow = ["日","月","火","水","木","金","土"][new Date(a.date).getDay()];
              const inT = a.clockIn ? new Date(a.clockIn).toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit"}) : "";
              const outT = a.clockOut ? new Date(a.clockOut).toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit"}) : "";
              return `<div class="bg-slate-50 rounded p-2">
                <div class="flex justify-between items-center">
                  <span class="font-mono">${escapeHtml(a.date.slice(5))} (${dow})</span>
                  <span class="font-semibold">${fmtYen(Math.round(a.pay))}</span>
                </div>
                <div class="text-slate-600 text-[10px] mt-0.5">
                  予定 ${escapeHtml(a.startTime || "")}〜${escapeHtml(a.endTime || "")} (${escapeHtml(pos.label)})
                  ${(inT || outT) ? `<br>実打刻 ${inT || "—"}〜${outT || "—"}` : ""}
                  ${a.note ? `<br>📝 ${escapeHtml(a.note)}` : ""}
                </div>
              </div>`;
            }).join("")}
          </div>
        </details>
        <div class="flex gap-2 pt-2 border-t">
          <button id="stmt-print" class="flex-1 bg-blue-600 text-white rounded py-2 text-sm font-semibold">🖨 印刷 / PDF 保存</button>
          <button id="stmt-close2" class="px-4 bg-slate-200 rounded py-2 text-sm">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#stmt-close").onclick = () => overlay.remove();
    overlay.querySelector("#stmt-close2").onclick = () => overlay.remove();
    overlay.querySelector("#stmt-print").onclick = () => {
      // 印刷用ウィンドウを別途開く
      const w = window.open("", "_blank");
      if (!w) { toast("ポップアップがブロックされています", "error"); return; }
      const printHtml = `
        <!doctype html><html lang="ja"><head><meta charset="utf-8">
        <title>${monthKey} 給与明細 - ${data.staff?.name || ""}</title>
        <style>
          body { font-family: 'Hiragino Sans','Yu Gothic',sans-serif; padding: 15mm; font-size: 11pt; color: #1e293b; }
          h1 { font-size: 18pt; margin-bottom: 4mm; }
          h2 { font-size: 11pt; color: #555; margin: 0 0 8mm; font-weight: normal; }
          table { width: 100%; border-collapse: collapse; font-size: 11pt; }
          th, td { border: 1px solid #888; padding: 2mm 3mm; text-align: left; }
          th { background: #e2e8f0; }
          .summary { margin: 4mm 0; padding: 3mm; background: #f1f5f9; border-radius: 2mm; }
          .right { text-align: right; }
          @media print { @page { size: A4; margin: 12mm; } }
        </style></head><body>
        <h1>${escapeHtml(monthKey)} 給与明細</h1>
        <h2>${escapeHtml(data.restaurantName || "")} / ${escapeHtml(data.staff?.name || "")} さん</h2>
        <div class="summary">
          出勤日数: <b>${new Set(allAss.map(a => a.date)).size} 日</b> /
          合計時間: <b>${totalH.toFixed(1)}h</b> /
          予定給与: <b>${fmtYen(totalP)}</b>
          ${actualCount > 0 ? `<br>実労働: <b>${actualH.toFixed(1)}h</b> (打刻 ${actualCount}/${allAss.length} 回)` : ""}
        </div>
        <table>
          <thead><tr><th>日付</th><th>予定</th><th>打刻</th><th class="right">時間</th><th class="right">給与</th></tr></thead>
          <tbody>${allAss.map(a => {
            const pos = positions.find(p => p.id === a.position) || { label: a.position };
            const dow = ["日","月","火","水","木","金","土"][new Date(a.date).getDay()];
            const inT = a.clockIn ? new Date(a.clockIn).toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit"}) : "";
            const outT = a.clockOut ? new Date(a.clockOut).toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit"}) : "";
            return `<tr>
              <td>${a.date.slice(5)} (${dow})<br><span style="font-size:9pt;color:#666">${escapeHtml(pos.label)}</span></td>
              <td>${escapeHtml(a.startTime || "")}〜${escapeHtml(a.endTime || "")}</td>
              <td>${inT || "—"}〜${outT || "—"}</td>
              <td class="right">${(a.hours || 0).toFixed(1)}h</td>
              <td class="right">${fmtYen(Math.round(a.pay))}</td>
            </tr>`;
          }).join("")}</tbody>
          <tfoot><tr style="font-weight:bold">
            <td colspan="3">合計</td>
            <td class="right">${totalH.toFixed(1)}h</td>
            <td class="right">${fmtYen(Math.round(totalP))}</td>
          </tr></tfoot>
        </table>
        <div style="margin-top:8mm;font-size:9pt;color:#888">
          ※ 上記は予定額です。実打刻ベースの確定額は店長より別途ご連絡があります。<br>
          発行: ${new Date().toLocaleString("ja-JP")}
        </div>
        <script>setTimeout(() => window.print(), 200);<\/script>
        </body></html>`;
      w.document.write(printHtml);
    };
  }

  // 初回ガイドツアー (Round 10)
  function showOnboardingTour() {
    let step = 0;
    const STEPS = [
      {
        title: "👋 はじめまして！",
        body: `${escapeHtml(data.staff?.name || "あなた")}さんのシフト希望を集めるページです。<br>
          毎週、お店から URL が届くので、開いて希望を入力 → 送信、の繰り返しになります。<br><br>
          <strong>所要時間: 約 2 分 / 週</strong>`,
      },
      {
        title: "📝 希望の入力方法",
        body: `各日の各時間帯に <strong>4 つのボタン</strong> があります:<br>
          <ul class="list-disc pl-5 mt-2 space-y-1 text-xs">
            <li>🔥 <strong>必須</strong>: 絶対入りたい (家計/予定優先)</li>
            <li>✅ <strong>希望</strong>: 入れたら入りたい</li>
            <li>🚫 <strong>不可</strong>: 入れません (用事あり)</li>
            <li>— <strong>未定</strong>: 任せる (どちらでも)</li>
          </ul>
          <div class="mt-2 text-xs text-amber-700">時間範囲を絞りたい場合は ⚙️ ボタン、毎週同じパターンの方は ⚡ テンプレートが便利です。</div>`,
      },
      {
        title: "✅ 送信して完了！",
        body: `画面下部の「送信」ボタンを押すと完了です。<br><br>
          ✓ 期限内なら何度でも編集して再送信できます<br>
          ✓ 入力内容は自動下書き保存されます (途中で閉じても OK)<br>
          ✓ 提出期限は画面上部の <strong>⏰ カウントダウン</strong> をご確認ください<br><br>
          <strong>不明点は店長まで気軽にご連絡を！</strong>`,
      },
    ];
    function render() {
      const overlay = document.getElementById("portal-tour-overlay");
      if (overlay) overlay.remove();
      const o = document.createElement("div");
      o.id = "portal-tour-overlay";
      o.className = "fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4";
      const s = STEPS[step];
      o.innerHTML = `
        <div class="bg-white rounded-2xl max-w-md w-full p-6 space-y-3 shadow-2xl">
          <div class="flex items-center justify-between">
            <div class="text-xs text-slate-500">${step + 1} / ${STEPS.length}</div>
            <button id="tour-skip" class="text-xs text-slate-400 hover:text-slate-700">スキップ</button>
          </div>
          <h2 class="font-bold text-xl">${s.title}</h2>
          <div class="text-sm text-slate-700">${s.body}</div>
          <div class="h-1 bg-slate-200 rounded-full overflow-hidden">
            <div class="h-full bg-brand-600 transition-all" style="width:${((step + 1) / STEPS.length) * 100}%"></div>
          </div>
          <div class="flex gap-2 justify-between pt-2">
            ${step > 0 ? '<button id="tour-prev" class="px-3 py-2 text-sm text-slate-500">← 戻る</button>' : '<div></div>'}
            <button id="tour-next" class="px-5 py-2 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold">
              ${step < STEPS.length - 1 ? "次へ →" : "🎉 はじめる"}
            </button>
          </div>
        </div>`;
      document.body.appendChild(o);
      o.querySelector("#tour-skip").onclick = () => o.remove();
      const prev = o.querySelector("#tour-prev");
      if (prev) prev.onclick = () => { step--; render(); };
      o.querySelector("#tour-next").onclick = () => {
        if (step < STEPS.length - 1) { step++; render(); }
        else { o.remove(); }
      };
    }
    render();
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
        `DESCRIPTION:${escapeIcs(`${staffName} さんのシフト\\n${restaurant}\\n\\n勤務時間: ${a.startTime}〜${a.endTime}\\nポジション: ${pos.label}${a.note ? `\\n\\n📝 店長メモ: ${a.note}` : ""}`)}`,
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
