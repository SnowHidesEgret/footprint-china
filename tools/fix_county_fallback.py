#!/usr/bin/env python3
"""对真错的 45 个用县城/市中心兜底（保证省县正确）。"""
import json, time, urllib.request, urllib.parse, sys
sys.path.insert(0, "tools")
from build_5a_step2_geocode import wgs84_to_gcj02, UA, NOM

UNITS = {u["id"]: u for u in json.load(open("tools/5a_units.json", encoding="utf-8"))}
CACHE = json.load(open("tools/5a_geocode_cache.json", encoding="utf-8"))

# 真错的 ID（display_name 验证为错误）
WRONG_IDS = [15,16,39,50,51,52,64,67,88,99,112,113,118,120,121,123,
             138,140,141,162,172,175,185,187,206,215,217,228,239,244,245,
             246,249,258,259,300,308,312,313,330,342,344,348,352,358]
# 误判为错但实际正确的（海岛/边界）：标记 validated，不动坐标
OK_IDS = [96, 107, 130, 290, 248]

def geocode(q):
    url = NOM + "?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 1, "countrycodes": "cn"})
    req = urllib.request.Request(url, headers=UA)
    try:
        res = json.load(urllib.request.urlopen(req, timeout=8))
    except Exception:
        return None
    if not res:
        return None
    r = res[0]
    return (float(r["lon"]), float(r["lat"]), r.get("display_name", "")[:60])

# 标记 OK 的
for uid in OK_IDS:
    if str(uid) in CACHE:
        CACHE[str(uid)]["validated"] = True
        print(f"id={uid} marked validated (island/coastal, coord correct)")

# 县城兜底
for uid in WRONG_IDS:
    u = UNITS[uid]
    # 用县名查中心，县为空则用市名
    q = u.get("county") or u.get("city") or u["prov"]
    if not q:
        print(f"id={uid} SKIP (no county/city)")
        continue
    time.sleep(1.2)
    res = geocode(f"{q} {u['prov']}")
    if not res:
        # 退化：只查县名
        time.sleep(1.2)
        res = geocode(q)
    if res:
        lng, lat, disp = res
        glng, glat = wgs84_to_gcj02(lng, lat)
        CACHE[str(uid)] = {
            "q": f"COUNTY_FALLBACK:{q}", "qlv": 0,
            "wgs": [round(lng, 5), round(lat, 5)],
            "gcj": [round(glng, 5), round(glat, 5)],
            "disp": disp, "approx": True,
        }
        print(f"id={uid} {u['name'][:20]} -> county {q} ({glng:.2f},{glat:.2f})", flush=True)
    else:
        print(f"id={uid} {u['name'][:20]} COUNTY FAIL", flush=True)
    json.dump(CACHE, open("tools/5a_geocode_cache.json", "w", encoding="utf-8"), ensure_ascii=False)

print("done")
