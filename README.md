# PBCR 자재 재고

창고 자재의 반출입 수량을 휴대폰에서 바로 기록하는 웹앱.
화면은 GitHub Pages, 데이터는 구글 시트(앱스 스크립트 API)에 있다.

[휴대폰 / PC]  →  GitHub Pages (index.html)  →  Apps Script API  →  Google Sheet (Items, Log, Users)

## 처음 세팅
1. 구글 드라이브에서 빈 스프레드시트를 만든다.
2. 확장 프로그램 → Apps Script → `apps-script/Code.gs` 내용을 통째로 붙여넣고 저장.
3. 함수 선택에서 `setup` → 실행. 권한 화면이 뜨면 허용한다.
4. Items 탭에 `Items_import.csv`, Log 탭에 `Log_import.csv`, Images 탭에 `Images_import.csv`를 파일 → 가져오기 → 현재 시트 바꾸기로 넣는다. 이때 "텍스트를 숫자, 날짜, 수식으로 변환" 체크를 해제한다.
5. Users 탭에 작업자 6명 이름을 넣는다. (참고용 명단. 첫 화면의 이름 입력은 목록 선택이 아니라 자유 타이핑이며, 입력한 이름이 기기 브라우저에 저장된다)

## API 배포
배포 → 새 배포 → 유형 웹 앱, 실행: 나, 액세스: 모든 사용자.

## 화면에 API 주소 넣기
`index.html`의 `const API_URL = '...'` 줄을 배포 주소로 바꾼다.

## GitHub Pages
Settings → Pages → Deploy from a branch → main / (root) → Save.

재고 데이터(CSV, 엑셀)와 부품 이미지는 이 저장소에 올리지 않는다.
