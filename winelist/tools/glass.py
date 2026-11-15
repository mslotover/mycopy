import pdfplumber, re, json
from parse import lines_of, clean, fam, BULLETS, is_heading_line
LAST = re.compile(r'^(?P<region>.+?),\s+(?P<country>[^,]+?)\s*(?P<vintage>NV|\d{4})\s*(?P<abv>[\d.]*\s*%)?\s*$')
pdf = pdfplumber.open('list.pdf')
out = []; section = ''
for pn in (2, 3):
    page = pdf.pages[pn-1]
    chars = [c for c in page.chars if c['text'].strip()]
    body = [c for c in chars if c['top'] > 60 and c['text'] not in BULLETS]
    margin = min(c['x0'] for c in body)
    bullets = [c for c in chars if c['text'] in BULLETS]
    it = [c['x0'] for c in body if fam(c) == 'Italic' and c['x0'] > margin + 150]
    GR = min(it) - 3
    PR = margin + 250
    helv = lambda c: 'Helvetica' in c['fontname']
    left = lines_of(page, lambda c: c['text'] not in BULLETS and c['top'] > 60 and (c['x0'] < GR or (helv(c) and c['x0'] < PR)))
    grapes = lines_of(page, lambda c: GR <= c['x0'] and not helv(c) and c['top'] > 60)
    pc = [c for c in body if helv(c) and c['x0'] >= PR]
    # price column anchors from header text on this page
    hdr = [c for c in pc if c['top'] < 100 or (c['size'] < 7.6 and c['text'] in 'ml')]
    words = page.filter(lambda o: o.get('object_type')!='char' or (helv(o) and o['x0']>=PR and o['top']>60)).extract_words(keep_blank_chars=False, use_text_flow=False)
    buf = []
    for l in left:
        txt = clean(l['text'])
        if is_heading_line(l):
            section = txt; buf = []; continue
        if re.fullmatch(r'[\d.]+\s*%', txt) and not buf:
            if out and not out[-1]['abv']: out[-1]['abv'] = txt.replace(' ', '')
            continue
        buf.append(l)
        m = LAST.match(txt)
        if m and len(buf) >= 2:
            first, last = buf[0], buf[-1]
            top, bot = first['top'] - 5, last['bottom'] + 1
            g = ' '.join(clean(x['text']) for x in grapes if top <= x['top'] <= bot)
            ws = [w for w in words if top <= w['top'] <= bot]
            head = ' '.join(clean(x['text']) for x in buf[:-1])
            bl = any(abs((b['top']+b['bottom'])/2 - (first['top']+first['bottom'])/2) < 7 for b in bullets)
            out.append(dict(page=pn, section=section, head=head, region=m['region'], country=m['country'], vintage=m['vintage'],
                            abv=(m['abv'] or '').replace(' ',''), grapes=g, price_x=[(round(w['x0']), w['text']) for w in ws], anchor=round(min(w['x0'] for w in words)), low_intervention='Y' if bl else ''))
            buf = []
json.dump(out, open('glass_raw.json','w'), ensure_ascii=False, indent=1)
print(len(out))
for r in out[:6]: print(r)
