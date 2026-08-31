'use strict';
// 디지털새싹 일정판 — 마스터(학교 담당자) 중심의 1:1 공유 일정 도구.
//
// 권한은 전부 여기서 막는다. 화면에서 버튼을 숨기는 것은 보안이 아니다.
//   · 미인증 API → 401
//   · 권한 없는 쓰기 → 403
//   · 조회는 요청자 시점으로 서버에서 걸러 내보낸다(선생님에게는 남의 '안 되는 날'을
//     응답에 담지 않는다 — 화면에서 감추는 것이 아니라 아예 보내지 않는다)
var express = require('express');
var cookieParser = require('cookie-parser');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var store = require('./lib/store');

var PORT = process.env.PORT || 3000;
var MASTER_CODE = String(process.env.MASTER_CODE || '').trim();
var COOKIE_SECRET = process.env.COOKIE_SECRET || '';
var SESSION_COOKIE = 'saessak_session';
var SESSION_MAX_AGE = 30 * 24 * 60 * 60;   // 초 (30일)

if (!COOKIE_SECRET) {
  COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[경고] COOKIE_SECRET 이 없어 임시 열쇠를 만들었습니다 — 서버를 다시 켜면 모두 다시 로그인해야 합니다.');
}
if (!MASTER_CODE) {
  console.warn('[경고] MASTER_CODE 가 설정되지 않았습니다 — 담당자(마스터)로는 로그인할 수 없습니다.');
}

// ===== 세션 (school-device-inspector 의 서명 쿠키 방식) =====
// payload(base64) + '.' + HMAC-SHA256. 서버가 서명한 값만 신뢰한다.
function signSession(payload) {
  var body = Buffer.from(JSON.stringify(payload)).toString('base64');
  var sig = crypto.createHmac('sha256', COOKIE_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}
function readSession(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var expected = crypto.createHmac('sha256', COOKIE_SECRET).update(parts[0]).digest('hex');
  var a = Buffer.from(expected), b = Buffer.from(parts[1]);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    var p = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
    if (p && p.exp && p.exp > Date.now()) return p;
    return null;
  } catch (e) { return null; }
}
function issueSession(res, payload) {
  payload.exp = Date.now() + SESSION_MAX_AGE * 1000;
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(signSession(payload)) +
    '; Path=/; Max-Age=' + SESSION_MAX_AGE + '; HttpOnly; SameSite=Lax');
}
function clearSession(res) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

// 세션에 적힌 사람이 지금도 명단에 있는지까지 본다.
// 명단에서 빠진 선생님의 오래된 쿠키로는 더 이상 들어올 수 없다.
function who(req) {
  var s = readSession(req.cookies && req.cookies[SESSION_COOKIE]);
  if (!s) return null;
  if (s.role === 'master') return { role: 'master', teacherId: 'master' };
  var d = store.load();
  var t = d.room.teachers.filter(function (x) { return x.id === s.teacherId; })[0];
  if (!t) return null;
  return { role: 'teacher', teacherId: t.id };
}
function requireAuth(req, res, next) {
  var s = who(req);
  if (!s) return res.status(401).json({ error: '로그인이 필요해요.' });
  req.session = s;
  next();
}
function requireMaster(req, res, next) {
  if (req.session.role !== 'master') {
    return res.status(403).json({ error: '담당 선생님만 할 수 있어요.' });
  }
  next();
}

// ===== 값 검사 =====
var RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
var RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function isDate(s) {
  if (!RE_DATE.test(String(s || ''))) return false;
  var d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime());
}
function isTime(s) { return RE_TIME.test(String(s || '')); }
function clean(s, max) { return String(s == null ? '' : s).trim().slice(0, max || 200); }
function nowIso() { return new Date().toISOString(); }

// 그 달 ±1주. 달을 넘나드는 주가 화면 격자에 함께 걸리므로 여유를 준다.
function monthRange(month) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  var now = new Date();
  var y = m ? parseInt(m[1], 10) : now.getFullYear();
  var mo = m ? parseInt(m[2], 10) : (now.getMonth() + 1);
  var first = new Date(Date.UTC(y, mo - 1, 1));
  var last = new Date(Date.UTC(y, mo, 0));
  first.setUTCDate(first.getUTCDate() - 7);
  last.setUTCDate(last.getUTCDate() + 7);
  var f = function (d) { return d.toISOString().slice(0, 10); };
  return { from: f(first), to: f(last) };
}

