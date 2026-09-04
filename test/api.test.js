'use strict';
// npm test — 함수 하네스 + API 하네스.
//
// 앞쪽은 서버와 화면이 함께 쓰는 순수 함수들(public/shared, lib)을 직접 부른다.
// 뒤쪽은 진짜 서버를 띄우고 진짜 쿠키로 두드린다. 권한·응답 필터는 서버가 하는 일이라
// 서버를 거치지 않으면 아무것도 증명되지 않는다.
var Slots = require('../public/shared/slots.js');
var Palette = require('../public/shared/palette.js');
var Holidays = require('../lib/holidays.js');
var VERSION = require('../package.json').version;
var H = require('./helpers');
var fs = require('fs');

var t = H.counter();
var ok = t.ok.bind(t), eq = t.eq.bind(t);

// ══ 1부. 함수 하네스 ═══════════════════════════════════════════
function unitTests() {
  console.log('\n── 함수: 시간대·공개 범위 ──');
  eq('slotOf 기본은 종일', Slots.slotOf({}), 'all');
  eq('slotOf 는 엉뚱한 값도 종일로', Slots.slotOf({ slot: 'wat' }), 'all');
  eq('slotOf 오전', Slots.slotOf({ slot: 'am' }), 'am');
  eq('visOf 기본은 private', Slots.visOf({}), 'private');
  eq('visOf 는 엉뚱한 값도 private 로', Slots.visOf({ visibility: 'wat' }), 'private');
  eq('narrowestVis 는 가장 좁은 것', Slots.narrowestVis([{ visibility: 'full' }, { visibility: 'fact' }]), 'fact');
  eq('narrowestVis 빈 목록은 private', Slots.narrowestVis([]), 'private');
  eq('memoOf 는 옛 기본 제목을 빈칸으로', Slots.memoOf({ title: '안 돼요' }), '');
  eq('memoOf 는 title 을 메모로 읽는다', Slots.memoOf({ title: '연수' }), '연수');
  eq('memoOf 는 memo 가 우선', Slots.memoOf({ memo: '출장', title: '연수' }), '출장');

  console.log('\n── 함수: 겹침 판정 ──');
  var am9 = { start: '09:00', end: '11:00' }, pm2 = { start: '14:00', end: '16:00' };
  ok('종일은 무엇과도 부딪힘', Slots.blockHitsProgram({ slot: 'all' }, am9));
  ok('오전 × 오전 수업 = 부딪힘', Slots.blockHitsProgram({ slot: 'am' }, am9));
  ok('오전 × 오후 수업 = 안 부딪힘', !Slots.blockHitsProgram({ slot: 'am' }, pm2));
  ok('오후 × 오후 수업 = 부딪힘', Slots.blockHitsProgram({ slot: 'pm' }, pm2));
  ok('오후 × 오전 수업 = 안 부딪힘', !Slots.blockHitsProgram({ slot: 'pm' }, am9));
  ok('시간 없는 수업은 종일로 봐서 부딪힘', Slots.blockHitsProgram({ slot: 'am' }, {}));

  console.log('\n── 함수: 하루 상태 ──');
  eq('아무것도 없으면 가능', Slots.dayStatus([]).free, true);
  eq('오전만 안 되면 오후만 가능', Slots.dayStatus([{ slot: 'am' }]).availLabel, '오후만 가능');
  eq('오전+오후면 불가', Slots.dayStatus([{ slot: 'am' }, { slot: 'pm' }]).free, false);
  eq('종일이면 불가', Slots.dayStatus([{ slot: 'all' }]).free, false);
  eq('오후만 안 되면 폼 라벨', Slots.dayStatus([{ slot: 'pm' }]).formLabel, '(오후 안 됨)');

  console.log('\n── 함수: 바쁨(남의 비공개 수업) 시간대 (v2.7) ──');
  eq('오전에 끝나면 오전', Slots.busySlotOf({ start: '09:00', end: '12:00' }), 'am');
  eq('12시를 넘기면 종일', Slots.busySlotOf({ start: '09:00', end: '15:00' }), 'all');
  eq('정오에 시작하면 오후', Slots.busySlotOf({ start: '12:00', end: '14:00' }), 'pm');
  eq('오후에 시작하면 오후', Slots.busySlotOf({ start: '13:00', end: '15:00' }), 'pm');
  eq('11:59–12:01 도 종일', Slots.busySlotOf({ start: '11:59', end: '12:01' }), 'all');
  eq('시간이 없으면 종일', Slots.busySlotOf({}), 'all');
  eq('끝만 없어도 종일', Slots.busySlotOf({ start: '09:00' }), 'all');
  eq('오전+오후는 종일', Slots.mergeBusySlot('am', 'pm'), 'all');
  eq('오전+오전은 오전', Slots.mergeBusySlot('am', 'am'), 'am');
  eq('종일+오전은 종일', Slots.mergeBusySlot('all', 'am'), 'all');
  eq('앞이 비면 뒤를 따른다', Slots.mergeBusySlot(null, 'pm'), 'pm');
  eq('busyText 종일은 "안 됨"', Slots.busyText('all'), '안 됨');
  eq('busyText 오전', Slots.busyText('am'), '오전 안 됨');
  eq('busyText 오후', Slots.busyText('pm'), '오후 안 됨');
  eq('busyText 엉뚱한 값은 종일로', Slots.busyText('wat'), '안 됨');
  eq('바쁨 툴팁 문구', Slots.BUSY_TIP, '수업이 있어 안 되는 시간이에요');

  console.log('\n── 함수: 조율·만든 사람·고친 사람 ──');
  eq('flexOf 기본은 확인 필요', Slots.flexOf({}), 'unknown');
  eq('flexOf 는 엉뚱한 값도 unknown', Slots.flexOf({ flex: 'wat' }), 'unknown');
  ok('isFlex', Slots.isFlex('free') && !Slots.isFlex('nope'));
  eq('createdByOf 기본은 master', Slots.createdByOf({}), 'master');
  eq('createdByOf', Slots.createdByOf({ createdBy: 't_1' }), 't_1');
  eq('updatedByOf 없으면 만든 사람', Slots.updatedByOf({ createdBy: 't_1' }), 't_1');
  eq('updatedByOf 아무것도 없으면 master', Slots.updatedByOf({}), 'master');
  eq('updatedByOf', Slots.updatedByOf({ createdBy: 'master', updatedBy: 't_2' }), 't_2');

  console.log('\n── 함수: 회차 묶음 열쇠 ──');
  eq('seriesId 가 있으면 그것이 열쇠', Slots.seriesKeyOf({ seriesId: 's_1' }), 's_1');
  var legacyA = { title: '새싹', teacherIds: ['b', 'a'], start: '09:00' };
  var legacyB = { title: '새싹', teacherIds: ['a', 'b'], start: '09:00' };
  eq('옛 자료는 제목+담당+시작으로 묶고 담당 순서는 무관',
    Slots.seriesKeyOf(legacyA), Slots.seriesKeyOf(legacyB));
  ok('지어낸 열쇠는 ~ 로 시작', Slots.seriesKeyOf(legacyA).charAt(0) === '~');
  var progs = [
    { id: 'p2', date: '2026-10-08', seriesId: 's_1' },
    { id: 'p1', date: '2026-10-01', seriesId: 's_1' },
    { id: 'p3', date: '2026-10-01', seriesId: 's_2' }
  ];
  eq('seriesOf 는 날짜 순', Slots.seriesOf(progs, { seriesId: 's_1' }).map(function (x) { return x.id; }), ['p1', 'p2']);

  console.log('\n── 함수: 색 팔레트 ──');
  ok('팔레트에 색이 있다', Array.isArray(Palette.COLORS) && Palette.COLORS.length > 0);
  ok('pick 은 안 쓴 색을 준다', Palette.COLORS.indexOf(Palette.pick([Palette.COLORS[0]])) >= 0);
  ok('pick 은 이미 쓴 색을 피한다', Palette.pick([Palette.COLORS[0]]) !== Palette.COLORS[0]);
  ok('textOn 은 글자색을 준다', typeof Palette.textOn(Palette.COLORS[0]) === 'string');

  console.log('\n── 함수: 공휴일 자료 ──');
  ok('공휴일 목록이 있다', Array.isArray(Holidays.LIST) && Holidays.LIST.length > 0);
  ok('모든 공휴일이 날짜·이름을 갖는다',
    Holidays.LIST.every(function (h) { return /^\d{4}-\d{2}-\d{2}$/.test(h.date) && h.name; }));
  var dates = Holidays.LIST.map(function (h) { return h.date; });
  ok('같은 날짜가 두 번 있지 않다', new Set(dates).size === dates.length);
  ok('2027년은 확정 전으로 표시', (Holidays.PROVISIONAL_YEARS || []).indexOf('2027') >= 0 ||
    (Holidays.PROVISIONAL_YEARS || []).indexOf(2027) >= 0, Holidays.PROVISIONAL_YEARS);

  // 화면의 KST 표기와 같은 셈(index.html 의 kstShortDate). 화면 쪽 진짜 함수는
  // 헤드리스 크롬(npm run test:ui)에서 부른다 — 여기서는 셈만 확인한다.
  console.log('\n── 함수: 한국 시간 날짜 ──');
  function kst(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    var k = new Date(d.getTime() + 9 * 3600 * 1000);
    return (k.getUTCMonth() + 1) + '/' + k.getUTCDate();
  }
  eq('UTC 8/31 16:00 은 한국의 9/1', kst('2026-08-31T16:00:00.000Z'), '9/1');
  eq('UTC 8/31 14:59 은 아직 8/31', kst('2026-08-31T14:59:00.000Z'), '8/31');
  eq('UTC 9/1 00:00 은 9/1', kst('2026-09-01T00:00:00.000Z'), '9/1');
  eq('UTC 12/31 15:00 은 1/1', kst('2026-12-31T15:00:00.000Z'), '1/1');
  eq('빈 값은 빈 문자열', kst(''), '');
  eq('엉뚱한 값도 빈 문자열', kst('nope'), '');
}

