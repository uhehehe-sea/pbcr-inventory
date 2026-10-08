"""
이미지 세트와 재고 품목 매칭 점검 + Images 시트용 CSV 생성
표준 라이브러리만 사용 (Pillow가 있으면 이미지 파일 손상 여부도 확인)

사용:
  python check_images.py --items Items_import.csv --tags image_tags.csv --images ./images --out ./check
  (--tags 는 image_tags.csv 또는 image_tags.json)

결과 (--out 폴더):
  image_check_report.txt : 점검 결과 요약과 문제 목록
  Images_import.csv      : 구글 시트 Images 탭에 가져올 파일 (코드당 한 줄)
"""
import argparse, csv, json, os, sys
from collections import Counter, defaultdict

CONF_ORDER = ['정확모델', '동일타입 대표', '일반 대표이미지', '실물사진', '이미지 없음']

def norm_conf(v):
    v = (v or '').strip()
    if '정확' in v: return '정확모델'
    if '동일' in v or '유사' in v: return '동일타입 대표'
    if '일반' in v or '참고' in v: return '일반 대표이미지'
    if '실물' in v: return '실물사진'
    if '없' in v or v == '': return '이미지 없음'
    return v

def read_table(path):
    if path.lower().endswith('.json'):
        data = json.load(open(path, encoding='utf-8-sig'))
        if isinstance(data, dict):
            data = next((v for v in data.values() if isinstance(v, list)), [])
        return [{str(k): ('' if v is None else str(v)) for k, v in row.items()} for row in data]
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def pick(headers, *keys):
    low = {h: h.lower().replace(' ', '').replace('_', '').replace('-', '') for h in headers}
    for k in keys:
        for h, l in low.items():
            if k in l: return h
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--items', required=True)
    ap.add_argument('--tags', required=True)
    ap.add_argument('--images', required=True)
    ap.add_argument('--out', default='.')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    problems, notes = [], []

    items = read_table(a.items)
    item_codes = Counter(r['sea_code'].strip().upper() for r in items if r.get('sea_code', '').strip())
    item_names = defaultdict(list)
    for r in items: item_names[r['sea_code'].strip().upper()].append(r.get('name', ''))

    tags = read_table(a.tags)
    if not tags: sys.exit('태그 파일이 비어 있습니다: ' + a.tags)
    H = list(tags[0].keys())
    c_code = pick(H, 'seacode', '코드', 'code')
    c_conf = pick(H, '신뢰', 'confidence')
    c_cat = pick(H, '분류', 'category')
    c_src = pick(H, '출처', 'source', 'url')
    c_name = pick(H, '품명', 'name', 'contents')
    c_spec = pick(H, '규격', 'spec')
    notes.append(f'태그 파일 열 인식: 코드={c_code}, 신뢰도={c_conf}, 분류={c_cat}, 출처={c_src}, 품명={c_name}, 규격={c_spec}')
    if not c_code or not c_conf: sys.exit('태그 파일에서 코드 열 또는 신뢰도 열을 찾지 못했습니다. 열 이름: ' + ', '.join(H))

    files = {}
    for fn in os.listdir(a.images):
        stem, ext = os.path.splitext(fn)
        if ext.lower() not in ('.jpg', '.jpeg', '.png', '.webp'): continue
        files.setdefault(stem.strip().upper(), []).append(fn)

    try:
        from PIL import Image
        for code, fns in files.items():
            for fn in fns:
                try:
                    with Image.open(os.path.join(a.images, fn)) as im: im.verify()
                except Exception as e:
                    problems.append(f'[이미지 손상] {fn}: {e}')
    except ImportError:
        notes.append('Pillow가 없어 이미지 손상 여부는 건너뜀')

    # 1) 태그 행 점검
    tag_codes = Counter(); by_code = defaultdict(list)
    for i, r in enumerate(tags, 2):
        code = r.get(c_code, '').strip().upper()
        conf = norm_conf(r.get(c_conf, ''))
        tag_codes[code] += 1; by_code[code].append((conf, r))
        if conf not in CONF_ORDER: problems.append(f'[신뢰도 값 이상] {i}행 {code}: "{r.get(c_conf)}"')
        if code not in item_codes: problems.append(f'[재고에 없는 코드] 태그 {i}행: "{r.get(c_code)}"')
        has = code in files
        if conf != '이미지 없음' and not has: problems.append(f'[사진 누락] {code}: 신뢰도 "{conf}"인데 {code}.jpg 파일이 없음')
        if conf == '이미지 없음' and has: notes.append(f'[확인] {code}: 신뢰도 "이미지 없음"인데 파일이 있음 → 실물사진으로 처리')

    # 2) 재고 코드 기준 점검
    for code, n in item_codes.items():
        if code == '-': problems.append('[코드 없음] SEA-CODE가 "-"인 품목(Welding Machine Heater 등)은 사진 파일명을 만들 수 없음 → 코드 확정 후 연결')
        elif code not in tag_codes: problems.append(f'[태그 누락] 재고 코드 {code}가 태그 파일에 없음')
        if tag_codes.get(code, 0) and tag_codes[code] != n:
            notes.append(f'[행수 차이] {code}: 재고 {n}행, 태그 {tag_codes[code]}행')
    for code, fns in files.items():
        if code not in item_codes: problems.append(f'[재고에 없는 파일] {", ".join(fns)}')
        if len(fns) > 1: problems.append(f'[중복 파일] {code}: {", ".join(fns)}')
    for code, rows in by_code.items():
        confs = {c for c, _ in rows}
        if len(confs) > 1: notes.append(f'[신뢰도 불일치] {code}: {", ".join(sorted(confs))} → 가장 높은 등급 사용')

    # 3) Images_import.csv (코드당 한 줄)
    out_rows = []
    for code in sorted(set(item_codes) | set(files)):
        if code == '-': continue
        rows = by_code.get(code, [])
        rows.sort(key=lambda x: CONF_ORDER.index(x[0]) if x[0] in CONF_ORDER else 9)
        conf, r = rows[0] if rows else ('실물사진' if code in files else '이미지 없음', {})
        if conf == '이미지 없음' and code in files: conf = '실물사진'
        out_rows.append([code, r.get(c_name, '') if c_name else '', r.get(c_spec, '') if c_spec else '',
                         r.get(c_cat, '') if c_cat else '', conf, r.get(c_src, '') if c_src else '', ''])
    with open(os.path.join(a.out, 'Images_import.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f); w.writerow(['sea_code', 'name', 'spec', 'category', 'confidence', 'source', 'file_id']); w.writerows(out_rows)

    # 4) 요약
    conf_rows = Counter(norm_conf(r.get(c_conf, '')) for r in tags)
    matched = [c for c in item_codes if c in files]
    lines = [
        '# 이미지 매칭 점검 결과', '',
        f'재고: {sum(item_codes.values())}행, 코드 {len(item_codes)}종',
        f'태그 파일: {len(tags)}행, 코드 {len(tag_codes)}종',
        f'이미지 파일: {sum(len(v) for v in files.values())}장, 코드 {len(files)}종',
        f'재고 코드 중 사진 연결: {len(matched)}종 / 사진 없음: {len(item_codes) - len(matched)}종',
        '신뢰도별 행수: ' + ', '.join(f'{k} {conf_rows.get(k, 0)}' for k in CONF_ORDER if conf_rows.get(k)),
        '', f'## 문제 {len(problems)}건 (시스템에 올리기 전 해결 권장)'] + (problems or ['없음']) + \
        ['', f'## 참고 {len(notes)}건'] + (notes or ['없음'])
    open(os.path.join(a.out, 'image_check_report.txt'), 'w', encoding='utf-8').write('\n'.join(lines))
    print('\n'.join(lines[:9]))
    print(f'문제 {len(problems)}건, 참고 {len(notes)}건 → {os.path.join(a.out, "image_check_report.txt")}')

if __name__ == '__main__':
    main()