// 요청자 시점 필터. 선생님에게는 남의 '안 되는 날'을 아예 담지 않는다.
function filterFor(session, d, range) {
  var inRange = function (dt) { return dt >= range.from && dt <= range.to; };
  var programs = d.programs.filter(function (p) { return inRange(p.date); });
  var blocks = d.blocks.filter(function (b) { return inRange(b.date); });
  if (session.role !== 'master') {
    var id = session.teacherId;
    programs = programs.filter(function (p) {
      return (p.teacherIds || []).indexOf(id) >= 0 || p.visibility === 'all';
    });
    blocks = blocks.filter(function (b) { return b.teacherId === id; });
  }
  return { programs: programs, blocks: blocks };
}

// 선생님에게 나가는 명단에는 code 도 grade 도 넣지 않는다.
// 화면에서 감추는 것이 아니라 **응답에 아예 담지 않는다** — 등급은 담당자만 보는 값이다.
function publicTeachers(session, d) {
  return d.room.teachers.map(function (t) {
    var out = { id: t.id, name: t.name, cls: t.cls, color: t.color };
    if (session.role === 'master') { out.code = t.code; out.grade = t.grade; }
    return out;
  });
}

var app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ===== 로그인 =====
// 뒷자리 4자리로 들어온다. 4자리로 두 명 이상이 걸리면 앞 2자리를 더 받아 6자리로 가른다.
app.post('/api/login', function (req, res) {
  var code = clean(req.body && req.body.code, 20).replace(/\D/g, '');
  if (!code) return res.status(400).json({ error: '뒷자리를 입력해 주세요.' });

  if (MASTER_CODE && code === MASTER_CODE) {
    issueSession(res, { role: 'master', teacherId: 'master' });
    return res.json({ ok: true, role: 'master' });
  }

  var d = store.load();
  var hits = d.room.teachers.filter(function (t) {
    if (!t.code) return false;                       // 마스터 줄과 뒷자리 미등록자는 제외
    if (t.code === code) return true;
    if (code.length === 4 && t.code.length > 4 && t.code.slice(-4) === code) return true;
    if (code.length > 4 && t.code.length === 4 && code.slice(-4) === t.code) return true;
    return false;
  });

  if (hits.length === 1) {
    issueSession(res, { role: 'teacher', teacherId: hits[0].id });
    return res.json({ ok: true, role: 'teacher', name: hits[0].name });
  }
  if (hits.length > 1) {
    return res.json({ ambiguous: true, error: '뒷자리가 같은 분이 있어요. 앞 2자리를 더 입력해 주세요.' });
  }
  return res.status(401).json({ error: '등록된 번호가 아니에요. 담당 선생님께 확인해 주세요.' });
});

app.get('/api/me', function (req, res) {
  var s = who(req);
  if (!s) return res.status(401).json({ error: '로그인이 필요해요.' });
  var d = store.load();
  var t = d.room.teachers.filter(function (x) { return x.id === s.teacherId; })[0];
  res.json({
    role: s.role,
    me: t ? { id: t.id, name: t.name, cls: t.cls, color: t.color } : { id: s.teacherId, name: '담당 선생님', cls: '' },
    room: { name: d.room.name }
  });
});

app.post('/api/logout', function (req, res) { clearSession(res); res.json({ ok: true }); });

// ===== 조회 =====
app.get('/api/data', requireAuth, function (req, res) {
  var d = store.load();
  var range = monthRange(req.query.month);
  var v = filterFor(req.session, d, range);
  var me = d.room.teachers.filter(function (x) { return x.id === req.session.teacherId; })[0];
  res.json({
    role: req.session.role,
    me: me ? { id: me.id, name: me.name, cls: me.cls, color: me.color } : { id: req.session.teacherId, name: '담당 선생님', cls: '' },
    room: { name: d.room.name },
    teachers: publicTeachers(req.session, d),
    programs: v.programs,
    blocks: v.blocks,
    range: range
  });
});

