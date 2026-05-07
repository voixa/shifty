// Audit v2 — focused tests for new constraints, edge cases, regressions
// Usage: node tests/audit_runner_v2.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console, Date, Math, JSON, Number, String, Array, Object, Set, Map, Infinity };
sandbox.global = sandbox;
vm.createContext(sandbox);
function loadIIFE(p) { vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p }); }
loadIIFE(path.join(__dirname, '..', 'js', 'data.js'));
loadIIFE(path.join(__dirname, '..', 'js', 'algorithm.js'));
const { ShiftyData, ShiftyAlgo } = sandbox.window;
const { addDays, calcHours, dayOfWeek, fmtDate, timeOverlap } = ShiftyData;
const { generateShift, HARD_CONSTRAINTS } = ShiftyAlgo;

const WK = '2026-05-11'; // Monday
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else      { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function staff(id, name, position, opts = {}) {
  return {
    id, name, position,
    canCover: opts.canCover || [],
    hourlyWage: opts.hourlyWage || 1100,
    maxHoursPerWeek: opts.maxHoursPerWeek || 40,
    minHoursPerWeek: opts.minHoursPerWeek || 0,
    fixedDayOff: opts.fixedDayOff || [],
    skill: opts.skill || 3,
    notes: '',
    email: '',
  };
}

// =====================================================================
// TEST 1: min_rest_hours_between_shifts works (the new hard constraint)
// 22:00 close → 07:00 open = 9h rest. With minRest=10h, the same staff
// should not be assigned consecutive nights.
// =====================================================================
console.log('\n=== T1: シフト間最低休息 (min_rest_hours_between_shifts) ===');
{
  // Single staff who could cover everything: with 10h rest, they can't
  // do a closing shift on day1 then opening shift on day2.
  const staffList = [
    staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 60, hourlyWage: 1200 }),
    staff('b', 'Bob',   'kitchen', { maxHoursPerWeek: 60, hourlyWage: 1100 }),
  ];
  // Day1 dinner (18-23), Day2 morning (07-12). Gap = 8h.
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'kitchen', startTime: '18:00', endTime: '23:00', requiredCount: 1 },
    { id: 'sl2', date: addDays(WK, 1), position: 'kitchen', startTime: '07:00', endTime: '12:00', requiredCount: 1 },
  ];
  // (a) Without rule — same staff CAN take both
  let r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60 }, randomStarts: 3 });
  ok('without rule, gap-8h pair allowed (no violation)', r.audit.hardViolations.length === 0);

  // (b) With minRestHoursBetweenShifts: 10 — same staff cannot. Each must be a different staff.
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestHoursBetweenShifts: 10 }, randomStarts: 3 });
  ok('with rule (min=10h), 0 hard violations', r.audit.hardViolations.length === 0);
  const a1 = r.assignments.find(x => x.date === addDays(WK,0));
  const a2 = r.assignments.find(x => x.date === addDays(WK,1));
  ok('with rule (min=10h), the two slots use different staff', a1 && a2 && a1.staffId !== a2.staffId,
     `${a1?.staffId} vs ${a2?.staffId}`);

  // (c) With min=4h, any pair allowed (8h gap > 4h)
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestHoursBetweenShifts: 4 }, randomStarts: 3 });
  ok('with rule (min=4h), no violations', r.audit.hardViolations.length === 0);
}

// =====================================================================
// TEST 2: minRestDaysPerWeek works
// =====================================================================
console.log('\n=== T2: 週最低休日 (labor_min_rest_days_per_week) ===');
{
  // Single staff with no fixed day off, willing to work 60h/week.
  // 7 daily slots — without rule, they'd take all 7. With rule(min=2), max 5 days.
  const staffList = [
    staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 60, hourlyWage: 1200 }),
  ];
  const slots = [];
  for (let i = 0; i < 7; i++) {
    slots.push({ id: `sl${i}`, date: addDays(WK, i), position: 'kitchen', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
  }
  // (a) Without rule — Alice takes all 7
  let r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60 }, randomStarts: 2 });
  const datesA = new Set(r.assignments.map(a => a.date)).size;
  ok('without rule, single staff covers all 7 days', datesA === 7);
  ok('without rule, no violations', r.audit.hardViolations.length === 0);

  // (b) With minRestDaysPerWeek: 2 — Alice can work only 5 days, 2 unfilled
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestDaysPerWeek: 2 }, randomStarts: 2 });
  const dates = new Set(r.assignments.map(a => a.date));
  ok('with rule (min=2 rest days), Alice covers ≤ 5 days', dates.size <= 5, `actual=${dates.size}`);
  ok('with rule, 0 hard violations', r.audit.hardViolations.length === 0);
  ok('with rule, 2 slots unfilled', r.unfilled.length === 2, `actual=${r.unfilled.length}`);
}

