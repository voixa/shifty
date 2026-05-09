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
function persist() { saveState(state).catch(() => {}); }
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
}

// ===== Routing =====
function setTab(tab) {
  currentTab = tab;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

function render() {
  if (!state) return;
  const main = $("#main");
  main.innerHTML = "";
  if (currentTab === "dashboard")   main.appendChild(viewDashboard());
  if (currentTab === "staff")       main.appendChild(viewStaff());
  if (currentTab === "preferences") main.appendChild(viewPreferences());
  if (currentTab === "schedule")    main.appendChild(viewSchedule());
  if (currentTab === "export")      main.appendChild(viewExport());
  if (currentTab === "settings")    main.appendChild(viewSettings());
  // モバイル用 FAB（シフト編成タブのみ）
  const oldFab = document.getElementById("mobileFab");
  if (oldFab) oldFab.remove();
  if (currentTab === "schedule" && curStatus() === "draft") {
    const fab = el("button", {
      id: "mobileFab", class: "fab",
      onclick: autoGenerate,
    }, "🤖 AI生成");
    document.body.appendChild(fab);
  }
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
function viewDashboard() {
  const wrap = el("div", { class: "space-y-6" });
  wrap.appendChild(el("div", { class: "flex items-center justify-between" }, [
    el("h2", { class: "text-xl font-bold" }, "今週の概要"),
    el("div", { class: "text-sm text-slate-500" }, state.meta.currentWeekStart + " 〜"),
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

  // 月次労務リスク (Round 15 TOP 1) — 当月の累積時間と労務上限への接近度
  if (state.staff.length > 0) {
    const monthCard = renderMonthlyLaborRisk();
    if (monthCard) wrap.appendChild(monthCard);
  }

  // スタッフ・インサイト (Round 16 TOP 3) — 希望提出率・カバレッジ貢献・燃え尽きリスク
  if (state.staff.length > 0) {
    const insightCard = renderStaffInsights();
    if (insightCard) wrap.appendChild(insightCard);
  }

  // 人件費推移グラフ (Round 11) — 過去 8 週分の確定済シフト人件費
  if (state.staff.length > 0 && typeof Chart !== "undefined") {
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
  if (todayAssignments.length > 0) {
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

  if (alerts.length > 0) {
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
  wrap.appendChild(el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, `スタッフ管理 (${state.staff.length}名)`),
    el("div", { class: "flex gap-2 flex-wrap" }, [
      el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: () => importCsvDialog() }, "📥 CSV取込"),
      state.staff.length > 0 ? el("button", { class: "text-sm border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: copyAllStaffLinks }, "🔗 全員のリンク") : null,
      el("button", { class: "text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md px-3 py-1.5",
        onclick: () => openStaffEdit() }, "＋ スタッフ追加"),
    ]),
  ]));

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
  state.staff.forEach((s, idx) => {
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
    tr.innerHTML = `
      <td class="px-2 py-2.5 text-center text-slate-400 cursor-move" title="ドラッグで並び替え">⋮⋮</td>
      <td class="px-3 py-2.5 font-medium">${escapeHtml(s.name)}</td>
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
      el("button", { class: "text-xs text-red-600 hover:underline",
        onclick: () => {
          if (!confirm(`${s.name} を削除しますか？`)) return;
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

  const headerRow = el("div", { class: "flex items-center justify-between flex-wrap gap-2" }, [
    el("h2", { class: "text-xl font-bold" }, "シフト編成"),
    el("div", { class: "flex gap-2 flex-wrap" }, [
      el("button", { class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: () => {
          if (curStatus() === "published") { toast("確定済の週はクリアできません。先に「下書きに戻す」してください。", "error"); return; }
          const n = curAssignments().length;
          if (n === 0) return;
          if (!confirm(`今週の AI 生成シフト ${n} 件を全削除しますか？\nこの操作は取り消せません（希望データは残ります）。`)) return;
          curWeek().assignments = []; persist(); render(); toast(`${n} 件をクリアしました`);
        } }, "クリア"),
      el("button", { class: "text-sm border border-emerald-600 text-emerald-700 rounded-md px-3 py-1.5 hover:bg-emerald-50",
        onclick: copyFromPreviousWeek }, "📋 先週からコピー"),
      el("button", { class: "text-sm border border-purple-600 text-purple-700 rounded-md px-3 py-1.5 hover:bg-purple-50",
        onclick: openTemplateDialog }, "📑 テンプレ"),
      el("button", {
        class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50 " + (swapModeActive ? "bg-amber-500 text-white border-amber-500 hover:bg-amber-600" : ""),
        onclick: toggleSwapMode,
        title: "タップでスタッフ入替（モバイル対応）",
      }, swapModeActive ? "🔁 入替モード ON" : "🔁 入替モード"),
      curAssignments().length > 0 ? el("button", {
        class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50",
        onclick: openPrintView,
        title: "店内掲示用 / 紙シフトの印刷",
      }, "🖨️ 印刷") : null,
      el("button", {
        class: "text-sm border rounded-md px-3 py-1.5 hover:bg-slate-50 " + (multiWeekView ? "bg-blue-500 text-white border-blue-500" : ""),
        onclick: toggleMultiWeekView,
        title: "今週 + 翌3週 を一覧表示",
      }, multiWeekView ? "📆 4週表示 ON" : "📆 4週表示"),
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

function publishWeek() {
  if (!curAssignments().length) { toast("シフトを生成してから確定してください", "error"); return; }
  // Round 3: 確定 + 通知統合フロー
  const withEmail = state.staff.filter(s => (s.email || "").trim());
  const totalStaff = state.staff.length;
  const noEmailCount = totalStaff - withEmail.length;

  const body = el("div", { class: "p-6 space-y-3" });
  body.appendChild(el("h3", { class: "font-bold text-lg" }, "✓ 今週のシフトを確定"));
  body.appendChild(el("p", { class: "text-sm text-slate-600" },
    "確定するとスタッフはポータルから自分のシフトを閲覧できるようになります。"));

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
      const dayAssignments = curAssignments().filter(a => a.date === d && a.startTime === sess.startTime);
      for (const pos of state.meta.positions) {
        const list = dayAssignments.filter(a => a.position === pos.id);
        list.forEach(a => {
          const s = state.staff.find(x => x.id === a.staffId);
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
      const slotsInCell = curSlots().filter(s => s.date === d && s.startTime === sess.startTime);
      slotsInCell.forEach(slot => {
        const filledN = dayAssignments.filter(a => a.position === slot.position).length;
        const missing = slot.requiredCount - filledN;
        if (missing > 0 && curAssignments().length > 0) {
          cell.appendChild(el("div", { class: "text-[10px] text-red-600 bg-red-50 rounded px-1 mt-0.5" },
            `不足: ${posCfg(slot.position).label} ×${missing}`));
        }
      });
      // 必要人数オーバーライドボタン (Round 2 改善)
      if (curStatus() === "draft") {
        const adjustBtn = el("button", {
          class: "text-[10px] text-slate-400 hover:text-slate-700 mt-1 underline decoration-dotted",
          title: "この日のセッションの必要人数を編集",
          onclick: () => openSlotAdjustDialog(d, sess),
        }, "⚙️ 必要人数を調整");
        cell.appendChild(adjustBtn);
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

// 印刷ビュー (Round 4)
function openPrintView() {
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
        html += `<td rowspan="${positions.length}" style="vertical-align:middle">${escapeHtml(sess.label)}<br><span style="font-size:8pt;color:#555">${sess.startTime}〜${sess.endTime}</span></td>`;
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
      sessHead.innerHTML = `<span>${sess.icon || ""}</span><span>${escapeHtml(sess.label)}</span><span class="text-slate-400">${sess.startTime}〜${sess.endTime}</span>`;
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
        toast(`✅ 完成 (${totalElapsed}s): カバー${fmtPct(m.coverageRate)} / 希望${fmtPct(m.preferenceSatisfaction)} / ${fmtYen(m.totalCost)}`, "success", 5000);
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
      onclick: openPrintView }, "🖨 印刷ビュー"),
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
  wrap.appendChild(el("div", { class: "text-sm text-slate-600" },
    "ここで設定した内容に基づいて、シフト枠（必要人数マトリクス）が生成されます。"));

  // 設定セクション目次 (Round 7) — モバイルで縦スクロール時のジャンプ
  const toc = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3 sticky top-2 z-10" });
  toc.innerHTML = `
    <div class="text-xs font-semibold text-slate-700 mb-1.5">📌 設定項目に飛ぶ</div>
    <div class="flex flex-wrap gap-1 text-xs">
      <a href="#set-basic" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">基本情報</a>
      <a href="#set-positions" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">ポジション</a>
      <a href="#set-sessions" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">営業時間</a>
      <a href="#set-staffing" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">必要人数</a>
      <a href="#set-labor" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">労務ルール</a>
      <a href="#set-deadline" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">提出締切</a>
      <a href="#set-algo" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">AI 重み</a>
      <a href="#set-backup" class="bg-slate-100 hover:bg-slate-200 rounded px-2 py-1">バックアップ</a>
    </div>`;
  wrap.appendChild(toc);

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
  const matrixHeader = el("div", { class: "font-semibold" });
  matrixHeader.innerHTML = `5. 必要人数マトリクス${helpIcon("staffing-matrix")}`;
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

  // Round 6: プリセット選択
  const PRESETS = {
    "balanced": { label: "⚖️ バランス", desc: "標準的な配分", weights: { preference: 0.40, positionMatch: 0.15, fairness: 0.20, cost: 0.15, skill: 0.10 } },
    "preference": { label: "❤️ 希望最優先", desc: "スタッフ希望を最大限尊重", weights: { preference: 0.60, positionMatch: 0.10, fairness: 0.15, cost: 0.05, skill: 0.10 } },
    "cost": { label: "💴 コスト重視", desc: "人件費を最小化（時給低い人優先）", weights: { preference: 0.25, positionMatch: 0.15, fairness: 0.15, cost: 0.35, skill: 0.10 } },
    "skill": { label: "⭐ スキル重視", desc: "ピーク時に熟練者を配置", weights: { preference: 0.30, positionMatch: 0.20, fairness: 0.15, cost: 0.10, skill: 0.25 } },
    "fairness": { label: "🤝 公平性重視", desc: "全員に均等にシフトを配分", weights: { preference: 0.30, positionMatch: 0.10, fairness: 0.40, cost: 0.10, skill: 0.10 } },
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
      state.meta.algorithmWeights = { preference: 0.40, positionMatch: 0.15, fairness: 0.20, cost: 0.15, skill: 0.10 };
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
      const row = el("div", { class: "bg-slate-50 rounded-md p-3 text-sm" });
      const at = m.createdAt ? new Date(m.createdAt).toLocaleString("ja-JP") : "?";
      row.innerHTML = `
        <div class="flex items-center justify-between mb-1">
          <span class="font-semibold">${escapeHtml(m.staffName || m.staffId)}</span>
          <span class="text-xs text-slate-500">${at}</span>
        </div>
        <div class="text-xs text-amber-700 mb-1">${KIND_LABEL[m.kind] || m.kind}</div>
        <div class="text-sm text-slate-700 whitespace-pre-wrap mb-2">${escapeHtml(m.message || "")}</div>
      `;
      // 返信ボタン (Round 12)
      const replyBtn = el("button", {
        class: "text-xs bg-emerald-500 hover:bg-emerald-600 text-white rounded px-2 py-1 font-semibold",
        onclick: () => openReplyDialog(m),
      }, "✉️ 返信文を生成");
      row.appendChild(replyBtn);
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="text-xs text-red-600">取得失敗: ${escapeHtml(e.message)}</div>`;
  }
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

async function loadAndRender() {
  try {
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
  const STEPS = [
    {
      title: "👋 Shifty へようこそ",
      desc: "30 分で初期セットアップが完了します。<br>順番にご案内しますので、わからなければ「スキップ」もOKです。",
      content() {
        return el("div", { class: "text-sm text-slate-600 space-y-2" }, [
          el("p", {}, "Shifty は飲食店向けの AI シフト自動作成サービスです。"),
          el("ul", { class: "list-disc pl-5 space-y-1" }, [
            el("li", {}, "店舗・スタッフ・営業時間を設定"),
            el("li", {}, "スタッフから希望をスマホで収集"),
            el("li", {}, "AI が最適なシフトを 5 秒で生成"),
            el("li", {}, "確定 → スタッフへ通知"),
          ]),
          el("p", { class: "bg-blue-50 border border-blue-200 rounded p-3 text-blue-900" },
            "次のステップで「実データで始める」か「サンプルデータで試す」か選べます。"),
        ]);
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
