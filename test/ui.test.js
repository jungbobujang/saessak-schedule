'use strict';
// npm run test:ui — 헤드리스 크롬으로 진짜 화면을 두드린다.
//
// puppeteer 를 쓰지 않는다. 의존성 하나를 더 지고 다니는 대신 크롬을 직접 띄우고
// CDP(DevTools 규약)로 말한다. Node 의 전역 WebSocket 을 쓰므로 Node 22+ 가 필요하다.
// 크롬 경로는 CHROME_PATH 로 지정할 수 있다.
var { spawn } = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var H = require('./helpers');
var Palette = require('../public/shared/palette.js');

var t = H.counter();
var ok = t.ok.bind(t), eq = t.eq.bind(t);

// 화면이 되돌려 주는 색은 언제나 rgb() 꼴이다. 팔레트의 #rrggbb 와 맞대려면 같은 꼴로 바꾼다.
function rgbOf(hex) {
  var n = String(hex).replace('#', '');
  return 'rgb(' + parseInt(n.slice(0, 2), 16) + ', ' +
    parseInt(n.slice(2, 4), 16) + ', ' + parseInt(n.slice(4, 6), 16) + ')';
}

var CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe' : null,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);
function findChrome() {
  for (var i = 0; i < CANDIDATES.length; i++) {
    try { if (fs.existsSync(CANDIDATES[i])) return CANDIDATES[i]; } catch (e) {}
  }
  return null;
}

// ── 아주 작은 CDP 클라이언트 ──────────────────────────
function cdp(wsUrl) {
  var ws = new WebSocket(wsUrl);
  var id = 0, waiting = {};
  var ready = new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res(); });
    ws.addEventListener('error', function () { rej(new Error('CDP 연결 실패')); });
  });
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; }
  });
  function send(method, params, sessionId) {
    id++;
    var msg = { id: id, method: method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    var p = new Promise(function (res) { waiting[id] = res; });
    ws.send(JSON.stringify(msg));
    return p.then(function (m) {
      if (m.error) throw new Error(method + ': ' + m.error.message);
      return m.result;
    });
  }
  return { ready: ready, send: send, close: function () { try { ws.close(); } catch (e) {} } };
}

var srv, T1, T2, P_MASTER, P_MINE;
var DAY = '2026-09-10', DAY2 = '2026-09-11';
// 담당자(이남건)가 혼자 하는 비공개 수업. 김솔지 화면에는 실물이 아니라
// "이남건 · 오전 안 됨" 이라는 빗금 카드 한 장으로만 와야 한다 (v2.7).
var BUSY_DAY = '2026-09-15';

async function seed() {
  var ids = await H.seedRoom(srv);
  T1 = ids.T1; T2 = ids.T2;
  await srv.req('master', 'POST', '/api/programs', {
    dates: [BUSY_DAY], start: '09:00', end: '12:00',
    title: '남에게 보이면 안 되는 제목', teacherIds: [], memo: '보이면 안 되는 메모'
  });
  var r = await srv.req('master', 'POST', '/api/programs', {
    dates: [DAY], start: '09:00', end: '12:00', title: '담당자가 잡은 수업', teacherIds: [T1]
  });
  P_MASTER = r.body.created[0].id;
  r = await srv.req('sol', 'POST', '/api/programs', {
    dates: [DAY2], start: '09:00', end: '10:00', title: '내가 적은 수업'
  });
  P_MINE = r.body.created[0].id;
  // 김솔지가 담당자 수업을 고쳐 둔다 → 담당자 화면에 '고침' 줄이 붙어야 한다
  await srv.req('sol', 'PUT', '/api/programs/' + P_MASTER, { start: '13:00', end: '15:00' });
}

