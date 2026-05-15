// Audit v3 — Round 3 new edge cases (avoid+must conflict, swap solves avoid, all-day manager)
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const sandbox = { window: {}, console, Date, Math, JSON, Number, String, Array, Object, Set, Map, Infinity };
sandbox.global = sandbox; vm.createContext(sandbox);
function load(p){ vm.runInContext(fs.readFileSync(p,'utf8'), sandbox, {filename:p}); }
load(path.join(__dirname,'..','js','data.js'));
load(path.join(__dirname,'..','js','algorithm.js'));
const { ShiftyData, ShiftyAlgo } = sandbox.window;
const { addDays, calcHours, dayOfWeek } = ShiftyData;
const { generateShift } = ShiftyAlgo;

const WK='2026-05-11';
let pass=0, fail=0;
function ok(name,cond,detail){
  if(cond){pass++;console.log(`  PASS  ${name}${detail?' — '+detail:''}`);}
  else{fail++;console.log(`  FAIL  ${name}${detail?' — '+detail:''}`);}
}
function staff(id,n,p,o={}){return{id,name:n,position:p,canCover:o.canCover||[],hourlyWage:o.hourlyWage||1100,maxHoursPerWeek:o.maxHoursPerWeek||40,minHoursPerWeek:o.minHoursPerWeek||0,fixedDayOff:o.fixedDayOff||[],skill:o.skill||3,notes:'',email:''};}

// =====================================================================
// T15: avoid + must conflict on same staff/slot
// What happens if Alice has BOTH must and avoid on the same date+time?
// Should prefer the more specific intent. Current code: findPreference returns
// first matching pref via .find(), order is array order.
// =====================================================================
console.log('\n=== T15: avoid と must が衝突 (同スタッフ・同枠) ===');
{
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40}),
    staff('b','Bob','hall',{maxHoursPerWeek:40,hourlyWage:1500}),
  ];
  const slots=[{id:'sl1',date:addDays(WK,0),position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:1}];
  // Alice submits BOTH must and avoid on same slot (UI bug or contradictory input)
  const prefs=[
    {id:'p1',staffId:'a',date:addDays(WK,0),startTime:'11:00',endTime:'15:00',priority:'must'},
    {id:'p2',staffId:'a',date:addDays(WK,0),startTime:'11:00',endTime:'15:00',priority:'avoid'},
  ];
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3});
  ok('still produces a valid result (no crash)', r.assignments.length === 1);
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  // Document actual behavior: which one wins?
  const picked = r.assignments[0].staffId;
  console.log(`    NOTE: picked = ${picked}. avoid+must on same staff = ambiguous`);
}

// =====================================================================
// T16: Phase 2 swap actively resolves an avoid violation
// Phase 1 assigns Alice to her avoid slot; Phase 2 should swap with Bob.
// =====================================================================
console.log('\n=== T16: Phase 2 swap が avoid 違反を解消する ===');
{
  // Setup: Alice avoids dinner. Bob has no preference.
  // Lunch must go to one of them.
  // If Phase 1 picks Alice for dinner first (due to scoring), Phase 2 should swap.
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40,hourlyWage:1100,skill:5}),
    staff('b','Bob','hall',{maxHoursPerWeek:40,hourlyWage:1500,skill:3}),
  ];
  const slots = [
    {id:'l',date:addDays(WK,0),position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:1},
    {id:'d',date:addDays(WK,0),position:'hall',startTime:'17:00',endTime:'22:00',requiredCount:1},
  ];
  const prefs = [
    {id:'p1',staffId:'a',date:addDays(WK,0),startTime:'17:00',endTime:'22:00',priority:'avoid'},
  ];
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3});
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  ok('avoid violations 0 (resolved by 2-pass or swap)', r.metrics.avoidViolations === 0);
  // Alice on lunch, Bob on dinner
  const lunchA = r.assignments.find(a => a.startTime === '11:00');
  const dinA   = r.assignments.find(a => a.startTime === '17:00');
  ok('Alice on lunch (not avoid)', lunchA?.staffId === 'a');
  ok('Bob on dinner (avoid honored for Alice)', dinA?.staffId === 'b');
}

