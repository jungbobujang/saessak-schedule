/* 선생님 색 팔레트 — 서버와 화면이 **같은 파일**을 쓴다.
 * (slots.js 와 같은 방식: 서버는 require, 화면은 <script src="/shared/palette.js">)
 *
 * 두 곳에 색 목록을 적어 두면 한쪽만 고치는 날이 반드시 온다. 그러면 자동 배정은
 * 있는 색을 주는데 고르개에는 그 색이 없는, 설명하기 어려운 화면이 된다.
 *
 * 10색 모두 흰 글자가 읽히는 명도로 골랐다 — 카드 글자색은 흰색 그대로다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Palette = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = [
    '#2f8f5b', // 초록
    '#3462c7', // 파랑
    '#8c3fb8', // 보라
    '#c0392b', // 빨강
    '#d9701e', // 주황
    '#1f8a8a', // 청록
    '#c2457f', // 분홍
    '#8a5a2b', // 갈색
    '#34467c', // 남색
    '#6b8e23'  // 올리브
  ];
  var NAMES = ['초록', '파랑', '보라', '빨강', '주황', '청록', '분홍', '갈색', '남색', '올리브'];

  // 아직 쓰지 않은 색부터 준다. 다 썼을 때만 앞에서부터 다시 돈다.
  function pick(usedColors) {
    var used = usedColors || [];
    for (var i = 0; i < COLORS.length; i++) {
      if (used.indexOf(COLORS[i]) < 0) return COLORS[i];
    }
    return COLORS[used.length % COLORS.length];
  }

  function nameOf(hex) {
    var i = COLORS.indexOf(hex);
    return i >= 0 ? NAMES[i] : '';
  }

  return { COLORS: COLORS, NAMES: NAMES, pick: pick, nameOf: nameOf };
});
