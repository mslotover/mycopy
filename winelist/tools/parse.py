import pdfplumber, re, csv, json, sys

pdf = pdfplumber.open('list.pdf')
LAST = re.compile(r'^(?P<region>.+?),\s+(?P<country>[^,]+?)\s+(?P<vintage>NV|\d{4})\s*(?P<abv>[\d.]*\s*%)?\s*$')
BULLETS = set('•●')

def fam(ch):
    return ch['fontname'].split('+')[-1].replace('WolpePegasus-', '')

def is_heading_line(line):
    fs = {fam(c) for c in line['chars'] if c['text'].strip()}
    return bool(fs) and all(f in ('Bold', 'BoldItalic') for f in fs)

def lines_of(page, pred):
    sub = page.filter(lambda o: o.get('object_type') != 'char' or pred(o))
    return sub.extract_text_lines(return_chars=True, strip=True)

def clean(s):
    return re.sub(r'\s+', ' ', s).strip()

def parse_bottle_page(pn, page, state, out):
    chars = [c for c in page.chars if c['text'].strip()]
    body = [c for c in chars if c['top'] > 60 and c['text'] not in BULLETS]
    margin = min(c['x0'] for c in body)
    bullets = [c for c in chars if c['text'] in BULLETS]
    it = [c['x0'] for c in body if fam(c) == 'Italic' and c['x0'] > margin + 150]
    GR = (min(it) if it else margin + 178) - 3
    PR = margin + 250
    helv = lambda c: 'Helvetica' in c['fontname']
    left = lines_of(page, lambda c: c['text'] not in BULLETS and c['top'] > 60 and (c['x0'] < GR or (helv(c) and c['x0'] < PR)))
    grapes = lines_of(page, lambda c: GR <= c['x0'] and not helv(c) and c['top'] > 60)
    prices = lines_of(page, lambda c: c['x0'] >= PR and helv(c) and c['top'] > 60)
    buf = []
    pending_head = None
    def settle_tagline(l):
        return clean(l['text'])
    i = 0
    items = []
    for l in left:
        txt = clean(l['text'])
        if is_heading_line(l):
            fs = {(fam(c), round(c['size'], 1)) for c in l['chars'] if c['text'].strip()}
            name, size = sorted(fs)[0][0], max(s for _, s in fs)
            items.append(('head', name, size, txt, l))
        else:
            items.append(('line', l))
    k = 0
    for it in items:
        if it[0] == 'head':
            _, name, size, txt, l = it
            if name == 'BoldItalic':
                # tagline for most recent heading
                if state['last_level'] == 1: state['group_tag'] = txt
                elif state['last_level'] == 2: state['sub_tag'] = txt
                elif state['last_level'] == 0: state['section_tag'] = txt
                continue
            if txt.endswith(' continued'):
                continue
            if size >= 13:
                state.update(section=txt, group='', subgroup='', section_tag='', group_tag='', sub_tag='', last_level=0)
            elif size >= 10.5:
                if state['group'] == 'Further Afield' and txt in ('North America','South America','South Africa','Australia','New Zealand'):
                    state.update(subgroup=txt, sub_tag='', last_level=2)
                else:
                    state.update(group=txt, subgroup='', group_tag='', sub_tag='', last_level=1)
            else:
                state.update(subgroup=txt, sub_tag='', last_level=2)
            buf = []
            continue
        l = it[1]
        txt = clean(l['text'])
        if re.fullmatch(r'[\d.]+\s*%', txt) and not buf and out and not out[-1]['abv']:
            out[-1]['abv'] = txt.replace(' ', '')
            continue
        buf.append(l)
        m = LAST.match(txt)
        if m and len(buf) >= 2:
            first, lastl = buf[0], buf[-1]
            top, bot = first['top'] - 5, lastl['bottom'] + 1
            g = [clean(x['text']) for x in grapes if top <= x['top'] <= bot]
            pr = [clean(x['text']) for x in prices if top <= x['top'] <= bot]
            bl = any(top - 2 <= b['top'] <= bot for b in bullets if abs((b['top']+b['bottom'])/2 - (first['top']+first['bottom'])/2) < 7)
            producer = clean(buf[0]['text'])
            cuv = [clean(x['text']) for x in buf[1:-1]]
            rec = dict(page=pn, section=state['section'], group=state['group'], subgroup=state['subgroup'],
                       group_tagline=state['group_tag'], subgroup_tagline=state['sub_tag'],
                       producer=producer, cuvee=cuv[0] if cuv else '', cuvee_line2=cuv[1] if len(cuv) > 1 else '',
                       cuvee_line3=cuv[2] if len(cuv) > 2 else '',
                       region=m['region'], country=m['country'], vintage=m['vintage'],
                       abv=(m['abv'] or '').replace(' ', ''), grapes=' '.join(g), price=' '.join(pr),
                       low_intervention='Y' if bl else '', on_tap='', size='')
            out.append(rec)
            buf = []
    return

if __name__ == '__main__':
    out = []
    state = dict(section='', group='', subgroup='', section_tag='', group_tag='', sub_tag='', last_level=0)
    for pn in range(4, 34):
        parse_bottle_page(pn, pdf.pages[pn-1], state, out)
    for r in out:
        m = re.search(r'\s(\d+\s?ml)$', r['producer'])
        if m: r['size'] = m[1]; r['producer'] = r['producer'][:m.start()]
        # on tap + size post-processing on cuvee fields
        for key in ('cuvee', 'cuvee_line2', 'cuvee_line3'):
            v = r[key]
            if re.search(r',\s*on tap$', v):
                r['on_tap'] = 'Y'; r[key] = re.sub(r',\s*on tap$', '', v)
            if re.fullmatch(r'\d+\s?(?:ml|litre)', v):
                r['size'] = v; r[key] = ''
                continue
            m = re.search(r'\s(\d+\s?(?:ml|litre))$', v)
            if m and not r['size']:
                r['size'] = m[1]; r[key] = v[:m.start()]
    json.dump(out, open('bottle.json', 'w'), ensure_ascii=False, indent=1)
    print(len(out))