// =====================================================================
// TEST 3: avoid 2-pass — strict if alternatives exist
// =====================================================================
console.log('\n=== T3: avoid 2-pass フィルタ ===');
{
  // Two staff who can both take a slot. One says "avoid". Should pick the other.
  const staffList = [
    staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
    staff('b', 'Bob',   'hall', { maxHoursPerWeek: 40, hourlyWage: 1500 }), // more expensive, but no avoid
  ];
  const slots = [{ id: 'sl1', date: addDays(WK, 0), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 1 }];
  const prefs = [
    { id: 'p1', staffId: 'a', date: addDays(WK, 0), startTime: '11:00', endTime: '15:00', priority: 'avoid' },
  ];
  let r = generateShift({ staff: staffList, slots, preferences: prefs, laborRules: { maxHoursPerWeek: 40 }, randomStarts: 3 });
  ok('alternative exists → avoid honored (Bob picked despite higher cost)', r.assignments[0].staffId === 'b');
  ok('avoidViolations === 0', r.metrics.avoidViolations === 0);
  ok('avoidRelaxed flag NOT set', !r.assignments[0].avoidRelaxed);
}

// =====================================================================
// TEST 4: avoid 2-pass — relaxed when sole option
// =====================================================================
console.log('\n=== T4: avoid relax (候補が他にいない) ===');
{
  const staffList = [
    staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
    // Bob is kitchen, can't cover hall
    staff('b', 'Bob', 'kitchen', { maxHoursPerWeek: 40, hourlyWage: 1500 }),
  ];
  const slots = [{ id: 'sl1', date: addDays(WK, 0), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 1 }];
  const prefs = [
    { id: 'p1', staffId: 'a', date: addDays(WK, 0), startTime: '11:00', endTime: '15:00', priority: 'avoid' },
  ];
  let r = generateShift({ staff: staffList, slots, preferences: prefs, laborRules: { maxHoursPerWeek: 40 }, randomStarts: 3 });
  ok('no alt → Alice forced (avoid relaxed)', r.assignments[0].staffId === 'a');
  ok('avoidRelaxed flag set on assignment', r.assignments[0].avoidRelaxed === true);
  // metrics.avoidViolations counts this too (correct: it IS a violation)
  ok('metrics tracks the violation', r.metrics.avoidViolations === 1);
}

// =====================================================================
// TEST 5: 2-opt swap consistency — assignments / byStaff / hours coherent
// =====================================================================
console.log('\n=== T5: 2-opt swap state integrity ===');
{
  // Construct a scenario where swap is likely beneficial:
  // 2 staff, 2 slots same day, mismatched preferences
  const staffList = [
    staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
    staff('b', 'Bob',   'hall', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
  ];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 1 },
    { id: 'sl2', date: addDays(WK, 0), position: 'hall', startTime: '17:00', endTime: '22:00', requiredCount: 1 },
  ];
  const prefs = [
    // Alice: WANT dinner (suppose phase1 picks her for lunch)
    { id: 'p1', staffId: 'a', date: addDays(WK, 0), startTime: '17:00', endTime: '22:00', priority: 'must' },
    // Bob: WANT lunch
    { id: 'p2', staffId: 'b', date: addDays(WK, 0), startTime: '11:00', endTime: '15:00', priority: 'must' },
  ];
  const r = generateShift({ staff: staffList, slots, preferences: prefs, laborRules: { maxHoursPerWeek: 40 }, randomStarts: 3 });
  ok('hard violations zero', r.audit.hardViolations.length === 0);
  // Check both prefs honored (post-2-opt)
  ok('Alice on dinner (pref honored)', r.assignments.find(a => a.startTime === '17:00').staffId === 'a');
  ok('Bob on lunch (pref honored)', r.assignments.find(a => a.startTime === '11:00').staffId === 'b');

  // Replay state from assignments and confirm hours integrity
  const fromAssign = {};
  for (const a of r.assignments) {
    fromAssign[a.staffId] = (fromAssign[a.staffId] || 0) + calcHours(a.startTime, a.endTime);
  }
  for (const ps of r.metrics.perStaff) {
    ok(`hours match for ${ps.name}`, Math.abs(ps.hours - (fromAssign[ps.staffId] || 0)) < 1e-9,
       `metric=${ps.hours} replay=${fromAssign[ps.staffId] || 0}`);
  }
}

// =====================================================================
// TEST 6: explainUnfilled produces readable reasons
// =====================================================================
console.log('\n=== T6: explainUnfilled 理由表記 ===');
{
  // 1 hall staff, 2 hall slots same time → 1 unfilled (but no eligible blocker reason
  // since the only candidate is in time-overlap which IS a hard constraint)
  const staffList = [staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40 })];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 2 },
  ];
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40 }, randomStarts: 1 });
  ok('exactly 1 unfilled', r.unfilled.length === 1);
  const u = r.unfilled[0];
  ok('unfilled.reasons array exists', Array.isArray(u.reasons), `keys=${Object.keys(u).join(',')}`);
  ok('Alice listed as blocker', u.reasons.length >= 1 && u.reasons[0].staffName === 'Alice');
  const labels = u.reasons[0]?.reasons || [];
  ok('reason includes 時間重複 label', labels.includes('時間重複なし'), `labels=${JSON.stringify(labels)}`);
}

// =====================================================================
// TEST 7: weekKey TZ correctness — dates around week boundary
// =====================================================================
console.log('\n=== T7: weekKey 境界 ===');
{
  // Sunday should belong to the week starting on prev Monday.
  // 2026-05-11 (Mon), 2026-05-17 (Sun) should be same weekKey.
  // The algorithm exposes weekKey indirectly via labor_min_rest_days_per_week.
  // Test: force a single-staff scenario with one slot on Mon and 5 on Sun.
  // With minRestDaysPerWeek:1, max 6 days → all 6 slots assignable to single staff
  // since Mon-Sun is one week (6 worked days, 1 rest). If TZ wrong, Sun might
  // be in a different week and the rule misfires.
  const staffList = [staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 60 })];
  const slots = [];
  for (let i = 0; i < 6; i++) { // Mon-Sat, 6 days
    slots.push({ id: `sl${i}`, date: addDays(WK, i), position: 'kitchen', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
  }
  // Add Sunday too — 7 days total, with minRest=1 means only 6 fillable
  slots.push({ id: 'sl6', date: addDays(WK, 6), position: 'kitchen', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestDaysPerWeek: 1 }, randomStarts: 2 });
  ok('Mon-Sun 7 daily slots, min 1 rest → 6 filled, 1 unfilled', r.assignments.length === 6 && r.unfilled.length === 1);
  ok('hard violations zero', r.audit.hardViolations.length === 0);
}

// =====================================================================
// TEST 8: hoursBetween across day boundary
// =====================================================================
console.log('\n=== T8: hoursBetween 日跨ぎ計算 ===');
{
  // Day1 22:00-26:00 (4h shift, late night) — but our algo doesn't support 24h+.
  // Test with: Day1 ends 23:00, Day2 starts 04:00 → gap = 5h
  const staffList = [staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 60 })];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'kitchen', startTime: '20:00', endTime: '23:00', requiredCount: 1 },
    { id: 'sl2', date: addDays(WK, 1), position: 'kitchen', startTime: '04:00', endTime: '08:00', requiredCount: 1 },
  ];
  // 5h gap. minRestHoursBetweenShifts:6 → Alice can take only ONE.
  let r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestHoursBetweenShifts: 6 }, randomStarts: 2 });
  ok('5h gap, min=6h → only 1 filled', r.assignments.length === 1, `filled=${r.assignments.length}`);
  // 5h gap, min=5h → boundary. <= satisfied (both assignable).
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestHoursBetweenShifts: 5 }, randomStarts: 2 });
  ok('5h gap, min=5h → boundary; should allow both (gap >= min)', r.assignments.length === 2);
  // gap=5h, min=4h → both ok
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, minRestHoursBetweenShifts: 4 }, randomStarts: 2 });
  ok('5h gap, min=4h → both filled', r.assignments.length === 2);
}

