// data.js v4 — multi-tenant 対応 + 複数週対応スキーマ
// state.weeks[YYYY-MM-DD] = { slots, preferences, assignments, status, publishedAt }
(function () {
  // tenant slug を含めて localStorage キーを分離 (Round 4 C3 修正: クロステナント汚染防止)
  // window.ShiftyAPI が読込済みでない場合は URL から推測
  const _tenantSlug = (() => {
    try {
      if (typeof location === "undefined") return "default";
      const m = location.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{2,30}[a-z0-9])\//);
      return m ? m[1] : "default";
    } catch (_) { return "default"; }
  })();
  const STORAGE_KEY = `shifty.v4.${_tenantSlug}`;
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
  // 注: 明示的に T00:00:00 を付与してローカル時刻として解釈 (TZ ずれ防止)
  // 注: 明示的に T00:00:00 を付与してローカル時刻として解釈 (TZ ずれ防止)
  function dayOfWeek(dateStr) { return new Date(dateStr + "T00:00:00").getDay(); }

  // 日本の祝日 (2026 年・主要のみ。CSV や API 連携は将来課題)
  // ref: 内閣府 https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
  const JP_HOLIDAYS = {
    "2026-01-01": "元日",
    "2026-01-12": "成人の日",
    "2026-02-11": "建国記念の日",
    "2026-02-23": "天皇誕生日",
    "2026-03-20": "春分の日",
    "2026-04-29": "昭和の日",
    "2026-05-03": "憲法記念日",
    "2026-05-04": "みどりの日",
    "2026-05-05": "こどもの日",
    "2026-05-06": "振替休日",
    "2026-07-20": "海の日",
    "2026-08-11": "山の日",
    "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日",
    "2026-09-23": "秋分の日",
    "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日",
    "2026-11-23": "勤労感謝の日",
    "2027-01-01": "元日",
    "2027-01-11": "成人の日",
    "2027-02-11": "建国記念の日",
    "2027-02-23": "天皇誕生日",
    "2027-03-21": "春分の日",
    "2027-03-22": "振替休日",
    "2027-04-29": "昭和の日",
    "2027-05-03": "憲法記念日",
    "2027-05-04": "みどりの日",
    "2027-05-05": "こどもの日",
    "2027-07-19": "海の日",
    "2027-08-11": "山の日",
    "2027-09-20": "敬老の日",
    "2027-09-23": "秋分の日",
    "2027-10-11": "スポーツの日",
    "2027-11-03": "文化の日",
    "2027-11-23": "勤労感謝の日",
  };

  function getHoliday(dateStr) { return JP_HOLIDAYS[dateStr] || null; }
  function isHoliday(dateStr) { return Boolean(JP_HOLIDAYS[dateStr]); }
  // 祝日扱いの曜日を返す (祝日 → 0 = 日曜と同じ、それ以外は素の getDay())
  function effectiveDayOfWeek(dateStr, meta) {
    const handling = (meta && meta.holidayHandling) || "as_sunday";
    if (handling === "ignore") return dayOfWeek(dateStr);
    if (isHoliday(dateStr)) return 0;
    return dayOfWeek(dateStr);
  }
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
      // 祝日対応: 設定により祝日を日曜扱い
      const dow = effectiveDayOfWeek(date, meta);
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

  // 直近に取得・保存した state version (楽観的ロック用)
  let _lastVersion = null;

  // ===== Storage =====
  async function loadState() {
    // 新規初期化時のシード関数を選択
    // デモモード or sample=1 クエリ → 10名スタッフのサンプル
    // 本番初回 → 空テナント
    const wantsSample =
      window.__SHIFTY_DEMO_MODE__ ||
      /[?&]sample=1\b/.test(location.search);
    const seedFn = wantsSample ? seedSampleData : seedState;

    try {
      const remote = await window.ShiftyAPI.getState();
      if (remote && remote.staff) {
        if (typeof remote._version === "number") _lastVersion = remote._version;
        return migrate(remote);
      }
    } catch (e) {
      // 401 などはここで再スロー（呼び出し側で auth 処理）
      if (String(e.message).includes("401") || String(e.message).includes("unauthenticated")) throw e;
      console.warn("API getState failed, falling back", e);
    }
    // デモモードでは localStorage の本番キーから読まない (クロス汚染防止)
    // tenant モードでも localStorage フォールバックは現 tenant スコープのみ
    if (!window.__SHIFTY_DEMO_MODE__) {
      try {
        // 旧キー (`shifty.v3`) からの読み込みは default tenant のみ (legacy 互換)
        const raw = _tenantSlug === "default"
          ? (localStorage.getItem(STORAGE_KEY)
            || localStorage.getItem("shifty.v3")
            || localStorage.getItem("shifty.v2")
            || localStorage.getItem("shifty.v1"))
          : localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = migrate(JSON.parse(raw));
          try { await window.ShiftyAPI.saveState(parsed); } catch (_) {}
          return parsed;
        }
      } catch (e) {
        console.warn("localStorage parse failed", e);
      }
    }
    const fresh = seedFn();
    try { await window.ShiftyAPI.saveState(fresh); } catch (_) {}
    return fresh;
  }

  async function saveState(state) {
    if (!window.__SHIFTY_DEMO_MODE__) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    }
    // 楽観的ロック: 直近取得した _version を含めて送信
    const stateForSend = _lastVersion !== null ? { ...state, _version: _lastVersion } : state;
    try {
      const r = await window.ShiftyAPI.saveState(stateForSend);
      if (r && typeof r.version === "number") _lastVersion = r.version;
    } catch (e) {
      if (String(e.message).includes("401") || String(e.message).includes("unauthenticated")) throw e;
      // 409 conflict: 他のタブが先に保存した場合
      if (String(e.message).includes("409") || String(e.message).includes("version_conflict")) {
        if (typeof window.toast === "function") {
          window.toast("⚠ 他のタブで変更がありました。リロードしてください", "error", 6000);
        } else {
          console.warn("Version conflict — reload required");
          if (confirm("他のタブで変更が保存されました。最新を取得するためにリロードしますか？")) {
            location.reload();
          }
        }
        throw e;
      }
      console.warn("API saveState failed (kept local backup)", e);
    }
  }

  async function resetState({ withSample } = {}) {
    try { await window.ShiftyAPI.resetServer(); } catch (_) {}
    const useSample = withSample === undefined
      ? (window.__SHIFTY_DEMO_MODE__ === true)
      : !!withSample;
    const fresh = useSample ? seedSampleData() : seedState();
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
    // 祝日扱い: as_sunday (デフォルト) | ignore (無視) | manual
    if (!state.meta.holidayHandling) state.meta.holidayHandling = "as_sunday";
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
  // デフォルトの新規テナントは「空っぽ」で起動。
  // サンプルデータ（10名スタッフ + 希望サンプル）を試したい場合は seedSampleData() を呼ぶ。
  function seedState() {
    const weekStart = fmtDate(todayMonday());
    const meta = {
      restaurantName: "（店舗名未設定）",
      weeklyBudget: 380000,
      currentWeekStart: weekStart,
      sessions: JSON.parse(JSON.stringify(DEFAULT_SESSIONS)),
      positions: JSON.parse(JSON.stringify(DEFAULT_POSITIONS)),
      staffingPlan: defaultStaffingPlan(),
      laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, maxHoursPerDay: 12, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 },
      createdAt: new Date().toISOString(),
    };
    return {
      meta, staff: [],
      weeks: {
        [weekStart]: {
          slots: buildSlots(meta, weekStart),
          preferences: [],
          assignments: [],
          status: "draft",
          publishedAt: null,
          changeLog: [],
        },
      },
    };
  }

  // サンプルデータ投入（オンボーディングで「サンプルで試す」を選んだ場合・demo モード）
  function seedSampleData() {
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
      isSampleData: true,
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
    loadState, saveState, resetState, seedState, seedSampleData, migrate,
    JP_HOLIDAYS, getHoliday, isHoliday, effectiveDayOfWeek,
  };
})();