async function run(c) {
  await seed();
  ok('자료 준비', !!(P_MASTER && P_MINE));

  var target = await c.send('Target.createTarget', { url: 'about:blank' });
  var att = await c.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  var sid = att.sessionId;
  await c.send('Page.enable', {}, sid);
  await c.send('Runtime.enable', {}, sid);

  async function ev(expr) {
    var r = await c.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) {
      var msg = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
      throw new Error('화면 JS 오류: ' + msg + '\n식: ' + expr.slice(0, 160));
    }
    return r.result.value;
  }
  async function login(code) {
    await c.send('Page.navigate', { url: srv.base + '/#login' }, sid);
    for (var i = 0; i < 80; i++) {
      var r = await ev('typeof doLogin === "function" && !!document.getElementById("login-go")').catch(function () { return false; });
      if (r) break;
      await H.sleep(200);
    }
    await ev('document.getElementById("login-code").value = ' + JSON.stringify(code) + ', null');
    await ev('doLogin()');
    for (var k = 0; k < 80; k++) {
      if (await ev('S.role || null')) break;
      await H.sleep(150);
    }
    return await ev('S.role');
  }
  async function goto(ds) {
    await ev('(async function(){ S.view="cal"; S.formOpen=false; S.editing=null;' +
      ' S.month=' + JSON.stringify(ds.slice(0, 7)) + '; S.pick=' + JSON.stringify(ds) +
      '; await refresh(); })()');
    await H.sleep(150);
  }
  function panelText() { return ev('(panelBox().innerText || "")'); }
  function btns() { return ev('[].slice.call(panelBox().querySelectorAll("button")).map(function(b){return b.textContent})'); }
  async function click(label) {
    var hit = await ev('(function(){var b=[].slice.call(panelBox().querySelectorAll("button"))' +
      '.filter(function(x){return x.textContent===' + JSON.stringify(label) + '})[0];' +
      ' if(!b) return false; b.click(); return true;})()');
    await H.sleep(220);
    return hit;
  }
  function formInfo() {
    return ev('(function(){return {' +
      'text: panelBox().innerText||"",' +
      'btns: [].slice.call(panelBox().querySelectorAll("button")).map(function(b){return b.textContent}),' +
      'cbs: [].slice.call(panelBox().querySelectorAll("input[type=checkbox]")).map(function(c){' +
      'return {label:(c.parentNode.textContent||"").trim(), disabled:c.disabled, checked:c.checked}})' +
      '};})()');
  }

  console.log('\n── 화면 함수: 한국 시간 날짜 ──');
  await login('1111');
  eq('kstShortDate UTC 8/31 16:00 → 9/1', await ev('kstShortDate("2026-08-31T16:00:00.000Z")'), '9/1');
  eq('kstShortDate UTC 8/31 14:59 → 8/31', await ev('kstShortDate("2026-08-31T14:59:00.000Z")'), '8/31');
  eq('kstShortDate UTC 12/31 15:00 → 1/1', await ev('kstShortDate("2026-12-31T15:00:00.000Z")'), '1/1');
  eq('kstShortDate 빈 값', await ev('kstShortDate("")'), '');
  eq('kstShortDate 엉뚱한 값', await ev('kstShortDate("nope")'), '');

  console.log('\n── 선생님 상세 ──');
  await goto(DAY);
  var b = await btns(), txt = await panelText();
  ok('담당자가 잡은 수업에 [고치기] 노출', b.indexOf('고치기') >= 0, b);
  ok('담당자가 잡은 수업에 [지우기] 없음', b.indexOf('지우기') < 0, b);
  ok('선생님 상세에 "고침" 줄이 없음', txt.indexOf('선생님이 고침') < 0, txt);
  eq('선생님 안내줄 문구 (v2.6.1)',
    await ev('document.getElementById("teacher-note").textContent.trim()'),
    '내 수업과 내가 "안 돼요" 라고 적은 날이 보입니다. 다른 선생님이 적은 것은 그분이 알리기로 한 것만 보입니다.');

  await goto(DAY2);
  b = await btns();
  ok('내가 적은 수업에 [고치기] 노출', b.indexOf('고치기') >= 0, b);
  ok('내가 적은 수업에 [지우기] 노출', b.indexOf('지우기') >= 0, b);

  console.log('\n── 남의 비공개 수업은 "안 됨" 으로만 (v2.7) ──');
  await goto(BUSY_DAY);
  eq('화면이 받은 busy 는 한 장',
    await ev('S.busy.filter(function(b){return b.date===' + JSON.stringify(BUSY_DAY) + '}).length'), 1);
  eq('그 한 장은 이남건 · 오전',
    await ev('(function(){var b=S.busy.filter(function(x){return x.date===' + JSON.stringify(BUSY_DAY) + '})[0];' +
      ' return [b.teacherId, b.slot];})()'), ['master', 'am']);
  eq('수업 실물은 오지 않았다',
    await ev('S.programs.filter(function(p){return p.date===' + JSON.stringify(BUSY_DAY) + '}).length'), 0);
  ok('제목·메모는 화면 어디에도 없다',
    (await ev('document.body.innerText')).indexOf('보이면 안 되는') < 0);

  var cell = 'document.querySelector(\'.day[aria-label^="' + BUSY_DAY + '"]\')';
  eq('달력 칸에 빗금 카드가 한 장', await ev(cell + '.querySelectorAll(".card.block.busy").length'), 1);
  eq('카드 글씨는 "이남건 · 오전 안 됨"',
    await ev(cell + '.querySelector(".card.block.busy").innerText.trim()'), '이남건 · 오전 안 됨');
  eq('카드 툴팁은 "수업이 있어 안 되는 시간이에요"',
    await ev(cell + '.querySelector(".card.block.busy").title'), '수업이 있어 안 되는 시간이에요');
  eq('회색 바탕', await ev('getComputedStyle(' + cell + '.querySelector(".card.block.busy")).backgroundColor'),
    'rgb(107, 114, 128)');
  ok('빗금이 깔려 있다',
    (await ev('getComputedStyle(' + cell + '.querySelector(".card.block.busy")).backgroundImage'))
      .indexOf('repeating-linear-gradient') >= 0);
  eq('안 되는 날 카드와 같은 생김새',
    await ev('(function(){var a=getComputedStyle(' + cell + '.querySelector(".card.block.busy"));' +
      ' return [a.backgroundColor, a.backgroundImage].join("|");})()'),
    await ev('(function(){var p=document.createElement("div"); p.className="card block";' +
      ' document.body.appendChild(p); var a=getComputedStyle(p);' +
      ' var out=[a.backgroundColor, a.backgroundImage].join("|"); p.remove(); return out;})()'));

  txt = await panelText();
  ok('상세에도 같은 문구', txt.indexOf('이남건 · 오전 안 됨') >= 0, txt.slice(0, 400));
  eq('상세의 바쁨 줄은 한 줄뿐', await ev('panelBox().querySelectorAll(".row.busy").length'), 1);
  eq('바쁨 줄에는 단추가 없다', await ev('panelBox().querySelector(".row.busy").querySelectorAll("button").length'), 0);
  eq('바쁨 줄 툴팁', await ev('panelBox().querySelector(".row.busy").title'), '수업이 있어 안 되는 시간이에요');
  ok('상세 어디에도 [고치기] 가 없다', (await btns()).indexOf('고치기') < 0, await btns());

  console.log('\n── 선생님 새 수업 폼 ──');
  await goto(DAY2);
  ok('[+ 이날 수업 있어요] 눌림', (await click('+ 이날 수업 있어요')) === true);
  var f = await formInfo();
  var wm = f.cbs.filter(function (x) { return x.label.indexOf('담당 선생님과 함께하는 수업') >= 0; })[0];
  ok('"담당 선생님과 함께하는 수업" 체크 존재', !!wm, f.cbs);
  ok('기본 꺼짐', wm && wm.checked === false, wm);
  ok('새 폼에서는 만질 수 있다', wm && wm.disabled === false, wm);
  ok('설명 "켜면 이남건 선생님 일정에도 들어갑니다"',
    f.text.indexOf('켜면 이남건 선생님 일정에도 들어갑니다') >= 0, f.text.slice(0, 400));

  console.log('\n── 선생님 폼의 여러 날짜 (v2.6) ──');
  function dateCount() { return ev('panelBox().querySelectorAll(".datelist input[type=date]").length'); }
  eq('새 폼의 날짜는 고른 날 하나', await dateCount(), 1);
  ok('날짜 한 개일 때 "9월 11일에 적습니다."',
    (await panelText()).indexOf('9월 11일에 적습니다.') >= 0, (await panelText()).slice(0, 200));
  ok('[+ 날짜 추가] 가 있다', (await btns()).indexOf('+ 날짜 추가') >= 0, await btns());
  await click('+ 날짜 추가');
  eq('[+ 날짜 추가] 를 누르면 날짜 칸이 2개', await dateCount(), 2);
  ok('두 개일 때 "2개 날짜에 적습니다."',
    (await panelText()).indexOf('2개 날짜에 적습니다.') >= 0, (await panelText()).slice(0, 200));
  eq('둘째 줄에만 ✕ 가 붙는다',
    await ev('panelBox().querySelectorAll(".dateline button").length'), 1);
  await click('✕');
  eq('✕ 를 누르면 다시 1개', await dateCount(), 1);
  ok('다시 "…일에 적습니다."', (await panelText()).indexOf('일에 적습니다.') >= 0);

  // 세 날짜를 실제로 적어 저장한다 → 한 묶음 3회차
  await click('+ 날짜 추가');
  await click('+ 날짜 추가');
  await ev('(function(){var ins=[].slice.call(panelBox().querySelectorAll(".datelist input[type=date]"));' +
    'ins[0].value="2026-09-11"; ins[1].value="2026-09-18"; ins[2].value="2026-09-25";' +
    'panelBox().querySelector(".datelist").dispatchEvent(new Event("change",{bubbles:true}));})()');
  eq('세 개일 때 "3개 날짜에 적습니다."',
    (await panelText()).indexOf('3개 날짜에 적습니다.') >= 0, true);

  await ev('(function(){var c=[].slice.call(panelBox().querySelectorAll("input[type=checkbox]"))' +
    '.filter(function(x){return (x.parentNode.textContent||"").indexOf("담당 선생님과 함께")>=0})[0]; c.checked=true;})()');
  await ev('(function(){panelBox().querySelector("input[type=text]").value="브라우저로 만든 함께 수업";})()');
  await click('저장');
  await H.sleep(600);
  var saved = await srv.req('master', 'GET', '/api/data?month=2026-09');
  var mades = saved.body.programs.filter(function (p) { return p.title === '브라우저로 만든 함께 수업'; });
  eq('세 날짜가 모두 만들어졌다', mades.length, 3);
  eq('날짜가 고른 그대로',
    mades.map(function (p) { return p.date; }).sort(), ['2026-09-11', '2026-09-18', '2026-09-25']);
  var one = mades[0].seriesId;
  ok('셋이 한 묶음', one && mades.every(function (p) { return p.seriesId === one; }),
    mades.map(function (p) { return p.seriesId; }));
  ok('체크를 켜고 저장하면 teacherIds=[본인,master]',
    mades.every(function (p) { return JSON.stringify(p.teacherIds) === JSON.stringify([T1, 'master']); }),
    mades.map(function (p) { return p.teacherIds; }));

  console.log('\n── 담당자가 잡은 수업의 고치기 폼 ──');
  await goto(DAY);
  await click('고치기');
  f = await formInfo();
  ok('고치기 폼이 열림', f.text.indexOf('내 수업 고치기') >= 0, f.text.slice(0, 200));
  ok('[삭제] 없음', f.btns.indexOf('삭제') < 0, f.btns);
  ok('[모든 회차 삭제] 없음', f.btns.indexOf('모든 회차 삭제') < 0, f.btns);
  ok('안내 "이 수업을 지우려면 담당 선생님(이남건)께 말씀해 주세요."',
    f.text.indexOf('이 수업을 지우려면 담당 선생님(이남건)께 말씀해 주세요.') >= 0, f.text);
  var wm2 = f.cbs.filter(function (x) { return x.label.indexOf('담당 선생님과 함께하는 수업') >= 0; })[0];
  ok('함께 체크는 잠겨 있다', wm2 && wm2.disabled === true, wm2);
  ok('[저장] 은 있다(고치기는 된다)', f.btns.indexOf('저장') >= 0, f.btns);
  ok('묶음 담당 상속 안내가 보인다',
    f.text.indexOf('회차를 더하면 담당은 이 묶음 그대로 따라갑니다') >= 0, f.text.slice(0, 700));
  // 고칠 때는 이 회차 하나다. 회차를 더하는 것은 아래 묶음 줄이 맡는다.
  eq('고치기 폼의 날짜는 한 칸',
    await ev('panelBox().querySelectorAll(".datelist input[type=date]").length'), 1);
  eq('고치기 폼의 날짜 줄에는 ✕ 가 없다',
    await ev('panelBox().querySelectorAll(".dateline button").length'), 0);

  await ev('(function(){panelBox().querySelector("input[type=text]").value="선생님이 고친 제목";})()');
  await click('저장');
  await H.sleep(500);
  var after = await srv.req('master', 'GET', '/api/data?month=2026-09');
  var ap = after.body.programs.filter(function (p) { return p.id === P_MASTER; })[0];
  eq('화면에서 고친 제목이 저장됨', ap && ap.title, '선생님이 고친 제목');
  eq('담당은 그대로', ap && ap.teacherIds, [T1]);

  console.log('\n── 내가 적은 수업의 고치기 폼 (대조) ──');
  await goto(DAY2);
  await click('고치기');
  f = await formInfo();
  ok('[삭제] 있음', f.btns.indexOf('삭제') >= 0, f.btns);
  ok('안내 문구 없음', f.text.indexOf('이 수업을 지우려면') < 0, f.text.slice(0, 300));

  console.log('\n── 담당자 화면: 누가 고쳤는지 ──');
  eq('담당자 로그인', await login('1234'), 'master');
  await goto(DAY);
  txt = await panelText();
  ok('"김솔지 선생님이 고침" 이 보인다', txt.indexOf('김솔지 선생님이 고침') >= 0, txt.slice(0, 600));
  ok('고친 날짜가 함께 붙는다', /김솔지 선생님이 고침 · \d+\/\d+/.test(txt), txt.slice(0, 600));

  // 선생님이 스스로 적은 수업에는 붙지 않는다 (v2.5.1)
  await goto(DAY2);
  txt = await panelText();
  ok('선생님이 만든 수업에는 "고침" 이 안 붙는다', txt.indexOf('선생님이 고침') < 0, txt.slice(0, 600));

  await srv.req('master', 'PUT', '/api/programs/' + P_MASTER, { memo: '담당자가 정리' });
  await goto(DAY);
  txt = await panelText();
  ok('담당자가 고친 뒤에는 "고침" 이 사라진다', txt.indexOf('선생님이 고침') < 0, txt.slice(0, 600));

  // 담당자는 모든 수업을 실물로 본다 — '안 됨' 으로 겹쳐 찍히지 않는다 (v2.7)
  await goto(BUSY_DAY);
  eq('담당자 화면에는 busy 가 없다', await ev('S.busy.length'), 0);
  eq('담당자 달력에 빗금 "안 됨" 카드가 없다',
    await ev('document.querySelectorAll(".card.busy").length'), 0);
  ok('담당자에게는 제목이 그대로 보인다',
    (await panelText()).indexOf('남에게 보이면 안 되는 제목') >= 0, (await panelText()).slice(0, 300));

  await goto('2026-10-20');
  ok('빈 날은 그대로', (await panelText()).indexOf('이날은 적힌 일정이 없어요') >= 0);

  console.log('\n── 문구: "안 돼요" (v2.6.1) ──');
  await goto(DAY);
  b = await btns();
  ok('담당자 상세 단추는 [+ 나도 이날 안 돼요]', b.indexOf('+ 나도 이날 안 돼요') >= 0, b);
  ok('옛 문구 [+ 내 안 되는 날] 은 없다', b.indexOf('+ 내 안 되는 날') < 0, b);
  eq('범례는 "안 돼요(개인)"',
    await ev('[].slice.call(document.querySelectorAll(".legend span"))' +
      '.map(function(s){return s.textContent}).filter(function(s){return s.indexOf("개인")>=0})[0]'),
    '안 돼요(개인)');
  ok('달력 화면 어디에도 "안 되는 날" 이 없다',
    (await ev('document.body.innerText')).indexOf('안 되는 날') < 0);

  ok('[+ 나도 이날 안 돼요] 눌림', (await click('+ 나도 이날 안 돼요')) === true);
  f = await formInfo();
  ok('새로 적는 폼 제목은 "이날 안 돼요"', f.text.indexOf('이날 안 돼요') >= 0, f.text.slice(0, 200));
  ok('폼에 "안 되는 날" 이 없다', f.text.indexOf('안 되는 날') < 0, f.text.slice(0, 400));
  await ev('(function(){ S.formOpen=false; })()');

  // 이미 적어 둔 날의 [고치기] 폼 제목
  await srv.req('master', 'POST', '/api/blocks', { date: '2026-10-20', slot: 'all', memo: '문구 확인' });
  await goto('2026-10-20');
  txt = await panelText();
  ok('적어 둔 날 상세에도 "안 되는 날" 이 없다', txt.indexOf('안 되는 날') < 0, txt.slice(0, 400));
  await click('고치기');
  f = await formInfo();
  ok('고치기 폼 제목은 "이날 안 돼요 고치기"',
    f.text.indexOf('이날 안 돼요 고치기') >= 0, f.text.slice(0, 200));
  await ev('(function(){ S.formOpen=false; })()');

  console.log('\n── 회귀: 담당자 배정 폼·휴일 ──');
  await goto(DAY);
  ok('[+ 수업 배정] 눌림', (await click('+ 수업 배정')) === true);
  f = await formInfo();
  ok('담당 선생님 체크칸이 있다', f.cbs.length >= 2, f.cbs.length);
  ok('휴일 경고 없음 (v2.4.1 유지)', f.text.indexOf('그래도 배정할까요') < 0, f.text.slice(0, 400));
  ok('"나도 참석해야 하는 수업" 유지', f.text.indexOf('나도 참석해야 하는 수업') >= 0, f.text.slice(0, 500));
  ok('그 설명은 "켜면 내가 \\"안 돼요\\" 라고 적은 날과 겹치는지 확인합니다"',
    f.text.indexOf('켜면 내가 "안 돼요" 라고 적은 날과 겹치는지 확인합니다') >= 0, f.text.slice(0, 500));

  await ev('(function(){ S.formOpen=false; })()');
  await goto('2026-10-03');
  ok('상세 머리에 휴일 이름 유지', (await panelText()).indexOf('개천절') >= 0);
  ok('달력 칸에 휴일 이름 유지', (await ev('!!document.querySelector(".day.holiday .hname")')) === true);

  // ── 설정 화면. 달력 화면을 쓰는 검증 뒤에 둔다 — 여기서 화면을 #setup 으로 넘긴다.
  console.log('\n── 설정: 선생님 색 고르개 (v1.7 사양) ──');
  await ev('(function(){ location.hash = "#setup"; })()');
  for (var si = 0; si < 60; si++) {
    if (await ev('!document.getElementById("view-setup").classList.contains("hide")' +
      ' && document.querySelectorAll("#tea-body tr").length > 0')) break;
    await H.sleep(150);
  }
  ok('#setup 이 열렸다',
    (await ev('!document.getElementById("view-setup").classList.contains("hide")')) === true);
  eq('선생님 명단 표의 열 머리에 "색" 이 있다',
    await ev('[].slice.call(document.getElementById("tea-body").closest("table")' +
      '.querySelectorAll("thead th")).map(function(x){return x.textContent})'),
    ['이름', '반', 'CODE(4자리, 겹치면 6자리)', '색', '']);
  eq('줄마다 색 네모가 하나씩',
    await ev('[document.querySelectorAll("#tea-body tr").length,' +
      ' document.querySelectorAll("#tea-body .swatch-btn").length]'),
    [3, 3]);
  eq('네모에 그 선생님 색이 칠해져 있다',
    await ev('document.querySelector("#tea-body .swatch-btn").style.backgroundColor'),
    rgbOf(Palette.COLORS[0]));
  ok('셀에 [직접 고르기]용 color 입력이 숨어 있다',
    (await ev('!!document.querySelector("#tea-body td input[type=color].hide")')) === true);
  eq('팝오버는 처음엔 닫혀 있다', await ev('document.querySelectorAll(".cpop").length'), 0);

  // 색 네모 클릭 → 견본 10개 + [직접 고르기]
  await ev('document.querySelector("#tea-body .swatch-btn").click()');
  await H.sleep(150);
  eq('네모를 누르면 팝오버가 하나 열린다', await ev('document.querySelectorAll(".cpop").length'), 1);
  eq('견본은 10개', await ev('document.querySelectorAll(".cpop .cpop-grid .cpop-cell").length'), 10);
  eq('견본 색이 팔레트 10색 그대로',
    await ev('[].slice.call(document.querySelectorAll(".cpop .cpop-grid .cpop-cell"))' +
      '.map(function(b){return b.style.backgroundColor})'),
    Palette.COLORS.map(rgbOf));
  eq('[직접 고르기] 가 있다',
    await ev('(document.querySelector(".cpop .cpop-own") || {}).textContent'), '직접 고르기');
  eq('지금 쓰는 색 한 칸에만 ✓(.on)',
    await ev('document.querySelectorAll(".cpop .cpop-grid .cpop-cell.on").length'), 1);
  ok('남이 쓰는 색은 흐리게(.dim) 둔다',
    (await ev('document.querySelectorAll(".cpop .cpop-grid .cpop-cell.dim").length')) >= 2);
  eq('흐린 칸에는 누가 쓰는지 붙는다',
    await ev('document.querySelector(".cpop .cpop-grid .cpop-cell.dim").title.indexOf("선생님이 쓰는 색") > 0'),
    true);

  // 견본을 고르면 그 줄 색이 바뀌고 팝오버는 닫힌다
  await ev('document.querySelectorAll(".cpop .cpop-grid .cpop-cell")[5].click()');
  await H.sleep(150);
  eq('견본을 고르면 팝오버가 닫힌다', await ev('document.querySelectorAll(".cpop").length'), 0);
  eq('고른 색이 네모에 바로 보인다',
    await ev('document.querySelector("#tea-body .swatch-btn").style.backgroundColor'),
    rgbOf(Palette.COLORS[5]));
  eq('숨은 color 입력도 같은 값', await ev('document.querySelector("#tea-body td input[type=color]").value'),
    Palette.COLORS[5]);

  // 같은 네모를 다시 누르면 토글로 닫힌다
  await ev('document.querySelector("#tea-body .swatch-btn").click()');
  await H.sleep(120);
  eq('다시 열림', await ev('document.querySelectorAll(".cpop").length'), 1);
  await ev('document.querySelector("#tea-body .swatch-btn").click()');
  await H.sleep(120);
  eq('같은 네모를 또 누르면 닫힌다(토글)', await ev('document.querySelectorAll(".cpop").length'), 0);

  // 바깥을 누르면 닫힌다
  await ev('document.querySelector("#tea-body .swatch-btn").click()');
  await H.sleep(120);
  await ev('document.getElementById("room-name").click()');
  await H.sleep(120);
  eq('바깥을 누르면 닫힌다', await ev('document.querySelectorAll(".cpop").length'), 0);
}