// ══ 2부. API 하네스 ═══════════════════════════════════════════
var srv, T1, T2, req;

async function apiTests() {
  var ids = await H.seedRoom(srv);
  T1 = ids.T1; T2 = ids.T2;
  ok('방 준비', !!(T1 && T2));

  console.log('\n── 담당 선생님의 수정 (v2.5) ──');
  var r = await req('master', 'POST', '/api/programs', {
    dates: ['2026-09-10'], start: '09:00', end: '12:00',
    title: '마스터가 잡은 수업', teacherIds: [T1]
  });
  var P1 = r.body.created[0].id;
  eq('생성 시 createdBy=master', r.body.created[0].createdBy, 'master');
  eq('생성 시 updatedBy=master', r.body.created[0].updatedBy, 'master');

  r = await req('sol', 'PUT', '/api/programs/' + P1, { start: '13:00', end: '15:00' });
  ok('담당 선생님 시간 변경 → 200', r.status === 200, r.body);
  eq('시간이 실제로 바뀜', [r.body.program.start, r.body.program.end], ['13:00', '15:00']);
  eq('teacherIds 불변', r.body.program.teacherIds, [T1]);
  eq('선생님 응답에 updatedBy 없음', r.body.program.updatedBy, undefined);

  r = await req('sol', 'PUT', '/api/programs/' + P1, { teacherIds: [T1, T2], title: '제목만 바뀜' });
  eq('선생님 PUT 의 teacherIds 는 무시', r.body.program.teacherIds, [T1]);
  eq('다른 필드는 반영', r.body.program.title, '제목만 바뀜');
  r = await req('sol', 'PUT', '/api/programs/' + P1, { teacherIds: ['master'] });
  eq('자기를 빼려 해도 유지', r.body.program.teacherIds, [T1]);

  console.log('\n── 지우기는 만든 사람만 ──');
  r = await req('sol', 'DELETE', '/api/programs/' + P1);
  ok('담당이지만 안 만든 수업 DELETE → 403', r.status === 403, r.body);
  ok('안내 문구', /만든 사람만/.test(r.body.error), r.body);
  r = await req('sol', 'POST', '/api/programs', {
    dates: ['2026-09-11'], start: '09:00', end: '10:00', title: '내가 적은 수업'
  });
  eq('선생님 생성 createdBy', r.body.created[0].createdBy, T1);
  r = await req('sol', 'DELETE', '/api/programs/' + r.body.created[0].id);
  ok('내가 만든 수업 DELETE → 200', r.status === 200, r.body);

  console.log('\n── 선생님 POST 의 teacherIds ──');
  async function made(teacherIds, date) {
    var x = await req('sol', 'POST', '/api/programs', {
      dates: [date], start: '09:00', end: '10:00', title: 't', teacherIds: teacherIds
    });
    return x.body.created[0];
  }
  eq('[본인,master] 는 그대로', (await made([T1, 'master'], '2026-09-12')).teacherIds, [T1, 'master']);
  eq('[본인,남] → [본인]', (await made([T1, T2], '2026-09-13')).teacherIds, [T1]);
  eq('[남] → [본인]', (await made([T2], '2026-09-14')).teacherIds, [T1]);
  eq('없으면 [본인]', (await made(undefined, '2026-09-15')).teacherIds, [T1]);
  eq('[본인,master,남] → [본인]', (await made([T1, 'master', T2], '2026-09-16')).teacherIds, [T1]);

  console.log('\n── 남의 수업 ──');
  r = await req('yun', 'PUT', '/api/programs/' + P1, { start: '08:00' });
  ok('담당 아닌 수업 PUT → 403', r.status === 403, r.body);
  r = await req('yun', 'DELETE', '/api/programs/' + P1);
  ok('담당 아닌 수업 DELETE → 403', r.status === 403, r.body);
  r = await req('yun', 'PATCH', '/api/programs/' + P1 + '/flex', { flex: 'free' });
  ok('담당 아닌 수업 flex PATCH → 403', r.status === 403, r.body);

  console.log('\n── updatedBy ──');
  var md = await req('master', 'GET', '/api/data?month=all');
  var find = function (pack, id) { return pack.body.programs.filter(function (p) { return p.id === id; })[0]; };
  eq('마스터 응답에 updatedBy 포함', find(md, P1).updatedBy, T1);
  var sd = await req('sol', 'GET', '/api/data?month=all');
  ok('선생님 응답에 updatedBy 칸 자체가 없음', !('updatedBy' in find(sd, P1)), Object.keys(find(sd, P1)));
  ok('선생님 응답에 planId 칸도 없음', !('planId' in find(sd, P1)));
  await req('master', 'PUT', '/api/programs/' + P1, { memo: '담당자가 다시 고침' });
  md = await req('master', 'GET', '/api/data?month=all');
  eq('마스터가 고치면 master 로 돌아옴', find(md, P1).updatedBy, 'master');
  await req('sol', 'PATCH', '/api/programs/' + P1 + '/flex', { flex: 'free' });
  md = await req('master', 'GET', '/api/data?month=all');
  eq('flex 만 바꿔도 갱신', find(md, P1).updatedBy, T1);

  console.log('\n── 회차 묶음: 건너뛰기와 담당 상속 (v2.5.1) ──');
  r = await req('master', 'POST', '/api/programs', {
    dates: ['2026-10-01', '2026-10-08', '2026-10-15'], start: '09:00', end: '11:00',
    title: '연속 수업', teacherIds: [T1, T2]
  });
  var SER = r.body.created[0].seriesId;
  var S1 = r.body.created[0].id, S3 = r.body.created[2].id;
  eq('묶음 3회차 생성', r.body.created.length, 3);

  // 김솔지가 날짜 3개를 한 번에 — 같은 묶음, 담당은 본인
  r = await req('sol', 'POST', '/api/programs', {
    dates: ['2026-11-03', '2026-11-10', '2026-11-17'], start: '09:00', end: '10:00', title: '내 연속 수업'
  });
  ok('선생님이 날짜 3개 POST → 200', r.status === 200, r.body);
  eq('3회차가 만들어짐', r.body.created.length, 3);
  var sers = r.body.created.map(function (x) { return x.seriesId; });
  ok('셋이 같은 seriesId', sers[0] && sers[0] === sers[1] && sers[1] === sers[2], sers);
  ok('셋 다 담당은 본인', r.body.created.every(function (x) {
    return JSON.stringify(x.teacherIds) === JSON.stringify([T1]);
  }), r.body.created.map(function (x) { return x.teacherIds; }));

  // 담당이 [T1,T2] 인 마스터 묶음에 김솔지가 회차를 더하면 담당을 물려받는다
  r = await req('sol', 'POST', '/api/programs', {
    dates: ['2026-10-22'], start: '14:00', end: '16:00', title: '연속 수업',
    seriesId: SER, teacherIds: [T1]
  });
  ok('담당이면 + 날짜 추가 → 200', r.status === 200, r.body);
  eq('같은 묶음에 붙음', r.body.created[0].seriesId, SER);
  eq('담당을 묶음에서 물려받음(요청 값 무시)', r.body.created[0].teacherIds, [T1, T2]);
  eq('만든 사람은 더한 사람', r.body.created[0].createdBy, T1);

  // 마스터가 더해도 같은 규칙
  r = await req('master', 'POST', '/api/programs', {
    dates: ['2026-10-29'], start: '14:00', end: '16:00', title: '연속 수업',
    seriesId: SER, teacherIds: []
  });
  eq('마스터가 더해도 담당은 상속', r.body.created[0].teacherIds, [T1, T2]);

  // 섞인 묶음 만들기 — 3회차만 윤상혁 담당으로
  await req('master', 'PUT', '/api/programs/' + S3, { teacherIds: [T2] });
  r = await req('sol', 'PUT', '/api/programs/' + S1, { applyToSeries: true, start: '14:00', end: '16:00' });
  ok('섞인 묶음에 applyToSeries → 200', r.status === 200, r.body);
  eq('건너뛴 회차가 하나', r.body.skipped, 1);
  md = await req('master', 'GET', '/api/data?month=all');
  eq('건너뛴 회차는 그대로', [find(md, S3).start, find(md, S3).end], ['09:00', '11:00']);
  eq('내 회차는 바뀜', find(md, S1).start, '14:00');

  r = await req('sol', 'POST', '/api/programs', {
    dates: ['2026-11-01'], start: '09:00', end: '10:00', title: 'x', seriesId: 's_nope'
  });
  ok('없는 묶음 → 404', r.status === 404, r.body);
  r = await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-05'], start: '09:00', end: '10:00', title: '윤상혁 묶음', teacherIds: [T2]
  });
  var YSER = r.body.created[0].seriesId;
  r = await req('sol', 'POST', '/api/programs', {
    dates: ['2026-11-12'], start: '09:00', end: '10:00', title: 'x', seriesId: YSER
  });
  ok('담당이 하나도 없는 묶음에 붙이기 → 403', r.status === 403, r.body);
  r = await req('sol', 'DELETE', '/api/programs/series/' + encodeURIComponent(SER));
  ok('남이 만든 묶음 통째 삭제 → 403', r.status === 403, r.body);

  console.log('\n── 마스터 참석 수업 × 마스터의 안 되는 날 ──');
  await req('master', 'POST', '/api/blocks', { date: '2026-09-12', slot: 'all', visibility: 'private' });
  md = await req('master', 'GET', '/api/data?month=2026-09');
  var together = md.body.programs.filter(function (p) { return p.date === '2026-09-12'; })[0];
  ok('마스터가 그 수업의 담당', (together.teacherIds || []).indexOf('master') >= 0, together.teacherIds);
  eq('마스터 응답에 그 안 되는 날이 있다(화면이 겹침으로 그린다)',
    md.body.blocks.filter(function (b) { return b.date === '2026-09-12' && b.teacherId === 'master'; }).length, 1);
  sd = await req('sol', 'GET', '/api/data?month=2026-09');
  eq('마스터의 private 안 되는 날은 선생님 응답에 없다',
    sd.body.blocks.filter(function (b) { return b.teacherId === 'master'; }).length, 0);

  console.log('\n── 회귀: 권한·응답 필터 ──');
  r = await req('yun', 'GET', '/api/plans');
  ok('선생님은 /api/plans → 403', r.status === 403, r.body);
  sd = await req('sol', 'GET', '/api/data?month=all');
  ok('선생님 응답에 plans 칸 없음', !('plans' in sd.body), Object.keys(sd.body));
  ok('선생님 명단에 code 없음', sd.body.teachers.every(function (x) { return !('code' in x); }));
  md = await req('master', 'GET', '/api/data?month=all');
  eq('마스터 명단에는 code 있음', md.body.teachers.filter(function (x) { return x.id === T1; })[0].code, '1111');
  ok('미인증 → 401', (await fetch(srv.base + '/api/data')).status === 401);

  console.log('\n── 회귀: 값 검사 ──');
  var bads = [
    ['끝<시작 → 400', { dates: ['2026-09-20'], start: '13:00', end: '12:00' }],
    ['잘못된 날짜 → 400', { dates: ['nope'], start: '09:00', end: '10:00' }],
    ['잘못된 시간 → 400', { dates: ['2026-09-20'], start: '9시', end: '10:00' }],
    ['잘못된 flex → 400', { dates: ['2026-09-20'], start: '09:00', end: '10:00', flex: 'wat' }]
  ];
  for (var i = 0; i < bads.length; i++) {
    r = await req('sol', 'POST', '/api/programs', bads[i][1]);
    ok(bads[i][0], r.status === 400, r.body);
  }
  r = await req('sol', 'POST', '/api/blocks', { date: '2026-09-21', slot: 'wat' });
  ok('잘못된 slot → 400', r.status === 400, r.body);
  r = await req('sol', 'POST', '/api/blocks', { date: '2026-09-21', visibility: 'wat' });
  ok('잘못된 visibility → 400', r.status === 400, r.body);
  r = await req('sol', 'POST', '/api/blocks', { date: '2026-09-22', teacherId: T2 });
  ok('남의 안 되는 날 → 403', r.status === 403, r.body);

  console.log('\n── 회귀: 안 되는 날 공개 범위 ──');
  await req('yun', 'POST', '/api/blocks', { date: '2026-09-25', slot: 'am', visibility: 'fact', memo: '비밀' });
  sd = await req('sol', 'GET', '/api/data?month=2026-09');
  var shared = sd.body.blocks.filter(function (b) { return b.teacherId === T2 && b.date === '2026-09-25'; })[0];
  ok('fact 는 사실만 가고 memo 칸이 없다', shared && !('memo' in shared), shared);
  await req('yun', 'POST', '/api/blocks', { date: '2026-09-26', visibility: 'private', memo: '비밀2' });
  sd = await req('sol', 'GET', '/api/data?month=2026-09');
  eq('private 는 응답에 아예 없다',
    sd.body.blocks.filter(function (b) { return b.date === '2026-09-26' && b.teacherId === T2; }).length, 0);
  r = await req('yun', 'POST', '/api/blocks', { date: '2026-09-25', slot: 'all', visibility: 'fact' });
  ok('같은 날 다시 적으면 덮어쓴다(쌓이지 않는다)', r.body.replaced === true, r.body);

  console.log('\n── 남의 비공개 수업 → 바쁨(안 됨) (v2.7) ──');
  // 담당자가 윤상혁에게만 잡아 준 수업. 김솔지는 담당이 아니고 전체 공개도 아니다.
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-02'], start: '09:00', end: '12:00', title: '남의 비밀 수업',
    teacherIds: [T2], memo: '보이면 안 되는 메모'
  });
  var solD = await req('sol', 'GET', '/api/data?month=2026-11');
  var yunD = await req('yun', 'GET', '/api/data?month=2026-11');
  eq('담당 아닌 사람 programs 에는 없다',
    solD.body.programs.filter(function (p) { return p.date === '2026-11-02'; }).length, 0);
  var bz = solD.body.busy.filter(function (b) { return b.date === '2026-11-02'; });
  eq('대신 busy 가 한 장', bz.length, 1);
  eq('09:00–12:00 은 오전', bz[0] && bz[0].slot, 'am');
  eq('대표는 담당 선생님', bz[0] && bz[0].teacherId, T2);
  eq('busy 에는 세 칸뿐', bz[0] && Object.keys(bz[0]).sort(), ['date', 'slot', 'teacherId']);
  ok('title 칸이 없다', bz[0] && !('title' in bz[0]), bz[0]);
  ok('memo·start·end·seriesId 칸도 없다',
    bz[0] && !('memo' in bz[0]) && !('start' in bz[0]) && !('end' in bz[0]) && !('seriesId' in bz[0]), bz[0]);
  ok('담당인 사람에게는 수업 실물이 간다',
    yunD.body.programs.filter(function (p) { return p.title === '남의 비밀 수업'; }).length === 1,
    yunD.body.programs.length);
  eq('담당인 사람에게는 그 날 busy 가 없다',
    yunD.body.busy.filter(function (b) { return b.date === '2026-11-02'; }).length, 0);

  // 정오를 넘기는 수업은 종일
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-03'], start: '09:00', end: '15:00', title: '긴 수업', teacherIds: [T2]
  });
  solD = await req('sol', 'GET', '/api/data?month=2026-11');
  eq('09:00–15:00 은 종일',
    solD.body.busy.filter(function (b) { return b.date === '2026-11-03'; })[0].slot, 'all');

  // 같은 사람·같은 날 오전 수업 + 오후 수업 → 한 장으로 합쳐 종일
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-04'], start: '09:00', end: '11:00', title: '오전 것', teacherIds: [T2]
  });
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-04'], start: '13:00', end: '15:00', title: '오후 것', teacherIds: [T2]
  });
  solD = await req('sol', 'GET', '/api/data?month=2026-11');
  var two = solD.body.busy.filter(function (b) { return b.date === '2026-11-04'; });
  eq('수업 두 개라도 busy 는 한 장', two.length, 1);
  eq('오전+오후는 종일로 합쳐진다', two[0].slot, 'all');

  // 전체 공개 수업은 종전 그대로 실물로 보인다 — 바쁨으로 바뀌지 않는다
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-07'], start: '09:00', end: '11:00', title: '모두 보는 수업',
    teacherIds: [T2], visibility: 'all'
  });
  solD = await req('sol', 'GET', '/api/data?month=2026-11');
  eq('전체 공개는 실물로 보인다',
    solD.body.programs.filter(function (p) { return p.title === '모두 보는 수업'; }).length, 1);
  eq('전체 공개는 busy 로 바뀌지 않는다',
    solD.body.busy.filter(function (b) { return b.date === '2026-11-07'; }).length, 0);

  // 담당자가 혼자 하는 수업이면 대표는 'master'
  await req('master', 'POST', '/api/programs', {
    dates: ['2026-11-06'], start: '13:00', end: '15:00', title: '담당자 혼자', teacherIds: []
  });
  solD = await req('sol', 'GET', '/api/data?month=2026-11');
  var solo = solD.body.busy.filter(function (b) { return b.date === '2026-11-06'; })[0];
  eq('담당 선생님이 없으면 대표는 master', solo && solo.teacherId, 'master');
  eq('13:00–15:00 은 오후', solo && solo.slot, 'pm');

  md = await req('master', 'GET', '/api/data?month=2026-11');
  ok('마스터 응답에는 busy 칸 자체가 없다', !('busy' in md.body), Object.keys(md.body));

  // 내가 적은 개인 block 은 busy 와 무관하다 (v2.1 규칙 그대로)
  await req('sol', 'POST', '/api/blocks', { date: '2026-11-02', slot: 'pm', memo: '내 사정' });
  solD = await req('sol', 'GET', '/api/data?month=2026-11');
  eq('내 block 은 그대로 온다',
    solD.body.blocks.filter(function (b) { return b.date === '2026-11-02' && b.teacherId === T1; }).length, 1);
  eq('같은 날 busy 도 그대로 따로 있다',
    solD.body.busy.filter(function (b) { return b.date === '2026-11-02'; }).length, 1);

  console.log('\n── 회귀: 예정 목록(plans) ──');
  r = await req('master', 'POST', '/api/plans', { title: '새싹 A', teacherIds: [T1] });
  var PL = r.body.plan.id;
  ok('plan 생성', r.status === 200, r.body);
  r = await req('master', 'POST', '/api/programs', {
    dates: ['2026-12-01'], start: '09:00', end: '10:00', title: '새싹 A', teacherIds: [T1], planId: PL
  });
  eq('plan 으로 잡은 수업이 planId 를 진다', r.body.created[0].planId, PL);
  r = await req('master', 'DELETE', '/api/plans/' + PL);
  ok('달력에 잡힌 plan 삭제 → 409', r.status === 409, r.body);

  console.log('\n── 회귀: 판 번호·상태 ──');
  var room = await (await fetch(srv.base + '/api/room')).json();
  eq('/api/room 판 번호가 package.json 과 같다', room.version, VERSION);
  ok('공휴일이 내려온다', Array.isArray(room.holidays) && room.holidays.length > 0);
  var health = await (await fetch(srv.base + '/api/health')).json();
  eq('health 판 번호', health.version, VERSION);
  eq('health 선생님 수(마스터 제외)', health.teachers, 2);
  ok('health ok', health.ok === true, health);

  console.log('\n── 회귀: 옛 자료 호환 ──');
  var raw = JSON.parse(fs.readFileSync(srv.dataFile, 'utf8'));
  raw.programs.push({
    id: 'p_legacy', date: '2027-01-10', start: '09:00', end: '10:00',
    title: '옛 수업', teacherIds: [T1], visibility: 'assigned', memo: '',
    updatedAt: '2025-01-01T00:00:00.000Z'
  });
  fs.writeFileSync(srv.dataFile, JSON.stringify(raw, null, 2));
  md = await req('master', 'GET', '/api/data?month=all');
  var leg = find(md, 'p_legacy');
  eq('createdBy 기본값 master', leg.createdBy, 'master');
  eq('updatedBy 기본값 master', leg.updatedBy, 'master');
  eq('flex 기본값 unknown', leg.flex, 'unknown');
  r = await req('sol', 'PUT', '/api/programs/p_legacy', { memo: '담당이 고침' });
  ok('옛 수업도 담당이면 고칠 수 있다', r.status === 200, r.body);
  r = await req('sol', 'DELETE', '/api/programs/p_legacy');
  ok('옛 수업은 만든 사람(master)만 지운다 → 403', r.status === 403, r.body);
}

async function main() {
  console.log('══ 함수 하네스 ══');
  try { unitTests(); }
  catch (e) { t.bump('함수 예외: ' + e.message); console.log('  EXCEPTION ' + e.stack); }

  console.log('\n══ API 하네스 (진짜 서버) ══');
  srv = await H.startServer({ port: Number(process.env.TEST_PORT || 3477) });
  req = srv.req;
  try { await apiTests(); }
  catch (e) { t.bump('API 예외: ' + e.message); console.log('  EXCEPTION ' + e.stack); }
  var srvLog = srv.log();
  await srv.stop();

  if (t.countFail()) console.log('\n서버 로그 ---\n' + srvLog.trim().split('\n').slice(0, 10).join('\n'));
  process.exit(t.report() ? 1 : 0);
}

main();
