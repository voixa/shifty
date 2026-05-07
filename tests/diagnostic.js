// Diagnostic — manager coverage failure
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const sandbox = { window: {}, console, Date, Math, JSON, Number, String, Array, Object, Set, Map, Infinity };
sandbox.global = sandbox; vm.createContext(sandbox);
function load(p){ vm.runInContext(fs.readFileSync(p,'utf8'), sandbox, {filename:p}); }
load(path.join(__dirname,'..','js','data.js'));
load(path.join(__dirname,'..','js','algorithm.js'));
const D = sandbox.window.ShiftyData;
const A = sandbox.window.ShiftyAlgo;
const WS = '2026-05-11';

function makeStaff(id,name,position,opts={}){return{id,name,position,canCover:opts.canCover||[],hourlyWage:opts.hourlyWage||1100,maxHoursPerWeek:opts.maxHoursPerWeek||40,minHoursPerWeek:opts.minHoursPerWeek||0,fixedDayOff:opts.fixedDayOff||[],skill:opts.skill||3,notes:'',email:''};}

// 1人マネージャー、毎日lunch+dinner必要 → 1日9時間 > maxHoursPerDay=8 で不可
const staff = [
  makeStaff('m1','店長','manager',{maxHoursPerWeek:48,fixedDayOff:[1]}),
  makeStaff('h1','ホール','hall',{maxHoursPerWeek:30,canCover:['cashier']}),
  makeStaff('k1','キッチン','kitchen',{maxHoursPerWeek:30}),
  makeStaff('c1','レジ','cashier',{maxHoursPerWeek:30,canCover:['hall']}),
];
const sessions = [{id:'lunch',startTime:'11:00',endTime:'15:00'},{id:'dinner',startTime:'17:00',endTime:'22:00'}];
const slots = [];
for(let i=0;i<7;i++){
  const date = D.addDays(WS,i); const dow = D.dayOfWeek(date);
  for (const sess of sessions){
    if (dow===1) continue; // 火曜は店長休み
    slots.push({id:`m_${date}_${sess.id}`,date,position:'manager',startTime:sess.startTime,endTime:sess.endTime,requiredCount:1});
  }
}
console.log('Total manager slots required:', slots.length);
console.log('店長 maxHoursPerDay default:', 8);
console.log('lunch=4h, dinner=5h → 1日9hでHARD constraint labor_max_hours_day超過');

const r = A.generateShift({staff,slots,preferences:[],laborRules:{maxHoursPerWeek:48,maxConsecutiveDays:6,maxHoursPerDay:8,minRestDaysPerWeek:1},randomStarts:3});
console.log('Filled:', r.assignments.length, '/', slots.length);
console.log('Unfilled by date+session:');
for (const u of r.unfilled) console.log(' ', u.date, u.startTime);

console.log('\n--- Test 2: maxHoursPerDay=10 (relaxed) ---');
const r2 = A.generateShift({staff,slots,preferences:[],laborRules:{maxHoursPerWeek:48,maxConsecutiveDays:6,maxHoursPerDay:10,minRestDaysPerWeek:1},randomStarts:3});
console.log('Filled:', r2.assignments.length, '/', slots.length);
