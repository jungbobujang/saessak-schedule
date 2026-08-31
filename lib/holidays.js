/* 내장 공휴일 — 서버가 들고 있다가 /api/room 으로 화면에 내려 준다.
 *
 * ⚠ 2026년은 확정 자료다. **2027년은 확정 전 자료이니 연초에 확인이 필요하다.**
 *   설·추석과 부처님오신날은 음력이라 해마다 옮겨 다니고, 대체공휴일은 그해 달력에
 *   어떻게 걸리느냐에 따라 늘거나 준다. 정부 관보가 나오면 이 파일만 고치면 된다.
 *   (2027년 항목에는 provisional: true 를 붙여 두었다)
 *
 * 학교마다 다른 재량휴업일·방학은 여기 두지 않는다 — 그것은 담당자가 설정에서
 * room.schoolHolidays 로 넣고, 같은 날이면 학교 쪽 이름이 이긴다.
 */
'use strict';

var HOLIDAYS_2026 = [
  { date: '2026-01-01', name: '신정' },
  { date: '2026-02-16', name: '설 연휴' },
  { date: '2026-02-17', name: '설날' },
  { date: '2026-02-18', name: '설 연휴' },
  { date: '2026-03-01', name: '3·1절' },
  { date: '2026-03-02', name: '대체공휴일' },
  { date: '2026-05-05', name: '어린이날' },
  { date: '2026-05-24', name: '부처님오신날' },
  { date: '2026-05-25', name: '대체공휴일' },
  { date: '2026-06-03', name: '지방선거' },
  { date: '2026-06-06', name: '현충일' },
  { date: '2026-08-15', name: '광복절' },
  { date: '2026-08-17', name: '대체공휴일' },
  { date: '2026-09-24', name: '추석 연휴' },
  { date: '2026-09-25', name: '추석' },
  { date: '2026-09-26', name: '추석 연휴' },
  { date: '2026-10-03', name: '개천절' },
  { date: '2026-10-05', name: '대체공휴일' },
  { date: '2026-10-09', name: '한글날' },
  { date: '2026-12-25', name: '성탄절' }
];

// ⚠ 확정 전 — 연초에 관보로 확인할 것.
// **2027년 대체공휴일은 넣지 않았다.** 대체공휴일은 그해 요일에 따라 정부가 정하는데,
// 우리가 미리 짐작해 칠해 두면 틀렸을 때 그 날짜로 수업을 잡지 못하게 막는 쪽으로
// 잘못이 난다. 필요하면 담당자가 '학교 휴업일' 로 직접 넣으면 된다.
// 여기 있는 것은 고정일 공휴일과 음력 명절 본 날짜뿐이다.
var HOLIDAYS_2027 = [
  { date: '2027-01-01', name: '신정' },
  { date: '2027-02-05', name: '설 연휴' },
  { date: '2027-02-06', name: '설날' },
  { date: '2027-02-07', name: '설 연휴' },
  { date: '2027-03-01', name: '3·1절' },
  { date: '2027-05-05', name: '어린이날' },
  { date: '2027-05-13', name: '부처님오신날' },
  { date: '2027-06-06', name: '현충일' },
  { date: '2027-08-15', name: '광복절' },
  { date: '2027-09-14', name: '추석 연휴' },
  { date: '2027-09-15', name: '추석' },
  { date: '2027-09-16', name: '추석 연휴' },
  { date: '2027-10-03', name: '개천절' },
  { date: '2027-10-09', name: '한글날' },
  { date: '2027-12-25', name: '성탄절' }
].map(function (h) { return { date: h.date, name: h.name, provisional: true }; });

var LIST = HOLIDAYS_2026.concat(HOLIDAYS_2027);

// 확정 전인 해 — 화면 안내 문구에 쓴다
var PROVISIONAL_YEARS = ['2027'];
var CONFIRMED_YEARS = ['2026'];

function nameOf(date) {
  var h = LIST.filter(function (x) { return x.date === date; })[0];
  return h ? h.name : null;
}

module.exports = {
  LIST: LIST,
  PROVISIONAL_YEARS: PROVISIONAL_YEARS,
  CONFIRMED_YEARS: CONFIRMED_YEARS,
  nameOf: nameOf
};