// ===== 수업(programs) — 마스터 전용 =====
// 같은 제목·시간으로 여러 날짜를 한 번에 만들 수 있다(dates 배열).
app.post('/api/programs', requireAuth, requireMaster, function (req, res) {
  var b = req.body || {};
  var dates = Array.isArray(b.dates) && b.dates.length ? b.dates : [b.date];
  dates = dates.filter(function (x) { return isDate(x); });
  if (!dates.length) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
  if (!isTime(b.start) || !isTime(b.end)) return res.status(400).json({ error: '시간을 확인해 주세요. (예: 09:00)' });
  if (b.end <= b.start) return res.status(400).json({ error: '끝 시간이 시작 시간보다 빨라요.' });

  var d = store.load();
  var known = d.room.teachers.map(function (t) { return t.id; });
  var teacherIds = (Array.isArray(b.teacherIds) ? b.teacherIds : []).filter(function (id) { return known.indexOf(id) >= 0; });

  var made = dates.map(function (date) {
    return {
      id: store.genId('p'),
      date: date,
      start: b.start,
      end: b.end,
      title: clean(b.title, 80) || '디지털새싹 수업',
      teacherIds: teacherIds,
      visibility: b.visibility === 'all' ? 'all' : 'assigned',
      memo: clean(b.memo, 500),
      updatedAt: nowIso()
    };
  });
  d.programs = d.programs.concat(made);
  store.save(d);
  res.json({ ok: true, created: made });
});

app.put('/api/programs/:id', requireAuth, requireMaster, function (req, res) {
  var d = store.load();
  var p = d.programs.filter(function (x) { return x.id === req.params.id; })[0];
  if (!p) return res.status(404).json({ error: '그 수업을 찾지 못했어요.' });
  var b = req.body || {};

  if (b.date !== undefined) {
    if (!isDate(b.date)) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
    p.date = b.date;
  }
  if (b.start !== undefined) {
    if (!isTime(b.start)) return res.status(400).json({ error: '시간을 확인해 주세요.' });
    p.start = b.start;
  }
  if (b.end !== undefined) {
    if (!isTime(b.end)) return res.status(400).json({ error: '시간을 확인해 주세요.' });
    p.end = b.end;
  }
  if (p.end <= p.start) return res.status(400).json({ error: '끝 시간이 시작 시간보다 빨라요.' });
  if (b.title !== undefined) p.title = clean(b.title, 80) || '디지털새싹 수업';
  if (b.memo !== undefined) p.memo = clean(b.memo, 500);
  if (b.visibility !== undefined) p.visibility = b.visibility === 'all' ? 'all' : 'assigned';
  if (Array.isArray(b.teacherIds)) {
    var known = d.room.teachers.map(function (t) { return t.id; });
    p.teacherIds = b.teacherIds.filter(function (id) { return known.indexOf(id) >= 0; });
  }
  p.updatedAt = nowIso();
  store.save(d);
  res.json({ ok: true, program: p });
});

app.delete('/api/programs/:id', requireAuth, requireMaster, function (req, res) {
  var d = store.load();
  var before = d.programs.length;
  d.programs = d.programs.filter(function (x) { return x.id !== req.params.id; });
  if (d.programs.length === before) return res.status(404).json({ error: '그 수업을 찾지 못했어요.' });
  store.save(d);
  res.json({ ok: true });
});

// ===== 안 되는 날(blocks) — 본인 또는 마스터 =====
app.post('/api/blocks', requireAuth, function (req, res) {
  var b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: '날짜를 확인해 주세요.' });

  var target = b.teacherId || req.session.teacherId;
  if (req.session.role !== 'master' && target !== req.session.teacherId) {
    return res.status(403).json({ error: '내 것만 적을 수 있어요.' });
  }
  var d = store.load();
  if (!d.room.teachers.some(function (t) { return t.id === target; })) {
    return res.status(400).json({ error: '명단에 없는 선생님이에요.' });
  }
  var made = {
    id: store.genId('b'),
    date: b.date,
    teacherId: target,
    title: clean(b.title, 40) || '안 돼요',
    updatedAt: nowIso()
  };
  d.blocks.push(made);
  store.save(d);
  res.json({ ok: true, block: made });
});

app.delete('/api/blocks/:id', requireAuth, function (req, res) {
  var d = store.load();
  var target = d.blocks.filter(function (x) { return x.id === req.params.id; })[0];
  if (!target) return res.status(404).json({ error: '그 기록을 찾지 못했어요.' });
  if (req.session.role !== 'master' && target.teacherId !== req.session.teacherId) {
    return res.status(403).json({ error: '내가 적은 것만 지울 수 있어요.' });
  }
  d.blocks = d.blocks.filter(function (x) { return x.id !== req.params.id; });
  store.save(d);
  res.json({ ok: true });
});

