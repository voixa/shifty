// Node.js audit runner — loads algorithm.js + data.js without browser shim
// Usage: node tests/audit_runner.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Build a minimal `window` shim
const sandbox = {
  window: {},
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  Set,
  Map,
  Infinity,
};
sandbox.global = sandbox;
vm.createContext(sandbox);

function loadIIFE(p) {
  const src = fs.readFileSync(p, 'utf8');
  vm.runInContext(src, sandbox, { filename: p });
}

loadIIFE(path.join(__dirname, '..', 'js', 'data.js'));
loadIIFE(path.join(__dirname, '..', 'js', 'algorithm.js'));

const { ShiftyData, ShiftyAlgo } = sandbox.window;
const { addDays, calcHours, dayOfWeek } = ShiftyData;
const { generateShift } = ShiftyAlgo;

// =======================================================================
// Scenario builders
// =======================================================================
const WEEK_START = '2026-05-11'; // Monday

function buildSlots(weekStart, sessions, plan, positions) {
  const slots = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const dow = dayOfWeek(date);
    for (const sess of sessions) {
      const day = (plan[sess.id] || {})[dow] || {};
      for (const pos of positions) {
        const cnt = Number(day[pos.id]) || 0;
        if (cnt > 0) {
          slots.push({
            id: `sl_${date}_${sess.id}_${pos.id}`,
            date,
            position: pos.id,
            startTime: sess.startTime,
            endTime: sess.endTime,
            requiredCount: cnt,
          });
        }
      }
    }
  }
  return slots;
}

function makeStaff(id, name, position, opts = {}) {
  return {
    id,
    name,
    position,
    canCover: opts.canCover || [],
    hourlyWage: opts.hourlyWage || 1100,
    maxHoursPerWeek: opts.maxHoursPerWeek || 40,
    minHoursPerWeek: opts.minHoursPerWeek || 0,
    fixedDayOff: opts.fixedDayOff || [],
    skill: opts.skill || 3,
    notes: opts.notes || '',
    email: '',
  };
}

const POS_DEFAULT = [
  { id: 'manager', label: '店長' },
  { id: 'kitchen', label: 'キッチン' },
  { id: 'hall', label: 'ホール' },
  { id: 'cashier', label: 'レジ' },
];
const SESS_DEFAULT = [
  { id: 'lunch', label: 'ランチ', startTime: '11:00', endTime: '15:00' },
  { id: 'dinner', label: 'ディナー', startTime: '17:00', endTime: '22:00' },
];

