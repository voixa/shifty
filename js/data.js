// data.js v3 — 複数週対応スキーマ
// state.weeks[YYYY-MM-DD] = { slots, preferences, assignments, status, publishedAt }
(function () {
  const STORAGE_KEY = "shifty.v3";
  const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  const DEFAULT_POSITIONS = [
    { id: "manager", label: "店長",     color: "#8b5cf6" },
    { id: "kitchen", label: "キッチン", color: "#f97316" },
    { id: "hall",    label: "ホール",   color: "#3b82f6" },
    { id: "cashier", label: "レジ",     color: "#10b981" },
  ];
  const DEFAULT_SESSIONS = [
    { id: "lunch",  label: "ランチ",  startTime: "11:00", endTime: "15:00", icon: "☀️" },
    { id: "dinner", label: "ディナー", startTime: "17:00", endTime: "22:00", icon: "🌙" },
  ];

  function defaultStaffingPlan() {
    const plan = {};
    for (const sess of DEFAULT_SESSIONS) {
      plan[sess.id] = {};
      for (let dow = 0; dow < 7; dow++) {
        const isWeekend = dow === 0 || dow === 6;
        plan[sess.id][dow] =
          sess.id === "lunch"
            ? { manager: 1, kitchen: 1, hall: isWeekend ? 2 : 1, cashier: 1 }
            : { manager: 1, kitchen: isWeekend ? 2 : 1, hall: 2, cashier: 1 };
      }
    }
    return plan;
  }

  // ===== Time helpers =====
  function uid(prefix = "") {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }
  function todayMonday(d = new Date()) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }
  function dayOfWeek(dateStr) { return new Date(dateStr).getDay(); }
  function timeToMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
  function calcHours(start, end) { return (timeToMin(end) - timeToMin(start)) / 60; }
  function timeOverlap(a, b) {
    return timeToMin(a.startTime) < timeToMin(b.endTime) &&
           timeToMin(b.startTime) < timeToMin(a.endTime);
  }
  function timeContains(outer, inner) {
    return timeToMin(outer.startTime) <= timeToMin(inner.startTime) &&
           timeToMin(outer.endTime) >= timeToMin(inner.endTime);
  }

  // ===== Slot/Week helpers =====
  function buildSlots(meta, weekStart) {
    const slots = [];
    const plan = meta.staffingPlan || {};
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const dow = dayOfWeek(date);
      for (const sess of meta.sessions || []) {
        const dayPlan = plan[sess.id]?.[dow] || {};
        for (const pos of meta.positions || []) {
          const cnt = Number(dayPlan[pos.id]) || 0;
          if (cnt > 0) {
            slots.push({
              id: uid("sl_"), date,
              position: pos.id,
              startTime: sess.startTime, endTime: sess.endTime,
              requiredCount: cnt,
            });
          }
        }
      }
    }
    return slots;
  }

  function newWeek(meta, weekStart) {
    return {
      slots: buildSlots(meta, weekStart),
      preferences: [],
      assignments: [],
      status: "draft",
      publishedAt: null,
      changeLog: [],
    };
  }

  function ensureWeek(state, weekStart) {
    if (!state.weeks) state.weeks = {};
    if (!state.weeks[weekStart]) {
      state.weeks[weekStart] = newWeek(state.meta, weekStart);
    }
    return state.weeks[weekStart];
  }

  function listWeeks(state) {
    return Object.keys(state.weeks || {}).sort();
  }

  // ===== Storage =====
  async function loadState() {
    try {
      const remote = await window.ShiftyAPI.getState();
      if (remote && remote.staff) return migrate(remote);
    } catch (e) {
      // 401 などはここで再スロー（呼び出し側で auth 処理）
      if (String(e.message).includes("401") || String(e.message).includes("unauthenticated")) throw e;
      console.warn("API getState failed, falling back", e);
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("shifty.v2") || localStorage.getItem("shifty.v1");
      if (raw) {
        const parsed = migrate(JSON.parse(raw));
        try { await window.ShiftyAPI.saveState(parsed); } catch (_) {}
        return parsed;
      }
    } catch (e) {
      console.warn("localStorage parse failed", e);
    }
    const fresh = seedState();
    try { await window.ShiftyAPI.saveState(fresh); } catch (_) {}
    return fresh;
  }

  async function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    try { await window.ShiftyAPI.saveState(state); }
    catch (e) {
      if (String(e.message).includes("401") || String(e.message).includes("unauthenticated")) throw e;
      console.warn("API saveState failed (kept local backup)", e);
    }
  }

  async function resetState() {
    try { await window.ShiftyAPI.resetServer(); } catch (_) {}
    const fresh = seedState();
    await saveState(fresh);
    return fresh;
  }

  // ===== Migration =====
  function migrate(state) {
    if (!state) return state;
    state.meta = state.meta || {};
    if (!state.meta.sessions)     state.meta.sessions = JSON.parse(JSON.stringify(DEFAULT_SESSIONS));
    if (!state.meta.positions)    state.meta.positions = JSON.parse(JSON.stringify(DEFAULT_POSITIONS));
    if (!state.meta.staffingPlan) state.meta.staffingPlan = defaultStaffingPlan();
    if (!state.meta.weeklyBudget) state.meta.weeklyBudget = 380000;
    if (!state.meta.restaurantName) state.meta.restaurantName = "（店舗名未設定）";
    if (!state.meta.currentWeekStart) state.meta.currentWeekStart = fmtDate(todayMonday());
    if (!state.meta.laborRules) state.meta.laborRules = {
      maxHoursPerWeek: 40,
      maxConsecutiveDays: 5,
      maxHoursPerDay: 12,
      minRestDaysPerWeek: 1,
      minRestHoursBetweenShifts: 8,
    };
    // 自動アップグレード: 旧デフォルト 8h は飲食店現実に合わずカバー率が壊滅するため 12h に引き上げ
    // (lunch 11-15 + dinner 17-22 = 9h を許可。意図的に 8h 設定済みの顧客がいないので無条件で書き換え)
    if (state.meta.laborRules.maxHoursPerDay <= 8) state.meta.laborRules.maxHoursPerDay = 12;
    if (state.meta.laborRules.minRestHoursBetweenShifts === undefined) state.meta.laborRules.minRestHoursBetweenShifts = 8;
    if (!state.meta.templates) state.meta.templates = [];
    if (!state.meta.algorithmWeights) state.meta.algorithmWeights = {
      preference: 0.40,
      positionMatch: 0.15,
      fairness: 0.20,
      cost: 0.15,
      skill: 0.10,
    };
    if (!state.meta.randomStarts) state.meta.randomStarts = 5;
    if (state.meta.onboardingCompleted === undefined) state.meta.onboardingCompleted = false;
    // v4 → v5: changeLog を各週に追加
    for (const wk of Object.values(state.weeks || {})) {
      if (!Array.isArray(wk.changeLog)) wk.changeLog = [];
    }
    state.staff = state.staff || [];
    // v3 → v4: スタッフに email フィールドを追加（空文字でデフォルト）
    for (const s of state.staff) {
      if (s.email === undefined) s.email = "";
    }

    // v2 → v3: 旧トップレベルの slots/preferences/assignments を weeks 配下に移動
    if (!state.weeks) state.weeks = {};
    if (state.slots !== undefined || state.preferences !== undefined || state.assignments !== undefined) {
      const wk = state.meta.currentWeekStart;
      state.weeks[wk] = {
        slots: state.slots && state.slots.length ? state.slots : buildSlots(state.meta, wk),
        preferences: state.preferences || [],
        assignments: state.assignments || [],
        status: "draft",
        publishedAt: null,
      };
      delete state.slots;
      delete state.preferences;
      delete state.assignments;
    }

    ensureWeek(state, state.meta.currentWeekStart);
    return state;
  }

  // ===== Seed =====
  function seedState() {
    const weekStart = fmtDate(todayMonday());
    const meta = {
      restaurantName: "いざかや 縁",
      weeklyBudget: 380000,
      currentWeekStart: weekStart,
      sessions: JSON.parse(JSON.stringify(DEFAULT_SESSIONS)),
      positions: JSON.parse(JSON.stringify(DEFAULT_POSITIONS)),
      staffingPlan: defaultStaffingPlan(),
      laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, maxHoursPerDay: 12, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 },
      createdAt: new Date().toISOString(),
    };

    const staff = [
      { id: uid("s_"), name: "田中 美咲",  position: "hall",    canCover: ["cashier"],         hourlyWage: 1100, maxHoursPerWeek: 28, minHoursPerWeek: 15, fixedDayOff: [0],   skill: 4, notes: "リーダー候補", email: "" },
      { id: uid("s_"), name: "佐藤 健",    position: "kitchen", canCover: [],                  hourlyWage: 1300, maxHoursPerWeek: 40, minHoursPerWeek: 30, fixedDayOff: [2],   skill: 5, notes: "調理長" },
      { id: uid("s_"), name: "鈴木 由美",  position: "hall",    canCover: ["cashier"],         hourlyWage: 1050, maxHoursPerWeek: 20, minHoursPerWeek: 8,  fixedDayOff: [3,4], skill: 3, notes: "主婦・夕方まで" },
      { id: uid("s_"), name: "高橋 翔太",  position: "kitchen", canCover: ["hall"],            hourlyWage: 1100, maxHoursPerWeek: 25, minHoursPerWeek: 10, fixedDayOff: [1],   skill: 3, notes: "大学生" },
      { id: uid("s_"), name: "伊藤 さくら", position: "cashier", canCover: ["hall"],            hourlyWage: 1050, maxHoursPerWeek: 20, minHoursPerWeek: 8,  fixedDayOff: [5,6], skill: 3, notes: "高校生・夜不可" },
      { id: uid("s_"), name: "渡辺 拓海",  position: "kitchen", canCover: [],                  hourlyWage: 1150, maxHoursPerWeek: 30, minHoursPerWeek: 12, fixedDayOff: [0],   skill: 4, notes: "" },
      { id: uid("s_"), name: "山本 結衣",  position: "hall",    canCover: ["cashier","kitchen"], hourlyWage: 1200, maxHoursPerWeek: 32, minHoursPerWeek: 20, fixedDayOff: [4],   skill: 5, notes: "マルチプレイヤー" },
      { id: uid("s_"), name: "中村 直樹",  position: "manager", canCover: ["hall","kitchen"],    hourlyWage: 1800, maxHoursPerWeek: 40, minHoursPerWeek: 35, fixedDayOff: [1],   skill: 5, notes: "店長" },
      { id: uid("s_"), name: "小林 玲奈",  position: "hall",    canCover: ["cashier"],         hourlyWage: 1100, maxHoursPerWeek: 24, minHoursPerWeek: 12, fixedDayOff: [2],   skill: 3, notes: "大学生" },
      { id: uid("s_"), name: "加藤 大輔",  position: "kitchen", canCover: ["hall"],            hourlyWage: 1150, maxHoursPerWeek: 28, minHoursPerWeek: 15, fixedDayOff: [3],   skill: 4, notes: "フリーター" },
    ];

    // 希望サンプル
    const preferences = [];
    const samplePrefs = [
      { staffIdx: 0, days: [1,2,3,4],     sess: "lunch",  priority: "want" },
      { staffIdx: 0, days: [5,6],         sess: "dinner", priority: "must" },
      { staffIdx: 1, days: [0,1,3,4,5,6], sess: "both",   priority: "must" },
      { staffIdx: 2, days: [1,2,5,6],     sess: "lunch",  priority: "want" },
      { staffIdx: 3, days: [2,3,4,5,6],   sess: "dinner", priority: "want" },
      { staffIdx: 4, days: [0,1,2,3],     sess: "lunch",  priority: "must" },
      { staffIdx: 6, days: [0,1,2,3,5,6], sess: "dinner", priority: "want" },
      { staffIdx: 7, days: [0,2,3,4,5,6], sess: "both",   priority: "must" },
    ];
    for (const p of samplePrefs) {
      const s = staff[p.staffIdx];
      for (const d of p.days) {
        const date = addDays(weekStart, d);
        if (s.fixedDayOff.includes(dayOfWeek(date))) continue;
        const sessions = p.sess === "both" ? meta.sessions : meta.sessions.filter(x => x.id === p.sess);
        for (const sess of sessions) {
          preferences.push({
            id: uid("p_"), staffId: s.id, date,
            startTime: sess.startTime, endTime: sess.endTime, priority: p.priority,
          });
        }
      }
    }

    return {
      meta, staff,
      weeks: {
        [weekStart]: {
          slots: buildSlots(meta, weekStart),
          preferences,
          assignments: [],
          status: "draft",
          publishedAt: null,
          changeLog: [],
        },
      },
    };
  }

  window.ShiftyData = {
    DAY_LABELS,
    DEFAULT_POSITIONS, DEFAULT_SESSIONS, defaultStaffingPlan,
    uid, todayMonday, fmtDate, addDays, dayOfWeek,
    timeToMin, calcHours, timeOverlap, timeContains,
    buildSlots, newWeek, ensureWeek, listWeeks,
    loadState, saveState, resetState, seedState, migrate,
  };
})();
