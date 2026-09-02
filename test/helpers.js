'use strict';
// 검증 하네스가 함께 쓰는 것들 — 셈, 서버 띄우기, 쿠키를 든 요청.
//
// 가짜(mock)를 쓰지 않는다. 진짜 서버 프로세스를 띄우고, 진짜 로그인 쿠키로,
// 진짜 임시 폴더에 파일을 쓴다. 권한은 서버가 막는 것이라 서버를 거치지 않은
// 검증은 아무것도 증명하지 못한다.
var { spawn } = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..');

function counter() {
  var pass = 0, fail = 0, fails = [];
  return {
    ok: function (name, cond, extra) {
      if (cond) { pass++; console.log('  PASS  ' + name); }
      else {
        fail++; fails.push(name);
        console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
      }
    },
    eq: function (name, got, want) {
      this.ok(name, JSON.stringify(got) === JSON.stringify(want), { got: got, want: want });
    },
    report: function () {
      console.log('\n=== ' + pass + ' pass / ' + fail + ' fail ===');
      if (fails.length) console.log('실패: ' + fails.join(' | '));
      return fail;
    },
    countFail: function () { return fail; },
    bump: function (name) { fail++; fails.push(name); }
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 임시 DATA_DIR 에 진짜 서버를 띄운다. 사용자의 data.json 은 건드리지 않는다.
async function startServer(opts) {
  opts = opts || {};
  var port = opts.port || 3477;
  var dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saessak-test-'));
  var base = 'http://127.0.0.1:' + port;
  var log = '';
  var srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      MASTER_CODE: opts.masterCode || '1234',
      COOKIE_SECRET: 'test-only-secret',
      DATA_DIR: dataDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', function (b) { log += b; });
  srv.stderr.on('data', function (b) { log += b; });

  for (var i = 0; i < 80; i++) {
    try { var h = await fetch(base + '/api/health'); if (h.ok) break; } catch (e) {}
    await sleep(200);
  }

  var cookies = {};
  async function req(who, method, url, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    if (cookies[who]) opt.headers['Cookie'] = cookies[who];
    var res = await fetch(base + url, opt);
    var sc = res.headers.get('set-cookie');
    if (sc) cookies[who] = sc.split(';')[0];
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, body: data };
  }

  return {
    base: base, dataDir: dataDir, req: req,
    dataFile: path.join(dataDir, 'data.json'),
    log: function () { return log; },
    stop: async function () {
      srv.kill();
      await sleep(300);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  };
}

// 이름·코드가 정해진 방 하나. 두 하네스가 같은 사람으로 검증하도록 여기 모아 둔다.
//   마스터 이남건(1234) · 김솔지 3-1(1111) · 윤상혁 4-2(2222)
async function seedRoom(srv) {
  await srv.req('master', 'POST', '/api/login', { code: '1234' });
  var r = await srv.req('master', 'PUT', '/api/settings', {
    room: { name: '테스트 학교' },
    teachers: [
      { id: 'master', name: '이남건', cls: '' },
      { name: '김솔지', cls: '3-1', code: '1111' },
      { name: '윤상혁', cls: '4-2', code: '2222' }
    ]
  });
  var byName = {};
  r.body.teachers.forEach(function (t) { byName[t.name] = t.id; });
  await srv.req('sol', 'POST', '/api/login', { code: '1111' });
  await srv.req('yun', 'POST', '/api/login', { code: '2222' });
  return { T1: byName['김솔지'], T2: byName['윤상혁'] };
}

module.exports = { ROOT: ROOT, counter: counter, sleep: sleep, startServer: startServer, seedRoom: seedRoom };