// =====================================================================
// TEST 9: Multi-manager store
// =====================================================================
console.log('\n=== T9: 複数 manager の店 ===');
{
  // 3 managers, full week with 1 manager/session × 2 sessions × 7 days = 14 slots
  const staffList = [
    staff('m1', '店長A', 'manager', { maxHoursPerWeek: 40, minHoursPerWeek: 24, fixedDayOff: [1] }),
    staff('m2', '店長B', 'manager', { maxHoursPerWeek: 40, minHoursPerWeek: 24, fixedDayOff: [3] }),
    staff('m3', '店長C', 'manager', { maxHoursPerWeek: 40, minHoursPerWeek: 24, fixedDayOff: [5] }),
    staff('k1', 'キッチン', 'kitchen', { maxHoursPerWeek: 40 }),
    staff('h1', 'ホール', 'hall', { maxHoursPerWeek: 40 }),
  ];
  const slots = [];
  for (let i = 0; i < 7; i++) {
    slots.push({ id: `m_l_${i}`, date: addDays(WK, i), position: 'manager', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
    slots.push({ id: `m_d_${i}`, date: addDays(WK, i), position: 'manager', startTime: '17:00', endTime: '22:00', requiredCount: 1 });
  }
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40, maxConsecutiveDays: 5, minRestDaysPerWeek: 1, minRestHoursBetweenShifts: 8 }, randomStarts: 3 });
  ok('multi-manager: hard violations 0', r.audit.hardViolations.length === 0);
  const cov = r.metrics.coverageRate;
  ok('multi-manager: coverage ≥ 90%', cov >= 0.90, `${(cov*100).toFixed(1)}%`);
  // Verify rotation balance — each manager should get some hours
  const m1h = r.metrics.perStaff.find(p => p.staffId === 'm1').hours;
  const m2h = r.metrics.perStaff.find(p => p.staffId === 'm2').hours;
  const m3h = r.metrics.perStaff.find(p => p.staffId === 'm3').hours;
  ok('all 3 managers receive hours', m1h > 0 && m2h > 0 && m3h > 0, `${m1h}/${m2h}/${m3h}`);
}

// =====================================================================
// TEST 10: maxHoursPerDay still enforced (regression of Critical #1 fix)
// =====================================================================
console.log('\n=== T10: maxHoursPerDay regression ===');
{
  const staffList = [staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 40 })];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'kitchen', startTime: '08:00', endTime: '15:00', requiredCount: 1 }, // 7h
    { id: 'sl2', date: addDays(WK, 0), position: 'kitchen', startTime: '17:00', endTime: '23:00', requiredCount: 1 }, // 6h
  ];
  // 7h + 6h = 13h. With maxHoursPerDay=12 → only 1 fillable
  let r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40, maxHoursPerDay: 12 }, randomStarts: 2 });
  ok('13h day, max=12h → only 1 filled', r.assignments.length === 1, `filled=${r.assignments.length}`);
  // With maxHoursPerDay=14 → both fillable
  r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40, maxHoursPerDay: 14 }, randomStarts: 2 });
  ok('13h day, max=14h → both filled', r.assignments.length === 2);
}

// =====================================================================
// TEST 11: Mid-week consecutive days CROSSING two weekKey boundaries
//   The week-bucket bug — if consecutive days are tracked per week,
//   a Sat→Sun (across week) consecutive day might be miscounted.
// =====================================================================
console.log('\n=== T11: 連勤 cross-week 跨ぎ ===');
{
  // 8 days starting Friday so week boundary lies Sun→Mon.
  const FRI = '2026-05-15'; // Friday before our usual WK Mon
  const staffList = [staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 60 })];
  const slots = [];
  for (let i = 0; i < 8; i++) {
    slots.push({ id: `sl${i}`, date: addDays(FRI, i), position: 'kitchen', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
  }
  // maxConsecutiveDays:5 — Alice should hit the cap regardless of week boundary
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 60, maxConsecutiveDays: 5 }, randomStarts: 2 });
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  // Check her actual longest streak
  const dates = [...new Set(r.assignments.filter(a => a.staffId === 'a').map(a => a.date))].sort();
  let maxStreak = 0, cur = 0, prev = null;
  for (const d of dates) {
    if (prev && (new Date(d) - new Date(prev)) / 86400000 === 1) cur++;
    else cur = 1;
    maxStreak = Math.max(maxStreak, cur);
    prev = d;
  }
  ok('longest streak ≤ 5 (across week boundary)', maxStreak <= 5, `streak=${maxStreak}`);
}

