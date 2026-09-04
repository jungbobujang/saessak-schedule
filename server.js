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
// 시간대·겹침 규칙은 화면과 같은 파일을 쓴다 (public 아래라 브라우저도 같은 것을 읽는다)
var Slots = require('./public/shared/slots.js');
// 화면에 찍히는 판 번호. package.json 하나만 올리면 서버·화면이 따라온다.
var VERSION = require('./package.json').version;
var Holidays = require('./lib/holidays');

var PORT = process.env.PORT || 3000;
var MASTER_CODE = String(process.env.MASTER_CODE || '').trim();
var COOKIE_SECRET = process.env.COOKIE_SECRET || '';
var SESSION_COOKIE = 'saessak_session';
var SESSION_MAX_AGE = 30 * 24 * 60 * 60;   // 초 (30일)

if (!COOKIE_SECRET) {
  COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[경고] COOKIE_SECRET 이 없어 임시 열쇠를 만들었습니다 — 서버를 다시 켜면 모두 다시 로그인해야 합니다.');
}
// 입장 코드는 숫자만 받는 칸으로 들어온다. 그래서 MASTER_CODE 도 4~8자리 숫자여야
// 어떤 입력으로든 일치할 수 있다. 값이 어긋나도 서버는 뜨되(다른 기능은 멀쩡하다) 경고를 남긴다.
var MASTER_CODE_VALID = /^\d{4,8}$/.test(MASTER_CODE);
if (!MASTER_CODE) {
  console.warn('[경고] MASTER_CODE 가 설정되지 않았습니다 — 담당자(마스터)로는 로그인할 수 없습니다.');
} else if (!MASTER_CODE_VALID) {
  console.warn('[설정] 경고: MASTER_CODE 는 4~8자리 숫자여야 합니다. 현재 값으로는 마스터 로그인이 불가능합니다.');
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
// 공개 범위가 어긋났을 때의 말. 서버가 되돌리면 화면은 이 문장을 폼 안에 그대로 띄운다.
var VIS_ERROR = '누가 볼 수 있는지는 나와 담당자만·안 되는 것만·메모까지 중에서 골라 주세요.';
function clean(s, max) { return String(s == null ? '' : s).trim().slice(0, max || 200); }
function nowIso() { return new Date().toISOString(); }

// 그 달 ±1주. 달을 넘나드는 주가 화면 격자에 함께 걸리므로 여유를 준다.
// month=all 은 프로그램 화면처럼 '전체를 한 번에' 봐야 하는 곳에서 쓴다.
// 범위만 넓어질 뿐 요청자 시점 필터(filterFor)는 그대로 걸린다.
function monthRange(month) {
  if (String(month || '') === 'all') return { from: '0000-01-01', to: '9999-12-31' };
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

// 한 사람의 하루에는 '안 되는 날' 이 한 장이어야 한다. 옛 자료에는 여러 장이 있을 수
// 있는데, **파일은 건드리지 않고 읽는 응답에서만 합쳐 보여 준다.**
// 오전 + 오후 = 종일이고, 메모는 '/' 로 잇는다. 지우는 것이 아니라 겹쳐 읽는 것이다.
var mergeLogged = false;
function mergeBlocks(list) {
  var byKey = {};
  var order = [];
  var merged = 0;
  list.forEach(function (b) {
    var key = b.date + '|' + b.teacherId;
    if (!byKey[key]) { byKey[key] = [b]; order.push(key); return; }
    byKey[key].push(b);
    merged++;
  });
  if (merged > 0 && !mergeLogged) {
    mergeLogged = true;
    console.log('[데이터] 같은 날 중복 안 되는 날 ' + merged + '건을 합쳐 표시합니다.');
  }
  return order.map(function (key) {
    var group = byKey[key];
    if (group.length === 1) return group[0];
    var slots = {};
    var memos = [];
    group.forEach(function (b) {
      slots[Slots.slotOf(b)] = true;
      var m = Slots.memoOf(b);
      if (m && memos.indexOf(m) < 0) memos.push(m);
    });
    var slot = (slots.all || (slots.am && slots.pm)) ? 'all' : (slots.am ? 'am' : 'pm');
    return {
      id: group[0].id, date: group[0].date, teacherId: group[0].teacherId,
      slot: slot, memo: memos.join('/'), visibility: Slots.narrowestVis(group),
      updatedAt: group[0].updatedAt, mergedFrom: group.length
    };
  });
}

// 남이 적은 '안 되는 날' 을 선생님에게 어디까지 내보낼지.
// 화면에서 감추는 것이 아니라 **응답에 담지 않는다** — private 는 아예 빠지고,
// fact 는 memo 라는 칸 자체가 없다(빈 문자열로도 나가지 않는다).
function shareBlock(b) {
  var v = Slots.visOf(b);
  if (v === 'private') return null;
  var out = { id: b.id, date: b.date, teacherId: b.teacherId, slot: Slots.slotOf(b) };
  if (v === 'full') out.memo = Slots.memoOf(b);
  return out;
}

// 조율 등급(flex)·만든 사람(createdBy)·고친 사람(updatedBy)은 옛 자료에 없다. 파일을
// 고치는 마이그레이션 대신 **내보낼 때** 기본값을 채운다 — 화면은 늘 값이 있다고 보고 그린다.
//
// planId 와 updatedBy 는 담당자의 운영용 값이라 선생님 응답에는 **담지 않는다**.
// 누가 언제 고쳤는지는 판을 맞추는 담당자가 볼 일이지, 다른 선생님이 볼 일이 아니다 —
// 화면에서 감추는 것이 아니라 응답에 아예 넣지 않는다.
function shapeProgram(p, forMaster) {
  var out = {};
  Object.keys(p).forEach(function (k) {
    if (!forMaster && (k === 'planId' || k === 'updatedBy')) return;
    out[k] = p[k];
  });
  out.flex = Slots.flexOf(p);
  out.createdBy = Slots.createdByOf(p);
  if (forMaster) out.updatedBy = Slots.updatedByOf(p);
  return out;
}

// 남의 비공개 수업을 '바쁨' 으로 바꿀 때 이름표로 세울 한 사람.
// 담당자(master)는 어느 수업에나 낄 수 있으므로 대표가 되지 못한다 — 담당 선생님 중
// 첫 사람을 세우고, 그런 사람이 없을 때(담당자 혼자 하는 수업)만 'master' 다.
function busyOwner(p) {
  var ids = (p.teacherIds || []).filter(function (id) { return id !== 'master'; });
  return ids.length ? ids[0] : 'master';
}
// 비공개 수업 목록 → { date, teacherId, slot } 만 남긴 파생 항목.
// **여기서 만드는 객체에는 제목·메모·시간·seriesId 가 들어갈 자리가 아예 없다** —
// 원본에서 골라 빼는 것이 아니라 세 칸짜리 새 객체를 짓는다. 그래야 나중에 수업에
// 칸이 하나 더 늘어도 그것이 조용히 따라 나가지 않는다.
// 같은 사람·같은 날은 시간대를 합쳐 한 장으로 만든다.
function busyFrom(programs) {
  var byKey = {}, order = [];
  programs.forEach(function (p) {
    var who = busyOwner(p);
    var key = p.date + '|' + who;
    var slot = Slots.busySlotOf(p);
    if (!byKey[key]) {
      byKey[key] = { date: p.date, teacherId: who, slot: slot };
      order.push(key);
      return;
    }
    byKey[key].slot = Slots.mergeBusySlot(byKey[key].slot, slot);
  });
  return order.map(function (k) { return byKey[k]; });
}

// 요청자 시점 필터. 선생님에게는 남의 '안 되는 날'을 그 사람이 알리기로 한 만큼만 담는다.
function filterFor(session, d, range) {
  var inRange = function (dt) { return dt >= range.from && dt <= range.to; };
  var programs = d.programs.filter(function (p) { return inRange(p.date); });
  // 합치기가 먼저다 — 같은 사람의 하루가 여러 장이면 그 묶음의 공개 범위를 정한 뒤에
  // 걸러야, 좁게 적어 둔 쪽의 메모가 넓은 쪽에 얹혀 새어 나가지 않는다.
  var blocks = mergeBlocks(d.blocks.filter(function (b) { return inRange(b.date); }));
  var busy = null;
  if (session.role !== 'master') {
    var id = session.teacherId;
    var mineOrOpen = function (p) {
      return (p.teacherIds || []).indexOf(id) >= 0 || p.visibility === 'all';
    };
    // 빼는 것과 바쁨으로 바꾸는 것은 **같은 한 줄의 앞뒷면**이다. 두 군데에서 따로
    // 판정하면 언젠가 한쪽만 고쳐져 비공개 수업이 실물로 새거나, 보이는 수업이
    // '안 됨' 으로 겹쳐 찍힌다.
    busy = busyFrom(programs.filter(function (p) { return !mineOrOpen(p); }));
    // planId 는 담당자의 신청 관리용 값이다. 선생님 응답에는 담지 않는다.
    programs = programs.filter(mineOrOpen).map(function (p) { return shapeProgram(p, false); });
    blocks = blocks.map(function (b) {
      return b.teacherId === id ? b : shareBlock(b);   // 내 것은 그대로, 남의 것은 걸러서
    }).filter(Boolean);
  } else {
    programs = programs.map(function (p) { return shapeProgram(p, true); });
  }
  return { programs: programs, blocks: blocks, busy: busy };
}

// 선생님에게 나가는 명단에는 code 를 넣지 않는다.
// 화면에서 감추는 것이 아니라 **응답에 아예 담지 않는다**.
// grade(사람 등급)는 v2.3부터 아무에게도 내보내지 않는다 — 조율은 수업에 붙는다.
function publicTeachers(session, d) {
  return d.room.teachers.map(function (t) {
    var out = { id: t.id, name: t.name, cls: t.cls, color: t.color };
    if (session.role === 'master') out.code = t.code;
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
  if (!code) return res.status(400).json({ error: '코드를 입력해 주세요.' });

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
    // 6자리까지 넣었는데도 갈리지 않으면 사람이 더 할 수 있는 일이 없다. 담당자에게 넘긴다.
    if (code.length >= 6) {
      return res.json({ ambiguous: true, error: '담당 선생님께 CODE 정리를 요청해 주세요.' });
    }
    return res.json({ ambiguous: true, error: '같은 CODE의 선생님이 두 분 있어요. 앞 2자리를 더 넣어 6자리로 시도해 주세요.' });
  }
  return res.status(401).json({ error: '등록된 코드가 아니에요. 담당 선생님께 확인해 주세요.' });
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
  // 예정 목록은 담당자만 본다 — 선생님 응답에는 plans 라는 칸 자체가 없다.
  if (req.session.role === 'master') {
    return res.json({
      role: req.session.role,
      me: me ? { id: me.id, name: me.name, cls: me.cls, color: me.color } : { id: req.session.teacherId, name: '담당 선생님', cls: '' },
      room: { name: d.room.name, schoolHolidays: d.room.schoolHolidays },
      teachers: publicTeachers(req.session, d),
      plans: d.room.plans,
      programs: v.programs,
      blocks: v.blocks,
      range: range
    });
  }
  res.json({
    role: req.session.role,
    me: me ? { id: me.id, name: me.name, cls: me.cls, color: me.color } : { id: req.session.teacherId, name: '담당 선생님', cls: '' },
    // 학교 휴업일은 달력을 칠하는 데 쓰이므로 선생님에게도 함께 보낸다
    room: { name: d.room.name, schoolHolidays: d.room.schoolHolidays },
    teachers: publicTeachers(req.session, d),
    programs: v.programs,
    blocks: v.blocks,
    // 남의 비공개 수업을 시간대만 남긴 파생 표시(v2.7). 담당자 응답에는 이 칸이 없다 —
    // 담당자는 모든 수업을 실물로 보므로 같은 사실을 두 번 적을 이유가 없다.
    busy: v.busy || [],
    range: range
  });
});

// ===== 신청 예정 프로그램(plans) — 마스터 전용 =====
// '잡혔는가' 는 저장하지 않는다. planId 를 가진 수업이 하나라도 있으면 잡힌 것이고,
// 그 계산은 화면이 한다. 두 군데에 같은 사실을 적어 두면 반드시 어긋난다.
function bookedPlanIds(d) {
  var out = {};
  d.programs.forEach(function (p) { if (p.planId) out[p.planId] = true; });
  return out;
}

app.get('/api/plans', requireAuth, requireMaster, function (req, res) {
  res.json({ plans: store.load().room.plans });
});

app.post('/api/plans', requireAuth, requireMaster, function (req, res) {
  var b = req.body || {};
  var title = clean(b.title, 80);
  if (!title) return res.status(400).json({ error: '프로그램 이름을 적어 주세요.' });
  var d = store.load();
  var known = d.room.teachers.map(function (t) { return t.id; });
  var made = {
    id: store.genId('pl'),
    title: title,
    teacherIds: (Array.isArray(b.teacherIds) ? b.teacherIds : []).filter(function (id) { return known.indexOf(id) >= 0; }),
    memo: clean(b.memo, 200),
    applied: !!b.applied,
    createdAt: nowIso()
  };
  d.room.plans.push(made);
  store.save(d);
  res.json({ ok: true, plan: made });
});

app.put('/api/plans/:id', requireAuth, requireMaster, function (req, res) {
  var d = store.load();
  var pl = d.room.plans.filter(function (x) { return x.id === req.params.id; })[0];
  if (!pl) return res.status(404).json({ error: '그 프로그램을 찾지 못했어요.' });
  var b = req.body || {};
  if (b.title !== undefined) {
    var title = clean(b.title, 80);
    if (!title) return res.status(400).json({ error: '프로그램 이름을 적어 주세요.' });
    pl.title = title;
  }
  if (b.memo !== undefined) pl.memo = clean(b.memo, 200);
  if (b.applied !== undefined) pl.applied = !!b.applied;
  if (Array.isArray(b.teacherIds)) {
    var known = d.room.teachers.map(function (t) { return t.id; });
    pl.teacherIds = b.teacherIds.filter(function (id) { return known.indexOf(id) >= 0; });
  }
  store.save(d);
  res.json({ ok: true, plan: pl });
});

// 달력에 잡힌 것이 있으면 지우지 않는다. 여기서 지우면 그 수업의 planId 가 갈 곳을
// 잃고, 화면에서는 아무 데도 속하지 않은 수업이 된다. 달력에서 먼저 지우게 한다.
app.delete('/api/plans/:id', requireAuth, requireMaster, function (req, res) {
  var d = store.load();
  var pl = d.room.plans.filter(function (x) { return x.id === req.params.id; })[0];
  if (!pl) return res.status(404).json({ error: '그 프로그램을 찾지 못했어요.' });
  if (bookedPlanIds(d)[pl.id]) {
    return res.status(409).json({ error: '달력에 잡힌 수업이 있어요. 달력에서 먼저 지워 주세요.' });
  }
  d.room.plans = d.room.plans.filter(function (x) { return x.id !== req.params.id; });
  store.save(d);
  res.json({ ok: true });
});

// ===== 수업(programs) =====
// 담당자는 누구에게든 배정할 수 있고, 선생님은 **자기 수업만** 적을 수 있다.
// 조율 등급은 값이 없으면 '확인 필요' 지만, 엉뚱한 값이면 조용히 바꾸지 않고 되돌린다.
var FLEX_ERROR = '조율은 옮겨도 됨·어느 정도·옮길 수 없음·확인 필요 중에서 골라 주세요.';
// 이 수업을 고칠 수 있는가. v2.5부터 **본인이 담당인 수업이면** 담당자가 잡아 준
// 것이라도 고칠 수 있다 — 시간이 바뀌었다는 사실을 가장 먼저 아는 사람은 그 수업을
// 하는 선생님이다. 못 고치게 막아 두면 그 사실이 판에 들어오지 못한다.
// 다만 **담당 목록(teacherIds)만은 담당자가 정한다** — 아래 PUT 에서 선생님이 보낸
// teacherIds 는 받지 않는다. 자기를 빼거나 남을 끌어들이는 것은 배정이지 수정이 아니다.
function canEditProgram(session, p) {
  if (session.role === 'master') return true;
  if (Slots.createdByOf(p) === session.teacherId) return true;
  return (p.teacherIds || []).indexOf(session.teacherId) >= 0;
}
// 지우는 것은 다르다. **만든 사람만** 지운다 — 담당자가 잡아 준 수업을 선생님이
// 지우면 담당자의 판에서 그 수업이 말없이 사라진다. 고치면 흔적이 남지만 지우면 없다.
function canDeleteProgram(session, p) {
  return session.role === 'master' || Slots.createdByOf(p) === session.teacherId;
}
var NOT_MINE = '내가 담당인 수업만 고칠 수 있어요.';
var NOT_MADE = '이 수업은 만든 사람만 지울 수 있어요. 담당 선생님께 말씀해 주세요.';

// 선생님이 보내온 담당 목록을 받아 줄 수 있는 값으로 정한다.
// 허락하는 것은 **[본인]** 과 **[본인, 담당자]** 두 가지뿐이다. 뒤엣것은 폼의
// '담당 선생님과 함께하는 수업' 이고, 그래야 담당자의 안 되는 날과 겹치는지 본다.
// 그 밖의 값(남을 끼워 보낸 것)은 되돌리지 않고 [본인]으로 정한다 — 선생님 폼에는
// 남을 고르는 칸 자체가 없으므로 사람이 고른 값이 아니라 보내온 값일 뿐이다.
function ownTeacherIds(ids, meId) {
  var list = Array.isArray(ids) ? ids : [];
  var seen = {};
  list.forEach(function (x) { seen[String(x)] = true; });
  var keys = Object.keys(seen);
  if (!keys.length) return [meId];
  var onlyMineAndMaster = seen[meId] && keys.every(function (k) { return k === meId || k === 'master'; });
  if (!onlyMineAndMaster) return [meId];
  return seen['master'] ? [meId, 'master'] : [meId];
}

// 같은 제목·시간으로 여러 날짜를 한 번에 만들 수 있다(dates 배열).
app.post('/api/programs', requireAuth, function (req, res) {
  var b = req.body || {};
  var dates = Array.isArray(b.dates) && b.dates.length ? b.dates : [b.date];
  dates = dates.filter(function (x) { return isDate(x); });
  if (!dates.length) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
  if (!isTime(b.start) || !isTime(b.end)) return res.status(400).json({ error: '시간을 확인해 주세요. (예: 09:00)' });
  if (b.end <= b.start) return res.status(400).json({ error: '끝 시간이 시작 시간보다 빨라요.' });
  if (b.flex !== undefined && !Slots.isFlex(b.flex)) return res.status(400).json({ error: FLEX_ERROR });

  var d = store.load();
  var isMaster = req.session.role === 'master';
  var known = d.room.teachers.map(function (t) { return t.id; });
  // 선생님이 적는 수업의 담당은 본인, 또는 본인과 담당자다. 남을 담당으로 넣어 보내와도
  // 받지 않는다 — 화면에서 막는 것이 아니라 여기서 값을 정한다.
  var teacherIds = isMaster
    ? (Array.isArray(b.teacherIds) ? b.teacherIds : []).filter(function (id) { return known.indexOf(id) >= 0; })
    : ownTeacherIds(b.teacherIds, req.session.teacherId);

  // 회차 묶음. 한 번에 여러 날짜를 만들면 그것이 하나의 묶음이고, 한 날짜만 만들어도
  // 자기만의 묶음이다(나중에 [+ 날짜 추가] 로 회차를 붙일 수 있다).
  // seriesId 를 들고 오면 이미 있는 묶음에 붙이는 것이다 — 남의 묶음에는 붙이지 못한다.
  //
  // 붙일 수 있는 기준은 고치기와 같다: **묶음 안에 내가 담당인 회차가 하나라도 있으면**
  // 그 묶음은 내 수업이다. 담당이 섞인 묶음(내가 몇 회차만 맡은 연속 수업)에서
  // 전부 내 것이어야 한다고 막으면, 정작 그 수업을 하는 사람이 회차를 더하지 못한다.
  // 내 담당이 아닌 회차는 여기서 손대지 않으므로 그 수만 skipped 로 알려 준다.
  var seriesId = store.genId('s');
  var skippedMembers = 0;
  if (b.seriesId) {
    var key = String(b.seriesId);
    var members = d.programs.filter(function (x) { return Slots.seriesKeyOf(x) === key; });
    if (!members.length) return res.status(404).json({ error: '그 수업 묶음을 찾지 못했어요.' });
    var mine = members.filter(function (x) { return canEditProgram(req.session, x); });
    if (!mine.length) return res.status(403).json({ error: NOT_MINE });
    skippedMembers = members.length - mine.length;
    seriesId = key;
    // 회차를 더할 때 담당은 **묶음에서 물려받는다**(보내온 값은 쓰지 않는다).
    // 여기서 보내온 값을 쓰면, 담당이 여럿인 묶음에 한 사람이 회차를 더했을 때
    // 그 날짜만 담당이 줄어 다른 선생님 달력에서 사라진다. 회차를 더한 것이지
    // 배정을 바꾼 것이 아니다 — 배정을 바꾸려면 고치기 폼에서 담당을 고친다.
    // 어느 회차를 따를지는 **날짜가 가장 빠른 회차**로 정한다(같은 날이면 id 순).
    // 늘 같은 답이 나와야 회차를 더할 때마다 담당이 달라지지 않는다.
    var head = members.slice().sort(function (a, x) {
      if (a.date !== x.date) return a.date < x.date ? -1 : 1;
      return a.id < x.id ? -1 : 1;
    })[0];
    teacherIds = (head.teacherIds || []).filter(function (id) { return known.indexOf(id) >= 0; });
  }

  // 예정 목록에서 잡은 수업이면 어느 plan 에서 왔는지 들고 간다.
  // 사이에 그 plan 이 지워졌다면 조용히 빈 값으로 둔다 — 수업 자체는 만들어져야 한다.
  // 선생님에게는 예정 목록 자체가 없으므로 planId 를 보내와도 담지 않는다.
  var planId = '';
  if (isMaster && b.planId) {
    var pl = d.room.plans.filter(function (x) { return x.id === b.planId; })[0];
    if (pl) planId = pl.id;
  }

  var made = dates.map(function (date) {
    var p = {
      id: store.genId('p'),
      date: date,
      start: b.start,
      end: b.end,
      title: clean(b.title, 80) || '디지털새싹 수업',
      teacherIds: teacherIds,
      visibility: b.visibility === 'all' ? 'all' : 'assigned',
      memo: clean(b.memo, 500),
      flex: Slots.isFlex(b.flex) ? b.flex : 'unknown',
      createdBy: isMaster ? 'master' : req.session.teacherId,
      updatedBy: isMaster ? 'master' : req.session.teacherId,
      seriesId: seriesId,
      updatedAt: nowIso()
    };
    if (planId) p.planId = planId;
    return p;
  });
  d.programs = d.programs.concat(made);
  store.save(d);
  res.json({ ok: true, created: made, skipped: skippedMembers });
});

app.put('/api/programs/:id', requireAuth, function (req, res) {
  var d = store.load();
  var p = d.programs.filter(function (x) { return x.id === req.params.id; })[0];
  if (!p) return res.status(404).json({ error: '그 수업을 찾지 못했어요.' });
  if (!canEditProgram(req.session, p)) return res.status(403).json({ error: NOT_MINE });
  var b = req.body || {};

  // 어디에 적을지 먼저 정한다. applyToSeries 는 **날짜만 빼고** 묶음 전체에 적는다 —
  // 회차의 날짜는 회차마다 다른 것이 당연하므로 함께 옮기면 묶음이 한 날에 겹친다.
  //
  // 묶음에 내 담당이 아닌 회차가 섞여 있으면 **그 회차만 건너뛰고 나머지에 적는다.**
  // 통째로 되돌리면 고칠 수 있는 회차까지 못 고치고, 말없이 다 고치면 남의 회차를
  // 건드린다. 몇 개를 건너뛰었는지는 skipped 로 돌려 준다 — 조용히 넘어가지 않는다.
  var targets = [p];
  var skipped = 0;
  if (b.applyToSeries) {
    var key = Slots.seriesKeyOf(p);
    var members = d.programs.filter(function (x) { return Slots.seriesKeyOf(x) === key; });
    targets = members.filter(function (x) { return canEditProgram(req.session, x); });
    skipped = members.length - targets.length;
  }

  // 값은 **모두 검사한 뒤에** 한꺼번에 적는다. 중간에 되돌아가면 일부 회차만 바뀐 채
  // 남고, 되돌린 응답을 받은 사람은 아무것도 안 바뀐 줄 안다.
  if (b.flex !== undefined && !Slots.isFlex(b.flex)) return res.status(400).json({ error: FLEX_ERROR });
  if (b.date !== undefined && !isDate(b.date)) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
  if (b.start !== undefined && !isTime(b.start)) return res.status(400).json({ error: '시간을 확인해 주세요.' });
  if (b.end !== undefined && !isTime(b.end)) return res.status(400).json({ error: '시간을 확인해 주세요.' });
  var badTime = targets.some(function (x) {
    var s = (b.start !== undefined) ? b.start : x.start;
    var e = (b.end !== undefined) ? b.end : x.end;
    return e <= s;
  });
  if (badTime) return res.status(400).json({ error: '끝 시간이 시작 시간보다 빨라요.' });

  var known = d.room.teachers.map(function (t) { return t.id; });
  targets.forEach(function (x) {
    if (b.start !== undefined) x.start = b.start;
    if (b.end !== undefined) x.end = b.end;
    if (b.title !== undefined) x.title = clean(b.title, 80) || '디지털새싹 수업';
    if (b.memo !== undefined) x.memo = clean(b.memo, 500);
    if (b.visibility !== undefined) x.visibility = b.visibility === 'all' ? 'all' : 'assigned';
    if (b.flex !== undefined) x.flex = b.flex;
    // 담당 목록은 **담당자만** 바꾼다. 선생님이 보내와도 여기서 그냥 지나간다 —
    // 되돌리지 않는 이유는, 담당을 바꾸려던 것이 아니라 폼이 들고 있던 값을 그대로
    // 실어 보낸 것이기 때문이다. 대신 화면 쪽에서 그 칸을 만질 수 없게 해 둔다.
    if (Array.isArray(b.teacherIds) && req.session.role === 'master') {
      x.teacherIds = b.teacherIds.filter(function (id) { return known.indexOf(id) >= 0; });
    }
    x.updatedBy = req.session.teacherId;
    x.updatedAt = nowIso();
  });
  if (b.date !== undefined) p.date = b.date;   // 날짜는 이 회차만
  store.save(d);
  res.json({
    ok: true,
    program: shapeProgram(p, req.session.role === 'master'),
    updated: targets.length,
    skipped: skipped
  });
});

// 조율 등급만 바꾼다. **본인이 담당인 수업이면 담당자가 잡아 준 것이라도** 바꿀 수 있다 —
// "이 수업은 옮겨도 돼요" 는 그 수업을 맡은 선생님만 아는 사실이기 때문이다.
app.patch('/api/programs/:id/flex', requireAuth, function (req, res) {
  var d = store.load();
  var p = d.programs.filter(function (x) { return x.id === req.params.id; })[0];
  if (!p) return res.status(404).json({ error: '그 수업을 찾지 못했어요.' });
  if (req.session.role !== 'master' && (p.teacherIds || []).indexOf(req.session.teacherId) < 0) {
    return res.status(403).json({ error: '내가 담당인 수업만 표시할 수 있어요.' });
  }
  var b = req.body || {};
  if (!Slots.isFlex(b.flex)) return res.status(400).json({ error: FLEX_ERROR });
  p.flex = b.flex;
  p.updatedBy = req.session.teacherId;
  p.updatedAt = nowIso();
  store.save(d);
  res.json({ ok: true, program: shapeProgram(p, req.session.role === 'master') });
});

// 묶음 통째로 지우기. 회차가 열 번이면 열 번 확인을 누르게 하지 않는다.
// :seriesId 는 진짜 seriesId 이거나, 옛 자료의 지어낸 열쇠(~제목|담당|시작)다.
app.delete('/api/programs/series/:seriesId', requireAuth, function (req, res) {
  var d = store.load();
  var key = String(req.params.seriesId);
  var members = d.programs.filter(function (x) { return Slots.seriesKeyOf(x) === key; });
  if (!members.length) return res.status(404).json({ error: '그 수업 묶음을 찾지 못했어요.' });
  // 지우기는 고치기와 기준이 다르다 — 묶음을 통째로 지우려면 **전부 내가 만든 것**이어야
  // 한다. 담당이라는 이유로 남이 만든 회차까지 함께 지우면 되돌릴 길이 없다.
  if (!members.every(function (x) { return canDeleteProgram(req.session, x); })) {
    return res.status(403).json({ error: NOT_MADE });
  }
  var ids = {};
  members.forEach(function (x) { ids[x.id] = true; });
  d.programs = d.programs.filter(function (x) { return !ids[x.id]; });
  store.save(d);
  res.json({ ok: true, deleted: members.length });
});

app.delete('/api/programs/:id', requireAuth, function (req, res) {
  var d = store.load();
  var p = d.programs.filter(function (x) { return x.id === req.params.id; })[0];
  if (!p) return res.status(404).json({ error: '그 수업을 찾지 못했어요.' });
  if (!canDeleteProgram(req.session, p)) return res.status(403).json({ error: NOT_MADE });
  d.programs = d.programs.filter(function (x) { return x.id !== req.params.id; });
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
  // 시간대는 빠져 있으면 종일. 엉뚱한 값이면 조용히 종일로 바꾸지 않고 되돌린다 —
  // 오전만 안 된다고 적었는데 종일로 저장되면 그 선생님의 하루가 통째로 막힌다.
  var slot = (b.slot === undefined || b.slot === null || b.slot === '') ? 'all' : b.slot;
  if (!Slots.isSlot(slot)) {
    return res.status(400).json({ error: '시간대는 종일·오전·오후 중에서 골라 주세요.' });
  }
  // 공개 범위도 마찬가지다. 빠져 있으면 가장 좁은 쪽(나와 담당자만)으로 두되,
  // 엉뚱한 값이면 조용히 좁히지 않고 되돌린다 — 어느 쪽으로 조용히 정해도 사고가 된다.
  var vis = (b.visibility === undefined || b.visibility === null || b.visibility === '') ? 'private' : b.visibility;
  if (!Slots.isVis(vis)) {
    return res.status(400).json({ error: VIS_ERROR });
  }

  var d = store.load();
  if (!d.room.teachers.some(function (t) { return t.id === target; })) {
    return res.status(400).json({ error: '명단에 없는 선생님이에요.' });
  }
  // 한 사람의 하루에는 한 장이다. 이미 적어 둔 것이 있으면 새로 쌓지 않고 고쳐 쓴다 —
  // '오전' 이라 적었다가 '종일' 로 바꾸는 것은 새 기록이 아니라 같은 말의 정정이다.
  var memo = clean(b.memo, 100);   // 빈 값이어도 된다. 이유를 요구하지 않는다.
  var mine = d.blocks.filter(function (x) { return x.date === b.date && x.teacherId === target; });
  if (mine.length > 0) {
    mine.forEach(function (x, i) { if (i > 0) x._drop = true; });   // 옛 중복은 이참에 하나로
    var keep = mine[0];
    keep.slot = slot;
    keep.memo = memo;
    keep.visibility = vis;
    keep.updatedAt = nowIso();
    d.blocks = d.blocks.filter(function (x) { return !x._drop; });
    store.save(d);
    return res.json({ ok: true, replaced: true, block: keep });
  }

  var made = {
    id: store.genId('b'),
    date: b.date,
    teacherId: target,
    slot: slot,
    memo: memo,
    visibility: vis,
    updatedAt: nowIso()
  };
  d.blocks.push(made);
  store.save(d);
  res.json({ ok: true, replaced: false, block: made });
});

// 적어 둔 것을 고친다. 지웠다 다시 적게 하면 그 사이에 담당자가 본 화면이 어긋난다.
app.put('/api/blocks/:id', requireAuth, function (req, res) {
  var b = req.body || {};
  var d = store.load();
  var target = d.blocks.filter(function (x) { return x.id === req.params.id; })[0];
  if (!target) return res.status(404).json({ error: '그 기록을 찾지 못했어요.' });
  if (req.session.role !== 'master' && target.teacherId !== req.session.teacherId) {
    return res.status(403).json({ error: '내가 적은 것만 고칠 수 있어요.' });
  }
  // 값은 **모두 검사한 뒤에** 한꺼번에 적는다. 중간에 되돌아가면 반만 바뀐 기록이 남고,
  // 되돌린 응답을 받은 사람은 아무것도 안 바뀐 줄 안다.
  if (b.slot !== undefined && !Slots.isSlot(b.slot)) {
    return res.status(400).json({ error: '시간대는 종일·오전·오후 중에서 골라 주세요.' });
  }
  if (b.visibility !== undefined && !Slots.isVis(b.visibility)) {
    return res.status(400).json({ error: VIS_ERROR });
  }
  if (b.date !== undefined && b.date !== target.date) {
    if (!isDate(b.date)) return res.status(400).json({ error: '날짜를 확인해 주세요.' });
    // 한 사람의 하루에는 한 장이다. 옮겨 갈 날에 이미 적어 둔 것이 있으면 말없이 합치지
    // 않는다 — 두 장의 메모 중 어느 것을 살릴지는 사람이 정할 일이다.
    var busy = d.blocks.some(function (x) {
      return x.id !== target.id && x.teacherId === target.teacherId && x.date === b.date;
    });
    if (busy) {
      return res.status(400).json({ error: '그날에는 이미 적어 둔 게 있어요. 그걸 고치시거나 먼저 지워 주세요.' });
    }
    target.date = b.date;
  }
  if (b.slot !== undefined) target.slot = b.slot;
  if (b.memo !== undefined) target.memo = clean(b.memo, 100);
  if (b.visibility !== undefined) target.visibility = b.visibility;
  delete target.title;          // 옛 형식이 남아 있었다면 여기서 정리된다
  target.updatedAt = nowIso();
  store.save(d);
  res.json({ ok: true, block: target });
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
  res.json({
    room: { name: d.room.name, schoolHolidays: d.room.schoolHolidays },
    teachers: d.room.teachers
  });
});

// 명단에서 뺀 선생님의 수업 배정·안 되는 날은 **지우지 않는다**.
// 입력된 응답은 지우지 않는다는 원칙이고, 화면에서는 '(삭제된 선생님)' 으로 보인다.
app.put('/api/settings', requireAuth, requireMaster, function (req, res) {
  var b = req.body || {};
  var d = store.load();
  if (b.room && typeof b.room.name === 'string') d.room.name = clean(b.room.name, 60) || d.room.name;

  // 학교 휴업일 — 날짜가 어긋나면 그 줄을 짚어 되돌린다(조용히 버리지 않는다)
  if (b.room && Array.isArray(b.room.schoolHolidays)) {
    var badDay = -1;
    b.room.schoolHolidays.forEach(function (h, i) {
      if (badDay < 0 && !isDate(h && h.date)) badDay = i;
    });
    if (badDay >= 0) {
      return res.status(400).json({ error: '휴업일 날짜를 확인해 주세요. (예: 2026-10-06)', row: badDay, holidayRow: badDay });
    }
    // 같은 날짜가 두 번이면 나중 것이 앞 것을 조용히 덮는다 — 그 전에 알려 준다.
    var seenDay = {};
    var dupDay = -1;
    b.room.schoolHolidays.forEach(function (h, i) {
      if (dupDay < 0 && seenDay[h.date]) dupDay = i;
      seenDay[h.date] = true;
    });
    if (dupDay >= 0) {
      return res.status(400).json({ error: '같은 날짜가 두 번 있어요.', row: dupDay, holidayRow: dupDay });
    }
    d.room.schoolHolidays = b.room.schoolHolidays.map(function (h) {
      return { date: h.date, name: clean(h.name, 30) };
    }).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
  }

  if (Array.isArray(b.teachers)) {
    // 뒷자리는 자르지 않는다. 5자리를 4자리로 몰래 깎으면 그 선생님은 자기가 받은
    // 번호로 들어오지 못하고, 왜 안 되는지도 알 수 없다. 어긋나면 그 줄을 짚어 되돌린다.
    var bad = -1;
    b.teachers.forEach(function (t, i) {
      if (bad >= 0) return;
      if (t && t.id === 'master') return;          // 담당자 코드는 배포 설정에서 정한다
      var raw = String((t && t.code) || '').trim();
      // 빈 칸은 허용한다 — 이름만 먼저 적어 두고 CODE 는 나중에 받을 수 있다.
      // (빈 CODE 로는 로그인 매칭에 걸리지 않는다)
      if (raw !== '' && !/^\d{4}$|^\d{6}$/.test(raw)) bad = i;
    });
    if (bad >= 0) {
      return res.status(400).json({ error: '뒷자리는 4자리 또는 6자리 숫자로 입력해 주세요.', row: bad });
    }

    var seen = {};
    var next = [];
    // 색은 '아직 안 쓴 팔레트 색' 부터 준다. 앞에서부터 채워 나가므로 같은 색이 겹치지 않는다.
    var used = b.teachers.map(function (t) { return t && t.color; }).filter(Boolean);
    function freeColor() {
      for (var k = 0; k < store.PALETTE.length; k++) {
        if (used.indexOf(store.PALETTE[k]) < 0) return store.PALETTE[k];
      }
      return store.PALETTE[used.length % store.PALETTE.length];
    }
    var oldById = {};
    d.room.teachers.forEach(function (t) { oldById[t.id] = t; });
    b.teachers.forEach(function (t) {
      var id = (t && t.id) || store.genId('t');
      if (seen[id]) return;             // 같은 id 가 두 번 오면 뒤엣것은 버린다
      seen[id] = true;
      var color = (t && t.color) || freeColor();
      if (used.indexOf(color) < 0) used.push(color);
      var row = {
        id: id,
        name: clean(t && t.name, 20),
        cls: clean(t && t.cls, 10),
        code: id === 'master' ? '' : String((t && t.code) || '').trim(),
        color: color
      };
      // 사람 등급(grade)은 v2.3부터 쓰지 않는다. 보내오는 값은 받지 않고,
      // 파일에 남아 있던 옛 값만 그대로 지고 간다 — 쓰지 않는다고 지우지는 않는다.
      var old = oldById[id];
      if (old && old.grade !== undefined) row.grade = old.grade;
      next.push(row);
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

  res.json({
    ok: true,
    room: { name: d.room.name, schoolHolidays: d.room.schoolHolidays },
    teachers: d.room.teachers,
    duplicateIds: dupes
  });
});

// 로그인 화면에 방 이름을 띄우기 위한 것. 이름 말고는 아무것도 내보내지 않는다.
app.get('/api/room', function (req, res) {
  res.json({
    name: store.load().room.name,
    version: VERSION,
    holidays: Holidays.LIST,                       // 내장 공휴일(화면이 달력에 칠한다)
    provisionalYears: Holidays.PROVISIONAL_YEARS,  // 아직 확정 전인 해
    confirmedYears: Holidays.CONFIRMED_YEARS
  });
});

// ===== 상태 확인 =====
app.get('/api/health', function (req, res) {
  var d = store.load();
  res.json({
    ok: !store.isDamaged(),
    version: VERSION,
    dataPath: path.resolve(store.DATA_FILE),
    fileExists: store.fileExists(),
    masterCodeValid: MASTER_CODE_VALID,
    // 담당자(master)는 명단에 늘 한 줄 있지만 '등록한 선생님' 수에는 넣지 않는다.
    // 이 숫자는 담당자가 몇 분을 등록했는지 확인하려고 보는 값이다.
    teachers: d.room.teachers.filter(function (t) { return t.id !== 'master'; }).length,
    plans: d.room.plans.length,
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
