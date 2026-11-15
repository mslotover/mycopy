import json, csv, re, unicodedata, pdfplumber
bottle = json.load(open('bottle.json')); graw = json.load(open('glass_raw.json'))

def norm(s):
    s = unicodedata.normalize('NFKD', s.lower()); s = ''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

B = []
for i, r in enumerate(bottle, 1):
    cuv = ' / '.join(x for x in (r['cuvee'], r['cuvee_line2'], r['cuvee_line3']) if x)
    B.append(dict(id=f'B{i:03d}', sort=i, section=r['section'], group=r['group'], subgroup=r['subgroup'],
        group_tagline=r['group_tagline'], subgroup_tagline=r['subgroup_tagline'],
        producer=r['producer'], cuvee=r['cuvee'], cuvee_line2=r['cuvee_line2'] if not re.fullmatch(r'\d+\s?ml', r['cuvee_line2']) else '',
        cuvee_line3=r['cuvee_line3'], size=r['size'], region=r['region'], country=r['country'],
        vintage=r['vintage'], abv=r['abv'].rstrip('%'), grapes=r['grapes'], price=r['price'],
        low_intervention=r['low_intervention'], on_tap=r['on_tap'], source_page=r['page']))

G = []
for i, r in enumerate(graw, 1):
    head = r['head']; tap = ''
    if re.search(r',?\s*on tap$', head): tap = 'Y'; head = re.sub(r',?\s*on tap$', '', head)
    prod, _, cuv = head.partition(', ')
    xs = sorted({0}); a = r['anchor']
    p = {'125': '', '375': '', '750': '', '50': ''}
    for x, t in r['price_x']:
        col = ['125', '375', '750'][min(range(3), key=lambda k: abs(x - (a + 18*k)))]
        if r['section'] == 'Sweet & Oxidative': col = '50'
        p[col] = t
    G.append(dict(id=f'G{i:03d}', sort=i, section=r['section'], producer=prod, cuvee=cuv, region=r['region'], country=r['country'],
        vintage=r['vintage'], abv=r['abv'].rstrip('%'), grapes=r['grapes'], price_50=p['50'], price_125=p['125'], price_375=p['375'], price_750=p['750'],
        low_intervention=r['low_intervention'], on_tap=tap, source_page=r['page']))

def w(path, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0].keys())); wr.writeheader(); wr.writerows(rows)
w('/home/user/mycopy/winelist/data/wines.csv', B)
w('/home/user/mycopy/winelist/data/glass.csv', G)

# intro text
pdf = pdfplumber.open('list.pdf')
open('/home/user/mycopy/winelist/data/intro.txt', 'w').write(pdf.pages[0].extract_text())

# cross-checks
bi = {}
for b in B: bi.setdefault((norm(b['producer']), norm(b['cuvee'])), []).append(b)
issues = []
for g in G:
    key = (norm(g['producer']), norm(g['cuvee']))
    m = bi.get(key)
    if not m:
        m = [b for b in B if norm(b['producer']) == norm(g['producer']) and (norm(g['cuvee']) in norm(b['cuvee']+' '+b['cuvee_line2']) or norm(b['cuvee']) in norm(g['cuvee']))]
    if not m: issues.append(f"Glass {g['id']} {g['producer']}, {g['cuvee']}: no matching bottle-list entry"); continue
    b = m[0]
    if g['price_750'] and g['price_750'] != b['price']: issues.append(f"{g['producer']}, {g['cuvee']}: glass-list 750ml price {g['price_750']} vs bottle list {b['price']}")
    if g['abv'] != b['abv']: issues.append(f"{g['producer']}, {g['cuvee']}: ABV glass {g['abv']}% vs bottle {b['abv']}%")
    if g['vintage'] != b['vintage']: issues.append(f"{g['producer']}, {g['cuvee']}: vintage glass {g['vintage']} vs bottle {b['vintage']}")
for b in B:
    if not b['abv'] or float(b['abv']) < 5 or float(b['abv']) > 21: issues.append(f"{b['id']} p{b['source_page']} {b['producer']}, {b['cuvee']}: suspicious ABV '{b['abv']}'")
    for f in ('producer', 'cuvee', 'region', 'country', 'grapes'):
        if re.search(r'\.lo\b|á Vent|Penedes|Penedes', b[f]): issues.append(f"{b['id']} p{b['source_page']} {b['producer']}: check spelling in {f}: {b[f]}")
open('issues.txt', 'w').write('\n'.join(issues))
print(len(B), len(G)); print('\n'.join(issues))