// ----- Scenario A: 居酒屋 12 名・週2セッション -----
function scenarioA() {
  const staff = [
    makeStaff('s1', '中村 直樹 (店長)', 'manager', { hourlyWage: 1800, maxHoursPerWeek: 40, minHoursPerWeek: 35, fixedDayOff: [1], skill: 5, canCover: ['hall', 'kitchen'] }),
    makeStaff('s2', '佐藤 健 (調理長)', 'kitchen', { hourlyWage: 1300, maxHoursPerWeek: 40, minHoursPerWeek: 30, fixedDayOff: [2], skill: 5 }),
    makeStaff('s3', '田中 美咲', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 28, minHoursPerWeek: 15, fixedDayOff: [0], skill: 4, canCover: ['cashier'] }),
    makeStaff('s4', '鈴木 由美 (主婦)', 'hall', { hourlyWage: 1050, maxHoursPerWeek: 20, minHoursPerWeek: 8, fixedDayOff: [3, 4], skill: 3, canCover: ['cashier'] }),
    makeStaff('s5', '高橋 翔太 (大学生)', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 25, minHoursPerWeek: 10, fixedDayOff: [1], skill: 3, canCover: ['hall'] }),
    makeStaff('s6', '伊藤 さくら (高校生)', 'cashier', { hourlyWage: 1050, maxHoursPerWeek: 20, minHoursPerWeek: 8, fixedDayOff: [5, 6], skill: 3, canCover: ['hall'] }),
    makeStaff('s7', '渡辺 拓海', 'kitchen', { hourlyWage: 1150, maxHoursPerWeek: 30, minHoursPerWeek: 12, fixedDayOff: [0], skill: 4 }),
    makeStaff('s8', '山本 結衣', 'hall', { hourlyWage: 1200, maxHoursPerWeek: 32, minHoursPerWeek: 20, fixedDayOff: [4], skill: 5, canCover: ['cashier', 'kitchen'] }),
    makeStaff('s9', '小林 玲奈 (大学生)', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 24, minHoursPerWeek: 12, fixedDayOff: [2], skill: 3, canCover: ['cashier'] }),
    makeStaff('s10', '加藤 大輔 (フリーター)', 'kitchen', { hourlyWage: 1150, maxHoursPerWeek: 28, minHoursPerWeek: 15, fixedDayOff: [3], skill: 4, canCover: ['hall'] }),
    makeStaff('s11', '吉田 翼', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 25, minHoursPerWeek: 12, fixedDayOff: [6], skill: 3, canCover: ['cashier'] }),
    makeStaff('s12', '林 真央', 'cashier', { hourlyWage: 1100, maxHoursPerWeek: 20, minHoursPerWeek: 10, fixedDayOff: [0, 1], skill: 4, canCover: ['hall'] }),
  ];

  // 平日: lunch 4 / dinner 5、週末: lunch 5 / dinner 7
  const plan = { lunch: {}, dinner: {} };
  for (let d = 0; d < 7; d++) {
    const we = (d === 0 || d === 6);
    plan.lunch[d] = { manager: 1, kitchen: 1, hall: we ? 2 : 1, cashier: 1 };
    plan.dinner[d] = { manager: 1, kitchen: we ? 2 : 1, hall: we ? 3 : 2, cashier: 1 };
  }

  const slots = buildSlots(WEEK_START, SESS_DEFAULT, plan, POS_DEFAULT);

  // Preferences (希望)
  const preferences = [];
  function addPref(staffId, dayOffsets, sessId, priority) {
    for (const dOff of dayOffsets) {
      const date = addDays(WEEK_START, dOff);
      const sess = SESS_DEFAULT.find(s => s.id === sessId);
      preferences.push({ id: `p_${staffId}_${dOff}_${sessId}`, staffId, date, startTime: sess.startTime, endTime: sess.endTime, priority });
    }
  }
  addPref('s3', [1, 2, 3], 'lunch', 'want');
  addPref('s3', [5, 6], 'dinner', 'must');
  addPref('s4', [1, 2, 5, 6], 'lunch', 'want');
  addPref('s5', [2, 3, 4, 5, 6], 'dinner', 'want');
  addPref('s6', [0, 1, 2, 3], 'lunch', 'must');
  addPref('s11', [0, 1, 2, 3], 'dinner', 'want');
  // Avoid: 山本 hates Mondays dinner
  addPref('s8', [0], 'dinner', 'avoid');

  return {
    name: 'A: 居酒屋12名・週2セッション',
    staff,
    slots,
    preferences,
    laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, maxHoursPerDay: 12, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 },
  };
}

// ----- Scenario B: Cafe — 8人・モーニングのみ・学生中心 -----
function scenarioB() {
  const staff = [
    makeStaff('c1', 'オーナー', 'manager', { hourlyWage: 2000, maxHoursPerWeek: 40, minHoursPerWeek: 30, fixedDayOff: [1], skill: 5, canCover: ['hall', 'kitchen'] }),
    makeStaff('c2', '副店長', 'manager', { hourlyWage: 1500, maxHoursPerWeek: 30, minHoursPerWeek: 20, fixedDayOff: [3], skill: 4, canCover: ['hall'] }),
    makeStaff('c3', 'バリスタA', 'kitchen', { hourlyWage: 1200, maxHoursPerWeek: 20, minHoursPerWeek: 8, fixedDayOff: [2, 4], skill: 4 }),
    makeStaff('c4', 'バリスタB', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 18, minHoursPerWeek: 6, fixedDayOff: [1, 3, 5], skill: 3, canCover: ['hall'] }),
    makeStaff('c5', '学生A', 'hall', { hourlyWage: 1050, maxHoursPerWeek: 12, minHoursPerWeek: 4, fixedDayOff: [1, 2, 3], skill: 2, canCover: ['cashier'] }),
    makeStaff('c6', '学生B', 'hall', { hourlyWage: 1050, maxHoursPerWeek: 12, minHoursPerWeek: 4, fixedDayOff: [0, 1, 2, 3], skill: 2, canCover: ['cashier'] }),
    makeStaff('c7', '学生C', 'hall', { hourlyWage: 1050, maxHoursPerWeek: 16, minHoursPerWeek: 6, fixedDayOff: [4, 5], skill: 3, canCover: ['cashier'] }),
    makeStaff('c8', '学生D', 'cashier', { hourlyWage: 1050, maxHoursPerWeek: 14, minHoursPerWeek: 4, fixedDayOff: [0, 6], skill: 2, canCover: ['hall'] }),
  ];

  // モーニング+昼の1セッションのみ、ディナーなし
  const sessions = [{ id: 'morning', label: 'モーニング', startTime: '07:00', endTime: '14:00' }];
  const plan = { morning: {} };
  for (let d = 0; d < 7; d++) {
    plan.morning[d] = { manager: 1, kitchen: 1, hall: 2, cashier: 1 };
  }
  const slots = buildSlots(WEEK_START, sessions, plan, POS_DEFAULT);
  return {
    name: 'B: カフェ8名・モーニングのみ',
    staff,
    slots,
    preferences: [],
    laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, maxHoursPerDay: 12, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 },
  };
}

