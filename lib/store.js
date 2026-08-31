'use strict';
// 데이터 저장소 — school-device-inspector\server.js 의 저장 모듈을 그대로 옮겨 왔다.
// 원칙은 하나다: **입력된 응답은 절대 조용히 사라지지 않는다.**
//   · 원자적 쓰기(tmp → fsync → rename)라 쓰다가 죽어도 기존 파일이 온전하다
//   · rename 직전에 직전 세대를 .bak 으로 1벌 남긴다
//   · 읽기에 실패하면 빈 값으로 넘어가지 않는다. 손상본을 .corrupt-<시각> 으로 보존하고
//     로그를 남긴 뒤 .bak 으로 복구를 시도한다. 그래도 안 되면 '손상' 상태로 표시하고
//     기동 시 절대 덮어쓰지 않는다(빈 데이터로 볼륨을 지우는 사고를 막는다).
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// DATA_DIR: 환경변수 우선(DATA_DIR 또는 RAILWAY_VOLUME_MOUNT_PATH), 없으면 ./data
var DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('DATA_DIR 생성 실패: ' + e.message); }
}
var DATA_FILE = path.join(DATA_DIR, 'data.json');
var DATA_TMP = DATA_FILE + '.tmp';   // 원자적 쓰기용(같은 파일시스템이어야 rename 이 원자적)
var DATA_BAK = DATA_FILE + '.bak';   // 직전 세대 1벌

var dataDamaged = false;      // 읽었는데 못 쓰는 파일 + 백업 복구도 실패
var corruptPreserved = false; // 손상본 보존은 한 번만(같은 오류로 파일이 쌓이지 않게)
var loadFailLogged = 0;

// 선생님 색 팔레트 — 화면의 색 고르개와 같은 목록을 쓴다(public/shared/palette.js).
var PALETTE = require('../public/shared/palette.js').COLORS;

// 조율 등급. 담당자만 본다.
// 옛 파일에는 이 칸이 없다 — 마이그레이션으로 파일을 고치지 않고 **읽을 때 기본값**으로 채운다.
var GRADES = ['free', 'some', 'hard', 'unknown'];
function normGrade(g) { return GRADES.indexOf(g) >= 0 ? g : 'unknown'; }

function genId(prefix) { return prefix + '_' + crypto.randomBytes(5).toString('hex'); }

// 파일 하나를 읽어 파싱까지 시도한다. 실패 사유·크기를 그대로 담아 돌려준다(조용히 삼키지 않는다).
function readDataFile(file) {
  var out = { ok: false, data: null, raw: null, size: -1, err: null, missing: false };
  try { out.raw = fs.readFileSync(file, 'utf8'); out.size = Buffer.byteLength(out.raw); }
  catch (e) { out.err = e; out.missing = (e.code === 'ENOENT'); return out; }
  try {
    var d = JSON.parse(out.raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('최상위가 객체가 아닙니다');
    out.data = d; out.ok = true;
  } catch (e) { out.err = e; }
  return out;
}

// 손상본을 data.json.corrupt-<시각> 으로 남긴다. 덮어쓰기 전에 반드시 부른다.
function preserveCorrupt(raw) {
  if (corruptPreserved) return null;
  corruptPreserved = true;
  var d = new Date();
  var stamp = d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  var p = DATA_FILE + '.corrupt-' + stamp;
  // 같은 날 두 번째 손상이면 뒤에 시각을 붙여 앞의 것을 덮지 않는다
  if (fs.existsSync(p)) p += '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  try {
    if (raw != null) fs.writeFileSync(p, raw); else fs.copyFileSync(DATA_FILE, p);
    pruneCorrupt();
    return p;
  } catch (e) { console.error('[데이터] 손상 파일 보존 실패: ' + e.message); return null; }
}

// 손상본은 최근 3개만 남긴다. 볼륨이 오래 돌면 이 파일들이 계속 쌓이기 때문이다.
var KEEP_CORRUPT = 3;
function pruneCorrupt() {
  try {
    var base = path.basename(DATA_FILE) + '.corrupt-';
    var files = fs.readdirSync(DATA_DIR)
      .filter(function (f) { return f.indexOf(base) === 0; })
      .map(function (f) {
        var full = path.join(DATA_DIR, f);
        var st = null; try { st = fs.statSync(full); } catch (e) {}
        return { f: f, full: full, at: st ? st.mtimeMs : 0 };
      })
      .sort(function (a, b) { return b.at - a.at; });   // 최신이 앞
    var old = files.slice(KEEP_CORRUPT);
    old.forEach(function (x) { try { fs.unlinkSync(x.full); } catch (e) {} });
    if (old.length) {
      console.log('[데이터] 오래된 손상본 ' + old.length + '개를 지웠습니다 (최근 ' + KEEP_CORRUPT + '개만 남깁니다).');
    }
  } catch (e) { console.error('[데이터] 손상본 정리 실패: ' + e.message); }
}

// 원자적 쓰기 — 임시 파일에 쓰고 fsync 로 디스크까지 내린 뒤 rename 한다.
// 쓰기 도중 프로세스가 죽어도(재배포 SIGKILL 등) 기존 data.json 은 온전히 남는다.
function writeDataFile(data) {
  var json = JSON.stringify(data, null, 2);
  var fd = fs.openSync(DATA_TMP, 'w');
  try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_BAK); }
  catch (e) { console.error('[데이터] 백업(.bak) 보관 실패: ' + e.message); }
  fs.renameSync(DATA_TMP, DATA_FILE);
}

