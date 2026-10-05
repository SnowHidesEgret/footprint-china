#!/usr/bin/env python3
"""
Step 2 (fast): 359 个 5A 地理编码（Nominatim, WGS-84）→ 转 GCJ-02，存 cache。
不做 polygon（后置到 Step 3 批量校验）。
用法: python3 build_5a_step2_geocode.py [--limit N] [--resume]
"""
import json, math, re, sys, time, urllib.request, urllib.parse, os

UNITS = json.load(open("tools/5a_units.json", encoding="utf-8"))
UA = {"User-Agent": "footprint-china-dataset-builder/1.0 (5A scenic dataset; one-off)"}
NOM = "https://nominatim.openstreetmap.org/search"
CACHE = "tools/5a_geocode_cache.json"

MANUAL = {
    4: "中共一大会址 上海",
    5: "西沙湿地 上海",
    11: "普达措国家公园",
    12: "昆明世博园",
    13: "腾冲热海",
    14: "普者黑 丘北",
    19: "柴河 阿尔山",
    22: "莫尔格勒河",
    23: "老牛湾 清水河",
    32: "通州大运河 北京",
    36: "六鼎山 敦化",
    38: "长春世界雕塑公园",
    40: "嫩江湾 大安市 吉林",  # 勿用"大安嫩江湾"(会误配浙江)
    56: "亚丁 稻城",
    66: "六盘山 隆德",
    71: "西递 黟县",
    79: "采石矶 马鞍山",
    81: "孔庙 曲阜",
    92: "萤火虫水洞 沂水",
    96: "奥帆中心 青岛",
    107: "壶口瀑布 吉县",
    109: "华侨城 深圳",
    119: "大角湾 海陵岛",
    122: "开平碉楼",
    131: "百色起义",
    149: "三五九旅 阿拉尔",
    152: "托木尔 温宿",
    153: "三国城 无锡",
    156: "中山陵 南京",
    159: "夫子庙 南京",
    169: "沙家浜 常熟",
    171: "周恩来故居",
    196: "避暑山庄 承德",
    214: "鸡冠洞 栾川",
    216: "西峡恐龙",
    218: "红旗渠 林州",
    219: "芒砀山 永城",
    222: "太昊陵 淮阳",
    233: "鲁迅故里 绍兴",
    234: "根宫佛国 开化",
    238: "江郎山 江山",
    241: "文成县 温州",  # 刘伯温故里无精确POI，用县中心近似
    250: "槟榔谷 保亭",
    252: "天涯海角",
    257: "神农溪 巴东",
    261: "木兰山 黄陂",
    267: "明显陵 钟祥",
    286: "炳灵寺",
    294: "白水洋 屏南",
    298: "湄洲岛",
    305: "雅鲁藏布大峡谷",
    316: "老虎滩 大连",
    321: "红海滩 盘锦",
    324: "小三峡 巫山",
    325: "天生三桥 武隆",
    329: "四面山 江津",
    334: "武陵山 涪陵",  # 大裂谷无精确POI，用武陵山近似
    343: "西安城墙",
    345: "杨家岭 延安",
    346: "壶口瀑布 宜川",
}

def _tlat(x, y):
    r = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    r += (20.0*math.sin(6.0*x*math.pi/180.0) + 20.0*math.sin(2.0*x*math.pi/180.0))*2.0/3.0
    r += (20.0*math.sin(y*math.pi/180.0) + 40.0*math.sin(y/3.0*math.pi/180.0))*2.0/3.0
    r += (160.0*math.sin(y/12.0*math.pi/180.0) + 320*math.sin(y*math.pi/30.0))*2.0/3.0
    return r
def _tlng(x, y):
    r = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    r += (20.0*math.sin(6.0*x*math.pi/180.0) + 20.0*math.sin(2.0*x*math.pi/180.0))*2.0/3.0
    r += (20.0*math.sin(x*math.pi/180.0) + 40.0*math.sin(x/3.0*math.pi/180.0))*2.0/3.0
    r += (150.0*math.sin(x/12.0*math.pi/180.0) + 300.0*math.sin(x/29.0*math.pi/180.0))*2.0/3.0
    return r
def wgs84_to_gcj02(lng, lat):
    if not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271):
        return lng, lat
    dlat, dlng = _tlat(lng-105.0, lat-35.0), _tlng(lng-105.0, lat-35.0)
    rad = lat/180.0*math.pi
    magic = math.sin(rad); magic = 1 - 0.00669342162296594323*magic*magic
    sm = math.sqrt(magic)
    dlat = dlat*180.0/((6378245.0*(1-0.00669342162296594323))/(magic*sm)*math.pi)
    dlng = dlng*180.0/(6378245.0/sm*math.cos(rad)*math.pi)
    return lng+dlng, lat+dlat

def geocode(query):
    url = NOM + "?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "limit": 1, "countrycodes": "cn"})
    req = urllib.request.Request(url, headers=UA)
    try:
        # 5s 激进超时，快速失败
        res = json.load(urllib.request.urlopen(req, timeout=5))
    except Exception:
        return None
    if not res:
        return None
    r = res[0]
    return (float(r["lon"]), float(r["lat"]), r.get("display_name", "")[:80])

def strip_paren(s):
    return re.sub(r"（.+）$", "", s).strip()

def queries_for(u):
    name = u["name"]
    if u.get("merged_from"):
        name = strip_paren(u["merged_from"][0])
    else:
        name = strip_paren(name)
    # 短名优先（不带省名，Nominatim 对短查询更友好）；Step 3 做省几何校验
    short = re.sub(r"(风景名胜区|旅游区|景区|风景区)$", "", name)
    qs = []
    if short != name and len(short) >= 2:
        qs.append(short)
    qs.append(name)
    if f"{short} {u['prov']}" not in qs and short != name:
        qs.append(f"{short} {u['prov']}")
    return qs

def main():
    limit = int(sys.argv[sys.argv.index("--limit")+1]) if "--limit" in sys.argv else None
    resume = "--resume" in sys.argv
    cache = json.load(open(CACHE, encoding="utf-8")) if resume and os.path.exists(CACHE) else {}
    todo = [u for u in UNITS if str(u["id"]) not in cache][:limit]
    print(f"geocoding {len(todo)} units (cache has {len(cache)})", flush=True)
    for idx, u in enumerate(todo):
        manual = MANUAL.get(u["id"])
        got = None
        if isinstance(manual, (list, tuple)):
            lng, lat = manual
            got = (-1, "MANUAL_COORD", (lng, lat, "manual"))
        else:
            qs = [manual] if isinstance(manual, str) else queries_for(u)
            for qi, q in enumerate(qs):
                time.sleep(1.2)
                res = geocode(q)
                if res:
                    got = (qi, q, res); break
        if not got:
            cache[str(u["id"])] = {"error": "all_queries_failed",
                                   "queries": [manual] if manual else queries_for(u)}
            print(f"[{idx+1}/{len(todo)}] FAIL id={u['id']} {u['name']}", flush=True)
            continue
        qi, q, (lng, lat, disp) = got
        glng, glat = wgs84_to_gcj02(lng, lat)
        cache[str(u["id"])] = {
            "q": q, "qlv": qi,
            "wgs": [round(lng, 5), round(lat, 5)],
            "gcj": [round(glng, 5), round(glat, 5)],
            "disp": disp,
        }
        print(f"[{idx+1}/{len(todo)}] id={u['id']} {u['name'][:18]} -> ({glng:.3f},{glat:.3f})", flush=True)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    print("cache saved:", CACHE)

if __name__ == "__main__":
    main()