// =====================================================================
// T17: 通し勤務 (same-day double shift) for one manager
// =====================================================================
console.log('\n=== T17: 同日通し勤務 (店長一人, 朝→夜) ===');
{
  const staffList = [
    staff('m','店長','manager',{maxHoursPerWeek:60,hourlyWage:2000,skill:5}),
    staff('h','ホール','hall',{maxHoursPerWeek:40}),
  ];
  // Same day, lunch (4h) + dinner (5h) = 9h, gap=2h
  const slots = [
    {id:'l',date:addDays(WK,0),position:'manager',startTime:'11:00',endTime:'15:00',requiredCount:1},
    {id:'d',date:addDays(WK,0),position:'manager',startTime:'17:00',endTime:'22:00',requiredCount:1},
  ];
  // No minRestHoursBetweenShifts, maxHoursPerDay=12 → 9h ok
  let r = generateShift({staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:60,maxHoursPerDay:12},randomStarts:3});
  ok('no rest interval rule, 9h day → both filled by manager', r.assignments.length === 2 && r.assignments.every(a => a.staffId === 'm'));
  // With minRestHoursBetweenShifts:3 → gap=2h < 3h, should not allow (different staff or unfilled)
  // But there's no other manager; both slots must remain unfilled OR done by 1 person if rule violated.
  // Since min_rest_hours_between_shifts excludes same-day pairs (line 108), same-day double shift IS allowed.
  r = generateShift({staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:60,maxHoursPerDay:12,minRestHoursBetweenShifts:3},randomStarts:3});
  console.log(`    NOTE: same-day rule excluded; manager doubles. filled=${r.assignments.length}`);
  ok('same-day double allowed despite gap=2h (rule exempts same-day)', r.assignments.length === 2);
}

// =====================================================================
// T18: All staff submit avoid for same slot — what happens?
// =====================================================================
console.log('\n=== T18: 全員が avoid (strictAvoid デフォルトでは slot 未充足) ===');
{
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40}),
    staff('b','Bob','hall',{maxHoursPerWeek:40}),
    staff('c','Carol','hall',{maxHoursPerWeek:40}),
  ];
  const slots=[{id:'sl1',date:addDays(WK,0),position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:1}];
  const prefs=[
    {id:'p1',staffId:'a',date:addDays(WK,0),startTime:'11:00',endTime:'15:00',priority:'avoid'},
    {id:'p2',staffId:'b',date:addDays(WK,0),startTime:'11:00',endTime:'15:00',priority:'avoid'},
    {id:'p3',staffId:'c',date:addDays(WK,0),startTime:'11:00',endTime:'15:00',priority:'avoid'},
  ];
  // strictAvoid デフォルト (true): 全員 avoid なら slot は unfilled
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3});
  ok('strictAvoid: slot 未充足', r.assignments.length === 0);
  ok('strictAvoid: unfilled に記録', r.unfilled.length === 1);
  ok('strictAvoid: avoidViolations === 0', r.metrics.avoidViolations === 0);
  // strictAvoid: false で旧挙動も確認
  const r2 = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3, strictAvoid:false});
  ok('soft mode: slot filled (relaxed)', r2.assignments.length === 1);
  ok('soft mode: avoidRelaxed flag set', r2.assignments[0].avoidRelaxed === true);
  ok('soft mode: avoidViolations == 1', r2.metrics.avoidViolations === 1);
}

// =====================================================================
// T19: Reproducibility — randomStarts >= 5 always returns same result
// =====================================================================
console.log('\n=== T19: 再現性 (randomStarts=10 で2回実行) ===');
{
  const staffList = [
    staff('a','A','hall',{maxHoursPerWeek:40}),
    staff('b','B','hall',{maxHoursPerWeek:40}),
    staff('c','C','kitchen',{maxHoursPerWeek:40}),
  ];
  const slots = [];
  for (let i=0;i<5;i++){
    slots.push({id:`l${i}`,date:addDays(WK,i),position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:2});
    slots.push({id:`k${i}`,date:addDays(WK,i),position:'kitchen',startTime:'11:00',endTime:'15:00',requiredCount:1});
  }
  const r1 = generateShift({staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:40},randomStarts:10});
  const r2 = generateShift({staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:40},randomStarts:10});
  const sig = r => r.assignments.map(a=>`${a.date}|${a.position}|${a.startTime}|${a.staffId}`).sort().join('|');
  ok('two runs produce identical assignments', sig(r1) === sig(r2));
}

// =====================================================================
// T20: Computational performance — 50 staff, full week
// =====================================================================
console.log('\n=== T20: パフォーマンス — 50名の中規模店 ===');
{
  const staffList = [];
  for (let i=0;i<5;i++) staffList.push(staff(`m${i}`,`M${i}`,'manager',{maxHoursPerWeek:40,fixedDayOff:[i%7]}));
  for (let i=0;i<15;i++) staffList.push(staff(`k${i}`,`K${i}`,'kitchen',{maxHoursPerWeek:30,fixedDayOff:[i%7]}));
  for (let i=0;i<20;i++) staffList.push(staff(`h${i}`,`H${i}`,'hall',{maxHoursPerWeek:24,fixedDayOff:[i%7],canCover:i<10?['cashier']:[]}));
  for (let i=0;i<10;i++) staffList.push(staff(`c${i}`,`C${i}`,'cashier',{maxHoursPerWeek:24,fixedDayOff:[i%7],canCover:['hall']}));
  const slots=[];
  const sessions=[{id:'lunch',startTime:'11:00',endTime:'15:00'},{id:'dinner',startTime:'17:00',endTime:'22:00'}];
  for (let d=0;d<7;d++){
    for (const s of sessions){
      slots.push({id:`m_${d}_${s.id}`,date:addDays(WK,d),position:'manager',startTime:s.startTime,endTime:s.endTime,requiredCount:1});
      slots.push({id:`k_${d}_${s.id}`,date:addDays(WK,d),position:'kitchen',startTime:s.startTime,endTime:s.endTime,requiredCount:2});
      slots.push({id:`h_${d}_${s.id}`,date:addDays(WK,d),position:'hall',startTime:s.startTime,endTime:s.endTime,requiredCount:3});
      slots.push({id:`c_${d}_${s.id}`,date:addDays(WK,d),position:'cashier',startTime:s.startTime,endTime:s.endTime,requiredCount:1});
    }
  }
  const t0 = Date.now();
  const r = generateShift({staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:40,maxConsecutiveDays:5,maxHoursPerDay:12,minRestDaysPerWeek:1,minRestHoursBetweenShifts:8},randomStarts:5});
  const elapsed = Date.now() - t0;
  console.log(`    elapsed: ${elapsed}ms, coverage: ${(r.metrics.coverageRate*100).toFixed(1)}%`);
  ok('50 staff completes < 30s', elapsed < 30000, `${elapsed}ms`);
  ok('hard violations 0', r.audit.hardViolations.length === 0);
}

// =====================================================================
// T21: must が満たせない場合の挙動 (希望勤務日に他の制約で入れない)
// =====================================================================
console.log('\n=== T21: must が満たせない (固定休日と衝突) ===');
{
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40,fixedDayOff:[2]}), // Tuesday(2) off
    staff('b','Bob','hall',{maxHoursPerWeek:40}),
  ];
  // Alice MUST work Tuesday (contradictory with fixedDayOff[2])
  const tuesday = addDays(WK, 1); // 2026-05-12 = Tuesday(dow=2)
  const slots = [{id:'sl1',date:tuesday,position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:1}];
  const prefs = [
    {id:'p1',staffId:'a',date:tuesday,startTime:'11:00',endTime:'15:00',priority:'must'},
  ];
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3});
  ok('hard violations 0 (fixed day off respected)', r.audit.hardViolations.length === 0);
  ok('Bob takes the slot, not Alice', r.assignments[0].staffId === 'b');
  // The must is unsatisfied — verify metrics
  ok('preferenceSatisfaction = 0 (must unsatisfiable)', r.metrics.preferenceSatisfaction === 0);
}

// =====================================================================
// T23: Round 18 TOP 3a — Slot 細分化で部分希望が反映される
// 17-22 dinner × 2、A は 17-20 must、B は 19-22 must
// 細分化により: A=17-20、B=19-22、C=17-19、D=20-22 のような切り出しが可能
// =====================================================================
console.log('\n=== T23: Round 18 — slot 細分化 (部分時間希望が反映) ===');
{
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40}),
    staff('b','Bob','hall',{maxHoursPerWeek:40}),
    staff('c','Carol','hall',{maxHoursPerWeek:40}),
    staff('d','Dave','hall',{maxHoursPerWeek:40}),
  ];
  const day = addDays(WK, 0);
  const slots = [{id:'sl1',date:day,position:'hall',startTime:'17:00',endTime:'22:00',requiredCount:2}];
  const prefs = [
    {id:'p1',staffId:'a',date:day,startTime:'17:00',endTime:'20:00',priority:'must'},
    {id:'p2',staffId:'b',date:day,startTime:'19:00',endTime:'22:00',priority:'must'},
  ];
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3,decompose:true});
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  ok('decomposition occurred', r.audit.decomposition.splitCount === 1);
  ok('decomposed slots > 1', r.audit.decomposition.decomposedSlots > 1);
  // Alice should get a partial assignment matching 17-20 (not 17-22)
  const aliceAss = r.assignments.find(x => x.staffId === 'a');
  ok('Alice has assignment', !!aliceAss);
  if (aliceAss) {
    ok('Alice ends at 20:00 (not 22:00)', aliceAss.endTime === '20:00',
      `Alice: ${aliceAss.startTime}-${aliceAss.endTime}`);
  }
  const bobAss = r.assignments.find(x => x.staffId === 'b');
  ok('Bob has assignment', !!bobAss);
  if (bobAss) {
    ok('Bob starts at 19:00 (not 17:00)', bobAss.startTime === '19:00',
      `Bob: ${bobAss.startTime}-${bobAss.endTime}`);
  }
  ok('preference satisfaction high (>= 100%)', r.metrics.preferenceSatisfaction >= 1.0);
}

// =====================================================================
// T24: Round 18 TOP 3a — 細分化を OFF にした場合の旧挙動 (回帰確認)
// =====================================================================
console.log('\n=== T24: 細分化 OFF (decompose=false) で旧挙動を維持 ===');
{
  const staffList = [
    staff('a','Alice','hall',{maxHoursPerWeek:40}),
    staff('b','Bob','hall',{maxHoursPerWeek:40}),
  ];
  const day = addDays(WK, 0);
  const slots = [{id:'sl1',date:day,position:'hall',startTime:'17:00',endTime:'22:00',requiredCount:2}];
  const prefs = [
    {id:'p1',staffId:'a',date:day,startTime:'17:00',endTime:'20:00',priority:'must'},
  ];
  const r = generateShift({staff:staffList,slots,preferences:prefs,laborRules:{maxHoursPerWeek:40},randomStarts:3,decompose:false});
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  // 旧挙動: Alice は 17-22 全部に配置される (細分化なし)
  const aliceAss = r.assignments.find(x => x.staffId === 'a');
  if (aliceAss) {
    ok('Alice gets full slot 17-22 (legacy behavior)',
      aliceAss.startTime === '17:00' && aliceAss.endTime === '22:00',
      `Alice: ${aliceAss.startTime}-${aliceAss.endTime}`);
  }
}

// =====================================================================
// T22: weights = 0 for fairness — does it still produce coverage?
// =====================================================================
console.log('\n=== T22: weights.fairness = 0 でも動作 ===');
{
  const staffList = [
    staff('a','A','hall',{maxHoursPerWeek:40}),
    staff('b','B','hall',{maxHoursPerWeek:40}),
  ];
  const slots = [];
  for (let i=0;i<3;i++){
    slots.push({id:`l${i}`,date:addDays(WK,i),position:'hall',startTime:'11:00',endTime:'15:00',requiredCount:1});
  }
  const r = generateShift({
    staff:staffList,slots,preferences:[],laborRules:{maxHoursPerWeek:40},
    weights:{preference:0.5,positionMatch:0.2,fairness:0,cost:0.2,skill:0.1},
    randomStarts:3
  });
  ok('coverage 100%', r.metrics.coverageRate === 1);
  ok('hard violations 0', r.audit.hardViolations.length === 0);
  // Without fairness, expect skewed distribution (one person takes all)
  const aHrs = r.metrics.perStaff.find(p=>p.staffId==='a').hours;
  const bHrs = r.metrics.perStaff.find(p=>p.staffId==='b').hours;
  console.log(`    A=${aHrs}h B=${bHrs}h (fairness=0 → skewed expected)`);
}

console.log(`\n=== Summary ===\n  PASS: ${pass}\n  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
