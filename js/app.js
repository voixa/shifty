// app.js v3 — Multi-week + Publish + Auth
(function () {
const D = window.ShiftyData;
const { DAY_LABELS, uid, fmtDate, todayMonday, addDays, dayOfWeek, calcHours,
        buildSlots, ensureWeek, listWeeks,
        loadState, saveState, resetState } = D;
const { generateShift, recommendSubstitute, calcMetrics } = window.ShiftyAlgo;

let state = null;
let currentTab = "dashboard";

// ===== Utilities =====
function $(s, r = document) { return r.querySelector(s); }
function $$(s, r = document) { return [...r.querySelectorAll(s)]; }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style") Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (c instanceof Node) e.appendChild(c);
    else e.appendChild(document.createTextNode(String(c)));
  }
  return e;
}
function fmtYen(n) { return "¥" + Math.round(n).toLocaleString(); }
function fmtPct(r) { return Math.round(r * 100) + "%"; }
// Round 33 (Perf-3): persist debounce — 連続編集の API 往復を集約
let _persistTimer = null;
let _persistPending = false;
function persist(opts) {
  _persistPending = true;
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (opts && opts.immediate) { _flushPersist(); return; }
  _persistTimer = setTimeout(_flushPersist, 400);
}
function _flushPersist() {
  if (!_persistPending) return;
  _persistPending = false;
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  saveState(state).catch(() => {});
}
// 画面離脱時 / タブ非表示時は flush して取りこぼし防止
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => _flushPersist());
  window.addEventListener("visibilitychange", () => { if (document.hidden) _flushPersist(); });
}
function toast(msg, type = "", duration = 3500) {
  const t = el("div", { class: `toast-item ${type}`, role: "alert", "aria-live": "polite" }, msg);
  $("#toast").appendChild(t);
  setTimeout(() => t.remove(), duration);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

// ===== Week helpers =====
function curWeek() { return ensureWeek(state, state.meta.currentWeekStart); }
function curSlots()       { return curWeek().slots; }
function curPrefs()       { return curWeek().preferences; }
function curAssignments() { return curWeek().assignments; }
function curStatus()      { return curWeek().status; }

function goToWeek(weekStart) {
  state.meta.currentWeekStart = weekStart;
  ensureWeek(state, weekStart);
  persist();
  renderHeader();
  render();
}

// ===== Position/session helpers =====
function posCfg(id) {
  return (state?.meta?.positions || []).find(p => p.id === id) || { id, label: id, color: "#64748b" };
}
function posBadge(p) {
  const cfg = posCfg(p);
  return `<span class="pos-badge" style="background:${cfg.color}">${escapeHtml(cfg.label)}</span>`;
}

// ===== ヘルプツールチップ =====
const HELP_TIPS = {
  "staffing-matrix": {
    title: "必要人数マトリクス",
    body: "曜日 × 時間帯 × ポジションで「何人必要か」を定義します。AIはこの表を満たすようにシフトを組みます。",
    href: "/help#settings",
  },
  "labor-rules": {
    title: "労務ルール",
    body: "週・日・連勤・休日の上限を設定。AIはこれをハード制約として絶対守ります（労基順守）。",
    href: "/help#settings",
  },
  "algo-weights": {
    title: "アルゴリズム重み",
    body: "5要素（希望充足・ポジション・公平性・コスト・スキル）の優先度を 0〜100 で調整。合計は自動正規化。",
    href: "/docs/algorithm.md",
  },
  "preference": {
    title: "希望（want）/必須（must）/不可（avoid）",
    body: "want=入れたら入りたい、must=絶対入れて、avoid=避けて。avoidは可能な限り守られます。",
    href: "/help#preferences",
  },
  "publish": {
    title: "確定",
    body: "下書き → 確定 で、スタッフがポータルから自分のシフトを閲覧できるようになります。LINE通知文も自動生成。",
    href: "/help#publish",
  },
  "template": {
    title: "テンプレート",
    body: "現在のシフト配置を保存して、別の週に再利用できます。「夏休みシフト」「通常週」等。",
    href: "/help#schedule",
  },
  "audit": {
    title: "AI 検証レポート",
    body: "ハード制約7種・スコア要素5種・全試行履歴を表示。第三者監査可能な意思決定エンジン。",
    href: "/docs/algorithm.md",
  },
  "snapshot": {
    title: "自動スナップショット",
    body: "毎日 03:00 JST にサーバ側で自動バックアップ。30日分保持。任意の日に巻き戻せます。",
    href: "/help#trouble",
  },
};

function helpIcon(termId) {
  const tip = HELP_TIPS[termId];
  if (!tip) return "";
  return `<button class="help-icon ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 hover:bg-brand-100 text-slate-500 hover:text-brand-600 text-[10px] font-bold align-middle"
    data-help="${termId}" title="${escapeAttr(tip.title)}" type="button" tabindex="0">?</button>`;
}

// ヘルプアイコンクリックでツールチップ表示
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".help-icon");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const termId = btn.dataset.help;
  const tip = HELP_TIPS[termId];
  if (!tip) return;
  // 既存ポップアップを閉じる
  document.querySelectorAll(".help-popup").forEach(p => p.remove());
  const rect = btn.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "help-popup fixed z-[70] bg-slate-900 text-white text-xs rounded-lg p-3 shadow-2xl max-w-xs";
  pop.style.left = Math.min(window.innerWidth - 280, rect.left) + "px";
  pop.style.top = (rect.bottom + 6) + "px";
  pop.innerHTML = `
    <div class="font-semibold mb-1">${escapeHtml(tip.title)}</div>
    <div class="text-slate-300 leading-relaxed">${escapeHtml(tip.body)}</div>
    <a href="${tip.href}" target="_blank" class="text-brand-300 underline text-[10px] mt-2 block">もっと詳しく →</a>
  `;
  document.body.appendChild(pop);
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener("click", close); }
    });
  }, 100);
});

function modal(content) {
  const m = $("#modal");
  $("#modalBody").innerHTML = "";
  $("#modalBody").appendChild(content);
  m.classList.remove("hidden");
  m.onclick = (e) => { if (e.target === m) closeModal(); };
}
function closeModal() { $("#modal").classList.add("hidden"); }

function regenerateCurSlots() {
  curWeek().slots = buildSlots(state.meta, state.meta.currentWeekStart);
}

// ===== 長期休暇申請 (Round 16 TOP 1) =====
function renderVacationRequestsCard() {
  const reqs = (state.meta && state.meta.vacationRequests) || [];
  if (reqs.length === 0) return null;
  const pending = reqs.filter(r => r.status === "pending");
  const recent = reqs.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 10);
  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
    el("div", { class: "font-semibold text-sm" }, [
      el("span", {}, "🏖 長期休暇申請"),
      pending.length > 0 ? el("span", { class: "ml-2 bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]" },
        `承認待ち ${pending.length}`) : null,
    ]),
    el("button", {
      class: "text-[10px] text-slate-500 hover:text-slate-700 underline decoration-dotted",
      onclick: () => openVacationHistoryDialog(reqs),
    }, "全件表示"),
  ]));
  const list = el("div", { class: "space-y-1.5" });
  for (const r of recent) {
    const staff = state.staff.find(s => s.id === r.staffId);
    const days = Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1;
    const row = el("div", { class: "border border-slate-100 rounded-md p-2 text-xs flex items-center justify-between gap-2" });
    const STATUS_BADGE = {
      pending: `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">⏳ 申請中</span>`,
      approved: `<span class="bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5">✓ 承認</span>`,
      rejected: `<span class="bg-red-100 text-red-800 rounded px-1.5 py-0.5">✗ 却下</span>`,
    };
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="font-medium">${escapeHtml(staff?.name || r.staffName || "?")}
          <span class="text-slate-500 ml-1">${escapeHtml(r.startDate)}〜${escapeHtml(r.endDate)} (${days}日)</span>
        </div>
        ${r.reason ? `<div class="text-slate-500 text-[10px] mt-0.5 truncate">理由: ${escapeHtml(r.reason)}</div>` : ""}
        ${r.decidedAt ? `<div class="text-slate-400 text-[10px] mt-0.5">${new Date(r.decidedAt).toLocaleDateString("ja-JP")} 決定${r.decidedNote ? "・" + escapeHtml(r.decidedNote) : ""}</div>` : ""}
      </div>
      <div class="flex items-center gap-1">
        ${STATUS_BADGE[r.status] || ""}
      </div>
    `;
    if (r.status === "pending") {
      const btnGroup = el("div", { class: "flex gap-1" });
      btnGroup.appendChild(el("button", {
        class: "text-[10px] bg-emerald-500 hover:bg-emerald-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => decideVacationRequest(r.id, "approved"),
      }, "✓ 承認"));
      btnGroup.appendChild(el("button", {
        class: "text-[10px] bg-red-500 hover:bg-red-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => decideVacationRequest(r.id, "rejected"),
      }, "✗ 却下"));
      row.appendChild(btnGroup);
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

async function decideVacationRequest(reqId, decision) {
  const reqs = (state.meta && state.meta.vacationRequests) || [];
  const req = reqs.find(r => r.id === reqId);
  if (!req) { toast("申請が見つかりません", "error"); return; }
  const staff = state.staff.find(s => s.id === req.staffId);

  let note = "";
  if (decision === "rejected") {
    note = prompt(`却下理由 (任意・スタッフに通知されません):`, "") || "";
  }
  const verb = decision === "approved" ? "承認" : "却下";
  if (!confirm(
    `${staff?.name || req.staffName} さんの ${req.startDate}〜${req.endDate} の休暇申請を「${verb}」しますか？\n\n` +
    (decision === "approved"
      ? "承認すると、該当期間の全シフトに「不可」希望が自動追加されます (該当週がまだ存在しない場合は何もしません — 後で週を作成すれば反映されます)。"
      : "却下した場合、希望は変更されません。スタッフのポータルでステータスが「却下」と表示されます。")
  )) return;

  req.status = decision;
  req.decidedAt = new Date().toISOString();
  req.decidedNote = note;

  // 承認時: 該当期間の avoid 希望を該当週に追加
  if (decision === "approved") {
    addAvoidPrefsForRange(req.staffId, req.startDate, req.endDate);
  }
  logChange("vacation_" + decision, `${staff?.name || req.staffName} の休暇申請を${verb} (${req.startDate}〜${req.endDate})`);
  await persist();
  render();
  toast(`✓ 休暇申請を${verb}しました`, "success");
}

function addAvoidPrefsForRange(staffId, startDate, endDate) {
  const sd = new Date(startDate); const ed = new Date(endDate);
  const sessions = state.meta.sessions || [];
  let added = 0;
  for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    // 該当する週を見つける (date を含む週開始)
    const dow = d.getDay(); // 0=Sun
    // 月曜起点で週開始を計算
    const offsetToMonday = (dow + 6) % 7;
    const wkStart = new Date(d); wkStart.setDate(d.getDate() - offsetToMonday);
    const wkKey = wkStart.toISOString().slice(0, 10);
    const wk = (state.weeks || {})[wkKey];
    if (!wk) continue; // 週が未作成 — スキップ
    if (wk.status === "published") continue; // 確定済はスキップ
    wk.preferences = wk.preferences || [];
    // 既存の自分の希望を該当日付分は削除
    wk.preferences = wk.preferences.filter(p => !(p.staffId === staffId && p.date === dateStr));
    for (const sess of sessions) {
      wk.preferences.push({
        id: "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        staffId,
        date: dateStr,
        startTime: sess.startTime,
        endTime: sess.endTime,
        priority: "avoid",
      });
      added++;
    }
  }
  if (added > 0) toast(`📅 ${added} 件の avoid 希望を週データに追加しました`, "info", 4000);
}

function openVacationHistoryDialog(reqs) {
  const sorted = reqs.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🏖 長期休暇申請 全履歴"));
  body.appendChild(el("div", { class: "text-xs text-slate-500" }, `合計 ${sorted.length} 件`));
  const list = el("div", { class: "space-y-1 max-h-96 overflow-y-auto text-xs" });
  for (const r of sorted) {
    const staff = state.staff.find(s => s.id === r.staffId);
    const STATUS_LABEL = { pending: "⏳ 申請中", approved: "✓ 承認", rejected: "✗ 却下" };
    const days = Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1;
    const row = el("div", { class: "border border-slate-100 rounded p-2" });
    row.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-medium">${escapeHtml(staff?.name || r.staffName || "?")}</div>
        <div class="text-slate-600">${STATUS_LABEL[r.status] || ""}</div>
      </div>
      <div class="text-slate-500">${escapeHtml(r.startDate)} 〜 ${escapeHtml(r.endDate)} (${days} 日)</div>
      ${r.reason ? `<div class="text-slate-500">理由: ${escapeHtml(r.reason)}</div>` : ""}
      <div class="text-slate-400 text-[10px]">申請: ${r.createdAt ? new Date(r.createdAt).toLocaleString("ja-JP") : "—"}</div>
    `;
    list.appendChild(row);
  }
  body.appendChild(list);
  body.appendChild(el("button", {
    class: "w-full text-sm bg-slate-200 rounded-md py-1.5",
    onclick: closeModal,
  }, "閉じる"));
  modal(body);
}

// ===== スタッフ・インサイト (Round 16 TOP 3) =====
function renderStaffInsights() {
  // 過去 8 週分の確定済シフトと希望データから、各スタッフの指標を集計
  const allWeeks = state.weeks || {};
  const sortedWeekKeys = Object.keys(allWeeks).sort();
  const last8 = sortedWeekKeys.slice(-8);
  if (last8.length === 0) return null;

  // 各スタッフのメトリクス
  const insights = {};
  for (const s of state.staff) {
    insights[s.id] = {
      staff: s,
      totalHours: 0,
      shiftCount: 0,
      prefSubmitWeeks: 0, // 希望提出した週数
      mustHonored: 0, mustTotal: 0,    // 必須希望の充足率
      avoidViolated: 0, avoidTotal: 0, // 不可なのに割当てられた回数
      vacReqCount: 0, swapReqCount: 0,
      weeksWorked: new Set(),
    };
  }
  let weeksConsidered = 0;
  for (const wkey of last8) {
    const wk = allWeeks[wkey];
    if (wk.status !== "published") continue;
    weeksConsidered++;
    const submitted = new Set();
    for (const p of (wk.preferences || [])) submitted.add(p.staffId);
    for (const sid of submitted) if (insights[sid]) insights[sid].prefSubmitWeeks++;

    for (const a of (wk.assignments || [])) {
      const ins = insights[a.staffId];
      if (!ins) continue;
      const h = calcHours(a.startTime, a.endTime);
      ins.totalHours += h;
      ins.shiftCount++;
      ins.weeksWorked.add(wkey);
    }
    // 必須・不可の達成度
    for (const p of (wk.preferences || [])) {
      const ins = insights[p.staffId];
      if (!ins) continue;
      const matched = (wk.assignments || []).some(a =>
        a.staffId === p.staffId && a.date === p.date
        && _timeOverlap(a.startTime, a.endTime, p.startTime, p.endTime)
      );
      if (p.priority === "must") {
        ins.mustTotal++;
        if (matched) ins.mustHonored++;
      } else if (p.priority === "avoid") {
        ins.avoidTotal++;
        if (matched) ins.avoidViolated++;
      }
    }
  }

  // 申請履歴
  for (const vr of (state.meta.vacationRequests || [])) {
    if (insights[vr.staffId]) insights[vr.staffId].vacReqCount++;
  }
  for (const sw of (state.meta.swapRequests || [])) {
    if (insights[sw.fromStaffId]) insights[sw.fromStaffId].swapReqCount++;
  }

  // ソート (働いた時間が多い順)
  const sorted = Object.values(insights).sort((a, b) => b.totalHours - a.totalHours);
  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
    el("div", { class: "font-semibold text-sm" }, `📊 スタッフ・インサイト (直近 ${weeksConsidered} 週)`),
    el("div", { class: "text-[10px] text-slate-500" }, "希望提出率 / 必須充足率 / 燃え尽きリスク"),
  ]));
  if (weeksConsidered === 0) {
    card.appendChild(el("div", { class: "text-xs text-slate-500 text-center py-2" }, "確定済の週がまだありません"));
    return card;
  }
  const list = el("div", { class: "space-y-2" });
  for (const ins of sorted) {
    if (ins.totalHours === 0 && ins.prefSubmitWeeks === 0) continue;
    const submitRate = weeksConsidered > 0 ? ins.prefSubmitWeeks / weeksConsidered : 0;
    const mustRate = ins.mustTotal > 0 ? ins.mustHonored / ins.mustTotal : null;
    const avoidViolationRate = ins.avoidTotal > 0 ? ins.avoidViolated / ins.avoidTotal : 0;
    const avgWeeklyHours = weeksConsidered > 0 ? ins.totalHours / weeksConsidered : 0;
    // 燃え尽きリスク: 平均週時間が高い + avoid 違反率が高い
    let burnoutScore = 0;
    if (avgWeeklyHours > 35) burnoutScore += 2;
    else if (avgWeeklyHours > 28) burnoutScore += 1;
    if (avoidViolationRate > 0.3) burnoutScore += 2;
    else if (avoidViolationRate > 0.1) burnoutScore += 1;
    if (ins.swapReqCount > 2) burnoutScore += 1;
    const burnoutLabel = burnoutScore >= 3 ? `<span class="bg-red-100 text-red-800 rounded px-1.5 py-0.5 text-[10px]">🔥 高</span>`
                       : burnoutScore >= 2 ? `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]">⚠️ 中</span>`
                       : `<span class="bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5 text-[10px]">✓ 低</span>`;
    const submitColor = submitRate >= 0.8 ? "#10b981" : submitRate >= 0.5 ? "#f59e0b" : "#dc2626";
    const reliabilityLabel = (() => {
      if (ins.prefSubmitWeeks === weeksConsidered && submitRate >= 1.0) return `<span class="text-[10px] text-emerald-600">⭐ 皆勤</span>`;
      return "";
    })();

    const row = el("div", { class: "border border-slate-100 rounded-md p-2" });
    row.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-1 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-semibold">${escapeHtml(ins.staff.name)}</span>
          <span class="text-[10px] text-slate-500">${escapeHtml(posCfg(ins.staff.position).label)}</span>
          ${reliabilityLabel}
        </div>
        <div class="flex items-center gap-1.5">燃え尽き: ${burnoutLabel}</div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 text-[11px]">
        <div>
          <div class="text-slate-500 text-[10px]">希望提出率</div>
          <div class="font-semibold" style="color:${submitColor}">${Math.round(submitRate*100)}%</div>
          <div class="text-[9px] text-slate-400">${ins.prefSubmitWeeks}/${weeksConsidered} 週</div>
        </div>
        <div>
          <div class="text-slate-500 text-[10px]">必須充足率</div>
          <div class="font-semibold">${mustRate === null ? "—" : Math.round(mustRate*100) + "%"}</div>
          <div class="text-[9px] text-slate-400">${ins.mustHonored}/${ins.mustTotal}</div>
        </div>
        <div>
          <div class="text-slate-500 text-[10px]">平均週時間</div>
          <div class="font-semibold">${avgWeeklyHours.toFixed(1)}h</div>
          <div class="text-[9px] text-slate-400">合計 ${ins.totalHours.toFixed(0)}h / ${ins.shiftCount} 件</div>
        </div>
        <div>
          <div class="text-slate-500 text-[10px]">不可割当率</div>
          <div class="font-semibold ${avoidViolationRate > 0.1 ? 'text-red-600' : ''}">${ins.avoidTotal === 0 ? "—" : Math.round(avoidViolationRate*100) + "%"}</div>
          <div class="text-[9px] text-slate-400">${ins.avoidViolated}/${ins.avoidTotal}</div>
        </div>
      </div>
      ${(ins.vacReqCount > 0 || ins.swapReqCount > 0) ? `
        <div class="mt-1.5 text-[10px] text-slate-500 flex gap-2">
          ${ins.vacReqCount > 0 ? `<span>🏖 休暇申請 ${ins.vacReqCount}回</span>` : ""}
          ${ins.swapReqCount > 0 ? `<span>🔄 交換申請 ${ins.swapReqCount}回</span>` : ""}
        </div>` : ""}
    `;
    list.appendChild(row);
  }
  if (list.children.length === 0) {
    card.appendChild(el("div", { class: "text-xs text-slate-500 text-center py-2" },
      "データが不足しています (確定済の週・希望データが必要)"));
  } else {
    card.appendChild(list);
  }
  return card;
}

function _timeOverlap(s1, e1, s2, e2) {
  function _t(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  return _t(s1) < _t(e2) && _t(s2) < _t(e1);
}

// ===== シフト交換掲示板 (Round 16 TOP 2) =====
function renderSwapRequestsCard() {
  const swaps = (state.meta && state.meta.swapRequests) || [];
  if (swaps.length === 0) return null;
  const claimed = swaps.filter(s => s.status === "claimed");
  const open = swaps.filter(s => s.status === "open");
  const recent = swaps.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 10);

  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
    el("div", { class: "font-semibold text-sm" }, [
      el("span", {}, "🔄 シフト交換"),
      claimed.length > 0 ? el("span", { class: "ml-2 bg-blue-100 text-blue-800 rounded px-1.5 py-0.5 text-[10px]" },
        `承認待ち ${claimed.length}`) : null,
      open.length > 0 ? el("span", { class: "ml-2 bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 text-[10px]" },
        `募集中 ${open.length}`) : null,
    ]),
  ]));
  const list = el("div", { class: "space-y-1.5" });
  for (const sw of recent) {
    const fromStaff = state.staff.find(s => s.id === sw.fromStaffId);
    const claimedBy = state.staff.find(s => s.id === sw.claimedBy);
    const STATUS_BADGE = {
      open: `<span class="bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">募集中</span>`,
      claimed: `<span class="bg-blue-100 text-blue-800 rounded px-1.5 py-0.5">承認待ち</span>`,
      approved: `<span class="bg-emerald-100 text-emerald-800 rounded px-1.5 py-0.5">✓ 承認</span>`,
      rejected: `<span class="bg-red-100 text-red-800 rounded px-1.5 py-0.5">✗ 却下</span>`,
      cancelled: `<span class="bg-slate-200 text-slate-700 rounded px-1.5 py-0.5">取消</span>`,
    };
    const row = el("div", { class: "border border-slate-100 rounded-md p-2 text-xs flex items-center justify-between gap-2" });
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="font-medium">
          ${escapeHtml(fromStaff?.name || sw.fromStaffName || "?")}
          ${sw.claimedBy ? `<span class="text-slate-500">→ ${escapeHtml(claimedBy?.name || sw.claimedByName || "?")}</span>` : ""}
        </div>
        <div class="text-slate-500">${escapeHtml(sw.date)} ${escapeHtml(sw.startTime)}〜${escapeHtml(sw.endTime)} (${escapeHtml(posCfg(sw.position).label)})</div>
        ${sw.note ? `<div class="text-slate-400 text-[10px] truncate">伝言: ${escapeHtml(sw.note)}</div>` : ""}
      </div>
      <div class="flex items-center gap-1">${STATUS_BADGE[sw.status] || ""}</div>
    `;
    if (sw.status === "claimed") {
      const btnGroup = el("div", { class: "flex gap-1" });
      btnGroup.appendChild(el("button", {
        class: "text-[10px] bg-emerald-500 hover:bg-emerald-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => decideSwapRequest(sw.id, "approved"),
      }, "✓ 承認"));
      btnGroup.appendChild(el("button", {
        class: "text-[10px] bg-red-500 hover:bg-red-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => decideSwapRequest(sw.id, "rejected"),
      }, "✗ 却下"));
      row.appendChild(btnGroup);
    } else if (sw.status === "open") {
      row.appendChild(el("button", {
        class: "text-[10px] bg-slate-200 hover:bg-slate-300 text-slate-700 rounded px-2 py-1",
        onclick: () => decideSwapRequest(sw.id, "cancelled"),
      }, "取消"));
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

async function decideSwapRequest(swapId, decision) {
  const swaps = state.meta.swapRequests || [];
  const sw = swaps.find(s => s.id === swapId);
  if (!sw) { toast("対象が見つかりません", "error"); return; }
  const fromStaff = state.staff.find(s => s.id === sw.fromStaffId);
  const claimedBy = state.staff.find(s => s.id === sw.claimedBy);

  if (decision === "approved") {
    if (sw.status !== "claimed") { toast("承認には引受が必要です", "error"); return; }
    if (!confirm(`${fromStaff?.name || sw.fromStaffName} → ${claimedBy?.name || sw.claimedByName} へのシフト交換 (${sw.date} ${sw.startTime}〜) を承認しますか？\n\n承認すると該当アサインの担当者を変更します。`)) return;

    // 該当 assignment を変更
    const wk = state.weeks?.[sw.weekStart];
    if (!wk) { toast("該当週が見つかりません", "error"); return; }
    const idx = (wk.assignments || []).findIndex(a => a.id === sw.assignmentId);
    if (idx < 0) { toast("該当アサインが見つかりません", "error"); return; }
    const orig = wk.assignments[idx];
    const newStaff = state.staff.find(s => s.id === sw.claimedBy);
    if (!newStaff) { toast("引受スタッフが見つかりません", "error"); return; }
    // 適格性チェック
    const elig = newStaff.position === orig.position || (newStaff.canCover || []).includes(orig.position);
    if (!elig && !confirm(`${newStaff.name} さんは ${posCfg(orig.position).label} を担当できないと設定されています。\nそれでも交換を承認しますか？`)) return;
    // 入替実行
    wk.assignments[idx] = {
      ...orig,
      staffId: newStaff.id,
      cost: newStaff.hourlyWage * calcHours(orig.startTime, orig.endTime),
    };
    sw.status = "approved";
    sw.decidedAt = new Date().toISOString();
    logChange("swap_approved", `${fromStaff?.name || "?"} → ${newStaff.name} のシフト交換を承認 (${sw.date} ${sw.startTime}〜)`);
  } else if (decision === "rejected") {
    if (!confirm(`このシフト交換を却下しますか？\n却下すると元のスタッフのシフトとして残ります。`)) return;
    sw.status = "rejected";
    sw.decidedAt = new Date().toISOString();
    logChange("swap_rejected", `${fromStaff?.name || "?"} のシフト交換を却下 (${sw.date} ${sw.startTime}〜)`);
  } else if (decision === "cancelled") {
    if (!confirm(`このシフト交換募集を取消しますか？`)) return;
    sw.status = "cancelled";
    sw.decidedAt = new Date().toISOString();
    logChange("swap_cancelled", `シフト交換募集を取消 (${sw.date} ${sw.startTime}〜)`);
  }
  await persist(); render();
  toast(`✓ シフト交換を${decision === "approved" ? "承認" : decision === "rejected" ? "却下" : "取消"}しました`, "success");

  // 承認の場合は対象スタッフへ変更通知
  if (decision === "approved") {
    await notifyShiftChanges([sw.fromStaffId, sw.claimedBy]);
  }
}

// ===== 週次/月次レポート (Round 20 TOP 2) =====
function _aggregateAttendance(assignments) {
  let totalHours = 0, actualHours = 0, totalCost = 0;
  let lateCount = 0, earlyOutCount = 0, overtimeCount = 0, missingClock = 0;
  for (const a of assignments) {
    const sched = calcHours(a.startTime, a.endTime);
    totalHours += sched;
    totalCost += a.cost || 0;
    if (a.clockIn && a.clockOut) {
      try {
        const inDt = new Date(a.clockIn), outDt = new Date(a.clockOut);
        actualHours += (outDt - inDt) / 3600000;
        const sIn = new Date(`${a.date}T${a.startTime}:00`);
        const sOut = new Date(`${a.date}T${a.endTime}:00`);
        const dIn = (inDt - sIn) / 60000;
        const dOut = (outDt - sOut) / 60000;
        if (dIn > 5) lateCount++;
        if (dOut < -10) earlyOutCount++;
        if (dOut > 5) overtimeCount++;
      } catch (_) {}
    } else if (!a.clockIn || !a.clockOut) {
      missingClock++;
    }
  }
  return { totalHours, actualHours, totalCost, lateCount, earlyOutCount, overtimeCount, missingClock };
}

function openWeeklyReport() {
  const w0 = state.meta.currentWeekStart || "";
  if (!w0) { toast("対象週がありません", "error"); return; }
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const wkAss = curAssignments();
  const att = _aggregateAttendance(wkAss);
  const sales = state.meta.dailySales || {};
  const wkSales = days.reduce((s, d) => s + (Number(sales[d]) || 0), 0);
  const ratio = wkSales > 0 ? att.totalCost / wkSales : null;
  const target = state.meta.laborCostRatioTarget || 0.28;

  // スタッフ別集計
  const perStaff = state.staff.map(s => {
    const myAss = wkAss.filter(a => a.staffId === s.id);
    const myHours = myAss.reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const myCost = myAss.reduce((sm, a) => sm + (a.cost || 0), 0);
    const att = _aggregateAttendance(myAss);
    return { staff: s, shifts: myAss.length, hours: myHours, cost: myCost, ...att };
  }).filter(x => x.hours > 0).sort((a, b) => b.hours - a.hours);

  // 希望提出率
  const submittedSet = new Set((curPrefs() || []).map(p => p.staffId));
  const submitRate = state.staff.length > 0 ? submittedSet.size / state.staff.length : 0;

  // 変更履歴
  const changeLog = curWeek().changeLog || [];
  const changeBreakdown = {};
  for (const c of changeLog) {
    changeBreakdown[c.type] = (changeBreakdown[c.type] || 0) + 1;
  }
  const changeText = Object.entries(changeBreakdown).map(([k, v]) => `${k}:${v}`).join(", ") || "なし";

  // 印刷用 HTML
  const wrap = document.createElement("div");
  wrap.className = "print-only report-print";
  wrap.innerHTML = `
    <style>
      @media print {
        body > *:not(.print-only) { display: none !important; }
        .print-only { display: block !important; padding: 10mm; font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; }
        .report-print { font-size: 10pt; color: #1e293b; }
        .report-print h1 { font-size: 16pt; margin-bottom: 4mm; }
        .report-print h2 { font-size: 12pt; margin: 4mm 0 2mm; border-bottom: 1px solid #94a3b8; padding-bottom: 1mm; }
        .report-print table { width: 100%; border-collapse: collapse; font-size: 9pt; }
        .report-print th, .report-print td { border: 1px solid #cbd5e1; padding: 1mm 2mm; text-align: left; }
        .report-print th { background: #e2e8f0; }
        .report-print .kpi { display: flex; gap: 4mm; flex-wrap: wrap; margin: 2mm 0; }
        .report-print .kpi-item { border: 1px solid #cbd5e1; padding: 2mm 3mm; border-radius: 1mm; min-width: 30mm; }
        .report-print .kpi-label { font-size: 8pt; color: #64748b; }
        .report-print .kpi-value { font-size: 14pt; font-weight: bold; }
        .report-print .ok { color: #047857; }
        .report-print .warn { color: #b45309; }
        .report-print .danger { color: #b91c1c; }
      }
      @media screen {
        body > .print-only { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: white; z-index: 100; padding: 20px; overflow: auto; }
        .report-print { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; font-size: 12px; max-width: 900px; margin: auto; }
        .report-print h1 { font-size: 22px; margin-bottom: 12px; }
        .report-print h2 { font-size: 16px; margin: 16px 0 8px; border-bottom: 1px solid #94a3b8; padding-bottom: 4px; }
        .report-print table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .report-print th, .report-print td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; }
        .report-print th { background: #e2e8f0; }
        .report-print .kpi { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; }
        .report-print .kpi-item { border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 6px; min-width: 110px; }
        .report-print .kpi-label { font-size: 11px; color: #64748b; }
        .report-print .kpi-value { font-size: 18px; font-weight: bold; }
        .report-print .ok { color: #047857; }
        .report-print .warn { color: #b45309; }
        .report-print .danger { color: #b91c1c; }
        .report-controls { position: fixed; top: 12px; right: 16px; z-index: 200; }
        .report-controls button { padding: 8px 14px; margin-left: 8px; background: #4f46e5; color: white; border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; }
      }
    </style>
    <div class="report-controls no-print">
      <button onclick="window.print()">🖨 印刷 / PDF 保存</button>
      <button onclick="document.querySelector('.print-only')?.remove()" style="background:#64748b">✕ 閉じる</button>
    </div>
    <h1>📊 週次レポート — ${escapeHtml(state.meta.restaurantName)}</h1>
    <div style="color:#64748b;font-size:10pt;margin-bottom:4mm">対象期間: ${w0} 〜 ${addDays(w0, 6)} (${curStatus() === "published" ? "確定済" : "下書き"})</div>

    <h2>主要 KPI</h2>
    <div class="kpi">
      <div class="kpi-item"><div class="kpi-label">シフト数</div><div class="kpi-value">${wkAss.length} 件</div></div>
      <div class="kpi-item"><div class="kpi-label">合計勤務時間</div><div class="kpi-value">${att.totalHours.toFixed(1)}h</div></div>
      <div class="kpi-item"><div class="kpi-label">人件費</div><div class="kpi-value">${fmtYen(Math.round(att.totalCost))}</div></div>
      ${wkSales > 0 ? `
      <div class="kpi-item"><div class="kpi-label">売上</div><div class="kpi-value">${fmtYen(wkSales)}</div></div>
      <div class="kpi-item"><div class="kpi-label">人件費率</div><div class="kpi-value ${ratio <= target ? 'ok' : ratio <= target + 0.05 ? 'warn' : 'danger'}">${(ratio * 100).toFixed(1)}%</div><div class="kpi-label">目標 ${(target * 100).toFixed(0)}%</div></div>
      ` : ""}
      <div class="kpi-item"><div class="kpi-label">希望提出率</div><div class="kpi-value">${(submitRate * 100).toFixed(0)}%</div><div class="kpi-label">${submittedSet.size}/${state.staff.length}名</div></div>
    </div>

    <h2>勤怠サマリ</h2>
    <div class="kpi">
      <div class="kpi-item"><div class="kpi-label">実労働時間</div><div class="kpi-value">${att.actualHours.toFixed(1)}h</div></div>
      <div class="kpi-item"><div class="kpi-label">遅刻 (5分以上)</div><div class="kpi-value ${att.lateCount === 0 ? 'ok' : 'warn'}">${att.lateCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">早退 (10分以上)</div><div class="kpi-value ${att.earlyOutCount === 0 ? 'ok' : 'warn'}">${att.earlyOutCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">残業 (5分以上)</div><div class="kpi-value">${att.overtimeCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">打刻欠落</div><div class="kpi-value ${att.missingClock === 0 ? 'ok' : 'danger'}">${att.missingClock} 件</div></div>
    </div>

    <h2>スタッフ別 (${perStaff.length} 名)</h2>
    <table>
      <thead><tr><th>名前</th><th>本職</th><th>シフト数</th><th>勤務時間</th><th>給与</th><th>遅刻</th><th>早退</th><th>残業</th></tr></thead>
      <tbody>
        ${perStaff.map(p => `
          <tr>
            <td><b>${escapeHtml(p.staff.name)}</b></td>
            <td>${escapeHtml(posCfg(p.staff.position).label)}</td>
            <td>${p.shifts}</td>
            <td>${p.hours.toFixed(1)}h</td>
            <td>${fmtYen(Math.round(p.cost))}</td>
            <td class="${p.lateCount === 0 ? '' : 'warn'}">${p.lateCount}</td>
            <td class="${p.earlyOutCount === 0 ? '' : 'warn'}">${p.earlyOutCount}</td>
            <td>${p.overtimeCount}</td>
          </tr>`).join("")}
      </tbody>
    </table>

    <h2>変更履歴</h2>
    <div style="font-size:10pt">${changeLog.length} 件 (${escapeHtml(changeText)})</div>

    <div style="margin-top:8mm;font-size:9pt;color:#94a3b8;text-align:right">
      生成: ${new Date().toLocaleString("ja-JP")} / Shifty
    </div>`;
  document.body.appendChild(wrap);
}

function openMonthlyReport() {
  const w0 = state.meta.currentWeekStart || "";
  const monthKey = w0.slice(0, 7);
  if (!monthKey) { toast("対象月が判定できません", "error"); return; }

  // 当月の確定済 assignments
  const monthAss = [];
  const allWeeks = state.weeks || {};
  const wkKeys = Object.keys(allWeeks).filter(k => {
    // 当月開始 or 当月内に日付がある週
    return k.startsWith(monthKey) || (allWeeks[k].assignments || []).some(a => (a.date || "").startsWith(monthKey));
  });
  for (const wk of wkKeys) {
    if ((allWeeks[wk] || {}).status !== "published") continue;
    for (const a of (allWeeks[wk].assignments || [])) {
      if ((a.date || "").startsWith(monthKey)) monthAss.push(a);
    }
  }
  if (monthAss.length === 0) { toast(`${monthKey} の確定済シフトがありません`, "error"); return; }

  const att = _aggregateAttendance(monthAss);
  const sales = state.meta.dailySales || {};
  const monthSales = Object.entries(sales)
    .filter(([d, _]) => d.startsWith(monthKey))
    .reduce((s, [_, v]) => s + Number(v || 0), 0);
  const ratio = monthSales > 0 ? att.totalCost / monthSales : null;
  const target = state.meta.laborCostRatioTarget || 0.28;

  // スタッフ別月次集計
  const perStaff = state.staff.map(s => {
    const myAss = monthAss.filter(a => a.staffId === s.id);
    const myHours = myAss.reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const myCost = myAss.reduce((sm, a) => sm + (a.cost || 0), 0);
    const att2 = _aggregateAttendance(myAss);
    const days = new Set(myAss.map(a => a.date)).size;
    return { staff: s, shifts: myAss.length, days, hours: myHours, cost: myCost, ...att2 };
  }).filter(x => x.hours > 0).sort((a, b) => b.cost - a.cost);

  // トップ/ボトム パフォーマー
  const top3 = perStaff.slice(0, 3);

  // 週次トレンド
  const weekTrend = wkKeys.filter(k => (allWeeks[k] || {}).status === "published").sort();
  const trendData = weekTrend.map(wk => {
    const wkAss = (allWeeks[wk] || {}).assignments || [];
    const wkDays = Array.from({ length: 7 }, (_, i) => addDays(wk, i));
    const wkSales = wkDays.reduce((s, d) => s + (Number(sales[d]) || 0), 0);
    const wkCost = wkAss.reduce((s, a) => s + (a.cost || 0), 0);
    return { wk, sales: wkSales, cost: wkCost, ratio: wkSales > 0 ? wkCost / wkSales : null };
  });

  const wrap = document.createElement("div");
  wrap.className = "print-only report-print";
  wrap.innerHTML = `
    <style>
      @media print {
        body > *:not(.print-only) { display: none !important; }
        .print-only { display: block !important; padding: 10mm; font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; }
        .report-print { font-size: 10pt; color: #1e293b; }
        .report-print h1 { font-size: 16pt; margin-bottom: 4mm; }
        .report-print h2 { font-size: 12pt; margin: 4mm 0 2mm; border-bottom: 1px solid #94a3b8; padding-bottom: 1mm; }
        .report-print table { width: 100%; border-collapse: collapse; font-size: 9pt; }
        .report-print th, .report-print td { border: 1px solid #cbd5e1; padding: 1mm 2mm; text-align: left; }
        .report-print th { background: #e2e8f0; }
        .report-print .kpi { display: flex; gap: 4mm; flex-wrap: wrap; margin: 2mm 0; }
        .report-print .kpi-item { border: 1px solid #cbd5e1; padding: 2mm 3mm; border-radius: 1mm; min-width: 30mm; }
        .report-print .kpi-label { font-size: 8pt; color: #64748b; }
        .report-print .kpi-value { font-size: 14pt; font-weight: bold; }
        .report-print .ok { color: #047857; }
        .report-print .warn { color: #b45309; }
        .report-print .danger { color: #b91c1c; }
      }
      @media screen {
        body > .print-only { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: white; z-index: 100; padding: 20px; overflow: auto; }
        .report-print { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; font-size: 12px; max-width: 900px; margin: auto; }
        .report-print h1 { font-size: 22px; margin-bottom: 12px; }
        .report-print h2 { font-size: 16px; margin: 16px 0 8px; border-bottom: 1px solid #94a3b8; padding-bottom: 4px; }
        .report-print table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .report-print th, .report-print td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; }
        .report-print th { background: #e2e8f0; }
        .report-print .kpi { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; }
        .report-print .kpi-item { border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 6px; min-width: 110px; }
        .report-print .kpi-label { font-size: 11px; color: #64748b; }
        .report-print .kpi-value { font-size: 18px; font-weight: bold; }
        .report-print .ok { color: #047857; }
        .report-print .warn { color: #b45309; }
        .report-print .danger { color: #b91c1c; }
        .report-controls { position: fixed; top: 12px; right: 16px; z-index: 200; }
        .report-controls button { padding: 8px 14px; margin-left: 8px; background: #4f46e5; color: white; border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; }
      }
    </style>
    <div class="report-controls no-print">
      <button onclick="window.print()">🖨 印刷 / PDF 保存</button>
      <button onclick="document.querySelector('.print-only')?.remove()" style="background:#64748b">✕ 閉じる</button>
    </div>
    <h1>📈 月次レポート — ${escapeHtml(state.meta.restaurantName)}</h1>
    <div style="color:#64748b;font-size:10pt;margin-bottom:4mm">対象月: ${monthKey} / ${trendData.length} 週分の確定済データ</div>

    <h2>月次 KPI</h2>
    <div class="kpi">
      <div class="kpi-item"><div class="kpi-label">総シフト数</div><div class="kpi-value">${monthAss.length} 件</div></div>
      <div class="kpi-item"><div class="kpi-label">総勤務時間</div><div class="kpi-value">${att.totalHours.toFixed(0)}h</div></div>
      <div class="kpi-item"><div class="kpi-label">人件費</div><div class="kpi-value">${fmtYen(Math.round(att.totalCost))}</div></div>
      ${monthSales > 0 ? `
      <div class="kpi-item"><div class="kpi-label">売上</div><div class="kpi-value">${fmtYen(monthSales)}</div></div>
      <div class="kpi-item"><div class="kpi-label">人件費率</div><div class="kpi-value ${ratio <= target ? 'ok' : ratio <= target + 0.05 ? 'warn' : 'danger'}">${(ratio * 100).toFixed(1)}%</div><div class="kpi-label">目標 ${(target * 100).toFixed(0)}%</div></div>
      ` : ""}
      <div class="kpi-item"><div class="kpi-label">活動スタッフ</div><div class="kpi-value">${perStaff.length} 名</div></div>
    </div>

    <h2>勤怠</h2>
    <div class="kpi">
      <div class="kpi-item"><div class="kpi-label">遅刻</div><div class="kpi-value ${att.lateCount === 0 ? 'ok' : 'warn'}">${att.lateCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">早退</div><div class="kpi-value ${att.earlyOutCount === 0 ? 'ok' : 'warn'}">${att.earlyOutCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">残業</div><div class="kpi-value">${att.overtimeCount} 回</div></div>
      <div class="kpi-item"><div class="kpi-label">打刻欠落</div><div class="kpi-value ${att.missingClock === 0 ? 'ok' : 'danger'}">${att.missingClock} 件</div></div>
    </div>

    <h2>給与上位 ${Math.min(3, top3.length)} 名 (頼りになるスタッフ)</h2>
    <table>
      <thead><tr><th>順位</th><th>名前</th><th>本職</th><th>出勤日数</th><th>勤務時間</th><th>給与</th></tr></thead>
      <tbody>
        ${top3.map((p, i) => `
          <tr>
            <td>${["🥇", "🥈", "🥉"][i] || (i+1)}</td>
            <td><b>${escapeHtml(p.staff.name)}</b></td>
            <td>${escapeHtml(posCfg(p.staff.position).label)}</td>
            <td>${p.days}日</td>
            <td>${p.hours.toFixed(1)}h</td>
            <td>${fmtYen(Math.round(p.cost))}</td>
          </tr>`).join("")}
      </tbody>
    </table>

    <h2>スタッフ別 月次合計 (${perStaff.length} 名)</h2>
    <table>
      <thead><tr><th>名前</th><th>本職</th><th>日数</th><th>勤務時間</th><th>給与</th><th>遅刻</th><th>早退</th><th>残業</th></tr></thead>
      <tbody>
        ${perStaff.map(p => `
          <tr>
            <td><b>${escapeHtml(p.staff.name)}</b></td>
            <td>${escapeHtml(posCfg(p.staff.position).label)}</td>
            <td>${p.days}</td>
            <td>${p.hours.toFixed(1)}h</td>
            <td>${fmtYen(Math.round(p.cost))}</td>
            <td class="${p.lateCount === 0 ? '' : 'warn'}">${p.lateCount}</td>
            <td class="${p.earlyOutCount === 0 ? '' : 'warn'}">${p.earlyOutCount}</td>
            <td>${p.overtimeCount}</td>
          </tr>`).join("")}
      </tbody>
    </table>

    ${trendData.length >= 2 ? `
    <h2>週次トレンド</h2>
    <table>
      <thead><tr><th>週開始</th><th>売上</th><th>人件費</th><th>人件費率</th></tr></thead>
      <tbody>
        ${trendData.map(t => `
          <tr>
            <td>${t.wk}</td>
            <td>${t.sales > 0 ? fmtYen(t.sales) : "—"}</td>
            <td>${fmtYen(Math.round(t.cost))}</td>
            <td class="${t.ratio === null ? '' : t.ratio <= target ? 'ok' : t.ratio <= target + 0.05 ? 'warn' : 'danger'}">
              ${t.ratio === null ? "—" : (t.ratio * 100).toFixed(1) + "%"}
            </td>
          </tr>`).join("")}
      </tbody>
    </table>` : ""}

    <div style="margin-top:8mm;font-size:9pt;color:#94a3b8;text-align:right">
      生成: ${new Date().toLocaleString("ja-JP")} / Shifty
    </div>`;
  document.body.appendChild(wrap);
}

// ===== 売上予測 + 人件費シミュレーション (Round 27 TOP 2) =====
function forecastSales(targetWeekStart) {
  const sales = state.meta.dailySales || {};
  const days = Array.from({ length: 7 }, (_, i) => addDays(targetWeekStart, i));
  // 過去 4-8 週の同曜日売上の移動平均で予測
  const allWeeks = state.weeks || {};
  const sortedWk = Object.keys(allWeeks).sort();
  const historicalWeeks = sortedWk.filter(w => w < targetWeekStart).slice(-8);

  const forecast = {};
  const confidences = {};
  for (let i = 0; i < 7; i++) {
    const dow = dayOfWeek(days[i]);
    const samples = [];
    for (const wk of historicalWeeks) {
      const histDate = addDays(wk, i);
      if (sales[histDate] && sales[histDate] > 0) samples.push(sales[histDate]);
    }
    if (samples.length === 0) {
      forecast[days[i]] = null;
      confidences[days[i]] = "low";
      continue;
    }
    // 中央値ベース (外れ値に強い)
    const sorted = samples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    forecast[days[i]] = Math.round(median);
    confidences[days[i]] = samples.length >= 4 ? "high" : samples.length >= 2 ? "med" : "low";
  }
  return { forecast, confidences, samplesUsed: historicalWeeks.length };
}

function openSimulationDialog() {
  const w0 = state.meta.currentWeekStart || "";
  if (!w0) { toast("対象週がありません", "error"); return; }
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));

  // 売上予測
  const fc = forecastSales(w0);
  const sales = state.meta.dailySales || {};
  const target = state.meta.laborCostRatioTarget || 0.28;

  // 現在の配置
  const ass = curAssignments();
  const totalCost = ass.reduce((s, a) => s + (a.cost || 0), 0);
  const totalForecast = Object.values(fc.forecast).reduce((s, v) => s + (v || 0), 0);
  const inputSales = days.reduce((s, d) => s + (Number(sales[d]) || 0), 0);
  const usedSales = inputSales > 0 ? inputSales : totalForecast;
  const ratio = usedSales > 0 ? totalCost / usedSales : null;

  // What-if: 人数を 1 つ減らした場合の予測
  function calcWhatIf(deltaPercent) {
    const newCost = totalCost * (1 + deltaPercent / 100);
    return usedSales > 0 ? newCost / usedSales : null;
  }

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🔮 売上予測 + 人件費シミュレーション"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    `対象週: ${w0} 〜 ${addDays(w0, 6)} / 過去 ${fc.samplesUsed} 週の売上を学習`));

  // 予測テーブル
  const fcTable = el("table", { class: "w-full text-xs border-collapse" });
  let fcHtml = `<thead><tr class="bg-slate-100"><th class="border p-1.5 text-left">日付</th><th class="border p-1.5">入力</th><th class="border p-1.5">AI 予測</th><th class="border p-1.5">使用値</th><th class="border p-1.5">信頼度</th></tr></thead><tbody>`;
  for (const d of days) {
    const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
    const dowColor = dayOfWeek(d) === 0 ? "text-red-600" : dayOfWeek(d) === 6 ? "text-blue-600" : "";
    const inputV = Number(sales[d]) || 0;
    const fcV = fc.forecast[d];
    const used = inputV > 0 ? inputV : (fcV || 0);
    const conf = fc.confidences[d];
    const confLabel = { high: "🟢 高", med: "🟡 中", low: "🔴 低" }[conf] || "—";
    fcHtml += `<tr>
      <td class="border p-1.5 ${dowColor}"><span class="font-mono">${d.slice(5)}</span> (${dow})</td>
      <td class="border p-1.5 text-right">${inputV > 0 ? fmtYen(inputV) : "—"}</td>
      <td class="border p-1.5 text-right text-slate-500">${fcV ? fmtYen(fcV) : "—"}</td>
      <td class="border p-1.5 text-right font-semibold ${inputV > 0 ? "text-blue-700" : "text-slate-700"}">${used > 0 ? fmtYen(used) : "—"}</td>
      <td class="border p-1.5 text-center text-[10px]">${confLabel}</td>
    </tr>`;
  }
  fcHtml += `<tr class="bg-slate-50 font-bold"><td class="border p-1.5">週合計</td><td class="border p-1.5 text-right">${fmtYen(inputSales)}</td><td class="border p-1.5 text-right text-slate-500">${fmtYen(totalForecast)}</td><td class="border p-1.5 text-right text-blue-700">${fmtYen(usedSales)}</td><td class="border p-1.5"></td></tr>`;
  fcHtml += `</tbody>`;
  fcTable.innerHTML = fcHtml;
  body.appendChild(fcTable);

  // 現在の指標
  body.appendChild(el("div", { class: "grid grid-cols-3 gap-2 text-xs mt-2" }, [
    el("div", { class: "bg-slate-50 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "今週の人件費"),
      el("div", { class: "font-bold text-base" }, fmtYen(Math.round(totalCost))),
    ]),
    el("div", { class: "bg-slate-50 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "売上 (使用値)"),
      el("div", { class: "font-bold text-base" }, fmtYen(usedSales)),
    ]),
    el("div", { class: "bg-slate-50 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "予想人件費率"),
      el("div", { class: `font-bold text-base ${ratio === null ? "" : ratio <= target ? "text-emerald-700" : ratio <= target + 0.05 ? "text-amber-700" : "text-red-700"}` },
        ratio === null ? "—" : (ratio * 100).toFixed(1) + "%"),
    ]),
  ]));

  // What-if 分析
  if (usedSales > 0) {
    body.appendChild(el("div", { class: "border-t pt-2 mt-2" }, [
      el("div", { class: "text-xs font-semibold mb-1" }, "💡 What-if 分析"),
    ]));
    const whatIf = el("div", { class: "space-y-1 text-xs" });
    for (const dPct of [-20, -10, 0, 10]) {
      const r = calcWhatIf(dPct);
      const label = dPct === 0 ? "現状" : dPct > 0 ? `+${dPct}%` : `${dPct}%`;
      const newCost = totalCost * (1 + dPct / 100);
      const dr = r === null ? "—" : (r * 100).toFixed(1) + "%";
      const cls = r === null ? "" : r <= target ? "text-emerald-700" : r <= target + 0.05 ? "text-amber-700" : "text-red-700";
      whatIf.innerHTML += `
        <div class="flex justify-between bg-slate-50 rounded px-2 py-1 ${dPct === 0 ? 'border-l-4 border-blue-500' : ''}">
          <span>人件費 ${label}</span>
          <span class="font-mono">${fmtYen(Math.round(newCost))}</span>
          <span class="font-bold ${cls}">${dr}</span>
        </div>`;
    }
    body.appendChild(whatIf);
    body.appendChild(el("div", { class: "text-[10px] text-slate-500 mt-1" },
      `💡 目標 ${(target * 100).toFixed(0)}% を達成するには、人件費を ${fmtYen(Math.round(usedSales * target))} 以下にする必要があります${totalCost > usedSales * target ? ` (現状から ${fmtYen(Math.round(totalCost - usedSales * target))} 削減)` : " (✓ 目標達成見込み)"}.`));
  }

  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
}

// ===== スタッフ詳細展開行 (Round 31 TOP 3) =====
function toggleStaffDetailRow(tr, staff) {
  const next = tr.nextSibling;
  if (next && next.classList && next.classList.contains("staff-detail-row")) {
    next.remove();
    return;
  }
  // 過去シフト集計 (4 週分)
  const allWeeks = state.weeks || {};
  const sortedWk = Object.keys(allWeeks).sort().slice(-8);
  const monthKey = (state.meta.currentWeekStart || "").slice(0, 7);
  let monthHours = 0, monthCost = 0, monthShifts = 0;
  let lateCount = 0, clockInCount = 0, clockableShifts = 0;
  const recent = [];
  for (const wk of sortedWk) {
    const wd = allWeeks[wk];
    if (!wd.assignments) continue;
    for (const a of wd.assignments) {
      if (a.staffId !== staff.id) continue;
      // 月次集計
      if ((a.date || "").startsWith(monthKey)) {
        const h = calcHours(a.startTime, a.endTime);
        monthHours += h;
        monthCost += a.cost || 0;
        monthShifts++;
      }
      // 打刻率
      if (wd.status === "published") {
        clockableShifts++;
        if (a.clockIn) {
          clockInCount++;
          // 遅刻判定
          try {
            const inDt = new Date(a.clockIn);
            const sched = new Date(`${a.date}T${a.startTime}:00`);
            if ((inDt - sched) / 60000 > 5) lateCount++;
          } catch (_) {}
        }
        recent.push(a);
      }
    }
  }
  recent.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const recentDisplay = recent.slice(0, 5);

  // 希望提出率
  let prefSubmittedWeeks = 0;
  let prefWeeksTotal = 0;
  for (const wk of sortedWk) {
    const wd = allWeeks[wk];
    if (wd.status !== "published") continue;
    prefWeeksTotal++;
    const has = (wd.preferences || []).some(p => p.staffId === staff.id);
    if (has) prefSubmittedWeeks++;
  }
  const submitRate = prefWeeksTotal > 0 ? prefSubmittedWeeks / prefWeeksTotal : 0;
  const clockRate = clockableShifts > 0 ? clockInCount / clockableShifts : 0;

  const detailTr = document.createElement("tr");
  detailTr.className = "staff-detail-row bg-slate-50 dark:bg-slate-800/50";
  const td = document.createElement("td");
  td.colSpan = 9;
  td.className = "px-4 py-3";
  td.innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      <div class="bg-white dark:bg-slate-700 rounded p-2">
        <div class="text-[10px] text-slate-500">${escapeHtml(monthKey)} 出勤</div>
        <div class="text-base font-bold">${monthShifts} 件 / ${monthHours.toFixed(1)}h</div>
      </div>
      <div class="bg-white dark:bg-slate-700 rounded p-2">
        <div class="text-[10px] text-slate-500">${escapeHtml(monthKey)} 給与</div>
        <div class="text-base font-bold">${fmtYen(Math.round(monthCost))}</div>
      </div>
      <div class="bg-white dark:bg-slate-700 rounded p-2">
        <div class="text-[10px] text-slate-500">希望提出率 (過去 ${prefWeeksTotal} 週)</div>
        <div class="text-base font-bold ${submitRate >= 0.8 ? "text-emerald-600" : submitRate >= 0.5 ? "text-amber-600" : "text-red-600"}">${Math.round(submitRate * 100)}%</div>
      </div>
      <div class="bg-white dark:bg-slate-700 rounded p-2">
        <div class="text-[10px] text-slate-500">打刻率 / 遅刻</div>
        <div class="text-base font-bold">${Math.round(clockRate * 100)}% <span class="text-xs text-slate-500">/ ${lateCount} 回遅刻</span></div>
      </div>
    </div>
    ${recentDisplay.length > 0 ? `
    <div class="mt-3">
      <div class="text-[10px] text-slate-500 mb-1">最近の確定済シフト</div>
      <div class="flex flex-wrap gap-1">
        ${recentDisplay.map(a => {
          const dow = ["日","月","火","水","木","金","土"][dayOfWeek(a.date)];
          return `<span class="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded px-2 py-0.5 text-[10px]">${escapeHtml(a.date.slice(5))}(${dow}) ${escapeHtml(a.startTime)}〜${escapeHtml(a.endTime)} ${escapeHtml(posCfg(a.position).label)}</span>`;
        }).join("")}
      </div>
    </div>` : ""}
  `;
  detailTr.appendChild(td);
  tr.parentNode.insertBefore(detailTr, tr.nextSibling);
}

// ===== AI 生成後の改善ポイント表示 (Round 32 TOP 3) =====
function showPostGenFeedback(result) {
  const m = result.metrics;
  const issues = [];

  // 1. 不足コマ
  const unfilled = result.unfilled || [];
  if (unfilled.length > 0) {
    const top = unfilled.slice(0, 2);
    issues.push({
      level: "danger",
      icon: "⚠️",
      title: `${unfilled.length} コマが埋められませんでした`,
      detail: top.map(u => `${u.date.slice(5)} ${u.startTime}〜 ${posCfg(u.position).label}`).join(" / ") + (unfilled.length > 2 ? ` 他 ${unfilled.length - 2}` : ""),
      action: { label: "対象を確認", onclick: () => toast("シフト編成画面で「不足: ...」表示があるコマです", "info", 4000) },
    });
  }

  // 2. 予算超過
  const budget = state.meta.weeklyBudget || 0;
  if (budget > 0 && m.totalCost > budget) {
    const over = m.totalCost - budget;
    issues.push({
      level: "warn",
      icon: "💸",
      title: `予算を ${fmtYen(over)} 超過しました`,
      detail: `予算 ${fmtYen(budget)} / 実績 ${fmtYen(Math.round(m.totalCost))}`,
      action: { label: "AI 戦略を「コスト」に変更", onclick: () => {
        state.meta.algorithmWeights = { preference: 0.22, positionMatch: 0.13, fairness: 0.13, cost: 0.35, skill: 0.10, skillMix: 0.07 };
        persist();
        toast("✓ コスト重視に切替。再生成で人件費削減を試みてください", "success", 5000);
      } },
    });
  }

  // 3. 希望充足が低い
  if (m.preferenceSatisfaction < 0.7 && m.preferenceTotal > 0) {
    issues.push({
      level: "warn",
      icon: "📝",
      title: `希望充足率 ${fmtPct(m.preferenceSatisfaction)} は低めです`,
      detail: `${m.preferenceHit}/${m.preferenceTotal} の希望が反映されました。スタッフの不満につながる可能性`,
      action: { label: "AI 戦略を「希望優先」に変更", onclick: () => {
        state.meta.algorithmWeights = { preference: 0.55, positionMatch: 0.10, fairness: 0.13, cost: 0.05, skill: 0.10, skillMix: 0.07 };
        persist();
        toast("✓ 希望優先に切替。再生成すると希望充足率が上がります", "success", 5000);
      } },
    });
  }

  // 4. 公平性 (時間の偏り)
  if (m.fairness && m.fairness.cv > 0.5) {
    const overMax = m.perStaff.filter(p => p.overMax);
    issues.push({
      level: "warn",
      icon: "⚖️",
      title: `スタッフ間の時間配分が不均等です (CV ${m.fairness.cv.toFixed(2)})`,
      detail: overMax.length > 0
        ? `週上限超過: ${overMax.slice(0, 2).map(p => p.name).join(", ")}`
        : "一部のスタッフに時間が偏っています",
      action: { label: "AI 戦略を「公平性重視」に変更", onclick: () => {
        state.meta.algorithmWeights = { preference: 0.27, positionMatch: 0.10, fairness: 0.38, cost: 0.10, skill: 0.08, skillMix: 0.07 };
        persist();
        toast("✓ 公平性重視に切替。再生成すると時間が平準化されます", "success", 5000);
      } },
    });
  }

  // 5. avoid 違反
  if (m.avoidViolations > 0) {
    issues.push({
      level: "warn",
      icon: "🚫",
      title: `不可希望に反する配置が ${m.avoidViolations} 件あります`,
      detail: "他に候補が居ないなどの理由で配置されています。手動調整も検討",
      action: null,
    });
  }

  // 6. 個人別希望充足が極端に低い
  if (state.staff.length >= 3 && m.preferenceTotal > 0) {
    const lowStaff = m.perStaff.filter(p => p.hours > 0).slice(0, 5);
    // 希望提出済みなのに反映されてないスタッフ
    const submittedSet = new Set((curPrefs() || []).map(p => p.staffId));
    const submittedStaff = state.staff.filter(s => !s.archived && submittedSet.has(s.id));
    const cur = curAssignments();
    const lowSatisfaction = submittedStaff.filter(s => {
      const myPrefs = curPrefs().filter(p => p.staffId === s.id && p.priority !== "avoid");
      if (myPrefs.length === 0) return false;
      const hits = myPrefs.filter(p => cur.some(a => a.staffId === s.id && a.date === p.date)).length;
      return hits / myPrefs.length < 0.4;
    });
    if (lowSatisfaction.length > 0) {
      issues.push({
        level: "info",
        icon: "👤",
        title: `希望充足率が低いスタッフが ${lowSatisfaction.length} 名います`,
        detail: lowSatisfaction.slice(0, 3).map(s => s.name).join(", "),
        action: { label: "確認", onclick: () => {} },
      });
    }
  }

  // 何も問題ない場合は祝福のみ
  if (issues.length === 0) {
    const body = el("div", { class: "p-6 space-y-3" });
    body.appendChild(el("div", { class: "text-center" }, [
      el("div", { class: "text-5xl" }, "🎉"),
      el("h3", { class: "font-bold text-lg mt-2" }, "完璧な配置です"),
      el("p", { class: "text-sm text-slate-600 dark:text-slate-400 mt-2" },
        `カバー率 ${fmtPct(m.coverageRate)} / 希望充足 ${fmtPct(m.preferenceSatisfaction)} / 予算内。\n気になる点があれば手動で調整できます。`),
    ]));
    body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
      el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "閉じる"),
      el("button", {
        class: "px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-semibold",
        onclick: () => { closeModal(); publishWeek(); },
      }, "✓ そのまま確定する"),
    ]));
    modal(body);
    return;
  }

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💡 改善ポイント"));
  body.appendChild(el("p", { class: "text-xs text-slate-600 dark:text-slate-400" },
    `AI 生成完了。${issues.length} 件の改善ポイントがあります。下記を確認してから確定してください。`));

  // メトリクス表示
  body.appendChild(el("div", { class: "grid grid-cols-3 gap-2 text-xs" }, [
    el("div", { class: "bg-emerald-50 dark:bg-emerald-900/30 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-emerald-700" }, "カバー率"),
      el("div", { class: "font-bold text-base" }, fmtPct(m.coverageRate)),
    ]),
    el("div", { class: "bg-blue-50 dark:bg-blue-900/30 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-blue-700" }, "希望充足"),
      el("div", { class: "font-bold text-base" }, fmtPct(m.preferenceSatisfaction)),
    ]),
    el("div", { class: "bg-amber-50 dark:bg-amber-900/30 rounded p-2 text-center" }, [
      el("div", { class: "text-[10px] text-amber-700" }, "人件費"),
      el("div", { class: "font-bold text-base" }, fmtYen(Math.round(m.totalCost))),
    ]),
  ]));

  const list = el("div", { class: "space-y-1.5" });
  for (const iss of issues) {
    const cls = iss.level === "danger" ? "bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-700"
              : iss.level === "warn"   ? "bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700"
              : "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700";
    const row = el("div", { class: `border ${cls} rounded p-2.5 text-xs flex items-start gap-2` });
    row.appendChild(el("span", { class: "text-base flex-none" }, iss.icon));
    const main = el("div", { class: "flex-1 min-w-0" });
    main.appendChild(el("div", { class: "font-semibold" }, iss.title));
    main.appendChild(el("div", { class: "text-[11px] mt-0.5 opacity-90" }, iss.detail));
    if (iss.action) {
      main.appendChild(el("button", {
        class: "mt-1.5 text-[11px] underline decoration-dotted hover:no-underline",
        onclick: () => { iss.action.onclick(); closeModal(); render(); },
      }, "→ " + iss.action.label));
    }
    row.appendChild(main);
    list.appendChild(row);
  }
  body.appendChild(list);

  body.appendChild(el("div", { class: "flex justify-between gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "閉じる (シフトを確認)"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold",
      onclick: () => { closeModal(); autoGenerate(); },
    }, "🔄 再生成"),
  ]));
  modal(body);
}

// ===== クイックセットアップウィザード (Round 32 TOP 1) =====
function openQuickSetupWizard() {
  const BUSINESS_TYPES = (window.ShiftyData || {}).BUSINESS_TYPES || {};
  const SESSION_PRESETS = (window.ShiftyData || {}).SESSION_PRESETS || {};
  let step = 0;
  let selectedType = null;
  let selectedHours = null;
  let staffCountTier = null;

  const HOUR_PRESETS = [
    { id: "lunch_dinner", label: "ランチ + ディナー", desc: "11:00〜15:00 + 17:00〜22:00 (典型的な飲食店)" },
    { id: "all_day", label: "通し営業", desc: "10:00〜22:00 (カフェ・ファミレス向け)" },
    { id: "night_only", label: "夜営業のみ", desc: "17:00〜深夜 (居酒屋・バー向け)" },
    { id: "morning_only", label: "朝〜夕方", desc: "07:00〜18:00 (カフェ・モーニング向け)" },
  ];

  const STAFF_COUNT_TIERS = [
    { id: "small", label: "小規模 (5-8 名)", desc: "家族経営、個人店、少人数運営" },
    { id: "medium", label: "中規模 (9-15 名)", desc: "標準的な飲食店、複数シフト" },
    { id: "large", label: "大規模 (16+ 名)", desc: "ファミレス、チェーン店" },
  ];

  function render() {
    const body = el("div", { class: "p-6 space-y-4" });
    body.appendChild(el("div", { class: "flex items-center gap-3 mb-2" }, [
      el("div", { class: "text-3xl" }, "🚀"),
      el("div", { class: "flex-1" }, [
        el("div", { class: "text-xs text-slate-500" }, `ステップ ${step + 1} / 3`),
        el("h3", { class: "font-bold text-lg" }, [
          "クイックセットアップ",
          el("span", { class: "ml-2 text-xs font-normal text-slate-500" }, "(後から変更可)"),
        ]),
      ]),
    ]));

    // 進捗ドット
    const dots = el("div", { class: "flex gap-1.5 mb-3" });
    for (let i = 0; i < 3; i++) {
      dots.appendChild(el("div", {
        class: `flex-1 h-1.5 rounded-full ${i <= step ? "bg-brand-600" : "bg-slate-200 dark:bg-slate-700"}`,
      }));
    }
    body.appendChild(dots);

    if (step === 0) {
      body.appendChild(el("div", { class: "font-semibold text-sm" }, "1. お店の業態を選んでください"));
      const list = el("div", { class: "space-y-2 max-h-64 overflow-y-auto" });
      for (const [key, bt] of Object.entries(BUSINESS_TYPES)) {
        const isSelected = key === selectedType;
        const card = el("button", {
          class: `block w-full text-left border-2 rounded-md p-3 transition ${isSelected ? "border-brand-600 bg-brand-50 dark:bg-brand-900/30" : "border-slate-200 dark:border-slate-700 hover:border-slate-400"}`,
          onclick: () => { selectedType = key; renderModal(); },
        });
        card.innerHTML = `
          <div class="font-semibold text-sm">${escapeHtml(bt.label)}</div>
          <div class="text-xs text-slate-600 dark:text-slate-400 mt-0.5">${escapeHtml(bt.description)}</div>`;
        list.appendChild(card);
      }
      body.appendChild(list);
    } else if (step === 1) {
      body.appendChild(el("div", { class: "font-semibold text-sm" }, "2. 営業時間のパターンを選んでください"));
      body.appendChild(el("div", { class: "text-xs text-slate-500" },
        "業態に応じて推奨パターンを表示しています。詳細時間は後で営業時間タブから個別調整できます。"));
      const list = el("div", { class: "space-y-2" });
      for (const opt of HOUR_PRESETS) {
        const isSelected = opt.id === selectedHours;
        const card = el("button", {
          class: `block w-full text-left border-2 rounded-md p-3 transition ${isSelected ? "border-brand-600 bg-brand-50 dark:bg-brand-900/30" : "border-slate-200 dark:border-slate-700 hover:border-slate-400"}`,
          onclick: () => { selectedHours = opt.id; renderModal(); },
        });
        card.innerHTML = `
          <div class="font-semibold text-sm">${escapeHtml(opt.label)}</div>
          <div class="text-xs text-slate-600 dark:text-slate-400 mt-0.5">${escapeHtml(opt.desc)}</div>`;
        list.appendChild(card);
      }
      body.appendChild(list);
    } else if (step === 2) {
      body.appendChild(el("div", { class: "font-semibold text-sm" }, "3. 概ねのスタッフ人数は？"));
      body.appendChild(el("div", { class: "text-xs text-slate-500" },
        "必要人数の目安を自動設定します。後から「必要人数マトリクス」で個別調整可能です。"));
      const list = el("div", { class: "space-y-2" });
      for (const opt of STAFF_COUNT_TIERS) {
        const isSelected = opt.id === staffCountTier;
        const card = el("button", {
          class: `block w-full text-left border-2 rounded-md p-3 transition ${isSelected ? "border-brand-600 bg-brand-50 dark:bg-brand-900/30" : "border-slate-200 dark:border-slate-700 hover:border-slate-400"}`,
          onclick: () => { staffCountTier = opt.id; renderModal(); },
        });
        card.innerHTML = `
          <div class="font-semibold text-sm">${escapeHtml(opt.label)}</div>
          <div class="text-xs text-slate-600 dark:text-slate-400 mt-0.5">${escapeHtml(opt.desc)}</div>`;
        list.appendChild(card);
      }
      body.appendChild(list);
    }

    // ナビボタン
    body.appendChild(el("div", { class: "flex justify-between gap-2 pt-3 border-t" }, [
      el("button", {
        class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md",
        onclick: () => step === 0 ? closeModal() : (step--, renderModal()),
      }, step === 0 ? "キャンセル" : "← 戻る"),
      el("button", {
        class: `px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold ${
          (step === 0 && !selectedType) || (step === 1 && !selectedHours) || (step === 2 && !staffCountTier) ? "opacity-50 pointer-events-none" : ""
        }`,
        onclick: () => {
          if (step < 2) { step++; renderModal(); }
          else applyQuickSetup();
        },
      }, step < 2 ? "次へ →" : "✓ 適用"),
    ]));
    return body;
  }

  function renderModal() {
    const m = $("#modal");
    const mb = $("#modalBody");
    if (mb) mb.innerHTML = "";
    if (mb) mb.appendChild(render());
    if (m) m.classList.remove("hidden");
  }

  function applyQuickSetup() {
    const bt = BUSINESS_TYPES[selectedType];
    if (!bt) { toast("業態が未選択です", "error"); return; }

    // スナップショット
    try { createSnapshot("manual", `クイックセットアップ適用前 (${bt.label})`); } catch (_) {}

    // 業態適用
    state.meta.businessType = selectedType;

    // 営業時間: hours preset とビジネスタイプの session preset を組み合わせ
    let presetKey = bt.sessionPreset;
    if (selectedHours === "all_day") presetKey = "early_mid_late";
    else if (selectedHours === "night_only") presetKey = "izakaya";
    else if (selectedHours === "morning_only") presetKey = "cafe_allday";
    else if (selectedHours === "lunch_dinner") presetKey = "simple_lunch_dinner";

    const sessionPreset = SESSION_PRESETS[presetKey];
    if (sessionPreset) {
      state.meta.sessions = JSON.parse(JSON.stringify(sessionPreset.sessions));
    }

    // スタッフ規模に応じた必要人数調整
    const tierMultiplier = staffCountTier === "small" ? 0.8 : staffCountTier === "large" ? 1.5 : 1.0;
    const newPlan = {};
    for (const sess of state.meta.sessions) {
      newPlan[sess.id] = {};
      for (let dow = 0; dow < 7; dow++) {
        newPlan[sess.id][dow] = {};
        const isWeekend = dow === 0 || dow === 6;
        const isPeak = sess.id.includes("peak") || sess.id.includes("lunch") || sess.id.includes("dinner");
        for (const pos of state.meta.positions) {
          let base = bt.defaultStaffCount[pos.id] != null ? bt.defaultStaffCount[pos.id] : 1;
          if (isWeekend && isPeak) base += 1;
          base = Math.round(base * tierMultiplier);
          if (pos.id === "manager") base = 1;
          newPlan[sess.id][dow][pos.id] = Math.max(0, base);
        }
      }
    }
    state.meta.staffingPlan = newPlan;
    state.meta.laborRules = { ...bt.laborRules };
    state.meta.algorithmWeights = { ...bt.weights };
    state.meta.payrollSettings = { ...bt.payrollSettings };
    state.meta.laborCostRatioTarget = bt.laborCostRatioTarget;
    regenerateCurSlots();
    persist();
    closeModal();
    render();
    toast(`✓ ${bt.label} の設定を適用しました。スタッフ&希望タブでスタッフ追加を進めましょう`, "success", 6000);
  }

  modal(render());
}

// ===== 設定検索 (Round 30) =====
function filterSettingsBySearch(query) {
  const q = (query || "").toLowerCase().trim();
  // 設定の各セクション (id="set-*") をフィルタ
  const sections = document.querySelectorAll('[id^="set-"]');
  if (!q) {
    sections.forEach(s => s.style.display = "");
    return;
  }
  sections.forEach(s => {
    const text = s.textContent.toLowerCase();
    s.style.display = text.includes(q) ? "" : "none";
  });
}

// ===== ダッシュボードカスタマイズ (Round 28 TOP 1) =====
function openDashboardCustomizeDialog() {
  const settings = state.meta.dashboardWidgets || {};
  const widgets = [
    { id: "alerts", label: "⚠️ 注意事項", desc: "希望未提出・予算超過などの警告" },
    { id: "todayAttendance", label: "☀ 本日の出勤者", desc: "今日のシフト + 打刻ステータス" },
    { id: "laborCostRatio", label: "💰 人件費率", desc: "売上 vs 人件費のゲージ + トレンド" },
    { id: "monthlyLaborRisk", label: "📊 月次労務リスク", desc: "スタッフ別の月次累積時間" },
    { id: "staffInsights", label: "📈 スタッフインサイト", desc: "希望提出率・燃え尽きリスク" },
    { id: "costChart", label: "📈 人件費推移グラフ", desc: "直近 8 週のトレンド" },
    { id: "monthlyRanking", label: "🏅 月間労働時間ランキング", desc: "スタッフ別の今月集計" },
  ];

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "⚙️ ダッシュボードのカスタマイズ"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "表示する項目を選択してください。OFF にした項目はダッシュボードに表示されません。"));

  const list = el("div", { class: "space-y-2" });
  for (const w of widgets) {
    const enabled = settings[w.id] !== false;
    const row = el("label", { class: "flex items-center gap-3 border border-slate-200 rounded p-2.5 cursor-pointer hover:bg-slate-50" });
    const cb = el("input", { type: "checkbox", "data-widget-id": w.id });
    if (enabled) cb.checked = true;
    row.appendChild(cb);
    row.appendChild(el("div", { class: "flex-1" }, [
      el("div", { class: "font-semibold text-sm" }, w.label),
      el("div", { class: "text-xs text-slate-500" }, w.desc),
    ]));
    list.appendChild(row);
  }
  body.appendChild(list);

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold",
      onclick: () => {
        const newSettings = { ...settings };
        list.querySelectorAll("[data-widget-id]").forEach(cb => {
          newSettings[cb.getAttribute("data-widget-id")] = cb.checked;
        });
        state.meta.dashboardWidgets = newSettings;
        persist();
        closeModal();
        render();
        toast("✓ ダッシュボード設定を保存しました", "success");
      },
    }, "💾 保存"),
  ]));
  modal(body);
}

// ===== キーボードショートカット (Round 28 TOP 2) =====
const SHORTCUTS = {
  "?": { desc: "ショートカット一覧", action: () => showShortcutsHelp() },
  "g d": { desc: "ダッシュボードへ", action: () => setTab("dashboard") },
  "g s": { desc: "スタッフ管理へ", action: () => setTab("staff") },
  "g p": { desc: "希望収集へ", action: () => setTab("preferences") },
  "g r": { desc: "シフト編成へ", action: () => setTab("schedule") },
  "g e": { desc: "エクスポートへ", action: () => setTab("export") },
  "g c": { desc: "設定へ", action: () => setTab("settings") },
  "n": { desc: "新規スタッフ追加 (スタッフタブで)", action: () => { if (currentTab === "staff") openStaffEdit(); } },
  "a": { desc: "AI 自動生成 (シフト編成タブで)", action: () => { if (currentTab === "schedule") autoGenerate(); } },
  "p": { desc: "印刷 (シフト編成タブで)", action: () => { if (currentTab === "schedule") openPrintMenuDialog(); } },
  "/": { desc: "検索フォーカス", action: () => {
    const inp = document.querySelector("input[type=search]");
    if (inp) { inp.focus(); inp.select(); }
  } },
  "Esc": { desc: "モーダル閉じる", action: () => closeModal() },
};

function showShortcutsHelp() {
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "⌨️ キーボードショートカット"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "効率的に操作できるキー。いつでも「?」で再表示できます。"));
  const list = el("div", { class: "space-y-1 text-sm" });
  for (const [key, def] of Object.entries(SHORTCUTS)) {
    const row = el("div", { class: "flex items-center justify-between bg-slate-50 dark:bg-slate-800 rounded px-3 py-2" });
    row.innerHTML = `
      <span>${escapeHtml(def.desc)}</span>
      <kbd class="bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded px-2 py-0.5 text-xs font-mono">${escapeHtml(key)}</kbd>`;
    list.appendChild(row);
  }
  body.appendChild(list);
  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
}

(function _initShortcuts() {
  let buffer = "";
  let bufferTimer = null;
  document.addEventListener("keydown", (e) => {
    // 入力中はスキップ
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)) {
      // 例外: Esc は許可
      if (e.key === "Escape") {
        if (active && active.blur) active.blur();
      }
      return;
    }
    // モディファイアキー付きはスキップ (ブラウザショートカットを邪魔しない)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "?") {
      e.preventDefault(); showShortcutsHelp(); return;
    }
    if (e.key === "Escape") {
      closeModal(); return;
    }
    if (e.key === "/") {
      e.preventDefault();
      const inp = document.querySelector("input[type=search]");
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
    // g + key シーケンス
    if (e.key === "g") {
      buffer = "g ";
      if (bufferTimer) clearTimeout(bufferTimer);
      bufferTimer = setTimeout(() => { buffer = ""; }, 1500);
      return;
    }
    if (buffer.startsWith("g ")) {
      const combo = buffer + e.key.toLowerCase();
      const def = SHORTCUTS[combo];
      if (def) {
        e.preventDefault();
        def.action();
      }
      buffer = "";
      if (bufferTimer) clearTimeout(bufferTimer);
      return;
    }
    // 単独キー
    const single = SHORTCUTS[e.key.toLowerCase()];
    if (single) {
      e.preventDefault();
      single.action();
    }
  });
})();

// ===== ヘルプセンター (Round 25 TOP 1) =====
const FAQ_DATA = [
  // 基本操作
  { cat: "🚀 はじめに", q: "最初に何をすればいい？", a: "ダッシュボードの「業態を選択」から、お店の業態に合うテンプレートを選んでください。セッション・必要人数・労務ルール・人件費目標が一括設定されます。次にスタッフタブで「+ 追加」または CSV 取込でスタッフを登録してください。" },
  { cat: "🚀 はじめに", q: "サンプルデータで試したい", a: "ダッシュボードの「🎯 サンプルデータで試す」ボタン、または設定タブの危険操作の「リセット」から投入できます。10 名のサンプルスタッフ + 希望サンプルが入ります。" },
  { cat: "🚀 はじめに", q: "シフトの作り方の流れは？", a: "1) スタッフ登録 → 2) 各スタッフへ希望入力リンクを共有 → 3) 希望が集まったら「シフト編成」タブで「🤖 AI自動生成」 → 4) 必要に応じて手動調整 → 5) 「✓ 確定」 → 6) スタッフへ通知メール送信、の流れです。" },

  // 希望収集
  { cat: "📝 希望収集", q: "スタッフに希望入力リンクをどう渡す？", a: "スタッフタブの「📱 QR」ボタンで QR コードを生成・印刷できます。または「🔗 全員のリンク」で全員分の URL を一括コピー → LINE で配信できます。" },
  { cat: "📝 希望収集", q: "スタッフが入力するときの操作は？", a: "セッション (lunch/dinner) の 4 ボタン (必須/希望/不可/未定) を押すか、または「⏰ 自由時間で希望」で「17:00-22:00」など自由時間を直接登録できます (Round 18 TOP 1)。" },
  { cat: "📝 希望収集", q: "提出期限はどう設定する？", a: "設定タブの「提出締切」で「週開始の何日前/何時」を設定してください。スタッフポータルにカウントダウンが表示されます。" },

  // AI 自動生成
  { cat: "🤖 AI 自動生成", q: "AI の重みづけはどう変える？", a: "「シフト編成」タブヘッダーの「AI 戦略」プルダウンで 5 戦略から選択 (バランス/希望優先/コスト/スキル/公平性)。詳細は設定タブで個別調整可能。" },
  { cat: "🤖 AI 自動生成", q: "希望が反映されない", a: "「avoid」希望の人を強制配置することはありません。「must」希望は他制約 (固定休日・週上限) と衝突しなければ最優先。希望が反映されない理由はアサイン詳細の「AI スコア内訳」で確認できます。" },
  { cat: "🤖 AI 自動生成", q: "シフト不足が出る", a: "対象スタッフが少ない、または労務ルールが厳しすぎる可能性があります。「設定 > 労務ルール」を緩和、またはスタッフ追加・希望提出促進をお試しください。「💡 AI 推奨人数」で適正配置を再計算もできます。" },

  // 打刻
  { cat: "⏱ 打刻", q: "スタッフの打刻はどこから？", a: "確定済シフトのスタッフポータルに「⏱ 出勤打刻」「⏱ 退勤打刻」ボタンが自動表示されます。シフト時刻の前後 4 時間以内のみ打刻可。" },
  { cat: "⏱ 打刻", q: "打刻を忘れた場合", a: "オーナーがアサイン詳細から手動修正可能。打刻管理 UI で出勤/退勤時刻を編集できます。" },
  { cat: "⏱ 打刻", q: "予定と実績の差はどう確認？", a: "ダッシュボードに「予定/実績の乖離が大」アラート、月次バイト代 CSV で「実労働 + 予定との差分明細」を選択できます。" },

  // 給与
  { cat: "💴 給与計算", q: "月次バイト代を出すには？", a: "エクスポートタブ「💴 給与計算 CSV」から対象月を選び、形式 (サマリ/明細/弥生/freee) と集計ベース (予定/実労働/差分明細) を選択。" },
  { cat: "💴 給与計算", q: "深夜手当は？", a: "設定タブの給与計算オプションで「深夜手当を有効にする」をオン。22 時以降の労働時間が自動的に 1.25 倍 (法定) で計算されます。" },
  { cat: "💴 給与計算", q: "休憩時間の控除は？", a: "スタッフ編集ダイアログで「休憩(分)」を設定。6 時間超勤務時に自動的に給与から控除されます。" },

  // トラブル対応
  { cat: "🚨 トラブル対応", q: "スタッフが当日に休みたいと言ってきた", a: "受信メッセージで赤色強調表示されます。「🆘 代打を探す」ボタンで AI が候補 3 名を提示、ワンクリックで代打が決まります。両者へ自動メール通知も。" },
  { cat: "🚨 トラブル対応", q: "確定済みのシフトを変更したい", a: "シフト編成タブで「下書きに戻す」 → 編集 → 再確定。変更通知メールが影響スタッフに自動送信されます。" },
  { cat: "🚨 トラブル対応", q: "間違って削除/上書きしてしまった", a: "設定タブの「🔁 操作単位スナップショット」または「🕒 過去スナップショット (サーバ)」から復元可能。確定前/AI 生成前/日次に自動取得しています。" },

  // 経営管理
  { cat: "📊 経営管理", q: "人件費率を改善したい", a: "ダッシュボードに「💰 今週の人件費率」カード。設定で日次売上を入力すれば自動計算 (目標 25-30%)。「💡 AI 推奨人数」は過去データから最適配置を学習・提案します。" },
  { cat: "📊 経営管理", q: "週次/月次レポートは？", a: "エクスポートタブ「📊 週次レポート」「📈 月次レポート」で印刷/PDF 保存可能なレポートを生成。店舗会議資料として使えます。" },

  // 通知
  { cat: "💬 通知", q: "LINE 通知に対応？", a: "LINE Notify は 2025/3 終了。スタッフ編集の Webhook URL に IFTTT/Zapier 経由 LINE webhook を設定するか、Slack/Discord webhook を直接利用できます。" },
  { cat: "💬 通知", q: "全員にお知らせを送りたい", a: "スタッフタブ「📢 全員に通知」ボタン。緊急度 (通常/重要/緊急) + 件名/本文 + 送信先絞込。メール + Webhook 同時送信。" },

  // セキュリティ・権限
  { cat: "🔒 セキュリティ", q: "リンクが流出したら？", a: "スタッフタブで「🔄 再発行」ボタン → 旧 URL を無効化、新 URL を発行・コピー。退職者対応・URL 流出時の対処に。" },
  { cat: "🔒 セキュリティ", q: "退職者の処理は？", a: "「📁 アーカイブ」が推奨です。削除と異なり履歴・給与計算データは残ります。「📤 復帰」で戻せます。完全削除も可能ですが警告が出ます。" },
];

function renderHelpCenter() {
  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3" });
  card.appendChild(el("div", { class: "font-semibold" }, "📚 ヘルプセンター / FAQ"));
  card.appendChild(el("div", { class: "text-xs text-slate-500" },
    `${FAQ_DATA.length} 件の Q&A から検索できます。`));

  const searchInput = el("input", {
    type: "search",
    placeholder: "🔍 質問を検索 (例: 打刻 / 希望 / 給与)",
    class: "w-full border rounded-md px-3 py-2 text-sm",
  });
  card.appendChild(searchInput);

  const list = el("div", { class: "space-y-1.5 max-h-96 overflow-y-auto" });
  card.appendChild(list);

  function renderFiltered() {
    const q = (searchInput.value || "").toLowerCase().trim();
    list.innerHTML = "";
    const filtered = q
      ? FAQ_DATA.filter(f =>
          f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q))
      : FAQ_DATA;

    if (filtered.length === 0) {
      list.appendChild(el("div", { class: "text-xs text-slate-500 text-center py-4" },
        `「${q}」に一致する FAQ がありません`));
      return;
    }
    // カテゴリ別にグループ化
    const byCat = {};
    for (const f of filtered) {
      if (!byCat[f.cat]) byCat[f.cat] = [];
      byCat[f.cat].push(f);
    }
    for (const [cat, items] of Object.entries(byCat)) {
      list.appendChild(el("div", { class: "text-[10px] font-semibold text-slate-500 mt-2" }, cat));
      for (const f of items) {
        const det = el("details", { class: "border border-slate-100 rounded p-2 hover:bg-slate-50" });
        det.appendChild(el("summary", { class: "text-sm cursor-pointer" }, `Q. ${f.q}`));
        det.appendChild(el("div", { class: "text-xs text-slate-700 mt-2 whitespace-pre-wrap" }, f.a));
        list.appendChild(det);
      }
    }
  }
  searchInput.oninput = renderFiltered;
  renderFiltered();

  card.appendChild(el("div", { class: "text-[10px] text-slate-400 pt-2 border-t border-slate-100" },
    "💡 解決しない場合: support@in-dx.jp までご連絡ください"));

  return card;
}

// ===== 全体監査ログ (Round 25 TOP 2) =====
function appendAuditLog(action, detail, extra = {}) {
  if (!state || !state.meta) return;
  if (!Array.isArray(state.meta.auditLog)) state.meta.auditLog = [];
  state.meta.auditLog.push({
    at: new Date().toISOString(),
    week: state.meta.currentWeekStart || null,
    action,
    detail,
    ...extra,
  });
  // 最新 500 件のみ保持
  if (state.meta.auditLog.length > 500) {
    state.meta.auditLog = state.meta.auditLog.slice(-500);
  }
}


function renderAuditLogViewer() {
  const log = (state.meta && state.meta.auditLog) || [];
  if (log.length === 0) {
    return null;
  }
  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3" });
  card.appendChild(el("details", {}, [
    el("summary", { class: "cursor-pointer font-semibold" },
      `🔍 全体監査ログ (${log.length} 件)`),
    (() => {
      const wrap = el("div", { class: "mt-3 space-y-2" });
      const search = el("input", {
        type: "search",
        placeholder: "🔍 アクション/詳細で検索 (例: 確定 / Bさん / 削除)",
        class: "w-full border rounded-md px-3 py-1.5 text-sm",
      });
      wrap.appendChild(search);
      const listWrap = el("div", { class: "max-h-72 overflow-y-auto space-y-1 text-xs" });
      wrap.appendChild(listWrap);

      const TYPE_LABEL = {
        publish: "✅ 確定", unpublish: "📝 下書きに戻す", delete: "🗑 削除",
        swap: "🔄 入替", substitute: "🆘 代打", add: "➕ 追加",
        autogenerate: "🤖 AI生成", note: "📝 メモ更新",
        vacation_approved: "🏖 休暇承認", vacation_rejected: "🏖 休暇却下",
        swap_approved: "🔄 交換承認", swap_rejected: "🔄 交換却下", swap_cancelled: "🔄 交換取消",
        clock_edit: "⏱ 打刻修正", clock_clear: "⏱ 打刻クリア",
      };

      function renderLogList() {
        const q = (search.value || "").toLowerCase().trim();
        listWrap.innerHTML = "";
        const filtered = q
          ? log.filter(l => (l.detail || "").toLowerCase().includes(q) || (l.action || "").toLowerCase().includes(q) || (TYPE_LABEL[l.action] || "").toLowerCase().includes(q))
          : log;
        const sorted = filtered.slice().reverse(); // 新しい順
        if (sorted.length === 0) {
          listWrap.appendChild(el("div", { class: "text-slate-500 text-center py-3" }, "該当なし"));
          return;
        }
        for (const entry of sorted.slice(0, 200)) {
          const at = new Date(entry.at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          const wk = entry.week ? `[${entry.week.slice(5)}]` : "";
          const row = el("div", { class: "border-b border-slate-100 py-1 grid grid-cols-12 gap-1" });
          row.innerHTML = `
            <span class="col-span-2 text-slate-400 text-[10px]">${at}</span>
            <span class="col-span-1 text-[10px] text-blue-600">${wk}</span>
            <span class="col-span-3 font-medium text-[11px]">${TYPE_LABEL[entry.action] || entry.action}</span>
            <span class="col-span-6 text-slate-700 text-[11px]">${escapeHtml(entry.detail || "")}</span>`;
          listWrap.appendChild(row);
        }
        if (sorted.length > 200) {
          listWrap.appendChild(el("div", { class: "text-[10px] text-slate-400 text-center py-2" },
            `+ ${sorted.length - 200} 件 (検索で絞り込んでください)`));
        }
      }
      search.oninput = renderLogList;
      renderLogList();

      // CSV エクスポート
      wrap.appendChild(el("div", { class: "flex justify-end pt-2 border-t border-slate-100" }, [
        el("button", {
          class: "text-xs bg-slate-700 hover:bg-slate-800 text-white rounded px-3 py-1",
          onclick: () => exportAuditLogCsv(),
        }, "📥 CSV エクスポート"),
      ]));
      return wrap;
    })(),
  ]));
  return card;
}

function exportAuditLogCsv() {
  const log = (state.meta && state.meta.auditLog) || [];
  if (log.length === 0) { toast("ログがありません", "error"); return; }
  let csv = "日時,週,アクション,詳細\n";
  for (const e of log) {
    const row = [
      e.at,
      e.week || "",
      e.action || "",
      e.detail || "",
    ].map(x => `"${String(x).replace(/"/g, '""')}"`).join(",");
    csv += row + "\n";
  }
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `audit_log_${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`✓ ${log.length} 件のログを CSV ダウンロード`, "success");
}

// ===== ダークモード (Round 25 TOP 3) =====
function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("dark");
  if (theme === "dark") {
    html.classList.add("dark");
  } else if (theme === "auto") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) html.classList.add("dark");
  }
}

// 初回起動時にテーマ適用
(function _initTheme() {
  try {
    const saved = localStorage.getItem("shifty.theme") || "auto";
    applyTheme(saved);
    // システム設定変更を監視
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        const cur = localStorage.getItem("shifty.theme") || "auto";
        if (cur === "auto") applyTheme("auto");
      });
    }
  } catch (_) {}
})();

// ===== グループ通知 (Round 22 TOP 2) =====
function openBroadcastDialog() {
  if (state.staff.length === 0) { toast("送信先のスタッフがいません", "error"); return; }
  const candidates = state.staff.filter(s => !s.archived);
  const withEmail = candidates.filter(s => (s.email || "").trim()).length;
  const withWebhook = candidates.filter(s => (s.webhookUrl || "").trim()).length;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📢 全員に通知"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    `${candidates.length} 名のうち、メール登録 ${withEmail} 名 / Webhook 登録 ${withWebhook} 名へ送信されます。`));

  const sevSelect = el("select", { id: "br-sev", class: "w-full border rounded px-2 py-1 text-sm" });
  for (const [val, label] of [["normal", "📢 通常 (お知らせ)"], ["important", "❗ 重要 (会議・変更)"], ["urgent", "🚨 緊急 (台風・休業)"]]) {
    sevSelect.appendChild(el("option", { value: val }, label));
  }

  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-700" }, "緊急度"),
    sevSelect,
  ]));

  const subjInput = el("input", {
    id: "br-subj", class: "w-full border rounded px-2 py-1 text-sm", maxlength: "200",
    placeholder: "件名 (例: 来週の営業時間変更について)",
  });
  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-700" }, "件名 (任意)"),
    subjInput,
  ]));

  const bodyInput = el("textarea", {
    id: "br-body", rows: "5", maxlength: "3000",
    class: "w-full border rounded px-2 py-1 text-sm",
    placeholder: "メッセージ本文 (3000 字まで)\n\n例:\nお疲れ様です。台風 5 号接近のため、明日 (5/15) は営業時間を 12:00〜18:00 に短縮します。\n出勤予定のシフトは変更なし、終了時刻のみ早まります。\nご確認お願いします。",
  });
  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-700" }, "本文"),
    bodyInput,
  ]));

  // 送信先選択
  const targetWrap = el("details", { class: "border border-slate-200 rounded p-2" });
  targetWrap.appendChild(el("summary", { class: "text-sm cursor-pointer" }, "送信先 (絞込)"));
  const checkAllRow = el("div", { class: "mt-2 mb-1 flex gap-2 text-xs" }, [
    el("button", { class: "text-blue-600 hover:underline", type: "button",
      onclick: () => targetWrap.querySelectorAll("input[data-target]").forEach(i => i.checked = true) }, "全選択"),
    el("button", { class: "text-slate-500 hover:underline", type: "button",
      onclick: () => targetWrap.querySelectorAll("input[data-target]").forEach(i => i.checked = false) }, "全解除"),
  ]);
  targetWrap.appendChild(checkAllRow);
  const targetGrid = el("div", { class: "grid grid-cols-2 sm:grid-cols-3 gap-1" });
  for (const s of candidates) {
    const hasContact = (s.email || s.webhookUrl);
    targetGrid.appendChild(el("label", { class: `inline-flex items-center gap-1 text-xs ${hasContact ? "" : "opacity-50"}` }, [
      (() => {
        const cb = el("input", { type: "checkbox", "data-target": s.id });
        cb.checked = !!hasContact; // デフォルトで連絡先ありのみ ON
        return cb;
      })(),
      el("span", {}, `${s.name}${!hasContact ? " (連絡先なし)" : ""}`),
    ]));
  }
  targetWrap.appendChild(targetGrid);
  body.appendChild(targetWrap);

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md font-semibold",
      onclick: async () => {
        const severity = sevSelect.value;
        const subject = subjInput.value.trim();
        const bodyText = bodyInput.value.trim();
        if (!bodyText) { toast("本文を入力してください", "error"); return; }
        const targets = Array.from(targetWrap.querySelectorAll("input[data-target]:checked")).map(i => i.getAttribute("data-target"));
        if (targets.length === 0) { toast("送信先を 1 名以上選んでください", "error"); return; }
        const sevLabel = { normal: "通常", important: "重要", urgent: "緊急" }[severity];
        if (!confirm(`${targets.length} 名へ「${sevLabel}」通知を送信します。よろしいですか？`)) return;
        try {
          const r = await window.ShiftyAPI.broadcast({ severity, subject, body: bodyText, staffIds: targets });
          toast(`✓ ${r.sentEmail} 名にメール送信、${r.sentWebhook} Webhook 送信 (${r.skipped} 名スキップ)`, "success", 6000);
          closeModal();
        } catch (e) {
          toast("送信失敗: " + (e?.message || ""), "error");
        }
      },
    }, "📢 送信"),
  ]));
  modal(body);
}

// ===== モデルシフト (Round 21 TOP 1) =====
// 過去の確定済シフトと売上から「曜日×セッション×ポジション」の最適人数を学習
function computeModelShift() {
  const sessions = state.meta.sessions || [];
  const positions = state.meta.positions || [];
  const sales = state.meta.dailySales || {};
  const target = state.meta.laborCostRatioTarget || 0.28;
  const allWeeks = state.weeks || {};

  // 過去 8 週の確定済シフトを集計
  const wkKeys = Object.keys(allWeeks).filter(k => allWeeks[k].status === "published").sort().slice(-8);
  if (wkKeys.length < 2) {
    return { error: "履歴不足", weeksAnalyzed: wkKeys.length };
  }

  // 各 (dow, sessId, posId) のサンプルを集める
  // サンプル: { count, salesShare, laborCost, ratio }
  const samples = {}; // key: "dow|sess|pos" -> [{ count, ratio, salesPerHour }]
  for (const wkKey of wkKeys) {
    const wk = allWeeks[wkKey];
    if (!wk.assignments) continue;
    // 週内日別の売上
    const days = Array.from({ length: 7 }, (_, i) => addDays(wkKey, i));
    const wkSales = days.map(d => Number(sales[d]) || 0);
    const totalWkSales = wkSales.reduce((a, b) => a + b, 0);
    if (totalWkSales === 0) continue; // 売上不明はスキップ (人件費率比較できない)

    // 日別人件費 (assignments cost)
    const dayCost = days.map(d =>
      wk.assignments.filter(a => a.date === d).reduce((s, a) => s + (a.cost || 0), 0)
    );

    for (let i = 0; i < 7; i++) {
      const d = days[i];
      const dow = dayOfWeek(d);
      if (wkSales[i] === 0) continue;
      const dayRatio = dayCost[i] / wkSales[i];
      // 各セッション・ポジションの実際配置人数
      for (const sess of sessions) {
        for (const pos of positions) {
          const count = wk.assignments.filter(a =>
            a.date === d && a.position === pos.id &&
            a.startTime === sess.startTime && a.endTime === sess.endTime
          ).length;
          const key = `${dow}|${sess.id}|${pos.id}`;
          if (!samples[key]) samples[key] = [];
          samples[key].push({ count, ratio: dayRatio, sales: wkSales[i] });
        }
      }
    }
  }

  // 各 key について、人件費率が target 以下のサンプルがあれば、そのサンプル群の平均 count を採用
  // 無ければ全サンプルの平均 (より少なめに)
  const recommendation = {}; // sess -> dow -> pos -> count
  for (const sess of sessions) {
    recommendation[sess.id] = {};
    for (let dow = 0; dow < 7; dow++) {
      recommendation[sess.id][dow] = {};
      for (const pos of positions) {
        const key = `${dow}|${sess.id}|${pos.id}`;
        const list = samples[key] || [];
        if (list.length === 0) {
          // データなし → 現状を維持
          recommendation[sess.id][dow][pos.id] = state.meta.staffingPlan[sess.id]?.[dow]?.[pos.id] || 0;
          continue;
        }
        // 目標達成サンプルのみ
        const goodSamples = list.filter(x => x.ratio <= target);
        const targetSamples = goodSamples.length > 0 ? goodSamples : list;
        const avgCount = targetSamples.reduce((s, x) => s + x.count, 0) / targetSamples.length;
        // 中央値の方が外れ値に強いので両方計算して max を採用 (人手不足を避ける)
        const sorted = targetSamples.map(x => x.count).slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const recommended = Math.max(Math.round(avgCount), median);
        recommendation[sess.id][dow][pos.id] = Math.max(0, recommended);
      }
    }
  }

  return {
    recommendation,
    weeksAnalyzed: wkKeys.length,
    weeks: wkKeys,
    samples,
  };
}

function openModelShiftDialog() {
  const result = computeModelShift();
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💡 AI 推奨人数 (モデルシフト)"));

  if (result.error) {
    body.appendChild(el("div", { class: "bg-amber-50 border border-amber-200 rounded p-3 text-sm" },
      `データ不足: ${result.error}。過去 ${result.weeksAnalyzed} 週分の確定済シフトしかありません。`));
    body.appendChild(el("p", { class: "text-xs text-slate-600" },
      "推奨機能を使うには 2 週以上の確定済シフト + 日次売上データが必要です。"));
    body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3" }, [
      el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    ]));
    modal(body);
    return;
  }

  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    `過去 ${result.weeksAnalyzed} 週の確定済シフト + 売上から、目標人件費率 ${((state.meta.laborCostRatioTarget || 0.28) * 100).toFixed(0)}% を達成した曜日×時間帯の配置パターンを学習しました。`));

  // 差分テーブル
  const sessions = state.meta.sessions || [];
  const positions = state.meta.positions || [];
  let totalCurr = 0, totalRec = 0, changesByCell = 0;
  const diffsHtml = [];
  for (const sess of sessions) {
    let sessHtml = `<table class="w-full text-xs border border-slate-200 rounded mt-2"><thead class="bg-slate-50"><tr>`;
    sessHtml += `<th class="text-left p-1">${escapeHtml(sess.icon || "")} ${escapeHtml(sess.label)}</th>`;
    for (let d = 1; d <= 7; d++) {
      const dow = d === 7 ? 0 : d;
      sessHtml += `<th class="p-1">${DAY_LABELS[dow]}</th>`;
    }
    sessHtml += `</tr></thead><tbody>`;
    for (const pos of positions) {
      sessHtml += `<tr class="border-t border-slate-100"><td class="p-1">${posBadge(pos.id)}</td>`;
      for (let d = 1; d <= 7; d++) {
        const dow = d === 7 ? 0 : d;
        const curr = state.meta.staffingPlan[sess.id]?.[dow]?.[pos.id] || 0;
        const rec = result.recommendation[sess.id]?.[dow]?.[pos.id] || 0;
        totalCurr += curr; totalRec += rec;
        const diff = rec - curr;
        if (diff !== 0) changesByCell++;
        const cls = diff > 0 ? "text-red-600" : diff < 0 ? "text-emerald-600" : "text-slate-400";
        const arrow = diff > 0 ? `+${diff}↑` : diff < 0 ? `${diff}↓` : "=";
        sessHtml += `<td class="p-1 text-center text-[10px]">
          <span class="text-slate-700">${curr}</span> → <span class="font-semibold">${rec}</span>
          <br><span class="${cls}">${arrow}</span>
        </td>`;
      }
      sessHtml += `</tr>`;
    }
    sessHtml += `</tbody></table>`;
    diffsHtml.push(sessHtml);
  }
  const diffsContainer = el("div", { class: "max-h-72 overflow-y-auto" });
  diffsContainer.innerHTML = diffsHtml.join("");
  body.appendChild(diffsContainer);

  // サマリ
  body.appendChild(el("div", { class: "grid grid-cols-3 gap-2 text-xs" }, [
    el("div", { class: "bg-slate-50 rounded p-2" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "現状の合計枠数 (週)"),
      el("div", { class: "font-bold" }, String(totalCurr)),
    ]),
    el("div", { class: "bg-slate-50 rounded p-2" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "推奨の合計枠数 (週)"),
      el("div", { class: "font-bold" }, String(totalRec)),
    ]),
    el("div", { class: "bg-slate-50 rounded p-2" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "差分セル数"),
      el("div", { class: "font-bold" }, `${changesByCell}/${sessions.length * positions.length * 7}`),
    ]),
  ]));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md font-semibold",
      onclick: () => {
        if (!confirm(`AI 推奨を適用すると、必要人数マトリクスが ${changesByCell} セル変更されます。\n適用前にスナップショットを自動取得します。続行しますか？`)) return;
        try { createSnapshot("manual", "AI 推奨人数 適用前"); } catch (_) {}
        // 全セル上書き
        const newPlan = {};
        for (const sess of sessions) {
          newPlan[sess.id] = {};
          for (let dow = 0; dow < 7; dow++) {
            newPlan[sess.id][dow] = {};
            for (const pos of positions) {
              newPlan[sess.id][dow][pos.id] = result.recommendation[sess.id]?.[dow]?.[pos.id] || 0;
            }
          }
        }
        state.meta.staffingPlan = newPlan;
        regenerateCurSlots();
        persist();
        closeModal();
        render();
        toast(`✓ AI 推奨を適用 (${changesByCell} セル更新 / 過去 ${result.weeksAnalyzed} 週分析)`, "success", 5000);
      },
    }, "💡 推奨を適用"),
  ]));
  modal(body);
}

// ===== 売上連動の人件費率 (Round 20 TOP 1) =====
function renderLaborCostRatio() {
  const w0 = state.meta.currentWeekStart || "";
  if (!w0) return null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const sales = state.meta.dailySales || {};
  const target = state.meta.laborCostRatioTarget || 0.28;

  // 今週の売上と人件費を集計
  const weekAssignments = curAssignments();
  const weekCost = weekAssignments.reduce((s, a) => s + (a.cost || 0), 0);
  const weekSales = days.reduce((s, d) => s + (Number(sales[d]) || 0), 0);
  const ratio = weekSales > 0 ? weekCost / weekSales : null;

  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
  const headerRow = el("div", { class: "flex items-center justify-between mb-2 flex-wrap gap-1" }, [
    el("div", { class: "font-semibold text-sm" }, "💰 今週の人件費率"),
    el("div", { class: "flex gap-2" }, [
      el("button", {
        class: "text-xs text-purple-600 hover:text-purple-800 underline decoration-dotted",
        onclick: () => openSimulationDialog(),
      }, "🔮 予測+シミュ"),
      el("button", {
        class: "text-xs text-slate-500 hover:text-slate-700 underline decoration-dotted",
        onclick: () => openSalesInputDialog(),
      }, "📝 売上を入力"),
    ]),
  ]);
  card.appendChild(headerRow);

  // メインゲージ
  if (ratio !== null) {
    const pctRatio = ratio * 100;
    const targetPct = target * 100;
    const status = ratio <= target ? "good" : ratio <= target + 0.05 ? "warn" : "danger";
    const color = status === "good" ? "#10b981" : status === "warn" ? "#f59e0b" : "#dc2626";
    const statusLabel = status === "good" ? `✓ 目標達成` : status === "warn" ? `⚠️ やや高め` : `🚨 大幅オーバー`;

    const main = el("div", { class: "space-y-2" });
    main.innerHTML = `
      <div class="flex items-baseline justify-between">
        <span class="text-2xl font-bold" style="color:${color}">${pctRatio.toFixed(1)}%</span>
        <span class="text-xs text-slate-600">目標 ${targetPct.toFixed(0)}% / ${statusLabel}</span>
      </div>
      <div class="gauge-bar"><div style="width:${Math.min(100, pctRatio*1.5)}%;background:${color}"></div></div>
      <div class="grid grid-cols-2 gap-3 text-xs mt-2">
        <div class="bg-slate-50 rounded p-2">
          <div class="text-slate-500 text-[10px]">今週売上</div>
          <div class="font-semibold">${fmtYen(weekSales)}</div>
        </div>
        <div class="bg-slate-50 rounded p-2">
          <div class="text-slate-500 text-[10px]">今週人件費</div>
          <div class="font-semibold">${fmtYen(Math.round(weekCost))}</div>
        </div>
      </div>`;
    card.appendChild(main);
  } else {
    card.appendChild(el("div", { class: "text-xs text-slate-500 text-center py-3" },
      [
        "📊 売上を入力すると人件費率を自動計算します",
        el("button", {
          class: "block mx-auto mt-2 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded px-3 py-1.5 font-semibold",
          onclick: () => openSalesInputDialog(),
        }, "💴 売上入力 →"),
      ]
    ));
  }

  // 過去 8 週のトレンドグラフ
  const allWeeks = state.weeks || {};
  const sortedWk = Object.keys(allWeeks).sort().slice(-8);
  if (sortedWk.length >= 2 && typeof Chart !== "undefined") {
    const trendData = sortedWk.map(wk => {
      const wkDays = Array.from({ length: 7 }, (_, i) => addDays(wk, i));
      const wkSales = wkDays.reduce((s, d) => s + (Number(sales[d]) || 0), 0);
      const wkAss = (allWeeks[wk] || {}).assignments || [];
      const wkCost = wkAss.reduce((s, a) => s + (a.cost || 0), 0);
      return {
        wk,
        sales: wkSales,
        cost: wkCost,
        ratio: wkSales > 0 ? wkCost / wkSales : null,
      };
    }).filter(x => x.ratio !== null);

    if (trendData.length >= 2) {
      const trendCard = el("div", { class: "mt-3 pt-3 border-t border-slate-100" });
      trendCard.appendChild(el("div", { class: "text-xs font-semibold text-slate-700 mb-1" },
        `📈 直近 ${trendData.length} 週のトレンド`));
      const cv = el("canvas", { id: "lcr-trend-chart", style: { maxHeight: "120px" } });
      trendCard.appendChild(cv);
      card.appendChild(trendCard);
      setTimeout(() => {
        const ctx = document.getElementById("lcr-trend-chart");
        if (!ctx) return;
        try {
          if (window._lcrChart) window._lcrChart.destroy();
          window._lcrChart = new Chart(ctx, {
            type: "line",
            data: {
              labels: trendData.map(x => x.wk.slice(5)),
              datasets: [
                {
                  label: "人件費率",
                  data: trendData.map(x => x.ratio * 100),
                  borderColor: "#4f46e5",
                  backgroundColor: "rgba(79, 70, 229, 0.1)",
                  fill: true,
                  tension: 0.3,
                },
                {
                  label: `目標 ${(target * 100).toFixed(0)}%`,
                  data: trendData.map(() => target * 100),
                  borderColor: "#10b981",
                  borderDash: [4, 4],
                  borderWidth: 1.5,
                  pointRadius: 0,
                  fill: false,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: true, position: "bottom", labels: { font: { size: 9 } } } },
              scales: {
                y: { beginAtZero: false, ticks: { callback: v => v + "%", font: { size: 9 } } },
                x: { ticks: { font: { size: 9 } } },
              },
            },
          });
        } catch (e) { console.warn("lcr chart failed:", e); }
      }, 100);
    }
  }
  return card;
}

function openSalesInputDialog() {
  const w0 = state.meta.currentWeekStart || "";
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const sales = state.meta.dailySales || {};
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💴 日次売上入力"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "今週 7 日分の売上 (税込/税抜どちらでも、運用統一を推奨) を入力してください。空欄は 0 として扱います。"));

  const grid = el("div", { class: "space-y-1.5" });
  for (const d of days) {
    const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
    const dowColor = dayOfWeek(d) === 0 ? "text-red-600" : dayOfWeek(d) === 6 ? "text-blue-600" : "text-slate-700";
    const row = el("label", { class: "flex items-center gap-2" });
    row.innerHTML = `
      <span class="${dowColor} font-mono text-xs w-24">${d.slice(5)} (${dow})</span>
      <input type="number" data-date="${d}" min="0" step="1000"
        class="sales-input flex-1 border rounded-md px-3 py-1.5 text-sm" placeholder="例: 180000"
        value="${sales[d] || ""}">
      <span class="text-[10px] text-slate-500 w-12">円</span>`;
    grid.appendChild(row);
  }
  body.appendChild(grid);

  // 目標人件費率
  body.appendChild(el("div", { class: "border-t pt-3 mt-2" }, [
    el("label", { class: "block text-sm" }, [
      el("span", { class: "text-slate-700" }, "目標人件費率"),
      el("select", { id: "lcr-target", class: "ml-2 border rounded px-2 py-1 text-sm" }, [
        el("option", { value: "0.20" }, "20% (理想・チェーン)"),
        el("option", { value: "0.25" }, "25% (優良)"),
        el("option", { value: "0.28" }, "28% (標準)"),
        el("option", { value: "0.30" }, "30% (目安上限)"),
        el("option", { value: "0.33" }, "33% (要改善)"),
      ]),
    ]),
    el("div", { class: "text-[10px] text-slate-500 mt-1" },
      "💡 飲食業界平均は 28-32%。25% 以下なら優良。"),
  ]));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md font-semibold",
      onclick: () => {
        state.meta.dailySales = state.meta.dailySales || {};
        body.querySelectorAll(".sales-input").forEach(inp => {
          const d = inp.getAttribute("data-date");
          const v = Number(inp.value) || 0;
          if (v > 0) state.meta.dailySales[d] = v;
          else delete state.meta.dailySales[d];
        });
        const tgt = Number(document.getElementById("lcr-target").value) || 0.28;
        state.meta.laborCostRatioTarget = tgt;
        persist(); closeModal(); render();
        toast("✓ 売上データと目標を保存しました", "success");
      },
    }, "💾 保存"),
  ]));
  modal(body);
  // 目標値を select で初期選択
  setTimeout(() => {
    const sel = document.getElementById("lcr-target");
    if (sel) sel.value = String(state.meta.laborCostRatioTarget || 0.28);
  }, 0);
}

// ===== 月次労務リスク (Round 15 TOP 1) =====
function renderMonthlyLaborRisk() {
  // 当月キー (現在週の月を採用)
  const wkStart = state.meta.currentWeekStart || "";
  const monthKey = wkStart.slice(0, 7); // "YYYY-MM"
  if (!monthKey) return null;

  // 全 weeks から当月の確定済 + 下書き両方を集計 (リスク予測のため下書きも含める)
  const allWeeks = state.weeks || {};
  const perStaff = {}; // staffId -> { hours, cost, days: Set }
  for (const wk of Object.values(allWeeks)) {
    for (const a of (wk.assignments || [])) {
      if (!(a.date || "").startsWith(monthKey)) continue;
      const sid = a.staffId;
      if (!perStaff[sid]) perStaff[sid] = { hours: 0, cost: 0, days: new Set() };
      const h = calcHours(a.startTime, a.endTime);
      const s = state.staff.find(x => x.id === sid);
      const breakMin = (s && s.breakMinutes) || 0;
      const eff = (h > 6 && breakMin > 0) ? h - breakMin / 60 : h;
      perStaff[sid].hours += eff;
      perStaff[sid].cost += eff * (s ? s.hourlyWage : 1100);
      perStaff[sid].days.add(a.date);
    }
  }

  // 月の上限: 4.33 週 × maxHoursPerWeek を月上限と仮定 (社会保険の壁を考慮するなら別途)
  const lr = state.meta.laborRules || {};
  const monthLimitDefault = (lr.maxHoursPerWeek || 40) * 4.33;
  const warnThreshold = (state.meta.laborWarnThreshold || 0.7);  // 70%
  const dangerThreshold = (state.meta.laborDangerThreshold || 0.85); // 85%

  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
  const monthLabel = monthKey.replace("-", "年") + "月";
  const totalCost = Object.values(perStaff).reduce((s, r) => s + r.cost, 0);
  const monthBudget = (state.meta.weeklyBudget || 0) * 4.33;
  card.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
    el("div", { class: "font-semibold text-sm" }, `📊 ${monthLabel}の労務状況`),
    el("div", { class: "text-xs text-slate-500" },
      `合計人件費 ${fmtYen(Math.round(totalCost))} / 月予算${fmtYen(Math.round(monthBudget))}`),
  ]));

  // スタッフ一覧（時間が多い順）
  const sorted = state.staff.map(s => {
    const r = perStaff[s.id] || { hours: 0, cost: 0, days: new Set() };
    const personalLimit = s.maxHoursPerWeek ? s.maxHoursPerWeek * 4.33 : monthLimitDefault;
    const ratio = personalLimit > 0 ? r.hours / personalLimit : 0;
    return { staff: s, hours: r.hours, cost: r.cost, daysCount: r.days.size, limit: personalLimit, ratio };
  }).sort((a, b) => b.ratio - a.ratio);

  // 警告サマリ
  const warns = sorted.filter(x => x.ratio >= warnThreshold);
  const dangers = sorted.filter(x => x.ratio >= dangerThreshold);
  if (dangers.length > 0 || warns.length > 0) {
    const summary = el("div", { class: "mb-3 text-xs flex flex-wrap gap-2" });
    if (dangers.length > 0) {
      summary.appendChild(el("span", { class: "bg-red-50 border border-red-200 text-red-800 rounded px-2 py-0.5" },
        `🚨 上限接近 (${Math.round(dangerThreshold*100)}%以上): ${dangers.length}名`));
    }
    if (warns.length > dangers.length) {
      summary.appendChild(el("span", { class: "bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-0.5" },
        `⚠️ 注意 (${Math.round(warnThreshold*100)}%以上): ${warns.length - dangers.length}名`));
    }
    card.appendChild(summary);
  }

  const list = el("div", { class: "space-y-1.5" });
  for (const item of sorted) {
    if (item.hours === 0) continue;
    const pct = Math.min(120, item.ratio * 100);
    const color = item.ratio >= dangerThreshold ? "#dc2626"
                : item.ratio >= warnThreshold ? "#f59e0b"
                : "#10b981";
    const row = el("div", { class: "text-xs" });
    row.innerHTML = `
      <div class="flex items-center justify-between mb-1">
        <span class="font-medium">${escapeHtml(item.staff.name)}
          <span class="text-[10px] text-slate-500 ml-1">(${escapeHtml(posCfg(item.staff.position).label)})</span></span>
        <span class="text-slate-600">${item.hours.toFixed(1)}h / ${item.limit.toFixed(0)}h
          <span class="font-bold" style="color:${color}">(${Math.round(item.ratio*100)}%)</span>
        </span>
      </div>
      <div class="gauge-bar"><div style="width:${Math.min(100,pct)}%;background:${color}"></div></div>
      <div class="text-[10px] text-slate-500 mt-0.5">${item.daysCount} 日 / ${fmtYen(Math.round(item.cost))}</div>
    `;
    list.appendChild(row);
  }
  if (list.children.length === 0) {
    list.appendChild(el("div", { class: "text-xs text-slate-500 text-center py-2" },
      "今月の確定済シフトはまだありません"));
  }
  card.appendChild(list);

  // 設定リンク
  card.appendChild(el("div", { class: "text-[10px] text-slate-400 mt-2 text-right" }, [
    el("button", {
      class: "underline decoration-dotted hover:text-slate-600",
      onclick: () => { setTab("settings"); setTimeout(() => location.hash = "#set-labor", 100); },
    }, "⚙️ 警告閾値を変更"),
  ]));
  return card;
}

// ===== セッションタイムライン可視化 (Round 18 TOP 2) =====
function renderSessionsTimeline(sessions) {
  if (!sessions || sessions.length === 0) return null;
  // 表示範囲: 全 sessions の min start ～ max end
  function _t(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  let minMin = Math.min(...sessions.map(s => _t(s.startTime)));
  let maxMin = Math.max(...sessions.map(s => _t(s.endTime)));
  // 1 時間刻みの目盛
  minMin = Math.floor(minMin / 60) * 60;
  maxMin = Math.ceil(maxMin / 60) * 60;
  const totalMin = maxMin - minMin;
  if (totalMin <= 0) return null;
  const wrap = el("div", { class: "bg-slate-50 border border-slate-200 rounded-md p-3 mt-2" });
  wrap.appendChild(el("div", { class: "text-[10px] text-slate-500 mb-1" }, "🕐 営業時間タイムライン"));

  // 時間軸
  const ruler = el("div", { class: "relative h-6 mb-1 border-b border-slate-300", style: { fontSize: "9px", color: "#64748b" } });
  const hours = Math.floor(totalMin / 60);
  for (let i = 0; i <= hours; i++) {
    const m = minMin + i * 60;
    const pct = (m - minMin) / totalMin * 100;
    const tick = el("div", { style: { position: "absolute", left: pct + "%", top: "0", bottom: "0", borderLeft: "1px solid #cbd5e1", paddingLeft: "2px" } });
    tick.textContent = `${Math.floor(m / 60)}:00`;
    ruler.appendChild(tick);
  }
  wrap.appendChild(ruler);

  // 各セッションをバーとして配置 (重なり対応のため row 動的計算)
  const rows = []; // 各 row は終わりの時刻を保持
  const sorted = sessions.slice().sort((a, b) => _t(a.startTime) - _t(b.startTime));
  const colors = ["#fbbf24", "#fb923c", "#f87171", "#a78bfa", "#60a5fa", "#34d399", "#f472b6", "#94a3b8"];
  const placedRows = sorted.map((s, i) => {
    const sStart = _t(s.startTime);
    const sEnd = _t(s.endTime);
    let row = 0;
    while (rows[row] !== undefined && rows[row] > sStart) row++;
    rows[row] = sEnd;
    return { sess: s, row, color: colors[i % colors.length] };
  });
  const rowCount = rows.length;
  const rowHeight = 22;
  const tlWrap = el("div", { class: "relative", style: { height: (rowCount * rowHeight) + "px" } });
  for (const { sess, row, color } of placedRows) {
    const sStart = _t(sess.startTime);
    const sEnd = _t(sess.endTime);
    const left = (sStart - minMin) / totalMin * 100;
    const width = (sEnd - sStart) / totalMin * 100;
    const bar = el("div", {
      style: {
        position: "absolute", left: left + "%", width: width + "%",
        top: (row * rowHeight) + "px", height: (rowHeight - 4) + "px",
        background: color, color: "white", borderRadius: "4px",
        fontSize: "10px", padding: "2px 6px",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
      },
      title: `${sess.label}: ${sess.startTime}〜${sess.endTime}`,
    });
    bar.textContent = `${sess.icon || ""} ${sess.label} ${sess.startTime.slice(0, 5)}〜${sess.endTime.slice(0, 5)}`;
    tlWrap.appendChild(bar);
  }
  wrap.appendChild(tlWrap);
  // 重なりがあれば警告
  const overlaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      if (_t(a.startTime) < _t(b.endTime) && _t(b.startTime) < _t(a.endTime)) {
        overlaps.push(`${a.label} ⇆ ${b.label}`);
      }
    }
  }
  if (overlaps.length > 0) {
    wrap.appendChild(el("div", { class: "mt-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5" },
      `⚠️ 時間が重複: ${overlaps.slice(0, 3).join(" / ")}${overlaps.length > 3 ? ` 他 ${overlaps.length - 3} 件` : ""}`));
  }
  return wrap;
}

// セッションプリセット選択ダイアログ (Round 18 TOP 2)
function openSessionPresetsDialog() {
  const presets = window.ShiftyData.SESSION_PRESETS || {};
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📋 セッションプリセット選択"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "業態に合わせて、時間帯セットをワンクリックで設定できます。現在のセッション設定は上書きされます (必要人数マトリクスはリセット)。"));
  const list = el("div", { class: "space-y-2 max-h-96 overflow-y-auto" });
  for (const [key, preset] of Object.entries(presets)) {
    const card = el("div", { class: "border border-slate-200 rounded-md p-3 hover:bg-slate-50 cursor-pointer" });
    card.innerHTML = `
      <div class="font-semibold text-sm">${escapeHtml(preset.label)}</div>
      <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(preset.description)}</div>
      <div class="text-[10px] text-slate-600 mt-1">
        ${preset.sessions.map(s => `<span class="inline-block bg-slate-100 rounded px-1.5 py-0.5 mr-1 mb-1">${s.icon || ""} ${escapeHtml(s.label)} ${s.startTime}〜${s.endTime}</span>`).join("")}
      </div>`;
    card.appendChild(el("button", {
      class: "mt-2 text-xs bg-brand-600 hover:bg-brand-700 text-white rounded px-3 py-1 font-semibold",
      onclick: () => applySessionPreset(key, preset),
    }, "このプリセットを適用 →"));
    list.appendChild(card);
  }
  body.appendChild(list);
  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
}

function applySessionPreset(key, preset) {
  if (!confirm(
    `「${preset.label}」を適用しますか？\n\n` +
    `現在のセッション ${state.meta.sessions.length} 個 → ${preset.sessions.length} 個に置き換わり、` +
    `必要人数マトリクスは初期化されます (適用前に自動スナップショットを取得)。`
  )) return;
  // 先にスナップショット
  try { createSnapshot("manual", `セッションプリセット適用前 (${preset.label})`); } catch (_) {}

  state.meta.sessions = JSON.parse(JSON.stringify(preset.sessions));
  // 必要人数マトリクスを規模に応じて適切に再構築
  const newPlan = {};
  for (const sess of preset.sessions) {
    newPlan[sess.id] = {};
    // ピーク時間 (12-14, 18-21) は厚め、他は薄め
    function _t(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
    const sStart = _t(sess.startTime);
    const sEnd = _t(sess.endTime);
    const isLunchPeak  = sStart >= 11*60 && sEnd <= 14*60+30;
    const isDinnerPeak = sStart >= 17*60 && sEnd <= 21*60+30;
    const isPeak = isLunchPeak || isDinnerPeak || sess.id.includes("peak");
    for (let dow = 0; dow < 7; dow++) {
      const isWeekend = dow === 0 || dow === 6;
      newPlan[sess.id][dow] = {};
      for (const pos of state.meta.positions) {
        let count = 1;
        if (isPeak) count = isWeekend ? 2 : 1;
        if (pos.id === "manager") count = 1; // マネージャーは常に 1
        newPlan[sess.id][dow][pos.id] = count;
      }
    }
  }
  state.meta.staffingPlan = newPlan;
  regenerateCurSlots();
  persist();
  closeModal();
  render();
  toast(`✓ プリセット「${preset.label}」を適用 (${preset.sessions.length} セッション)`, "success", 5000);
}

// ===== データ復旧スナップショット (Round 17 TOP 1) =====
const SNAPSHOT_LIMIT = 20;
function createSnapshot(kind = "manual", label = "") {
  if (!state || !state.meta) return null;
  state.meta.snapshots = state.meta.snapshots || [];
  // 浅いコピーで snapshots フィールド自体は除く (再帰防止)
  const { snapshots: _ignore, ...metaWithoutSnaps } = state.meta;
  const id = "snap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const snap = {
    id,
    kind,            // "manual" | "auto_publish" | "auto_autogen" | "daily" | "pre_ai_clear"
    label: (label || kind).slice(0, 80),
    createdAt: new Date().toISOString(),
    payload: {
      meta: JSON.parse(JSON.stringify(metaWithoutSnaps)),
      staff: JSON.parse(JSON.stringify(state.staff || [])),
      weeks: JSON.parse(JSON.stringify(state.weeks || {})),
    },
  };
  state.meta.snapshots.unshift(snap);
  // 古いものを削除 (新しい順で保持)
  if (state.meta.snapshots.length > SNAPSHOT_LIMIT) {
    state.meta.snapshots = state.meta.snapshots.slice(0, SNAPSHOT_LIMIT);
  }
  return snap;
}

function maybeCreateDailySnapshot() {
  // 1 日 1 回 (UTC ベースで判定)
  state.meta.snapshots = state.meta.snapshots || [];
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayDaily = state.meta.snapshots.find(s => s.kind === "daily" && (s.createdAt || "").startsWith(todayKey));
  if (!todayDaily) {
    createSnapshot("daily", `日次 (${todayKey})`);
  }
}

async function restoreSnapshot(snapId) {
  const snaps = (state.meta && state.meta.snapshots) || [];
  const snap = snaps.find(s => s.id === snapId);
  if (!snap) { toast("スナップショットが見つかりません", "error"); return; }
  if (!confirm(
    `スナップショット「${snap.label}」(${new Date(snap.createdAt).toLocaleString("ja-JP")}) を復元しますか？\n\n` +
    `現在の状態は失われます。直前の状態を念のためバックアップ用スナップショットとして残します。`
  )) return;

  // 復元前に現状をスナップショットとして保存
  try { createSnapshot("manual", `復元前バックアップ (${new Date().toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit" })})`); } catch (_) {}

  // 復元実行 — snapshots 自体は保持
  const preservedSnaps = state.meta.snapshots;
  state.meta = JSON.parse(JSON.stringify(snap.payload.meta));
  state.meta.snapshots = preservedSnaps;
  state.staff = JSON.parse(JSON.stringify(snap.payload.staff));
  state.weeks = JSON.parse(JSON.stringify(snap.payload.weeks));
  await persist();
  render();
  toast(`✓ スナップショット「${snap.label}」を復元しました`, "success", 5000);
}

// ===== Change Log =====
function logChange(type, detail, extra = {}) {
  const wk = curWeek();
  if (!Array.isArray(wk.changeLog)) wk.changeLog = [];
  wk.changeLog.push({
    at: new Date().toISOString(),
    type, detail, ...extra,
  });
  // 最新100件のみ保持
  if (wk.changeLog.length > 100) wk.changeLog = wk.changeLog.slice(-100);
  // Round 25 TOP 2: 全体監査ログにも追記
  try {
    if (typeof appendAuditLog === "function") appendAuditLog(type, detail, extra);
  } catch (_) {}
}

// ===== Routing =====
function setTab(tab) {
  currentTab = tab;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

function render() {
  if (!state) return;
  // Round 29: 旧タブ ID を新構造へリダイレクト (後方互換)
  if (currentTab === "preferences") currentTab = "staff";
  if (currentTab === "export") currentTab = "schedule";
  const main = $("#main");
  main.innerHTML = "";
  if (currentTab === "dashboard")   main.appendChild(viewHome());          // Round 29: 旧 dashboard → home
  if (currentTab === "staff")       main.appendChild(viewStaffAndPreferences()); // Round 29: 統合
  if (currentTab === "schedule")    main.appendChild(viewScheduleAndExport()); // Round 29: 統合
  if (currentTab === "settings")    main.appendChild(viewSettings());
  // モバイル用 FAB（シフトタブのみ）
  const oldFab = document.getElementById("mobileFab");
  if (oldFab) oldFab.remove();
  if (currentTab === "schedule" && curStatus() === "draft") {
    const fab = el("button", {
      id: "mobileFab", class: "fab",
      onclick: autoGenerate,
    }, "🤖 AI生成");
    document.body.appendChild(fab);
  }
  // タブのアクティブクラスを反映
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
  renderHeader();
}

function renderHeader() {
  if (!state) return;
  $("#restaurantName").textContent = state.meta.restaurantName + " · " + state.meta.currentWeekStart + " 週";
  // Week nav label
  $("#weekJumpBtn").textContent = state.meta.currentWeekStart.slice(5).replace("-", "/") + "〜";
  // Status badge
  const badge = $("#weekStatusBadge");
  const status = curStatus();
  if (status === "published") {
    badge.className = "ml-1 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800";
    badge.textContent = "✓ 確定済";
  } else {
    badge.className = "ml-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800";
    badge.textContent = "下書き";
  }
}

// ===== View: Dashboard =====
// ===== タスクチェックリスト (Round 34 TOP 1) =====
const TASK_CHECKLIST = {
  daily: [
    { id: "d_check_today", label: "本日の出勤者を確認", tip: "ホームの「☀ 本日の出勤者」カードで打刻状況を確認。未打刻者がいたら声がけ" },
    { id: "d_check_msg", label: "スタッフからのメッセージ確認", tip: "スタッフ&希望タブの下部にメッセージ一覧。緊急休みは赤色強調表示" },
  ],
  weekly: [
    { id: "w_collect_pref", label: "翌週分の希望を集める", tip: "「📨 募集メッセージ生成」で LINE 用テキストをワンクリック作成" },
    { id: "w_generate_ai", label: "AI でシフトを生成", tip: "「🤖 AI 自動生成」を実行。改善ポイントが自動表示されるので確認" },
    { id: "w_publish", label: "シフトを確定 & 通知", tip: "確定モーダルにヘルスチェック表示。問題なければ確定 + 通知メール送信" },
    { id: "w_review_late", label: "遅刻・早退・残業を確認", tip: "ホームの注意事項アラートで月次の異常を検知" },
  ],
  monthly: [
    { id: "m_export_payroll", label: "給与計算 CSV をエクスポート", tip: "シフトタブ末尾「💴 給与計算 CSV」。実労働時間ベースを推奨" },
    { id: "m_review_report", label: "月次レポートを店舗会議で共有", tip: "「📈 月次レポート」を PDF 保存して経営判断資料に活用" },
    { id: "m_input_sales", label: "日次売上を入力 (任意)", tip: "ダッシュボード「💰 人件費率」カード→「📝 売上を入力」。AI 推奨人数の精度が上がる" },
    { id: "m_check_lcr", label: "人件費率の達成度を確認", tip: "目標値 (業界平均 28-32%) に対する乖離を確認。AI 戦略を「コスト」に変えて再生成も" },
  ],
  setup: [
    { id: "s_business_type", label: "業態テンプレを適用", tip: "設定タブ冒頭の「🚀 はじめての方は 2 分で完了」ウィザードを実行" },
    { id: "s_add_staff", label: "スタッフを登録", tip: "1人ずつ追加 / CSV 一括取込 / サンプルで体験 の 3 通り" },
    { id: "s_share_links", label: "スタッフに希望入力リンク共有", tip: "「🔗 全員のリンクをコピー」で LINE グループに一括送信" },
    { id: "s_first_shift", label: "初回シフトを生成", tip: "希望が集まったら「🤖 AI 自動生成」 → 確認 → 確定" },
  ],
};

function renderTaskChecklist() {
  const completed = state.meta.taskChecklist || {};
  const isSetupComplete = (TASK_CHECKLIST.setup || []).every(t => completed[t.id]);

  // セットアップ未完なら最優先表示、完了したら毎週/毎月を表示
  const sections = isSetupComplete
    ? [
        { key: "weekly", label: "📅 毎週のルーチン", items: TASK_CHECKLIST.weekly },
        { key: "monthly", label: "📊 毎月のルーチン", items: TASK_CHECKLIST.monthly },
      ]
    : [
        { key: "setup", label: "🚀 初日のセットアップ", items: TASK_CHECKLIST.setup },
      ];

  // 進捗計算
  let totalTasks = 0, completedTasks = 0;
  for (const sec of sections) {
    for (const t of sec.items) {
      totalTasks++;
      if (completed[t.id]) completedTasks++;
    }
  }
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const card = el("div", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3" });
  card.appendChild(el("details", { open: pct < 100 ? "" : null }, [
    el("summary", { class: "cursor-pointer flex items-center justify-between gap-2" }, [
      el("div", { class: "flex items-center gap-2" }, [
        el("span", { class: "font-semibold text-sm" }, "📋 やることリスト"),
        el("span", { class: "text-xs text-slate-500" }, `${completedTasks}/${totalTasks} 完了`),
      ]),
      el("div", { class: "flex items-center gap-2 flex-1 max-w-32" }, [
        el("div", { class: "flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded" }, [
          el("div", { class: "h-full rounded bg-emerald-500", style: { width: pct + "%" } }),
        ]),
        el("span", { class: "text-xs font-bold text-emerald-700 w-8 text-right" }, pct + "%"),
      ]),
    ]),
    (() => {
      const wrap = el("div", { class: "mt-3 space-y-3" });
      for (const sec of sections) {
        const secEl = el("div", {});
        secEl.appendChild(el("div", { class: "text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1" }, sec.label));
        for (const t of sec.items) {
          const isDone = !!completed[t.id];
          const row = el("label", { class: `flex items-start gap-2 p-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer ${isDone ? "opacity-60" : ""}` });
          const cb = el("input", { type: "checkbox" });
          if (isDone) cb.checked = true;
          cb.onchange = () => {
            if (cb.checked) {
              state.meta.taskChecklist[t.id] = { completedAt: new Date().toISOString() };
            } else {
              delete state.meta.taskChecklist[t.id];
            }
            persist();
            // 即座に再描画 (進捗バー更新)
            render();
          };
          row.appendChild(cb);
          row.appendChild(el("div", { class: "flex-1" }, [
            el("div", { class: `text-sm ${isDone ? "line-through text-slate-500" : ""}` }, t.label),
            el("div", { class: "text-[10px] text-slate-500 dark:text-slate-400" }, "💡 " + t.tip),
          ]));
          secEl.appendChild(row);
        }
        wrap.appendChild(secEl);
      }
      // セットアップ完了時の祝福
      if (isSetupComplete && completedTasks === totalTasks) {
        wrap.appendChild(el("div", { class: "bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-300 dark:border-emerald-700 rounded p-3 text-sm text-emerald-800 dark:text-emerald-300" },
          "🎉 今週のルーチン完了です！来週もこのペースを維持しましょう。"));
      }
      return wrap;
    })(),
  ]));
  return card;
}

// ===== プラン表示 + アップグレード動線 (Round 34 TOP 2) =====
async function fetchAndRenderPlanInfo() {
  // tenant API から plan 情報取得 (簡易: localStorage キャッシュ)
  if (!window.ShiftyAPI || !window.ShiftyAPI.tenantSlug) return;
  // 既存の owner tenants から自分の plan を判定
  if (_ownerTenants && _ownerTenants.length > 0) {
    const cur = _ownerTenants.find(t => t.slug === window.ShiftyAPI.tenantSlug);
    if (cur) {
      window._currentPlan = cur.plan || "free";
    }
  }
}

function renderPlanCard() {
  const plan = window._currentPlan || "free";
  const activeStaff = state.staff.filter(s => !s.archived).length;
  const FREE_LIMIT = 8;
  const isAtLimit = plan === "free" && activeStaff >= FREE_LIMIT;
  const isNearLimit = plan === "free" && activeStaff >= FREE_LIMIT - 1 && activeStaff < FREE_LIMIT;

  const card = el("div", {
    class: `${plan === "free" ? "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700" : "bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-900/30 dark:to-blue-900/30 border border-emerald-300 dark:border-emerald-700"} rounded-xl p-4`,
  });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
    el("div", { class: "flex items-center gap-2" }, [
      el("span", { class: "text-xl" }, plan === "free" ? "🆓" : "💎"),
      el("div", {}, [
        el("div", { class: "font-semibold text-sm" }, plan === "free" ? "Free プラン" : "Pro プラン"),
        el("div", { class: "text-xs text-slate-500" }, plan === "free" ? "8 名まで永久無料" : "無制限・全機能利用可"),
      ]),
    ]),
    plan === "free" ? el("button", {
      class: "text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded px-3 py-1.5 font-bold",
      onclick: () => openUpgradeDialog(),
    }, "💎 Pro へアップグレード") : el("span", { class: "text-xs text-emerald-700 dark:text-emerald-400 font-semibold" }, "✓ 全機能利用可"),
  ]));

  // スタッフ数バー
  card.appendChild(el("div", { class: "text-xs text-slate-600 dark:text-slate-400 mb-1" },
    `スタッフ数: ${activeStaff}${plan === "free" ? ` / ${FREE_LIMIT}` : " (無制限)"}`));
  if (plan === "free") {
    const ratio = Math.min(1, activeStaff / FREE_LIMIT);
    const color = isAtLimit ? "#dc2626" : isNearLimit ? "#f59e0b" : "#10b981";
    card.appendChild(el("div", { class: "gauge-bar" }, [
      el("div", { style: { width: (ratio * 100) + "%", background: color } }),
    ]));
    if (isAtLimit) {
      card.appendChild(el("div", { class: "mt-2 text-xs text-red-700 bg-red-50 dark:bg-red-900/30 rounded p-2" },
        "⚠️ Free プランの上限です。アクティブスタッフを 8 名以下に減らすか、Pro へアップグレードしてください。"));
    } else if (isNearLimit) {
      card.appendChild(el("div", { class: "mt-2 text-xs text-amber-700 bg-amber-50 dark:bg-amber-900/30 rounded p-2" },
        `⚠️ あと ${FREE_LIMIT - activeStaff} 名で Free プラン上限。Pro なら無制限です。`));
    }
  }
  return card;
}

function openUpgradeDialog() {
  const body = el("div", { class: "p-6 space-y-4" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💎 Pro プランへアップグレード"));
  body.appendChild(el("p", { class: "text-sm text-slate-600 dark:text-slate-400" },
    "Pro プランでは以下の制限が解除されます:"));
  body.appendChild(el("ul", { class: "space-y-1.5 text-sm" }, [
    el("li", {}, "✅ スタッフ数 無制限 (Free は 8 名まで)"),
    el("li", {}, "✅ 多店舗対応 (1 オーナー × 5 店舗まで)"),
    el("li", {}, "✅ サーバ側自動バックアップ (30 日分)"),
    el("li", {}, "✅ 優先サポート (平日 9-18 時)"),
    el("li", {}, "✅ 全 AI 機能 (モデルシフト・自動代打 等)"),
  ]));
  body.appendChild(el("div", { class: "bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-300 rounded-lg p-3 text-center" }, [
    el("div", { class: "text-2xl font-bold" }, "¥1,980 / 月"),
    el("div", { class: "text-xs text-slate-600 dark:text-slate-400" }, "1 店舗あたり / 14 日無料トライアル"),
  ]));
  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "あとで"),
    el("a", {
      href: "https://shifty.in-dx.jp/#contact", target: "_blank",
      class: "px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-bold",
    }, "📞 アップグレード相談"),
  ]));
  modal(body);
}

// Round 28 TOP 1: ダッシュボード ウィジェット ON/OFF 判定
function dashboardWidgetOn(widgetId) {
  if (!state || !state.meta || !state.meta.dashboardWidgets) return true;
  const v = state.meta.dashboardWidgets[widgetId];
  return v !== false; // 未定義は ON 扱い
}

// ========================================================================
// Round 29: タブ統合 + 「次にやること」中心ホーム
// ========================================================================

// 状態に応じて「次にやること」を返す
function getNextAction() {
  // 1. スタッフ未登録
  if (state.staff.length === 0 || (state.staff.length === 1 && state.staff[0].name === "")) {
    return {
      icon: "👥",
      title: "まずスタッフを登録しましょう",
      desc: "シフトを作るには、働くスタッフの情報が必要です。",
      buttons: [
        { label: "🎯 サンプル 10 名で試す", onclick: async () => {
          if (!confirm("サンプル 10 名 + 希望サンプルを投入しますか？")) return;
          state = await resetState({ withSample: true });
          render();
          toast("✓ サンプル投入完了。シフト生成を試してみてください", "success", 5000);
        }, primary: true },
        { label: "+ スタッフを追加", onclick: () => { setTab("staff"); setTimeout(() => openStaffEdit(), 200); } },
      ],
    };
  }

  // 2. 希望未収集
  const submittedN = state.staff.filter(s => !s.archived && curPrefs().some(p => p.staffId === s.id)).length;
  const activeStaffN = state.staff.filter(s => !s.archived).length;
  if (submittedN === 0 && curStatus() === "draft" && curAssignments().length === 0) {
    return {
      icon: "📝",
      title: "スタッフから希望を集めましょう",
      desc: "各スタッフに専用 URL を共有してスマホから希望時間を入力してもらいます。",
      buttons: [
        { label: "💬 募集メッセージ生成", onclick: () => { setTab("staff"); setTimeout(openRecruitDialog, 200); }, primary: true },
        { label: "🔗 全員のリンクをコピー", onclick: copyAllStaffLinks },
      ],
    };
  }

  // 3. 希望はあるが AI 生成未実行
  if (curAssignments().length === 0 && curStatus() === "draft") {
    return {
      icon: "🤖",
      title: "AI でシフトを自動生成しましょう",
      desc: `${submittedN}/${activeStaffN} 名分の希望が集まっています。AI が最適配置を 5 秒で計算します。`,
      buttons: [
        { label: "🤖 AI 自動生成", onclick: () => { setTab("schedule"); setTimeout(autoGenerate, 200); }, primary: true },
        { label: "📅 手動で組む", onclick: () => setTab("schedule") },
      ],
    };
  }

  // 4. 生成済みだが未確定
  if (curAssignments().length > 0 && curStatus() === "draft") {
    return {
      icon: "✓",
      title: "シフトを確認して確定しましょう",
      desc: "内容を確認して問題なければ確定。スタッフへ自動通知できます。",
      buttons: [
        { label: "📅 シフト編成を確認", onclick: () => setTab("schedule"), primary: true },
        { label: "✓ そのまま確定", onclick: () => { setTab("schedule"); setTimeout(publishWeek, 200); } },
      ],
    };
  }

  // 5. 確定済 → 来週準備
  if (curStatus() === "published") {
    return {
      icon: "🎉",
      title: "今週は確定済みです。来週の準備を始めましょう",
      desc: "週ナビゲーションで来週へ移動して、新しい希望収集を始めると効率的です。",
      buttons: [
        { label: "▶ 来週へ", onclick: () => { document.getElementById("nextWeekBtn")?.click(); } },
        { label: "📊 今週のレポート", onclick: () => { setTab("schedule"); setTimeout(() => openWeeklyReport(), 200); } },
        { label: "💴 給与計算 CSV", onclick: () => { setTab("schedule"); setTimeout(() => openPayrollCsvDialog(), 200); } },
      ],
    };
  }

  return null;
}

function viewHome() {
  const wrap = el("div", { class: "space-y-6" });

  // ヘッダー (簡潔化)
  wrap.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, "🏠 ホーム"),
    el("div", { class: "flex items-center gap-2" }, [
      el("div", { class: "text-sm text-slate-500" }, state.meta.currentWeekStart + " 〜"),
      el("button", {
        class: "text-xs text-slate-500 hover:text-slate-700 underline decoration-dotted",
        onclick: () => openDashboardCustomizeDialog(),
      }, "⚙️ 表示項目"),
    ]),
  ]));

  // 初回オーナー: ヒーロー
  if (state.staff.length === 0 && !window.__SHIFTY_DEMO_MODE__) {
    const hero = el("div", { class: "bg-gradient-to-br from-brand-50 to-amber-50 border border-brand-200 rounded-xl p-6 text-center space-y-4" });
    hero.appendChild(el("div", { class: "text-4xl" }, "👋"));
    hero.appendChild(el("h3", { class: "font-bold text-lg" }, "Shifty へようこそ"));
    hero.appendChild(el("p", { class: "text-sm text-slate-600 max-w-md mx-auto" },
      "3 ステップで初回シフトが完成します。"));
    const steps = el("div", { class: "grid grid-cols-1 md:grid-cols-3 gap-2 max-w-2xl mx-auto" });
    [
      { num: "1", title: "スタッフ登録", desc: "👥 サンプル or 手動で 10 名くらい" },
      { num: "2", title: "希望収集", desc: "📝 スタッフが自分のスマホから入力" },
      { num: "3", title: "AI でシフト生成", desc: "🤖 5 秒で最適化" },
    ].forEach(s => {
      steps.appendChild(el("div", { class: "bg-white border border-slate-200 rounded-md p-3 text-left" }, [
        el("div", { class: "text-2xl font-bold text-brand-600" }, s.num),
        el("div", { class: "font-semibold text-sm" }, s.title),
        el("div", { class: "text-xs text-slate-500 mt-1" }, s.desc),
      ]));
    });
    hero.appendChild(steps);
    hero.appendChild(el("div", { class: "flex flex-col sm:flex-row gap-2 justify-center pt-2" }, [
      el("button", {
        class: "bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-5 py-2.5 text-sm font-semibold",
        onclick: async () => {
          if (!confirm("サンプルデータ（10名スタッフ・希望サンプル付き）を投入しますか？")) return;
          state = await resetState({ withSample: true });
          render();
          toast("✓ サンプル投入完了。「シフト」タブで AI 生成を試してみてください", "success", 6000);
        }
      }, "🎯 サンプルで体験"),
      el("button", {
        class: "bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-5 py-2.5 text-sm font-semibold",
        onclick: () => { setTab("staff"); setTimeout(() => openStaffEdit(), 200); }
      }, "👥 スタッフを追加 →"),
    ]));
    wrap.appendChild(hero);
    return wrap;
  }

  // Round 30: 進捗バー (4 ステップ: スタッフ→希望→生成→確定)
  if (state.staff.length > 0) {
    const submittedN = state.staff.filter(s => !s.archived && curPrefs().some(p => p.staffId === s.id)).length;
    const activeN = state.staff.filter(s => !s.archived).length;
    const steps = [
      { id: 1, label: "スタッフ", done: state.staff.length > 0, hint: `${activeN} 名` },
      { id: 2, label: "希望収集", done: submittedN > 0, hint: `${submittedN}/${activeN} 提出` },
      { id: 3, label: "AI 生成", done: curAssignments().length > 0, hint: `${curAssignments().length} 件` },
      { id: 4, label: "確定", done: curStatus() === "published", hint: curStatus() === "published" ? "✓" : "未" },
    ];
    const progressCard = el("div", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3" });
    progressCard.appendChild(el("div", { class: "text-xs font-semibold text-slate-500 mb-2" }, "📍 今週の進捗"));
    const stepsRow = el("div", { class: "flex items-center justify-between" });
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const cls = s.done ? "bg-emerald-500 text-white"
                : (i === 0 || steps[i - 1].done) ? "bg-brand-600 text-white"
                : "bg-slate-200 dark:bg-slate-600 text-slate-500";
      stepsRow.appendChild(el("div", { class: "flex flex-col items-center flex-1" }, [
        el("div", { class: `w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${cls}` }, s.done ? "✓" : String(s.id)),
        el("div", { class: "text-[11px] mt-1 text-slate-700 dark:text-slate-300 text-center" }, s.label),
        el("div", { class: "text-[10px] text-slate-500" }, s.hint),
      ]));
      if (i < steps.length - 1) {
        const lineColor = steps[i].done ? "bg-emerald-500" : "bg-slate-200 dark:bg-slate-600";
        stepsRow.appendChild(el("div", { class: `flex-grow h-1 mx-1 ${lineColor}`, style: { marginTop: "-22px", flex: "0.5" } }));
      }
    }
    progressCard.appendChild(stepsRow);
    wrap.appendChild(progressCard);
  }

  // Round 34 TOP 1: タスクチェックリスト
  if (state.staff.length > 0) {
    const checklistCard = renderTaskChecklist();
    if (checklistCard) wrap.appendChild(checklistCard);
  }

  // Round 34 TOP 2: プラン情報カード (Pro 表示や上限警告)
  if (window.ShiftyAPI && window.ShiftyAPI.tenantSlug) {
    const planCard = renderPlanCard();
    if (planCard) wrap.appendChild(planCard);
  }

  // 「次にやること」カード
  const next = getNextAction();
  if (next) {
    const naCard = el("div", { class: "bg-gradient-to-br from-blue-500 to-brand-700 rounded-xl p-4 text-white shadow-lg" });
    naCard.appendChild(el("div", { class: "flex items-start gap-3" }, [
      el("div", { class: "text-3xl" }, next.icon),
      el("div", { class: "flex-1" }, [
        el("div", { class: "text-xs opacity-90 uppercase tracking-wider" }, "次にやること"),
        el("h3", { class: "font-bold text-lg mt-0.5" }, next.title),
        el("p", { class: "text-sm opacity-90 mt-1" }, next.desc),
        (() => {
          const btnRow = el("div", { class: "flex gap-2 flex-wrap mt-3" });
          for (const b of next.buttons) {
            btnRow.appendChild(el("button", {
              class: b.primary
                ? "bg-white text-brand-700 hover:bg-slate-100 rounded px-4 py-2 text-sm font-bold"
                : "bg-white/20 hover:bg-white/30 text-white rounded px-3 py-2 text-sm",
              onclick: b.onclick,
            }, b.label));
          }
          return btnRow;
        })(),
      ]),
    ]));
    wrap.appendChild(naCard);
  }

  // 多店舗対応: 集計ダッシュボード ボタン
  if (_ownerTenants && _ownerTenants.length >= 2) {
    wrap.appendChild(el("button", {
      class: "w-full bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 rounded-xl p-3 text-left hover:bg-purple-100",
      onclick: openCrossStoreDashboard,
    }, [
      el("div", { class: "flex items-center justify-between" }, [
        el("div", {}, [
          el("div", { class: "font-semibold text-purple-900 dark:text-purple-300" }, `🏪 全 ${_ownerTenants.length} 店舗を管理中`),
          el("div", { class: "text-xs text-purple-700 dark:text-purple-400 mt-0.5" }, "全店舗集計ダッシュボードを開く →"),
        ]),
        el("span", { class: "text-2xl" }, "📊"),
      ]),
    ]));
  }

  // 主要 KPI (3 つに絞る)
  if (state.staff.length > 0) {
    const assignments = curAssignments();
    const metrics = assignments.length
      ? calcMetrics(
          { hours: aggregateHours(), byStaff: aggregateByStaff(), assignments, unfilled: [] },
          { staff: state.staff, slots: curSlots(), preferences: curPrefs() })
      : null;
    const submittedN = state.staff.filter(s => !s.archived && curPrefs().some(p => p.staffId === s.id)).length;
    const activeN = state.staff.filter(s => !s.archived).length;
    const kpis = el("div", { class: "grid grid-cols-2 md:grid-cols-4 gap-3" });
    kpis.appendChild(kpiCard("スタッフ", activeN + "名", "👥"));
    kpis.appendChild(kpiCard("希望提出", `${submittedN}/${activeN}`, "📝",
      submittedN === activeN ? "ok" : submittedN >= activeN * 0.7 ? "" : "warn"));
    if (metrics) {
      kpis.appendChild(kpiCard("カバー率", fmtPct(metrics.coverageRate), "✅", metrics.coverageRate < 1 ? "warn" : "ok"));
      kpis.appendChild(kpiCard("人件費", fmtYen(metrics.totalCost), "💴", metrics.totalCost > state.meta.weeklyBudget ? "warn" : "ok"));
    } else {
      kpis.appendChild(kpiCard("シフト枠", curSlots().reduce((s, x) => s + x.requiredCount, 0) + "枠", "🪑"));
      kpis.appendChild(kpiCard("人件費", "—", "💴"));
    }
    wrap.appendChild(kpis);
  }

  // 詳細指標 (折りたたみ式)
  const details = el("details", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3" });
  details.appendChild(el("summary", { class: "cursor-pointer font-semibold text-sm" }, "📊 詳細な指標を表示"));
  const detailsBody = el("div", { class: "mt-3 space-y-3" });
  details.appendChild(detailsBody);

  if (state.staff.length > 0 && dashboardWidgetOn("laborCostRatio")) {
    const c = renderLaborCostRatio(); if (c) detailsBody.appendChild(c);
  }
  if (state.staff.length > 0 && dashboardWidgetOn("monthlyLaborRisk")) {
    const c = renderMonthlyLaborRisk(); if (c) detailsBody.appendChild(c);
  }
  if (state.staff.length > 0 && dashboardWidgetOn("staffInsights")) {
    const c = renderStaffInsights(); if (c) detailsBody.appendChild(c);
  }
  if (detailsBody.children.length > 0) wrap.appendChild(details);

  // Round 31 TOP 2: 今週のシフト要約 (確定済みシフトがあれば表示)
  if (curAssignments().length > 0) {
    const summaryCard = renderWeeklyShiftSummary();
    if (summaryCard) wrap.appendChild(summaryCard);
  }

  // 本日の出勤者 (重要なので折りたたみではなく表示)
  if (dashboardWidgetOn("todayAttendance")) {
    renderTodayAttendance(wrap);
  }

  // 警告 (alerts)
  if (dashboardWidgetOn("alerts")) {
    renderAlerts(wrap);
  }

  return wrap;
}

// 既存の viewDashboard を viewHome に名前変更したので、本来の処理を抽出
// Round 31 TOP 2: 今週のシフト要約
function renderWeeklyShiftSummary() {
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const ass = curAssignments();
  if (ass.length === 0) return null;

  const card = el("div", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 cursor-pointer hover:border-brand-400 transition" });
  card.onclick = () => setTab("schedule");
  card.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
    el("div", { class: "font-semibold text-sm" }, `📅 今週のシフト概要 (${curStatus() === "published" ? "✓ 確定済" : "📝 下書き"})`),
    el("div", { class: "text-xs text-brand-600 hover:underline" }, "詳細 →"),
  ]));

  // 日別の出勤者数バー
  const grid = el("div", { class: "grid grid-cols-7 gap-1" });
  for (const d of days) {
    const dayAss = ass.filter(a => a.date === d);
    const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
    const dowColor = dayOfWeek(d) === 0 ? "text-red-600" : dayOfWeek(d) === 6 ? "text-blue-600" : "text-slate-600";
    const intensity = dayAss.length;
    const barHeight = Math.min(40, intensity * 4 + 8);
    const cell = el("div", { class: "flex flex-col items-center text-[10px]" }, [
      el("div", { class: "w-full bg-slate-100 dark:bg-slate-700 rounded h-12 flex items-end overflow-hidden" }, [
        el("div", {
          class: "w-full bg-gradient-to-t from-brand-500 to-brand-300",
          style: { height: `${barHeight}px` },
        }),
      ]),
      el("div", { class: `mt-1 ${dowColor}` }, `${d.slice(8)} (${dow})`),
      el("div", { class: "font-bold" }, `${intensity}名`),
    ]);
    grid.appendChild(cell);
  }
  card.appendChild(grid);

  // 主要メトリクス
  const totalH = ass.reduce((s, a) => s + calcHours(a.startTime, a.endTime), 0);
  const totalCost = ass.reduce((s, a) => s + (a.cost || 0), 0);
  card.appendChild(el("div", { class: "grid grid-cols-3 gap-2 mt-3 text-xs" }, [
    el("div", { class: "bg-slate-50 dark:bg-slate-700 rounded p-1.5 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "シフト数"),
      el("div", { class: "font-bold" }, `${ass.length} 件`),
    ]),
    el("div", { class: "bg-slate-50 dark:bg-slate-700 rounded p-1.5 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "合計時間"),
      el("div", { class: "font-bold" }, `${totalH.toFixed(0)}h`),
    ]),
    el("div", { class: "bg-slate-50 dark:bg-slate-700 rounded p-1.5 text-center" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "人件費"),
      el("div", { class: "font-bold" }, fmtYen(Math.round(totalCost))),
    ]),
  ]));

  return card;
}

function renderTodayAttendance(wrap) {
  const todayStr = new Date().toISOString().slice(0,10);
  let todayAssignments = curAssignments().filter(a => a.date === todayStr);
  if (todayAssignments.length === 0 && state.weeks) {
    for (const wk of Object.values(state.weeks)) {
      const found = (wk.assignments || []).filter(a => a.date === todayStr);
      if (found.length) { todayAssignments = found; break; }
    }
  }
  if (todayAssignments.length === 0) return;
  const todayCard = el("div", { class: "bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/30 border border-amber-300 dark:border-amber-700 rounded-xl p-3" });
  const dow = ["日","月","火","水","木","金","土"][new Date(todayStr + "T00:00:00").getDay()];
  const totalShifts = todayAssignments.length;
  const clockedIn = todayAssignments.filter(a => a.clockIn).length;
  const clockedOut = todayAssignments.filter(a => a.clockOut).length;
  const lateUnclock = todayAssignments.filter(a => !a.clockIn && (Date.now() - new Date(`${a.date}T${a.startTime}:00`)) / 60000 > 5).length;
  let summaryBadge = `<span class="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">${totalShifts} シフト</span>`;
  if (lateUnclock > 0) summaryBadge += `<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded ml-1">⚠️ 未打刻 ${lateUnclock}</span>`;
  if (clockedIn - clockedOut > 0) summaryBadge += `<span class="text-xs bg-emerald-100 text-emerald-800 px-2 py-1 rounded ml-1">勤務中 ${clockedIn - clockedOut}</span>`;
  if (clockedOut > 0) summaryBadge += `<span class="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded ml-1">退勤済 ${clockedOut}</span>`;
  todayCard.appendChild(el("div", { class: "flex items-center justify-between mb-2 flex-wrap gap-1" }, [
    el("div", { class: "font-semibold text-sm text-amber-900 dark:text-amber-200" }, `☀ 本日の出勤者 (${todayStr.slice(5)} ${dow}曜)`),
    el("div", { class: "flex flex-wrap gap-1", html: summaryBadge }),
  ]));
  const sortedAss = todayAssignments.slice().sort((a,b) => a.startTime.localeCompare(b.startTime));
  const list = el("div", { class: "space-y-1 text-xs" });
  for (const a of sortedAss.slice(0, 8)) {
    const s = state.staff.find(x => x.id === a.staffId);
    if (!s) continue;
    const cfg = posCfg(a.position);
    const hasIn = !!a.clockIn;
    const status = hasIn ? (a.clockOut ? "✓ 退勤" : "▶ 勤務中") : "未打刻";
    list.appendChild(el("div", { class: "flex items-center justify-between bg-white/60 dark:bg-slate-800/40 rounded px-2 py-1" }, [
      el("span", {}, [
        el("span", { style: { color: cfg.color } }, "● "),
        el("strong", {}, s.name),
        el("span", { class: "text-slate-500 ml-1" }, ` (${cfg.label})`),
      ]),
      el("span", { class: "text-[11px] text-slate-600" }, `${a.startTime}〜${a.endTime} · ${status}`),
    ]));
  }
  todayCard.appendChild(list);
  wrap.appendChild(todayCard);
}

function renderAlerts(wrap) {
  // 必要な alerts を viewDashboard から抽出
  const alerts = [];
  const notSub = state.staff.filter(s => !s.archived && !curPrefs().some(p => p.staffId === s.id));
  if (notSub.length > 0 && curStatus() === "draft") {
    alerts.push({ level: "warn", emoji: "📝", text: `希望未提出 ${notSub.length} 名`, detail: notSub.slice(0, 3).map(s => s.name).join("・") });
  }
  if (state.staff.length === 0) return;
  if (alerts.length === 0) return;
  const card = el("div", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3" });
  card.appendChild(el("div", { class: "font-semibold text-sm text-slate-700 dark:text-slate-300 mb-2" }, `⚠️ 注意事項 ${alerts.length} 件`));
  const list = el("div", { class: "space-y-1.5" });
  for (const a of alerts) {
    list.appendChild(el("div", { class: `bg-amber-50 border border-amber-200 rounded p-2 text-xs flex items-start gap-2` }, [
      el("span", {}, a.emoji),
      el("div", { class: "flex-1" }, [
        el("div", { class: "font-semibold" }, a.text),
        el("div", { class: "text-slate-600" }, a.detail),
      ]),
    ]));
  }
  card.appendChild(list);
  wrap.appendChild(card);
}

// ===== スタッフ&希望 統合タブ (Round 29) =====
function viewStaffAndPreferences() {
  const wrap = el("div", { class: "space-y-4" });

  // 既存の viewStaff の内容を継承
  const staffContent = viewStaff();
  wrap.appendChild(staffContent);

  // セパレータ
  if (state.staff.length > 0) {
    wrap.appendChild(el("div", { class: "pt-4 mt-4 border-t-2 border-slate-200 dark:border-slate-700" }));

    // 希望収集セクション (元 viewPreferences の内容)
    const prefSection = viewPreferences();
    wrap.appendChild(prefSection);
  }

  return wrap;
}

// ===== シフト 統合タブ (Round 29) =====
function viewScheduleAndExport() {
  const wrap = el("div", { class: "space-y-4" });

  // シフト編成本体
  const scheduleContent = viewSchedule();
  wrap.appendChild(scheduleContent);

  // 確定済かつ assignments があれば、エクスポート機能をボトムに表示
  if (curAssignments().length > 0) {
    wrap.appendChild(el("div", { class: "pt-4 mt-4 border-t-2 border-slate-200 dark:border-slate-700" }));
    const exportContent = viewExport();
    wrap.appendChild(exportContent);
  }

  return wrap;
}

function viewDashboard() {
  const wrap = el("div", { class: "space-y-6" });
  wrap.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, "今週の概要"),
    el("div", { class: "flex items-center gap-2" }, [
      el("div", { class: "text-sm text-slate-500" }, state.meta.currentWeekStart + " 〜"),
      el("button", {
        class: "text-xs text-slate-500 hover:text-slate-700 underline decoration-dotted",
        onclick: () => openDashboardCustomizeDialog(),
        title: "ダッシュボードに表示する項目を選択",
      }, "⚙️ カスタマイズ"),
    ]),
  ]));

  // 初回オーナー向け: 完全に空の状態のみ表示するヒーロー empty state
  if (state.staff.length === 0 && !window.__SHIFTY_DEMO_MODE__) {
    const hero = el("div", { class: "bg-gradient-to-br from-brand-50 to-amber-50 border border-brand-200 rounded-xl p-6 text-center space-y-4" });
    hero.appendChild(el("div", { class: "text-4xl" }, "👋"));
    hero.appendChild(el("h3", { class: "font-bold text-lg" }, "Shifty へようこそ"));
    hero.appendChild(el("p", { class: "text-sm text-slate-600 max-w-md mx-auto" },
      "まずスタッフを登録するか、サンプルデータで動作を体験してください。"));
    hero.appendChild(el("div", { class: "flex flex-col sm:flex-row gap-2 justify-center pt-2" }, [
      el("button", {
        class: "bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-5 py-2.5 text-sm font-semibold",
        onclick: async () => {
          if (!confirm("サンプルデータ（10名スタッフ・希望サンプル付き）を投入しますか？")) return;
          state = await resetState({ withSample: true });
          render();
          toast("サンプルデータを投入しました。「シフト編成」タブで AI 自動生成を試せます", "success");
        }
      }, "🎯 サンプルデータで試す（10名）"),
      el("button", {
        class: "bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-5 py-2.5 text-sm font-semibold",
        onclick: () => { setTab("staff"); setTimeout(() => openStaffEdit(), 200); }
      }, "👥 スタッフを追加 →"),
      el("button", {
        class: "bg-white border border-slate-300 hover:bg-slate-50 rounded-lg px-5 py-2.5 text-sm font-semibold",
        onclick: () => { setTab("staff"); setTimeout(() => importCsvDialog(), 200); }
      }, "📥 CSV 取込"),
    ]));
    wrap.appendChild(hero);
    return wrap;
  }

  const assignments = curAssignments();
  const metrics = assignments.length
    ? calcMetrics(
        { hours: aggregateHours(), byStaff: aggregateByStaff(), assignments, unfilled: [] },
        { staff: state.staff, slots: curSlots(), preferences: curPrefs() })
    : null;

  // ダッシュボード警告サマリ (Round 5) — 注意点を一覧化
  const alerts = [];
  // 1. 希望未提出
  const notSub = state.staff.filter(s => !curPrefs().some(p => p.staffId === s.id));
  if (notSub.length > 0 && curStatus() === "draft") {
    alerts.push({
      level: "warn", emoji: "📝", text: `希望未提出 ${notSub.length} 名`,
      detail: notSub.slice(0, 3).map(s => s.name).join("・") + (notSub.length > 3 ? ` 他${notSub.length - 3}名` : ""),
      action: () => { setTab("preferences"); }, actionLabel: "希望収集タブへ",
    });
  }
  // 2. 不足ポジション
  if (assignments.length > 0) {
    const unfilledN = curSlots().reduce((sum, sl) => {
      const filled = assignments.filter(a => a.date === sl.date && a.position === sl.position && a.startTime === sl.startTime).length;
      return sum + Math.max(0, sl.requiredCount - filled);
    }, 0);
    if (unfilledN > 0) {
      alerts.push({
        level: "error", emoji: "⚠️", text: `${unfilledN} 枠が不足`,
        detail: "AI 自動生成で埋まらなかった枠があります",
        action: () => { setTab("schedule"); }, actionLabel: "シフト編成へ",
      });
    }
  }
  // 3. 予算超過
  if (metrics && metrics.totalCost > state.meta.weeklyBudget) {
    const over = metrics.totalCost - state.meta.weeklyBudget;
    alerts.push({
      level: "warn", emoji: "💸", text: `予算超過 ${fmtYen(over)}`,
      detail: `予算 ${fmtYen(state.meta.weeklyBudget)} → 実績 ${fmtYen(metrics.totalCost)}`,
      action: () => { setTab("schedule"); }, actionLabel: "シフト編成へ",
    });
  }
  // 4. 労務違反
  const lr = state.meta.laborRules || {};
  const overLimit = state.staff.filter(s => {
    const h = aggregateHours()[s.id] || 0;
    return h > Math.min(s.maxHoursPerWeek || Infinity, lr.maxHoursPerWeek || Infinity);
  });
  if (overLimit.length > 0) {
    alerts.push({
      level: "error", emoji: "⚖️", text: `労務上限超過 ${overLimit.length} 名`,
      detail: overLimit.slice(0, 2).map(s => s.name).join("・"),
      action: () => { setTab("schedule"); }, actionLabel: "確認",
    });
  }
  // 5. メール未登録 (確定時に通知できないリスク)
  if (state.staff.length > 0 && curStatus() === "draft") {
    const noEmail = state.staff.filter(s => !(s.email || "").trim()).length;
    if (noEmail > 0) {
      alerts.push({
        level: "info", emoji: "📧", text: `メール未登録 ${noEmail} 名`,
        detail: "確定通知は LINE 通知文をご利用ください",
        action: () => { setTab("staff"); }, actionLabel: "スタッフ編集",
      });
    }
  }

  // 6. 打刻未登録アラート (Round 19) — 開始予定時刻を 10 分以上過ぎても未打刻
  const todayStrA = new Date().toISOString().slice(0, 10);
  const allUnclock = [];
  for (const wk of Object.values(state.weeks || {})) {
    if (wk.status !== "published") continue;
    for (const a of (wk.assignments || [])) {
      if (a.date !== todayStrA) continue;
      if (a.clockIn) continue;
      const start = new Date(`${a.date}T${a.startTime}:00`);
      const minLate = (Date.now() - start) / 60000;
      if (minLate > 10) allUnclock.push({ a, minLate });
    }
  }
  if (allUnclock.length > 0) {
    allUnclock.sort((a, b) => b.minLate - a.minLate);
    const names = allUnclock.slice(0, 3).map(x => {
      const s = state.staff.find(st => st.id === x.a.staffId);
      return `${s?.name || "?"}(${Math.floor(x.minLate)}分)`;
    }).join("・");
    alerts.push({
      level: "error", emoji: "⏱",
      text: `未打刻 ${allUnclock.length} 名`,
      detail: names + (allUnclock.length > 3 ? ` 他 ${allUnclock.length - 3}` : ""),
      action: () => { /* dashboard 内なので何もしない */ }, actionLabel: "確認",
    });
  }

  // 7. 大幅な乖離アラート (Round 19) — 当月内で予定 vs 実績の差が大きいスタッフ
  const monthKey = (state.meta.currentWeekStart || "").slice(0, 7);
  if (monthKey) {
    const deviationByStaff = {};
    for (const wk of Object.values(state.weeks || {})) {
      if (wk.status !== "published") continue;
      for (const a of (wk.assignments || [])) {
        if (!a.date.startsWith(monthKey)) continue;
        if (!a.clockIn || !a.clockOut) continue;
        try {
          const inDt = new Date(a.clockIn), outDt = new Date(a.clockOut);
          const sched = calcHours(a.startTime, a.endTime);
          const actual = (outDt - inDt) / 3600000;
          const diff = actual - sched;
          if (Math.abs(diff) >= 0.5) { // 30分以上の乖離
            if (!deviationByStaff[a.staffId]) deviationByStaff[a.staffId] = { count: 0, total: 0 };
            deviationByStaff[a.staffId].count++;
            deviationByStaff[a.staffId].total += diff;
          }
        } catch (_) {}
      }
    }
    const bigDev = Object.entries(deviationByStaff).filter(([_, v]) => v.count >= 3 || Math.abs(v.total) >= 2);
    if (bigDev.length > 0) {
      const names = bigDev.slice(0, 2).map(([sid, v]) => {
        const s = state.staff.find(st => st.id === sid);
        const sign = v.total >= 0 ? "+" : "";
        return `${s?.name || "?"}(${sign}${v.total.toFixed(1)}h, ${v.count}回)`;
      }).join("・");
      alerts.push({
        level: "warn", emoji: "📊",
        text: `予定/実績の乖離が大 ${bigDev.length} 名`,
        detail: names + " — 月給与と CSV 集計に注意",
        action: () => { setTab("export"); }, actionLabel: "給与CSV確認",
      });
    }
  }

  // 売上連動の人件費率管理 (Round 20 TOP 1)
  if (state.staff.length > 0 && dashboardWidgetOn("laborCostRatio")) {
    const lcrCard = renderLaborCostRatio();
    if (lcrCard) wrap.appendChild(lcrCard);
  }

  // 月次労務リスク (Round 15 TOP 1) — 当月の累積時間と労務上限への接近度
  if (state.staff.length > 0 && dashboardWidgetOn("monthlyLaborRisk")) {
    const monthCard = renderMonthlyLaborRisk();
    if (monthCard) wrap.appendChild(monthCard);
  }

  // スタッフ・インサイト (Round 16 TOP 3) — 希望提出率・カバレッジ貢献・燃え尽きリスク
  if (state.staff.length > 0 && dashboardWidgetOn("staffInsights")) {
    const insightCard = renderStaffInsights();
    if (insightCard) wrap.appendChild(insightCard);
  }

  // 人件費推移グラフ (Round 11) — 過去 8 週分の確定済シフト人件費
  if (state.staff.length > 0 && typeof Chart !== "undefined" && dashboardWidgetOn("costChart")) {
    const chartCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
    chartCard.appendChild(el("div", { class: "flex items-center justify-between mb-2" }, [
      el("div", { class: "font-semibold text-sm" }, "📈 人件費推移 (直近 8 週)"),
      el("div", { class: "text-xs text-slate-500" }, `予算: ${fmtYen(state.meta.weeklyBudget)}/週`),
    ]));
    const canvas = document.createElement("canvas");
    canvas.id = "cost-chart";
    canvas.style.maxHeight = "200px";
    chartCard.appendChild(canvas);

    // データ集計: 直近 8 週
    const allWeeks = state.weeks || {};
    const sortedWeeks = Object.keys(allWeeks).sort().slice(-8);
    const labels = sortedWeeks.map(w => w.slice(5));
    const costs = sortedWeeks.map(w => {
      const week = allWeeks[w];
      if (!week.assignments) return 0;
      return week.assignments.reduce((sum, a) => sum + (a.cost || 0), 0);
    });
    const budget = state.meta.weeklyBudget;

    setTimeout(() => {
      const ctx = document.getElementById("cost-chart");
      if (!ctx) return;
      try {
        // 既存 chart instance 破棄
        if (window._costChart) window._costChart.destroy();
        window._costChart = new Chart(ctx, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: "人件費",
                data: costs,
                backgroundColor: costs.map(c => c > budget ? "#dc2626" : c > budget * 0.85 ? "#f59e0b" : "#10b981"),
                borderRadius: 4,
              },
              {
                label: "予算",
                data: labels.map(() => budget),
                type: "line",
                borderColor: "#4f46e5",
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                fill: false,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, position: "bottom", labels: { font: { size: 10 } } },
              tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ¥${ctx.parsed.y.toLocaleString()}` } },
            },
            scales: {
              y: { beginAtZero: true, ticks: { callback: (v) => `¥${(v/1000).toFixed(0)}k`, font: { size: 10 } } },
              x: { ticks: { font: { size: 10 } } },
            },
          },
        });
      } catch (e) { console.warn("chart render failed:", e); }
    }, 100);
    wrap.appendChild(chartCard);
  }

  // 本日の出勤者カード (Round 13) — 朝開店前の確認用
  const todayStr = new Date().toISOString().slice(0,10);
  // 今週の中で今日が含まれていれば、今週の assignments から、そうでなければ全 weeks から該当日を探す
  let todayAssignments = curAssignments().filter(a => a.date === todayStr);
  if (todayAssignments.length === 0 && state.weeks) {
    for (const wk of Object.values(state.weeks)) {
      const found = (wk.assignments || []).filter(a => a.date === todayStr);
      if (found.length) { todayAssignments = found; break; }
    }
  }
  if (todayAssignments.length > 0 && dashboardWidgetOn("todayAttendance")) {
    const todayCard = el("div", { class: "bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-300 rounded-xl p-3" });
    const dow = ["日","月","火","水","木","金","土"][new Date(todayStr + "T00:00:00").getDay()];
    // 打刻サマリ (Round 19)
    const totalShifts = todayAssignments.length;
    const clockedIn = todayAssignments.filter(a => a.clockIn).length;
    const clockedOut = todayAssignments.filter(a => a.clockOut).length;
    const lateUnclock = todayAssignments.filter(a => !a.clockIn && (Date.now() - new Date(`${a.date}T${a.startTime}:00`)) / 60000 > 5).length;
    let summaryBadge = `<span class="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">${totalShifts} シフト</span>`;
    if (lateUnclock > 0) {
      summaryBadge += `<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded ml-1">⚠️ 未打刻 ${lateUnclock}</span>`;
    }
    if (clockedIn - clockedOut > 0) {
      summaryBadge += `<span class="text-xs bg-emerald-100 text-emerald-800 px-2 py-1 rounded ml-1">勤務中 ${clockedIn - clockedOut}</span>`;
    }
    if (clockedOut > 0) {
      summaryBadge += `<span class="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded ml-1">退勤済 ${clockedOut}</span>`;
    }
    todayCard.appendChild(el("div", { class: "flex items-center justify-between mb-2 flex-wrap gap-1" }, [
      el("div", { class: "font-semibold text-sm text-amber-900" }, `☀ 本日の出勤者 (${todayStr.slice(5)} ${dow}曜)`),
      el("div", { class: "flex flex-wrap gap-1", html: summaryBadge }),
    ]));
    // 時間順ソート
    const sortedAss = todayAssignments.slice().sort((a,b) => a.startTime.localeCompare(b.startTime));
    // 時間帯別 (session) にグループ化
    const sessGroups = {};
    for (const a of sortedAss) {
      const key = `${a.startTime}-${a.endTime}`;
      if (!sessGroups[key]) sessGroups[key] = [];
      sessGroups[key].push(a);
    }
    const sessList = el("div", { class: "space-y-1.5" });
    for (const [timeKey, list] of Object.entries(sessGroups)) {
      const row = el("div", { class: "bg-white/60 rounded p-2 text-xs" });
      const sessLabel = (state.meta.sessions || []).find(s => `${s.startTime}-${s.endTime}` === timeKey)?.label || timeKey;
      row.innerHTML = `<div class="font-semibold text-amber-900 mb-1">⏰ ${escapeHtml(timeKey.replace("-", "〜"))} <span class="text-[10px] text-slate-500">(${escapeHtml(sessLabel)})</span></div>`;
      const staffList = el("div", { class: "flex flex-wrap gap-1" });
      for (const a of list) {
        const s = state.staff.find(x => x.id === a.staffId);
        if (!s) continue;
        const cfg = posCfg(a.position);
        // 打刻ステータス (Round 19)
        const hasIn = !!a.clockIn;
        const hasOut = !!a.clockOut;
        let clockStatus = "";
        let chipBg = "bg-white";
        if (hasIn && !hasOut) {
          clockStatus = `<span class="ml-1 text-[9px] bg-emerald-500 text-white rounded px-1">勤務中</span>`;
          chipBg = "bg-emerald-50";
        } else if (hasIn && hasOut) {
          clockStatus = `<span class="ml-1 text-[9px] bg-slate-500 text-white rounded px-1">退勤済</span>`;
          chipBg = "bg-slate-100";
        } else {
          // 未打刻
          const startDt = new Date(`${a.date}T${a.startTime}:00`);
          const minLate = (Date.now() - startDt) / 60000;
          if (minLate > 5) {
            clockStatus = `<span class="ml-1 text-[9px] bg-red-500 text-white rounded px-1">未打刻 ${Math.floor(minLate)}分経過</span>`;
            chipBg = "bg-red-50";
          }
        }
        // 遅刻情報
        let lateInfo = "";
        if (hasIn) {
          try {
            const inDt = new Date(a.clockIn);
            const sched = new Date(`${a.date}T${a.startTime}:00`);
            const diffMin = Math.round((inDt - sched) / 60000);
            if (diffMin > 5) lateInfo = `<span class="text-[9px] text-red-600 ml-0.5">+${diffMin}分</span>`;
            else if (diffMin < -10) lateInfo = `<span class="text-[9px] text-blue-600 ml-0.5">${diffMin}分</span>`;
          } catch (_) {}
        }
        const chip = el("span", {
          class: `inline-flex items-center gap-1 ${chipBg} border rounded px-2 py-0.5 text-[11px]`,
          style: { borderColor: cfg.color },
          title: `${s.name} (${cfg.label}) ${s.email ? '・' + s.email : ''}${hasIn ? '・出勤 ' + new Date(a.clockIn).toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'}) : ''}`,
        });
        chip.innerHTML = `<span style="color:${cfg.color}">●</span><strong>${escapeHtml(s.name)}</strong><span class="text-slate-500">(${escapeHtml(cfg.label)})</span>${lateInfo}${clockStatus}`;
        staffList.appendChild(chip);
      }
      row.appendChild(staffList);
      sessList.appendChild(row);
    }
    todayCard.appendChild(sessList);
    wrap.appendChild(todayCard);
  }

  if (alerts.length > 0 && dashboardWidgetOn("alerts")) {
    const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3" });
    card.appendChild(el("div", { class: "font-semibold text-sm text-slate-700 mb-2" }, `⚠️ 注意事項 ${alerts.length} 件`));
    const list = el("div", { class: "space-y-1.5" });
    for (const a of alerts) {
      const cls = a.level === "error" ? "bg-red-50 border-red-200 text-red-900"
        : a.level === "warn" ? "bg-amber-50 border-amber-200 text-amber-900"
        : "bg-blue-50 border-blue-200 text-blue-900";
      const row = el("div", { class: `flex items-center justify-between gap-2 border rounded-md px-3 py-2 text-sm ${cls}` });
      row.appendChild(el("div", { class: "flex-1" }, [
        el("span", { class: "font-semibold" }, `${a.emoji} ${a.text}`),
        el("span", { class: "text-xs ml-2 opacity-80" }, a.detail),
      ]));
      if (a.action) {
        row.appendChild(el("button", {
          class: "text-xs bg-white border border-current rounded px-2 py-1 font-semibold",
          onclick: a.action,
        }, a.actionLabel || "確認 →"));
      }
      list.appendChild(row);
    }
    card.appendChild(list);
    wrap.appendChild(card);
  }

  const kpis = el("div", { class: "grid grid-cols-2 md:grid-cols-4 gap-3" });
  kpis.appendChild(kpiCard("スタッフ", state.staff.length + "名", "👥"));
  kpis.appendChild(kpiCard("シフト枠", curSlots().reduce((s, x) => s + x.requiredCount, 0) + "枠", "🪑"));
  if (metrics) {
    kpis.appendChild(kpiCard("カバー率", fmtPct(metrics.coverageRate), "✅", metrics.coverageRate < 1 ? "warn" : "ok"));
    kpis.appendChild(kpiCard("人件費", fmtYen(metrics.totalCost), "💴", metrics.totalCost > state.meta.weeklyBudget ? "warn" : "ok"));
  } else {
    kpis.appendChild(kpiCard("カバー率", "— ", "✅"));
    kpis.appendChild(kpiCard("人件費", "— ", "💴"));
  }
  wrap.appendChild(kpis);

  const cost = metrics ? metrics.totalCost : 0;
  const budget = state.meta.weeklyBudget;
  const ratio = budget > 0 ? Math.min(2, cost / budget) : 0;
  const gaugeColor = ratio >= 1 ? "#dc2626" : ratio >= 0.85 ? "#f59e0b" : "#10b981";
  wrap.appendChild(el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" }, [
    el("div", { class: "flex items-center justify-between mb-2" }, [
      el("div", { class: "text-sm font-semibold text-slate-700" }, "今週予算"),
      el("div", { class: "text-sm text-slate-600" }, `${fmtYen(cost)} / ${fmtYen(budget)}`),
    ]),
    el("div", { class: "gauge-bar" }, [
      el("div", { style: { width: Math.min(100, ratio * 100) + "%", background: gaugeColor } })
    ]),
    el("div", { class: "text-xs text-slate-500 mt-2" }, ratio >= 1 ? "⚠️ 予算超過" : "想定内"),
  ]));

  // Status
  const statusCard = el("div", { class: `${curStatus() === "published" ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"} border rounded-xl p-4` });
  if (curStatus() === "published") {
    statusCard.appendChild(el("div", { class: "font-semibold text-emerald-900" }, "✓ この週は確定済みです"));
    statusCard.appendChild(el("div", { class: "text-sm text-emerald-800 mt-1" },
      "スタッフはポータルから自分のシフトを確認できます。"));
  } else {
    statusCard.appendChild(el("div", { class: "font-semibold text-amber-900" }, "📝 下書き状態"));
    statusCard.appendChild(el("div", { class: "text-sm text-amber-800 mt-1" },
      "シフト編成タブで「確定する」と、スタッフがポータルで自分のシフトを見られます。"));
  }
  wrap.appendChild(statusCard);

  // Unsubmitted
  const unsubmitted = state.staff.filter(s => !curPrefs().some(p => p.staffId === s.id));
  if (unsubmitted.length && curStatus() === "draft") {
    wrap.appendChild(el("div", { class: "bg-amber-50 border border-amber-200 rounded-xl p-4" }, [
      el("div", { class: "font-semibold text-amber-900 mb-1" }, `🔔 希望未提出: ${unsubmitted.length}名`),
      el("div", { class: "text-sm text-amber-800 mb-2" }, unsubmitted.map(s => s.name).join("・")),
      el("button", {
        class: "text-sm bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-md",
        onclick: () => setTab("preferences"),
      }, "希望収集タブへ →"),
    ]));
  }

  if (metrics && metrics.unfilled && metrics.unfilled.length) {
    wrap.appendChild(el("div", { class: "bg-red-50 border border-red-200 rounded-xl p-4" }, [
      el("div", { class: "font-semibold text-red-900 mb-1" }, `⚠️ 未充足スロット: ${metrics.unfilled.length}件`),
      el("div", { class: "text-sm text-red-800" }, "シフト編成タブで詳細を確認できます。"),
    ]));
  }

  // 今日 / 明日の出勤者
  wrap.appendChild(renderTodayPanel());
  wrap.appendChild(renderTomorrowPanel());

  // Past weeks analytics
  const trends = computeTrends();
  if (trends.length >= 2) {
    const chartCard = el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" });
    chartCard.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
      el("div", { class: "font-semibold" }, "📈 過去週推移"),
      el("div", { class: "text-xs text-slate-500" }, `直近 ${trends.length} 週`),
    ]));
    const grid = el("div", { class: "grid grid-cols-1 md:grid-cols-3 gap-4" });
    const c1 = el("div", {}, [el("div", { class: "text-xs text-slate-500 mb-1" }, "人件費 (¥)"), el("canvas", { id: "trendCost", style: { maxHeight: "180px" } })]);
    const c2 = el("div", {}, [el("div", { class: "text-xs text-slate-500 mb-1" }, "カバー率 (%)"), el("canvas", { id: "trendCoverage", style: { maxHeight: "180px" } })]);
    const c3 = el("div", {}, [el("div", { class: "text-xs text-slate-500 mb-1" }, "希望充足 (%)"), el("canvas", { id: "trendPref", style: { maxHeight: "180px" } })]);
    grid.appendChild(c1); grid.appendChild(c2); grid.appendChild(c3);
    chartCard.appendChild(grid);
    wrap.appendChild(chartCard);
    setTimeout(() => drawTrendCharts(trends), 50);
  }

  // 月間労働時間ランキング
  wrap.appendChild(renderMonthlyHoursRanking());

  wrap.appendChild(el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" }, [
    el("div", { class: "font-semibold mb-3" }, "クイックアクション"),
    el("div", { class: "grid grid-cols-2 md:grid-cols-3 gap-2" }, [
      quickAction("🤖 AIシフト自動生成", () => { setTab("schedule"); setTimeout(autoGenerate, 300); }),
      quickAction("📝 希望を入力", () => setTab("preferences")),
      quickAction("👥 スタッフ追加", () => { setTab("staff"); setTimeout(() => openStaffEdit(), 200); }),
      quickAction("⚙️ 店舗設定", () => setTab("settings")),
      quickAction("📤 シフト出力", () => setTab("export")),
      quickAction(state.staff.length === 0 ? "🎯 サンプルで試す" : "🔄 サンプル再投入", async () => {
        const msg = state.staff.length === 0
          ? "サンプルデータ（10名スタッフ・希望サンプル付き）を投入して動作を試しますか？"
          : "現在のデータを破棄してサンプルデータに戻しますか？この操作は取り消せません。";
        if (!confirm(msg)) return;
        state = await resetState({ withSample: true });
        render();
        toast("サンプルデータを投入しました。シフト編成タブで「🤖 AI自動生成」を試せます", "success");
      }),
    ]),
  ]));
  return wrap;
}

function kpiCard(label, value, icon, status = "") {
  const colors = status === "warn" ? "bg-amber-50 border-amber-200" : status === "ok" ? "bg-emerald-50 border-emerald-200" : "bg-white border-slate-200";
  return el("div", { class: `${colors} rounded-xl p-4 border` }, [
    el("div", { class: "flex items-center justify-between text-slate-500 text-xs mb-1" }, [
      el("span", {}, label), el("span", {}, icon),
    ]),
    el("div", { class: "text-2xl font-bold" }, value),
  ]);
}

function quickAction(label, onclick) {
  return el("button", {
    class: "text-left bg-slate-50 hover:bg-brand-50 hover:border-brand-500 border border-slate-200 rounded-lg px-3 py-2.5 text-sm transition",
    onclick,
  }, label);
}

function renderMonthlyHoursRanking() {
  // 当月（meta.currentWeekStart の年月）
  const ref = state.meta.currentWeekStart;
  const yearMonth = ref.slice(0, 7); // YYYY-MM
  const totals = Object.fromEntries(state.staff.map(s => [s.id, { name: s.name, hours: 0, cost: 0, position: s.position }]));
  for (const wk of Object.values(state.weeks)) {
    for (const a of wk.assignments || []) {
      if (!a.date.startsWith(yearMonth)) continue;
      const s = totals[a.staffId];
      if (!s) continue;
      const h = calcHours(a.startTime, a.endTime);
      s.hours += h;
      s.cost += a.cost || 0;
    }
  }
  const ranked = Object.values(totals).filter(s => s.hours > 0).sort((a, b) => b.hours - a.hours);

  const card = el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
    el("div", { class: "font-semibold" }, `📊 ${yearMonth} 月間労働時間ランキング`),
    el("div", { class: "text-xs text-slate-500" }, `${ranked.length} 名出勤`),
  ]));
  if (!ranked.length) {
    const empty = el("div", { class: "text-sm text-slate-500 text-center py-6 space-y-2" });
    empty.innerHTML = "今月の確定済シフトはまだありません<br>" +
      '<span class="text-xs">シフトを確定するとここに月間ランキングが表示されます</span>';
    card.appendChild(empty);
    return card;
  }
  const max = ranked[0].hours;
  const tbl = el("table", { class: "w-full text-sm" });
  tbl.innerHTML = `<thead class="text-xs text-slate-500"><tr>
    <th class="text-left py-1">#</th>
    <th class="text-left py-1">名前</th>
    <th class="text-right py-1">時間</th>
    <th class="text-right py-1">給与</th>
    <th class="text-left py-1 pl-2">割合</th>
  </tr></thead>`;
  const tb = el("tbody");
  ranked.forEach((s, i) => {
    const ratio = s.hours / max;
    const tr = el("tr", { class: "border-t border-slate-100" });
    tr.innerHTML = `
      <td class="py-1.5 text-slate-500">${i + 1}</td>
      <td class="py-1.5 font-medium">${escapeHtml(s.name)} <span class="text-xs text-slate-500">${escapeHtml(posCfg(s.position).label)}</span></td>
      <td class="py-1.5 text-right">${s.hours.toFixed(1)}h</td>
      <td class="py-1.5 text-right">${fmtYen(s.cost)}</td>
      <td class="py-1.5 pl-2">
        <div class="gauge-bar"><div style="width:${ratio*100}%;background:#6366f1"></div></div>
      </td>`;
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  card.appendChild(tbl);
  return card;
}

function renderAuditReport(audit) {
  const passed = audit.passed && audit.hardViolations.length === 0;
  const card = el("div", {
    class: passed
      ? "bg-emerald-50 border border-emerald-300 rounded-xl p-4 space-y-3"
      : "bg-red-50 border border-red-300 rounded-xl p-4 space-y-3",
  });

  card.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("div", { class: passed ? "font-bold text-emerald-900" : "font-bold text-red-900" },
      passed ? "✅ 検証レポート: 全制約クリア" : `⚠️ 検証レポート: ハード制約違反 ${audit.hardViolations.length}件`),
    el("button", { class: "text-xs underline text-slate-600",
      onclick: () => openAuditDetail(audit) }, "詳細を見る"),
  ]));

  // 主要指標
  const metricsGrid = el("div", { class: "grid grid-cols-2 md:grid-cols-4 gap-3 text-xs" });
  const items = [
    { label: "ハード制約検査", value: audit.hardConstraintsChecked.length + "件 全パス", ok: passed },
    { label: "試行回数", value: `${audit.randomStarts}回中ベスト採用`, ok: true },
    { label: "目的関数値", value: (audit.bestObjective).toFixed(3), ok: true },
    { label: "重み設定", value: "標準" + (state.meta.algorithmWeights ? "（カスタム可）" : ""), ok: true },
  ];
  // Round 18: 細分化情報
  if (audit.decomposition && audit.decomposition.splitCount > 0) {
    items.push({
      label: "🔪 希望ベース細分化",
      value: `${audit.decomposition.splitCount}/${audit.decomposition.originalSlots} 枠を分割`,
      ok: true,
    });
  }
  items.forEach(it => {
    metricsGrid.appendChild(el("div", { class: "bg-white rounded p-2" }, [
      el("div", { class: "text-slate-500 text-[10px]" }, it.label),
      el("div", { class: it.ok ? "font-semibold text-slate-800" : "font-semibold text-red-700" }, it.value),
    ]));
  });
  card.appendChild(metricsGrid);

  // 違反があれば一覧
  if (!passed) {
    const violList = el("div", { class: "text-xs space-y-1" });
    violList.appendChild(el("div", { class: "font-semibold text-red-900 mt-2" }, "違反内容:"));
    audit.hardViolations.slice(0, 5).forEach(v => {
      violList.appendChild(el("div", { class: "text-red-700" },
        `・${v.staffName || v.staffId} / ${v.date} / ${v.label || v.constraintId}`));
    });
    if (audit.hardViolations.length > 5) {
      violList.appendChild(el("div", { class: "text-red-700" },
        `... 他 ${audit.hardViolations.length - 5} 件`));
    }
    card.appendChild(violList);
  }

  return card;
}

function openAuditDetail(audit) {
  const body = el("div", { class: "p-6 space-y-4" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🛡️ アルゴリズム検証レポート"));

  body.appendChild(el("p", { class: "text-xs text-slate-500" },
    "シフトはこの基準で生成されました。仕様の詳細は docs/algorithm.md を参照してください。"));

  // ハード制約
  const hard = el("div", { class: "bg-white border rounded-md p-3 space-y-2" });
  hard.appendChild(el("div", { class: "font-semibold text-sm" }, "🛑 ハード制約（違反ゼロを保証）"));
  audit.hardConstraintsChecked.forEach(c => {
    hard.appendChild(el("div", { class: "text-xs" }, [
      el("span", { class: "text-emerald-600 font-bold" }, "✓ "),
      el("span", { class: "font-medium" }, c.label),
      el("span", { class: "text-slate-500" }, " — " + c.rationale),
    ]));
  });
  if (audit.hardViolations.length > 0) {
    hard.appendChild(el("div", { class: "mt-2 text-xs text-red-700 font-semibold" },
      `❌ 違反 ${audit.hardViolations.length}件:`));
    audit.hardViolations.forEach(v => {
      hard.appendChild(el("div", { class: "text-xs text-red-700 ml-3" },
        `${v.staffName} / ${v.date} / ${v.label}`));
    });
  }
  body.appendChild(hard);

  // ソフト制約（スコア要素）
  const soft = el("div", { class: "bg-white border rounded-md p-3 space-y-2" });
  soft.appendChild(el("div", { class: "font-semibold text-sm" }, "⚖️ スコア要素（重み付き加点方式）"));
  soft.appendChild(el("div", { class: "text-[11px] text-slate-500" },
    "各要素を 0..1 に正規化、重みで加重平均。重み合計 = 1.0"));
  audit.scoreFactors.forEach(f => {
    const row = el("div", { class: "flex items-center gap-2 text-xs" });
    row.innerHTML = `
      <span class="w-24 font-medium">${escapeHtml(f.label)}</span>
      <span class="text-slate-500 w-12">${(f.weight*100).toFixed(0)}%</span>
      <div class="flex-1 h-1.5 bg-slate-200 rounded">
        <div class="h-full bg-brand-600 rounded" style="width:${(f.weight*100).toFixed(0)}%"></div>
      </div>
      <span class="text-[10px] text-slate-500 flex-1">${escapeHtml(f.rationale)}</span>
    `;
    soft.appendChild(row);
  });
  body.appendChild(soft);

  // 試行
  const trial = el("div", { class: "bg-slate-50 rounded-md p-3 text-xs" });
  trial.appendChild(el("div", { class: "font-semibold mb-1" }, `🎯 試行 ${audit.randomStarts} 回（ベスト解採用）`));
  audit.trials.forEach(t => {
    const isBest = t.seed === audit.bestSeed;
    trial.appendChild(el("div", { class: `flex justify-between ${isBest ? 'font-bold text-emerald-700' : 'text-slate-600'}` }, [
      el("span", {}, `Seed ${t.seed}${isBest ? ' ← 採用' : ''}`),
      el("span", {}, `obj=${t.obj.toFixed(3)} cov=${(t.coverage*100).toFixed(0)}% pref=${(t.prefSat*100).toFixed(0)}%`),
    ]));
  });
  body.appendChild(trial);

  body.appendChild(el("button", { class: "w-full bg-slate-200 rounded-md py-2 text-sm", onclick: closeModal }, "閉じる"));
  modal(body);
}

function renderTomorrowPanel() {
  const tomorrow = addDays(fmtDate(new Date()), 1);
  let tomorrowWeek = null;
  for (const wk of listWeeks(state)) {
    const wEnd = addDays(wk, 6);
    if (tomorrow >= wk && tomorrow <= wEnd) { tomorrowWeek = wk; break; }
  }
  const list = tomorrowWeek ? state.weeks[tomorrowWeek].assignments.filter(a => a.date === tomorrow) : [];
  list.sort((a, b) => a.startTime.localeCompare(b.startTime));

  const card = el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
    el("div", { class: "font-semibold flex items-center gap-2" }, [
      el("span", {}, "🌅 明日の出勤"),
      el("span", { class: "text-xs text-slate-500" }, tomorrow),
    ]),
  ]));
  if (!list.length) {
    card.appendChild(el("div", { class: "text-sm text-slate-500 text-center py-3" },
      tomorrowWeek ? "明日の出勤者はいません" : "対象週が見つかりません"));
  } else {
    const grid = el("div", { class: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" });
    for (const a of list) {
      const s = state.staff.find(x => x.id === a.staffId);
      const cfg = posCfg(a.position);
      const item = el("div", { class: "border border-slate-200 rounded-md p-2 flex items-center gap-2" });
      item.innerHTML = `
        <div class="w-1 self-stretch rounded" style="background:${cfg.color}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm truncate">${escapeHtml(s?.name || "?")}</div>
          <div class="text-xs text-slate-600">${a.startTime}〜${a.endTime} <span class="text-slate-500">${escapeHtml(cfg.label)}</span></div>
        </div>`;
      grid.appendChild(item);
    }
    card.appendChild(grid);
  }
  return card;
}

function renderTodayPanel() {
  const today = fmtDate(new Date());
  // 今日が含まれる週を探す
  let todayWeek = null;
  for (const wk of listWeeks(state)) {
    const wEnd = addDays(wk, 6);
    if (today >= wk && today <= wEnd) { todayWeek = wk; break; }
  }
  const todayAssignments = todayWeek ? state.weeks[todayWeek].assignments.filter(a => a.date === today) : [];
  todayAssignments.sort((a, b) => a.startTime.localeCompare(b.startTime));

  const card = el("div", { class: "bg-white rounded-xl p-4 border border-slate-200" });
  card.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
    el("div", { class: "font-semibold flex items-center gap-2" }, [
      el("span", {}, "📅 今日の出勤"),
      el("span", { class: "text-xs text-slate-500" }, today),
    ]),
    todayWeek && state.weeks[todayWeek].status === "draft"
      ? el("span", { class: "text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800" }, "下書き中")
      : (todayWeek ? el("span", { class: "text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800" }, "確定済") : null),
  ]));
  if (!todayAssignments.length) {
    card.appendChild(el("div", { class: "text-sm text-slate-500 text-center py-4" },
      todayWeek ? "今日の出勤者はいません（休業日 or 未配置）" : "対象週が見つかりません"));
  } else {
    const grid = el("div", { class: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" });
    for (const a of todayAssignments) {
      const s = state.staff.find(x => x.id === a.staffId);
      const cfg = posCfg(a.position);
      const item = el("div", { class: "border border-slate-200 rounded-md p-2 flex items-center gap-2" });
      item.innerHTML = `
        <div class="w-1 self-stretch rounded" style="background:${cfg.color}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-sm truncate">${escapeHtml(s?.name || "?")}</div>
          <div class="text-xs text-slate-600">${a.startTime}〜${a.endTime} <span class="text-slate-500">${escapeHtml(cfg.label)}</span></div>
        </div>`;
      grid.appendChild(item);
    }
    card.appendChild(grid);
  }
  return card;
}

function computeTrends() {
  // 全週から最新8週を時系列で
  const weekKeys = listWeeks(state).slice(-8);
  const out = [];
  for (const wk of weekKeys) {
    const w = state.weeks[wk];
    if (!w || !w.assignments?.length) continue;
    const m = calcMetrics(
      {
        hours: Object.fromEntries(state.staff.map(s => [s.id, 0])),
        byStaff: Object.fromEntries(state.staff.map(s => [s.id, []])),
        assignments: w.assignments,
        unfilled: [],
      },
      { staff: state.staff, slots: w.slots, preferences: w.preferences });
    // hours/byStaff の再計算
    for (const a of w.assignments) {
      m.perStaff = m.perStaff;
    }
    out.push({
      weekStart: wk,
      label: wk.slice(5).replace("-", "/"),
      cost: w.assignments.reduce((s, a) => s + a.cost, 0),
      coverage: m.coverageRate,
      pref: m.preferenceSatisfaction,
      status: w.status,
    });
  }
  return out;
}

const _chartInstances = {};
function drawTrendCharts(trends) {
  for (const k of Object.keys(_chartInstances)) {
    try { _chartInstances[k]?.destroy(); } catch (_) {}
    delete _chartInstances[k];
  }
  const labels = trends.map(t => t.label);
  const mkChart = (id, data, color, isPct) => {
    const ctx = document.getElementById(id);
    if (!ctx || !window.Chart) return;
    _chartInstances[id] = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 4 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: isPct ? { callback: v => v + "%" } : { callback: v => v >= 1000 ? (v / 1000) + "k" : v } },
          x: { grid: { display: false } },
        },
      },
    });
  };
  mkChart("trendCost",     trends.map(t => Math.round(t.cost)),         "#6366f1", false);
  mkChart("trendCoverage", trends.map(t => Math.round(t.coverage * 100)), "#10b981", true);
  mkChart("trendPref",     trends.map(t => Math.round(t.pref * 100)),     "#f59e0b", true);
}

function aggregateHours() {
  const h = Object.fromEntries(state.staff.map(s => [s.id, 0]));
  for (const a of curAssignments()) h[a.staffId] = (h[a.staffId] || 0) + calcHours(a.startTime, a.endTime);
  return h;
}
function aggregateByStaff() {
  const m = Object.fromEntries(state.staff.map(s => [s.id, []]));
  for (const a of curAssignments()) (m[a.staffId] = m[a.staffId] || []).push(a);
  return m;
}

// ===== View: Staff =====
function viewStaff() {
  const wrap = el("div", { class: "space-y-4" });
  // Round 22: 検索 & アーカイブ表示の状態
  if (typeof window._staffSearchQuery === "undefined") window._staffSearchQuery = "";
  if (typeof window._showArchived === "undefined") window._showArchived = false;
  if (typeof window._positionFilter === "undefined") window._positionFilter = "all";

  wrap.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, `スタッフ管理 (${state.staff.filter(s => !s.archived).length}名${state.staff.some(s => s.archived) ? ` + アーカイブ${state.staff.filter(s => s.archived).length}名` : ""})`),
    el("div", { class: "flex gap-2 flex-wrap" }, [
      state.staff.length > 0 ? el("button", { class: "text-sm border border-purple-300 text-purple-700 hover:bg-purple-50 rounded-md px-3 py-1.5",
        onclick: () => openBroadcastDialog() }, "📢 全員に通知") : null,
      el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: () => importCsvDialog() }, "📥 CSV取込"),
      state.staff.length > 0 ? el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: copyAllStaffLinks }, "🔗 全員のリンク") : null,
      el("button", { class: "text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md px-3 py-1.5",
        onclick: () => openStaffEdit() }, "＋ スタッフ追加"),
    ]),
  ]));

  // Round 22+30: 検索 & フィルタ UI (希望提出ステータス追加)
  if (state.staff.length >= 1) {
    const searchRow = el("div", { class: "bg-slate-50 dark:bg-slate-800 rounded-md p-2 flex items-center gap-2 flex-wrap text-sm" });
    const searchInput = el("input", {
      type: "search",
      placeholder: "🔍 名前で検索",
      class: "flex-1 min-w-32 border rounded px-2 py-1 dark:bg-slate-700 dark:border-slate-600",
      value: window._staffSearchQuery || "",
      "aria-label": "スタッフ名検索",
    });
    // Round 33 (Perf-1): debounce で render() 連発を抑制
    let _searchTimer = null;
    searchInput.oninput = () => {
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => {
        window._staffSearchQuery = searchInput.value;
        render();
      }, 150);
    };
    searchRow.appendChild(searchInput);

    const posSelect = el("select", { class: "border rounded px-2 py-1 dark:bg-slate-700 dark:border-slate-600" });
    const allOpt = el("option", { value: "all" }, "全ポジション");
    if (window._positionFilter === "all") allOpt.selected = true;
    posSelect.appendChild(allOpt);
    for (const p of state.meta.positions) {
      const opt = el("option", { value: p.id }, p.label);
      if (window._positionFilter === p.id) opt.selected = true;
      posSelect.appendChild(opt);
    }
    posSelect.onchange = () => { window._positionFilter = posSelect.value; render(); };
    searchRow.appendChild(posSelect);

    // Round 30: 希望提出ステータスフィルタ
    const subFilterSelect = el("select", { class: "border rounded px-2 py-1 dark:bg-slate-700 dark:border-slate-600", title: "希望提出状況でフィルタ" });
    [
      ["all", "全員"],
      ["submitted", "📝 提出済"],
      ["unsubmitted", "⏳ 未提出"],
    ].forEach(([v, l]) => {
      const o = el("option", { value: v }, l);
      if ((window._submitFilter || "all") === v) o.selected = true;
      subFilterSelect.appendChild(o);
    });
    subFilterSelect.onchange = () => { window._submitFilter = subFilterSelect.value; render(); };
    searchRow.appendChild(subFilterSelect);

    if (state.staff.some(s => s.archived)) {
      const archToggle = el("label", { class: "inline-flex items-center gap-1 text-xs cursor-pointer" }, [
        (() => {
          const cb = el("input", { type: "checkbox" });
          if (window._showArchived) cb.checked = true;
          cb.onchange = () => { window._showArchived = cb.checked; render(); };
          return cb;
        })(),
        el("span", {}, "アーカイブ表示"),
      ]);
      searchRow.appendChild(archToggle);
    }
    wrap.appendChild(searchRow);
  }

  // 空状態の wizard 風 onboarding (Round 6)
  if (state.staff.length === 0 && !window.__SHIFTY_DEMO_MODE__) {
    const guide = el("div", { class: "bg-gradient-to-br from-emerald-50 to-blue-50 border border-emerald-200 rounded-xl p-5 text-center space-y-3" });
    guide.appendChild(el("div", { class: "text-3xl" }, "👥"));
    guide.appendChild(el("h3", { class: "font-bold text-base" }, "まだスタッフが登録されていません"));
    guide.appendChild(el("p", { class: "text-sm text-slate-600" },
      "次の 3 つの方法から選んで、スタッフ情報を登録してください。"));
    const choices = el("div", { class: "grid grid-cols-1 md:grid-cols-3 gap-3 mt-3" });

    // 1. サンプルで試す
    const c1 = el("button", {
      class: "bg-amber-50 border-2 border-amber-300 hover:bg-amber-100 rounded-lg p-4 text-left",
      onclick: async () => {
        if (!confirm("サンプルデータ（10 名スタッフ + 希望サンプル）を投入しますか？\n\n後でいつでも削除・変更できます。")) return;
        state = await resetState({ withSample: true });
        render();
        toast("サンプルデータ投入完了", "success");
      },
    });
    c1.innerHTML = `<div class="text-2xl mb-2">🎯</div>
      <div class="font-semibold text-amber-900">サンプルで試す</div>
      <div class="text-xs text-amber-700 mt-1">10 名のサンプルスタッフを即投入。動作を体験。</div>
      <div class="text-[10px] text-amber-600 mt-1.5">⏱ 0 分</div>`;

    // 2. 1人ずつ追加
    const c2 = el("button", {
      class: "bg-brand-50 border-2 border-brand-300 hover:bg-brand-100 rounded-lg p-4 text-left",
      onclick: () => openStaffEdit(),
    });
    c2.innerHTML = `<div class="text-2xl mb-2">＋</div>
      <div class="font-semibold text-brand-900">1人ずつ追加</div>
      <div class="text-xs text-brand-700 mt-1">フォームに名前・時給・希望休を入力。</div>
      <div class="text-[10px] text-brand-600 mt-1.5">⏱ 約 2 分/人</div>`;

    // 3. CSV 取込
    const c3 = el("button", {
      class: "bg-emerald-50 border-2 border-emerald-300 hover:bg-emerald-100 rounded-lg p-4 text-left",
      onclick: () => importCsvDialog(),
    });
    c3.innerHTML = `<div class="text-2xl mb-2">📥</div>
      <div class="font-semibold text-emerald-900">CSV で一括取込</div>
      <div class="text-xs text-emerald-700 mt-1">Excel / Google スプレッドシートからまとめて。</div>
      <div class="text-[10px] text-emerald-600 mt-1.5">⏱ 約 5 分（既存データ流用）</div>`;

    choices.appendChild(c1);
    choices.appendChild(c2);
    choices.appendChild(c3);
    guide.appendChild(choices);
    wrap.appendChild(guide);
    return wrap;
  }

  // ドラッグ並び替え用ヒント (Round 10)
  if (state.staff.length > 1) {
    wrap.appendChild(el("div", { class: "text-xs text-slate-500" },
      "💡 行の左端 ⋮⋮ をドラッグでスタッフの並び順を変更できます (シフト編成・ランキングにも反映)"));
  }
  const table = el("div", { class: "bg-white rounded-xl border border-slate-200 overflow-x-auto" });
  table.innerHTML = `
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-slate-600 text-xs">
        <tr>
          <th class="px-2 py-2"></th>
          <th class="text-left px-3 py-2">名前</th>
          <th class="text-left px-3 py-2">本職</th>
          <th class="text-left px-3 py-2">兼任</th>
          <th class="text-right px-3 py-2">時給</th>
          <th class="text-right px-3 py-2">週時間</th>
          <th class="text-left px-3 py-2">固定休</th>
          <th class="text-left px-3 py-2">スキル</th>
          <th class="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`;
  const tbody = table.querySelector("tbody");
  // Round 22+30: 検索 & フィルタを適用
  const submittedSet = new Set((curPrefs() || []).map(p => p.staffId));
  const filteredStaff = state.staff.filter(s => {
    if (s.archived && !window._showArchived) return false;
    if (window._positionFilter && window._positionFilter !== "all" && s.position !== window._positionFilter) return false;
    if (window._staffSearchQuery) {
      const q = window._staffSearchQuery.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !(s.notes || "").toLowerCase().includes(q)) return false;
    }
    // Round 30: 提出ステータス
    const subFilter = window._submitFilter || "all";
    if (subFilter === "submitted" && !submittedSet.has(s.id)) return false;
    if (subFilter === "unsubmitted" && submittedSet.has(s.id)) return false;
    return true;
  });
  filteredStaff.forEach((s, idx) => {
    const tr = el("tr", {
      class: "border-t border-slate-100 hover:bg-slate-50",
      draggable: "true",
      "data-staff-id": s.id,
      ondragstart: (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); tr.style.opacity = "0.4"; },
      ondragend: () => { tr.style.opacity = ""; },
      ondragover: (e) => { e.preventDefault(); tr.style.borderTop = "2px solid #4f46e5"; },
      ondragleave: () => { tr.style.borderTop = ""; },
      ondrop: (e) => {
        e.preventDefault();
        tr.style.borderTop = "";
        const sourceId = e.dataTransfer.getData("text/plain");
        if (!sourceId || sourceId === s.id) return;
        const sourceIdx = state.staff.findIndex(x => x.id === sourceId);
        const targetIdx = state.staff.findIndex(x => x.id === s.id);
        if (sourceIdx < 0 || targetIdx < 0) return;
        const [moved] = state.staff.splice(sourceIdx, 1);
        state.staff.splice(targetIdx, 0, moved);
        persist(); render();
        toast(`${moved.name} の並び順を変更`, "success");
      },
    });
    const archMark = s.archived ? `<span class="text-[9px] bg-slate-200 text-slate-600 rounded px-1 ml-1">📁 アーカイブ</span>` : "";
    // Round 31 TOP 3: 名前部分をクリック可能に (詳細展開)
    tr.innerHTML = `
      <td class="px-2 py-2.5 text-center text-slate-400 cursor-move" title="ドラッグで並び替え">⋮⋮</td>
      <td class="px-3 py-2.5 font-medium ${s.archived ? "text-slate-400" : ""}">
        <button class="staff-row-expand text-left hover:underline" data-staff-id="${escapeAttr(s.id)}" title="クリックで月次実績を表示">
          ${escapeHtml(s.name)}${archMark}
          <span class="text-[10px] text-slate-400 ml-1">▼</span>
        </button>
      </td>
      <td class="px-3 py-2.5">${posBadge(s.position)}</td>
      <td class="px-3 py-2.5">${s.canCover.length ? s.canCover.map(p => escapeHtml(posCfg(p).label)).join("・") : "<span class=\"text-slate-400\">—</span>"}</td>
      <td class="px-3 py-2.5 text-right">${fmtYen(s.hourlyWage)}</td>
      <td class="px-3 py-2.5 text-right">${s.minHoursPerWeek}〜${s.maxHoursPerWeek}h</td>
      <td class="px-3 py-2.5">${s.fixedDayOff.map(d => DAY_LABELS[d]).join("・") || "<span class=\"text-slate-400\">—</span>"}</td>
      <td class="px-3 py-2.5">${"★".repeat(s.skill)}<span class="text-slate-300">${"★".repeat(5 - s.skill)}</span></td>`;
    const td = el("td", { class: "px-3 py-2.5 text-right whitespace-nowrap" }, [
      el("button", { class: "text-xs text-emerald-600 hover:underline mr-2",
        title: "希望入力ポータルの URL をコピー（既存があれば再利用）",
        onclick: () => copyStaffLink(s) }, "🔗 リンク"),
      el("button", { class: "text-xs text-blue-600 hover:underline mr-2",
        title: "QR コード表示（紙印刷で渡せる）",
        onclick: () => showStaffQR(s) }, "📱 QR"),
      el("button", { class: "text-xs text-amber-600 hover:underline mr-2",
        title: "URL を再発行して旧 URL を失効させる（退職者対応・URL流出時など）",
        onclick: () => regenerateStaffLink(s) }, "🔄 再発行"),
      el("button", { class: "text-xs text-brand-600 hover:underline mr-2",
        onclick: () => openStaffEdit(s) }, "編集"),
      // Round 22: アーカイブ ボタン (削除より安全)
      el("button", {
        class: "text-xs text-slate-500 hover:underline mr-2",
        title: s.archived ? "アーカイブから戻す" : "退職者などをアーカイブ (削除しない)",
        onclick: () => {
          s.archived = !s.archived;
          persist(); render();
          toast(s.archived ? `${s.name} をアーカイブしました` : `${s.name} を復帰しました`, "success");
        },
      }, s.archived ? "📤 復帰" : "📁 アーカイブ"),
      el("button", { class: "text-xs text-red-600 hover:underline",
        onclick: () => {
          if (!confirm(`${s.name} を完全削除しますか？\n\n💡 退職対応なら「📁 アーカイブ」のほうが安全です (履歴・給与計算データを保持)。`)) return;
          state.staff = state.staff.filter(x => x.id !== s.id);
          // 全週から該当スタッフのデータを除去
          for (const wk of Object.values(state.weeks)) {
            wk.preferences = wk.preferences.filter(p => p.staffId !== s.id);
            wk.assignments = wk.assignments.filter(a => a.staffId !== s.id);
          }
          // トークンも失効
          window.ShiftyAPI.revokeStaffToken(s.id).catch(() => {});
          persist(); render(); toast("削除しました（リンクも失効）", "success");
        } }, "削除"),
    ]);
    tr.appendChild(td);
    tbody.appendChild(tr);
    // Round 31 TOP 3: 名前ボタンの click → 詳細行展開
    const expandBtn = tr.querySelector(".staff-row-expand");
    if (expandBtn) {
      expandBtn.onclick = () => toggleStaffDetailRow(tr, s);
    }
  });
  wrap.appendChild(table);
  return wrap;
}

// tenant URL を生成（multi-tenant の場合は /t/{slug}/staff、legacy は /staff）
function _staffPortalUrl(token) {
  const slug = window.ShiftyAPI && window.ShiftyAPI.tenantSlug;
  return slug
    ? `${location.origin}/t/${encodeURIComponent(slug)}/staff?t=${token}`
    : `${location.origin}/staff?t=${token}`;
}

async function copyStaffLink(s) {
  try {
    const r = await window.ShiftyAPI.genStaffToken(s.id);
    const url = _staffPortalUrl(r.token);
    await navigator.clipboard.writeText(url);
    if (r.created) {
      toast(`${s.name} の新しいリンクを発行・コピーしました`, "success");
    } else {
      toast(`${s.name} の既存リンクをコピーしました`, "info");
    }
  } catch (e) { toast("リンク生成失敗: " + e.message, "error"); }
}

// スタッフ QR コード表示 (Round 14)
async function showStaffQR(s) {
  let token;
  try {
    const r = await window.ShiftyAPI.genStaffToken(s.id);
    token = r.token;
  } catch (e) { toast("リンク生成失敗: " + e.message, "error"); return; }
  const url = _staffPortalUrl(token);

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, `📱 ${s.name} さんの QR コード`));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "印刷してスタッフに直接渡せます。スマホでスキャンするとポータルが開きます。"));

  const qrWrap = el("div", { id: "qr-wrap", class: "flex justify-center bg-white p-4 border-2 border-slate-300 rounded" });
  body.appendChild(qrWrap);

  body.appendChild(el("div", { class: "bg-slate-50 rounded p-2 text-xs font-mono break-all" }, url));

  body.appendChild(el("div", { class: "flex gap-2 justify-end" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md font-semibold",
      onclick: () => {
        const canvas = qrWrap.querySelector("canvas");
        if (canvas) {
          const link = document.createElement("a");
          link.download = `qr_${s.name}.png`;
          link.href = canvas.toDataURL();
          document.body.appendChild(link); link.click(); link.remove();
          toast("QR コードをダウンロード", "success");
        }
      },
    }, "💾 PNG ダウンロード"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-slate-700 text-white rounded-md font-semibold",
      onclick: () => {
        // 印刷用ウィンドウ
        const canvas = qrWrap.querySelector("canvas");
        if (canvas) {
          const w = window.open("", "_blank");
          if (w) {
            w.document.write(`<html><head><title>QR - ${s.name}</title>
              <style>body{font-family:system-ui;text-align:center;padding:20mm}img{width:60mm;height:60mm}h1{font-size:14pt}p{font-size:10pt;color:#555;word-break:break-all}</style>
              </head><body><h1>${s.name} さんのシフト希望提出 URL</h1>
              <img src="${canvas.toDataURL()}"><p>${url}</p>
              <p style="font-size:8pt">※ スマホでスキャン or URL 直接入力</p>
              </body></html>`);
            setTimeout(() => w.print(), 500);
          }
        }
      },
    }, "🖨 印刷"),
  ]));
  modal(body);

  // QR 描画
  setTimeout(() => {
    if (typeof QRCode !== "undefined") {
      const cv = document.createElement("canvas");
      qrWrap.appendChild(cv);
      QRCode.toCanvas(cv, url, { width: 240, margin: 2 }, (err) => {
        if (err) qrWrap.innerHTML = `<div class="text-red-600 text-sm">QR 生成失敗</div>`;
      });
    } else {
      qrWrap.innerHTML = `<div class="text-amber-600 text-sm">QR ライブラリ読込待ち...</div>`;
    }
  }, 100);
}

async function regenerateStaffLink(s) {
  if (!confirm(
    `${s.name} の URL を再発行しますか？\n\n` +
    `この操作で旧 URL は無効化されます（旧 URL を持つ人はアクセス不可になります）。\n` +
    `退職者対応や URL の流出時にご利用ください。`
  )) return;
  try {
    const r = await window.ShiftyAPI.regenerateStaffToken(s.id);
    const url = _staffPortalUrl(r.token);
    await navigator.clipboard.writeText(url);
    toast(
      r.regenerated
        ? `${s.name}: 旧 URL を失効、新 URL をコピーしました`
        : `${s.name}: 新規リンクを発行・コピーしました`,
      "success"
    );
  } catch (e) { toast("再発行失敗: " + e.message, "error"); }
}

async function copyAllStaffLinks() {
  try {
    const lines = [];
    for (const s of state.staff) {
      const { token } = await window.ShiftyAPI.genStaffToken(s.id);
      const url = _staffPortalUrl(token);
      lines.push(`【${s.name}】${url}`);
    }
    const txt = lines.join("\n");
    await navigator.clipboard.writeText(txt);
    toast(`${state.staff.length}名分のリンクをコピー`, "success");
    const body = el("div", { class: "p-6 space-y-2" });
    body.appendChild(el("h3", { class: "font-bold text-lg" }, "全スタッフの希望入力リンク"));
    body.appendChild(el("p", { class: "text-xs text-slate-500" }, "下記をコピーしてLINEで一斉送信してください"));
    body.appendChild(el("textarea", { class: "w-full border rounded-md p-2 text-xs font-mono h-64", readonly: "" }, txt));
    body.appendChild(el("div", { class: "flex justify-end" }, [
      el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    ]));
    modal(body);
  } catch (e) { toast("リンク生成失敗: " + e.message, "error"); }
}

function openStaffEdit(s = null) {
  const isNew = !s;
  const data = s ? { ...s } : {
    id: uid("s_"), name: "", position: state.meta.positions[0]?.id || "hall", canCover: [],
    hourlyWage: 1100, maxHoursPerWeek: 28, minHoursPerWeek: 10,
    fixedDayOff: [], skill: 3, notes: "",
    breakMinutes: 0,
    fixedShifts: [],  // Round 13: 固定出勤 [{dow: 1, sessionId: "lunch"}]
  };
  if (data.breakMinutes === undefined) data.breakMinutes = 0;
  if (!Array.isArray(data.fixedShifts)) data.fixedShifts = [];
  const body = el("div", { class: "p-6 space-y-4" });
  body.innerHTML = `<h3 class="font-bold text-lg mb-3">${isNew ? "新規スタッフ追加" : "スタッフ編集"}</h3>`;
  const form = el("div", { class: "space-y-3 text-sm" });
  form.innerHTML = `
    <label class="block"><span class="text-slate-600">名前</span>
      <input data-k="name" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.name)}"></label>
    <div class="grid grid-cols-2 gap-3">
      <label class="block"><span class="text-slate-600">本職</span>
        <select data-k="position" class="mt-1 w-full border rounded-md px-3 py-2">
          ${state.meta.positions.map(p => `<option value="${p.id}" ${data.position === p.id ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
        </select></label>
      <label class="block"><span class="text-slate-600">時給(円)</span>
        <input data-k="hourlyWage" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.hourlyWage}"></label>
      <label class="block"><span class="text-slate-600">週最低(h)</span>
        <input data-k="minHoursPerWeek" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.minHoursPerWeek}"></label>
      <label class="block"><span class="text-slate-600">週最大(h)</span>
        <input data-k="maxHoursPerWeek" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.maxHoursPerWeek}"></label>
      <label class="block"><span class="text-slate-600">スキル(1-5)</span>
        <input data-k="skill" type="number" min="1" max="5" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.skill}"></label>
    </div>
    <div>
      <span class="text-slate-600 block mb-1">兼任可能ポジション</span>
      <div class="flex flex-wrap gap-2">
        ${state.meta.positions.map(p =>
          `<label class="inline-flex items-center gap-1 text-sm border rounded-md px-2 py-1 cursor-pointer">
            <input type="checkbox" data-cover="${p.id}" ${data.canCover.includes(p.id) ? "checked" : ""}>
            ${escapeHtml(p.label)}</label>`).join("")}
      </div>
    </div>
    <details class="border border-slate-200 rounded-md p-2">
      <summary class="text-sm cursor-pointer text-slate-700 select-none">🎯 ポジション別スキル (Round 22) <span class="text-[10px] text-slate-400">— ピーク帯配置の判定に使用</span></summary>
      <div class="mt-2 space-y-1.5">
        ${state.meta.positions.map(p => {
          const cur = (data.skills && data.skills[p.id] != null) ? data.skills[p.id] : (p.id === data.position ? data.skill : 1);
          return `<label class="flex items-center gap-2 text-xs">
            <span class="w-20 ${p.id === data.position ? "font-semibold" : "text-slate-600"}">${escapeHtml(p.label)} ${p.id === data.position ? "(本職)" : ""}</span>
            <input type="range" min="1" max="5" data-task-skill="${p.id}" value="${cur}" class="flex-1">
            <span class="w-10 text-right text-slate-700" data-task-skill-display="${p.id}">${cur}/5</span>
          </label>`;
        }).join("")}
      </div>
      <div class="text-[10px] text-slate-500 mt-2">
        💡 1=未経験 / 2=研修中 / 3=一人前 / 4=熟練 / 5=指導者。AI はピーク帯に平均スキル ≥ 3 を満たすよう配置します。
      </div>
    </details>
    <div>
      <span class="text-slate-600 block mb-1">固定休</span>
      <div class="flex gap-1 flex-wrap">
        ${DAY_LABELS.map((d, i) =>
          `<label class="inline-flex items-center gap-1 text-sm border rounded-md px-2 py-1 cursor-pointer">
            <input type="checkbox" data-off="${i}" ${data.fixedDayOff.includes(i) ? "checked" : ""}>
            ${d}</label>`).join("")}
      </div>
    </div>
    <div>
      <span class="text-slate-600 block mb-1">固定出勤 <span class="text-[10px] text-slate-400">(チェックの曜日×セッションは AI が必ず配置)</span></span>
      <div class="space-y-1">
        ${state.meta.sessions.map(sess => `
          <div class="flex items-center gap-2 text-xs">
            <span class="w-16 text-slate-600">${escapeHtml(sess.label)}:</span>
            ${DAY_LABELS.map((d, i) => {
              const isFixed = data.fixedShifts.some(f => f.dow === i && f.sessionId === sess.id);
              return `<label class="inline-flex items-center gap-0.5 cursor-pointer">
                <input type="checkbox" data-fixed-dow="${i}" data-fixed-sess="${sess.id}" ${isFixed ? "checked" : ""}>
                <span class="ml-0.5">${d}</span>
              </label>`;
            }).join("")}
          </div>`).join("")}
      </div>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <label class="block"><span class="text-slate-600">休憩(分) <span class="text-[10px] text-slate-400">6h 超勤務時に控除</span></span>
        <select data-k="breakMinutes" class="mt-1 w-full border rounded-md px-3 py-2">
          <option value="0" ${data.breakMinutes === 0 ? "selected" : ""}>休憩なし (給与控除なし)</option>
          <option value="30" ${data.breakMinutes === 30 ? "selected" : ""}>30 分</option>
          <option value="45" ${data.breakMinutes === 45 ? "selected" : ""}>45 分 (労基: 6-8h 勤務)</option>
          <option value="60" ${data.breakMinutes === 60 ? "selected" : ""}>60 分 (労基: 8h 超勤務)</option>
          <option value="90" ${data.breakMinutes === 90 ? "selected" : ""}>90 分</option>
        </select></label>
      <label class="block"><span class="text-slate-600">メールアドレス <span class="text-[10px] text-slate-400">通知用</span></span>
        <input data-k="email" type="email" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.email || "")}" placeholder="staff@example.com"></label>
    </div>
    <label class="block"><span class="text-slate-600">メモ (店長用・スタッフには非表示)</span>
      <input data-k="notes" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.notes || "")}"></label>
    <label class="block"><span class="text-slate-600">📲 Webhook URL <span class="text-[10px] text-slate-400">(任意・LINE 連携 / Slack / Discord)</span></span>
      <div class="flex gap-1 mt-1">
        <input data-k="webhookUrl" type="url" class="flex-1 border rounded-md px-3 py-2 text-xs"
          value="${escapeAttr(data.webhookUrl || "")}" placeholder="https://hooks.slack.com/... or Discord/IFTTT/Zapier">
        <button id="webhook-test-btn" type="button" class="text-xs bg-slate-700 text-white rounded-md px-3 py-1.5 whitespace-nowrap">🔔 テスト</button>
      </div>
      <div class="text-[10px] text-slate-500 mt-1">
        確定通知を LINE/Slack/Discord に送れます。LINE は IFTTT/Zapier 経由 (LINE Notify は 2025/3 終了)。
      </div></label>`;
  body.appendChild(form);
  // Webhook テストボタンの配線 (Round 17 TOP 2)
  setTimeout(() => {
    // Round 22: タスク別スキルのライブ表示
    form.querySelectorAll("[data-task-skill]").forEach(inp => {
      inp.addEventListener("input", () => {
        const k = inp.getAttribute("data-task-skill");
        const disp = form.querySelector(`[data-task-skill-display="${k}"]`);
        if (disp) disp.textContent = `${inp.value}/5`;
      });
    });
    const wt = document.getElementById("webhook-test-btn");
    if (wt) wt.onclick = async () => {
      const url = (form.querySelector("[data-k=webhookUrl]")?.value || "").trim();
      if (!url) { toast("先に Webhook URL を入力してください", "error"); return; }
      wt.disabled = true; wt.textContent = "送信中…";
      try {
        const r = await window.ShiftyAPI.testWebhook(url);
        if (r.ok) toast("✓ テスト送信成功 (Webhook 側でメッセージを確認してください)", "success", 5000);
        else toast("送信失敗 — URL の形式または到達性を確認してください", "error", 5000);
      } catch (e) {
        toast("テスト失敗: " + (e?.message || ""), "error");
      } finally {
        wt.disabled = false; wt.textContent = "🔔 テスト";
      }
    };
  }, 50);
  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm", onclick: closeModal }, "キャンセル"),
    el("button", { class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md", onclick: () => {
      $$("input,select", form).forEach(inp => {
        const k = inp.dataset.k;
        if (k) data[k] = inp.type === "number" ? Number(inp.value) : inp.value;
      });
      data.canCover = $$("input[data-cover]", form).filter(i => i.checked).map(i => i.dataset.cover);
      data.fixedDayOff = $$("input[data-off]", form).filter(i => i.checked).map(i => Number(i.dataset.off));
      // Round 13: 固定出勤の収集
      data.fixedShifts = $$("input[data-fixed-dow]", form).filter(i => i.checked).map(i => ({
        dow: Number(i.dataset.fixedDow),
        sessionId: i.dataset.fixedSess,
      }));
      // Round 22: タスク別スキル収集
      const skills = {};
      $$("input[data-task-skill]", form).forEach(inp => {
        const k = inp.getAttribute("data-task-skill");
        const v = Number(inp.value);
        if (v >= 1 && v <= 5) skills[k] = v;
      });
      data.skills = skills;
      // 後方互換: skill (本職スキル) も同期
      if (skills[data.position]) data.skill = skills[data.position];
      if (!data.name) { toast("名前を入力してください", "error"); return; }
      if (isNew) state.staff.push(data);
      else state.staff = state.staff.map(x => x.id === data.id ? data : x);
      persist(); closeModal(); render(); toast(isNew ? "追加しました" : "更新しました", "success");
    } }, "保存"),
  ]));
  modal(body);
}

function importCsvDialog() {
  const positionIds = state.meta.positions.map(p => p.id).join("/");
  const sampleCsv =
    "名前,本職ID,時給,週最低,週最大,固定休(0-6スペース区切り),スキル\n" +
    "山田 太郎,hall,1100,10,28,0,3\n" +
    "佐藤 花子,kitchen,1300,30,40,2,5\n" +
    "鈴木 一郎,cashier,1050,8,20,5 6,3\n";

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "CSV 取込"));
  body.appendChild(el("div", { class: "bg-slate-50 border border-slate-200 rounded p-3 text-xs space-y-1" }, [
    el("div", { class: "font-semibold" }, "📋 列の順序"),
    el("div", { class: "font-mono text-[11px]" }, "名前,本職ID,時給,週最低,週最大,固定休,スキル"),
    el("div", {}, `本職ID は: ${positionIds}（設定タブで追加可）`),
    el("div", {}, "固定休は曜日番号 (0=日 〜 6=土) をスペース区切り。例: 「2 5」= 火・金"),
    el("div", {}, "スキルは 1〜5（5が最も熟練）"),
  ]));
  body.appendChild(el("div", { class: "flex items-center justify-between" }, [
    el("label", { class: "text-sm font-semibold", for: "csvText" }, "CSV 内容"),
    el("button", {
      class: "text-xs text-emerald-600 hover:underline",
      onclick: () => {
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), sampleCsv], { type: "text/csv" });
        const a = el("a", { href: URL.createObjectURL(blob), download: "shifty_staff_sample.csv" });
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast("サンプル CSV をダウンロードしました", "success");
      }
    }, "⬇ サンプル CSV をダウンロード"),
  ]));
  body.appendChild(el("textarea", {
    id: "csvText",
    class: "w-full border rounded-md px-3 py-2 text-sm font-mono h-40",
    placeholder: sampleCsv,
    "aria-label": "CSV 内容",
  }));
  // プレビュー領域 (Round 11)
  const previewArea = el("div", { class: "hidden", id: "csv-preview-area" });
  body.appendChild(previewArea);

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      id: "csv-preview-btn",
      class: "px-4 py-1.5 text-sm bg-slate-600 hover:bg-slate-700 text-white rounded-md font-semibold",
      onclick: () => {
        const txt = $("#csvText").value.trim();
        if (!txt) { toast("CSV を入力してください", "error"); return; }
        previewCsvImport(txt);
      }
    }, "👁 プレビュー"),
    el("button", {
      id: "csv-confirm-btn",
      class: "px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold hidden",
      onclick: () => {
        const txt = $("#csvText").value.trim();
        commitCsvImport(txt);
      },
    }, "✓ 取込実行"),
  ]));
  modal(body);
}

// CSV 取込: parse + validate (preview 用と commit 用で共有)
function _parseCsvRows(txt) {
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  const dataLines = lines[0].includes("名前") || lines[0].includes("本職ID") ? lines.slice(1) : lines;
  const rows = dataLines.map(r => r.split(",").map(x => x.trim())).filter(r => r.length >= 5);
  const parsed = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0];
    const posId = r[1] || state.meta.positions[0]?.id;
    if (!name) { errors.push(`${i+1}行目: 名前が空`); continue; }
    if (!state.meta.positions.find(p => p.id === posId)) {
      errors.push(`${i+1}行目: 不明な本職ID 「${posId}」`); continue;
    }
    const off = r[5] ? r[5].split(/[\s\/、]+/).map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 6) : [];
    parsed.push({
      lineNo: i+1, name, position: posId,
      hourlyWage: Number(r[2]) || 1100,
      minHoursPerWeek: Number(r[3]) || 10,
      maxHoursPerWeek: Number(r[4]) || 28,
      fixedDayOff: off,
      skill: Math.min(5, Math.max(1, Number(r[6]) || 3)),
    });
  }
  return { parsed, errors };
}

function previewCsvImport(txt) {
  const { parsed, errors } = _parseCsvRows(txt);
  const area = $("#csv-preview-area");
  if (!area) return;
  area.classList.remove("hidden");
  let html = `<div class="bg-slate-50 rounded p-3 mt-2 text-xs">
    <div class="font-semibold mb-2">📋 取込プレビュー: 有効 ${parsed.length} 件 / エラー ${errors.length} 件</div>`;
  if (errors.length > 0) {
    html += `<div class="bg-red-50 border border-red-200 rounded p-2 mb-2">
      <div class="font-semibold text-red-700">エラー:</div>
      ${errors.slice(0, 5).map(e => `<div class="text-red-600">• ${escapeHtml(e)}</div>`).join("")}
      ${errors.length > 5 ? `<div class="text-red-500">…他 ${errors.length - 5} 件</div>` : ""}
    </div>`;
  }
  if (parsed.length > 0) {
    html += `<div class="overflow-x-auto"><table class="w-full text-[11px]">
      <thead class="bg-white"><tr>
        <th class="text-left p-1">名前</th>
        <th class="text-left p-1">本職</th>
        <th class="text-right p-1">時給</th>
        <th class="text-right p-1">週時間</th>
        <th class="text-left p-1">固定休</th>
        <th class="text-left p-1">スキル</th>
      </tr></thead><tbody>`;
    parsed.slice(0, 20).forEach(p => {
      const dows = p.fixedDayOff.map(d => DAY_LABELS[d]).join("・") || "—";
      html += `<tr class="border-t border-slate-200">
        <td class="p-1 font-medium">${escapeHtml(p.name)}</td>
        <td class="p-1">${escapeHtml(posCfg(p.position).label)}</td>
        <td class="p-1 text-right">${fmtYen(p.hourlyWage)}</td>
        <td class="p-1 text-right">${p.minHoursPerWeek}〜${p.maxHoursPerWeek}h</td>
        <td class="p-1">${dows}</td>
        <td class="p-1">${"★".repeat(p.skill)}</td>
      </tr>`;
    });
    if (parsed.length > 20) html += `<tr><td colspan="6" class="p-1 text-slate-500">…他 ${parsed.length - 20} 件</td></tr>`;
    html += `</tbody></table></div>`;
  }
  html += `</div>`;
  area.innerHTML = html;

  // ボタン状態切替
  $("#csv-confirm-btn").classList.toggle("hidden", parsed.length === 0);
  $("#csv-preview-btn").textContent = "🔄 再プレビュー";
}

function commitCsvImport(txt) {
  const { parsed, errors } = _parseCsvRows(txt);
  if (parsed.length === 0) { toast("有効な行がありません", "error"); return; }
  for (const p of parsed) {
    state.staff.push({
      id: uid("s_"), name: p.name, position: p.position, canCover: [],
      hourlyWage: p.hourlyWage,
      minHoursPerWeek: p.minHoursPerWeek,
      maxHoursPerWeek: p.maxHoursPerWeek,
      fixedDayOff: p.fixedDayOff,
      skill: p.skill,
      notes: "", email: "", breakMinutes: 0,
    });
  }
  persist(); closeModal(); render();
  if (errors.length === 0) {
    toast(`${parsed.length}名 取り込み完了`, "success");
  } else {
    toast(`${parsed.length}名 取込・${errors.length}件はエラーで除外`, "info");
  }
}

// ===== View: Preferences =====
function viewPreferences() {
  const wrap = el("div", { class: "space-y-4" });
  wrap.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, "希望収集"),
    el("div", { class: "flex gap-2 flex-wrap" }, [
      el("button", { class: "text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-md px-3 py-1.5",
        onclick: openRecruitDialog,
        title: "新週の希望募集をスタッフに依頼するメール/LINE 文" }, "📨 募集メッセージ生成"),
      el("button", { class: "text-sm bg-emerald-600 text-white rounded-md px-3 py-1.5",
        onclick: copyAllStaffLinks }, "💬 LINE用 全員リンク生成"),
    ]),
  ]));

  // 長期休暇申請カード (Round 16 TOP 1)
  const vacReqCard = renderVacationRequestsCard();
  if (vacReqCard) wrap.appendChild(vacReqCard);

  // シフト交換掲示板カード (Round 16 TOP 2)
  const swapCard = renderSwapRequestsCard();
  if (swapCard) wrap.appendChild(swapCard);

  const submitted = state.staff.filter(s => curPrefs().some(p => p.staffId === s.id));
  const notSubmitted = state.staff.filter(s => !curPrefs().some(p => p.staffId === s.id));
  wrap.appendChild(el("div", { class: "grid grid-cols-2 gap-3" }, [
    el("div", { class: "bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm" }, [
      el("div", { class: "font-semibold text-emerald-900" }, `提出済 ${submitted.length}/${state.staff.length}`),
      el("div", { class: "text-emerald-800 mt-1" }, submitted.map(s => s.name).join("・") || "—"),
    ]),
    el("div", { class: "bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm" }, [
      el("div", { class: "flex items-center justify-between" }, [
        el("div", { class: "font-semibold text-amber-900" }, `未提出 ${notSubmitted.length}名`),
        notSubmitted.length > 0 ? el("button", {
          class: "text-xs bg-amber-500 hover:bg-amber-600 text-white rounded px-2 py-1 font-semibold",
          onclick: () => openReminderDialog(notSubmitted),
        }, "📣 催促 LINE 文") : null,
      ]),
      el("div", { class: "text-amber-800 mt-1" }, notSubmitted.map(s => s.name).join("・") || "✓ 全員提出済み"),
    ]),
  ]));

  // スタッフからのコメント表示 (Round 1 改善)
  const week = curWeek();
  const staffComments = (week && week.staffComments) || {};
  const allComments = [];
  for (const [staffId, dateMap] of Object.entries(staffComments)) {
    const staff = state.staff.find(s => s.id === staffId);
    if (!staff || !dateMap) continue;
    for (const [date, text] of Object.entries(dateMap)) {
      if (!text) continue;
      allComments.push({ staffName: staff.name, date, text });
    }
  }
  if (allComments.length > 0) {
    allComments.sort((a, b) => a.date.localeCompare(b.date));
    const cmtCard = el("div", { class: "bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm" });
    cmtCard.appendChild(el("div", { class: "font-semibold text-blue-900 mb-2" }, `💬 スタッフからのメモ (${allComments.length}件)`));
    const list = el("div", { class: "space-y-1.5 text-xs text-blue-900" });
    for (const c of allComments) {
      const row = el("div", { class: "bg-white/60 border border-blue-100 rounded p-2" });
      row.innerHTML = `<span class="font-semibold">${escapeHtml(c.staffName)}</span> <span class="text-blue-700">${escapeHtml(c.date.slice(5))}</span>: ${escapeHtml(c.text)}`;
      list.appendChild(row);
    }
    cmtCard.appendChild(list);
    wrap.appendChild(cmtCard);
  }

  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));

  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4" });
  card.appendChild(el("div", { class: "font-semibold mb-1" }, "希望入力（管理側で代理入力）"));
  card.appendChild(el("div", { class: "text-xs text-slate-500 mb-3" },
    "通常はスタッフ自身がモバイルで入力します（上の「LINE用 全員リンク生成」ボタンを使用）"));

  const select = el("select", { class: "border rounded-md px-3 py-2 text-sm w-full mb-3" });
  state.staff.forEach(s => select.appendChild(el("option", { value: s.id }, s.name)));
  card.appendChild(select);

  const grid = el("div", { class: "space-y-2" });
  function refreshGrid(staffId) {
    grid.innerHTML = "";
    days.forEach(d => {
      const dow = dayOfWeek(d);
      const dayLabel = `${d.slice(5)} (${DAY_LABELS[dow]})`;
      const row = el("div", { class: "flex items-center gap-2 text-sm bg-slate-50 rounded-md p-2 flex-wrap" });
      row.appendChild(el("div", { class: "w-20 font-medium text-slate-700" }, dayLabel));
      for (const sess of state.meta.sessions) {
        const cur = curPrefs().find(p => p.staffId === staffId && p.date === d && p.startTime === sess.startTime && p.endTime === sess.endTime);
        const cls = cur
          ? (cur.priority === "must"  ? "bg-red-100 border-red-300 text-red-800"
            : cur.priority === "avoid" ? "bg-slate-200 border-slate-300 text-slate-600 line-through"
            : "bg-emerald-100 border-emerald-300 text-emerald-800")
          : "bg-white border-slate-300 text-slate-500";
        const btn = el("button", {
          class: `text-xs px-2.5 py-1 rounded-md border ${cls}`,
          onclick: () => {
            const order = ["want", "must", "avoid", "none"];
            const cur2 = curPrefs().find(p => p.staffId === staffId && p.date === d && p.startTime === sess.startTime && p.endTime === sess.endTime);
            const idx = cur2 ? order.indexOf(cur2.priority) : -1;
            const next = order[(idx + 1) % 4];
            curWeek().preferences = curPrefs().filter(p => !(p.staffId === staffId && p.date === d && p.startTime === sess.startTime && p.endTime === sess.endTime));
            if (next !== "none") {
              curWeek().preferences.push({ id: uid("p_"), staffId, date: d, startTime: sess.startTime, endTime: sess.endTime, priority: next });
            }
            persist(); refreshGrid(staffId);
          }
        }, sess.label);
        row.appendChild(btn);
      }
      grid.appendChild(row);
    });
    grid.appendChild(el("div", { class: "text-xs text-slate-500 pt-2" },
      "タップで [未入力 → 希望 → 必須 → 入りたくない] を切替"));
  }
  select.onchange = () => refreshGrid(select.value);
  refreshGrid(state.staff[0]?.id);
  card.appendChild(grid);
  wrap.appendChild(card);
  return wrap;
}

// ===== View: Schedule =====
function viewSchedule() {
  const wrap = el("div", { class: "space-y-4" });

  // Round 30: フェーズ判定 (空 / 編成中 / 確定済)
  const phase = curAssignments().length === 0
    ? "empty"
    : (curStatus() === "published" ? "published" : "drafting");

  // フェーズインジケーター
  const phases = [
    { id: "empty", label: "1. 編成開始", icon: "📝" },
    { id: "drafting", label: "2. 編成中", icon: "✏️" },
    { id: "published", label: "3. 確定済", icon: "✓" },
  ];
  const phaseBar = el("div", { class: "bg-slate-50 dark:bg-slate-800 rounded-md p-2 flex items-center justify-between" });
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    const curIdx = phases.findIndex(x => x.id === phase);
    const isActive = p.id === phase;
    const isPast = i < curIdx;
    const cls = isActive ? "bg-brand-600 text-white"
              : isPast ? "bg-emerald-100 text-emerald-700"
              : "bg-white dark:bg-slate-700 text-slate-500";
    phaseBar.appendChild(el("div", { class: `flex-1 text-center py-2 px-2 rounded-md mx-0.5 text-xs font-semibold ${cls}` },
      `${p.icon} ${p.label}${isPast ? " ✓" : ""}`));
    if (i < phases.length - 1) {
      phaseBar.appendChild(el("span", { class: "text-slate-400 mx-1" }, "→"));
    }
  }
  wrap.appendChild(phaseBar);

  // モバイル D&D ヒント (Round 17 TOP 3) — 一度だけ表示
  const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const TOUCH_HINT_KEY = "shifty.schedule.touchHintSeen";
  if (isTouchDevice && curStatus() === "draft" && curAssignments().length > 0
      && !localStorage.getItem(TOUCH_HINT_KEY)) {
    const hint = el("div", { class: "bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs flex items-start gap-2" });
    hint.innerHTML = `
      <span class="text-blue-600 text-base">📱</span>
      <div class="flex-1">
        <div class="font-semibold text-blue-900">モバイルでもシフトを動かせます</div>
        <div class="text-blue-800 mt-0.5">シフトを <b>長押し</b> → 別のシフトへドラッグして離すと入替できます。</div>
      </div>
      <button class="text-blue-600 hover:text-blue-800 text-xs px-2"
        onclick="localStorage.setItem('${TOUCH_HINT_KEY}', '1'); this.closest('div').remove();">×</button>`;
    wrap.appendChild(hint);
  }

  // Round 30: 空状態の場合は AI 生成 CTA を大きく表示
  if (phase === "empty") {
    const cta = el("div", { class: "bg-gradient-to-br from-brand-50 to-amber-50 dark:from-brand-900/30 dark:to-amber-900/30 border border-brand-200 rounded-xl p-6 text-center space-y-3" });
    cta.innerHTML = `
      <div class="text-5xl">🤖</div>
      <h3 class="font-bold text-lg">AI でシフトを自動生成</h3>
      <p class="text-sm text-slate-600 dark:text-slate-400 max-w-md mx-auto">
        ${state.staff.length} 名のスタッフ × ${curSlots().reduce((s, x) => s + x.requiredCount, 0)} 枠を最適配置。
        スタッフの希望・労務ルール・人件費を考慮して 5 秒で計算します。
      </p>`;
    const aiBtn = el("button", {
      class: "bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-6 py-3 text-base font-bold shadow-lg",
      onclick: autoGenerate,
    }, "🤖 AI 自動生成を実行 (推奨)");
    cta.appendChild(aiBtn);
    cta.appendChild(el("div", { class: "flex justify-center gap-2 flex-wrap text-xs" }, [
      el("button", { class: "text-slate-600 hover:text-slate-900 underline decoration-dotted",
        onclick: copyFromPreviousWeek }, "📋 先週からコピー"),
      el("button", { class: "text-slate-600 hover:text-slate-900 underline decoration-dotted",
        onclick: openTemplateDialog }, "📑 テンプレを使う"),
    ]));
    wrap.appendChild(cta);
    if (state.staff.length === 0) {
      wrap.appendChild(el("div", { class: "bg-amber-50 border border-amber-200 rounded p-3 text-sm" },
        "⚠️ スタッフが未登録です。「👥 スタッフ&希望」タブから先にスタッフを追加してください。"));
    }
    return wrap;
  }

  // Round 32 TOP 2: ヘッダー整理 — 第一級ボタンを大きく、二級は「⋮ もっと」に格納
  const headerRow = el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, phase === "published" ? "📅 シフト (確定済)" : "📅 シフト編成"),
    el("div", { class: "flex gap-2 flex-wrap items-center" }, [
      // 第一級: 入替モード (頻繁に使う)
      el("button", {
        class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 " + (swapModeActive ? "bg-amber-500 text-white border-amber-500 hover:bg-amber-600" : ""),
        onclick: toggleSwapMode,
        title: "タップでスタッフ入替（モバイル対応）",
      }, swapModeActive ? "🔁 入替モード ON" : "🔁 入替"),
      // ⋮ もっと メニュー
      (() => {
        const wrap = el("div", { class: "relative inline-block" });
        const btn = el("button", {
          class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700",
          title: "他のアクション",
          onclick: (e) => {
            e.stopPropagation();
            const dd = wrap.querySelector(".more-dropdown");
            if (dd) dd.classList.toggle("hidden");
          },
        }, "⋮ もっと");
        wrap.appendChild(btn);
        const dd = el("div", { class: "more-dropdown hidden absolute top-full right-0 mt-1 w-56 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-30" });
        // クリア
        const btnClear = el("button", {
          class: "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700",
          onclick: () => {
            dd.classList.add("hidden");
            if (curStatus() === "published") { toast("確定済の週はクリアできません。先に「下書きに戻す」してください。", "error"); return; }
            const n = curAssignments().length;
            if (n === 0) { toast("クリア対象がありません", "info"); return; }
            if (!confirm(`今週の AI 生成シフト ${n} 件を全削除しますか？\nこの操作は取り消せません（希望データは残ります）。`)) return;
            curWeek().assignments = []; persist(); render(); toast(`${n} 件をクリアしました`);
          },
        }, "🗑 シフトをクリア");
        dd.appendChild(btnClear);
        // 先週からコピー
        dd.appendChild(el("button", {
          class: "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700",
          onclick: () => { dd.classList.add("hidden"); copyFromPreviousWeek(); },
        }, "📋 先週からコピー"));
        // テンプレ
        dd.appendChild(el("button", {
          class: "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700",
          onclick: () => { dd.classList.add("hidden"); openTemplateDialog(); },
        }, "📑 シフトテンプレ"));
        // 4 週表示
        dd.appendChild(el("button", {
          class: "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700",
          onclick: () => { dd.classList.add("hidden"); toggleMultiWeekView(); },
        }, multiWeekView ? "📆 4週表示 (現在 ON)" : "📆 4週表示"));
        // 印刷
        if (curAssignments().length > 0) {
          dd.appendChild(el("button", {
            class: "block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 border-t border-slate-100 dark:border-slate-700",
            onclick: () => { dd.classList.add("hidden"); openPrintMenuDialog(); },
          }, "🖨️ 印刷ビュー"));
        }
        wrap.appendChild(dd);
        // クリック外で閉じる
        document.addEventListener("click", (e) => {
          if (!wrap.contains(e.target)) dd.classList.add("hidden");
        }, { once: true });
        return wrap;
      })(),
      // Round 24 TOP 3: AI 戦略ピッカー
      (() => {
        const PRESETS_QUICK = {
          "balanced":   { emoji: "⚖️", label: "バランス" },
          "preference": { emoji: "😊", label: "希望優先" },
          "cost":       { emoji: "💴", label: "コスト" },
          "skill":      { emoji: "🌟", label: "スキル" },
          "fairness":   { emoji: "🤝", label: "公平性" },
        };
        const PRESET_WEIGHTS = {
          "balanced":   { preference: 0.38, positionMatch: 0.14, fairness: 0.18, cost: 0.12, skill: 0.10, skillMix: 0.08 },
          "preference": { preference: 0.55, positionMatch: 0.10, fairness: 0.13, cost: 0.05, skill: 0.10, skillMix: 0.07 },
          "cost":       { preference: 0.22, positionMatch: 0.13, fairness: 0.13, cost: 0.35, skill: 0.10, skillMix: 0.07 },
          "skill":      { preference: 0.27, positionMatch: 0.18, fairness: 0.13, cost: 0.10, skill: 0.20, skillMix: 0.12 },
          "fairness":   { preference: 0.27, positionMatch: 0.10, fairness: 0.38, cost: 0.10, skill: 0.08, skillMix: 0.07 },
        };
        // 現在の重みからプリセットを判定 (近似一致)
        const aw = state.meta.algorithmWeights || {};
        let curKey = "balanced";
        for (const [k, w] of Object.entries(PRESET_WEIGHTS)) {
          if (Math.abs((aw.preference || 0) - w.preference) < 0.05
              && Math.abs((aw.fairness || 0) - w.fairness) < 0.05
              && Math.abs((aw.cost || 0) - w.cost) < 0.05) {
            curKey = k; break;
          }
        }
        const sel = el("select", {
          class: "text-sm border rounded-md px-2 py-1.5 bg-white",
          title: "AI 戦略を切替 (詳細は設定タブ)",
          onchange: () => {
            const newKey = sel.value;
            const w = PRESET_WEIGHTS[newKey];
            if (!w) return;
            state.meta.algorithmWeights = { ...w };
            persist();
            toast(`✓ AI 戦略「${PRESETS_QUICK[newKey].emoji} ${PRESETS_QUICK[newKey].label}」に切替`, "success");
          },
        });
        for (const [k, p] of Object.entries(PRESETS_QUICK)) {
          const opt = el("option", { value: k }, `${p.emoji} ${p.label}`);
          if (k === curKey) opt.selected = true;
          sel.appendChild(opt);
        }
        return sel;
      })(),
      el("button", { class: "text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md px-3 py-1.5",
        onclick: autoGenerate }, "🤖 AI自動生成"),
    ]),
  ]);
  wrap.appendChild(headerRow);

  // スタッフ別フィルタ (Round 8) — シフトが生成済みのとき
  if (curAssignments().length > 0 && state.staff.length > 1) {
    const filterRow = el("div", { class: "bg-white border border-slate-200 rounded-lg p-2 flex items-center gap-2 flex-wrap text-sm" });
    filterRow.appendChild(el("span", { class: "text-xs text-slate-600 font-semibold" }, "🔍 表示フィルタ:"));
    const sel = el("select", {
      class: "border rounded px-2 py-1 text-sm",
      onchange: (e) => setStaffFilter(e.target.value),
    });
    sel.appendChild(el("option", { value: "all" }, `全スタッフ (${state.staff.length} 名)`));
    state.staff.forEach(s => {
      const opt = el("option", { value: s.id }, s.name);
      if (staffFilter === s.id) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    });
    filterRow.appendChild(sel);
    if (staffFilter !== "all") {
      const filterStaff = state.staff.find(s => s.id === staffFilter);
      const myAss = curAssignments().filter(a => a.staffId === staffFilter);
      const myH = myAss.reduce((sum, a) => sum + calcHours(a.startTime, a.endTime), 0);
      filterRow.appendChild(el("span", { class: "text-xs text-slate-700" },
        `${filterStaff?.name}: ${myAss.length} シフト・${myH.toFixed(1)}h`));
      filterRow.appendChild(el("button", {
        class: "ml-auto text-xs text-slate-500 hover:text-slate-700 underline",
        onclick: () => setStaffFilter("all"),
      }, "✕ クリア"));
    }
    wrap.appendChild(filterRow);
  }

  if (swapModeActive) {
    wrap.appendChild(el("div", { class: "bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900" }, [
      el("div", { class: "font-semibold" }, "🔁 入替モード"),
      el("div", { class: "text-xs mt-1" },
        swapModeSourceId
          ? "もう一つのシフトをタップすると入替されます。もう一度同じシフトをタップで解除。"
          : "入れ替えたい 1 つ目のシフトをタップしてください。"),
    ]));
  }

  // 今週の店長お知らせ (Round 9) — 確定通知 / iCal / 印刷に反映
  const noticeCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3 no-print" });
  noticeCard.appendChild(el("details", {}, [
    el("summary", { class: "text-sm font-semibold cursor-pointer select-none" },
      "📢 今週のお知らせ" + (curWeek().ownerNotice ? " ✓" : " (店長 → 全スタッフ)")),
    el("div", { class: "mt-2 space-y-2" }, [
      el("textarea", {
        id: "owner-notice",
        class: "w-full border rounded-md px-3 py-2 text-sm",
        rows: "3",
        maxlength: "500",
        placeholder: "例: 今週は GW のため売上目標 200% / 18 時以降は人手不足のため積極的に入って欲しい / 月末に賞与あります 等",
        oninput: () => {
          const v = $("#owner-notice").value.slice(0, 500);
          curWeek().ownerNotice = v;
          // 自動保存タイマー
          if (window._noticeTimer) clearTimeout(window._noticeTimer);
          window._noticeTimer = setTimeout(() => persist(), 800);
        },
      }, curWeek().ownerNotice || ""),
      el("div", { class: "text-[10px] text-slate-500" },
        "ここに書いた内容は LINE 通知文・確定メール・印刷シフト・スタッフポータルに自動表示されます。最大 500 文字。"),
    ]),
  ]));
  wrap.appendChild(noticeCard);

  // Publish / unpublish controls
  const pubBox = el("div", {});
  if (curStatus() === "draft") {
    pubBox.className = "bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2";
    pubBox.appendChild(el("div", { class: "text-sm text-amber-900" }, [
      el("div", { class: "font-semibold" }, "📝 この週は下書き状態"),
      el("div", { class: "text-xs" }, "「確定する」を押すと、スタッフがポータルで自分のシフトを閲覧できるようになります。"),
    ]));
    pubBox.appendChild(el("button", { class: "text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-4 py-2 font-semibold",
      onclick: () => publishWeek() }, "✓ 確定する"));
  } else {
    pubBox.className = "bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2";
    pubBox.appendChild(el("div", { class: "text-sm text-emerald-900" }, [
      el("div", { class: "font-semibold" }, `✓ 確定済 (${curWeek().publishedAt?.slice(0, 16) || ""})`),
      el("div", { class: "text-xs" }, "スタッフはポータルから自分のシフトを閲覧中。変更したい場合は「下書きに戻す」してください。"),
    ]));
    pubBox.appendChild(el("div", { class: "flex gap-2 flex-wrap" }, [
      el("button", { class: "text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1.5",
        onclick: () => openLineNotificationDialog() }, "💬 LINE通知文"),
      el("button", { class: "text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md px-3 py-1.5",
        onclick: () => sendShiftEmails() }, "📧 メール一斉送信"),
      el("button", { class: "text-sm border border-emerald-700 text-emerald-700 rounded-md px-3 py-1.5",
        onclick: () => unpublishWeek() }, "下書きに戻す"),
    ]));
  }
  wrap.appendChild(pubBox);

  if (curAssignments().length) {
    // 検証レポート（最新生成のもの）
    if (state._lastAudit) wrap.appendChild(renderAuditReport(state._lastAudit));

    const m = calcMetrics(
      { hours: aggregateHours(), byStaff: aggregateByStaff(), assignments: curAssignments(), unfilled: getUnfilled() },
      { staff: state.staff, slots: curSlots(), preferences: curPrefs() });
    const cost = m.totalCost;
    const ratio = state.meta.weeklyBudget > 0 ? cost / state.meta.weeklyBudget : 0;
    const gaugeColor = ratio >= 1 ? "#dc2626" : ratio >= 0.85 ? "#f59e0b" : "#10b981";
    const ms = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm" });
    ms.innerHTML = `
      <div><div class="text-slate-500 text-xs">カバー率</div><div class="text-lg font-bold ${m.coverageRate < 1 ? "text-amber-600" : "text-emerald-600"}">${fmtPct(m.coverageRate)}</div></div>
      <div><div class="text-slate-500 text-xs">希望充足</div><div class="text-lg font-bold">${fmtPct(m.preferenceSatisfaction)}</div></div>
      <div><div class="text-slate-500 text-xs">人件費</div><div class="text-lg font-bold ${ratio >= 1 ? "text-red-600" : ""}">${fmtYen(cost)}</div></div>
      <div><div class="text-slate-500 text-xs">予算消化</div>
        <div class="gauge-bar mt-2"><div style="width:${Math.min(100, ratio * 100)}%;background:${gaugeColor}"></div></div>
        <div class="text-xs mt-1 text-slate-600">${fmtPct(Math.min(2, ratio))}</div>
      </div>`;
    wrap.appendChild(ms);

    if (m.unfilled && m.unfilled.length) {
      const ul = el("div", { class: "bg-red-50 border border-red-200 rounded-xl p-3 text-sm" });
      ul.appendChild(el("div", { class: "font-semibold text-red-900 mb-1" }, `⚠️ 未充足 ${m.unfilled.length}件`));
      ul.appendChild(el("div", { class: "text-red-800 text-xs" },
        m.unfilled.slice(0, 5).map(s => `${s.date.slice(5)}(${DAY_LABELS[dayOfWeek(s.date)]}) ${posCfg(s.position).label} ${s.startTime}〜`).join(" / ")));
      wrap.appendChild(ul);
    }
  }

  if (multiWeekView) {
    wrap.appendChild(renderMultiWeekView());
  } else {
    wrap.appendChild(renderCalendar());
  }
  if (curAssignments().length) wrap.appendChild(renderStaffSummary());

  // 変更履歴 (Round 11) — このタブで一覧表示
  const changeLog = curWeek().changeLog || [];
  if (changeLog.length > 0) {
    const logCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3 no-print" });
    logCard.appendChild(el("details", {}, [
      el("summary", { class: "text-sm font-semibold cursor-pointer select-none" },
        `📜 変更履歴 (${changeLog.length} 件)`),
      el("div", { class: "mt-3 space-y-1 text-xs max-h-80 overflow-y-auto" }, changeLog.slice().reverse().map(log => {
        const TYPE_EMOJI = { publish: "✅", unpublish: "📝", delete: "🗑", swap: "🔄", substitute: "🆘", add: "➕", autogenerate: "🤖", note: "📝", vacation_approved: "🏖", vacation_rejected: "🏖", swap_approved: "🔄", swap_rejected: "🔄", swap_cancelled: "🔄" };
        const emoji = TYPE_EMOJI[log.type] || "📌";
        const ts = log.at ? new Date(log.at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        const row = el("div", { class: "flex items-start gap-2 bg-slate-50 rounded p-2" });
        row.innerHTML = `
          <span>${emoji}</span>
          <div class="flex-1">
            <div class="font-medium">${escapeHtml(log.message || log.type || "")}</div>
            <div class="text-[10px] text-slate-500">${ts}</div>
          </div>`;
        return row;
      })),
    ]));
    wrap.appendChild(logCard);
  }
  if ((curWeek().changeLog || []).length) wrap.appendChild(renderChangeLog());
  return wrap;
}

function renderChangeLog() {
  const log = curWeek().changeLog || [];
  const sorted = [...log].reverse(); // 新しい順
  const card = el("details", { class: "bg-white border border-slate-200 rounded-xl p-4" });
  const summary = el("summary", { class: "font-semibold cursor-pointer flex items-center justify-between" });
  summary.innerHTML = `<span>📜 変更履歴 <span class="text-xs text-slate-500 font-normal">(${log.length}件)</span></span><span class="text-xs text-slate-400">クリックで開閉 ▾</span>`;
  card.appendChild(summary);
  const list = el("div", { class: "mt-3 space-y-1.5 text-xs" });
  const TYPE_LABEL = {
    publish: "✅ 確定", unpublish: "📝 下書きに戻す", delete: "🗑 削除",
    swap: "🔄 入替", substitute: "🆘 代打", add: "➕ 追加",
    autogenerate: "🤖 AI生成", note: "📝 メモ更新",
    vacation_approved: "🏖 休暇承認", vacation_rejected: "🏖 休暇却下",
    swap_approved: "🔄 交換承認", swap_rejected: "🔄 交換却下", swap_cancelled: "🔄 交換取消",
  };
  sorted.forEach(entry => {
    const at = new Date(entry.at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const row = el("div", { class: "flex items-start gap-2 border-b border-slate-100 pb-1.5" });
    row.innerHTML = `
      <span class="text-slate-400 w-20 flex-none">${at}</span>
      <span class="font-medium w-24 flex-none">${TYPE_LABEL[entry.type] || entry.type}</span>
      <span class="flex-1 text-slate-700">${escapeHtml(entry.detail || "")}</span>
    `;
    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}

// Round 23 TOP 3: 確定前ヘルスチェック
function renderPublishHealthCheck() {
  const checks = [];
  const ass = curAssignments();
  const slots = curSlots();
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));

  // 1. 不足コマ
  let unfilledN = 0;
  for (const sl of slots) {
    const filled = ass.filter(a => a.date === sl.date && a.position === sl.position && a.startTime === sl.startTime && a.endTime === sl.endTime).length;
    unfilledN += Math.max(0, sl.requiredCount - filled);
  }
  checks.push({
    id: "unfilled",
    pass: unfilledN === 0,
    label: "シフト不足コマ",
    detail: unfilledN === 0 ? "すべて充足" : `${unfilledN} コマ不足`,
    severity: unfilledN === 0 ? "ok" : (unfilledN <= 2 ? "warn" : "danger"),
  });

  // 2. 予算超過
  const totalCost = ass.reduce((s, a) => s + (a.cost || 0), 0);
  const budget = state.meta.weeklyBudget || 0;
  const overBudget = budget > 0 && totalCost > budget;
  checks.push({
    id: "budget",
    pass: !overBudget,
    label: "週予算",
    detail: budget === 0 ? "予算未設定" : `${fmtYen(Math.round(totalCost))} / ${fmtYen(budget)} ${overBudget ? `(超過 ${fmtYen(Math.round(totalCost - budget))})` : ""}`,
    severity: !budget ? "info" : (overBudget ? (totalCost > budget * 1.2 ? "danger" : "warn") : "ok"),
  });

  // 3. 労務上限近接 (週上限 95% 以上のスタッフ)
  const lr = state.meta.laborRules || {};
  const overLaborStaff = [];
  for (const s of state.staff) {
    if (s.archived) continue;
    const myH = ass.filter(a => a.staffId === s.id).reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const cap = Math.min(s.maxHoursPerWeek || Infinity, lr.maxHoursPerWeek || Infinity);
    if (cap > 0 && myH >= cap * 0.95) overLaborStaff.push(`${s.name}(${myH.toFixed(0)}/${cap}h)`);
  }
  checks.push({
    id: "labor",
    pass: overLaborStaff.length === 0,
    label: "週時間上限",
    detail: overLaborStaff.length === 0 ? "全員 95% 未満" : `近接 ${overLaborStaff.length} 名 (${overLaborStaff.slice(0, 2).join(", ")})`,
    severity: overLaborStaff.length === 0 ? "ok" : "warn",
  });

  // 4. 連勤超過 (5 連勤以上のスタッフ)
  const consecMax = lr.maxConsecutiveDays || 5;
  const longStreakStaff = [];
  for (const s of state.staff) {
    if (s.archived) continue;
    const dates = ass.filter(a => a.staffId === s.id).map(a => a.date);
    const uniqDates = Array.from(new Set(dates)).sort();
    let streak = 0, maxStreak = 0, prev = null;
    for (const d of uniqDates) {
      if (prev && new Date(d) - new Date(prev) === 86400000) streak++;
      else streak = 1;
      maxStreak = Math.max(maxStreak, streak);
      prev = d;
    }
    if (maxStreak >= consecMax) longStreakStaff.push(`${s.name}(${maxStreak}日連勤)`);
  }
  checks.push({
    id: "consec",
    pass: longStreakStaff.length === 0,
    label: "連勤上限",
    detail: longStreakStaff.length === 0 ? `全員 ${consecMax} 日未満` : longStreakStaff.slice(0, 2).join(", "),
    severity: longStreakStaff.length === 0 ? "ok" : "warn",
  });

  // 5. 新人だけのコマ (skill 平均 < 2.5)
  const lowSkillSlots = [];
  for (const sl of slots) {
    if (sl.requiredCount < 2) continue;
    const inSlot = ass.filter(a => a.date === sl.date && a.position === sl.position && a.startTime === sl.startTime && a.endTime === sl.endTime);
    if (inSlot.length < 2) continue;
    const skills = inSlot.map(a => {
      const s = state.staff.find(x => x.id === a.staffId);
      if (!s) return 1;
      return (s.skills && s.skills[sl.position]) || s.skill || 1;
    });
    const avg = skills.reduce((a, b) => a + b, 0) / skills.length;
    if (avg < 2.5) lowSkillSlots.push(`${sl.date.slice(5)} ${sl.startTime} ${posCfg(sl.position).label}`);
  }
  checks.push({
    id: "skillmix",
    pass: lowSkillSlots.length === 0,
    label: "スキル構成",
    detail: lowSkillSlots.length === 0 ? "ベテラン×新人バランス OK" : `新人ばかり ${lowSkillSlots.length} コマ (${lowSkillSlots.slice(0, 2).join(" / ")})`,
    severity: lowSkillSlots.length === 0 ? "ok" : (lowSkillSlots.length > 5 ? "danger" : "warn"),
  });

  // 6. 希望未提出のスタッフ
  const submitted = new Set((curPrefs() || []).map(p => p.staffId));
  const noSubmit = state.staff.filter(s => !s.archived && !submitted.has(s.id));
  checks.push({
    id: "submit",
    pass: noSubmit.length === 0,
    label: "希望提出",
    detail: noSubmit.length === 0 ? "全員提出済み" : `未提出 ${noSubmit.length} 名 (${noSubmit.slice(0, 2).map(s => s.name).join(", ")})`,
    severity: noSubmit.length === 0 ? "ok" : "info",
  });

  // 7. 固定出勤未配置
  const missingFixed = [];
  for (const s of state.staff) {
    if (s.archived || !s.fixedShifts || s.fixedShifts.length === 0) continue;
    for (const fs of s.fixedShifts) {
      const sess = (state.meta.sessions || []).find(x => x.id === fs.sessionId);
      if (!sess) continue;
      // 該当日付を探す
      for (const d of days) {
        if (dayOfWeek(d) !== fs.dow) continue;
        const placed = ass.find(a => a.staffId === s.id && a.date === d &&
          a.startTime === sess.startTime && a.endTime === sess.endTime);
        if (!placed) {
          missingFixed.push(`${s.name}/${["日","月","火","水","木","金","土"][fs.dow]}${sess.label}`);
        }
      }
    }
  }
  checks.push({
    id: "fixed",
    pass: missingFixed.length === 0,
    label: "固定出勤",
    detail: missingFixed.length === 0 ? "全配置済" : `未配置 ${missingFixed.length} 件 (${missingFixed.slice(0, 2).join(", ")})`,
    severity: missingFixed.length === 0 ? "ok" : "warn",
  });

  // 8. メール未登録 (active staff のみ)
  const activeStaff = state.staff.filter(s => !s.archived);
  const noEmailN = activeStaff.filter(s => !(s.email || "").trim() && !(s.webhookUrl || "").trim()).length;
  checks.push({
    id: "contact",
    pass: noEmailN === 0,
    label: "連絡先登録",
    detail: noEmailN === 0 ? `全員メール/Webhook 登録済` : `未登録 ${noEmailN}/${activeStaff.length} 名`,
    severity: noEmailN === 0 ? "ok" : "info",
  });

  const passN = checks.filter(c => c.pass).length;
  const dangerN = checks.filter(c => c.severity === "danger").length;
  const warnN = checks.filter(c => c.severity === "warn").length;
  const headerLevel = dangerN > 0 ? "danger" : warnN > 0 ? "warn" : "ok";
  const headerColor = headerLevel === "danger" ? "bg-red-50 border-red-300"
                    : headerLevel === "warn"  ? "bg-amber-50 border-amber-300"
                    : "bg-emerald-50 border-emerald-300";
  const headerText = headerLevel === "danger" ? `🚨 重大な問題が ${dangerN} 件あります`
                   : headerLevel === "warn"   ? `⚠️ 注意点が ${warnN} 件あります`
                   : `✅ ヘルスチェック OK (${passN}/${checks.length})`;

  const card = el("div", { class: `${headerColor} border rounded-md p-3 space-y-1` });
  card.appendChild(el("div", { class: "font-semibold text-sm" }, headerText));
  const list = el("div", { class: "text-xs space-y-0.5" });
  for (const c of checks) {
    const icon = c.severity === "danger" ? "🚨" : c.severity === "warn" ? "⚠️" : c.severity === "info" ? "ℹ️" : "✓";
    const cls = c.severity === "danger" ? "text-red-700"
             : c.severity === "warn" ? "text-amber-700"
             : c.severity === "info" ? "text-slate-600"
             : "text-emerald-700";
    list.appendChild(el("div", { class: `flex items-start gap-1 ${cls}` }, [
      el("span", {}, icon),
      el("span", { class: "font-semibold w-24 flex-none" }, c.label),
      el("span", { class: "flex-1" }, c.detail),
    ]));
  }
  card.appendChild(list);
  return card;
}

function publishWeek() {
  if (!curAssignments().length) { toast("シフトを生成してから確定してください", "error"); return; }
  // Round 3: 確定 + 通知統合フロー
  const withEmail = state.staff.filter(s => (s.email || "").trim() && !s.archived);
  const totalStaff = state.staff.filter(s => !s.archived).length;
  const noEmailCount = totalStaff - withEmail.length;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "✓ 今週のシフトを確定"));
  body.appendChild(el("p", { class: "text-sm text-slate-600" },
    "確定するとスタッフはポータルから自分のシフトを閲覧できるようになります。"));

  // Round 23: ヘルスチェック
  const healthCard = renderPublishHealthCheck();
  body.appendChild(healthCard);

  body.appendChild(el("div", { class: "bg-slate-50 rounded-md p-3 text-xs space-y-1" }, [
    el("div", {}, `📊 ${curAssignments().length} 件のアサインを確定`),
    el("div", { class: "text-emerald-700" }, `✉️ メール送信可能: ${withEmail.length}/${totalStaff} 名`),
    noEmailCount > 0 ? el("div", { class: "text-amber-600" }, `⚠️ メール未登録: ${noEmailCount} 名 (LINE 通知文を別途お渡しください)`) : null,
  ]));

  // 通知方法選択
  const cb = el("input", { type: "checkbox", id: "pub-send-mail", checked: withEmail.length > 0 ? "checked" : null });
  body.appendChild(el("label", { class: "flex items-center gap-2 text-sm" }, [
    cb,
    el("span", {}, `確定と同時に ${withEmail.length} 名へメール送信`),
  ]));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-semibold",
      onclick: async () => {
        const sendMail = $("#pub-send-mail").checked;
        const wasRepublish = curWeek().publishedAt;
        // 確定前に自動スナップショット (Round 17 TOP 1)
        try { createSnapshot("auto_publish", `確定前 (${state.meta.currentWeekStart})`); } catch (_) {}
        curWeek().status = "published";
        curWeek().publishedAt = new Date().toISOString();
        logChange("publish", wasRepublish ? "再確定" : "確定", { assignmentCount: curAssignments().length });
        await persist();
        closeModal(); render();
        toast("✓ 確定しました", "success");

        if (sendMail && withEmail.length > 0) {
          // メール送信実行
          try {
            toast("メール送信中…", "info");
            const r = await window.ShiftyAPI.notifyShifts(state.meta.currentWeekStart);
            if (r && r.sent) {
              toast(`✉️ ${r.sent} 名にメール送信完了 (失敗 ${(r.errors||[]).length}件)`, "success");
            }
          } catch (e) {
            toast("メール送信失敗: " + e.message + " — LINE通知文をご利用ください", "error");
          }
        }
        // LINE 通知文ダイアログを開く (メール未登録者 / メール送信しなかった場合の補完)
        setTimeout(openLineNotificationDialog, 600);
      },
    }, "✓ 確定する"),
  ]));
  modal(body);
}

function unpublishWeek() {
  if (!confirm("下書きに戻しますか？スタッフは閲覧できなくなります。")) return;
  curWeek().status = "draft";
  curWeek().publishedAt = null;
  logChange("unpublish", "下書きに戻す");
  persist(); render();
  toast("下書きに戻しました", "success");
}

async function sendShiftEmails() {
  const withEmail = state.staff.filter(s => (s.email || "").trim());
  if (!withEmail.length) {
    toast("メール登録済みのスタッフがいません。スタッフタブで email を設定してください。", "error");
    return;
  }
  if (!confirm(`${withEmail.length}名のスタッフにシフト確定メールを送信します。よろしいですか？`)) return;
  try {
    const r = await window.ShiftyAPI.notifyShifts(state.meta.currentWeekStart);
    if (r.sent === 0) {
      toast(`送信失敗: SMTP 未設定の可能性があります（LAUNCH.md 参照）`, "error");
    } else {
      toast(`✅ ${r.sent}名にメール送信しました${r.skipped_no_email ? ` (email未設定: ${r.skipped_no_email}名)` : ""}`, "success");
    }
  } catch (e) {
    toast("送信失敗: " + e.message, "error");
  }
}

async function openLineNotificationDialog() {
  // 全スタッフのトークンを取得
  let tokens = {};
  try {
    tokens = await window.ShiftyAPI.listStaffTokens();
    // 未生成のスタッフ用に生成
    for (const s of state.staff) {
      if (!tokens[s.id]) {
        const r = await window.ShiftyAPI.genStaffToken(s.id);
        tokens[s.id] = r.token;
      }
    }
  } catch (e) { toast("トークン取得失敗: " + e.message, "error"); return; }

  const w0 = state.meta.currentWeekStart;
  const wEnd = addDays(w0, 6);
  const ownerNotice = (curWeek().ownerNotice || "").trim();
  const lines = [
    `【シフト確定のお知らせ】`,
    `${state.meta.restaurantName}`,
    `期間: ${w0} 〜 ${wEnd}`,
    ``,
  ];
  // Round 9: 店長お知らせがあれば冒頭に挿入
  if (ownerNotice) {
    lines.push("📢 今週のお知らせ:");
    ownerNotice.split("\n").forEach(l => lines.push(l));
    lines.push("");
  }
  lines.push(`各自、下記URLから自分の今週のシフトを確認してください。`, ``);
  for (const s of state.staff) {
    const t = tokens[s.id];
    if (!t) continue;
    lines.push(`【${s.name}さん】`);
    lines.push(_staffPortalUrl(t));
    lines.push("");
  }
  const txt = lines.join("\n");

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💬 LINE通知文（コピーして送信）"));
  body.appendChild(el("p", { class: "text-xs text-slate-500" },
    "下記をコピーしてLINEグループに貼り付けてください。各スタッフは自分のリンクを開くと、自分のシフトのみが見られます。"));
  const ta = el("textarea", { class: "w-full border rounded-md p-2 text-xs font-mono h-72", readonly: "" }, txt);
  body.appendChild(ta);
  body.appendChild(el("div", { class: "flex justify-end gap-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", { class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md", onclick: async () => {
      try { await navigator.clipboard.writeText(txt); toast("コピーしました", "success"); }
      catch (_) { ta.select(); document.execCommand("copy"); toast("コピーしました", "success"); }
    } }, "📋 クリップボードにコピー"),
  ]));
  modal(body);
}

// 複数週まとめ表示 (Round 13) — 今週 + 翌 3 週分のサマリ
function renderMultiWeekView() {
  const wrap = el("div", { class: "space-y-3" });
  wrap.appendChild(el("div", { class: "bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900" },
    "📆 4 週まとめ表示中。各週カードをクリックでその週に切替。"));

  const w0 = state.meta.currentWeekStart;
  for (let i = 0; i < 4; i++) {
    const wkStart = addDays(w0, i * 7);
    const wkEnd = addDays(wkStart, 6);
    const week = (state.weeks || {})[wkStart];
    const isCurrent = wkStart === w0;
    const card = el("div", {
      class: `bg-white border rounded-xl p-3 ${isCurrent ? "border-brand-500 shadow" : "border-slate-200"} cursor-pointer hover:shadow`,
      onclick: () => goToWeek(wkStart),
    });
    const header = el("div", { class: "flex items-center justify-between mb-2" });
    header.appendChild(el("div", {}, [
      el("span", { class: "font-bold text-sm" }, `${wkStart.slice(5)} 〜 ${wkEnd.slice(5)}`),
      isCurrent ? el("span", { class: "ml-2 text-xs bg-brand-100 text-brand-700 px-2 py-0.5 rounded" }, "今週") : null,
    ]));
    if (week) {
      const status = week.status || "draft";
      header.appendChild(el("span", {
        class: `text-xs px-2 py-1 rounded ${status === "published" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`,
      }, status === "published" ? "✓ 確定済" : "📝 下書き"));
    } else {
      header.appendChild(el("span", { class: "text-xs text-slate-400" }, "未作成"));
    }
    card.appendChild(header);

    if (week && week.assignments && week.assignments.length > 0) {
      const assN = week.assignments.length;
      const totalH = week.assignments.reduce((s, a) => s + calcHours(a.startTime, a.endTime), 0);
      const totalCost = week.assignments.reduce((s, a) => s + (a.cost || 0), 0);
      const slots = week.slots || [];
      const reqN = slots.reduce((s, x) => s + x.requiredCount, 0);
      const cov = reqN ? (assN / reqN * 100).toFixed(0) : 0;
      card.appendChild(el("div", { class: "grid grid-cols-4 gap-2 text-center" }, [
        el("div", {}, [el("div", { class: "text-[10px] text-slate-500" }, "アサイン"), el("div", { class: "text-base font-bold" }, `${assN}/${reqN}`)]),
        el("div", {}, [el("div", { class: "text-[10px] text-slate-500" }, "カバー"), el("div", { class: "text-base font-bold text-emerald-600" }, `${cov}%`)]),
        el("div", {}, [el("div", { class: "text-[10px] text-slate-500" }, "時間"), el("div", { class: "text-base font-bold" }, `${totalH.toFixed(0)}h`)]),
        el("div", {}, [el("div", { class: "text-[10px] text-slate-500" }, "人件費"), el("div", { class: "text-base font-bold text-brand-700" }, fmtYen(totalCost))]),
      ]));

      // 該当週の希望未提出スタッフ
      const submitted = state.staff.filter(s => (week.preferences || []).some(p => p.staffId === s.id));
      const notSub = state.staff.filter(s => !submitted.includes(s));
      if (notSub.length > 0) {
        card.appendChild(el("div", { class: "mt-2 text-[11px] text-amber-700" },
          `📝 希望未提出: ${notSub.length} 名 (${notSub.slice(0,3).map(s => s.name).join("・")}${notSub.length > 3 ? ` 他${notSub.length-3}名` : ""})`));
      }
    } else {
      card.appendChild(el("div", { class: "text-xs text-slate-500 py-2 text-center" },
        week ? "シフト未生成" : "週未作成（クリックで作成）"));
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function renderCalendar() {
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const isMobile = window.innerWidth < 640;
  // モバイル時は縦スタック表示
  if (isMobile) return renderCalendarMobile(days);

  // Round 33 (Perf-2): セル単位のインデックスを事前構築
  // O(sessions × days × positions × N) → O(N) lookup に
  const ass = curAssignments();
  const slots = curSlots();
  const assByCellPos = new Map(); // key: `${date}|${startTime}|${pos}` → [a]
  for (const a of ass) {
    const key = `${a.date}|${a.startTime}|${a.position}`;
    let arr = assByCellPos.get(key); if (!arr) { arr = []; assByCellPos.set(key, arr); }
    arr.push(a);
  }
  const slotsByCell = new Map(); // key: `${date}|${startTime}` → [slot]
  for (const s of slots) {
    const key = `${s.date}|${s.startTime}`;
    let arr = slotsByCell.get(key); if (!arr) { arr = []; slotsByCell.set(key, arr); }
    arr.push(s);
  }
  const staffById = new Map(state.staff.map(s => [s.id, s]));
  const hasAssignments = ass.length > 0;

  const grid = el("div", { class: "cal-grid" });
  grid.appendChild(el("div", { class: "cal-cell head" }, ""));
  for (const d of days) {
    const dow = dayOfWeek(d);
    const holidayName = window.ShiftyData.getHoliday(d);
    const dowColor = holidayName ? "text-red-600 font-semibold" : (dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "");
    const headEl = el("div", { class: "cal-cell head" });
    headEl.appendChild(el("div", { class: dowColor }, `${d.slice(5)} (${DAY_LABELS[dow]})`));
    if (holidayName) {
      headEl.appendChild(el("div", { class: "text-[9px] text-red-600 font-normal mt-0.5", title: `祝日: ${holidayName}` }, `🎌 ${holidayName}`));
    }
    grid.appendChild(headEl);
  }

  for (const sess of state.meta.sessions) {
    grid.appendChild(el("div", { class: "cal-cell head" }, [
      el("div", {}, sess.label),
      el("div", { class: "text-[10px] font-normal text-slate-500" }, `${sess.startTime}〜`),
    ]));
    for (const d of days) {
      const cell = el("div", { class: "cal-cell" });
      const cellKey = `${d}|${sess.startTime}`;
      for (const pos of state.meta.positions) {
        const list = assByCellPos.get(`${cellKey}|${pos.id}`) || [];
        list.forEach(a => {
          const s = staffById.get(a.staffId);
          const cfg = posCfg(pos.id);
          const editable = curStatus() === "draft";
          const isSwapSource = swapModeActive && swapModeSourceId === a.id;
          const isFilteredOut = staffFilter !== "all" && a.staffId !== staffFilter;
          const chip = el("div", {
            class: "assignment-chip" + (editable ? " editable" : "") + (isSwapSource ? " swap-source" : "") + (swapModeActive ? " swap-mode" : "") + (isFilteredOut ? " opacity-25" : ""),
            draggable: (editable && !swapModeActive) ? "true" : "false",
            "data-assignment-id": a.id,
            style: { borderColor: cfg.color, touchAction: editable ? "pan-y" : "auto" },
            onclick: () => handleChipTap(a),
            ondragstart: editable ? (e) => handleChipDragStart(e, a) : null,
            ondragover: editable ? (e) => { e.preventDefault(); chip.classList.add("drop-target"); } : null,
            ondragleave: editable ? () => chip.classList.remove("drop-target") : null,
            ondrop: editable ? (e) => { chip.classList.remove("drop-target"); handleChipDrop(e, a); } : null,
            ondragend: () => $$(".assignment-chip").forEach(c => c.classList.remove("drop-target", "dragging")),
            // Round 17 TOP 3: Touch D&D サポート
            ontouchstart: editable ? (e) => handleChipTouchStart(e, a) : null,
            ontouchmove: editable ? (e) => handleChipTouchMove(e) : null,
            ontouchend: editable ? (e) => handleChipTouchEnd(e) : null,
            ontouchcancel: editable ? () => { _touchState = null; } : null,
          });
          const memoBadge = a.note ? `<span title="${escapeAttr(a.note)}" class="inline-block ml-1 text-[10px] bg-amber-200 text-amber-900 rounded px-1">📝</span>` : "";
          chip.innerHTML = `<div class="name">${escapeHtml(s?.name || "?")}${memoBadge}</div>
            <div class="time">${escapeHtml(cfg.label)} ${a.startTime.slice(0,5)}〜${a.endTime.slice(0,5)}</div>`;
          cell.appendChild(chip);
        });
      }
      const slotsInCell = slotsByCell.get(cellKey) || [];
      slotsInCell.forEach(slot => {
        const filledN = (assByCellPos.get(`${cellKey}|${slot.position}`) || []).length;
        const missing = slot.requiredCount - filledN;
        if (missing > 0 && hasAssignments) {
          // Round 21 TOP 2: 不足表示 + クイック追加ボタン
          const shortRow = el("div", { class: "text-[10px] mt-0.5 flex items-center justify-between gap-1 bg-red-50 rounded px-1 py-0.5" });
          shortRow.appendChild(el("span", { class: "text-red-600" },
            `不足: ${posCfg(slot.position).label} ×${missing}`));
          if (curStatus() === "draft") {
            shortRow.appendChild(el("button", {
              class: "text-[9px] bg-emerald-500 hover:bg-emerald-600 text-white rounded px-1.5 py-0.5 font-semibold whitespace-nowrap",
              onclick: () => openQuickAddDialog(d, sess, slot.position),
              title: "このコマにスタッフを追加",
            }, "+ 追加"));
          }
          cell.appendChild(shortRow);
        }
      });
      // クイック追加ボタン (Round 21 TOP 2) — どのセルでも常に表示 (draft時)
      if (curStatus() === "draft") {
        const tools = el("div", { class: "flex items-center gap-1 mt-1" });
        tools.appendChild(el("button", {
          class: "text-[10px] text-emerald-700 hover:bg-emerald-50 border border-emerald-300 rounded px-1.5 py-0.5",
          title: "このセッションにスタッフを直接追加",
          onclick: () => openQuickAddDialog(d, sess, null),
        }, "＋ アサイン追加"));
        tools.appendChild(el("button", {
          class: "text-[10px] text-slate-400 hover:text-slate-700 underline decoration-dotted",
          title: "この日のセッションの必要人数を編集",
          onclick: () => openSlotAdjustDialog(d, sess),
        }, "⚙️ 人数"));
        cell.appendChild(tools);
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

// クイックアサイン追加ダイアログ (Round 21 TOP 2)
function openQuickAddDialog(date, sess, suggestedPosition) {
  if (curStatus() !== "draft") {
    toast("確定済では追加できません。先に下書きに戻してください", "error"); return;
  }
  const positions = state.meta.positions || [];
  // 候補スタッフを評価
  const dow = dayOfWeek(date);
  function _t(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  function isOverlapWithExisting(staffId, startT, endT) {
    return curAssignments().some(a =>
      a.staffId === staffId && a.date === date &&
      _t(a.startTime) < _t(endT) && _t(startT) < _t(a.endTime)
    );
  }
  function evaluateStaff(s, posId, startT, endT) {
    const reasons = [];
    let score = 100;
    // ポジション適合
    if (s.position !== posId && !(s.canCover || []).includes(posId)) {
      return { score: -1, reasons: ["❌ ポジション不適合"], blocked: true };
    }
    if (s.position === posId) { score += 50; reasons.push("✓ 本職"); }
    else { score += 10; reasons.push("○ 兼任可"); }
    // 固定休日
    if ((s.fixedDayOff || []).includes(dow)) {
      return { score: -1, reasons: ["❌ 固定休日"], blocked: true };
    }
    // 重複チェック
    if (isOverlapWithExisting(s.id, startT, endT)) {
      return { score: -1, reasons: ["❌ 既存シフトと時間重複"], blocked: true };
    }
    // 希望
    const myPrefs = curPrefs().filter(p => p.staffId === s.id && p.date === date);
    const want = myPrefs.find(p => p.priority === "want" && _t(p.startTime) <= _t(startT) && _t(endT) <= _t(p.endTime));
    const must = myPrefs.find(p => p.priority === "must" && _t(p.startTime) <= _t(startT) && _t(endT) <= _t(p.endTime));
    const avoid = myPrefs.find(p => p.priority === "avoid" && _t(p.startTime) < _t(endT) && _t(startT) < _t(p.endTime));
    if (must) { score += 80; reasons.push("🔥 必須希望"); }
    else if (want) { score += 50; reasons.push("✅ 希望あり"); }
    else if (avoid) { score -= 100; reasons.push("🚫 不可希望"); }
    // 週時間上限
    const wkHours = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const newHours = wkHours + (_t(endT) - _t(startT)) / 60;
    if (newHours > (s.maxHoursPerWeek || 40)) { score -= 50; reasons.push(`⚠️ 週上限超過 (${newHours.toFixed(1)}h/${s.maxHoursPerWeek}h)`); }
    else if (newHours < (s.minHoursPerWeek || 0)) { score += 30; reasons.push(`✓ 最低時間まだ未達`); }
    // 時給 (低いほど良い)
    score -= s.hourlyWage / 100;
    return { score, reasons, blocked: false };
  }

  let selPos = suggestedPosition || (positions[0]?.id);
  let selStart = sess.startTime;
  let selEnd = sess.endTime;
  let selStaffId = null;

  function refreshCandidates() {
    const list = state.staff
      .map(s => ({ s, ...evaluateStaff(s, selPos, selStart, selEnd) }))
      .sort((a, b) => b.score - a.score);
    return list;
  }

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "⚡ クイックアサイン追加"));
  body.appendChild(el("div", { class: "text-xs text-slate-600" },
    `${date} (${["日","月","火","水","木","金","土"][dow]}) の ${sess.label} (${sess.startTime}〜${sess.endTime}) にスタッフを追加`));

  // ポジション選択
  const posSelect = el("select", { id: "qa-pos", class: "w-full border rounded px-2 py-1 text-sm mt-1" });
  for (const p of positions) {
    const opt = el("option", { value: p.id }, p.label);
    if (p.id === selPos) opt.selected = true;
    posSelect.appendChild(opt);
  }
  posSelect.onchange = () => { selPos = posSelect.value; selStaffId = null; renderList(); };

  // 時間範囲
  function timeOptionsBetween(min, max) {
    const out = [];
    for (let m = _t(min); m <= _t(max); m += 30) {
      const h = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      out.push(`${h}:${mm}`);
    }
    return out;
  }
  const opts = timeOptionsBetween(sess.startTime, sess.endTime);
  const startSelect = el("select", { id: "qa-start", class: "w-full border rounded px-2 py-1 text-sm mt-1" });
  const endSelect = el("select", { id: "qa-end", class: "w-full border rounded px-2 py-1 text-sm mt-1" });
  for (const o of opts) {
    const optS = el("option", { value: o }, o);
    if (o === selStart) optS.selected = true;
    startSelect.appendChild(optS);
    const optE = el("option", { value: o }, o);
    if (o === selEnd) optE.selected = true;
    endSelect.appendChild(optE);
  }
  startSelect.onchange = () => { selStart = startSelect.value; renderList(); };
  endSelect.onchange = () => { selEnd = endSelect.value; renderList(); };

  body.appendChild(el("div", { class: "grid grid-cols-3 gap-2 text-sm" }, [
    el("label", { class: "block" }, [el("span", { class: "text-slate-600 text-xs" }, "ポジション"), posSelect]),
    el("label", { class: "block" }, [el("span", { class: "text-slate-600 text-xs" }, "開始"), startSelect]),
    el("label", { class: "block" }, [el("span", { class: "text-slate-600 text-xs" }, "終了"), endSelect]),
  ]));

  // 候補リスト
  body.appendChild(el("div", { class: "text-xs font-semibold text-slate-700 mt-2" }, "候補スタッフ (スコア順)"));
  const listWrap = el("div", { id: "qa-list", class: "space-y-1 max-h-64 overflow-y-auto" });
  body.appendChild(listWrap);

  function renderList() {
    listWrap.innerHTML = "";
    const list = refreshCandidates();
    for (const item of list) {
      const isBlocked = item.blocked;
      const isSelected = item.s.id === selStaffId;
      const row = el("button", {
        class: `w-full text-left border-2 rounded p-2 text-xs transition ${
          isSelected ? "border-emerald-600 bg-emerald-50" :
          isBlocked ? "border-slate-200 opacity-50" :
          "border-slate-200 hover:border-slate-400"
        }`,
        onclick: () => {
          if (isBlocked) return;
          selStaffId = item.s.id;
          renderList();
        },
        disabled: isBlocked,
      });
      const cfg = posCfg(item.s.position);
      row.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <span class="font-semibold">${escapeHtml(item.s.name)}</span>
            <span class="text-[10px] text-slate-500 ml-1">${escapeHtml(cfg.label)} ¥${item.s.hourlyWage}/h</span>
          </div>
          <div class="text-[10px] text-slate-600">スコア ${item.score.toFixed(0)}</div>
        </div>
        <div class="text-[10px] text-slate-600 mt-0.5">${item.reasons.join(" / ")}</div>`;
      listWrap.appendChild(row);
    }
  }
  renderList();

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md font-semibold",
      onclick: () => {
        if (!selStaffId) { toast("スタッフを選択してください", "error"); return; }
        if (_t(selEnd) <= _t(selStart)) { toast("終了は開始より後にしてください", "error"); return; }
        const s = state.staff.find(x => x.id === selStaffId);
        const cost = s.hourlyWage * calcHours(selStart, selEnd);
        const newAssignment = {
          id: uid("a_"),
          date,
          staffId: selStaffId,
          position: selPos,
          startTime: selStart,
          endTime: selEnd,
          cost,
          score: 0,
        };
        curWeek().assignments.push(newAssignment);
        logChange("add", `${date} ${selStart}〜${selEnd} ${posCfg(selPos).label} に ${s.name} を追加`);
        persist(); closeModal(); render();
        toast(`✓ ${s.name} を追加 (¥${Math.round(cost).toLocaleString()})`, "success");
      },
    }, "💾 追加"),
  ]));
  modal(body);
}

// 印刷ビュー (Round 4)
// Round 23: 印刷モード選択ダイアログ
function openPrintMenuDialog() {
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🖨 印刷モードを選択"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "用途に応じてレイアウトを選んでください。"));
  const opts = [
    {
      id: "shop",
      title: "🏪 店内掲示用 (シンプル)",
      desc: "A4 横、時間帯×日付のマトリクス。冷蔵庫貼り用。情報量を抑えて視認性最優先",
      action: () => { closeModal(); openPrintView({ mode: "shop" }); },
    },
    {
      id: "detail",
      title: "📋 詳細・会議用",
      desc: "従来の詳細版。ポジション×セッション全表示、人件費・労働時間サマリ付き",
      action: () => { closeModal(); openPrintView({ mode: "detail" }); },
    },
    {
      id: "personal",
      title: "👤 個人配布用 (1人ずつ 1ページ)",
      desc: "スタッフ個別の自分のシフトのみ。月間カレンダー風。手渡し配布用",
      action: () => { closeModal(); openPrintView({ mode: "personal" }); },
    },
  ];
  for (const o of opts) {
    body.appendChild(el("button", {
      class: "w-full text-left bg-slate-50 hover:bg-brand-50 border border-slate-200 hover:border-brand-400 rounded-lg p-3 transition",
      onclick: o.action,
    }, [
      el("div", { class: "font-semibold text-sm" }, o.title),
      el("div", { class: "text-xs text-slate-600 mt-0.5" }, o.desc),
    ]));
  }
  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
  ]));
  modal(body);
}

function openPrintView(options = {}) {
  const mode = options.mode || "detail";
  if (mode === "shop") return openPrintViewShop();
  if (mode === "personal") return openPrintViewPersonal();
  return openPrintViewDetail();
}

// シンプル版 (店内掲示・冷蔵庫貼り)
function openPrintViewShop() {
  document.querySelectorAll(".print-only").forEach(e => e.remove());
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const restaurant = state.meta.restaurantName || "店舗";
  const wrap = document.createElement("div");
  wrap.className = "print-only";
  let html = `
    <style>
      @media print {
        @page { size: A4 landscape; margin: 12mm; }
        body > *:not(.print-only) { display: none !important; }
        .print-only { display: block !important; font-family: 'Hiragino Sans','Yu Gothic',sans-serif; }
        .print-only .ph { font-size: 16pt; font-weight: bold; margin-bottom: 4mm; }
        .print-only .pm { font-size: 9pt; color: #555; margin-bottom: 4mm; }
        .print-only table { width: 100%; border-collapse: collapse; font-size: 11pt; }
        .print-only th, .print-only td { border: 1px solid #444; padding: 2mm 1mm; text-align: center; }
        .print-only th { background: #e2e8f0; font-weight: bold; }
        .print-only .nm { font-size: 12pt; font-weight: bold; }
        .print-only .pos { font-size: 8pt; color: #666; }
      }
    </style>`;
  html += `<div class="ph">${escapeHtml(restaurant)} / ${w0} 〜 ${addDays(w0, 6)}</div>`;
  html += `<div class="pm">確定: ${(curWeek().publishedAt || "—").slice(0, 16)} / 印刷: ${new Date().toLocaleString("ja-JP")}</div>`;
  html += `<table><thead><tr><th style="width:80px">時間</th>`;
  for (const d of days) {
    const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
    html += `<th>${d.slice(5)} (${dow})</th>`;
  }
  html += `</tr></thead><tbody>`;
  for (const sess of state.meta.sessions) {
    html += `<tr><td><b>${escapeHtml(sess.label)}</b><br><span class="pos">${escapeHtml(sess.startTime)}〜${escapeHtml(sess.endTime)}</span></td>`;
    for (const d of days) {
      const list = curAssignments().filter(a =>
        a.date === d && a.startTime === sess.startTime && a.endTime === sess.endTime
      );
      if (list.length === 0) {
        html += `<td>—</td>`;
      } else {
        html += `<td>${list.map(a => {
          const s = state.staff.find(x => x.id === a.staffId);
          return `<div class="nm">${escapeHtml(s?.name || "?")}</div><div class="pos">${escapeHtml(posCfg(a.position).label)}</div>`;
        }).join("<hr>")}</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
  document.getElementById("main").appendChild(wrap);
  setTimeout(() => window.print(), 100);
}

// 個人配布用 (1ページ 1スタッフ)
function openPrintViewPersonal() {
  document.querySelectorAll(".print-only").forEach(e => e.remove());
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const restaurant = state.meta.restaurantName || "店舗";
  const wrap = document.createElement("div");
  wrap.className = "print-only";
  let html = `
    <style>
      @media print {
        @page { size: A4 portrait; margin: 15mm; }
        body > *:not(.print-only) { display: none !important; }
        .print-only { display: block !important; font-family: 'Hiragino Sans','Yu Gothic',sans-serif; }
        .print-only .person-page { page-break-after: always; }
        .print-only .person-page:last-child { page-break-after: auto; }
        .print-only h1 { font-size: 18pt; margin: 0 0 4mm; }
        .print-only h2 { font-size: 11pt; color: #555; margin: 0 0 8mm; font-weight: normal; }
        .print-only table { width: 100%; border-collapse: collapse; font-size: 11pt; margin-top: 4mm; }
        .print-only th, .print-only td { border: 1px solid #888; padding: 3mm; text-align: left; }
        .print-only th { background: #e2e8f0; }
        .print-only .day { font-weight: bold; width: 30mm; }
        .print-only .off { color: #999; }
        .print-only .summary { margin-top: 8mm; padding: 4mm; background: #f1f5f9; border: 1px solid #94a3b8; border-radius: 2mm; font-size: 11pt; }
      }
    </style>`;
  const sortedStaff = state.staff.filter(s => !s.archived)
    .filter(s => curAssignments().some(a => a.staffId === s.id));
  for (const s of sortedStaff) {
    const myAss = curAssignments().filter(a => a.staffId === s.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    const totalH = myAss.reduce((sum, a) => sum + calcHours(a.startTime, a.endTime), 0);
    const totalCost = myAss.reduce((sum, a) => sum + (a.cost || 0), 0);
    html += `<div class="person-page">`;
    html += `<h1>${escapeHtml(s.name)} さんのシフト</h1>`;
    html += `<h2>${escapeHtml(restaurant)} / ${w0} 〜 ${addDays(w0, 6)}</h2>`;
    html += `<table><tbody>`;
    for (const d of days) {
      const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
      const list = myAss.filter(a => a.date === d);
      html += `<tr><td class="day">${d.slice(5)} (${dow}曜)</td>`;
      if (list.length === 0) {
        html += `<td class="off">— お休み —</td>`;
      } else {
        html += `<td>${list.map(a => {
          const memoLine = a.note ? `<div style="font-size:9pt;color:#92400e;margin-top:1mm">📝 ${escapeHtml(a.note)}</div>` : "";
          return `${escapeHtml(a.startTime)}〜${escapeHtml(a.endTime)} (${escapeHtml(posCfg(a.position).label)})${memoLine}`;
        }).join("<br><br>")}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    html += `<div class="summary">合計: <b>${totalH.toFixed(1)}h</b> / 予定給与 <b>${fmtYen(Math.round(totalCost))}</b></div>`;
    html += `<div style="margin-top:6mm;font-size:9pt;color:#94a3b8">変更・質問はスタッフポータルからどうぞ。</div>`;
    html += `</div>`;
  }
  wrap.innerHTML = html;
  document.getElementById("main").appendChild(wrap);
  setTimeout(() => window.print(), 100);
}

function openPrintViewDetail() {
  // 既存印刷 DOM を削除して再生成
  document.querySelectorAll(".print-only").forEach(e => e.remove());

  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const sessions = state.meta.sessions || [];
  const positions = state.meta.positions || [];
  const restaurant = state.meta.restaurantName || "店舗";

  // テーブル構築: 行 = ポジション × セッション、列 = 日付
  const wrap = document.createElement("div");
  wrap.className = "print-only";
  const ownerNotice = (curWeek().ownerNotice || "").trim();
  let html = `
    <div class="print-header">${escapeHtml(restaurant)} シフト表</div>
    <div class="print-meta">${w0} 〜 ${addDays(w0, 6)} (確定: ${(curWeek().publishedAt || "—").slice(0, 16)})</div>
    ${ownerNotice ? `<div style="border:1px solid #999;padding:6px 8px;margin-bottom:4mm;background:#fffbeb;font-size:9pt;"><b>📢 今週のお知らせ:</b> ${escapeHtml(ownerNotice).replace(/\n/g, "<br>")}</div>` : ""}
    <table class="print-shift">
      <thead>
        <tr>
          <th rowspan="2" style="min-width:80px">時間帯</th>
          <th rowspan="2" style="min-width:60px">ポジション</th>`;
  for (const d of days) {
    const dow = ["日","月","火","水","木","金","土"][dayOfWeek(d)];
    const holiday = window.ShiftyData.getHoliday ? window.ShiftyData.getHoliday(d) : null;
    html += `<th>${d.slice(5)} (${dow}${holiday ? "🎌" : ""})</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const sess of sessions) {
    for (let pi = 0; pi < positions.length; pi++) {
      const pos = positions[pi];
      html += `<tr>`;
      if (pi === 0) {
        html += `<td rowspan="${positions.length}" style="vertical-align:middle">${escapeHtml(sess.label)}<br><span style="font-size:8pt;color:#555">${escapeHtml(sess.startTime)}〜${escapeHtml(sess.endTime)}</span></td>`;
      }
      html += `<td class="print-pos-cell">${escapeHtml(pos.label)}</td>`;
      for (const d of days) {
        const cellAss = curAssignments().filter(a =>
          a.date === d && a.position === pos.id && a.startTime === sess.startTime);
        if (!cellAss.length) {
          // 必要数あるけどアサイン無しなら "—"、必要無しならブランク
          const slot = curSlots().find(s => s.date === d && s.position === pos.id && s.startTime === sess.startTime);
          html += slot ? `<td class="print-empty">—</td>` : `<td></td>`;
        } else {
          const lines = cellAss.map(a => {
            const s = state.staff.find(x => x.id === a.staffId);
            const memoMark = a.note ? `<span title="${escapeAttr(a.note)}" style="font-size:7pt;color:#b45309;">📝</span>` : "";
            return `<span class="print-staff-name">${escapeHtml(s?.name || "?")}${memoMark}</span>`;
          }).join("");
          html += `<td class="${cellAss.length > 1 ? "print-cell-multi" : ""}">${lines}</td>`;
        }
      }
      html += `</tr>`;
    }
  }
  html += `</tbody></table>`;

  // スタッフ別合計時間
  const hours = aggregateHours();
  if (Object.keys(hours).length > 0) {
    html += `
      <div style="margin-top: 6mm;">
        <table class="print-shift" style="width: auto;">
          <thead><tr><th>スタッフ</th><th>合計時間</th></tr></thead>
          <tbody>`;
    for (const s of state.staff) {
      const h = hours[s.id] || 0;
      if (h > 0) html += `<tr><td style="text-align:left">${escapeHtml(s.name)}</td><td>${h.toFixed(1)}h</td></tr>`;
    }
    html += `</tbody></table>
      </div>`;
  }

  wrap.innerHTML = html;
  document.getElementById("main").appendChild(wrap);

  // 印刷ダイアログ呼び出し
  setTimeout(() => {
    window.print();
  }, 100);
}

// 店長 → スタッフ 返信文生成 (Round 12)
function openReplyDialog(msg) {
  const staff = state.staff.find(s => s.id === msg.staffId);
  const staffName = staff?.name || msg.staffName || "スタッフ";
  const KIND_LABEL = { general: "ご連絡", change_request: "シフト変更希望", question: "ご質問", report: "ご報告" };

  // 返信テンプレート (kind 別)
  const REPLIES = {
    "change_request": {
      "了承": `${staffName}さん\n\nお疲れ様です。\nシフト変更のご希望、了承いたしました。\n\n調整して新しいシフトを確定しましたら改めてご連絡します。\n少々お待ちください。\n\n${state.meta.restaurantName || ''}`,
      "確認中": `${staffName}さん\n\nお疲れ様です。\nシフト変更のご希望、確認しました。\n他のスタッフの状況を確認してから○月○日までにお返事いたします。\n\nご質問・補足あれば、追加でメッセージください。\n\n${state.meta.restaurantName || ''}`,
      "代替提案": `${staffName}さん\n\nお疲れ様です。\nご希望の日は○○のため対応難しい状況です。\n\n代わりに以下の案はいかがでしょうか:\n• 案 A: ○月○日 (時間)\n• 案 B: ○月○日 (時間)\n\nご希望をお聞かせください。\n\n${state.meta.restaurantName || ''}`,
      "却下": `${staffName}さん\n\nお疲れ様です。\nご希望の件、店舗運営の都合上で対応が難しい状況です。\n\n申し訳ございませんが、当初のシフト通りお願いできますでしょうか。\n何か事情があればお気軽にご相談ください。\n\n${state.meta.restaurantName || ''}`,
    },
    "question": {
      "回答": `${staffName}さん\n\nお疲れ様です。\nご質問いただきありがとうございます。\n\n[ここに回答を記入してください]\n\n他に分からないことがあればお気軽にご質問ください。\n\n${state.meta.restaurantName || ''}`,
    },
    "report": {
      "確認": `${staffName}さん\n\nお疲れ様です。\nご報告いただきありがとうございます。\n\n内容確認しました。お体ご自愛ください。\nお大事にしてください。\n\n${state.meta.restaurantName || ''}`,
    },
    "general": {
      "返信": `${staffName}さん\n\nお疲れ様です。\nご連絡ありがとうございます。\n\n[返信内容を記入してください]\n\n${state.meta.restaurantName || ''}`,
    },
  };
  const templates = REPLIES[msg.kind] || REPLIES["general"];

  const body = el("div", { class: "p-6 space-y-3 max-h-[80vh] overflow-y-auto" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "✉️ 返信文を生成"));
  body.appendChild(el("div", { class: "bg-slate-50 rounded p-2 text-xs text-slate-600" }, [
    el("div", { class: "font-semibold" }, `${staffName} さんからの${KIND_LABEL[msg.kind] || msg.kind}:`),
    el("div", { class: "mt-1 whitespace-pre-wrap" }, msg.message || ""),
  ]));

  body.appendChild(el("div", { class: "text-xs font-semibold text-slate-700" }, "返信テンプレ選択:"));
  const tpls = el("div", { class: "grid grid-cols-2 gap-2" });
  Object.keys(templates).forEach(label => {
    const btn = el("button", {
      class: "text-xs bg-slate-100 hover:bg-emerald-50 hover:border-emerald-300 border border-slate-300 rounded-md px-3 py-1.5",
      onclick: () => {
        $("#reply-text").value = templates[label];
      },
    }, label);
    tpls.appendChild(btn);
  });
  body.appendChild(tpls);

  body.appendChild(el("div", { class: "text-xs font-semibold text-slate-700 pt-2" }, "返信文 (LINE/メール用):"));
  body.appendChild(el("textarea", {
    id: "reply-text",
    class: "w-full border rounded-md p-2 text-xs font-mono h-48",
  }, templates[Object.keys(templates)[0]] || ""));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-md font-semibold",
      onclick: async () => {
        const txt = $("#reply-text").value;
        try {
          await navigator.clipboard.writeText(txt);
          toast(`返信文をコピー (${staffName} さん宛)`, "success");
        } catch (_) { toast("コピー失敗", "error"); }
      },
    }, "📋 コピーして送信準備"),
  ]));
  modal(body);
}

// 新週の希望募集メッセージ生成 (Round 12)
function openRecruitDialog() {
  const restaurant = state.meta.restaurantName || "店舗";
  const w0 = state.meta.currentWeekStart;
  const wEnd = addDays(w0, 6);
  const dl = state.meta.preferenceDeadline || { daysBefore: 3, hour: 18 };
  const wkDate = new Date(w0 + "T00:00:00");
  wkDate.setDate(wkDate.getDate() - dl.daysBefore);
  const deadline = `${wkDate.getMonth()+1}/${wkDate.getDate()} (${["日","月","火","水","木","金","土"][wkDate.getDay()]}) ${String(dl.hour).padStart(2,"0")}:00`;

  const lineTxt =
    `【シフト希望募集】 (${restaurant})\n\n` +
    `${w0.slice(5)} 〜 ${wEnd.slice(5)} の週シフト希望をお願いします。\n\n` +
    `▼ 締切: ${deadline}\n\n` +
    `▼ 提出方法:\n` +
    `各自に個別の URL をお送りします（または「💬 LINE用 全員リンク生成」ボタンから一括取得）。\n` +
    `URL を開いて、各日の希望をタップするだけ。所要時間 約 2 分です。\n\n` +
    `▼ ご注意:\n` +
    `期限内であれば何度でも編集・再送信できます。\n` +
    `特殊な事情・要望はメモ欄にご記入ください。\n\n` +
    `ご協力お願いいたします。`;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📨 希望募集メッセージ"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    `${state.staff.length} 名のスタッフへ送信する週次希望募集テンプレ`));
  body.appendChild(el("textarea", {
    id: "recruit-ta",
    class: "w-full border rounded-md p-2 text-xs font-mono h-72",
    readonly: "",
  }, lineTxt));
  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md font-semibold",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(lineTxt);
          toast("コピーしました。LINE グループに貼り付けてください", "success");
        } catch (_) { $("#recruit-ta").select(); toast("選択しました。手動でコピー", "info"); }
      },
    }, "📋 コピー"),
  ]));
  modal(body);
}

// 未提出スタッフへの催促 LINE 文生成 (Round 3)
function openReminderDialog(staffList) {
  const restaurant = state.meta.restaurantName || "店舗";
  const wk = state.meta.currentWeekStart;
  const wkEnd = addDays(wk, 6);
  // 期限: 月曜の 18:00 (週開始の前日 18時) — もしくは設定可能だが固定で
  const deadline = `${wk.slice(5)}〜${wkEnd.slice(5)} の希望提出`;

  const lineTxt =
    `📣 シフト希望のお願い (${restaurant})\n\n` +
    `${deadline} がまだ提出されていない方へ、再度ご案内です。\n\n` +
    `▼ 対象者:\n` +
    staffList.map((s, i) => `${i+1}. ${s.name}さん`).join("\n") + "\n\n" +
    `▼ 提出方法:\n` +
    `スタッフ別にお送りした個人 URL を開いて、各日の希望をタップして「送信」を押してください。\n` +
    `URL を紛失された方は、店長までお声がけください。\n\n` +
    `▼ 締切:\n` +
    `本日 18:00 までにご提出をお願いします。\n` +
    `期限を過ぎた場合は店舗都合でシフトを組ませていただきます。\n\n` +
    `ご協力よろしくお願いいたします。`;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📣 提出催促 LINE 文"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    `${staffList.length} 名 (${staffList.map(s => s.name).join("・")}) の未提出に対する一斉送信用テンプレ`));

  body.appendChild(el("textarea", {
    id: "reminder-ta",
    class: "w-full border rounded-md p-2 text-xs font-mono h-72",
    readonly: "",
  }, lineTxt));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-md font-semibold",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(lineTxt);
          toast("催促文をコピーしました。LINE グループに貼り付けてください", "success");
        } catch (e) {
          $("#reminder-ta").select();
          toast("コピー失敗。手動で選択してコピーしてください", "error");
        }
      },
    }, "📋 コピー"),
  ]));
  modal(body);
}

// 必要人数を日付・セッション別にオーバーライドするダイアログ (Round 2)
function openSlotAdjustDialog(date, sess) {
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, `${date.slice(5)} ${sess.label} の必要人数`));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "曜日設定の人数を上書きします。GW・年末年始・特別イベント等に。"));

  const wrap = el("div", { class: "space-y-2" });
  const inputs = {};
  for (const pos of state.meta.positions) {
    const cur = curSlots().find(s => s.date === date && s.position === pos.id && s.startTime === sess.startTime);
    const val = cur ? cur.requiredCount : 0;
    const row = el("div", { class: "flex items-center justify-between gap-3" });
    row.appendChild(el("div", { class: "flex items-center gap-2" }, [
      el("span", { style: { width: "12px", height: "12px", borderRadius: "3px", background: pos.color, display: "inline-block" } }),
      el("span", { class: "font-medium text-sm" }, pos.label),
    ]));
    const input = el("input", {
      type: "number", min: "0", max: "20", value: String(val),
      class: "w-20 border rounded-md px-2 py-1 text-right text-sm",
    });
    inputs[pos.id] = input;
    row.appendChild(input);
    wrap.appendChild(row);
  }
  body.appendChild(wrap);
  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md font-semibold",
      onclick: () => {
        // 既存 slots を更新 / 新規追加 / 0 なら削除
        const week = curWeek();
        const newSlots = (week.slots || []).filter(s => !(s.date === date && s.startTime === sess.startTime));
        for (const pos of state.meta.positions) {
          const n = Number(inputs[pos.id].value) || 0;
          if (n > 0) {
            const existing = (week.slots || []).find(s =>
              s.date === date && s.position === pos.id && s.startTime === sess.startTime);
            newSlots.push({
              id: existing ? existing.id : uid("sl_"),
              date, position: pos.id,
              startTime: sess.startTime, endTime: sess.endTime,
              requiredCount: n,
            });
          }
        }
        // 「日付別オーバーライド」フラグを meta に記録 (UI 視覚化のため)
        const meta = state.meta;
        meta.dateOverrides = meta.dateOverrides || {};
        meta.dateOverrides[`${date}|${sess.id}`] = true;
        week.slots = newSlots;
        persist(); closeModal(); render();
        toast(`${date.slice(5)} ${sess.label} の必要人数を更新しました`, "success");
      },
    }, "保存"),
  ]));
  modal(body);
}

function renderCalendarMobile(days) {
  const wrap = el("div", { class: "space-y-2" });
  for (const d of days) {
    const dow = dayOfWeek(d);
    const holidayName = window.ShiftyData.getHoliday(d);
    const dayCard = el("div", { class: "bg-white border border-slate-200 rounded-lg p-3" });
    const dowColor = holidayName ? "text-red-600" : (dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "text-slate-700");
    const header = el("div", { class: "flex items-center justify-between mb-2" });
    header.appendChild(el("div", { class: `font-bold text-sm ${dowColor}` }, `${d.slice(5)} (${DAY_LABELS[dow]})`));
    if (holidayName) {
      header.appendChild(el("span", { class: "text-[10px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5" }, `🎌 ${holidayName}`));
    }
    dayCard.appendChild(header);

    let totalCount = 0;
    for (const sess of state.meta.sessions) {
      const dayAssignments = curAssignments().filter(a => a.date === d && a.startTime === sess.startTime);
      if (!dayAssignments.length) {
        // 未充足チェック
        const slotsCnt = curSlots().filter(s => s.date === d && s.startTime === sess.startTime)
          .reduce((s, x) => s + x.requiredCount, 0);
        if (slotsCnt > 0 && curAssignments().length > 0) {
          dayCard.appendChild(el("div", { class: "text-xs text-red-600 bg-red-50 rounded px-2 py-1 mb-1" },
            `${sess.icon} ${sess.label} 未充足 ${slotsCnt}名`));
        }
        continue;
      }
      const sessHead = el("div", { class: "text-xs font-semibold text-slate-600 mt-2 flex items-center gap-1" });
      // Round 33 (Sec-2): sess.icon/startTime/endTime もエスケープ
      sessHead.innerHTML = `<span>${escapeHtml(sess.icon || "")}</span><span>${escapeHtml(sess.label)}</span><span class="text-slate-400">${escapeHtml(sess.startTime)}〜${escapeHtml(sess.endTime)}</span>`;
      dayCard.appendChild(sessHead);
      // 未充足チェック
      const slotsInCell = curSlots().filter(s => s.date === d && s.startTime === sess.startTime);
      slotsInCell.forEach(slot => {
        const filledN = dayAssignments.filter(a => a.position === slot.position).length;
        const missing = slot.requiredCount - filledN;
        if (missing > 0) {
          dayCard.appendChild(el("div", { class: "text-[10px] text-red-600 bg-red-50 rounded px-1 mt-0.5 inline-block" },
            `不足: ${posCfg(slot.position).label} ×${missing}`));
        }
      });
      const list = el("div", { class: "space-y-1 mt-1" });
      for (const pos of state.meta.positions) {
        const ll = dayAssignments.filter(a => a.position === pos.id);
        ll.forEach(a => {
          const s = state.staff.find(x => x.id === a.staffId);
          const cfg = posCfg(pos.id);
          const editable = curStatus() === "draft";
          const chip = el("div", {
            class: "assignment-chip flex items-center justify-between" + (editable ? " editable" : ""),
            draggable: editable ? "true" : "false",
            "data-assignment-id": a.id,
            style: { borderColor: cfg.color, padding: "6px 8px", touchAction: editable ? "pan-y" : "auto" },
            onclick: () => handleChipTap(a),
            ondragstart: editable ? (e) => handleChipDragStart(e, a) : null,
            ondragover: editable ? (e) => { e.preventDefault(); chip.classList.add("drop-target"); } : null,
            ondragleave: editable ? () => chip.classList.remove("drop-target") : null,
            ondrop: editable ? (e) => { chip.classList.remove("drop-target"); handleChipDrop(e, a); } : null,
            ondragend: () => $$(".assignment-chip").forEach(c => c.classList.remove("drop-target", "dragging")),
            // Round 17 TOP 3: Touch D&D
            ontouchstart: editable ? (e) => handleChipTouchStart(e, a) : null,
            ontouchmove: editable ? (e) => handleChipTouchMove(e) : null,
            ontouchend: editable ? (e) => handleChipTouchEnd(e) : null,
            ontouchcancel: editable ? () => { _touchState = null; } : null,
          });
          const memoBadge2 = a.note ? `<span title="${escapeAttr(a.note)}" class="inline-block ml-1 text-[10px] bg-amber-200 text-amber-900 rounded px-1">📝</span>` : "";
          chip.innerHTML = `
            <span><span class="name font-semibold">${escapeHtml(s?.name || "?")}</span>${memoBadge2} <span class="text-[10px] text-slate-500">${escapeHtml(cfg.label)}</span></span>
            <span class="text-[10px] text-slate-500">${a.startTime.slice(0,5)}〜${a.endTime.slice(0,5)}</span>
          `;
          list.appendChild(chip);
          totalCount++;
        });
      }
      dayCard.appendChild(list);
    }
    if (totalCount === 0 && curAssignments().length > 0) {
      dayCard.appendChild(el("div", { class: "text-xs text-slate-400 text-center py-2" }, "（該当なし）"));
    }
    wrap.appendChild(dayCard);
  }
  return wrap;
}

function openAssignmentDetail(a) {
  const s = state.staff.find(x => x.id === a.staffId);
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("div", { class: "flex items-center justify-between" }, [
    el("h3", { class: "font-bold text-lg" }, s?.name || "?"),
    el("span", { html: posBadge(a.position) }),
  ]));
  body.appendChild(el("div", { class: "text-sm text-slate-600" }, `${a.date} ${a.startTime}〜${a.endTime} (${calcHours(a.startTime, a.endTime)}h, ${fmtYen(a.cost)})`));

  // Round 27 TOP 1: AI 配置理由 (自然言語)
  if (a.reason) {
    body.appendChild(el("div", { class: "bg-blue-50 border border-blue-200 rounded-md p-2 text-xs flex items-start gap-2" }, [
      el("span", { class: "text-base" }, "🧠"),
      el("div", { class: "flex-1" }, [
        el("span", { class: "font-semibold text-blue-900" }, "AI が選んだ理由: "),
        el("span", { class: "text-blue-800" }, a.reason),
      ]),
    ]));
  }

  // 新フォーマット: breakdown (0..1正規化値 × 重み) + 旧 reasons 互換
  if (a.breakdown && a.breakdown.length) {
    const tbl = el("div", { class: "bg-slate-50 rounded-md p-3 text-xs space-y-1" });
    tbl.appendChild(el("div", { class: "font-semibold text-slate-700 mb-2" }, "🤖 AIスコア内訳（重み付き加点方式）"));
    const head = el("div", { class: "grid grid-cols-12 gap-2 text-[10px] text-slate-500 mb-1" });
    head.innerHTML = `<div class="col-span-3">要素</div><div class="col-span-3">値(0-100)</div><div class="col-span-2">重み</div><div class="col-span-2 text-right">寄与</div><div class="col-span-2 text-right">詳細</div>`;
    tbl.appendChild(head);
    a.breakdown.forEach(b => {
      const row = el("div", { class: "grid grid-cols-12 gap-2 items-center" });
      row.innerHTML = `
        <div class="col-span-3">${escapeHtml(b.label)}</div>
        <div class="col-span-3 flex items-center gap-1">
          <div class="flex-1 h-1.5 bg-slate-200 rounded">
            <div class="h-full bg-brand-600 rounded" style="width:${(b.value*100).toFixed(0)}%"></div>
          </div>
          <span class="text-[10px] w-7 text-right">${(b.value*100).toFixed(0)}</span>
        </div>
        <div class="col-span-2 text-slate-600">×${(b.weight*100).toFixed(0)}%</div>
        <div class="col-span-2 text-right text-emerald-600 font-semibold">${(b.contrib*100).toFixed(1)}</div>
        <div class="col-span-2 text-right text-[10px] text-slate-500" title="${escapeAttr(b.detail || '')}">${escapeHtml((b.detail||'').slice(0,12))}</div>
      `;
      tbl.appendChild(row);
    });
    tbl.appendChild(el("div", { class: "flex justify-between font-bold border-t pt-1.5 mt-2" }, [
      el("span", {}, "合計スコア (0-100)"),
      el("span", { class: "text-brand-600" }, (a.score * 100).toFixed(1)),
    ]));
    body.appendChild(tbl);

    // 候補者比較
    if (a.topCandidates && a.topCandidates.length > 1) {
      const cand = el("div", { class: "bg-blue-50 rounded-md p-3 text-xs" });
      cand.appendChild(el("div", { class: "font-semibold text-slate-700 mb-2" }, "🔍 候補者比較（上位3名）"));
      a.topCandidates.forEach((c, i) => {
        const isPicked = c.staffId === a.staffId;
        cand.appendChild(el("div", { class: `flex justify-between ${isPicked ? 'font-bold text-brand-700' : 'text-slate-600'}` }, [
          el("span", {}, `${i+1}. ${c.name}${isPicked ? ' ← 採用' : ''}`),
          el("span", {}, (c.score * 100).toFixed(1)),
        ]));
      });
      body.appendChild(cand);
    }
  } else if (a.reasons) {
    // 旧フォーマット互換
    const tbl = el("div", { class: "bg-slate-50 rounded-md p-3 text-xs space-y-1" });
    tbl.appendChild(el("div", { class: "font-semibold text-slate-700 mb-1" }, "🤖 AIスコア内訳"));
    a.reasons.forEach(([label, pts]) => {
      tbl.appendChild(el("div", { class: "flex justify-between" }, [
        el("span", {}, label),
        el("span", { class: pts >= 0 ? "text-emerald-600" : "text-red-600" }, (pts >= 0 ? "+" : "") + Math.round(pts)),
      ]));
    });
    tbl.appendChild(el("div", { class: "flex justify-between font-bold border-t pt-1 mt-1" }, [
      el("span", {}, "合計スコア"), el("span", {}, Math.round(a.score)),
    ]));
    body.appendChild(tbl);
  }

  // 個別シフトメモ (Round 14 TOP 3) — draft / published 両方で編集可
  const memoCard = el("div", { class: "bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2" });
  memoCard.appendChild(el("div", { class: "text-xs font-semibold text-amber-900 flex items-center gap-1" }, [
    el("span", {}, "📝 このシフトのメモ"),
    el("span", { class: "text-[10px] text-amber-700 font-normal" }, "（スタッフポータルにも表示されます）"),
  ]));
  const memoInput = el("textarea", {
    id: "asgn-note-input",
    class: "w-full border border-amber-300 rounded-md px-2 py-1.5 text-sm",
    rows: "2",
    placeholder: "例: 新人さんと一緒なのでフォロー多めでお願いします / 18:00 から食材の納品あり",
    maxlength: "200",
  }, a.note || "");
  memoCard.appendChild(memoInput);
  memoCard.appendChild(el("div", { class: "flex justify-end gap-2" }, [
    el("button", {
      class: "text-xs bg-amber-600 hover:bg-amber-700 text-white rounded px-3 py-1",
      onclick: async () => {
        const newNote = (memoInput.value || "").trim().slice(0, 200);
        const oldNote = a.note || "";
        if (newNote === oldNote) { toast("変更ありません", "info"); return; }
        const idx = curAssignments().findIndex(x => x.id === a.id);
        if (idx < 0) { toast("対象が見つかりません", "error"); return; }
        curAssignments()[idx] = { ...a, note: newNote };
        a.note = newNote; // モーダル内表示の整合性
        const verb = newNote ? "更新" : "削除";
        logChange("note", `${a.date} ${a.startTime}〜 ${posCfg(a.position).label} (${s?.name || "?"}) のメモを${verb}`);
        await persist(); render();
        toast(newNote ? "メモを保存しました" : "メモを削除しました", "success");
        // 確定済の場合、対象スタッフに変更通知
        if (curStatus() === "published") {
          await notifyShiftChanges([a.staffId]);
        }
      },
    }, "💾 メモを保存"),
  ]));
  body.appendChild(memoCard);

  // 打刻管理カード (Round 19) — オーナーが手動で打刻時刻を編集 (修正・追加)
  const clockCard = el("div", { class: "bg-blue-50 border border-blue-200 rounded-md p-3 space-y-2" });
  clockCard.appendChild(el("div", { class: "text-xs font-semibold text-blue-900" }, "⏱ 打刻管理"));
  function fmtClockLocal(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) { return ""; }
  }
  const inVal = fmtClockLocal(a.clockIn);
  const outVal = fmtClockLocal(a.clockOut);
  const grid = el("div", { class: "grid grid-cols-1 md:grid-cols-2 gap-2 text-xs" });
  grid.innerHTML = `
    <label class="block">
      <span class="text-slate-700">出勤打刻 (予定 ${escapeHtml(a.startTime)})</span>
      <input id="clock-in-input" type="datetime-local" class="mt-1 w-full border rounded px-2 py-1" value="${escapeAttr(inVal)}">
      ${a.clockInBy === "manual" ? '<span class="text-[10px] text-slate-500">店長手動修正</span>' : a.clockInBy === "self" ? '<span class="text-[10px] text-slate-500">セルフ打刻</span>' : ""}
    </label>
    <label class="block">
      <span class="text-slate-700">退勤打刻 (予定 ${escapeHtml(a.endTime)})</span>
      <input id="clock-out-input" type="datetime-local" class="mt-1 w-full border rounded px-2 py-1" value="${escapeAttr(outVal)}">
      ${a.clockOutBy === "manual" ? '<span class="text-[10px] text-slate-500">店長手動修正</span>' : a.clockOutBy === "self" ? '<span class="text-[10px] text-slate-500">セルフ打刻</span>' : ""}
    </label>`;
  clockCard.appendChild(grid);
  // 差分表示
  if (a.clockIn || a.clockOut) {
    const diffs = [];
    if (a.clockIn) {
      try {
        const inDt = new Date(a.clockIn);
        const sched = new Date(`${a.date}T${a.startTime}:00`);
        const dm = Math.round((inDt - sched) / 60000);
        if (dm > 5) diffs.push(`<span class="text-red-700">+${dm}分遅刻</span>`);
        else if (dm < -10) diffs.push(`<span class="text-blue-700">${dm}分早出</span>`);
      } catch (_) {}
    }
    if (a.clockOut) {
      try {
        const outDt = new Date(a.clockOut);
        const sched = new Date(`${a.date}T${a.endTime}:00`);
        const dm = Math.round((outDt - sched) / 60000);
        if (dm > 5) diffs.push(`<span class="text-amber-700">+${dm}分残業</span>`);
        else if (dm < -10) diffs.push(`<span class="text-blue-700">${dm}分早退</span>`);
      } catch (_) {}
    }
    if (a.clockIn && a.clockOut) {
      try {
        const inDt = new Date(a.clockIn);
        const outDt = new Date(a.clockOut);
        const actualH = (outDt - inDt) / 3600000;
        const schedH = calcHours(a.startTime, a.endTime);
        diffs.push(`<span class="text-slate-700">実労働 <b>${actualH.toFixed(2)}h</b> / 予定 ${schedH.toFixed(1)}h</span>`);
      } catch (_) {}
    }
    if (diffs.length > 0) {
      clockCard.appendChild(el("div", { class: "text-[11px] flex flex-wrap gap-2 px-1", html: diffs.join(" ・ ") }));
    }
  }
  clockCard.appendChild(el("div", { class: "flex justify-between gap-2 pt-1" }, [
    (a.clockIn || a.clockOut) ? el("button", {
      class: "text-xs text-red-600 hover:bg-red-50 rounded px-2 py-1",
      onclick: async () => {
        if (!confirm("このシフトの打刻データをクリアしますか？")) return;
        const idx = curAssignments().findIndex(x => x.id === a.id);
        if (idx < 0) return;
        const upd = { ...a };
        delete upd.clockIn; delete upd.clockInBy;
        delete upd.clockOut; delete upd.clockOutBy;
        curAssignments()[idx] = upd;
        logChange("clock_clear", `${a.date} ${a.startTime}〜 (${s?.name || "?"}) の打刻をクリア`);
        await persist(); closeModal(); render();
        toast("打刻をクリアしました", "success");
      },
    }, "🗑 打刻クリア") : el("span", {}),
    el("button", {
      class: "text-xs bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1",
      onclick: async () => {
        const inEl = document.getElementById("clock-in-input");
        const outEl = document.getElementById("clock-out-input");
        const newIn = inEl?.value || "";
        const newOut = outEl?.value || "";
        const idx = curAssignments().findIndex(x => x.id === a.id);
        if (idx < 0) { toast("対象が見つかりません", "error"); return; }
        function _toIso(localStr) {
          if (!localStr) return "";
          // datetime-local は "YYYY-MM-DDTHH:mm" を JST と解釈
          return localStr + ":00+09:00";
        }
        const inIso = newIn ? _toIso(newIn) : "";
        const outIso = newOut ? _toIso(newOut) : "";
        if (inIso && outIso && new Date(outIso) <= new Date(inIso)) {
          toast("退勤時刻は出勤時刻より後にしてください", "error"); return;
        }
        const upd = { ...a };
        const oldIn = a.clockIn || "", oldOut = a.clockOut || "";
        if (inIso && inIso !== oldIn) { upd.clockIn = inIso; upd.clockInBy = "manual"; }
        else if (!inIso && oldIn) { delete upd.clockIn; delete upd.clockInBy; }
        if (outIso && outIso !== oldOut) { upd.clockOut = outIso; upd.clockOutBy = "manual"; }
        else if (!outIso && oldOut) { delete upd.clockOut; delete upd.clockOutBy; }
        curAssignments()[idx] = upd;
        logChange("clock_edit", `${a.date} ${a.startTime}〜 (${s?.name || "?"}) の打刻を手動修正`);
        await persist(); closeModal(); render();
        toast("打刻を保存しました", "success");
      },
    }, "💾 打刻を保存"),
  ]));
  body.appendChild(clockCard);

  if (curStatus() === "draft") {
    body.appendChild(el("button", { class: "w-full text-sm bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-md py-2 font-semibold",
      onclick: () => showSubstitutes(a) }, "🆘 欠勤想定 → 代打推薦"));

    body.appendChild(el("div", { class: "flex justify-between gap-2" }, [
      el("button", { class: "flex-1 text-sm border border-red-300 text-red-700 rounded-md py-1.5",
        onclick: () => {
          if (!confirm("このアサインを削除しますか？")) return;
          const removedStaff = state.staff.find(x => x.id === a.staffId);
          curWeek().assignments = curAssignments().filter(x => x.id !== a.id);
          logChange("delete", `${a.date} ${a.startTime}〜 ${posCfg(a.position).label} (${removedStaff?.name || "?"}) 削除`);
          persist(); closeModal(); render(); toast("削除しました", "success");
        } }, "削除"),
      el("button", { class: "flex-1 text-sm bg-slate-200 rounded-md py-1.5", onclick: closeModal }, "閉じる"),
    ]));
  } else {
    body.appendChild(el("div", { class: "text-xs text-slate-500" }, "確定済の週は編集不可（下書きに戻すと編集できます）。メモは確定後でも追加可能です。"));
    body.appendChild(el("button", { class: "w-full text-sm bg-slate-200 rounded-md py-1.5", onclick: closeModal }, "閉じる"));
  }
  modal(body);
}

function showSubstitutes(targetA) {
  const a = targetA;
  const subs = recommendSubstitute(a, {
    staff: state.staff, slots: curSlots(), preferences: curPrefs(), assignments: curAssignments(),
    laborRules: state.meta.laborRules, weights: state.meta.algorithmWeights,
  });
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🆘 代打推薦"));
  if (!subs.length) {
    body.appendChild(el("div", { class: "text-sm text-slate-600" }, "対応可能なスタッフが見つかりません。"));
  } else {
    subs.forEach((cand, i) => {
      const s = cand.staff;
      const row = el("div", { class: "flex items-center justify-between bg-slate-50 rounded-md p-3" });
      row.innerHTML = `
        <div>
          <div class="font-semibold">${i+1}. ${escapeHtml(s.name)} <span class="text-xs text-slate-500">${escapeHtml(posCfg(s.position).label)}</span></div>
          <div class="text-xs text-slate-600">スコア ${Math.round(cand.score)} / ${fmtYen(s.hourlyWage)}/h</div>
        </div>`;
      const btn = el("button", { class: "text-xs bg-brand-600 text-white rounded px-3 py-1.5",
        onclick: async () => {
          const idx = curAssignments().findIndex(x => x.id === a.id);
          if (idx >= 0) {
            const oldStaffId = a.staffId;
            const newStaffId = s.id;
            const oldStaff = state.staff.find(x => x.id === oldStaffId);
            curAssignments()[idx] = {
              ...a, staffId: newStaffId, cost: s.hourlyWage * calcHours(a.startTime, a.endTime),
              reasons: cand.reasons, score: cand.score, breakdown: cand.breakdown,
            };
            logChange("substitute", `${oldStaff?.name || "?"} → ${s.name} に代打入替（${a.date} ${a.startTime}〜 ${posCfg(a.position).label}）`);
            await persist(); closeModal(); render(); toast("代打を割当てました", "success");
            // Round 8: 確定後の変更ならメール再通知
            await notifyShiftChanges([oldStaffId, newStaffId]);
          }
        } }, "入替");
      row.appendChild(btn);
      body.appendChild(row);
    });
  }
  // Round 2: 代打一斉打診テンプレ生成
  body.appendChild(el("div", { class: "mt-3 pt-3 border-t" }, [
    el("div", { class: "text-xs text-slate-600 mb-2" }, "もしくは候補スタッフ全員に一斉打診"),
    el("button", {
      class: "w-full text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-2 font-semibold",
      onclick: () => openBroadcastSubDialog(a, subs),
    }, "📣 候補全員に LINE / メール文を生成"),
  ]));
  body.appendChild(el("button", { class: "mt-2 w-full text-sm bg-slate-200 rounded-md py-1.5", onclick: closeModal }, "閉じる"));
  modal(body);
}

// 代打一斉打診テンプレ生成 (Round 2)
function openBroadcastSubDialog(a, subs) {
  const absent = state.staff.find(s => s.id === a.staffId);
  const restaurant = state.meta.restaurantName || "店舗";
  const dt = `${a.date.slice(5)} ${a.startTime}〜${a.endTime}`;
  const positionLabel = posCfg(a.position).label;
  const candidates = (subs || []).slice(0, 8); // 上位 8 名

  const lineTxt =
    `📣 急募・代打のお願い\n` +
    `${restaurant}より\n\n` +
    `下記のシフトに急遽 1 名足りなくなりました。出勤可能な方は 30 分以内にこのスレッドにご返信ください。\n\n` +
    `📅 日時: ${a.date} (${a.startTime.slice(0,5)}〜${a.endTime.slice(0,5)})\n` +
    `🪑 ポジション: ${positionLabel}\n` +
    `❌ 元の担当: ${absent ? absent.name : '?'}\n\n` +
    `【お声がけ候補】※ AI が自動推薦した順位\n` +
    candidates.map((c, i) => `${i+1}. ${c.staff.name}さん`).join("\n") + "\n\n" +
    `※ 上記以外の方も大歓迎です。お返事は早い者勝ちです。\n` +
    `※ 入れない場合はその旨もお返事ください（出席集計のため）。`;

  const emailTxt =
    `件名: 【至急】${a.date} ${dt} 代打のお願い\n\n` +
    `お疲れ様です、${restaurant}です。\n\n` +
    `${a.date} (${a.startTime.slice(0,5)}〜${a.endTime.slice(0,5)}) の ${positionLabel} に急遽 1 名足りなくなりました。\n` +
    `（元の担当: ${absent ? absent.name : '?'} さん）\n\n` +
    `30 分以内にご返信いただける方を募集しています。\n` +
    `早い者勝ちで決めさせていただきますので、もし出れる方はこのメールにご返信ください。\n\n` +
    `【AI 推薦の優先候補】\n` +
    candidates.map((c, i) => `${i+1}. ${c.staff.name}さん`).join("\n") + "\n\n" +
    `上記以外の方も歓迎です。出れない場合もその旨ご返信いただけると助かります。\n\n` +
    `${restaurant}\n${state.meta.restaurantName || ''}`;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📣 代打一斉打診テンプレ"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "下記のテンプレをコピーして、LINE グループまたはメール一斉送信でお使いください。"));

  // タブ風切替
  const tabs = el("div", { class: "flex gap-1 border-b" });
  const lineTab = el("button", { class: "px-3 py-1.5 text-sm font-semibold border-b-2 border-brand-600 text-brand-600" }, "💬 LINE 用");
  const mailTab = el("button", { class: "px-3 py-1.5 text-sm border-b-2 border-transparent text-slate-500" }, "✉️ メール用");
  tabs.appendChild(lineTab); tabs.appendChild(mailTab);
  body.appendChild(tabs);

  const ta = el("textarea", { class: "w-full border rounded-md p-2 text-xs font-mono h-72", readonly: "" }, lineTxt);
  body.appendChild(ta);

  lineTab.onclick = () => {
    ta.value = lineTxt;
    lineTab.classList.add("border-brand-600", "text-brand-600");
    lineTab.classList.remove("border-transparent", "text-slate-500");
    mailTab.classList.add("border-transparent", "text-slate-500");
    mailTab.classList.remove("border-brand-600", "text-brand-600");
  };
  mailTab.onclick = () => {
    ta.value = emailTxt;
    mailTab.classList.add("border-brand-600", "text-brand-600");
    mailTab.classList.remove("border-transparent", "text-slate-500");
    lineTab.classList.add("border-transparent", "text-slate-500");
    lineTab.classList.remove("border-brand-600", "text-brand-600");
  };

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-md font-semibold",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(ta.value);
          toast("テンプレをクリップボードにコピーしました", "success");
        } catch (e) {
          ta.select();
          toast("コピー失敗。手動で選択してコピーしてください", "error");
        }
      },
    }, "📋 コピー"),
  ]));
  modal(body);
}

function getUnfilled() {
  const unfilled = [];
  for (const sl of curSlots()) {
    const n = curAssignments().filter(a => a.date === sl.date && a.position === sl.position && a.startTime === sl.startTime).length;
    for (let i = n; i < sl.requiredCount; i++) unfilled.push(sl);
  }
  return unfilled;
}

function renderStaffSummary() {
  const card = el("div", { class: "bg-white border border-slate-200 rounded-xl overflow-x-auto" });
  card.innerHTML = `<div class="font-semibold p-3 border-b flex items-center justify-between">
    <span>スタッフ別サマリ</span>
    <span class="text-xs font-normal text-slate-500" id="summary-total"></span>
  </div>`;
  const tbl = el("table", { class: "w-full text-sm" });
  tbl.innerHTML = `
    <thead class="bg-slate-50 text-slate-600 text-xs"><tr>
      <th class="text-left px-3 py-2">名前</th>
      <th class="text-right px-3 py-2">時間</th>
      <th class="text-right px-3 py-2">給与</th>
      <th class="text-left px-3 py-2">状態</th>
    </tr></thead>`;
  const tb = el("tbody");
  const hours = aggregateHours();
  // 時間降順でランキング表示 (Round 9)
  const rows = [];
  for (const s of state.staff) {
    const h = hours[s.id] || 0;
    const cost = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + a.cost, 0);
    rows.push({ s, h, cost });
  }
  rows.sort((a, b) => b.h - a.h);
  let totalH = 0, totalCost = 0;
  for (const { s, h, cost } of rows) {
    totalH += h;
    totalCost += cost;
    let status = "✓";
    let statusClass = "text-slate-400";
    if (h === 0) { status = "— 未配置"; statusClass = "text-slate-400"; }
    else if (h < s.minHoursPerWeek) { status = `△ 最低未達(${s.minHoursPerWeek}h)`; statusClass = "text-amber-600"; }
    else if (h > s.maxHoursPerWeek) { status = `× 上限超過(${s.maxHoursPerWeek}h)`; statusClass = "text-red-600"; }
    else { status = "✓ OK"; statusClass = "text-emerald-600"; }
    const tr = el("tr", { class: "border-t border-slate-100 cursor-pointer hover:bg-slate-50" });
    tr.innerHTML = `
      <td class="px-3 py-2">${escapeHtml(s.name)} <span class="text-xs text-slate-500">${escapeHtml(posCfg(s.position).label)}</span></td>
      <td class="px-3 py-2 text-right">${h.toFixed(1)}h</td>
      <td class="px-3 py-2 text-right">${fmtYen(cost)}</td>
      <td class="px-3 py-2 ${statusClass}">${status}</td>`;
    // クリックでフィルタ適用 (Round 9)
    tr.onclick = () => setStaffFilter(s.id);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  card.appendChild(tbl);
  // 合計表示
  setTimeout(() => {
    const t = card.querySelector("#summary-total");
    if (t) t.textContent = `合計: ${totalH.toFixed(1)}h / ${fmtYen(totalCost)}`;
  }, 0);
  return card;
}

// ===== Drag & Drop & Tap-to-swap =====
let draggedAssignment = null;
let swapModeActive = false;
let swapModeSourceId = null;
// シフト編成のスタッフ別フィルタ (Round 8)
let staffFilter = "all"; // "all" | staffId
function setStaffFilter(v) { staffFilter = v; render(); }
// 複数週まとめ表示 (Round 13)
let multiWeekView = false;
function toggleMultiWeekView() { multiWeekView = !multiWeekView; render(); }

function toggleSwapMode() {
  if (curStatus() === "published") {
    toast("確定済の週は編集不可。先に「下書きに戻す」してください", "error");
    return;
  }
  swapModeActive = !swapModeActive;
  swapModeSourceId = null;
  render();
}

function handleChipTap(a) {
  if (!swapModeActive) {
    openAssignmentDetail(a);
    return;
  }
  if (curStatus() === "published") {
    swapModeActive = false; swapModeSourceId = null;
    toast("確定済の週は編集不可", "error");
    render();
    return;
  }
  if (!swapModeSourceId) {
    swapModeSourceId = a.id;
    render();
    toast(`${(state.staff.find(s => s.id === a.staffId) || {}).name || "?"} を選択。次に入替先のシフトをタップ`, "info", 4000);
    return;
  }
  if (swapModeSourceId === a.id) {
    swapModeSourceId = null;
    render();
    return;
  }
  const source = curAssignments().find(x => x.id === swapModeSourceId);
  if (!source) {
    swapModeSourceId = null; render(); return;
  }
  // 既存の swap ロジックを流用
  draggedAssignment = source;
  const fakeEvent = { preventDefault: () => {} };
  handleChipDrop(fakeEvent, a);
  swapModeSourceId = null;
  // モードはタップ後 1 ペアで自動オフ。連続入替したい場合は再度ボタン押下
  swapModeActive = false;
  render();
}

function handleChipDragStart(e, a) {
  draggedAssignment = a;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", a.id);
  e.target.classList.add("dragging");
}

// ===== Touch D&D サポート (Round 17 TOP 3) =====
let _touchState = null;

function handleChipTouchStart(e, a) {
  if (curStatus() === "published") return;
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  const chip = e.currentTarget;
  // 長押し検出 (350ms 静止) で D&D モード開始
  _touchState = {
    a, chip, startX: t.clientX, startY: t.clientY,
    moved: false, dragging: false,
    longPressTimer: setTimeout(() => {
      if (_touchState && !_touchState.moved) {
        _touchState.dragging = true;
        draggedAssignment = a;
        chip.classList.add("dragging");
        // ハプティック
        if (navigator.vibrate) navigator.vibrate(20);
        toast("シフトを移動できます (指を移動して別のシフトの上で離す)", "info", 2500);
      }
    }, 350),
  };
}

function handleChipTouchMove(e) {
  if (!_touchState) return;
  const t = e.touches[0];
  const dx = t.clientX - _touchState.startX;
  const dy = t.clientY - _touchState.startY;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
    _touchState.moved = true;
    if (!_touchState.dragging) {
      // 通常スクロールへ移行 (D&D 起動前の移動)
      clearTimeout(_touchState.longPressTimer);
    }
  }
  if (_touchState.dragging) {
    e.preventDefault();
    // 指の下のドロップターゲットをハイライト
    const elUnder = document.elementFromPoint(t.clientX, t.clientY);
    document.querySelectorAll(".assignment-chip.drop-target").forEach(c => c.classList.remove("drop-target"));
    if (elUnder) {
      const targetChip = elUnder.closest(".assignment-chip.editable");
      if (targetChip && targetChip !== _touchState.chip) {
        targetChip.classList.add("drop-target");
      }
    }
  }
}

function handleChipTouchEnd(e) {
  if (!_touchState) return;
  clearTimeout(_touchState.longPressTimer);
  if (_touchState.dragging) {
    const t = e.changedTouches[0];
    const elUnder = document.elementFromPoint(t.clientX, t.clientY);
    if (elUnder) {
      const targetChip = elUnder.closest(".assignment-chip.editable");
      if (targetChip && targetChip !== _touchState.chip) {
        const targetId = targetChip.getAttribute("data-assignment-id");
        const targetA = curAssignments().find(x => x.id === targetId);
        if (targetA) {
          const fakeEvt = { preventDefault: () => {} };
          handleChipDrop(fakeEvt, targetA);
        }
      }
    }
    _touchState.chip.classList.remove("dragging");
    document.querySelectorAll(".assignment-chip.drop-target").forEach(c => c.classList.remove("drop-target"));
  } else if (!_touchState.moved) {
    // タップ → 通常のクリックハンドラに任せる (touchend → click)
  }
  _touchState = null;
}

async function notifyShiftChanges(staffIds) {
  // Round 8: 確定後の変更があった場合、該当スタッフのみに再通知メール送信
  if (curStatus() !== "published") return; // 下書きなら通知しない
  const withEmail = state.staff.filter(s => staffIds.includes(s.id) && (s.email || "").trim());
  if (withEmail.length === 0) return;
  if (!confirm(
    `シフト変更に伴い、影響を受ける ${withEmail.length} 名のスタッフ (${withEmail.map(s => s.name).join("・")}) にメール再送しますか？\n` +
    `件名に【シフト変更】と付きます。`
  )) return;
  try {
    const r = await window.ShiftyAPI.notifyShifts(state.meta.currentWeekStart, {
      staffIds: withEmail.map(s => s.id),
      subjectPrefix: "【シフト変更】",
    });
    toast(`✉️ ${r.sent || 0} 名に変更通知を送信`, "success");
  } catch (e) {
    toast("変更通知失敗: " + e.message, "error");
  }
}

function handleChipDrop(e, target) {
  e.preventDefault();
  if (!draggedAssignment || draggedAssignment.id === target.id) { draggedAssignment = null; return; }
  if (curStatus() === "published") { toast("確定済では編集不可", "error"); draggedAssignment = null; return; }

  // Swap staffIds between dragged and target
  const draggedStaff = state.staff.find(s => s.id === draggedAssignment.staffId);
  const targetStaff = state.staff.find(s => s.id === target.staffId);
  if (!draggedStaff || !targetStaff) { draggedAssignment = null; return; }

  // Eligibility check: each staff must be able to cover the other's slot
  const checkEligible = (staff, slot) => {
    if (staff.position !== slot.position && !staff.canCover.includes(slot.position)) return false;
    if (staff.fixedDayOff.includes(dayOfWeek(slot.date))) return false;
    return true;
  };
  const draggedFitsTarget = checkEligible(draggedStaff, target);
  const targetFitsDragged = checkEligible(targetStaff, draggedAssignment);
  if (!draggedFitsTarget || !targetFitsDragged) {
    if (!confirm(`⚠️ 制約違反の可能性があります（ポジション/固定休）。それでも入替えしますか？`)) {
      draggedAssignment = null;
      return;
    }
  }

  const newDragged = {
    ...draggedAssignment,
    staffId: target.staffId,
    cost: targetStaff.hourlyWage * calcHours(draggedAssignment.startTime, draggedAssignment.endTime),
    reasons: [["手動入替", 0]],
    score: 0,
  };
  const newTarget = {
    ...target,
    staffId: draggedAssignment.staffId,
    cost: draggedStaff.hourlyWage * calcHours(target.startTime, target.endTime),
    reasons: [["手動入替", 0]],
    score: 0,
  };
  curWeek().assignments = curAssignments().map(a => {
    if (a.id === draggedAssignment.id) return newDragged;
    if (a.id === target.id) return newTarget;
    return a;
  });
  logChange("swap", `${draggedStaff.name} ⇔ ${targetStaff.name} 入替（${draggedAssignment.date} ${draggedAssignment.startTime}〜 と ${target.date} ${target.startTime}〜）`);
  draggedAssignment = null;
  persist(); render();
  toast(`${draggedStaff.name} ⇔ ${targetStaff.name} 入替完了`, "success");
}

// ===== Templates =====
function openTemplateDialog() {
  const body = el("div", { class: "p-6 space-y-4" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📑 シフトテンプレート"));

  // Save current as template
  body.appendChild(el("div", { class: "bg-purple-50 border border-purple-200 rounded-md p-3" }, [
    el("div", { class: "text-sm text-purple-900 font-semibold mb-2" }, "現在の週をテンプレートに保存"),
    el("div", { class: "flex gap-2" }, [
      el("input", { id: "tpl-name", class: "flex-1 border rounded-md px-3 py-1.5 text-sm", placeholder: "テンプレ名（例: 通常週、夏休みシフト）" }),
      el("button", { class: "text-sm bg-purple-600 text-white rounded-md px-3 py-1.5",
        onclick: saveCurrentAsTemplate }, "💾 保存"),
    ]),
  ]));

  // List templates
  const list = el("div", { class: "space-y-2" });
  if (!state.meta.templates?.length) {
    list.appendChild(el("div", { class: "text-sm text-slate-500 text-center py-6" }, "保存済テンプレートはありません"));
  } else {
    state.meta.templates.forEach(tpl => {
      const row = el("div", { class: "bg-slate-50 rounded-md p-3 flex items-center justify-between gap-2" });
      const meta = el("div", {});
      meta.innerHTML = `<div class="font-semibold text-sm">${escapeHtml(tpl.name)}</div>
        <div class="text-xs text-slate-500">${tpl.createdAt?.slice(0, 10) || "?"} / ${tpl.patterns?.length || 0} 配置</div>`;
      row.appendChild(meta);
      row.appendChild(el("div", { class: "flex gap-2" }, [
        el("button", { class: "text-xs bg-purple-600 text-white rounded-md px-3 py-1.5",
          onclick: () => applyTemplate(tpl.id) }, "📥 読込"),
        el("button", { class: "text-xs text-red-600 hover:underline",
          onclick: () => {
            if (!confirm(`「${tpl.name}」を削除しますか？`)) return;
            state.meta.templates = state.meta.templates.filter(t => t.id !== tpl.id);
            persist(); closeModal(); openTemplateDialog();
            toast("削除しました", "success");
          } }, "削除"),
      ]));
      list.appendChild(row);
    });
  }
  body.appendChild(list);

  body.appendChild(el("div", { class: "flex justify-end" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
}

function saveCurrentAsTemplate() {
  const name = $("#tpl-name").value.trim();
  if (!name) { toast("テンプレ名を入力", "error"); return; }
  if (!curAssignments().length) { toast("現在の週にアサインがありません", "error"); return; }

  const patterns = curAssignments().map(a => ({
    dayOfWeek: dayOfWeek(a.date),
    position: a.position,
    startTime: a.startTime,
    endTime: a.endTime,
    staffId: a.staffId,
  }));
  state.meta.templates.push({
    id: uid("tpl_"),
    name, createdAt: new Date().toISOString(),
    patterns,
  });
  persist();
  closeModal();
  openTemplateDialog();
  toast(`「${name}」を保存しました（${patterns.length}配置）`, "success");
}

function applyTemplate(templateId) {
  const tpl = state.meta.templates.find(t => t.id === templateId);
  if (!tpl) return;
  if (curStatus() === "published") { toast("確定済の週には適用できません", "error"); return; }
  if (curAssignments().length > 0 && !confirm("既存のアサインを上書きします。続行しますか？")) return;

  const w0 = state.meta.currentWeekStart;
  const newAssignments = [];
  let skippedNoStaff = 0, skippedFixedOff = 0;

  for (const p of tpl.patterns) {
    // 同じdayOfWeekの今週日付を探す
    let date = null;
    for (let i = 0; i < 7; i++) {
      const d = addDays(w0, i);
      if (dayOfWeek(d) === p.dayOfWeek) { date = d; break; }
    }
    if (!date) continue;
    const s = state.staff.find(x => x.id === p.staffId);
    if (!s) { skippedNoStaff++; continue; }
    if (s.fixedDayOff.includes(p.dayOfWeek)) { skippedFixedOff++; continue; }
    newAssignments.push({
      id: uid("a_"),
      date,
      staffId: p.staffId,
      position: p.position,
      startTime: p.startTime,
      endTime: p.endTime,
      cost: s.hourlyWage * calcHours(p.startTime, p.endTime),
      reasons: [["テンプレ復元", 0]],
      score: 0,
    });
  }
  curWeek().assignments = newAssignments;
  persist(); closeModal(); render();
  const msg = `${newAssignments.length}件適用` + (skippedNoStaff ? ` / 退職者${skippedNoStaff}除外` : "") + (skippedFixedOff ? ` / 固定休${skippedFixedOff}除外` : "");
  toast(msg, "success");
}

function copyFromPreviousWeek() {
  const cur = state.meta.currentWeekStart;
  const prev = addDays(cur, -7);
  const prevWeek = state.weeks[prev];
  if (!prevWeek || !prevWeek.assignments?.length) {
    toast("先週のシフトデータが見つかりません", "error");
    return;
  }
  if (curStatus() === "published") {
    toast("確定済の週には貼り付けできません", "error");
    return;
  }
  if (curAssignments().length > 0) {
    if (!confirm("今の週に既にアサインがあります。上書きしますか？")) return;
  }
  let copied = 0, skippedNoStaff = 0, skippedFixedOff = 0;
  const newAssignments = [];
  for (const a of prevWeek.assignments) {
    const newDate = addDays(a.date, 7);
    const s = state.staff.find(x => x.id === a.staffId);
    if (!s) { skippedNoStaff++; continue; }
    if (s.fixedDayOff.includes(dayOfWeek(newDate))) { skippedFixedOff++; continue; }
    newAssignments.push({ ...a, id: uid("a_"), date: newDate });
    copied++;
  }
  curWeek().assignments = newAssignments;
  persist(); render();
  const msg = `${copied} 件をコピー` + (skippedNoStaff ? ` / 退職者${skippedNoStaff}件除外` : "") + (skippedFixedOff ? ` / 固定休${skippedFixedOff}件除外` : "");
  toast(msg, "success");
}

function autoGenerate() {
  if (state.staff.length === 0) {
    toast("スタッフが登録されていません。スタッフタブで追加するか、ダッシュボードの「🎯 サンプルで試す」をご利用ください", "error", 6000);
    return;
  }
  if (curStatus() === "published") { toast("確定済の週は再生成できません。先に「下書きに戻す」してください。", "error"); return; }
  if (curSlots().length === 0) { toast("シフト枠がありません。設定タブの「必要人数」で定義してください。", "error"); return; }
  // Round 31 TOP 1: 既存アサインがある場合はプレビュー → 確認モーダル
  if (curAssignments().length > 0) {
    openAutoGeneratePreviewDialog();
    return;
  }
  // 初回生成は即実行
  runAutoGenerate();
}

// Round 31 TOP 1: AI 生成プレビュー
function openAutoGeneratePreviewDialog() {
  const slotN = curSlots().reduce((s, x) => s + x.requiredCount, 0);
  const staffN = state.staff.filter(s => !s.archived).length;
  const submittedN = state.staff.filter(s => !s.archived && curPrefs().some(p => p.staffId === s.id)).length;
  // 簡易予測 (ヒューリスティック)
  const expCoverage = Math.min(100, Math.round((Math.min(staffN, slotN) / slotN) * 100));
  const prefRate = staffN > 0 ? submittedN / staffN : 0;
  const expPrefSat = Math.min(95, Math.round(60 + prefRate * 30));
  // 平均時給 × 平均時間 × slotN
  const avgWage = state.staff.length > 0 ? state.staff.reduce((s, x) => s + x.hourlyWage, 0) / state.staff.length : 1100;
  const avgHours = curSlots().length > 0 ? curSlots().reduce((s, x) => s + calcHours(x.startTime, x.endTime), 0) / curSlots().length : 5;
  const expCost = Math.round(avgWage * avgHours * slotN);

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🤖 AI シフト生成プレビュー"));
  body.appendChild(el("div", { class: "text-xs text-slate-600 dark:text-slate-400" },
    "既存のアサインを上書きして再生成します。実行前に予測値を確認してください。"));

  body.appendChild(el("div", { class: "grid grid-cols-2 gap-2" }, [
    el("div", { class: "bg-slate-50 dark:bg-slate-800 rounded p-2.5" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "シフト枠"),
      el("div", { class: "font-bold text-base" }, `${slotN} 枠 / ${staffN} 名`),
    ]),
    el("div", { class: "bg-slate-50 dark:bg-slate-800 rounded p-2.5" }, [
      el("div", { class: "text-[10px] text-slate-500" }, "希望提出"),
      el("div", { class: "font-bold text-base" }, `${submittedN}/${staffN} 名`),
    ]),
    el("div", { class: "bg-emerald-50 dark:bg-emerald-900/30 rounded p-2.5" }, [
      el("div", { class: "text-[10px] text-emerald-700 dark:text-emerald-400" }, "予測カバー率"),
      el("div", { class: "font-bold text-base text-emerald-700 dark:text-emerald-400" }, `${expCoverage}%`),
    ]),
    el("div", { class: "bg-blue-50 dark:bg-blue-900/30 rounded p-2.5" }, [
      el("div", { class: "text-[10px] text-blue-700 dark:text-blue-400" }, "予測希望充足"),
      el("div", { class: "font-bold text-base text-blue-700 dark:text-blue-400" }, `~${expPrefSat}%`),
    ]),
    el("div", { class: "bg-amber-50 dark:bg-amber-900/30 rounded p-2.5 col-span-2" }, [
      el("div", { class: "text-[10px] text-amber-700 dark:text-amber-400" }, "予測人件費"),
      el("div", { class: "font-bold text-base text-amber-700 dark:text-amber-400" }, fmtYen(expCost) + " (週)"),
      el("div", { class: "text-[10px] text-slate-500" }, `予算 ${fmtYen(state.meta.weeklyBudget || 0)} ${expCost > (state.meta.weeklyBudget || 0) ? "・⚠️ 超過の可能性" : "内"}`),
    ]),
  ]));

  // AI 戦略の確認
  const aw = state.meta.algorithmWeights || {};
  const top = Object.entries(aw).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const topLabels = { preference: "希望充足", positionMatch: "ポジション", fairness: "公平性", cost: "コスト", skill: "スキル", skillMix: "スキル構成" };
  body.appendChild(el("div", { class: "text-xs text-slate-600 dark:text-slate-400 bg-purple-50 dark:bg-purple-900/30 rounded p-2 mt-2" },
    `🎯 重視している指標: ${top.map(([k, v]) => `${topLabels[k] || k} ${(v * 100).toFixed(0)}%`).join(" / ")} (シフトタブのプルダウンで切替)`));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold",
      onclick: () => { closeModal(); runAutoGenerate(); },
    }, "🤖 実行"),
  ]));
  modal(body);
}

function runAutoGenerate() {

  // Round 9: AI 生成中のプログレスモーダル表示
  const slotN = curSlots().reduce((s, x) => s + x.requiredCount, 0);
  const staffN = state.staff.length;
  const estimatedSec = Math.max(1, Math.ceil(staffN * slotN / 600));  // 簡易予測
  const body = el("div", { class: "p-6 text-center space-y-3" });
  body.innerHTML = `
    <div class="text-4xl">🤖</div>
    <h3 class="font-bold text-lg">AI シフト生成中…</h3>
    <p class="text-sm text-slate-600">
      スタッフ ${staffN} 名 × シフト枠 ${slotN} 枠を最適化中。<br>
      予測時間: 約 ${estimatedSec} 秒
    </p>
    <div class="w-full bg-slate-200 rounded-full h-3 overflow-hidden">
      <div id="progress-bar" class="h-full bg-gradient-to-r from-brand-500 to-brand-700 transition-all duration-200" style="width: 5%"></div>
    </div>
    <div id="progress-status" class="text-xs text-slate-500">準備中...</div>
    <div id="progress-elapsed" class="text-[10px] text-slate-400">経過: 0.0s</div>`;
  modal(body);

  const startTime = Date.now();
  let phaseIdx = 0;
  const phases = [
    { pct: 15, status: "📋 入力データ整理中..." },
    { pct: 35, status: "🎯 Phase 1: 困難スロット優先で配置中..." },
    { pct: 65, status: "⚙️ Phase 2: ペアスワップで最適化中..." },
    { pct: 85, status: "✓ ハード制約検証中..." },
    { pct: 95, status: "📊 メトリクス計算中..." },
  ];
  // プログレスバーをアニメーション
  const progressTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const elEl = document.getElementById("progress-elapsed");
    if (elEl) elEl.textContent = `経過: ${elapsed.toFixed(1)}s`;
    if (phaseIdx < phases.length) {
      const phase = phases[phaseIdx];
      const bar = document.getElementById("progress-bar");
      const stat = document.getElementById("progress-status");
      if (bar) bar.style.width = `${phase.pct}%`;
      if (stat) stat.textContent = phase.status;
      phaseIdx++;
    }
  }, Math.max(150, estimatedSec * 200));

  // 実際の生成は requestIdleCallback / setTimeout で UI ブロック回避
  setTimeout(() => {
    try {
      // AI 生成前に自動スナップショット (Round 17 TOP 1) — 既存アサインがある場合のみ
      if (curAssignments().length > 0) {
        try { createSnapshot("auto_autogen", `AI再生成前 (${state.meta.currentWeekStart})`); } catch (_) {}
      }
      // Round 13: 固定出勤を must preferences として注入
      const w0 = state.meta.currentWeekStart;
      const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
      const syntheticPrefs = [];
      for (const s of state.staff) {
        if (!s.fixedShifts || !s.fixedShifts.length) continue;
        for (const fs of s.fixedShifts) {
          const sess = state.meta.sessions.find(x => x.id === fs.sessionId);
          if (!sess) continue;
          for (const d of days) {
            if (dayOfWeek(d) !== fs.dow) continue;
            // 既存希望と衝突しないよう、既存の同 staff/date/time の must が無い場合のみ追加
            const existing = curPrefs().find(p =>
              p.staffId === s.id && p.date === d &&
              p.startTime === sess.startTime && p.endTime === sess.endTime);
            if (!existing) {
              syntheticPrefs.push({
                id: `_fixed_${s.id}_${d}_${fs.sessionId}`,
                staffId: s.id, date: d,
                startTime: sess.startTime, endTime: sess.endTime,
                priority: "must",
              });
            }
          }
        }
      }
      const allPrefs = [...curPrefs(), ...syntheticPrefs];

      const result = generateShift({
        staff: state.staff, slots: curSlots(), preferences: allPrefs,
        laborRules: state.meta.laborRules,
        weights: state.meta.algorithmWeights,
        randomStarts: state.meta.randomStarts || 5,
      });
      clearInterval(progressTimer);
      // 100% に
      const bar = document.getElementById("progress-bar");
      const stat = document.getElementById("progress-status");
      if (bar) bar.style.width = "100%";
      if (stat) stat.textContent = "✅ 完了！";

      state._lastAudit = result.audit;
      curWeek().assignments = result.assignments;
      logChange("autogenerate", `AI生成: ${result.assignments.length}件配置 / カバー${fmtPct(result.metrics.coverageRate)} / 希望${fmtPct(result.metrics.preferenceSatisfaction)}`, {
        audit: result.audit ? { passed: result.audit.passed, violations: result.audit.hardViolations.length } : null,
      });
      persist();
      const m = result.metrics;
      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      setTimeout(() => {
        closeModal();
        render();
        toast(`✅ 完成 (${totalElapsed}s): カバー${fmtPct(m.coverageRate)} / 希望${fmtPct(m.preferenceSatisfaction)} / ${fmtYen(m.totalCost)}`, "success", 4000);
        // Round 32 TOP 3: 改善ポイント自動表示
        setTimeout(() => showPostGenFeedback(result), 800);
      }, 400);
    } catch (e) {
      clearInterval(progressTimer);
      closeModal();
      toast("AI 生成失敗: " + e.message, "error", 6000);
      console.error(e);
    }
  }, 100);
}

// ===== View: Export =====
function viewExport() {
  const wrap = el("div", { class: "space-y-4" });
  wrap.appendChild(el("h2", { class: "text-xl font-bold" }, "エクスポート"));

  if (!curAssignments().length) {
    const empty = el("div", { class: "bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 space-y-3" });
    empty.appendChild(el("div", { class: "font-semibold" }, "シフトがまだ生成されていません"));
    empty.appendChild(el("div", {}, "「📅 シフト編成」タブで「🤖 AI 自動生成」ボタンを押すと、登録済みスタッフ・希望からシフトが自動作成されます。"));
    empty.appendChild(el("button", {
      class: "bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-4 py-2 text-sm font-semibold",
      onclick: () => { setTab("schedule"); setTimeout(autoGenerate, 300); },
    }, "🤖 今すぐ AI 自動生成 →"));
    wrap.appendChild(empty);
    return wrap;
  }

  wrap.appendChild(el("div", { class: "flex gap-2 no-print flex-wrap" }, [
    el("button", { class: "text-sm bg-slate-700 hover:bg-slate-800 text-white rounded-md px-3 py-1.5",
      onclick: downloadCsv, title: "週次のシフト表（汎用）" }, "📄 シフト CSV (週次)"),
    el("button", { class: "text-sm bg-emerald-700 hover:bg-emerald-800 text-white rounded-md px-3 py-1.5",
      onclick: () => openPayrollCsvDialog(), title: "月次の給与計算用 CSV" }, "💴 給与計算 CSV"),
    el("button", { class: "text-sm bg-slate-700 hover:bg-slate-800 text-white rounded-md px-3 py-1.5",
      onclick: () => openPrintMenuDialog(), title: "店内掲示用 / 個人配布用 / 詳細" }, "🖨 印刷"),
    el("button", { class: "text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md px-3 py-1.5",
      onclick: () => openWeeklyReport(), title: "店舗管理用の今週サマリレポート" }, "📊 週次レポート"),
    el("button", { class: "text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-md px-3 py-1.5",
      onclick: () => openMonthlyReport(), title: "月次会議用の月次レポート" }, "📈 月次レポート"),
    el("button", { class: "text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1.5",
      onclick: openLineNotificationDialog }, "💬 LINE通知文を作成"),
  ]));

  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  const tbl = el("div", { class: "bg-white border border-slate-200 rounded-xl overflow-x-auto" });
  let html = `<div class="p-3 font-semibold">${escapeHtml(state.meta.restaurantName)} シフト表 / ${w0}〜</div>
    <table class="w-full text-xs"><thead class="bg-slate-50">
      <tr><th class="text-left px-2 py-1">名前</th>`;
  days.forEach(d => { html += `<th class="px-2 py-1">${d.slice(5)}<br><span class="font-normal">${DAY_LABELS[dayOfWeek(d)]}</span></th>`; });
  html += `<th class="text-right px-2 py-1">時間</th><th class="text-right px-2 py-1">給与</th></tr></thead><tbody>`;
  state.staff.forEach(s => {
    html += `<tr class="border-t border-slate-100"><td class="px-2 py-1 font-semibold">${escapeHtml(s.name)}</td>`;
    days.forEach(d => {
      const list = curAssignments().filter(a => a.staffId === s.id && a.date === d).sort((a,b) => a.startTime.localeCompare(b.startTime));
      html += `<td class="px-2 py-1 text-center">${list.map(a => `${a.startTime.slice(0,5)}-${a.endTime.slice(0,5)}<br><span class="text-[10px] text-slate-500">${escapeHtml(posCfg(a.position).label)}</span>`).join("<hr class=\"my-1\">") || "<span class=\"text-slate-300\">休</span>"}</td>`;
    });
    const h = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const cost = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + a.cost, 0);
    html += `<td class="px-2 py-1 text-right">${h.toFixed(1)}h</td><td class="px-2 py-1 text-right">${fmtYen(cost)}</td></tr>`;
  });
  const totalCost = curAssignments().reduce((s, a) => s + a.cost, 0);
  const totalH = curAssignments().reduce((s, a) => s + calcHours(a.startTime, a.endTime), 0);
  html += `<tr class="border-t-2 border-slate-300 font-bold bg-slate-50"><td class="px-2 py-1">合計</td><td colspan="7"></td><td class="px-2 py-1 text-right">${totalH.toFixed(1)}h</td><td class="px-2 py-1 text-right">${fmtYen(totalCost)}</td></tr>`;
  html += `</tbody></table>`;
  tbl.innerHTML = html;
  wrap.appendChild(tbl);
  return wrap;
}

// 給与計算用 CSV ダイアログ (Round 5)
function openPayrollCsvDialog() {
  const w0 = state.meta.currentWeekStart;
  const monthKey = w0.slice(0, 7);  // YYYY-MM

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "💴 給与計算 CSV エクスポート"));
  body.appendChild(el("p", { class: "text-xs text-slate-600" },
    "確定済シフトのみ集計します。月次の合計時間・給与・各日明細を出力。"));

  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-600" }, "対象月"),
    el("input", { id: "pcsv-month", type: "month", class: "mt-1 w-full border rounded-md px-3 py-2", value: monthKey }),
  ]));

  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-600" }, "形式"),
    el("select", { id: "pcsv-format", class: "mt-1 w-full border rounded-md px-3 py-2" }, [
      el("option", { value: "summary" }, "サマリ（スタッフ × 合計時間 + 給与）"),
      el("option", { value: "detail" }, "明細（日付 × スタッフ × 時間）"),
      el("option", { value: "yayoi" }, "弥生給与 互換 (汎用 CSV)"),
      el("option", { value: "freee" }, "freee 人事労務 互換 (時間単位の従業員別)"),
    ]),
  ]));

  // Round 19: 集計ベース選択
  body.appendChild(el("label", { class: "block text-sm" }, [
    el("span", { class: "text-slate-600" }, "集計ベース"),
    el("select", { id: "pcsv-basis", class: "mt-1 w-full border rounded-md px-3 py-2" }, [
      el("option", { value: "scheduled" }, "予定時間（シフト確定値）"),
      el("option", { value: "actual" }, "実労働時間（打刻ベース）— 推奨"),
      el("option", { value: "actual_with_diff" }, "実労働 + 予定との差分明細"),
    ]),
  ]));
  body.appendChild(el("div", { class: "text-[10px] text-slate-500 -mt-1 pl-1" },
    "💡 「実労働時間」は打刻された時刻から計算。打刻が無いシフトは予定時間で代用。"));

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-md font-semibold",
      onclick: () => {
        const month = $("#pcsv-month").value;
        const format = $("#pcsv-format").value;
        const basis = $("#pcsv-basis").value;
        downloadPayrollCsv(month, format, basis);
        closeModal();
      },
    }, "ダウンロード"),
  ]));
  modal(body);
}

function downloadPayrollCsv(monthKey, format, basis = "scheduled") {
  // 当月の確定済 assignments を全 weeks から集約
  const allWeeks = state.weeks || {};
  const monthAssignments = [];
  for (const wk of Object.values(allWeeks)) {
    if (wk.status !== "published") continue;
    for (const a of (wk.assignments || [])) {
      if ((a.date || "").startsWith(monthKey)) monthAssignments.push(a);
    }
  }
  if (!monthAssignments.length) {
    toast(`${monthKey} の確定済シフトがありません`, "error");
    return;
  }

  // 実労働時間を計算 (Round 19): clockIn/clockOut があればそれを使用、無ければ予定
  const useActual = (basis === "actual" || basis === "actual_with_diff");
  function getEffectiveHours(a) {
    if (useActual && a.clockIn && a.clockOut) {
      try {
        const inDt = new Date(a.clockIn);
        const outDt = new Date(a.clockOut);
        const h = (outDt - inDt) / 3600000;
        if (h > 0) return { hours: h, source: "actual" };
      } catch (_) {}
    }
    return { hours: calcHours(a.startTime, a.endTime), source: "scheduled" };
  }

  // スタッフ別集計 (Round 10: 休憩控除 + Round 14: 深夜手当 + Round 19: 実労働)
  const byStaff = {};
  const ps = state.meta.payrollSettings || {};
  const nightOn = ps.nightAllowanceEnabled;
  const nightStart = ps.nightStartHour || 22;
  const nightRate = ps.nightRate || 1.25;
  function _t(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
  // Round 19: HH:MM 形式で時刻表現を取り出す (実打刻 ISO → JST HH:MM)
  function _isoToHHMM(iso) {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    } catch (_) { return null; }
  }
  for (const a of monthAssignments) {
    if (!byStaff[a.staffId]) byStaff[a.staffId] = { hours: 0, scheduledHours: 0, nightHours: 0, pay: 0, days: [], actualCount: 0, missingCount: 0 };
    const staffRec = state.staff.find(s => s.id === a.staffId);
    const breakMin = (staffRec && staffRec.breakMinutes) || 0;
    // 集計ベースに応じて使う時間を切り替え
    const eff = getEffectiveHours(a);
    let h = eff.hours;
    const schedH = calcHours(a.startTime, a.endTime);
    if (h > 6 && breakMin > 0) h -= breakMin / 60;
    let schedHForReport = schedH;
    if (schedHForReport > 6 && breakMin > 0) schedHForReport -= breakMin / 60;

    // 深夜時間の計算 — 実打刻があればその時間、無ければ予定
    let nightStartT = a.startTime;
    let nightEndT = a.endTime;
    if (useActual && a.clockIn && a.clockOut) {
      const inH = _isoToHHMM(a.clockIn);
      const outH = _isoToHHMM(a.clockOut);
      if (inH && outH) { nightStartT = inH; nightEndT = outH; }
    }
    let nightH = 0;
    if (nightOn && staffRec) {
      const startMin = _t(nightStartT);
      const endMin = _t(nightEndT);
      const nightStartMin = nightStart * 60;
      // シフトが深夜時間帯と重なるか
      if (endMin > nightStartMin) {
        const overlap = Math.max(0, Math.min(endMin, 24*60) - Math.max(startMin, nightStartMin));
        nightH = overlap / 60;
      }
    }
    const dayH = h - nightH;
    const wage = staffRec ? staffRec.hourlyWage : 1100;
    const pay = (wage * dayH) + (wage * nightRate * nightH);
    byStaff[a.staffId].hours += h;
    byStaff[a.staffId].scheduledHours += schedHForReport;
    byStaff[a.staffId].nightHours += nightH;
    byStaff[a.staffId].pay += pay;
    if (eff.source === "actual") byStaff[a.staffId].actualCount += 1;
    else if (useActual) byStaff[a.staffId].missingCount += 1;
    byStaff[a.staffId].days.push(a);
  }

  let csv = "";
  let filename = `payroll_${monthKey}_${format}.csv`;

  if (format === "summary") {
    // Round 19: useActual の場合は実労働カラムも追加
    let head;
    if (useActual && nightOn) {
      head = "スタッフID,氏名,本職,時給,予定時間(h),実労働時間(h),通常時間(h),深夜時間(h),合計時間(h),合計給与(円),打刻有効,打刻欠落\n";
    } else if (useActual) {
      head = "スタッフID,氏名,本職,時給,予定時間(h),実労働時間(h),合計給与(円),打刻有効,打刻欠落\n";
    } else if (nightOn) {
      head = "スタッフID,氏名,本職,時給,通常時間(h),深夜時間(h),合計時間(h),合計給与(円)\n";
    } else {
      head = "スタッフID,氏名,本職,時給,合計時間(h),合計給与(円)\n";
    }
    csv = head;
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      const dayH = (r.hours - r.nightHours);
      let row;
      if (useActual && nightOn) {
        row = [s.id, s.name, posCfg(s.position).label, s.hourlyWage, r.scheduledHours.toFixed(2), r.hours.toFixed(2), dayH.toFixed(2), r.nightHours.toFixed(2), r.hours.toFixed(2), Math.round(r.pay), r.actualCount, r.missingCount];
      } else if (useActual) {
        row = [s.id, s.name, posCfg(s.position).label, s.hourlyWage, r.scheduledHours.toFixed(2), r.hours.toFixed(2), Math.round(r.pay), r.actualCount, r.missingCount];
      } else if (nightOn) {
        row = [s.id, s.name, posCfg(s.position).label, s.hourlyWage, dayH.toFixed(2), r.nightHours.toFixed(2), r.hours.toFixed(2), Math.round(r.pay)];
      } else {
        row = [s.id, s.name, posCfg(s.position).label, s.hourlyWage, r.hours.toFixed(2), Math.round(r.pay)];
      }
      csv += row.map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
  } else if (format === "detail") {
    let head;
    if (basis === "actual_with_diff") {
      head = "日付,曜日,スタッフID,氏名,予定開始,予定終了,予定(h),出勤打刻,退勤打刻,実労働(h),差分(分),ポジション,給与(円),メモ\n";
    } else if (nightOn) {
      head = "日付,曜日,スタッフID,氏名,開始,終了,時間(h),うち深夜(h),ポジション,給与(円),メモ\n";
    } else {
      head = "日付,曜日,スタッフID,氏名,開始,終了,時間(h),ポジション,給与(円),メモ\n";
    }
    csv = head;
    monthAssignments.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    for (const a of monthAssignments) {
      const s = state.staff.find(x => x.id === a.staffId);
      if (!s) continue;
      const breakMin = (s.breakMinutes) || 0;
      const eff = getEffectiveHours(a);
      let h = eff.hours;
      if (h > 6 && breakMin > 0) h -= breakMin / 60;
      const schedH = calcHours(a.startTime, a.endTime);
      // 深夜時間を再計算
      let nightStartT = a.startTime, nightEndT = a.endTime;
      if (useActual && a.clockIn && a.clockOut) {
        nightStartT = _isoToHHMM(a.clockIn) || a.startTime;
        nightEndT = _isoToHHMM(a.clockOut) || a.endTime;
      }
      let nightH = 0;
      if (nightOn) {
        const startMin = _t(nightStartT);
        const endMin = _t(nightEndT);
        const nightStartMin = nightStart * 60;
        if (endMin > nightStartMin) {
          const overlap = Math.max(0, Math.min(endMin, 24*60) - Math.max(startMin, nightStartMin));
          nightH = overlap / 60;
        }
      }
      const dayH = h - nightH;
      const pay = (s.hourlyWage * dayH) + (s.hourlyWage * nightRate * nightH);
      const dow = DAY_LABELS[dayOfWeek(a.date)];
      const memo = a.note || "";
      const inHHMM = _isoToHHMM(a.clockIn) || "";
      const outHHMM = _isoToHHMM(a.clockOut) || "";
      // 差分(分): 実労働 - 予定 (両方ある場合のみ)
      let diffMin = "";
      if (a.clockIn && a.clockOut) {
        try {
          const inDt = new Date(a.clockIn), outDt = new Date(a.clockOut);
          const actualMin = (outDt - inDt) / 60000;
          const schedMin = schedH * 60;
          diffMin = Math.round(actualMin - schedMin);
        } catch (_) {}
      }
      let row;
      if (basis === "actual_with_diff") {
        row = [a.date, dow, s.id, s.name, a.startTime, a.endTime, schedH.toFixed(2), inHHMM, outHHMM, h.toFixed(2), diffMin, posCfg(a.position).label, Math.round(pay), memo];
      } else if (nightOn) {
        row = [a.date, dow, s.id, s.name, a.startTime, a.endTime, h.toFixed(2), nightH.toFixed(2), posCfg(a.position).label, Math.round(pay), memo];
      } else {
        row = [a.date, dow, s.id, s.name, a.startTime, a.endTime, h.toFixed(2), posCfg(a.position).label, Math.round(pay), memo];
      }
      csv += row.map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
  } else if (format === "yayoi") {
    // 弥生給与の汎用取込形式 (社員番号,氏名,勤務時間,合計支給額)
    const head = nightOn
      ? "社員番号,氏名,勤務時間,うち深夜時間,基本給(時給×時間+深夜割増)\n"
      : "社員番号,氏名,勤務時間,基本給(時給×時間)\n";
    csv = head;
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      const row = nightOn
        ? [s.id, s.name, r.hours.toFixed(2), r.nightHours.toFixed(2), Math.round(r.pay)]
        : [s.id, s.name, r.hours.toFixed(2), Math.round(r.pay)];
      csv += row.map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
    filename = `yayoi_${monthKey}.csv`;
  } else if (format === "freee") {
    // freee 人事労務の取込形式 (従業員番号,氏名,労働時間,時給,給与)
    const head = nightOn
      ? "従業員番号,従業員氏名,労働時間,うち深夜時間,時給,給与額\n"
      : "従業員番号,従業員氏名,労働時間,時給,給与額\n";
    csv = head;
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      const row = nightOn
        ? [s.id, s.name, r.hours.toFixed(2), r.nightHours.toFixed(2), s.hourlyWage, Math.round(r.pay)]
        : [s.id, s.name, r.hours.toFixed(2), s.hourlyWage, Math.round(r.pay)];
      csv += row.map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
    filename = `freee_${monthKey}.csv`;
  }

  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  // Round 19: 集計ベースを toast に表示
  let basisLabel = "";
  if (useActual) {
    const totalActual = Object.values(byStaff).reduce((s, r) => s + (r.actualCount || 0), 0);
    const totalMissing = Object.values(byStaff).reduce((s, r) => s + (r.missingCount || 0), 0);
    basisLabel = ` [実労働ベース: 打刻あり ${totalActual} / 欠落 ${totalMissing}]`;
  } else {
    basisLabel = " [予定時間ベース]";
  }
  toast(`${filename} をダウンロード (${Object.keys(byStaff).length} 名分)${basisLabel}`, "success", 5000);
}

function downloadCsv() {
  const w0 = state.meta.currentWeekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
  let csv = "名前," + days.map(d => `${d}(${DAY_LABELS[dayOfWeek(d)]})`).join(",") + ",時間,給与\n";
  state.staff.forEach(s => {
    const cells = days.map(d => {
      const list = curAssignments().filter(a => a.staffId === s.id && a.date === d).sort((a,b) => a.startTime.localeCompare(b.startTime));
      return list.map(a => `${a.startTime}-${a.endTime}(${posCfg(a.position).label})`).join("/");
    });
    const h = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + calcHours(a.startTime, a.endTime), 0);
    const cost = curAssignments().filter(a => a.staffId === s.id).reduce((sm, a) => sm + a.cost, 0);
    csv += [s.name, ...cells, h.toFixed(1) + "h", cost].map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
  });
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `shift_${w0}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("CSVをダウンロードしました", "success");
}

// ===== View: Settings =====
function viewSettings() {
  const wrap = el("div", { class: "space-y-3" });
  wrap.appendChild(el("h2", { class: "text-xl font-bold" }, "⚙️ 店舗設定"));
  wrap.appendChild(el("div", { class: "text-sm text-slate-600 dark:text-slate-400" },
    "ここで設定した内容に基づいて、シフト枠（必要人数マトリクス）が生成されます。"));

  // Round 32 TOP 1: 初心者向けクイック設定ウィザード (業態未設定の場合のみ表示)
  if (!state.meta.businessType || state.meta.businessType === null) {
    const quickCard = el("div", { class: "bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/30 dark:to-orange-900/30 border-2 border-amber-300 dark:border-amber-700 rounded-xl p-4" });
    quickCard.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="text-3xl">🚀</div>
        <div class="flex-1">
          <h3 class="font-bold text-base text-amber-900 dark:text-amber-200">はじめての方は 2 分で完了します</h3>
          <p class="text-xs text-amber-800 dark:text-amber-300 mt-1">
            業態を選ぶだけで、営業時間・必要人数・労務ルール・AI 重み・人件費目標を一括最適化します。
            後から個別に微調整できます。
          </p>
        </div>
      </div>`;
    quickCard.appendChild(el("button", {
      class: "mt-3 w-full bg-amber-500 hover:bg-amber-600 text-white rounded-md px-4 py-2.5 text-sm font-bold",
      onclick: openQuickSetupWizard,
    }, "🎯 業態を選んで一括設定 →"));
    wrap.appendChild(quickCard);
  }

  // Round 30: 検索バー + グルーピングナビ (TOC リファクタ)
  const navCard = el("div", { class: "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 sticky top-2 z-10" });
  // 検索バー
  navCard.appendChild(el("input", {
    type: "search",
    id: "set-search",
    placeholder: "🔍 設定項目を検索 (例: 深夜手当・ポジション・締切)",
    class: "w-full border rounded-md px-3 py-2 text-sm mb-2 dark:bg-slate-700 dark:border-slate-600",
    "aria-label": "設定検索",
    oninput: (e) => filterSettingsBySearch(e.target.value),
  }));
  // グルーピング (5 カテゴリ)
  const groups = [
    { label: "🏪 店舗", links: [
      ["#set-basic", "基本情報"],
      ["#set-positions", "ポジション"],
      ["#set-sessions", "営業時間"],
    ]},
    { label: "📅 シフトルール", links: [
      ["#set-staffing", "必要人数"],
      ["#set-labor", "労務ルール"],
      ["#set-deadline", "提出締切"],
    ]},
    { label: "🤖 AI", links: [
      ["#set-algo", "AI 重み"],
    ]},
    { label: "💾 バックアップ", links: [
      ["#set-backup", "バックアップ"],
    ]},
  ];
  for (const g of groups) {
    const groupRow = el("div", { class: "flex items-center gap-2 flex-wrap text-xs mb-1" });
    groupRow.appendChild(el("span", { class: "font-semibold text-slate-700 dark:text-slate-300 min-w-20" }, g.label));
    for (const [href, label] of g.links) {
      groupRow.appendChild(el("a", { href, class: "bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded px-2 py-1" }, label));
    }
    navCard.appendChild(groupRow);
  }
  wrap.appendChild(navCard);

  // Basic
  const basic = el("div", { id: "set-basic", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  basic.appendChild(el("div", { class: "font-semibold" }, "1. 基本情報"));
  const grid1 = el("div", { class: "grid grid-cols-1 md:grid-cols-3 gap-3 text-sm" });
  grid1.innerHTML = `
    <label class="block"><span class="text-slate-600">店舗名</span>
      <input id="set-name" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(state.meta.restaurantName)}"></label>
    <label class="block"><span class="text-slate-600">週の予算(円)</span>
      <input id="set-budget" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${state.meta.weeklyBudget}"></label>
    <label class="block"><span class="text-slate-600">対象週(月曜)</span>
      <input id="set-weekstart" type="date" class="mt-1 w-full border rounded-md px-3 py-2" value="${state.meta.currentWeekStart}"></label>`;
  basic.appendChild(grid1);
  basic.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: () => {
      state.meta.restaurantName = $("#set-name").value;
      state.meta.weeklyBudget = Number($("#set-budget").value) || 0;
      const newWeek = $("#set-weekstart").value;
      if (newWeek && newWeek !== state.meta.currentWeekStart) {
        state.meta.currentWeekStart = newWeek;
        ensureWeek(state, newWeek);
      }
      persist(); render(); toast("基本情報を更新", "success");
    } }, "保存"));
  wrap.appendChild(basic);

  // Password
  const passCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3" });
  passCard.appendChild(el("div", { class: "font-semibold" }, "2. オーナーパスワード変更"));
  const passGrid = el("div", { class: "grid grid-cols-1 md:grid-cols-3 gap-3 text-sm" });
  passGrid.innerHTML = `
    <label class="block"><span class="text-slate-600">現在のパスワード</span>
      <input id="set-curpass" type="password" class="mt-1 w-full border rounded-md px-3 py-2"></label>
    <label class="block"><span class="text-slate-600">新パスワード(6字以上)</span>
      <input id="set-newpass" type="password" class="mt-1 w-full border rounded-md px-3 py-2"></label>
    <label class="block"><span class="text-slate-600">確認</span>
      <input id="set-newpass2" type="password" class="mt-1 w-full border rounded-md px-3 py-2"></label>`;
  passCard.appendChild(passGrid);
  passCard.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: async () => {
      const cur = $("#set-curpass").value;
      const n1 = $("#set-newpass").value;
      const n2 = $("#set-newpass2").value;
      if (!cur || !n1) return toast("入力してください", "error");
      if (n1 !== n2) return toast("新パスワードが一致しません", "error");
      if (n1.length < 6) return toast("6文字以上必要", "error");
      try {
        await window.ShiftyAPI.authChangePassword(cur, n1);
        $("#set-curpass").value = $("#set-newpass").value = $("#set-newpass2").value = "";
        toast("パスワードを変更しました", "success");
      } catch (e) {
        toast(e.message.includes("invalid_current") ? "現在のパスワードが違います" : "変更失敗: " + e.message, "error");
      }
    } }, "変更"));
  wrap.appendChild(passCard);

  // Positions
  const posCard = el("div", { id: "set-positions", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  posCard.appendChild(el("div", { class: "flex items-center justify-between" }, [
    el("div", { class: "font-semibold" }, "3. ポジション"),
    el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
      onclick: () => editPositionDialog() }, "＋ 追加"),
  ]));
  const posList = el("div", { class: "space-y-2" });
  state.meta.positions.forEach(p => {
    const row = el("div", { class: "flex items-center gap-2 bg-slate-50 rounded-md p-2 text-sm" });
    row.innerHTML = `
      <span class="pos-badge" style="background:${p.color}">${escapeHtml(p.label)}</span>
      <span class="text-xs text-slate-500 font-mono">${escapeHtml(p.id)}</span>`;
    row.appendChild(el("div", { class: "ml-auto flex gap-2" }, [
      el("button", { class: "text-xs text-brand-600 hover:underline",
        onclick: () => editPositionDialog(p) }, "編集"),
      el("button", { class: "text-xs text-red-600 hover:underline",
        onclick: () => {
          if (!confirm(`${p.label} を削除しますか？このポジションを使うスタッフ・シフト枠は保持されますがラベル表示が壊れます。`)) return;
          state.meta.positions = state.meta.positions.filter(x => x.id !== p.id);
          for (const sessId in state.meta.staffingPlan) {
            for (const dow in state.meta.staffingPlan[sessId]) {
              delete state.meta.staffingPlan[sessId][dow][p.id];
            }
          }
          regenerateCurSlots();
          persist(); render(); toast("削除しました", "success");
        } }, "削除"),
    ]));
    posList.appendChild(row);
  });
  posCard.appendChild(posList);
  wrap.appendChild(posCard);

  // Sessions
  const sessCard = el("div", { id: "set-sessions", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  sessCard.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("div", { class: "font-semibold" }, "4. 営業セッション（時間帯）"),
    el("div", { class: "flex gap-2" }, [
      el("button", { class: "text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1.5",
        onclick: openSessionPresetsDialog,
        title: "業態に合わせたプリセットから選択" }, "📋 プリセット選択"),
      el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
        onclick: () => editSessionDialog() }, "＋ 追加"),
    ]),
  ]));
  // セッションタイムライン可視化 (Round 18 TOP 2)
  const tl = renderSessionsTimeline(state.meta.sessions);
  if (tl) sessCard.appendChild(tl);
  const sessList = el("div", { class: "space-y-2" });
  state.meta.sessions.forEach(s => {
    const row = el("div", { class: "flex items-center gap-2 bg-slate-50 rounded-md p-2 text-sm flex-wrap" });
    row.innerHTML = `
      <span class="text-lg">${s.icon || ""}</span>
      <span class="font-medium">${escapeHtml(s.label)}</span>
      <span class="text-xs text-slate-500 font-mono">${escapeHtml(s.id)}</span>
      <span class="text-xs text-slate-600">${s.startTime}〜${s.endTime}</span>`;
    row.appendChild(el("div", { class: "ml-auto flex gap-2" }, [
      el("button", { class: "text-xs text-brand-600 hover:underline",
        onclick: () => editSessionDialog(s) }, "編集"),
      el("button", { class: "text-xs text-red-600 hover:underline",
        onclick: () => {
          if (!confirm(`${s.label} を削除しますか？`)) return;
          state.meta.sessions = state.meta.sessions.filter(x => x.id !== s.id);
          delete state.meta.staffingPlan[s.id];
          regenerateCurSlots();
          persist(); render(); toast("削除しました", "success");
        } }, "削除"),
    ]));
    sessList.appendChild(row);
  });
  sessCard.appendChild(sessList);
  wrap.appendChild(sessCard);

  // Staffing matrix
  const matrixCard = el("div", { id: "set-staffing", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  const matrixHeader = el("div", { class: "flex items-center justify-between flex-wrap gap-2" });
  matrixHeader.innerHTML = `<div class="font-semibold">5. 必要人数マトリクス${helpIcon("staffing-matrix")}</div>`;
  matrixHeader.appendChild(el("button", {
    class: "text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-md px-3 py-1.5 font-semibold",
    onclick: openModelShiftDialog,
    title: "過去の確定済シフト + 売上から AI が推奨人数を提案",
  }, "💡 AI 推奨人数 (Round 21)"));
  matrixCard.appendChild(matrixHeader);
  matrixCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "セルに必要人数を入力。0で枠なし。新規作成週には自動適用。既存週には『今の週に再適用』で反映。"));

  for (const sess of state.meta.sessions) {
    const sessSection = el("div", { class: "border border-slate-200 rounded-md p-3 space-y-2" });
    sessSection.appendChild(el("div", { class: "font-semibold text-sm flex items-center gap-2" }, [
      el("span", {}, sess.icon || ""),
      el("span", {}, `${sess.label} (${sess.startTime}〜${sess.endTime})`),
    ]));
    const tbl = el("table", { class: "w-full text-xs" });
    let headHtml = `<thead><tr><th class="text-left p-1">ポジション</th>`;
    for (let d = 1; d <= 7; d++) {
      const dow = d === 7 ? 0 : d;
      const dowColor = dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "";
      headHtml += `<th class="p-1 text-center ${dowColor}">${DAY_LABELS[dow]}</th>`;
    }
    headHtml += `</tr></thead><tbody>`;
    let bodyHtml = "";
    for (const pos of state.meta.positions) {
      bodyHtml += `<tr class="border-t border-slate-100"><td class="p-1">${posBadge(pos.id)}</td>`;
      for (let d = 1; d <= 7; d++) {
        const dow = d === 7 ? 0 : d;
        const cur = state.meta.staffingPlan[sess.id]?.[dow]?.[pos.id] || 0;
        bodyHtml += `<td class="p-1 text-center"><input type="number" min="0" class="w-12 border rounded px-1 py-0.5 text-center"
          data-mat-sess="${sess.id}" data-mat-dow="${dow}" data-mat-pos="${pos.id}" value="${cur}"></td>`;
      }
      bodyHtml += `</tr>`;
    }
    tbl.innerHTML = headHtml + bodyHtml + `</tbody>`;
    sessSection.appendChild(tbl);
    matrixCard.appendChild(sessSection);
  }
  matrixCard.appendChild(el("div", { class: "flex gap-2 flex-wrap" }, [
    el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-4 py-1.5",
      onclick: () => {
        $$("input[data-mat-sess]").forEach(inp => {
          const ses = inp.dataset.matSess, dow = inp.dataset.matDow, pos = inp.dataset.matPos;
          state.meta.staffingPlan[ses] = state.meta.staffingPlan[ses] || {};
          state.meta.staffingPlan[ses][dow] = state.meta.staffingPlan[ses][dow] || {};
          state.meta.staffingPlan[ses][dow][pos] = Number(inp.value) || 0;
        });
        persist(); toast("計画を保存（新規作成週に自動適用）", "success");
      } }, "💾 計画を保存"),
    el("button", { class: "text-sm border border-brand-600 text-brand-600 rounded-md px-4 py-1.5",
      onclick: () => {
        if (curStatus() === "published") return toast("確定済の週には再適用できません", "error");
        regenerateCurSlots();
        persist(); render(); toast("今の週に再適用しました", "success");
      } }, "↻ 今の週に再適用"),
  ]));
  wrap.appendChild(matrixCard);

  // Labor rules
  const laborCard = el("div", { id: "set-labor", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  const laborHeader = el("div", { class: "font-semibold" });
  laborHeader.innerHTML = `6. 労務ルール（労基順守）${helpIcon("labor-rules")}`;
  laborCard.appendChild(laborHeader);
  laborCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "ここで設定した上限を AI 自動生成・代打推薦が hard constraint として守ります（個人契約とのMINを採用）"));
  const lr = state.meta.laborRules;
  const lrGrid = el("div", { class: "grid grid-cols-2 md:grid-cols-4 gap-3 text-sm" });
  lrGrid.innerHTML = `
    <label class="block"><span class="text-slate-600">週最大労働時間</span>
      <input id="lr-week" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${lr.maxHoursPerWeek}"></label>
    <label class="block"><span class="text-slate-600">1日最大労働時間</span>
      <input id="lr-day" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${lr.maxHoursPerDay}"></label>
    <label class="block"><span class="text-slate-600">連勤上限(日)</span>
      <input id="lr-cons" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${lr.maxConsecutiveDays}"></label>
    <label class="block"><span class="text-slate-600">最低週休(日)</span>
      <input id="lr-rest" type="number" class="mt-1 w-full border rounded-md px-3 py-2" value="${lr.minRestDaysPerWeek}"></label>`;
  laborCard.appendChild(lrGrid);

  // 月次労務リスク警告閾値 (Round 15 TOP 1)
  const warnT = state.meta.laborWarnThreshold ?? 0.7;
  const dangerT = state.meta.laborDangerThreshold ?? 0.85;
  laborCard.appendChild(el("div", { class: "mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600" },
    "📊 ダッシュボードの月次労務警告閾値"));
  const thresholdGrid = el("div", { class: "grid grid-cols-2 gap-3 text-sm" });
  thresholdGrid.innerHTML = `
    <label class="block"><span class="text-slate-600 text-xs">注意ライン (黄色)</span>
      <select id="lr-warn" class="mt-1 w-full border rounded-md px-3 py-2 text-sm">
        ${[0.5, 0.6, 0.7, 0.75, 0.8].map(v => `<option value="${v}" ${warnT === v ? "selected" : ""}>${Math.round(v*100)}%</option>`).join("")}
      </select></label>
    <label class="block"><span class="text-slate-600 text-xs">危険ライン (赤)</span>
      <select id="lr-danger" class="mt-1 w-full border rounded-md px-3 py-2 text-sm">
        ${[0.8, 0.85, 0.9, 0.95, 1.0].map(v => `<option value="${v}" ${dangerT === v ? "selected" : ""}>${Math.round(v*100)}%</option>`).join("")}
      </select></label>`;
  laborCard.appendChild(thresholdGrid);

  laborCard.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: () => {
      state.meta.laborRules = {
        maxHoursPerWeek: Number($("#lr-week").value) || 40,
        maxHoursPerDay: Number($("#lr-day").value) || 8,
        maxConsecutiveDays: Number($("#lr-cons").value) || 5,
        minRestDaysPerWeek: Number($("#lr-rest").value) || 1,
        minRestHoursBetweenShifts: state.meta.laborRules.minRestHoursBetweenShifts || 8,
      };
      state.meta.laborWarnThreshold = Number($("#lr-warn").value) || 0.7;
      state.meta.laborDangerThreshold = Number($("#lr-danger").value) || 0.85;
      persist(); render(); toast("労務ルールを保存（次回 AI 生成から適用）", "success");
    } }, "保存"));
  wrap.appendChild(laborCard);

  // 給与計算オプション (Round 14)
  const payCard = el("div", { id: "set-payroll", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  payCard.appendChild(el("div", { class: "font-semibold" }, "給与計算オプション"));
  payCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "深夜手当 (22時以降の時給割増) を給与計算 CSV に反映します。労働基準法では 22:00〜翌5:00 の労働は通常時給の 25% 増し以上が必要です。"));
  const ps = state.meta.payrollSettings || {};
  const payGrid = el("div", { class: "space-y-2 text-sm" });
  payGrid.innerHTML = `
    <label class="inline-flex items-center gap-2">
      <input type="checkbox" id="ps-night-on" ${ps.nightAllowanceEnabled ? "checked" : ""}>
      <span>深夜手当を有効にする</span>
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="block"><span class="text-slate-600 text-xs">深夜開始時刻</span>
        <select id="ps-night-start" class="mt-1 w-full border rounded-md px-3 py-2 text-sm">
          ${[20,21,22,23].map(h => `<option value="${h}" ${(ps.nightStartHour||22)===h?"selected":""}>${h}:00</option>`).join("")}
        </select></label>
      <label class="block"><span class="text-slate-600 text-xs">割増倍率</span>
        <select id="ps-night-rate" class="mt-1 w-full border rounded-md px-3 py-2 text-sm">
          <option value="1.25" ${(ps.nightRate||1.25)===1.25?"selected":""}>1.25 倍 (労基準拠)</option>
          <option value="1.30" ${(ps.nightRate||1.25)===1.30?"selected":""}>1.30 倍</option>
          <option value="1.50" ${(ps.nightRate||1.25)===1.50?"selected":""}>1.50 倍</option>
        </select></label>
    </div>`;
  payCard.appendChild(payGrid);
  payCard.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: () => {
      state.meta.payrollSettings = {
        nightAllowanceEnabled: $("#ps-night-on").checked,
        nightStartHour: Number($("#ps-night-start").value),
        nightRate: Number($("#ps-night-rate").value),
      };
      persist(); render(); toast("給与計算オプションを保存", "success");
    } }, "保存"));
  wrap.appendChild(payCard);

  // 希望提出締切設定 (Round 4)
  const dlCard = el("div", { id: "set-deadline", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  dlCard.appendChild(el("div", { class: "font-semibold" }, "7. 希望提出締切"));
  dlCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "スタッフポータルにカウントダウン表示されます。シフト編成の前日設定が一般的です。"));
  const dl = state.meta.preferenceDeadline || { daysBefore: 3, hour: 18 };
  const dlGrid = el("div", { class: "grid grid-cols-3 gap-3 text-sm items-end" });
  dlGrid.innerHTML = `
    <label class="block col-span-2"><span class="text-slate-600">週開始の何日前？</span>
      <select id="dl-days" class="mt-1 w-full border rounded-md px-3 py-2">
        <option value="0" ${dl.daysBefore === 0 ? "selected" : ""}>当日</option>
        <option value="1" ${dl.daysBefore === 1 ? "selected" : ""}>1 日前 (前日)</option>
        <option value="2" ${dl.daysBefore === 2 ? "selected" : ""}>2 日前</option>
        <option value="3" ${dl.daysBefore === 3 ? "selected" : ""}>3 日前 (推奨)</option>
        <option value="4" ${dl.daysBefore === 4 ? "selected" : ""}>4 日前</option>
        <option value="5" ${dl.daysBefore === 5 ? "selected" : ""}>5 日前</option>
        <option value="7" ${dl.daysBefore === 7 ? "selected" : ""}>1 週間前</option>
      </select></label>
    <label class="block"><span class="text-slate-600">時刻</span>
      <select id="dl-hour" class="mt-1 w-full border rounded-md px-3 py-2">
        ${Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${dl.hour === i ? "selected" : ""}>${String(i).padStart(2,"0")}:00</option>`).join("")}
      </select></label>`;
  dlCard.appendChild(dlGrid);
  dlCard.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: () => {
      state.meta.preferenceDeadline = {
        daysBefore: Number($("#dl-days").value),
        hour: Number($("#dl-hour").value),
      };
      persist(); render(); toast("提出締切を保存しました", "success");
    } }, "保存"));
  wrap.appendChild(dlCard);

  // Algorithm weights
  const algoCard = el("div", { id: "set-algo", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  const algoHeader = el("div", { class: "flex items-center justify-between flex-wrap gap-2" });
  const algoTitle = el("div", { class: "font-semibold" });
  algoTitle.innerHTML = `7. アルゴリズム重み調整${helpIcon("algo-weights")}`;
  algoHeader.appendChild(algoTitle);
  algoHeader.appendChild(el("a", { class: "text-xs text-brand-600 underline", href: "/docs/algorithm.md", target: "_blank" }, "📖 仕様書"));
  algoCard.appendChild(algoHeader);
  algoCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "プリセットを選ぶか、各スコア要素の重みを直接調整できます。"));

  // Round 6 + Round 24: プリセット選択 — skillMix 含む全6因子で正規化
  const PRESETS = {
    "balanced":   { label: "⚖️ バランス",     desc: "標準的な配分",                       weights: { preference: 0.38, positionMatch: 0.14, fairness: 0.18, cost: 0.12, skill: 0.10, skillMix: 0.08 } },
    "preference": { label: "😊 希望最優先",     desc: "スタッフ希望を最大限尊重",         weights: { preference: 0.55, positionMatch: 0.10, fairness: 0.13, cost: 0.05, skill: 0.10, skillMix: 0.07 } },
    "cost":       { label: "💴 コスト重視",     desc: "人件費を最小化（時給低い人優先）", weights: { preference: 0.22, positionMatch: 0.13, fairness: 0.13, cost: 0.35, skill: 0.10, skillMix: 0.07 } },
    "skill":      { label: "🌟 スキル重視",     desc: "ピーク時に熟練者を配置・育成ペア",weights: { preference: 0.27, positionMatch: 0.18, fairness: 0.13, cost: 0.10, skill: 0.20, skillMix: 0.12 } },
    "fairness":   { label: "🤝 公平性重視",     desc: "全員に均等にシフトを配分",         weights: { preference: 0.27, positionMatch: 0.10, fairness: 0.38, cost: 0.10, skill: 0.08, skillMix: 0.07 } },
  };
  const presetGrid = el("div", { class: "grid grid-cols-2 md:grid-cols-5 gap-2 mb-3" });
  for (const [k, p] of Object.entries(PRESETS)) {
    const isMatch = JSON.stringify(state.meta.algorithmWeights) === JSON.stringify(p.weights);
    const btn = el("button", {
      class: `text-xs p-2 rounded-md border-2 transition active:scale-95 ${isMatch ? "bg-brand-600 text-white border-brand-600" : "bg-white text-slate-700 border-slate-200 hover:border-brand-400"}`,
      onclick: () => {
        state.meta.algorithmWeights = { ...p.weights };
        persist(); render(); toast(`プリセット「${p.label}」を適用`, "success");
      },
    });
    btn.innerHTML = `<div class="font-semibold">${p.label}</div><div class="text-[10px] opacity-80 mt-0.5">${p.desc}</div>`;
    presetGrid.appendChild(btn);
  }
  algoCard.appendChild(presetGrid);
  algoCard.appendChild(el("div", { class: "text-[10px] text-slate-500 mb-2" }, "▼ または個別調整"));

  const aw = state.meta.algorithmWeights;
  const FACTORS = [
    { id: "preference",    label: "希望充足",       desc: "スタッフの提出希望と一致" },
    { id: "positionMatch", label: "ポジション適合", desc: "本職に配置（兼任より優先）" },
    { id: "fairness",      label: "公平性",         desc: "未充足時間が多い人を優先" },
    { id: "cost",          label: "コスト",         desc: "時給が低い人を優先（人件費抑制）" },
    { id: "skill",         label: "スキル",         desc: "高スキル人を優先" },
    { id: "skillMix",      label: "スキル構成",     desc: "ベテラン×新人ペアリング (Round 23)" },
  ];
  const grid = el("div", { class: "space-y-2" });
  FACTORS.forEach(f => {
    const row = el("div", { class: "flex items-center gap-3 text-sm" });
    row.innerHTML = `
      <div class="w-32">
        <div class="font-medium">${f.label}</div>
        <div class="text-[10px] text-slate-500">${f.desc}</div>
      </div>
      <input type="range" min="0" max="100" value="${Math.round((aw[f.id]||0)*100)}"
        data-aw="${f.id}" class="flex-1">
      <span class="text-xs w-12 text-right" data-awval="${f.id}">${Math.round((aw[f.id]||0)*100)}</span>
    `;
    grid.appendChild(row);
  });
  algoCard.appendChild(grid);

  // 多重スタート
  const rsRow = el("div", { class: "flex items-center gap-3 text-sm pt-2 border-t border-slate-100" });
  rsRow.innerHTML = `
    <div class="w-32">
      <div class="font-medium">試行回数</div>
      <div class="text-[10px] text-slate-500">多いほど高品質（遅くなる）</div>
    </div>
    <input type="range" id="aw-randomStarts" min="1" max="20" value="${state.meta.randomStarts || 5}" class="flex-1">
    <span class="text-xs w-12 text-right" id="aw-randomStarts-val">${state.meta.randomStarts || 5}</span>
  `;
  algoCard.appendChild(rsRow);

  algoCard.appendChild(el("div", { class: "flex gap-2 pt-2" }, [
    el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-4 py-1.5", onclick: () => {
      const newWeights = {};
      FACTORS.forEach(f => {
        const inp = $(`input[data-aw="${f.id}"]`);
        newWeights[f.id] = Number(inp.value) / 100;
      });
      // 正規化
      const sum = Object.values(newWeights).reduce((s, v) => s + v, 0);
      if (sum > 0) {
        for (const k of Object.keys(newWeights)) newWeights[k] /= sum;
      }
      state.meta.algorithmWeights = newWeights;
      state.meta.randomStarts = Number($("#aw-randomStarts").value) || 5;
      persist(); render(); toast("重みを保存（次回 AI 生成から適用）", "success");
    } }, "💾 保存"),
    el("button", { class: "text-sm border border-slate-300 rounded-md px-4 py-1.5", onclick: () => {
      state.meta.algorithmWeights = { preference: 0.38, positionMatch: 0.14, fairness: 0.18, cost: 0.12, skill: 0.10, skillMix: 0.08 };
      state.meta.randomStarts = 5;
      persist(); render(); toast("既定値に戻しました", "success");
    } }, "↻ 既定値に戻す"),
  ]));

  // リアルタイムスライダー値表示
  setTimeout(() => {
    FACTORS.forEach(f => {
      const inp = $(`input[data-aw="${f.id}"]`);
      const out = $(`[data-awval="${f.id}"]`);
      if (inp && out) inp.addEventListener("input", () => { out.textContent = inp.value; });
    });
    const rs = $("#aw-randomStarts"), rsv = $("#aw-randomStarts-val");
    if (rs && rsv) rs.addEventListener("input", () => { rsv.textContent = rs.value; });
  }, 50);

  wrap.appendChild(algoCard);

  // Staff Messages inbox
  const msgCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3" });
  const msgHeader = el("div", { class: "flex items-center justify-between" });
  msgHeader.innerHTML = `<div class="font-semibold">📥 スタッフからの連絡</div>`;
  msgHeader.appendChild(el("button", { id: "refreshMsgBtn", class: "text-xs text-brand-600 underline", onclick: () => loadStaffMessages() }, "↻ 更新"));
  msgCard.appendChild(msgHeader);
  const msgListEl = el("div", { id: "staffMsgList", class: "space-y-2 max-h-72 overflow-y-auto" });
  msgListEl.innerHTML = '<div class="text-xs text-slate-500">読み込み中...</div>';
  msgCard.appendChild(msgListEl);
  wrap.appendChild(msgCard);

  setTimeout(loadStaffMessages, 100);

  // Backup
  const backupCard = el("div", { id: "set-backup", class: "bg-white border border-slate-200 rounded-xl p-4 space-y-3 scroll-mt-4" });
  backupCard.appendChild(el("div", { class: "font-semibold" }, "9. データバックアップ"));
  backupCard.appendChild(el("div", { class: "text-xs text-slate-500" },
    "全データ（店舗・スタッフ・全週・トークン）を JSON でエクスポート/インポートできます。定期的にダウンロードして保管推奨。"));
  backupCard.appendChild(el("div", { class: "flex gap-2 flex-wrap" }, [
    el("button", { class: "text-sm bg-slate-700 hover:bg-slate-800 text-white rounded-md px-3 py-1.5",
      onclick: downloadBackup }, "📥 JSONでダウンロード"),
    el("label", { class: "text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-md px-3 py-1.5 cursor-pointer" }, [
      el("span", {}, "📤 JSONから復元"),
      el("input", { type: "file", accept: "application/json,.json", class: "hidden", onchange: handleRestoreFile }),
    ]),
    el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5",
      onclick: openSnapshotsDialog }, "🕒 過去スナップショット (サーバ)"),
  ]));
  backupCard.appendChild(el("div", { class: "text-xs text-slate-500 pt-2 border-t border-slate-100" },
    "💡 サーバ側で毎日 03:00 (JST) に自動スナップショット取得（過去 30 日分保持）。「過去スナップショット」ボタンから任意の日に巻き戻せます。"));

  // 操作単位スナップショット (Round 17 TOP 1)
  const localSnaps = (state.meta.snapshots || []);
  backupCard.appendChild(el("div", { class: "pt-3 border-t border-slate-100 space-y-2" }, [
    el("div", { class: "text-xs font-semibold text-slate-700" }, "🔁 操作単位スナップショット (Round 17)"),
    el("div", { class: "text-xs text-slate-500" },
      `確定前 / AI 生成前 / 日次に自動取得。最新 ${SNAPSHOT_LIMIT} 件まで保持。誤操作の即時取り戻しに使えます。`),
    el("div", { class: "flex gap-2 flex-wrap" }, [
      el("button", { class: "text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-md px-3 py-1.5",
        onclick: () => {
          const label = prompt("スナップショット名 (任意・例: 「サンプル投入前」):", "手動 " + new Date().toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit" })) || "手動";
          const snap = createSnapshot("manual", label);
          if (snap) { persist(); render(); toast(`✓ スナップショット「${snap.label}」を作成`, "success"); }
        } }, "📸 今すぐ手動スナップショット"),
      el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5",
        onclick: () => openLocalSnapshotsDialog() }, `📋 一覧 (${localSnaps.length}件)`),
    ]),
  ]));
  wrap.appendChild(backupCard);

  // テーマ設定 (Round 25 TOP 3)
  const themeCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-4 space-y-2" });
  themeCard.appendChild(el("div", { class: "font-semibold" }, "🎨 表示テーマ"));
  const curTheme = state.meta.theme || "auto";
  const themeOpts = [
    { val: "auto", label: "🖥 自動 (システム設定)", desc: "OS のダークモード設定に追従" },
    { val: "light", label: "☀️ ライト", desc: "明るい背景・夜営業以外向け" },
    { val: "dark", label: "🌙 ダーク", desc: "暗い背景・夜営業や夜間操作向け" },
  ];
  const themeGrid = el("div", { class: "grid grid-cols-1 sm:grid-cols-3 gap-2" });
  for (const opt of themeOpts) {
    const isSel = curTheme === opt.val;
    const btn = el("button", {
      class: `text-left rounded-md p-3 border-2 transition ${isSel ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-400"}`,
      onclick: () => {
        state.meta.theme = opt.val;
        try { localStorage.setItem("shifty.theme", opt.val); } catch (_) {}
        applyTheme(opt.val);
        persist(); render();
        toast(`テーマを「${opt.label}」に切替`, "success");
      },
    });
    btn.innerHTML = `<div class="font-semibold text-sm">${opt.label}</div><div class="text-xs text-slate-600 mt-0.5">${opt.desc}</div>`;
    themeGrid.appendChild(btn);
  }
  themeCard.appendChild(themeGrid);
  wrap.appendChild(themeCard);

  // ヘルプセンター (Round 25 TOP 1)
  const helpCard = renderHelpCenter();
  if (helpCard) wrap.appendChild(helpCard);

  // 監査ログビューア (Round 25 TOP 2)
  const auditCard = renderAuditLogViewer();
  if (auditCard) wrap.appendChild(auditCard);

  // Danger
  const danger = el("div", { class: "bg-red-50 border border-red-200 rounded-xl p-4 space-y-2" });
  danger.appendChild(el("div", { class: "font-semibold text-red-900" }, "⚠️ 危険操作"));
  danger.appendChild(el("button", { class: "text-sm bg-red-600 hover:bg-red-700 text-white rounded-md px-3 py-1.5",
    onclick: async () => {
      if (!confirm("全データをリセットしてサンプルに戻します。よろしいですか？")) return;
      state = await resetState(); render(); toast("リセット完了", "success");
    } }, "全データリセット"));
  wrap.appendChild(danger);

  return wrap;
}

async function downloadBackup() {
  try {
    const data = await window.ShiftyAPI.backup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = el("a", { href: url, download: `shifty-backup-${today}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("バックアップをダウンロードしました", "success");
  } catch (e) { toast("バックアップ失敗: " + e.message, "error"); }
}

async function loadStaffMessages() {
  const listEl = $("#staffMsgList");
  if (!listEl) return;
  try {
    const msgs = await window.ShiftyAPI.listStaffMessages();
    listEl.innerHTML = "";
    if (!msgs.length) {
      listEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-3">受信メッセージはありません</div>';
      return;
    }
    const KIND_LABEL = { general: "💬 連絡", change_request: "📅 変更希望", question: "❓ 質問", report: "📢 報告" };
    msgs.forEach(m => {
      // Round 24 TOP 1: 緊急当日休み連絡を検出
      const isEmergency = (m.message || "").includes("【緊急】当日休み連絡");
      const cls = isEmergency
        ? "bg-red-50 border-2 border-red-300 rounded-md p-3 text-sm"
        : "bg-slate-50 rounded-md p-3 text-sm";
      const row = el("div", { class: cls });
      const at = m.createdAt ? new Date(m.createdAt).toLocaleString("ja-JP") : "?";
      row.innerHTML = `
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold ${isEmergency ? "text-red-800" : ""}">${isEmergency ? "🚨 " : ""}${escapeHtml(m.staffName || m.staffId)}</span>
          <span class="text-xs text-slate-500">${at}</span>
        </div>
        <div class="text-xs ${isEmergency ? "text-red-700 font-bold" : "text-amber-700"} mb-1">${isEmergency ? "🚨 緊急当日休み連絡" : (KIND_LABEL[m.kind] || m.kind)}</div>
        <div class="text-sm text-slate-700 whitespace-pre-wrap mb-2">${escapeHtml(m.message || "")}</div>
      `;
      const btnRow = el("div", { class: "flex gap-2 flex-wrap" });
      // Round 24 TOP 1: 緊急の場合は代打候補ボタン
      if (isEmergency) {
        btnRow.appendChild(el("button", {
          class: "text-xs bg-red-600 hover:bg-red-700 text-white rounded px-3 py-1 font-bold",
          onclick: () => openEmergencySubstituteFlow(m),
        }, "🆘 代打を探す"));
      }
      // 返信ボタン (Round 12)
      btnRow.appendChild(el("button", {
        class: "text-xs bg-emerald-500 hover:bg-emerald-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => openReplyDialog(m),
      }, "✉️ 返信文を生成"));
      row.appendChild(btnRow);
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="text-xs text-red-600">取得失敗: ${escapeHtml(e.message)}</div>`;
  }
}

// Round 24 TOP 1: 緊急代打フロー
function openEmergencySubstituteFlow(message) {
  const staffId = message.staffId;
  const staff = state.staff.find(s => s.id === staffId);
  if (!staff) { toast("該当スタッフが見つかりません", "error"); return; }

  // 今日の該当スタッフのシフトを探す
  const todayStr = new Date().toISOString().slice(0, 10);
  let todayShift = null;
  let parentWeek = null;
  for (const [wkKey, wk] of Object.entries(state.weeks || {})) {
    if (wk.status !== "published") continue;
    for (const a of (wk.assignments || [])) {
      if (a.staffId === staffId && a.date === todayStr) {
        const start = new Date(`${a.date}T${a.startTime}:00`);
        if (start > new Date()) { // 未来のシフトのみ
          todayShift = a;
          parentWeek = wkKey;
          break;
        }
      }
    }
    if (todayShift) break;
  }

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg text-red-800" },
    `🆘 ${staff.name} さんの緊急代打`));
  if (!todayShift) {
    body.appendChild(el("p", { class: "text-sm text-slate-600" },
      "本日の未来シフトが見つかりません。既に開始済みの場合や、別日のシフトの場合は、シフト編成画面から手動で対応してください。"));
    body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
      el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    ]));
    modal(body);
    return;
  }

  body.appendChild(el("div", { class: "bg-red-50 border border-red-200 rounded p-3 text-sm" }, [
    el("div", { class: "font-semibold" }, `対象シフト: ${todayShift.date} ${todayShift.startTime}〜${todayShift.endTime}`),
    el("div", { class: "text-xs text-slate-600" }, `${posCfg(todayShift.position).label} / 元担当: ${staff.name}`),
  ]));

  // 該当週を一時的に下書きにして代打を計算
  const wk = state.weeks[parentWeek];
  const wasPublished = wk.status === "published";

  // 代打候補を計算 (公開状態でも候補は計算可能)
  const subs = recommendSubstitute(todayShift, {
    staff: state.staff.filter(s => !s.archived),
    slots: wk.slots || [],
    preferences: wk.preferences || [],
    assignments: wk.assignments || [],
    laborRules: state.meta.laborRules,
    weights: state.meta.algorithmWeights,
  });

  if (!subs.length) {
    body.appendChild(el("div", { class: "text-sm text-amber-700 bg-amber-50 rounded p-3" },
      "⚠️ 代替可能なスタッフが見つかりません。スタッフタブから連絡先を確認して、個別に依頼してください。"));
  } else {
    body.appendChild(el("div", { class: "text-xs font-semibold text-slate-700" }, "推奨代打 (上位 3 名):"));
    const list = el("div", { class: "space-y-1.5" });
    subs.slice(0, 3).forEach((cand, i) => {
      const s = cand.staff;
      const row = el("div", { class: "flex items-center justify-between bg-slate-50 rounded p-2.5" });
      row.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="font-semibold">${i + 1}位: ${escapeHtml(s.name)}
            <span class="text-xs text-slate-500 font-normal">${escapeHtml(posCfg(s.position).label)} / ¥${s.hourlyWage}/h</span>
          </div>
          <div class="text-xs text-slate-600">スコア ${Math.round(cand.score * 100)} ${(cand.reasons || []).slice(0, 2).map(r => `· ${typeof r === 'string' ? r : r[0] || ''}`).join(" ")}</div>
          ${(s.email || s.webhookUrl) ? '<div class="text-[10px] text-emerald-600">✉️ 連絡可能</div>' : '<div class="text-[10px] text-amber-600">⚠️ 連絡先未登録</div>'}
        </div>`;
      const swapBtn = el("button", {
        class: "text-xs bg-red-600 hover:bg-red-700 text-white rounded px-3 py-2 font-bold whitespace-nowrap ml-2",
        onclick: async () => {
          if (!confirm(
            `${todayShift.date} ${todayShift.startTime}〜${todayShift.endTime} ${posCfg(todayShift.position).label} を\n\n` +
            `${staff.name} さん → ${s.name} さんへ交代しますか？\n\n` +
            `両者にシフト変更通知メールが自動送信されます。`
          )) return;
          // 該当 assignment を更新
          const wkk = state.weeks[parentWeek];
          const idx = (wkk.assignments || []).findIndex(x => x.id === todayShift.id);
          if (idx < 0) { toast("該当アサインが既に変更されています", "error"); return; }
          // 確定済の場合はスナップショット
          if (wasPublished) {
            try { createSnapshot("manual", `緊急代打 ${staff.name} → ${s.name}`); } catch (_) {}
          }
          wkk.assignments[idx] = {
            ...todayShift,
            staffId: s.id,
            cost: s.hourlyWage * calcHours(todayShift.startTime, todayShift.endTime),
            substituteFor: staffId,
            substitutedAt: new Date().toISOString(),
          };
          logChange("substitute", `緊急代打: ${staff.name} → ${s.name} (${todayShift.date} ${todayShift.startTime}〜)`);
          await persist();
          closeModal();
          render();
          toast(`✓ ${s.name} さんへ代打しました。両者へ通知メールを送信します`, "success", 5000);
          // 通知 (両者に変更通知)
          if (wasPublished) {
            try {
              await window.ShiftyAPI.notifyShifts(parentWeek, {
                staffIds: [staffId, s.id],
                subjectPrefix: "【緊急代打】",
              });
            } catch (e) { toast("通知送信失敗: " + (e?.message || ""), "error"); }
          }
        },
      }, "代打 →");
      row.appendChild(swapBtn);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  // Round 27 TOP 3: 一斉打診ボタン
  if (subs.length > 0) {
    body.appendChild(el("div", { class: "border-t pt-3 mt-3" }, [
      el("div", { class: "text-xs font-semibold mb-2" }, "💡 まだ代打が決まらない場合"),
      el("button", {
        class: "w-full bg-purple-600 hover:bg-purple-700 text-white rounded-md py-2 text-sm font-bold",
        onclick: async () => {
          const top3 = subs.slice(0, 3);
          if (!confirm(
            `候補上位 3 名 (${top3.map(c => c.staff.name).join(", ")}) に一斉打診メールを送信します。\n\n` +
            `先着で「やります」と応えた人へ自動的にアサインが切り替わります。`
          )) return;
          try {
            const r = await window.ShiftyAPI.createSubstituteOffer({
              assignmentId: todayShift.id,
              candidateIds: top3.map(c => c.staff.id),
            });
            toast(`✓ ${r.candidatesSent} 名へ打診メール送信。応答を待っています`, "success", 5000);
            closeModal();
          } catch (e) {
            toast("打診失敗: " + (e?.message || ""), "error");
          }
        },
      }, "📞 候補上位 3 名へ一斉打診 (先着順で決定)"),
    ]));
  }

  body.appendChild(el("div", { class: "flex justify-between gap-2 pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
    el("button", {
      class: "px-3 py-1.5 text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-md font-semibold",
      onclick: () => {
        if (!confirm(`代打が見つからない場合に、シフトを「不在」にできます (該当アサインを削除)。続行しますか？`)) return;
        const wkk = state.weeks[parentWeek];
        wkk.assignments = (wkk.assignments || []).filter(x => x.id !== todayShift.id);
        logChange("delete", `緊急休み: ${staff.name} 削除 (${todayShift.date} ${todayShift.startTime}〜)`);
        persist(); closeModal(); render();
        toast(`シフトから ${staff.name} を削除しました (要・追加対応)`, "info", 5000);
      },
    }, "代打なしで削除"),
  ]));
  modal(body);
}

async function openSnapshotsDialog() {
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🕒 過去スナップショット"));
  body.appendChild(el("p", { class: "text-xs text-slate-500" },
    "毎日 03:00 (JST) に自動取得。クリックで該当日の状態に巻き戻ります（現在のデータは上書きされます）。"));
  const list = el("div", { class: "space-y-1.5 max-h-72 overflow-y-auto" });
  body.appendChild(list);
  body.appendChild(el("div", { class: "flex justify-end" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
  try {
    const snapshots = await window.ShiftyAPI.listSnapshots();
    if (!snapshots.length) {
      list.appendChild(el("div", { class: "text-sm text-slate-500 text-center py-4" },
        "スナップショットがまだありません。毎日 03:00 から取得開始されます。"));
      return;
    }
    snapshots.forEach(snap => {
      const row = el("div", { class: "flex items-center justify-between bg-slate-50 rounded-md p-2 text-sm" });
      row.innerHTML = `
        <div>
          <span class="font-mono">${snap.date}</span>
          ${snap.createdAt ? `<span class="text-xs text-slate-500 ml-2">${snap.createdAt.slice(11, 19)} UTC</span>` : ""}
        </div>`;
      const restoreBtn = el("button", {
        class: "text-xs bg-amber-600 text-white rounded px-3 py-1.5",
        onclick: async () => {
          if (!confirm(`${snap.date} の状態に巻き戻します。現在のデータは上書きされます。よろしいですか？`)) return;
          try {
            await window.ShiftyAPI.restoreSnapshot(snap.date);
            state = await loadState();
            closeModal(); render(); toast(`✅ ${snap.date} の状態に復元しました`, "success");
          } catch (e) {
            toast("復元失敗: " + e.message, "error");
          }
        },
      }, "復元");
      row.appendChild(restoreBtn);
      list.appendChild(row);
    });
  } catch (e) {
    list.appendChild(el("div", { class: "text-sm text-red-600" }, "取得失敗: " + e.message));
  }
}

// Round 17 TOP 1: ローカルスナップショット一覧
function openLocalSnapshotsDialog() {
  const snaps = (state.meta.snapshots || []).slice();
  const KIND_LABEL = {
    manual: "✋ 手動",
    auto_publish: "✅ 確定前",
    auto_autogen: "🤖 AI生成前",
    daily: "📅 日次",
  };
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "🔁 操作単位スナップショット"));
  body.appendChild(el("p", { class: "text-xs text-slate-500" },
    `最新 ${SNAPSHOT_LIMIT} 件まで保持。クリックで該当時点に巻き戻ります（復元前に現状を自動バックアップ）。`));
  if (snaps.length === 0) {
    body.appendChild(el("div", { class: "text-sm text-slate-500 text-center py-4" },
      "スナップショットがまだありません。確定 / AI 生成時に自動取得されます。"));
  } else {
    const list = el("div", { class: "space-y-1.5 max-h-72 overflow-y-auto" });
    for (const snap of snaps) {
      const row = el("div", { class: "border border-slate-200 rounded-md p-2 text-xs flex items-center justify-between gap-2" });
      const dt = new Date(snap.createdAt);
      const staffN = (snap.payload?.staff || []).length;
      const weeksN = Object.keys(snap.payload?.weeks || {}).length;
      row.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="font-medium">${escapeHtml(snap.label)}</div>
          <div class="text-slate-500 text-[10px]">${KIND_LABEL[snap.kind] || snap.kind}・${dt.toLocaleString("ja-JP")}</div>
          <div class="text-slate-400 text-[10px]">スタッフ ${staffN} 名 / 週 ${weeksN} 件</div>
        </div>
      `;
      const restoreBtn = el("button", {
        class: "text-xs bg-amber-600 hover:bg-amber-700 text-white rounded px-3 py-1.5 font-semibold",
        onclick: () => restoreSnapshot(snap.id),
      }, "復元");
      const deleteBtn = el("button", {
        class: "text-xs bg-slate-200 hover:bg-slate-300 rounded px-2 py-1.5",
        onclick: async () => {
          if (!confirm(`「${snap.label}」を削除しますか？`)) return;
          state.meta.snapshots = (state.meta.snapshots || []).filter(s => s.id !== snap.id);
          await persist(); closeModal(); openLocalSnapshotsDialog();
        },
      }, "🗑");
      row.appendChild(restoreBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);
    }
    body.appendChild(list);
  }
  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t border-slate-100" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);
}

async function handleRestoreFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  if (!confirm(`「${file.name}」から全データを復元します。現在のデータは上書きされます。続行しますか？`)) {
    ev.target.value = ""; return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await window.ShiftyAPI.restore(data);
    state = await loadState();
    render();
    toast("復元しました", "success");
  } catch (e) { toast("復元失敗: " + e.message, "error"); }
  ev.target.value = "";
}

function editPositionDialog(p = null) {
  const isNew = !p;
  const data = p ? { ...p } : { id: "", label: "", color: "#64748b" };
  const body = el("div", { class: "p-6 space-y-3" });
  body.innerHTML = `
    <h3 class="font-bold text-lg">${isNew ? "ポジション追加" : "ポジション編集"}</h3>
    <label class="block text-sm"><span class="text-slate-600">ID（半角英数。例: hall）</span>
      <input id="pos-id" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.id)}" ${isNew ? "" : "readonly"}></label>
    <label class="block text-sm"><span class="text-slate-600">ラベル（例: ホール）</span>
      <input id="pos-label" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.label)}"></label>
    <label class="block text-sm"><span class="text-slate-600">色</span>
      <input id="pos-color" type="color" class="mt-1 w-20 h-10 border rounded-md" value="${data.color}"></label>`;
  body.appendChild(el("div", { class: "flex justify-end gap-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm", onclick: closeModal }, "キャンセル"),
    el("button", { class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md", onclick: () => {
      const newP = { id: $("#pos-id").value.trim(), label: $("#pos-label").value.trim(), color: $("#pos-color").value };
      if (!newP.id || !newP.label) { toast("ID とラベルは必須", "error"); return; }
      if (isNew && state.meta.positions.some(x => x.id === newP.id)) { toast("ID 重複", "error"); return; }
      if (isNew) {
        state.meta.positions.push(newP);
        for (const ses in state.meta.staffingPlan) {
          for (const dow in state.meta.staffingPlan[ses]) {
            state.meta.staffingPlan[ses][dow][newP.id] = 0;
          }
        }
      } else {
        state.meta.positions = state.meta.positions.map(x => x.id === newP.id ? newP : x);
      }
      regenerateCurSlots();
      persist(); closeModal(); render(); toast(isNew ? "追加しました" : "更新しました", "success");
    } }, "保存"),
  ]));
  modal(body);
}

function editSessionDialog(s = null) {
  const isNew = !s;
  const data = s ? { ...s } : { id: "", label: "", startTime: "11:00", endTime: "15:00", icon: "" };
  const body = el("div", { class: "p-6 space-y-3" });
  body.innerHTML = `
    <h3 class="font-bold text-lg">${isNew ? "セッション追加" : "セッション編集"}</h3>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <label class="block"><span class="text-slate-600">ID（例: lunch）</span>
        <input id="sess-id" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.id)}" ${isNew ? "" : "readonly"}></label>
      <label class="block"><span class="text-slate-600">ラベル</span>
        <input id="sess-label" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.label)}"></label>
      <label class="block"><span class="text-slate-600">開始時刻</span>
        <input id="sess-start" type="time" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.startTime}"></label>
      <label class="block"><span class="text-slate-600">終了時刻</span>
        <input id="sess-end" type="time" class="mt-1 w-full border rounded-md px-3 py-2" value="${data.endTime}"></label>
      <label class="block col-span-2"><span class="text-slate-600">アイコン（絵文字1文字）</span>
        <input id="sess-icon" class="mt-1 w-20 border rounded-md px-3 py-2" value="${escapeAttr(data.icon)}"></label>
    </div>`;
  body.appendChild(el("div", { class: "flex justify-end gap-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm", onclick: closeModal }, "キャンセル"),
    el("button", { class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md", onclick: () => {
      const newS = {
        id: $("#sess-id").value.trim(),
        label: $("#sess-label").value.trim(),
        startTime: $("#sess-start").value,
        endTime: $("#sess-end").value,
        icon: $("#sess-icon").value,
      };
      if (!newS.id || !newS.label) { toast("ID とラベルは必須", "error"); return; }
      if (isNew && state.meta.sessions.some(x => x.id === newS.id)) { toast("ID 重複", "error"); return; }
      if (isNew) {
        state.meta.sessions.push(newS);
        state.meta.staffingPlan[newS.id] = {};
        for (let d = 0; d < 7; d++) {
          state.meta.staffingPlan[newS.id][d] = Object.fromEntries(state.meta.positions.map(p => [p.id, 0]));
        }
      } else {
        state.meta.sessions = state.meta.sessions.map(x => x.id === newS.id ? newS : x);
      }
      regenerateCurSlots();
      persist(); closeModal(); render(); toast(isNew ? "追加しました" : "更新しました", "success");
    } }, "保存"),
  ]));
  modal(body);
}

// ===== Auth boot =====
function showAuthOverlay(mode) {
  $("#authOverlay").classList.remove("hidden");
  $("#authSetup").classList.toggle("hidden", mode !== "setup");
  $("#authLogin").classList.toggle("hidden", mode !== "login");
  setTimeout(() => {
    if (mode === "setup") $("#setupPass1").focus();
    else $("#loginPass").focus();
  }, 100);
}
function hideAuthOverlay() {
  $("#authOverlay").classList.add("hidden");
}

window.onAuthRequired = () => showAuthOverlay("login");

async function bootApp() {
  // Stripe Checkout 経由で初到達した新規顧客の着地ページ
  // (multi-tenant 未実装のため /app は使えず、手動オンボに案内)
  const params = new URLSearchParams(location.search);
  if (params.get("welcome") === "1") {
    document.getElementById("authOverlay").classList.add("hidden");
    document.getElementById("main").innerHTML = `
      <div class="max-w-md mx-auto mt-12 p-8 bg-white rounded-xl shadow-xl border text-center space-y-4">
        <div class="text-5xl">🎉</div>
        <h1 class="font-bold text-2xl">トライアルご登録ありがとうございます</h1>
        <p class="text-sm text-slate-600">
          飲DX チームから <strong>1 営業日以内</strong>に
          <span class="font-mono">support@in-dx.jp</span> よりお店専用のセットアップ手順をメールでお送りします。
        </p>
        <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 text-left">
          📌 メールに記載の URL から「店長アカウント」を作成いただくと、
          スタッフ登録 → 希望収集 → AI シフト生成 が即お試しいただけます。
        </div>
        <p class="text-xs text-slate-500">
          14 日間の無料期間中はクレジットカード入力なしでご利用いただけます。<br>
          自動課金はされません（期間内に解約 / 何もしなければ自動的に終了）。
        </p>
        <div class="pt-2 space-y-2">
          <a href="/demo" class="block bg-amber-500 hover:bg-amber-600 text-white rounded-lg px-5 py-2.5 text-sm font-semibold">
            🎮 待っている間に機能を試す（デモ環境）
          </a>
          <a href="/" class="block text-xs text-slate-500 hover:text-slate-700">トップに戻る</a>
        </div>
      </div>`;
    return;
  }
  // Demo mode: skip auth entirely
  if (window.__SHIFTY_DEMO_MODE__) {
    hideAuthOverlay();
    showDemoBanner();
    await loadAndRender();
    return;
  }
  // Auth status check
  let status;
  try {
    status = await window.ShiftyAPI.authStatus();
  } catch (e) {
    // tenant が見つからない場合
    if (window.ShiftyAPI.tenantSlug && (String(e.message).includes("404") || String(e.message).includes("tenant_not_found"))) {
      $("#main").innerHTML = `<div class="max-w-md mx-auto mt-12 p-8 bg-white rounded-xl shadow text-center space-y-3">
        <div class="text-4xl">⚠️</div>
        <h1 class="font-bold text-xl">テナントが見つかりません</h1>
        <p class="text-sm text-slate-600">URL のテナント識別子が無効です。<br>店長から正しい URL を再度ご確認ください。</p>
        <a href="/login" class="inline-block bg-brand-600 text-white rounded-lg px-5 py-2.5 text-sm font-semibold mt-2">ログイン画面へ</a>
      </div>`;
      return;
    }
    $("#main").innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-red-900">サーバ接続失敗: ${escapeHtml(e.message)}</div>`;
    return;
  }
  // Tenant モード: 認証されていなければ /login へ
  if (window.ShiftyAPI.tenantSlug) {
    if (!status.authenticated) {
      location.href = "/login";
      return;
    }
    // tenant 名をヘッダーに反映
    if (status.tenant && status.tenant.restaurantName) {
      const rn = document.getElementById("restaurantName");
      if (rn) rn.textContent = status.tenant.restaurantName;
    }
    hideAuthOverlay();
    await loadAndRender();
    return;
  }
  // 旧 /app モード (legacy single-tenant): パスワード認証
  if (status.setupRequired) { showAuthOverlay("setup"); return; }
  if (!status.authenticated) { showAuthOverlay("login"); return; }
  hideAuthOverlay();
  await loadAndRender();
}

function showDemoBanner() {
  const existing = document.getElementById("demoBanner");
  if (existing) return;
  const banner = el("div", {
    id: "demoBanner",
    class: "bg-amber-100 border-b border-amber-300 text-amber-900 text-sm py-2 px-4 text-center",
  });
  banner.innerHTML = `
    📌 <strong>デモ環境です</strong> — データはこのブラウザにのみ保存され、リロードでサンプルに戻ります。
    <a href="/" class="underline ml-2 font-semibold">本番版を見る</a> /
    <a href="/#contact" class="underline font-semibold">14日無料トライアル</a>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
}

// ===== 多店舗対応 (Round 26 = A) =====
let _ownerTenants = null;

async function initShopSwitcher() {
  if (!window.ShiftyAPI || !window.ShiftyAPI.tenantSlug) return;
  const wrapEl = document.getElementById("shopSwitcher");
  if (!wrapEl) return;
  try {
    const r = await window.ShiftyAPI.listOwnerTenants();
    _ownerTenants = r.tenants || [];
    const cur = r.currentSlug;
    const curTenant = _ownerTenants.find(t => t.slug === cur);
    const label = document.getElementById("shopSwitcherLabel");
    if (label && curTenant) label.textContent = (curTenant.restaurantName || cur).slice(0, 20);
    // 1 店舗のみなら表示しない (UI ノイズ抑制)
    if (_ownerTenants.length <= 1) {
      // 「+ 店舗追加」だけは見せたい → 1 店舗でも表示する
    }
    wrapEl.classList.remove("hidden");
    // ドロップダウン構築
    renderShopSwitcherDropdown();
    // クリック開閉
    const btn = document.getElementById("shopSwitcherBtn");
    const dd = document.getElementById("shopSwitcherDropdown");
    if (btn && dd) {
      btn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = !dd.classList.contains("hidden");
        if (isOpen) dd.classList.add("hidden");
        else { dd.classList.remove("hidden"); btn.setAttribute("aria-expanded", "true"); }
      };
      // Round 33 (Perf-6): リスナー蓄積を防ぐため module-level 1 個のみ登録
      if (!window._shopSwitcherClickHandlerAttached) {
        document.addEventListener("click", (e) => {
          const w = document.getElementById("shopSwitcher");
          if (w && !w.contains(e.target)) {
            const ddx = document.getElementById("shopSwitcherDropdown");
            const btnx = document.getElementById("shopSwitcherBtn");
            if (ddx) ddx.classList.add("hidden");
            if (btnx) btnx.setAttribute("aria-expanded", "false");
          }
        });
        window._shopSwitcherClickHandlerAttached = true;
      }
    }
  } catch (e) {
    // 認証されていない or 多店舗対応未対応 → 何もしない
    console.warn("Shop switcher init failed:", e);
  }
}

function renderShopSwitcherDropdown() {
  const dd = document.getElementById("shopSwitcherDropdown");
  if (!dd) return;
  dd.innerHTML = "";
  const cur = window.ShiftyAPI && window.ShiftyAPI.tenantSlug;

  if (_ownerTenants && _ownerTenants.length > 1) {
    const header = el("div", { class: "px-3 py-2 text-[10px] uppercase font-semibold text-slate-500 border-b border-slate-100 dark:border-slate-700" }, `🏪 全 ${_ownerTenants.length} 店舗`);
    dd.appendChild(header);
    for (const t of _ownerTenants) {
      const isCur = t.slug === cur;
      const row = el("button", {
        class: `w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 ${isCur ? "bg-brand-50 dark:bg-brand-700/30 font-bold" : ""}`,
        onclick: async () => {
          if (isCur) { dd.classList.add("hidden"); return; }
          try {
            await window.ShiftyAPI.switchOwnerTenant(t.slug);
            // 切替後に新しいテナント URL へリダイレクト
            location.href = `/t/${encodeURIComponent(t.slug)}/app`;
          } catch (e) {
            toast("切替失敗: " + (e?.message || ""), "error");
          }
        },
      });
      row.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <span>${isCur ? "✓ " : ""}${escapeHtml(t.restaurantName || t.slug)}</span>
            ${t.plan && t.plan !== "free" ? `<span class="text-[9px] bg-emerald-100 text-emerald-800 rounded px-1 ml-1">${escapeHtml(t.plan)}</span>` : ""}
          </div>
          <span class="text-[10px] text-slate-400">${escapeHtml((t.slug || "").slice(0, 12))}</span>
        </div>`;
      dd.appendChild(row);
    }
  }

  // 全店舗集計ビュー
  if (_ownerTenants && _ownerTenants.length >= 2) {
    dd.appendChild(el("button", {
      class: "w-full text-left px-3 py-2 text-sm border-t border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-blue-600 dark:text-blue-400 font-semibold",
      onclick: () => {
        const ddx = document.getElementById("shopSwitcherDropdown");
        if (ddx) ddx.classList.add("hidden");
        openCrossStoreDashboard();
      },
    }, "📊 全店舗 集計ダッシュボード"));
  }

  // + 店舗追加
  dd.appendChild(el("button", {
    class: "w-full text-left px-3 py-2 text-sm border-t border-slate-100 dark:border-slate-700 hover:bg-emerald-50 dark:hover:bg-emerald-700/30 text-emerald-700 dark:text-emerald-400 font-semibold",
    onclick: async () => {
      const ddx = document.getElementById("shopSwitcherDropdown");
      if (ddx) ddx.classList.add("hidden");
      const name = prompt("新しい店舗の名前を入力してください:\n(後で設定タブから変更可能)");
      if (!name || !name.trim()) return;
      try {
        const r = await window.ShiftyAPI.addOwnerTenant(name.trim());
        if (r.ok) {
          toast(`✓ 「${name}」を追加。切替中...`, "success", 4000);
          setTimeout(() => { location.href = `/t/${encodeURIComponent(r.slug)}/app`; }, 1000);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("tenant_limit_reached")) {
          toast("店舗数上限 (5) に達しています", "error");
        } else {
          toast("店舗追加失敗: " + msg, "error");
        }
      }
    },
  }, "＋ 新店舗を追加"));
}

function openCrossStoreDashboard() {
  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "📊 全店舗 集計ダッシュボード"));
  body.appendChild(el("div", { class: "text-xs text-slate-500" }, "オーナーが管理する全店舗の今週サマリ"));
  const list = el("div", { class: "space-y-2 max-h-96 overflow-y-auto" });
  body.appendChild(list);
  list.appendChild(el("div", { class: "text-sm text-center py-4 text-slate-500" }, "読み込み中..."));
  body.appendChild(el("div", { class: "flex justify-end pt-2 border-t" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 rounded-md", onclick: closeModal }, "閉じる"),
  ]));
  modal(body);

  window.ShiftyAPI.ownerAggregate().then(r => {
    list.innerHTML = "";
    let totalCost = 0, totalHours = 0, totalShifts = 0, publishedN = 0;
    for (const shop of (r.shops || [])) {
      totalCost += shop.weekCost || 0;
      totalHours += shop.weekHours || 0;
      totalShifts += shop.shiftCount || 0;
      if (shop.publishedThisWeek) publishedN++;

      const row = el("button", {
        class: "w-full text-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 hover:border-brand-400 transition",
        onclick: async () => {
          try {
            await window.ShiftyAPI.switchOwnerTenant(shop.slug);
            location.href = `/t/${encodeURIComponent(shop.slug)}/app`;
          } catch (e) { toast("切替失敗", "error"); }
        },
      });
      const isCur = shop.slug === (window.ShiftyAPI && window.ShiftyAPI.tenantSlug);
      const overBudget = shop.weeklyBudget > 0 && shop.weekCost > shop.weeklyBudget;
      row.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <div class="font-semibold">${isCur ? "✓ " : ""}${escapeHtml(shop.restaurantName || shop.slug)}
              ${shop.plan && shop.plan !== "free" ? `<span class="text-[10px] bg-emerald-100 text-emerald-800 rounded px-1.5 ml-1">${escapeHtml(shop.plan)}</span>` : ""}
            </div>
            <div class="text-[10px] text-slate-500 mt-0.5">スタッフ ${shop.staffCount || 0} 名 / 週開始 ${shop.currentWeekStart || "—"}</div>
          </div>
          <div class="text-right">
            <div class="text-sm font-bold ${overBudget ? "text-red-600" : ""}">${fmtYen(shop.weekCost || 0)}</div>
            <div class="text-[10px] text-slate-500">${(shop.weekHours || 0).toFixed(1)}h / ${shop.shiftCount || 0} 件</div>
            <div class="text-[10px] ${shop.publishedThisWeek ? "text-emerald-600" : "text-amber-600"}">${shop.publishedThisWeek ? "✓ 確定済" : "📝 下書き"}</div>
          </div>
        </div>`;
      list.appendChild(row);
    }
    // サマリカード
    list.insertBefore(el("div", { class: "bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded p-3 text-xs grid grid-cols-2 gap-2" }, [
      el("div", {}, [el("div", { class: "text-slate-500" }, "全店舗合計人件費"), el("div", { class: "font-bold text-base" }, fmtYen(totalCost))]),
      el("div", {}, [el("div", { class: "text-slate-500" }, "合計勤務時間"), el("div", { class: "font-bold text-base" }, totalHours.toFixed(1) + "h")]),
      el("div", {}, [el("div", { class: "text-slate-500" }, "合計シフト"), el("div", { class: "font-bold text-base" }, totalShifts + " 件")]),
      el("div", {}, [el("div", { class: "text-slate-500" }, "確定済店舗"), el("div", { class: "font-bold text-base" }, `${publishedN} / ${(r.shops || []).length}`)]),
    ]), list.firstChild);
  }).catch(e => {
    list.innerHTML = `<div class="text-sm text-red-600 text-center py-4">取得失敗: ${escapeHtml(e?.message || "")}</div>`;
  });
}

async function loadAndRender() {
  try {
    // Round 26: 多店舗スイッチャー初期化 (失敗しても続行)
    initShopSwitcher().then(() => {
      // Round 34 TOP 2: プラン情報を取得 (tenant 情報から)
      try { fetchAndRenderPlanInfo(); } catch (_) {}
    }).catch(() => {});
    state = await loadState();
    // 日次スナップショット (Round 17 TOP 1)
    try {
      if (!window.__SHIFTY_DEMO_MODE__ && state.staff && state.staff.length > 0) {
        maybeCreateDailySnapshot();
      }
    } catch (e) { console.warn("snapshot failed:", e); }
    setTab("dashboard");
    if (!state.meta.onboardingCompleted && !window.__SHIFTY_DEMO_MODE__) {
      setTimeout(showOnboarding, 500);
    }
  } catch (e) {
    if (String(e.message).includes("401")) { showAuthOverlay("login"); return; }
    $("#main").innerHTML = `<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-red-900">読み込み失敗: ${escapeHtml(e.message)}</div>`;
  }
}

// ===== Onboarding wizard =====
function showOnboarding() {
  let step = 0;
  const BUSINESS_TYPES = (window.ShiftyData || {}).BUSINESS_TYPES || {};
  const SESSION_PRESETS = (window.ShiftyData || {}).SESSION_PRESETS || {};
  const STEPS = [
    {
      title: "👋 Shifty へようこそ",
      desc: "3 分で初期セットアップが完了します。",
      content() {
        return el("div", { class: "text-sm text-slate-600 space-y-2" }, [
          el("p", {}, "Shifty は飲食店向けの AI シフト自動作成サービスです。"),
          el("ul", { class: "list-disc pl-5 space-y-1" }, [
            el("li", {}, "店舗・スタッフ・営業時間を設定"),
            el("li", {}, "スタッフから希望をスマホで収集"),
            el("li", {}, "AI が最適なシフトを 5 秒で生成"),
            el("li", {}, "確定 → 打刻 → 月次給与計算"),
          ]),
          el("p", { class: "bg-blue-50 border border-blue-200 rounded p-3 text-blue-900" },
            "次のステップでお店の業態を選ぶと、セッション・必要人数・労務ルール・人件費率目標を一括で最適化します。"),
        ]);
      },
    },
    {
      title: "🏪 業態を選択 (Round 20)",
      desc: "お店の業態に合わせて、シフト枠・必要人数・労務ルール・AI 重みなどを一括設定します。後から設定タブで個別変更可能。",
      content() {
        const wrap = el("div", { class: "space-y-2 max-h-72 overflow-y-auto" });
        const current = state.meta.businessType || null;
        for (const [key, bt] of Object.entries(BUSINESS_TYPES)) {
          const isSelected = key === current;
          const card = el("button", {
            class: `block w-full text-left border-2 rounded-md p-3 transition ${isSelected ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-400"}`,
            "data-bt-key": key,
            onclick: () => {
              wrap.querySelectorAll("[data-bt-key]").forEach(b => {
                b.className = "block w-full text-left border-2 rounded-md p-3 transition border-slate-200 hover:border-slate-400";
              });
              card.className = "block w-full text-left border-2 rounded-md p-3 transition border-brand-600 bg-brand-50";
              card.setAttribute("data-selected", "1");
              wrap.querySelectorAll("[data-bt-key]").forEach(b => {
                if (b !== card) b.removeAttribute("data-selected");
              });
            },
          });
          if (isSelected) card.setAttribute("data-selected", "1");
          card.innerHTML = `
            <div class="font-semibold text-sm">${escapeHtml(bt.label)}</div>
            <div class="text-xs text-slate-600 mt-0.5">${escapeHtml(bt.description)}</div>
            <div class="text-[10px] text-slate-500 mt-1">
              人件費率目標 ${(bt.laborCostRatioTarget * 100).toFixed(0)}% / 週上限 ${bt.laborRules.maxHoursPerWeek}h / ${bt.payrollSettings.nightAllowanceEnabled ? "深夜手当 ON" : "深夜手当 OFF"}
            </div>`;
          wrap.appendChild(card);
        }
        return wrap;
      },
      onNext() {
        const selected = document.querySelector("[data-bt-key][data-selected]");
        const key = selected?.getAttribute("data-bt-key");
        if (!key || !BUSINESS_TYPES[key]) return;
        const bt = BUSINESS_TYPES[key];
        // 業態テンプレ適用 (スナップショット保存後)
        try { createSnapshot("manual", `業態テンプレ適用前 (${bt.label})`); } catch (_) {}
        state.meta.businessType = key;
        // セッション
        if (bt.sessionPreset && SESSION_PRESETS[bt.sessionPreset]) {
          state.meta.sessions = JSON.parse(JSON.stringify(SESSION_PRESETS[bt.sessionPreset].sessions));
          // 必要人数マトリクスをデフォルト構築
          const newPlan = {};
          for (const sess of state.meta.sessions) {
            newPlan[sess.id] = {};
            for (let dow = 0; dow < 7; dow++) {
              newPlan[sess.id][dow] = {};
              for (const pos of state.meta.positions) {
                newPlan[sess.id][dow][pos.id] = bt.defaultStaffCount[pos.id] != null ? bt.defaultStaffCount[pos.id] : 1;
              }
            }
          }
          state.meta.staffingPlan = newPlan;
        }
        // 労務ルール
        state.meta.laborRules = { ...bt.laborRules };
        // AI 重み
        state.meta.algorithmWeights = { ...bt.weights };
        // 給与設定
        state.meta.payrollSettings = { ...bt.payrollSettings };
        // 人件費率目標
        state.meta.laborCostRatioTarget = bt.laborCostRatioTarget;
        // 既存週のスロットを再生成
        regenerateCurSlots();
        toast(`✓ 業態「${bt.label}」を適用しました`, "success", 4000);
      },
    },
    {
      title: "🏪 店舗名を設定",
      desc: "ダッシュボードヘッダーに表示されます。後で設定タブから変更できます。",
      content() {
        return el("input", {
          id: "ob-name", class: "w-full border rounded-md px-3 py-2", placeholder: "例: いざかや 縁",
          value: state.meta.restaurantName === "いざかや 縁" ? "" : state.meta.restaurantName,
        });
      },
      onNext() {
        const v = $("#ob-name").value.trim();
        if (v) state.meta.restaurantName = v;
      },
    },
    {
      title: "💴 週の予算",
      desc: "週の人件費予算を設定。予算超過時に警告されます。",
      content() {
        return el("div", { class: "space-y-2" }, [
          el("input", {
            id: "ob-budget", type: "number", class: "w-full border rounded-md px-3 py-2",
            value: state.meta.weeklyBudget,
          }),
          el("div", { class: "text-xs text-slate-500" }, "目安: スタッフ 10名で月¥1,200,000 → 週¥300,000 程度"),
        ]);
      },
      onNext() {
        const v = Number($("#ob-budget").value);
        if (v > 0) state.meta.weeklyBudget = v;
      },
    },
    {
      title: "👥 スタッフ登録",
      desc: "実スタッフ情報の登録はあとからスタッフタブで行えます。まずは試してみたい場合は「サンプルを投入」を選んでください。",
      content() {
        const staffCount = state.staff.length;
        return el("div", { class: "text-sm space-y-3" }, [
          el("div", { class: "bg-slate-50 rounded p-3" }, [
            el("div", { class: "font-semibold mb-1" }, `現在のスタッフ: ${staffCount}名`),
            staffCount > 0
              ? el("div", { class: "text-xs text-slate-600" }, state.staff.slice(0, 5).map(s => s.name).join(" / ") + (staffCount > 5 ? ` 他${staffCount - 5}名` : ""))
              : el("div", { class: "text-xs text-slate-500" }, "（まだ登録されていません）"),
          ]),
          staffCount === 0 ? el("div", { class: "grid grid-cols-1 gap-2" }, [
            el("button", {
              class: "w-full bg-amber-500 hover:bg-amber-600 text-white rounded-md px-4 py-2.5 text-sm font-semibold",
              onclick: async () => {
                if (!confirm("サンプルデータ（10名スタッフ + 希望サンプル）を投入しますか？\n後でスタッフタブから自由に編集・削除できます。")) return;
                state = await resetState({ withSample: true });
                toast("サンプルデータを投入しました", "success");
                closeModal();
                render();
                setTimeout(showOnboarding, 300);
              }
            }, "🎯 サンプルデータで試す（10名）"),
            el("div", { class: "text-xs text-slate-500 text-center" }, "または完了後にスタッフタブから手動追加・CSV取込もできます"),
          ]) : el("div", { class: "text-xs text-slate-500" }, "💡 完了後にスタッフタブで「+ 追加」「CSV 取込」で編集できます。"),
        ]);
      },
    },
    {
      title: "📝 希望収集の方法",
      desc: "スタッフはスマホで希望を提出します。",
      content() {
        return el("div", { class: "text-sm space-y-3" }, [
          el("ol", { class: "list-decimal pl-5 space-y-2" }, [
            el("li", {}, "スタッフタブで「🔗 全員のリンク」をクリック"),
            el("li", {}, "クリップボードに各スタッフの URL がコピーされます"),
            el("li", {}, "LINE グループに貼り付けて配布"),
            el("li", {}, "スタッフは URL をタップ → スマホでタップ操作のみで希望提出"),
          ]),
          el("div", { class: "bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900" },
            "💡 スタッフは登録不要・アプリインストール不要。年配の方も使えます。"),
        ]);
      },
    },
    {
      title: "🎉 セットアップ完了",
      desc: "これで使い始められます！",
      content() {
        const hasStaff = state.staff.length > 0;
        return el("div", { class: "text-sm space-y-3" }, [
          el("p", {}, hasStaff
            ? "シフト編成タブの「🤖 AI 自動生成」ボタンで、登録済みスタッフ・希望からシフトが自動生成されます。"
            : "まずスタッフタブからスタッフを追加してください。希望収集 → AI生成 → 確定通知の流れで進みます。"),
          el("ul", { class: "list-disc pl-5 space-y-1 text-slate-600" }, [
            el("li", {}, "結果を確認 → 「確定する」"),
            el("li", {}, "「💬 LINE 通知文を生成」でクリップボードにコピー"),
            el("li", {}, "LINE グループに貼り付けて送信"),
          ]),
          el("p", { class: "text-xs text-slate-500 pt-2 border-t" },
            "わからないことがあれば右上の「ヘルプ」をクリック。"),
        ]);
      },
    },
  ];

  function renderStep() {
    const s = STEPS[step];
    const body = el("div", { class: "p-6" });
    body.appendChild(el("div", { class: "flex items-center justify-between mb-3" }, [
      el("h3", { class: "font-bold text-lg" }, s.title),
      el("span", { class: "text-xs text-slate-500" }, `Step ${step + 1} / ${STEPS.length}`),
    ]));
    // progress bar
    const pb = el("div", { class: "h-1.5 bg-slate-200 rounded-full mb-4 overflow-hidden" });
    pb.innerHTML = `<div style="width:${((step + 1) / STEPS.length) * 100}%;background:#4f46e5;height:100%"></div>`;
    body.appendChild(pb);
    body.appendChild(el("p", { class: "text-sm text-slate-600 mb-4", html: s.desc }));
    body.appendChild(s.content());
    body.appendChild(el("div", { class: "flex justify-between mt-6 pt-4 border-t" }, [
      el("div", {}, [
        step > 0 ? el("button", {
          class: "text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5",
          onclick: () => { step--; renderStep(); },
        }, "← 戻る") : null,
      ]),
      el("div", { class: "flex gap-2" }, [
        el("button", {
          class: "text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5",
          onclick: () => {
            state.meta.onboardingCompleted = true;
            persist(); closeModal();
          },
        }, "スキップ"),
        el("button", {
          class: "text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-1.5 font-semibold",
          onclick: () => {
            if (s.onNext) s.onNext();
            if (step < STEPS.length - 1) {
              step++;
              renderStep();
            } else {
              state.meta.onboardingCompleted = true;
              persist(); closeModal(); render();
              toast("セットアップ完了！シフト編成タブで AI 生成を試してみましょう", "success");
            }
          },
        }, step === STEPS.length - 1 ? "完了 →" : "次へ →"),
      ]),
    ]));
    modal(body);
  }
  renderStep();
}

// ===== Boot =====
document.addEventListener("DOMContentLoaded", () => {
  // Tab buttons
  $$(".tab-btn").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // Week nav
  $("#prevWeekBtn").addEventListener("click", () => goToWeek(addDays(state.meta.currentWeekStart, -7)));
  $("#nextWeekBtn").addEventListener("click", () => goToWeek(addDays(state.meta.currentWeekStart, 7)));
  $("#weekJumpBtn").addEventListener("click", () => {
    const body = el("div", { class: "p-6" });
    body.appendChild(el("h3", { class: "font-bold text-lg mb-3" }, "週ジャンプ"));
    body.appendChild(el("p", { class: "text-sm text-slate-600 mb-3" }, "ジャンプ先の日付を選択（月曜にスナップされます）"));
    const today = new Date();
    const minStr = (() => {
      const d = new Date(today); d.setMonth(d.getMonth() - 6);
      return fmt(d);
    })();
    const maxStr = (() => {
      const d = new Date(today); d.setMonth(d.getMonth() + 12);
      return fmt(d);
    })();
    function fmt(d) {
      const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,"0"); const dd = String(d.getDate()).padStart(2,"0");
      return `${y}-${m}-${dd}`;
    }
    const inp = el("input", {
      type: "date",
      class: "w-full border rounded-md px-3 py-2 text-base",
      value: state.meta.currentWeekStart,
      min: minStr, max: maxStr,
      "aria-label": "ジャンプ先の日付",
    });
    body.appendChild(inp);
    body.appendChild(el("div", { class: "flex justify-end gap-2 mt-4" }, [
      el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
      el("button", {
        class: "px-3 py-1.5 text-sm bg-brand-600 text-white rounded-md font-semibold",
        onclick: () => {
          const v = inp.value;
          if (!v) { toast("日付を選択してください", "error"); return; }
          // 月曜にスナップ
          const d = new Date(v);
          const day = d.getDay();
          const diff = day === 0 ? -6 : 1 - day;
          d.setDate(d.getDate() + diff);
          const monday = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
          closeModal();
          goToWeek(monday);
        },
      }, "ジャンプ →"),
    ]));
    modal(body);
    setTimeout(() => inp.focus(), 50);
  });

  // Logout
  $("#logoutBtn").addEventListener("click", async () => {
    if (!confirm("ログアウトしますか？")) return;
    try { await window.ShiftyAPI.authLogout(); } catch (_) {}
    state = null;
    showAuthOverlay("login");
    toast("ログアウトしました", "success");
  });

  // Auth handlers
  $("#setupBtn").addEventListener("click", async () => {
    const p1 = $("#setupPass1").value;
    const p2 = $("#setupPass2").value;
    const err = $("#setupErr");
    err.classList.add("hidden");
    if (p1.length < 6) { err.textContent = "6文字以上で入力してください"; err.classList.remove("hidden"); return; }
    if (p1 !== p2) { err.textContent = "パスワードが一致しません"; err.classList.remove("hidden"); return; }
    try {
      await window.ShiftyAPI.authSetup(p1);
      hideAuthOverlay();
      await loadAndRender();
      toast("セットアップ完了", "success");
    } catch (e) {
      err.textContent = "セットアップ失敗: " + e.message;
      err.classList.remove("hidden");
    }
  });

  $("#loginBtn").addEventListener("click", async () => {
    const p = $("#loginPass").value;
    const err = $("#loginErr");
    err.classList.add("hidden");
    try {
      await window.ShiftyAPI.authLogin(p);
      $("#loginPass").value = "";
      hideAuthOverlay();
      await loadAndRender();
      toast("ログインしました", "success");
    } catch (e) {
      err.textContent = e.message.includes("401") ? "パスワードが違います" : "ログイン失敗";
      err.classList.remove("hidden");
    }
  });
  $("#loginPass").addEventListener("keydown", e => { if (e.key === "Enter") $("#loginBtn").click(); });
  $("#setupPass2").addEventListener("keydown", e => { if (e.key === "Enter") $("#setupBtn").click(); });

  bootApp();
});

})();
