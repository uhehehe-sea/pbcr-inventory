# PBCR 재고 웹앱 — 오프라인 모드 추가 작업 지시서

- 대상 레포: `uhehehe-sea/pbcr-inventory` (기존 레포 그대로 사용, 새 레포 만들지 않음)
- 주소: https://uhehehe-sea.github.io/pbcr-inventory/
- 데이터: 구글 시트 + 앱스 스크립트 API (Luna 관리)
- 요청자: 지석

---

## 1. 목표

창고에서 인터넷이 끊겨도
1. 앱이 열리고 메뉴·재고 목록이 보여야 한다.
2. 입고·출고·카운팅 기록이 폰에 저장되어야 한다.
3. 인터넷이 돌아오면 저장된 기록이 시트에 자동 전송되어야 한다 (중복 없이).

## 2. 지켜야 할 원칙

- 기존 화면 구성, 기존 시트 구조, 이름 등록 방식은 **바꾸지 않는다.** 오프라인 기능만 덧붙인다.
- 수량 기록은 **최종 개수가 아니라 변화량(delta)** 으로 보낸다. 예: 출고 2개 → `delta: -2`
- 모든 기록에 **고유 ID** 를 붙이고, 앱스 스크립트는 **이미 처리한 ID는 무시**한다.
- 기록 시각은 **버튼을 누른 시각(at)** 과 **서버 반영 시각** 을 둘 다 남긴다.
- 앱스 스크립트 API 응답은 서비스 워커로 캐시하지 않는다. 데이터 캐시는 IndexedDB에서만 한다.
- 아래 코드는 예시다. 파일명·함수명·시트명은 **현재 레포에 맞게 조정**하고, 기존 API 형식이 다르면 그 형식에 맞춘다.

---

## 3. 작업 목록

### 3-1. manifest.json 추가 (홈 화면 앱 설치용)

