#!/usr/bin/env python3
"""
Step 3: units + geocode cache → maps/scenic-5a.json。
- p: 省 adcode（表名 → china.json）
- c: 市/区 adcode（表名 → city GeoJSON 名称索引；直辖市用区名）
- 几何校验：省级别 point-in-polygon，flag mismatch 供人工复核
字段: id, name, p, c, county, lng, lat(GCJ-02), cat, batch, src
"""
import json, re, os
from collections import Counter

UNITS = {u["id"]: u for u in json.load(open("tools/5a_units.json", encoding="utf-8"))}
CACHE = json.load(open("tools/5a_geocode_cache.json", encoding="utf-8"))

# 省名 → adcode
PROV = {}
for f in json.load(open("maps/china.json", encoding="utf-8"))["features"]:
    pr = f["properties"]
    PROV[pr["name"]] = str(pr["adcode"])

def norm_prov(name):
    return PROV.get(name) or PROV.get(
        name.replace("壮族自治区", "自治区").replace("维吾尔自治区", "自治区").replace("回族自治区", "自治区"))

# (省adcode, 市/区名) → adcode 索引
print("building city index...", flush=True)
CITY_INDEX = {}
for f in json.load(open("maps/china.json", encoding="utf-8"))["features"]:
    padcode = str(f["properties"]["adcode"])
    path = f"maps/cities/{padcode}_full.json"
    if not os.path.exists(path):
        continue
    d = json.load(open(path, encoding="utf-8"))
    feats = d["features"] if isinstance(d, dict) and "features" in d else d
    for cf in feats:
        cp = cf["properties"]
        CITY_INDEX[(padcode, cp["name"])] = str(cp["adcode"])
print(f"city index: {len(CITY_INDEX)} entries", flush=True)

# 省 polygon（仅用于校验）
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

# 分类
RED = ["一大", "二大", "四大", "革命", "红军", "起义", "纪念馆", "烈士", "长征",
       "抗战", "延安", "西柏坡", "井冈山", "瑞金", "遵义", "古田", "韶山", "花明楼",
       "朱德", "邓小平", "红嫂", "沂蒙", "八路军", "新四军", "淮海", "辽沈", "平津",
       "台儿庄", "百色", "秋收", "南湖", "苏维埃", "红色"]
HIST = ["博物院", "博物馆", "陵", "墓", "冢", "寺", "庙", "祠", "塔", "楼", "阁",
        "宫", "殿", "府", "衙", "故居", "故里", "书院", "石窟", "遗址", "古城",
        "古镇", "古村", "古街", "土楼", "碉楼", "城墙", "长城", "运河", "园林",
        "石刻", "壁画", "土司", "关隘", "王府", "孔庙", "文庙", "阙", "莫高窟",
        "堰", "渠", "堤", "窑", "坊", "巷", "宅", "邸", "驿道", "茶马"]
MODN = ["科技馆", "科技", "欢乐", "方特", "恐龙", "影视", "影城", "度假区", "度假",
        "主题", "海洋", "极地", "植物园", "动物园", "世博园", "雕塑", "动漫",
        "长隆", "乐园", "水世界", "滑雪", "广播电视", "野生动物", "大剧院",
        "恐龙城", "欢乐谷", "华侨城"]

def category(name, merged_from=None):
    hay = name + "|" + "|".join(merged_from or [])
    for kw in RED:
        if kw in hay: return "red"
    for kw in HIST:
        if kw in hay: return "hist"
    for kw in MODN:
        if kw in hay: return "modn"
    return "nat"

out, fails, mism, nocity = [], [], [], []
for uid, u in sorted(UNITS.items()):
    g = CACHE.get(str(uid))
    if not g or "error" in g:
        fails.append((uid, u["name"]))
        continue
    padcode = norm_prov(u["prov"])
    # c: 优先市名，直辖市用区名
    cname = u.get("city") or u.get("county") or ""
    cadcode = CITY_INDEX.get((padcode, cname), "")
    # 几何校验（省级别）；approx/validated 跳过
    glng, glat = g["gcj"]
    if g.get("approx"):
        src = "approx_county"
        prov_ok = True  # 县城查询已带省限定
    elif g.get("validated"):
        src = "nominatim_validated"
        prov_ok = True
    else:
        hit = prov_contains(glng, glat)
        prov_ok = hit and hit["adcode"] == padcode
        src = "manual" if g.get("q") == "MANUAL_COORD" else (
            "nominatim" if g.get("qlv", 0) in (0, -1) else "nominatim_fallback")
    if not prov_ok:
        mism.append((uid, u["name"], u["prov"], hit["name"] if hit else None))
    if not cadcode:
        nocity.append((uid, u["name"], u["prov"], cname))
    out.append({
        "id": uid, "name": u["name"], "p": padcode, "c": cadcode,
        "county": u.get("county") or "",
        "lng": glng, "lat": glat,
        "cat": category(u["name"], u.get("merged_from")),
        "batch": u.get("batch_year"),
        "src": src,
    })

json.dump(out, open("maps/scenic-5a.json", "w", encoding="utf-8"),
          ensure_ascii=False, separators=(",", ":"))
print(f"\nwrote maps/scenic-5a.json: {len(out)} records")
print("分类分布:", dict(Counter(r["cat"] for r in out)))
print(f"\n失败 ({len(fails)}): {fails}")
print(f"\n省 mismatch ({len(mism)}):")
for m in mism: print("  ", m)
print(f"\n市未匹配 ({len(nocity)}):")
for n in nocity: print("  ", n)
