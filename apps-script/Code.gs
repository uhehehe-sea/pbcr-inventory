/**
 * PBCR 자재 재고 — 구글 시트 API (Google Apps Script)
 * 화면(index.html)은 GitHub Pages에 있고, 이 스크립트는 JSON만 주고받는다.
 *
 * 시트 구성
 *   Items : row_id | sea_code | name | quantity | location | order_no | batch | note
 *           | body_material | diaphragm_material | material_note | memo | row_color | (실사 열: 10월8일 확인 …)
 *   row_color : 엑셀 다운로드 때 A~F열에 칠할 배경색(예: 92D050). 원본 엑셀의 차수별 색 구분을 그대로 유지한다.
 *   Log   : timestamp | user | row_id | sea_code | name | change | after_qty | note
 *   Users : name
 *   Images: sea_code | name | spec | category | confidence | source | file_id
 *           (image_tags.csv를 가져온 것. file_id는 syncImages()가 드라이브 폴더를 보고 채운다)
 *
 * 로그인·비밀번호 없음. 작업자는 첫 화면에서 자기 이름을 입력하고, 모든 변경에 그 이름이 기록된다.
 */

const SHEET_ITEMS = 'Items';
const SHEET_LOG = 'Log';
const SHEET_USERS = 'Users';
const SHEET_IMAGES = 'Images';
const ITEM_COLS = 13;

/* ---------- 최초 1회 실행 ---------- */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_ITEMS, ['row_id', 'sea_code', 'name', 'quantity', 'location', 'order_no', 'batch', 'note',
    'body_material', 'diaphragm_material', 'material_note', 'memo', 'row_color']);
  ensureSheet_(ss, SHEET_LOG, ['timestamp', 'user', 'row_id', 'sea_code', 'name', 'change', 'after_qty', 'note']);
  ensureSheet_(ss, SHEET_IMAGES, ['sea_code', 'name', 'spec', 'category', 'confidence', 'source', 'file_id']);
  const users = ensureSheet_(ss, SHEET_USERS, ['name']);
  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 6, 1).setValues([['작업자1'], ['작업자2'], ['작업자3'], ['작업자4'], ['작업자5'], ['작업자6']]);
  }
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ---------- API 진입점 ---------- */
// 화면은 text/plain 본문으로 POST한다 (CORS 사전요청을 피하기 위해)
function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (_) {}
  return json_(handle_(req));
}

function doGet() {
  return json_({ ok: true, message: 'PBCR 재고 API가 동작 중입니다.' });
}

function handle_(req) {
  try {
    switch (req.action) {
      case 'init':   return { ok: true, items: getItems_(), users: getUsers_(), logs: getRecentLogs_(30) };
      case 'items':  return { ok: true, items: getItems_(), logs: getRecentLogs_(30) };
      case 'update': return Object.assign({ ok: true }, updateQuantity_(req.user, req.rid, req.change, req.note));
      case 'export': return Object.assign({ ok: true }, getExportData_());
      default:       return { ok: false, error: '알 수 없는 요청입니다.' };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 공통 ---------- */
// 시트가 '1-2' 같은 위치 값을 날짜로 바꿔버린 경우 원래 글자로 되돌린다
function cellText_(v) {
  if (v instanceof Date) return (v.getMonth() + 1) + '-' + v.getDate();
  return v === null || v === undefined ? '' : String(v).trim();
}

/* ---------- 조회 ---------- */
function getItems_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ITEMS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const imgs = getImageMap_();
  return sh.getRange(2, 1, last - 1, ITEM_COLS).getValues()
    .filter(r => r[0] !== '')
    .map(r => {
      const code = String(r[1]).trim(), im = imgs[code.toUpperCase()] || {};
      return {
        rid: String(r[0]), code: code, name: String(r[2]), qty: Number(r[3]) || 0,
        location: cellText_(r[4]), order: String(r[5]), batch: String(r[6]),
        memo: [r[11], r[10]].map(String).filter(Boolean).join(' | '),
        img: im.id || '', conf: im.conf || '', src: im.src || ''
      };
    });
}

/* ---------- 이미지 ---------- */
// Images 시트 → { 'IP00081234': {id, conf, src} }
function getImageMap_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_IMAGES);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(r => {
    const code = cellText_(r[0]).toUpperCase();
    if (!code) return;
    const cur = map[code];
    const next = { id: cellText_(r[6]), conf: cellText_(r[4]), src: cellText_(r[5]) };
    if (!cur || (!cur.id && next.id)) map[code] = next;   // 같은 코드가 여러 줄이면 파일이 있는 쪽 우선
  });
  return map;
}

/**
 * 이미지 동기화 (이미지를 추가·교체한 뒤 편집기에서 직접 실행)
 * 스크립트 속성 IMAGE_FOLDER_ID 폴더의 {SEA-CODE}.jpg 파일을 찾아 Images 시트 file_id를 채우고,
 * 파일을 "링크가 있는 사용자 보기"로 공유한다. 결과 요약은 실행 로그에 남는다.
 */
