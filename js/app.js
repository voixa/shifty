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
    breakMinutes: 0,  // Round 10: 6h 超勤務時の休憩時間（分）
  };
  if (data.breakMinutes === undefined) data.breakMinutes = 0;
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
      <input data-k="notes" class="mt-1 w-full border rounded-md px-3 py-2" value="${escapeAttr(data.notes || "")}"></label>`;
  body.appendChild(form);
  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-2" }, [
    el("button", { class: "px-3 py-1.5 text-sm", onclick: closeModal }, "キャンセル"),
    el("button", { class: "px-4 py-1.5 text-sm bg-brand-600 text-white rounded-md", onclick: () => {
      $$("input,select", form).forEach(inp => {
        const k = inp.dataset.k;
        if (k) data[k] = inp.type === "number" ? Number(inp.value) : inp.value;
      });
      data.canCover = $$("input[data-cover]", form).filter(i => i.checked).map(i => i.dataset.cover);
      data.fixedDayOff = $$("input[data-off]", form).filter(i => i.checked).map(i => Number(i.dataset.off));
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

  wrap.appendChild(renderCalendar());
  if (curAssignments().length) wrap.appendChild(renderStaffSummary());

  // 変更履歴 (Round 11) — このタブで一覧表示
  const changeLog = curWeek().changeLog || [];
  if (changeLog.length > 0) {
    const logCard = el("div", { class: "bg-white border border-slate-200 rounded-xl p-3 no-print" });
    logCard.appendChild(el("details", {}, [
      el("summary", { class: "text-sm font-semibold cursor-pointer select-none" },
        `📜 変更履歴 (${changeLog.length} 件)`),
      el("div", { class: "mt-3 space-y-1 text-xs max-h-80 overflow-y-auto" }, changeLog.slice().reverse().map(log => {
        const TYPE_EMOJI = { publish: "✅", unpublish: "📝", delete: "🗑", swap: "🔄", substitute: "🆘", add: "➕", autogenerate: "🤖" };
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
  const TYPE_LABEL = { publish: "✅ 確定", unpublish: "📝 下書きに戻す", delete: "🗑 削除", swap: "🔄 入替", substitute: "🆘 代打", add: "➕ 追加", autogenerate: "🤖 AI生成" };
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
            style: { borderColor: cfg.color },
            onclick: () => handleChipTap(a),
            ondragstart: editable ? (e) => handleChipDragStart(e, a) : null,
            ondragover: editable ? (e) => { e.preventDefault(); chip.classList.add("drop-target"); } : null,
            ondragleave: editable ? () => chip.classList.remove("drop-target") : null,
            ondrop: editable ? (e) => { chip.classList.remove("drop-target"); handleChipDrop(e, a); } : null,
            ondragend: () => $$(".assignment-chip").forEach(c => c.classList.remove("drop-target", "dragging")),
          });
          chip.innerHTML = `<div class="name">${escapeHtml(s?.name || "?")}</div>
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
            return `<span class="print-staff-name">${escapeHtml(s?.name || "?")}</span>`;
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
            style: { borderColor: cfg.color, padding: "6px 8px" },
            onclick: () => handleChipTap(a),
            ondragstart: editable ? (e) => handleChipDragStart(e, a) : null,
            ondragover: editable ? (e) => { e.preventDefault(); chip.classList.add("drop-target"); } : null,
            ondragleave: editable ? () => chip.classList.remove("drop-target") : null,
            ondrop: editable ? (e) => { chip.classList.remove("drop-target"); handleChipDrop(e, a); } : null,
            ondragend: () => $$(".assignment-chip").forEach(c => c.classList.remove("drop-target", "dragging")),
          });
          chip.innerHTML = `
            <span><span class="name font-semibold">${escapeHtml(s?.name || "?")}</span> <span class="text-[10px] text-slate-500">${escapeHtml(cfg.label)}</span></span>
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
    body.appendChild(el("div", { class: "text-xs text-slate-500" }, "確定済の週は編集不可（下書きに戻すと編集できます）"));
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
      const result = generateShift({
        staff: state.staff, slots: curSlots(), preferences: curPrefs(),
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

  body.appendChild(el("div", { class: "flex justify-end gap-2 pt-3" }, [
    el("button", { class: "px-3 py-1.5 text-sm bg-slate-200 rounded-md", onclick: closeModal }, "キャンセル"),
    el("button", {
      class: "px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-md font-semibold",
      onclick: () => {
        const month = $("#pcsv-month").value;
        const format = $("#pcsv-format").value;
        downloadPayrollCsv(month, format);
        closeModal();
      },
    }, "ダウンロード"),
  ]));
  modal(body);
}

function downloadPayrollCsv(monthKey, format) {
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

  // スタッフ別集計 (Round 10: 休憩時間を控除)
  const byStaff = {};
  for (const a of monthAssignments) {
    if (!byStaff[a.staffId]) byStaff[a.staffId] = { hours: 0, pay: 0, days: [] };
    const staffRec = state.staff.find(s => s.id === a.staffId);
    const breakMin = (staffRec && staffRec.breakMinutes) || 0;
    let h = calcHours(a.startTime, a.endTime);
    // 6h 超勤務の場合は休憩時間を控除（労基準拠の慣習）
    if (h > 6 && breakMin > 0) {
      h -= breakMin / 60;
    }
    byStaff[a.staffId].hours += h;
    byStaff[a.staffId].pay += staffRec ? (staffRec.hourlyWage * h) : a.cost;
    byStaff[a.staffId].days.push(a);
  }

  let csv = "";
  let filename = `payroll_${monthKey}_${format}.csv`;

  if (format === "summary") {
    csv = "スタッフID,氏名,本職,時給,合計時間(h),合計給与(円)\n";
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      csv += [s.id, s.name, posCfg(s.position).label, s.hourlyWage, r.hours.toFixed(2), Math.round(r.pay)]
        .map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
  } else if (format === "detail") {
    csv = "日付,曜日,スタッフID,氏名,開始,終了,時間(h),ポジション,給与(円)\n";
    monthAssignments.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    for (const a of monthAssignments) {
      const s = state.staff.find(x => x.id === a.staffId);
      if (!s) continue;
      const h = calcHours(a.startTime, a.endTime);
      const dow = DAY_LABELS[dayOfWeek(a.date)];
      csv += [a.date, dow, s.id, s.name, a.startTime, a.endTime, h.toFixed(2), posCfg(a.position).label, Math.round(a.cost)]
        .map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
  } else if (format === "yayoi") {
    // 弥生給与の汎用取込形式 (社員番号,氏名,勤務時間,合計支給額)
    csv = "社員番号,氏名,勤務時間,基本給(時給×時間)\n";
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      csv += [s.id, s.name, r.hours.toFixed(2), Math.round(r.pay)]
        .map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
    filename = `yayoi_${monthKey}.csv`;
  } else if (format === "freee") {
    // freee 人事労務の取込形式 (従業員番号,氏名,労働時間,時給,給与)
    csv = "従業員番号,従業員氏名,労働時間,時給,給与額\n";
    for (const s of state.staff) {
      const r = byStaff[s.id];
      if (!r) continue;
      csv += [s.id, s.name, r.hours.toFixed(2), s.hourlyWage, Math.round(r.pay)]
        .map(x => `"${String(x).replace(/"/g, "\"\"")}"`).join(",") + "\n";
    }
    filename = `freee_${monthKey}.csv`;
  }

  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`${filename} をダウンロード (${Object.keys(byStaff).length} 名分)`, "success");
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
  sessCard.appendChild(el("div", { class: "flex items-center justify-between" }, [
    el("div", { class: "font-semibold" }, "4. 営業セッション（時間帯）"),
    el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
      onclick: () => editSessionDialog() }, "＋ 追加"),
  ]));
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
  laborCard.appendChild(el("button", { class: "text-sm bg-brand-600 text-white rounded-md px-3 py-1.5",
    onclick: () => {
      state.meta.laborRules = {
        maxHoursPerWeek: Number($("#lr-week").value) || 40,
        maxHoursPerDay: Number($("#lr-day").value) || 8,
        maxConsecutiveDays: Number($("#lr-cons").value) || 5,
        minRestDaysPerWeek: Number($("#lr-rest").value) || 1,
      };
      persist(); render(); toast("労務ルールを保存（次回 AI 生成から適用）", "success");
    } }, "保存"));
  wrap.appendChild(laborCard);

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
      onclick: openSnapshotsDialog }, "🕒 過去スナップショット"),
  ]));
  backupCard.appendChild(el("div", { class: "text-xs text-slate-500 pt-2 border-t border-slate-100" },
    "💡 サーバ側で毎日 03:00 (JST) に自動スナップショット取得（過去 30 日分保持）。「過去スナップショット」ボタンから任意の日に巻き戻せます。"));
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