```json
{
  "name": "PBCR 재고",
  "short_name": "PBCR 재고",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1f2937",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

`index.html` `<head>`에 추가:

```html
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#1f2937">
<link rel="apple-touch-icon" href="icon-192.png">
```

### 3-2. sw.js 추가 (화면 오프라인 캐시)

레포 루트에 `sw.js` 생성. `SHELL` 목록은 실제 파일명으로 맞출 것.

```js
const CACHE = 'pbcr-v1';   // ★ 배포할 때마다 숫자 올리기 (5번 규칙 참고)
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon-192.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;          // 앱스 스크립트 API·외부 요청은 건드리지 않음

  if (e.request.mode === 'navigate') {                  // 페이지 열기: 온라인 우선, 실패 시 캐시
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
```

`app.js` 맨 앞에 등록:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
```

### 3-3. IndexedDB 헬퍼 (데이터 저장소)

```js
const DB_NAME = 'pbcr-inventory';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
```

### 3-4. 재고 목록 캐시 (메뉴가 안 뜨는 문제 해결)

현재 시트에서 목록·위치·메뉴·용어사전을 불러오는 함수를 아래처럼 감싼다.

```js
async function loadInventory() {
  try {
    const data = await fetchInventoryFromApi();        // 기존 API 호출 함수
    await idbSet('snapshot', { data, savedAt: new Date().toISOString() });
    setSyncLabel('방금 동기화');
    return data;
  } catch (err) {
    const snap = await idbGet('snapshot');
    if (snap) {
      setSyncLabel('오프라인 · 마지막 동기화 ' + formatTime(snap.savedAt));
      return snap.data;
    }
    showError('인터넷 연결 후 한 번 접속해 주세요 (저장된 데이터 없음)');
    return null;
  }
}
```

- 메뉴·드롭다운·용어사전 등 시트에서 받아오는 것은 **전부 snapshot에 포함**시킬 것.
- 아이템 이미지는 용량이 크면 캐시 대상에서 빼도 됨 (오프라인 시 이미지 자리에 회색 박스).

### 3-5. 기록 대기열 (오프라인 기록 → 자동 전송)

```js
function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// 입고·출고·카운팅 버튼은 모두 이 함수를 거치게 변경
async function record(action) {
  // action 예: { type: 'out', code: 'IP00021811', delta: -2, location: 'A-03', note: '' }
  const item = {
    ...action,
    id: newId(),
    user: getUserName(),                 // 기존 이름 등록값 사용
    at: new Date().toISOString()
  };
  const box = (await idbGet('outbox')) || [];
  box.push(item);
  await idbSet('outbox', box);
  applyLocally(item);                    // 화면 수량 즉시 반영 + snapshot에도 반영
  renderPendingBadge(box.length);
  flush();
}

let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine) return;
  const box = (await idbGet('outbox')) || [];
  if (!box.length) return;
  flushing = true;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // CORS preflight 회피
      body: JSON.stringify({ action: 'syncRecords', items: box })
    });
    const out = await res.json();
    if (out.ok) {
      const sent = new Set(out.accepted);
      const remain = ((await idbGet('outbox')) || []).filter((x) => !sent.has(x.id));
      await idbSet('outbox', remain);
      renderPendingBadge(remain.length);
      if (out.warnings && out.warnings.length) showWarnings(out.warnings);
      loadInventory();                   // 서버 최신값으로 다시 맞춤
    }
  } catch (e) {
    // 실패하면 그대로 두고 다음 기회에 재시도
  } finally {
    flushing = false;
  }
}

window.addEventListener('online', flush);
document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
setInterval(flush, 60 * 1000);
```

### 3-6. 앱스 스크립트 수정 (중복 방지 + 변화량 반영)

- 시트에 `SyncLog` 시트를 추가한다. (이미 기록 로그 시트가 있으면 그 시트에 `id` 열을 추가해서 사용)
- `SyncLog` 열: `id | 누른시각(at) | 반영시각 | 이름 | 종류 | SEA-CODE | 변화량 | 위치 | 비고 | 경고`

```js
function syncRecords(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActive();
    const log = ss.getSheetByName('SyncLog');
    const last = log.getLastRow();
    const done = new Set(
      last > 1 ? log.getRange(2, 1, last - 1, 1).getValues().flat() : []
    );

    const accepted = [];
    const warnings = [];

    items.forEach((it) => {
      if (done.has(it.id)) { accepted.push(it.id); return; }   // 이미 처리됨 → 무시
      const newQty = applyDelta(it.code, it.delta, it.location); // 기존 재고 시트 수량 += delta
      let warn = '';
      if (newQty < 0) {
        warn = '재고 음수 — 현장 확인 필요';
        warnings.push({ code: it.code, qty: newQty, user: it.user });
      }
      log.appendRow([it.id, it.at, new Date(), it.user, it.type, it.code,
                     it.delta, it.location || '', it.note || '', warn]);
      done.add(it.id);
      accepted.push(it.id);
    });

    return { ok: true, accepted, warnings };
  } finally {
    lock.releaseLock();
  }
}
```

기존 `doPost`에서 `action === 'syncRecords'`이면 위 함수로 연결하고, 결과를 JSON으로 반환:

```js
return ContentService.createTextOutput(JSON.stringify(result))
  .setMimeType(ContentService.MimeType.JSON);
```

- `applyDelta`는 기존 재고 시트에서 SEA-CODE(+위치)로 행을 찾아 수량에 delta를 더하는 함수. 기존 수량 수정 로직을 재사용할 것.
- 앱스 스크립트 수정 후 **배포(새 버전)** 해야 반영됨. 웹앱 URL이 바뀌면 `API_URL`도 갱신.

### 3-7. 화면 표시 추가

- 상단 상태 표시: `● 온라인` / `● 오프라인 · 마지막 동기화 10/14 09:30`
- 전송 대기 배지: `전송 대기 3건` (0건이면 숨김)
- 대기 건이 있을 때 "브라우저 데이터 삭제·앱 삭제 시 미전송 기록이 사라집니다" 안내 문구
- 서버에서 음수 재고 경고가 오면 팝업으로 표시

---

## 4. 테스트 체크리스트

- [ ] 온라인으로 한 번 접속 → 비행기 모드 → 앱 새로고침 시 화면·메뉴·목록이 뜬다
- [ ] 오프라인에서 출고 2건, 입고 1건 기록 → 배지 "전송 대기 3건" 표시
- [ ] 오프라인 상태에서 앱을 닫았다 다시 열어도 대기 3건이 유지된다
- [ ] 비행기 모드 해제 → 자동 전송 → 배지 사라짐 → 시트 수량·SyncLog 확인
- [ ] 같은 기록을 강제로 두 번 전송해도 시트에 한 번만 반영된다
- [ ] 폰 2대에서 동시에 오프라인 출고 → 둘 다 온라인 → 수량이 두 기록 모두 반영된 값
- [ ] 아이폰 Safari / 안드로이드 Chrome 둘 다 확인 (홈 화면에 추가한 상태 포함)
- [ ] 기존 기능(검색, 용어사전 검색, 이름 등록, 이미지 표시) 정상 동작

## 5. 앞으로의 배포 규칙

- 화면 파일(html/js/css)을 수정해서 배포할 때마다 `sw.js`의 `CACHE` 버전을 올린다. (`pbcr-v1` → `pbcr-v2`)
  - 안 올리면 폰에 예전 화면이 계속 남는다.
- 새 파일을 추가하면 `SHELL` 목록에도 넣는다.

## 6. 사용자 안내 (팀원 6명에게 전달)

1. 인터넷 되는 곳에서 앱을 **한 번 열어두기** (그래야 오프라인에서도 열림)
2. 가능하면 **홈 화면에 추가**해서 사용
3. 오프라인에서 기록하면 "전송 대기"로 쌓였다가 인터넷 연결 후 자동 전송
4. 아이폰은 인터넷 연결 후 **앱을 한 번 열어야** 전송됨
5. 전송 대기 건이 있을 때 브라우저 데이터 삭제 금지

## 7. 완료 보고

작업 후 아래를 지석에게 보고:
- 변경·추가한 파일 목록
- 앱스 스크립트 새 배포 버전 / API URL 변경 여부
- 테스트 체크리스트 결과
- 기존 구조와 달라서 예시 코드를 바꾼 부분
