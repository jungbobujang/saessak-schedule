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

  // ── 글자 대비 ────────────────────────────────────────
  // 카드 글자를 흰색으로 고정해 두면 밝은 색 위에서 읽기 어려워진다.
  // WCAG 대비를 재서 흰 글자가 AA(4.5:1)에 못 미치면 진한 글자로 바꾼다.
  var DARK = '#111111';
  var AA = 4.5;

  function lum(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var c = [0, 2, 4].map(function (i) {
      var v = parseInt(h.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  // 배경색 위에 얹을 글자색. 흰 글자가 AA 를 넘으면 흰색, 아니면 진한 색.
  // 둘 다 못 미치면 그나마 대비가 큰 쪽을 준다.
  function textOn(bg) {
    var w = contrast(bg, '#ffffff');
    if (w >= AA) return '#ffffff';
    return contrast(bg, DARK) >= w ? DARK : '#ffffff';
  }

  return {
    COLORS: COLORS, NAMES: NAMES, pick: pick, nameOf: nameOf,
    DARK: DARK, AA: AA, lum: lum, contrast: contrast, textOn: textOn
  };
});