// ----- Scenario C: 25名・3セッション・大型店 -----
function scenarioC() {
  const staff = [];
  // 4人マネージャー
  for (let i = 0; i < 3; i++) {
    staff.push(makeStaff(`m${i}`, `店長${i + 1}`, 'manager', { hourlyWage: 1700 + i * 50, maxHoursPerWeek: 40, minHoursPerWeek: 32, fixedDayOff: [i], skill: 5, canCover: ['hall', 'kitchen'] }));
  }
  // 8人キッチン
  for (let i = 0; i < 8; i++) {
    staff.push(makeStaff(`k${i}`, `キッチン${i + 1}`, 'kitchen', { hourlyWage: 1100 + (i % 4) * 50, maxHoursPerWeek: 30 + (i % 3) * 5, minHoursPerWeek: 12, fixedDayOff: [(i % 7)], skill: 3 + (i % 3) }));
  }
  // 10人ホール
  for (let i = 0; i < 10; i++) {
    staff.push(makeStaff(`h${i}`, `ホール${i + 1}`, 'hall', { hourlyWage: 1050 + (i % 4) * 30, maxHoursPerWeek: 20 + (i % 3) * 8, minHoursPerWeek: 8, fixedDayOff: [(i + 2) % 7], skill: 3, canCover: i < 5 ? ['cashier'] : [] }));
  }
  // 4人レジ
  for (let i = 0; i < 4; i++) {
    staff.push(makeStaff(`r${i}`, `レジ${i + 1}`, 'cashier', { hourlyWage: 1050, maxHoursPerWeek: 24, minHoursPerWeek: 8, fixedDayOff: [(i + 5) % 7], skill: 3, canCover: ['hall'] }));
  }

  const sessions = [
    { id: 'morning', label: 'モーニング', startTime: '07:00', endTime: '11:00' },
    { id: 'lunch', label: 'ランチ', startTime: '11:00', endTime: '15:00' },
    { id: 'dinner', label: 'ディナー', startTime: '17:00', endTime: '23:00' },
  ];
  const plan = { morning: {}, lunch: {}, dinner: {} };
  for (let d = 0; d < 7; d++) {
    const we = (d === 0 || d === 6);
    plan.morning[d] = { manager: 1, kitchen: 1, hall: 2, cashier: 1 };
    plan.lunch[d] = { manager: 1, kitchen: 2, hall: we ? 4 : 3, cashier: 2 };
    plan.dinner[d] = { manager: 1, kitchen: we ? 3 : 2, hall: we ? 5 : 3, cashier: 2 };
  }
  const slots = buildSlots(WEEK_START, sessions, plan, POS_DEFAULT);
  return {
    name: 'C: 大型店25名・3セッション',
    staff,
    slots,
    preferences: [],
    laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 6, maxHoursPerDay: 10, minRestDaysPerWeek: 1 },
  };
}