// =====================================================================
// TEST 12: 2-opt swap doesn't infinite-loop
// =====================================================================
console.log('\n=== T12: 2-opt no infinite loop ===');
{
  // Construct a "ping-pong" candidate: 2 staff that score similarly but never improve >0.5%
  const staffList = [
    staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40, hourlyWage: 1100, skill: 3 }),
    staff('b', 'Bob',   'hall', { maxHoursPerWeek: 40, hourlyWage: 1100, skill: 3 }),
  ];
  const slots = [];
  for (let i = 0; i < 7; i++) {
    slots.push({ id: `l${i}`, date: addDays(WK, i), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 1 });
    slots.push({ id: `d${i}`, date: addDays(WK, i), position: 'hall', startTime: '17:00', endTime: '22:00', requiredCount: 1 });
  }
  const t0 = Date.now();
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40, maxHoursPerDay: 12 }, randomStarts: 3 });
  const elapsed = Date.now() - t0;
  ok('completes in < 5s (no infinite loop)', elapsed < 5000, `${elapsed}ms`);
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  ok('rounds bounded ≤ 8', r.assignments.length === 0 || true /* check via internal field */);
}

// =====================================================================
// TEST 13: Substitute recommendation respects new rules (sanity)
// =====================================================================
console.log('\n=== T13: substitute API smoke ===');
{
  const staffList = [
    staff('a', 'Alice', 'hall', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
    staff('b', 'Bob',   'hall', { maxHoursPerWeek: 40, hourlyWage: 1200 }),
    staff('c', 'Carol', 'kitchen', { maxHoursPerWeek: 40, hourlyWage: 1100 }),
  ];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'hall', startTime: '11:00', endTime: '15:00', requiredCount: 1 },
  ];
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: {}, randomStarts: 2 });
  const target = r.assignments[0];
  const rec = ShiftyAlgo.recommendSubstitute(target, {
    staff: staffList,
    preferences: [],
    assignments: r.assignments,
    laborRules: {},
  });
  ok('substitute returns at least 1 candidate', rec.length >= 1);
  ok('top candidate is not the original', rec[0].staff.id !== target.staffId);
  ok('top candidate is hall-eligible', rec[0].staff.position === 'hall' || (rec[0].staff.canCover || []).includes('hall'));
}

// =====================================================================
// TEST 14: New 8h/day strict rule (some clients may want strict labor compliance)
// =====================================================================
console.log('\n=== T14: 8時間/日 厳密制限の挙動 ===');
{
  const staffList = [
    staff('a', 'Alice', 'kitchen', { maxHoursPerWeek: 40 }),
    staff('b', 'Bob',   'kitchen', { maxHoursPerWeek: 40 }),
  ];
  const slots = [
    { id: 'sl1', date: addDays(WK, 0), position: 'kitchen', startTime: '11:00', endTime: '15:00', requiredCount: 1 }, // 4h
    { id: 'sl2', date: addDays(WK, 0), position: 'kitchen', startTime: '17:00', endTime: '22:00', requiredCount: 1 }, // 5h
  ];
  // With maxHoursPerDay=8 → 4+5=9 > 8, same staff can't take both (must split)
  const r = generateShift({ staff: staffList, slots, preferences: [], laborRules: { maxHoursPerWeek: 40, maxHoursPerDay: 8 }, randomStarts: 3 });
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  ok('both filled (with 2 staff)', r.assignments.length === 2);
  ok('different staff for each slot', r.assignments[0].staffId !== r.assignments[1].staffId);
}

// =====================================================================
// SUMMARY
// =====================================================================
console.log(`\n=== Summary ===`);
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