function syncImages() {
  const folderId = PropertiesService.getScriptProperties().getProperty('IMAGE_FOLDER_ID');
  if (!folderId) throw new Error('스크립트 속성 IMAGE_FOLDER_ID에 이미지 폴더 ID를 넣으세요.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_IMAGES, ['sea_code', 'name', 'spec', 'category', 'confidence', 'source', 'file_id']);

  // 1) 폴더의 이미지 → 코드별 파일 ID (같은 코드가 여러 장이면 가장 최근 것)
  const files = {}, it = DriveApp.getFolderById(folderId).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/^image\//.test(f.getMimeType())) continue;
    const code = f.getName().replace(/\.[^.]+$/, '').trim().toUpperCase();
    if (!files[code] || f.getLastUpdated() > files[code].getLastUpdated()) files[code] = f;
  }
  Object.keys(files).forEach(code => {
    try { files[code].setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
  });

  // 2) Items에 있는 코드
  const itemSh = ss.getSheetByName(SHEET_ITEMS);
  const itemCodes = {};
  if (itemSh.getLastRow() > 1) itemSh.getRange(2, 2, itemSh.getLastRow() - 1, 1).getValues()
    .forEach(r => { const c = cellText_(r[0]).toUpperCase(); if (c && c !== '-') itemCodes[c] = true; });

  // 3) Images 시트 갱신: 기존 줄은 file_id만 고치고, 태그 없이 새로 들어온 사진은 '실물사진'으로 추가
  const last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 7).getValues();
  const seen = {};
  rows.forEach(r => {
    const code = cellText_(r[0]).toUpperCase();
    seen[code] = true;
    r[6] = files[code] ? files[code].getId() : '';
    if (files[code] && cellText_(r[4]) === '이미지 없음') r[4] = '실물사진';
  });
  Object.keys(files).forEach(code => {
    if (!seen[code]) rows.push([code, '', '', '', '실물사진', '현장 촬영', files[code].getId()]);
  });
  if (rows.length) sh.getRange(2, 1, rows.length, 7).setValues(rows);

  const unmatched = Object.keys(files).filter(c => !itemCodes[c]);
  const missing = Object.keys(itemCodes).filter(c => !files[c]);
  const msg = `이미지 ${Object.keys(files).length}장 연결, 품목 코드 ${Object.keys(itemCodes).length}종 중 사진 없음 ${missing.length}종` +
              (unmatched.length ? `\nItems에 없는 코드의 파일: ${unmatched.join(', ')}` : '');
  Logger.log(msg);
  return msg;
}

function getUsers_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])).filter(Boolean);
}

function getRecentLogs_(n) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const count = Math.min(n || 30, last - 1);
  const tz = Session.getScriptTimeZone();
  return sh.getRange(last - count + 1, 1, count, 8).getValues().reverse().map(r => ({
    time: Utilities.formatDate(new Date(r[0]), tz, 'MM/dd HH:mm'),
    user: String(r[1]), code: String(r[3]), name: String(r[4]),
    change: Number(r[5]), after: Number(r[6]), note: String(r[7] || '')
  }));
}

/* ---------- 수량 변경 ---------- */
function updateQuantity_(user, rowId, change, note) {
  change = Number(change);
  user = String(user || '').trim().slice(0, 30);
  if (!user) throw new Error('이름을 먼저 입력하세요.');
  if (!change || !Number.isInteger(change)) throw new Error('변동 수량은 0이 아닌 정수여야 합니다.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // 동시에 눌러도 수량이 꼬이지 않도록
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_ITEMS);
    const last = sh.getLastRow();
    const ids = sh.getRange(2, 1, Math.max(last - 1, 1), 1).getValues().map(r => String(r[0]));
    const idx = ids.indexOf(String(rowId));
    if (idx === -1) throw new Error('해당 품목을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');

    const row = idx + 2;
    const vals = sh.getRange(row, 1, 1, 4).getValues()[0];
    const code = String(vals[1]).trim(), name = String(vals[2]);
    const current = Number(vals[3]) || 0, after = current + change;
    if (after < 0) throw new Error('재고가 부족합니다. 현재 ' + current + '개입니다.');

    sh.getRange(row, 4).setValue(after);
    ss.getSheetByName(SHEET_LOG).appendRow([new Date(), String(user), String(rowId), code, name, change, after, String(note || '')]);
    SpreadsheetApp.flush();
    return { rid: String(rowId), qty: after, code: code };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 엑셀 다운로드용 (원본 Total 양식) ---------- */
function getExportData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_ITEMS);
  const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), ITEM_COLS);
  const all = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
  const extraHeads = all[0].slice(ITEM_COLS).map(String);

  const header = ['Contents', 'SEA-CODE', '규격', 'PBCR 수량', '위치', 'REMARK',
                  'Body 재질', 'Diaphragm 재질', '재질/비고', ''].concat(extraHeads);
  const body = all.slice(1).filter(r => r[0] !== '');
  const rows = body.map(r =>
    [cellText_(r[5]), cellText_(r[1]), cellText_(r[2]), Number(r[3]) || 0, cellText_(r[4]), cellText_(r[6]),
     cellText_(r[8]), cellText_(r[9]), cellText_(r[10]), cellText_(r[11])]
      .concat(r.slice(ITEM_COLS).map(cellText_)));
  const colors = body.map(r => cellText_(r[12]).replace('#', '').toUpperCase());

  const tz = Session.getScriptTimeZone();
  const logSh = ss.getSheetByName(SHEET_LOG);
  const logLast = logSh.getLastRow();
  const logs = logLast < 2 ? [] : logSh.getRange(2, 1, logLast - 1, 8).getValues().map(r =>
    [Utilities.formatDate(new Date(r[0]), tz, 'yyyy-MM-dd HH:mm'), cellText_(r[1]), cellText_(r[3]), cellText_(r[4]),
     Number(r[5]) || 0, Number(r[6]) || 0, cellText_(r[7])]);

  return {
    total: [header].concat(rows),
    colors: colors,
    log: [['일시', '작업자', 'SEA-CODE', '규격', '변동', '변동 후 수량', '메모']].concat(logs),
    stamp: Utilities.formatDate(new Date(), tz, 'yyMMdd')
  };
}