// ----- Scenario D: 小ラーメン店 5名・オーナー過酷 -----
function scenarioD() {
  const staff = [
    makeStaff('r1', '大将', 'kitchen', { hourlyWage: 2000, maxHoursPerWeek: 60, minHoursPerWeek: 50, fixedDayOff: [1], skill: 5, canCover: ['hall', 'cashier', 'manager'] }),
    makeStaff('r2', '女将', 'hall', { hourlyWage: 1500, maxHoursPerWeek: 50, minHoursPerWeek: 40, fixedDayOff: [1], skill: 5, canCover: ['cashier', 'kitchen'] }),
    makeStaff('r3', 'バイトA', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 24, minHoursPerWeek: 12, fixedDayOff: [3, 4], skill: 3, canCover: ['hall'] }),
    makeStaff('r4', 'バイトB', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 24, minHoursPerWeek: 8, fixedDayOff: [2, 5], skill: 2, canCover: ['cashier'] }),
    makeStaff('r5', 'バイトC', 'hall', { hourlyWage: 1050, maxHoursPerWeek: 12, minHoursPerWeek: 4, fixedDayOff: [0, 1, 2, 3, 4], skill: 2, canCover: ['cashier', 'kitchen'] }),
  ];
  const sessions = SESS_DEFAULT;
  const plan = { lunch: {}, dinner: {} };
  for (let d = 0; d < 7; d++) {
    plan.lunch[d] = { kitchen: 1, hall: 1, cashier: 1 };
    plan.dinner[d] = { kitchen: 1, hall: 2, cashier: 1 };
  }
  // No manager required at this small shop
  const positions = POS_DEFAULT.filter(p => p.id !== 'manager');
  const slots = buildSlots(WEEK_START, sessions, plan, positions);

  // Conflict-heavy preferences: 全員土曜休みたい
  const preferences = [];
  function pref(staffId, dOff, sessId, priority) {
    const sess = sessions.find(x => x.id === sessId);
    preferences.push({
      id: `p_${staffId}_${dOff}_${sessId}`,
      staffId, date: addDays(WEEK_START, dOff),
      startTime: sess.startTime, endTime: sess.endTime, priority,
    });
  }
  // 全バイトが日曜日のディナーをavoid
  pref('r3', 6, 'dinner', 'avoid');
  pref('r4', 6, 'dinner', 'avoid');
  pref('r5', 6, 'dinner', 'avoid');
  // 大将は週6営業希望
  pref('r1', 0, 'dinner', 'must');
  pref('r1', 5, 'dinner', 'must');
  pref('r1', 6, 'dinner', 'must');

  return {
    name: 'D: 小ラーメン店5名・対立希望',
    staff,
    slots,
    preferences,
    laborRules: { maxHoursPerWeek: 60, maxConsecutiveDays: 6, maxHoursPerDay: 12, minRestDaysPerWeek: 1 },
  };
}

