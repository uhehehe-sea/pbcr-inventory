/**
 * PBCR 현장 용어 검색 (field-search.js)
 * 재고 앱(index.html)에 붙이는 검색 모듈. 외부 라이브러리 없음.
 *
 * 사용법
 *   <script src="field-search.js"></script>
 *   const results = FieldSearch.search(items, '서스304 어디있어?');
 *   // results: [{ item, score }]  — 점수 높은 순
 *   // 결과가 0건이면 FieldSearch.onMiss(query) 가 호출됨 (기본: 아무것도 안 함 → 로그 기록용으로 교체 가능)
 *
 * items 형식: 재고 API 'items' 응답 그대로 (code, name, matNote, body, diaphragm, note, memo, order, location …)
 *
 * 사전 추가: FieldSearch.addTerms([['SUS', ['서스','스텐']], ...])  — 시트 '용어사전' 탭을 읽어 넣을 때 사용
 */
(function (global) {
  'use strict';

  /* ---------- 1. 용어사전: [검색 키워드(들), [현장 용어들]] ----------
     키워드에 '|' 를 쓰면 "이 중 아무거나" (예: 'PTFE|TEFLON')
     ※ 현장 분들 확인 전 초안. 근거: 업체·자재몰 표기 조사 + 재고 품명 */
  const TERMS = [
    // 재질
    ['SUS', ['서스', '스텐', '스뎅', '스테인리스', '스테인레스', 'STS']],
    ['PTFE|TEFLON', ['테프론', '테플론', '테프']],
    ['FPM|FKM|VITON', ['바이톤', '불소고무', '비톤']],
    ['EPDM', ['이피디엠', '에틸렌프로필렌']],
    ['PVDF', ['피브이디에프', '피비디에프', '불소수지']],
    ['PEEK', ['피크']],
    ['PP', ['피피', '폴리프로필렌']],
    ['PVC', ['피브이씨', '피비씨']],
    ['AFLAS', ['아플라스']],
    ['PFA', ['피에프에이']],
    // 배관 부속
    ['ELBOW', ['엘보우', '엘보', '엘보우관']],
    ['TEE', ['티이', '티자', '티']],
    ['REDUCER', ['레듀샤', '레듀서', '리듀서']],
    ['FLANGE', ['후렌지', '플랜지', '프랜지']],
    ['NIPPLE', ['니뿌루', '니플']],
    ['UNION', ['유니온', '유니언']],
    ['SOCKET', ['소켓', '소케또']],
    ['PRESSURE REDUCING VALVE', ['감압밸브', '감압변']],
    ['VALVE', ['밸브', '벨브', '발브']],
    ['PACKING|GASKET', ['빠킹', '패킹', '가스켓', '개스킷']],
    ['O-RING|ORING|O RING', ['오링', '오-링']],
    ['FITTING', ['피팅']],
    ['PIPE', ['파이프', '배관']],
    // 체결
    ['BOLT', ['볼트', '보루또']],
    ['NUT', ['너트', '나또']],
    ['WASHER', ['와샤', '와셔']],
    ['SCREW|BOLT', ['나사', '스크류']],
    ['HEX', ['육각']],
    ['WRENCH', ['렌치', '랜치']],
    ['HEADLESS', ['무두']],
    ['ROUND HEAD', ['둥근머리', '라운드헤드']],
    // 부품·장비
    ['GRIPPER', ['그리퍼', '그립퍼', '집게']],
    ['HOLDER', ['홀더', '고정대']],
    ['COVER', ['커버', '덮개']],
    ['SUPPORT', ['서포트', '받침']],
    ['LEVEL', ['레벨', '수위']],
    ['SENSOR', ['센서', '쎈서']],
    ['CONDUCTIVITY', ['전도도']],
    ['CABLE', ['케이블', '케불']],
    ['DRAIN', ['드레인', '배수']],
    ['NOZZLE', ['노즐']],
    ['PUMP', ['펌프', '뽐뿌']],
    ['HEATER', ['히터']],
    ['ROLLER', ['롤러', '로라']],
    ['HANDLE', ['핸들', '손잡이']],
    ['SHAFT', ['샤프트', '축']],
    ['BEARING', ['베어링', '베아링']],
    ['PIN', ['핀']],
    ['BLOCK', ['블럭', '블록']],
    ['BATH', ['배스', '수조']],
    ['SOLENOID', ['솔레노이드', '솔밸브']],
    ['O3 GENERATOR', ['오존발생기', '오존']],
    ['WELDING', ['용접기', '용접']],
    ['LOCK', ['락', '잠금']],
    ['RAIL', ['레일']],
    ['INNER', ['이너', '안쪽']],
    ['WHITE', ['흰색', '화이트']],
    ['GRAY|GREY', ['회색', '그레이']]
  ];

  // 검색어에서 빼는 말 (말하듯이 쳐도 되게)
  const FILLER = ['어디있어', '어디 있어', '어디있나', '어디있지', '어디에', '어디', '위치', '있어', '있나',
    '몇개', '몇 개', '찾아줘', '찾아', '알려줘', '보여줘', '재고', '좀', '요'];
  const JOSA = /(은|는|이|가|을|를|에|의|도|랑|하고)$/;

  let dict = [];   // [{ alias, alts:[...] }] — 긴 별칭 먼저
  function buildDict(list) {
    list.forEach(([key, aliases]) => {
      const alts = String(key).toUpperCase().split('|').map(s => s.trim()).filter(Boolean);
      aliases.forEach(a => dict.push({ alias: String(a).toUpperCase(), alts }));
    });
    dict.sort((a, b) => b.alias.length - a.alias.length);
  }
  buildDict(TERMS);

  /* ---------- 2. 정규화 ---------- */
  function norm(s) {
    return String(s || '')
      .normalize('NFKC')                 // 전각 → 반각
      .toUpperCase()
      .replace(/\bSTS\s*[-_]?\s*(?=\d{3})/g, 'SUS')            // KS 표기 STS304 → SUS304
      .replace(/\bSUS\s*[-_]?\s*(\d{3}L?)\b/g, 'SUS$1')         // SUS 304 / SUS-304 → SUS304
      .replace(/\bPP\s*[-_]\s*([HNW])\b/g, 'PP-$1')              // PP H → PP-H
      .replace(/\b(M\d{1,2})\s*[X*×]\s*(\d{1,3})\s*L?\b/g, '$1 $1*$2'); // M5*20L → M5 M5*20
  }

  // 품목 → 검색용 문자열 (품명 가중치를 위해 따로 보관)
  function hay(item) {
    const name = norm(item.name);
    const other = norm([item.matNote, item.body, item.diaphragm, item.note, item.memo, item.order].join(' '));
    return { name, other, code: String(item.code || '').toUpperCase() };
  }

  /* ---------- 3. 검색어 → 조건 목록 ---------- */
  // 결과: [{ alts:[...], raw }]  — 모든 조건을 만족(AND), 각 조건은 alts 중 하나(OR)
  function parse(query) {
    let q = String(query || '').normalize('NFKC').toUpperCase().replace(/[?!.,~]/g, ' ');
    FILLER.forEach(f => { q = q.split(f.toUpperCase()).join(' '); });

    // 사전 치환: 현장 용어 → {키워드|키워드}
    const groups = [];
    dict.forEach(({ alias, alts }) => {
      if (!/[가-힣]/.test(alias) && alias.length <= 3) {
        // 짧은 영문 별칭(STS 등)은 단어 경계에서만
        const re = new RegExp('\\b' + alias + '(?=\\d|\\b)', 'g');
        q = q.replace(re, () => ' §' + (groups.push(alts) - 1) + '§ ');
      } else {
        q = q.split(alias).join(' §' + groups.length + '§ ');
        if (q.indexOf('§' + groups.length + '§') >= 0) groups.push(alts);
      }
    });

    // 그룹 + 바로 뒤 숫자 등급 붙이기: "§0§ 304" (서스304) → SUS304
    q = q.replace(/§(\d+)§\s*[-_]?\s*(\d{3}L?)\b/g, (m, g, n) => {
      const alts = groups[g];
      return alts.indexOf('SUS') >= 0 ? ' SUS' + n + ' ' : m;
    });
    q = norm(q.replace(/§(\d+)§/g, (m, g) => ' {#' + g + '} '));

    const terms = [];
    q.split(/\s+/).filter(Boolean).forEach(tok => {
      const g = tok.match(/^\{#(\d+)\}$/);
      if (g) { terms.push({ alts: groups[g[1]], raw: groups[g[1]].join('|') }); return; }
      tok = tok.replace(/^[^\w가-힣*-]+|[^\w가-힣*-]+$/g, '');
      if (/[가-힣]/.test(tok)) tok = tok.replace(JOSA, '');
      if (!tok) return;
      terms.push({ alts: [tok], raw: tok });
    });
    return terms;
  }

  /* ---------- 4. 한 조건이 품목에 맞는지 ---------- */
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function matchAlt(alt, h) {
    const text = h.name + ' ' + h.other;
    // 4자리 숫자만 → 코드 뒤 4자리
    if (/^\d{4}$/.test(alt)) return h.code.endsWith(alt) ? 3 : 0;
    // 전체 코드
    if (/^[A-Z]{2}\d{8}$/.test(alt)) return h.code === alt ? 5 : 0;
    // 재질 등급 (SUS304 → SUS304, SUS304L 은 매칭 / SUS316 은 제외)
    if (/^SUS\d{3}L?$/.test(alt)) {
      const re = new RegExp('\\b' + alt + '(?!\\d)');
      return re.test(h.name) ? 2 : re.test(h.other) ? 1 : 0;
    }
    // SUS 단독 → SUS, SUS304, SUS316 … 전부
    if (alt === 'SUS') {
      const re = /\bSUS(\d{3}L?)?\b/;
      return re.test(h.name) ? 2 : re.test(h.other) ? 1 : 0;
    }
    // 숫자만(4자리 아님) → 단독 숫자로만 (예: 304 가 800047304 에 걸리지 않게)
    if (/^\d+$/.test(alt)) {
      const re = new RegExp('(^|[^\\d])' + alt + '(?!\\d)');
      return re.test(h.name) ? 2 : re.test(h.other) ? 1 : 0;
    }
    // 볼트 규격 M5 → M5 (M50 제외)
    if (/^M\d{1,2}(\*\d+)?$/.test(alt)) {
      const re = new RegExp('\\b' + esc(alt) + '(?![\\d])');
      return re.test(h.name) ? 2 : re.test(h.other) ? 1 : 0;
    }
    // 짧은 영문(3자 이하: TEE, PIN, NUT, PP …) → 단어 시작 경계
    if (/^[A-Z0-9-]{1,3}$/.test(alt)) {
      const re = new RegExp('(^|[^A-Z])' + esc(alt) + '(?![A-Z])');
      return re.test(h.name) ? 2 : re.test(h.other) ? 1 : 0;
    }
    // 그 외(긴 영문·한글·구문) → 포함 여부
    return h.name.indexOf(alt) >= 0 ? 2 : text.indexOf(alt) >= 0 ? 1 : 0;
  }

  /* ---------- 5. 검색 ---------- */
  function search(items, query) {
    const terms = parse(query);
    if (!terms.length) return [];
    const out = [];
    (items || []).forEach(item => {
      const h = hay(item);
      let score = 0;
      for (const t of terms) {
        let best = 0;
        for (const a of t.alts) best = Math.max(best, matchAlt(a, h));
        if (!best) return;          // 모든 조건을 만족해야 함
        score += best;
      }
      if (Number(item.qty) > 0) score += 0.5; // 재고 있는 품목 먼저
      out.push({ item, score });
    });
    out.sort((a, b) => b.score - a.score);
    if (!out.length) FieldSearch.onMiss(query, terms);
    return out;
  }

  const FieldSearch = {
    search,
    parse,                                   // 디버깅용: FieldSearch.parse('서스304 어디있어')
    addTerms(list) { buildDict(list); },     // 시트 '용어사전' 탭 내용 추가
    onMiss() {},                             // 0건 검색어 기록용으로 교체
    TERMS
  };
  global.FieldSearch = FieldSearch;
  if (typeof module !== 'undefined') module.exports = FieldSearch;
})(typeof window !== 'undefined' ? window : globalThis);
