/* 안 되는 날의 시간대 규칙 — 서버와 화면이 **같은 파일**을 쓴다.
 *
 * 겹침 판정이 두 벌로 갈리면 어느 쪽이 맞는지 아무도 모르게 된다. 그래서 이 파일 하나만
 * 두고, 서버는 require 로, 화면은 <script src="/shared/slots.js"> 로 같은 코드를 읽는다.
 *
 * 옛 자료 호환은 '읽을 때' 한다 — 파일을 고치는 마이그레이션은 하지 않는다.
 *   · slot 이 없으면 'all'(종일)
 *   · memo 가 없고 title 만 있으면 title 을 메모로 본다. 다만 예전 기본값 '안 돼요' 는
 *     사람이 적은 말이 아니라 빈칸의 다른 이름이었으므로 빈 메모로 취급한다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Slots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SLOTS = ['all', 'am', 'pm'];
  var NOON = '12:00';
  var LABEL = { all: '종일', am: '오전', pm: '오후' };
  var EMPTY_MEMO = '안 돼요';   // 예전 기본 제목

  function isSlot(v) { return SLOTS.indexOf(v) >= 0; }
  function slotOf(block) {
    return (block && isSlot(block.slot)) ? block.slot : 'all';
  }
  function memoOf(block) {
    if (!block) return '';
    var m = (block.memo != null) ? String(block.memo) : String(block.title || '');
    m = m.trim();
    return m === EMPTY_MEMO ? '' : m;
  }
  function slotLabel(block) { return LABEL[slotOf(block)]; }

  // 카드 한 줄. 마스터 화면에서는 부르는 쪽이 앞에 이름을 붙인다.
  //   종일  → "안 돼요" 또는 메모
  //   오전  → "오전 · 새싹 연수"
  function blockCardText(block) {
    var s = slotOf(block);
    var body = memoOf(block) || EMPTY_MEMO;
    return s === 'all' ? body : (LABEL[s] + ' · ' + body);
  }

  // 이 '안 되는 날' 이 이 수업과 부딪히는가. 기준 시각은 12:00.
  // 수업 시간이 비어 있으면 종일 수업으로 보고 오전·오후 어느 쪽과도 부딪힌다.
  function blockHitsProgram(block, program) {
    var s = slotOf(block);
    if (s === 'all') return true;
    var start = program && program.start, end = program && program.end;
    if (!start || !end) return true;
    if (s === 'am') return start < NOON;
    return end > NOON;   // pm
  }

  // 그 사람의 그날 block 들을 모아 하루 상태를 낸다.
  //   free       가능 인원으로 세는가
  //   availLabel 상세 목록에 덧붙일 말 ('오후만 가능' 등). 온전히 가능하면 null
  //   formLabel  배정 폼 이름 옆 회색 말. 걸림이 없으면 빈 문자열
  function dayStatus(blocks) {
    var list = blocks || [];
    var am = false, pm = false, all = false;
    for (var i = 0; i < list.length; i++) {
      var s = slotOf(list[i]);
      if (s === 'all') all = true;
      else if (s === 'am') am = true;
      else pm = true;
    }
    if (all || (am && pm)) return { free: false, availLabel: null, formLabel: '(이날 안 됨)' };
    if (am) return { free: true, availLabel: '오후만 가능', formLabel: '(오전 안 됨)' };
    if (pm) return { free: true, availLabel: '오전만 가능', formLabel: '(오후 안 됨)' };
    return { free: true, availLabel: null, formLabel: '' };
  }

  return {
    SLOTS: SLOTS, LABEL: LABEL, NOON: NOON, EMPTY_MEMO: EMPTY_MEMO,
    isSlot: isSlot, slotOf: slotOf, memoOf: memoOf, slotLabel: slotLabel,
    blockCardText: blockCardText, blockHitsProgram: blockHitsProgram, dayStatus: dayStatus
  };
});