async function main() {
  var chromePath = findChrome();
  if (!chromePath) {
    console.log('크롬을 찾지 못했습니다. CHROME_PATH 로 경로를 알려 주세요.');
    console.log('찾아본 곳:\n  ' + CANDIDATES.join('\n  '));
    process.exit(2);
  }
  console.log('크롬: ' + chromePath);

  srv = await H.startServer({ port: Number(process.env.TEST_PORT || 3478) });
  var profile = fs.mkdtempSync(path.join(os.tmpdir(), 'saessak-chrome-'));
  var cdpPort = Number(process.env.TEST_CDP_PORT || 9334);
  var chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
    '--window-size=1400,1000', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  var wsUrl = null;
  for (var i = 0; i < 100; i++) {
    try {
      var v = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).json();
      wsUrl = v.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (e) {}
    await H.sleep(250);
  }

  var c = null;
  if (!wsUrl) { t.bump('크롬을 띄우지 못했습니다'); }
  else {
    c = cdp(wsUrl);
    await c.ready;
    try { await run(c); }
    catch (e) { t.bump('예외: ' + e.message); console.log('  EXCEPTION ' + e.stack); }
  }

  if (c) c.close();
  chrome.kill();
  await srv.stop();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(t.report() ? 1 : 0);
}

main();