// 빠진 칸을 채운다. 마스터는 명단에 항상 한 줄로 존재한다(id 고정 'master').
// 마스터의 code 는 파일에 두지 않는다 — 환경변수 MASTER_CODE 를 쓴다.
function ensureShape(d) {
  d = d || {};
  if (!d.room || typeof d.room !== 'object') d.room = {};
  if (typeof d.room.name !== 'string' || !d.room.name) d.room.name = '디지털새싹 일정판';
  if (!Array.isArray(d.room.teachers)) d.room.teachers = [];
  if (!Array.isArray(d.programs)) d.programs = [];
  if (!Array.isArray(d.blocks)) d.blocks = [];

  var hasMaster = d.room.teachers.some(function (t) { return t && t.id === 'master'; });
  if (!hasMaster) {
    d.room.teachers.unshift({ id: 'master', name: '담당 선생님', cls: '', code: '', color: PALETTE[0] });
  }
  d.room.teachers = d.room.teachers.map(function (t, i) {
    return {
      id: (t && t.id) || genId('t'),
      name: String((t && t.name) || ''),
      cls: String((t && t.cls) || ''),
      code: (t && t.id === 'master') ? '' : String((t && t.code) || ''),
      color: (t && t.color) || PALETTE[i % PALETTE.length],
      grade: normGrade(t && t.grade)
    };
  });
  return d;
}

function emptyData() { return ensureShape({}); }

// 읽기. 손상이면 보존 → .bak 복구 시도 → 그래도 안 되면 '손상' 표시.
function load() {
  var r = readDataFile(DATA_FILE);
  if (r.ok) return ensureShape(r.data);
  if (r.missing) return emptyData();   // 아직 파일이 없는 첫 기동 — 손상이 아니다

  // 여기부터는 "읽었는데 못 쓰는 파일"이다. 조용히 빈 값으로 넘어가면
  // 바로 다음 저장이 볼륨을 통째로 지운다 — 반드시 남기고 보존한 뒤 백업 복구를 시도한다.
  if (loadFailLogged < 3) {
    loadFailLogged++;
    console.error('[데이터] 경고: 저장 파일을 읽지 못했습니다 — ' + ((r.err && r.err.message) || '알 수 없는 오류') +
      ' | 크기 ' + r.size + '바이트 | 경로 ' + path.resolve(DATA_FILE));
  }
  var kept = preserveCorrupt(r.raw);
  if (kept) console.error('[데이터] 손상 파일을 ' + path.basename(kept) + ' 로 보존했습니다.');

  var bak = readDataFile(DATA_BAK);
  if (bak.ok) {
    var recovered = ensureShape(bak.data);
    try {
      writeDataFile(recovered);
      corruptPreserved = false;   // 복구했으니 다음 손상도 다시 보존한다
      dataDamaged = false;
      console.error('[데이터] 직전 백업(.bak)이 정상이라 그것으로 복구했습니다.');
    } catch (e) { console.error('[데이터] 백업 복구 저장 실패: ' + e.message); }
    return recovered;
  }
  dataDamaged = true;
  console.error('[데이터] 경고: 백업(.bak)으로도 복구할 수 없습니다. 빈 방으로 진행하되 손상 파일은 보존되어 있습니다. 덮어쓰지 않습니다.');
  return emptyData();
}

function save(data) {
  writeDataFile(data);
  dataDamaged = false;   // 정상적으로 한 벌 써 넣었으므로 손상 상태는 해소된다
}

// 기동 로그 1회 — 경로·파일 유무·건수를 눈으로 확인할 수 있게 찍는다.
function bootLog() {
  var r = readDataFile(DATA_FILE);
  var mode;
  if (r.missing) mode = '파일 없음 — 빈 방으로 시작';
  else if (r.ok) mode = '기존 파일 유지';
  else {
    console.error('[데이터] 경고: 저장 파일이 손상되었습니다 — ' + ((r.err && r.err.message) || '알 수 없는 오류') + ' | 크기 ' + r.size + '바이트');
    load();   // 손상본 보존 + 백업 복구까지 여기서 처리된다
    mode = dataDamaged ? '손상 감지 — 덮어쓰지 않음' : '손상 감지 — 백업(.bak)으로 복구';
  }
  var st = null; try { st = fs.statSync(DATA_FILE); } catch (e) {}
  var d = load();
  console.log('[데이터] 경로=' + path.resolve(DATA_FILE) +
    ' | 파일=' + (st ? ('있음 ' + st.size + '바이트') : '없음') +
    ' | 상태=' + mode +
    ' | 선생님=' + d.room.teachers.length + '명' +
    ' | 수업=' + d.programs.length + '건' +
    ' | 안 되는 날=' + d.blocks.length + '건');
}

module.exports = {
  DATA_DIR: DATA_DIR, DATA_FILE: DATA_FILE, DATA_TMP: DATA_TMP, DATA_BAK: DATA_BAK,
  PALETTE: PALETTE, GRADES: GRADES, normGrade: normGrade, genId: genId, pruneCorrupt: pruneCorrupt,
  load: load, save: save, bootLog: bootLog, emptyData: emptyData, ensureShape: ensureShape,
  isDamaged: function () { return dataDamaged; },
  fileExists: function () { return fs.existsSync(DATA_FILE); }
};
