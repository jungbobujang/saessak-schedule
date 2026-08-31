'use strict';
// 예시 데이터 넣기 —  npm run seed  (이미 쓰던 자료가 있으면  npm run seed -- --force)
//
// 날짜는 **오늘 기준 상대값**으로 만든다. 몇 달 뒤에 돌려도 이번 달 화면에 그대로 걸린다.
// 선생님 3명 / 수업 9건 / 안 되는 날 4건 / 그중 겹침 2건 / 전체 공개 1건.
var store = require('../lib/store');

function ymd(offsetDays) {
  var d = new Date();
  d.setHours(12, 0, 0, 0);                 // 서머타임·자정 경계로 하루가 밀리지 않게
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

var force = process.argv.indexOf('--force') >= 0;
var cur = store.load();
var used = cur.programs.length + cur.blocks.length +
  cur.room.teachers.filter(function (t) { return t.id !== 'master'; }).length;
if (used > 0 && !force) {
  console.error('이미 쓰고 있는 자료가 있습니다 (선생님·수업·안 되는 날 합계 ' + used + '건).');
  console.error('덮어써도 괜찮다면:  npm run seed -- --force');
  process.exit(1);
}

var P = store.PALETTE;
var t1 = 't_kim', t2 = 't_park', t3 = 't_lee';
var now = new Date().toISOString();

var data = store.ensureShape({
  room: {
    name: '석암초 · 2학기',
    teachers: [
      { id: 'master', name: '담당 선생님', cls: '', code: '', color: P[0] },
      { id: t1, name: '김선생', cls: '3-1', code: '2417', color: P[1] },
      { id: t2, name: '박선생', cls: '4-2', code: '8830', color: P[2] },
      { id: t3, name: '이선생', cls: '5-1', code: '0562', color: P[3] }
    ]
  },
  programs: [
    { id: 'p_1', date: ymd(2), start: '09:00', end: '12:00', title: '디지털새싹 1차시', teacherIds: [t1], visibility: 'assigned', memo: '노트북 15대 준비', updatedAt: now },
    { id: 'p_2', date: ymd(3), start: '09:00', end: '12:00', title: '디지털새싹 2차시', teacherIds: [t2], visibility: 'assigned', memo: '', updatedAt: now },
    { id: 'p_3', date: ymd(5), start: '13:00', end: '15:00', title: '디지털새싹 3차시', teacherIds: [t3], visibility: 'assigned', memo: '', updatedAt: now },
    // ↓ 겹침 ① — 김선생이 이날 '연수' 로 안 된다고 적어 두었다
    { id: 'p_4', date: ymd(9), start: '09:00', end: '12:00', title: '디지털새싹 4차시', teacherIds: [t1], visibility: 'assigned', memo: '', updatedAt: now },
    { id: 'p_5', date: ymd(10), start: '09:00', end: '11:00', title: '학부모 공개수업', teacherIds: [t1, t2], visibility: 'all', memo: '모두에게 보이는 일정', updatedAt: now },
    // ↓ 겹침 ② — 박선생이 이날 '출장' 으로 안 된다고 적어 두었다
    { id: 'p_6', date: ymd(14), start: '13:00', end: '16:00', title: '디지털새싹 5차시', teacherIds: [t2], visibility: 'assigned', memo: '', updatedAt: now },
    { id: 'p_7', date: ymd(16), start: '09:00', end: '12:00', title: '디지털새싹 6차시', teacherIds: [t3], visibility: 'assigned', memo: '', updatedAt: now },
    { id: 'p_8', date: ymd(21), start: '09:00', end: '12:00', title: '디지털새싹 7차시', teacherIds: [t1], visibility: 'assigned', memo: '', updatedAt: now },
    { id: 'p_9', date: ymd(23), start: '13:00', end: '15:00', title: '디지털새싹 8차시', teacherIds: [t2, t3], visibility: 'assigned', memo: '두 반 합반', updatedAt: now }
  ],
  // 종일 2 · 오전 1 · 오후 1. 겹침 2건 중 하나는 반나절만 부딪히는 '부분 겹침' 이다.
  blocks: [
    // 겹침 ① 종일 — p_4(09:00~12:00)와 통째로 부딪힌다
    { id: 'b_1', date: ymd(9), teacherId: t1, slot: 'all', memo: '연수', updatedAt: now },
    // 겹침 ② 오후만 — p_6(13:00~16:00)이 오후라 부딪힌다(오전 수업이었다면 안 부딪힌다)
    { id: 'b_2', date: ymd(14), teacherId: t2, slot: 'pm', memo: '출장', updatedAt: now },
    { id: 'b_3', date: ymd(6), teacherId: t3, slot: 'all', memo: '', updatedAt: now },
    { id: 'b_4', date: ymd(17), teacherId: t1, slot: 'am', memo: '학년 행사', updatedAt: now }
  ]
});

store.save(data);
console.log('예시 데이터를 넣었습니다 — ' + store.DATA_FILE);
console.log('  선생님 ' + data.room.teachers.length + '명(담당 선생님 포함) / 수업 ' + data.programs.length + '건 / 안 되는 날 ' + data.blocks.length + '건');
console.log('  겹침 2건: ' + ymd(9) + ' 김선생, ' + ymd(14) + ' 박선생');
console.log('  뒷자리 — 김선생 2417 · 박선생 8830 · 이선생 0562 (담당자는 MASTER_CODE)');
