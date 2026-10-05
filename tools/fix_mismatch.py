#!/usr/bin/env python3
"""自动检测省 mismatch 并用 '{short} {prov}' 重查。"""
import json, re, time, urllib.request, urllib.parse
import sys
sys.path.insert(0, "tools")
from build_5a_step2_geocode import wgs84_to_gcj02, strip_paren, UA, NOM

UNITS = {u["id"]: u for u in json.load(open("tools/5a_units.json", encoding="utf-8"))}
CACHE = json.load(open("tools/5a_geocode_cache.json", encoding="utf-8"))

PROV = {}
for f in json.load(open("maps/china.json", encoding="utf-8"))["features"]:
    pr = f["properties"]
    PROV[pr["name"]] = str(pr["adcode"])
def norm_prov(name):
    return PROV.get(name) or PROV.get(
        name.replace("壮族自治区", "自治区").replace("维吾尔自治区", "自治区").replace("回族自治区", "自治区"))

def load_prov_polys():
    out = []
    for f in json.load(open("maps/china.json", encoding="utf-8"))["features"]:
        g = f["geometry"]; t, coords = g["type"], g["coordinates"]
        polys = coords if t == "MultiPolygon" else [coords]
        rings = [p[0] for p in polys if p and p[0]]
        xs = [x for r in rings for x, y in r]; ys = [y for r in rings for x, y in r]
        pr = f["properties"]
        out.append({"name": pr["name"], "adcode": str(pr["adcode"]),
                    "rings": rings, "bbox": (min(xs), min(ys), max(xs), max(ys))})
    return out

def in_ring(lng, lat, ring):
    inside, n = False, len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]; xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi):
            inside = not inside
        j = i
    return inside

PROV_POLYS = load_prov_polys()
def prov_contains(lng, lat):
    for p in PROV_POLYS:
        x0, y0, x1, y1 = p["bbox"]
        if not (x0 <= lng <= x1 and y0 <= lat <= y1):
            continue
        if any(in_ring(lng, lat, r) for r in p["rings"]):
            return p
    return None

def geocode(q):
    url = NOM + "?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1, "countrycodes": "cn"})
    req = urllib.request.Request(url, headers=UA)
    try:
        res = json.load(urllib.request.urlopen(req, timeout=5))
    except Exception:
        return None
    if not res:
        return None
    r = res[0]
    return (float(r["lon"]), float(r["lat"]), r.get("display_name", "")[:80])

def short_name(u):
    name = u["name"]
    if u.get("merged_from"):
        name = strip_paren(u["merged_from"][0])
    else:
        name = strip_paren(name)
    return re.sub(r"(风景名胜区|旅游区|景区|风景区)$", "", name)

# 找出 mismatch
mismatches = []
for uid, u in sorted(UNITS.items()):
    g = CACHE.get(str(uid))
    if not g or "error" in g:
        continue
    padcode = norm_prov(u["prov"])
    hit = prov_contains(g["gcj"][0], g["gcj"][1])
    if not (hit and hit["adcode"] == padcode):
        mismatches.append(uid)

print(f"found {len(mismatches)} mismatches", flush=True)

fixed, still_bad = 0, []
for uid in mismatches:
    u = UNITS[uid]
    short = short_name(u)
    got = None
    for q in [f"{short} {u['prov']}", f"{short} {u['city']} {u['prov']}" if u.get("city") else None]:
        if not q:
            continue
        time.sleep(1.2)
        res = geocode(q)
        if res:
            lng, lat, disp = res
            glng, glat = wgs84_to_gcj02(lng, lat)
            # 验证新坐标的省
            hit = prov_contains(glng, glat)
            if hit and hit["adcode"] == norm_prov(u["prov"]):
                got = (q, glng, glat, lng, lat, disp)
                break
    if got:
        q, glng, glat, lng, lat, disp = got
        CACHE[str(uid)] = {
            "q": q, "qlv": 0,
            "wgs": [round(lng, 5), round(lat, 5)],
            "gcj": [round(glng, 5), round(glat, 5)],
            "disp": disp, "fixed": True,
        }
        fixed += 1
        print(f"  FIXED id={uid} {short[:20]} -> ({glng:.3f},{glat:.3f})", flush=True)
    else:
        still_bad.append(uid)
        print(f"  STILL BAD id={uid} {short[:20]} ({u['prov']})", flush=True)
    json.dump(CACHE, open("tools/5a_geocode_cache.json", "w", encoding="utf-8"), ensure_ascii=False)

print(f"\nfixed: {fixed}, still bad: {len(still_bad)}")
print("still bad IDs:", still_bad)