// ===== 설정 — 마스터 전용 =====
app.get('/api/settings', requireAuth, requireMaster, function (req, res) {
  var d = store.load();
  res.json({ room: { name: d.room.name }, teachers: d.room.teachers });
});

// 명단에서 뺀 선생님의 수업 배정·안 되는 날은 **지우지 않는다**.
// 입력된 응답은 지우지 않는다는 원칙이고, 화면에서는 '(삭제된 선생님)' 으로 보인다.
app.put('/api/settings', requireAuth, requireMaster, function (req, res) {
  var b = req.body || {};
  var d = store.load();
  if (b.room && typeof b.room.name === 'string') d.room.name = clean(b.room.name, 60) || d.room.name;

  if (Array.isArray(b.teachers)) {
    var seen = {};
    var next = [];
    b.teachers.forEach(function (t, i) {
      var id = (t && t.id) || store.genId('t');
      if (seen[id]) return;             // 같은 id 가 두 번 오면 뒤엣것은 버린다
      seen[id] = true;
      var code = String((t && t.code) || '').replace(/\D/g, '').slice(0, 6);
      next.push({
        id: id,
        name: clean(t && t.name, 20),
        cls: clean(t && t.cls, 10),
        code: id === 'master' ? '' : code,   // 마스터 코드는 환경변수라 파일에 두지 않는다
        color: (t && t.color) || store.PALETTE[i % store.PALETTE.length],
        grade: store.normGrade(t && t.grade)
      });
    });
    if (!seen['master']) {
      var old = d.room.teachers.filter(function (t) { return t.id === 'master'; })[0];
      next.unshift(old || { id: 'master', name: '담당 선생님', cls: '', code: '', color: store.PALETTE[0] });
    }
    d.room.teachers = next;
  }
  store.save(d);

  // 뒷자리가 겹치는 사람들을 알려 준다(저장은 막지 않는다 — 6자리로 나눠 등록하면 된다)
  var byTail = {};
  d.room.teachers.forEach(function (t) {
    if (!t.code) return;
    var tail = t.code.slice(-4);
    (byTail[tail] = byTail[tail] || []).push(t.id);
  });
  var dupes = Object.keys(byTail).filter(function (k) { return byTail[k].length > 1; })
    .reduce(function (acc, k) { return acc.concat(byTail[k]); }, []);

  res.json({ ok: true, room: { name: d.room.name }, teachers: d.room.teachers, duplicateIds: dupes });
});

// 로그인 화면에 방 이름을 띄우기 위한 것. 이름 말고는 아무것도 내보내지 않는다.
app.get('/api/room', function (req, res) {
  res.json({ name: store.load().room.name });
});

// ===== 상태 확인 =====
app.get('/api/health', function (req, res) {
  var d = store.load();
  res.json({
    ok: !store.isDamaged(),
    dataPath: path.resolve(store.DATA_FILE),
    fileExists: store.fileExists(),
    // 담당자(master)는 명단에 늘 한 줄 있지만 '등록한 선생님' 수에는 넣지 않는다.
    // 이 숫자는 담당자가 몇 분을 등록했는지 확인하려고 보는 값이다.
    teachers: d.room.teachers.filter(function (t) { return t.id !== 'master'; }).length,
    programs: d.programs.length,
    blocks: d.blocks.length
  });
});

app.use('/api', function (req, res) { res.status(404).json({ error: '없는 주소예요.' }); });

store.bootLog();
var httpServer = app.listen(PORT, function () {
  console.log('디지털새싹 일정판 서버가 포트 ' + PORT + ' 에서 실행 중입니다.');
});

// 재배포·정지 신호. 저장은 모두 동기(writeDataFile)라 이 핸들러가 도는 시점에는
// 진행 중이던 쓰기가 이미 끝나 있다. 남은 임시 파일만 지우고 새 요청을 받지 않은 채 내려간다.
var shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[종료] ' + sig + ' 수신 — 저장을 마치고 종료합니다.');
  try { if (fs.existsSync(store.DATA_TMP)) fs.unlinkSync(store.DATA_TMP); } catch (e) {}
  try { httpServer.close(function () { process.exit(0); }); } catch (e) { process.exit(0); }
  setTimeout(function () { process.exit(0); }, 4000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });
