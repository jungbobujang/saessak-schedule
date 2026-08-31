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

  // 공개 범위 — 그 '안 되는 날' 을 다른 선생님에게 어디까지 보일지.
  //   private  나와 담당자만 (기본)
  //   fact     안 된다는 사실만. 메모는 응답에 담기지도 않는다
  //   full     메모까지
  // 알리는 것은 **고르는 일**이지 기본값이 아니다. 그래서 값이 없으면 private 로 본다
  // (옛 자료에는 이 칸이 아예 없다 — 파일을 고치지 않고 읽을 때 채운다).
  var VIS = ['private', 'fact', 'full'];
  var VIS_RANK = { private: 0, fact: 1, full: 2 };
  // 폼 단추에 적는 말. 담당자에게는 '담당자' 가 자기 자신이라 '나만' 이 된다.
  var VIS_BTN = { private: '나와 담당자만', fact: '안 되는 것만 알리기', full: '메모까지 알리기' };
  var VIS_BTN_MASTER = { private: '나만', fact: '안 되는 것만 알리기', full: '메모까지 알리기' };
  // 내가 적은 것의 상세에 붙는 작은 회색 말
  var VIS_TAG = { private: '나와 담당자만', fact: '안 되는 것만 알림', full: '메모까지 알림' };
  var VIS_TAG_MASTER = { private: '나만', fact: '안 되는 것만 알림', full: '메모까지 알림' };
  var VIS_HINT = {
    private: '다른 선생님에게는 보이지 않아요.',
    fact: '다른 선생님 달력에 \'안 돼요\'만 보여요.',
    full: '다른 선생님에게 메모까지 보여요.'
  };

  function isSlot(v) { return SLOTS.indexOf(v) >= 0; }
  function slotOf(block) {
    return (block && isSlot(block.slot)) ? block.slot : 'all';
  }
  function isVis(v) { return VIS.indexOf(v) >= 0; }
  function visOf(block) { return (block && isVis(block.visibility)) ? block.visibility : 'private'; }
  // 여러 장을 한 장으로 합칠 때는 **가장 좁은 것**을 따른다. 오전은 알리지 않기로 하고
  // 오후만 알리기로 했다면, 합쳐진 한 장이 오전 메모까지 데리고 나가서는 안 된다.
  function narrowestVis(list) {
    if (!list || !list.length) return 'private';
    var out = 'full';
    list.forEach(function (b) {
      if (VIS_RANK[visOf(b)] < VIS_RANK[out]) out = visOf(b);
    });
    return out;
  }
  function visBtnLabel(v, isMaster) { return (isMaster ? VIS_BTN_MASTER : VIS_BTN)[v] || VIS_BTN[v]; }
  function visTagLabel(v, isMaster) { return (isMaster ? VIS_TAG_MASTER : VIS_TAG)[v] || VIS_TAG[v]; }
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
    VIS: VIS, VIS_HINT: VIS_HINT,
    isSlot: isSlot, slotOf: slotOf, memoOf: memoOf, slotLabel: slotLabel,
    isVis: isVis, visOf: visOf, narrowestVis: narrowestVis,
    visBtnLabel: visBtnLabel, visTagLabel: visTagLabel,
    blockCardText: blockCardText, blockHitsProgram: blockHitsProgram, dayStatus: dayStatus
  };
});
