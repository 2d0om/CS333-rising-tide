# Builds joint/city.json for the Rising Tide joint page: simplified community shapes + flats sold per year
# (y) and how many of them were sold off-plan (o).
# Sources: course repo, Part 2 transactions.csv and dubai.geojson. Same filter as Views B and D:
# sales of Unit / Flat, 1 Jan 2015 - 31 Aug 2026, dates read as UTC.
import csv, json, sys
from collections import defaultdict
T, G, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
YEARS = list(range(2015, 2027))
cnt = defaultdict(lambda: [0]*len(YEARS))
off = defaultdict(lambda: [0]*len(YEARS))   # of which off-plan (sold before completion)
with open(T, newline='') as f:
    for r in csv.DictReader(f):
        d = r['instance_date'][:10]
        if not ('2015-01-01' <= d < '2026-09-01'): continue
        if r['trans_group_en'] != 'Sales' or r['property_type_en'] != 'Unit' or r['property_sub_type_en'] != 'Flat': continue
        try: c = int(float(r['comm_num']))
        except: continue
        cnt[c][int(d[:4]) - 2015] += 1
        if r['reg_type_en'] == 'Off-Plan Properties': off[c][int(d[:4]) - 2015] += 1

def perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0: return ((x - x1)**2 + (y - y1)**2) ** .5
    t = max(0, min(1, ((x - x1)*dx + (y - y1)*dy) / (dx*dx + dy*dy)))
    return ((x - x1 - t*dx)**2 + (y - y1 - t*dy)**2) ** .5
def dp(pts, eps):
    if len(pts) < 3: return pts
    i, dmax = 0, 0
    for k in range(1, len(pts) - 1):
        d = perp(pts[k], pts[0], pts[-1])
        if d > dmax: i, dmax = k, d
    if dmax > eps: return dp(pts[:i+1], eps)[:-1] + dp(pts[i:], eps)
    return [pts[0], pts[-1]]
def simp(ring, eps=0.00035):
    # split the closed ring in two halves so DP keeps its shape
    h = len(ring) // 2
    s = dp(ring[:h+1], eps)[:-1] + dp(ring[h:], eps)
    return [[round(x, 5), round(y, 5)] for x, y in s]

g = json.load(open(G))
comms, total, nv = [], 0, 0
for f in g['features']:
    p = f['properties']; cid = int(p['COMM_NUM'])
    name = ' '.join(w.capitalize() for w in p['CNAME_E'].split()).split(' (')[0]
    rings = [simp(r) for r in f['geometry']['coordinates']]
    rings = [r for r in rings if len(r) >= 4]
    nv += sum(map(len, rings))
    y = cnt.get(cid, [0]*len(YEARS)); total += sum(y)
    comms.append({'id': cid, 'name': name, 'c': [round(float(p['Longitude']), 5), round(float(p['Latitude']), 5)], 'rings': rings, 'y': y, 'o': off.get(cid, [0]*len(YEARS))})
json.dump({'years': YEARS, 'comms': comms}, open(OUT, 'w'), separators=(',', ':'))
print('communities', len(comms), 'vertices', nv, 'flats sold', total, 'matched', sum(1 for c in comms if sum(c['y'])))
print('off-plan', sum(sum(v) for v in off.values()))
print('unmatched sales', sum(sum(v) for k, v in cnt.items() if k not in {c['id'] for c in comms}))
top = sorted(comms, key=lambda c: -sum(c['y']))[:8]
for c in top: print(c['id'], c['name'], sum(c['y']), c['y'])