// ----- Scenario E: 新店・データなし -----
function scenarioE() {
  const staff = [
    makeStaff('n1', '新人A', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n2', '新人B', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n3', '新人C', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n4', '新人D', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n5', '新人E', 'cashier', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n6', '新人F', 'manager', { hourlyWage: 1500, maxHoursPerWeek: 40, minHoursPerWeek: 0, fixedDayOff: [], skill: 2 }),
    makeStaff('n7', '新人G', 'hall', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
    makeStaff('n8', '新人H', 'kitchen', { hourlyWage: 1100, maxHoursPerWeek: 30, minHoursPerWeek: 0, fixedDayOff: [], skill: 1 }),
  ];
  const plan = { lunch: {}, dinner: {} };
  for (let d = 0; d < 7; d++) {
    plan.lunch[d] = { manager: 1, kitchen: 1, hall: 1, cashier: 1 };
    plan.dinner[d] = { manager: 1, kitchen: 1, hall: 2, cashier: 1 };
  }
  const slots = buildSlots(WEEK_START, SESS_DEFAULT, plan, POS_DEFAULT);
  return {
    name: 'E: 新店8名・希望なし',
    staff,
    slots,
    preferences: [],
    laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, maxHoursPerDay: 12, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 },
  };
}

// =======================================================================
// Run + score
// =======================================================================
function smellTest(result, scenario) {
  const m = result.metrics;
  const issues = [];

  if (m.coverageRate < 0.95) issues.push(`カバー率 ${(m.coverageRate * 100).toFixed(1)}% (95%未満)`);
  if (m.fairness.cv > 0.5) issues.push(`不公平度CV=${m.fairness.cv.toFixed(2)} (>0.5は偏り強)`);
  if (m.avoidViolations > 0) issues.push(`回避希望違反 ${m.avoidViolations}件`);
  if (result.audit.hardViolations.length > 0) issues.push(`ハード制約違反 ${result.audit.hardViolations.length}件`);
  if (m.fairness.overMaxCount > 0) issues.push(`maxHoursPerWeek超過スタッフ ${m.fairness.overMaxCount}名`);

  // 連勤チェック (post-condition)
  for (const s of scenario.staff) {
    const dates = [...new Set(result.assignments.filter(a => a.staffId === s.id).map(a => a.date))].sort();
    let max = 0, cur = 0, prev = null;
    for (const d of dates) {
      if (prev && (new Date(d) - new Date(prev)) / 86400000 === 1) cur++;
      else cur = 1;
      max = Math.max(max, cur);
      prev = d;
    }
    if (max > scenario.laborRules.maxConsecutiveDays) issues.push(`${s.name}: ${max}連勤 (上限${scenario.laborRules.maxConsecutiveDays})`);
  }

  // 最低時間達成率
  const minMet = m.fairness.minMetRate;
  if (minMet < 0.7) issues.push(`最低契約時間達成率 ${(minMet * 100).toFixed(0)}% (<70%)`);

  return issues;
}

function runScenario(scenario) {
  console.log('\n========================================================');
  console.log('Scenario:', scenario.name);
  console.log(`  staff=${scenario.staff.length}, slots=${scenario.slots.length}, totalRequired=${scenario.slots.reduce((s, x) => s + x.requiredCount, 0)}, prefs=${scenario.preferences.length}`);
  const t0 = Date.now();
  const result = generateShift({
    staff: scenario.staff,
    slots: scenario.slots,
    preferences: scenario.preferences,
    laborRules: scenario.laborRules,
    randomStarts: 5,
  });
  const elapsed = Date.now() - t0;
  const m = result.metrics;
  console.log(`  Elapsed: ${elapsed}ms`);
  console.log(`  Coverage: ${(m.coverageRate * 100).toFixed(1)}%  (${m.filled}/${m.totalSlots})`);
  console.log(`  Pref Sat: ${(m.preferenceSatisfaction * 100).toFixed(1)}%  (${m.preferenceHit}/${m.preferenceTotal})`);
  console.log(`  Avoid violations: ${m.avoidViolations}`);
  console.log(`  Total cost: ¥${m.totalCost.toLocaleString()}`);
  console.log(`  Fairness: mean=${m.fairness.mean.toFixed(1)}h, std=${m.fairness.std.toFixed(1)}, CV=${m.fairness.cv.toFixed(2)}, minMet=${(m.fairness.minMetRate * 100).toFixed(0)}%`);
  console.log(`  Hard violations: ${result.audit.hardViolations.length}`);
  console.log(`  Unfilled: ${result.unfilled.length}`);
  if (result.unfilled.length > 0) {
    const sample = result.unfilled.slice(0, 4).map(u => `${u.date}/${u.position}/${u.startTime}`).join(', ');
    console.log(`    例: ${sample}`);
  }
  // perStaff time table
  console.log('  Per staff:');
  for (const ps of m.perStaff) {
    const flag = ps.overMax ? '⚠超過' : (ps.meetsMin ? '✓' : '✗未達');
    console.log(`    ${ps.name.padEnd(20)} ${ps.hours.toFixed(1)}h (¥${ps.cost.toLocaleString()})  ${flag}`);
  }
  const smell = smellTest(result, scenario);
  console.log('  Smell test:');
  if (smell.length === 0) console.log('    ✅ 問題なし');
  else smell.forEach(s => console.log(`    ⚠ ${s}`));
  return { scenario: scenario.name, elapsed, metrics: m, audit: result.audit, unfilled: result.unfilled, smell };
}

const scenarios = [scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE()];
const results = scenarios.map(runScenario);

// Reproducibility
console.log('\n\n=== Reproducibility check (Scenario A run twice) ===');
const r1 = generateShift({ staff: scenarios[0].staff, slots: scenarios[0].slots, preferences: scenarios[0].preferences, laborRules: scenarios[0].laborRules, randomStarts: 5 });
const r2 = generateShift({ staff: scenarios[0].staff, slots: scenarios[0].slots, preferences: scenarios[0].preferences, laborRules: scenarios[0].laborRules, randomStarts: 5 });
const sig = r => r.assignments.map(a => `${a.date}|${a.position}|${a.startTime}|${a.staffId}`).sort().join('\n');
console.log('Same result:', sig(r1) === sig(r2));
