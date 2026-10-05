#!/usr/bin/env python3
"""
Step 1: 从 Wikipedia 抓取国家5A级旅游景区 wikitext，解析表格，
按官方 5A 为单位归并，输出 tools/5a_units.json。
事实核定：
- 乔家大院：2021-05 已恢复 5A（山西文旅厅 2025-12 官方确认山西 12 家），计入。
- 乐满地度假世界：2025 取消，不计入。
- 金佛山：神龙峡部分 2016 摘牌，保留金佛山。
"""
import json, re, sys, urllib.request, urllib.parse
from collections import Counter

WIKI_API = ("https://zh.wikipedia.org/w/api.php?action=parse"
            "&page=" + urllib.parse.quote("国家5A级旅游景区")
            + "&prop=wikitext&format=json&formatversion=2")
UA = {"User-Agent": "footprint-china-dataset-builder/1.0 (5A scenic dataset; one-off)"}

MERGE_UNITS = {
    "金山·焦山·北固山旅游景区",
    "土楼（永定·南靖）旅游景区",
    "中国共产党一大·二大·四大纪念馆景区",
    "两江四湖·象山景区",
    "矮寨·十八洞·德夯大峡谷景区",
    "岳阳楼—君山岛景区",
    "张家界武陵源—天门山旅游区",
    "云台山—神农山—博爱青天河风景名胜区",
    "三峡大坝-屈原故里旅游区",
    "八达岭-慕田峪长城",  # 官方计为 1 个 5A（北京 9 家）
}
# 合并后采用官方正式名
MERGE_NAME_OVERRIDE = {
    "八达岭-慕田峪长城": "八达岭—慕田峪长城旅游区",
}
COLS = ["prov", "n", "city", "county", "name", "batch"]

def split_frags(s):
    frags, buf, depth, i = [], [], 0, 0
    while i < len(s):
        if s.startswith("[[", i):
            depth += 1; buf.append("[["); i += 2
        elif s.startswith("]]", i):
            depth = max(0, depth - 1); buf.append("]]"); i += 2
        elif s[i] == "|" and depth == 0:
            frags.append("".join(buf)); buf = []; i += 1
        else:
            buf.append(s[i]); i += 1
    frags.append("".join(buf))
    return frags

def parse_cell(s):
    s = s.strip()
    if s[:1] in ("!", "|"):
        s = s[1:]
    rs = 1
    while True:
        m = re.match(r'\s*(rowspan|colspan|scope|style|class)="[^"]*"', s)
        if not m:
            break
        if m.group(1) == "rowspan":
            rs = int(re.search(r"\d+", m.group(0)).group())
        s = s[m.end():]
    s = s.strip()
    if s.startswith("|"):
        s = s[1:]
    t = s.strip()
    t = re.sub(r"<s>.*?</s>", "", t, flags=re.S)
    t = re.sub(r"~~.*?~~", "", t)
    t = re.sub(r"<del>.*?</del>", "", t, flags=re.S)
    t = re.sub(r"<ref[^>]*>.*?</ref>", "", t, flags=re.S)
    t = re.sub(r"<ref[^>]*/>", "", t)
    t = t.replace("<br>", " ").replace("<br/>", " ").replace("<br />", " ")
    t = re.sub(r"\[\[([^|\]]+)\|([^\]]+)\]\]", r"\2", t)
    t = re.sub(r"\[\[([^\]]+)\]\]", r"\1", t)
    return rs, re.sub(r"\s+", " ", t).strip()

def cells_from_frags(frags):
    """把 fragments 合并为单元格（处理纯属性片段与下一片段合并）。"""
    cells, i = [], 0
    while i < len(frags):
        f = frags[i].strip()
        body = f[1:] if f[:1] in ("!", "|") else f
        if re.fullmatch(r"\s*(?:(?:rowspan|colspan|scope|style|class)=\"[^\"]*\"\s*)+",
                        body) and i + 1 < len(frags):
            cells.append(parse_cell(body + "|" + frags[i + 1]))
            i += 2
            continue
        cells.append(parse_cell(f))
        i += 1
    return cells

def main():
    req = urllib.request.Request(WIKI_API, headers=UA)
    wt = json.load(urllib.request.urlopen(req, timeout=60))["parse"]["wikitext"]
    m = re.search(r"\{\|(.*?)\n\|\}", wt, flags=re.S)
    table = m.group(1)
    chunks = re.split(r"(?m)^\|-", table)[1:]

    rows, active, edge_log = [], {}, []
    for ci, chunk in enumerate(chunks):
        cur = {}
        for cidx in sorted(active):
            val, rem = active[cidx]
            cur[COLS[cidx]] = val
            active[cidx][1] = rem - 1
            if active[cidx][1] <= 0:
                del active[cidx]
        free = [c for c in COLS if c not in cur]
        K = len(free)

        lines = [ln for ln in chunk.split("\n") if ln.strip()[:1] in ("|", "!")]
        assigned, register = {}, []
        if len(lines) > 1:
            # 多行风格：严格按位置
            cells = [parse_cell(ln) for ln in lines]
            if len(cells) == K:
                for (rs, t), c in zip(cells, free):
                    assigned[c] = t
                    if rs > 1:
                        register.append((c, t, rs))
            else:
                edge_log.append((ci, f"multiline len!=K cells={[(r,t) for r,t in cells]}"))
        else:
            # 单行风格：用 batch/name 锚定
            frags = split_frags(lines[0] if lines else chunk)
            cells = cells_from_frags(frags)
            texts = [t for _, t in cells]
            # batch = 最后一个含 YYYY/ 的单元格；name = 它之前最后一个非空
            bi = next((i for i in range(len(texts) - 1, -1, -1)
                       if re.search(r"\d{4}/", texts[i])), None)
            if bi is None:
                bi = next((i for i in range(len(texts) - 1, -1, -1) if texts[i]), None)
            if bi is None:
                edge_log.append((ci, "empty row"))
                rows.append({c: cur.get(c, "") for c in COLS})
                continue
            ni = next((i for i in range(bi - 1, -1, -1) if texts[i]), None)
            lead = [(rs, t) for rs, t in cells[:ni] if t] if ni is not None else []
            # 去掉行首多余空片段后，lead 应对应 free 去掉 name/batch 后的前若干列
            rest_free = [c for c in free if c not in ("name", "batch")]
            if len(lead) <= len(rest_free) and ni is not None:
                for (rs, t), c in zip(lead, rest_free):
                    assigned[c] = t
                    if rs > 1:
                        register.append((c, t, rs))
                assigned["name"] = texts[ni]
                assigned["batch"] = texts[bi]
                # 其余 free 列置空
                for c in free:
                    assigned.setdefault(c, "")
            else:
                edge_log.append((ci, f"singleline align fail lead={lead} free={free}"))
        for c, t, rs in register:
            active[COLS.index(c)] = [t, rs - 1]
        row = {c: cur.get(c, "") for c in COLS}
        row.update(assigned)
        rows.append(row)

    print(f"rows: {len(rows)}, edge: {len(edge_log)}")
    for ci, msg in edge_log[:25]:
        print(f"  edge#{ci}: {msg[:220]}")
    dropped = [r for r in rows if not r["name"]]
    print(f"dropped (empty name): {len(dropped)}")
    rows = [r for r in rows if r["name"]]

    def unit_key(name):
        mm = re.search(r"（(.+)）$", name)
        return mm.group(1) if mm else None

    groups, singles = {}, []
    for r in rows:
        k = unit_key(r["name"])
        if k and k in MERGE_UNITS:
            groups.setdefault(k, []).append(r)
        else:
            r["name"] = re.sub(r"（.+）$", "", r["name"]).strip()
            singles.append(r)
    units = list(singles)
    for k, rs in groups.items():
        r0 = rs[0]
        units.append({"prov": r0["prov"], "city": r0["city"], "county": r0["county"],
                      "name": MERGE_NAME_OVERRIDE.get(k, k), "batch": r0["batch"],
                      "merged_from": [x["name"] for x in rs]})
    for u in units:
        mt = re.search(r"(\d{4})/", u.pop("batch"))
        u["batch_year"] = int(mt.group(1)) if mt else None

    cnt = Counter(u["prov"] for u in units)
    print(f"\nTOTAL units: {len(units)} (official target 358)")
    for p in sorted(cnt, key=lambda x: list(Counter(u["prov"] for u in units).keys()).index(x)):
        pass
    # 按首次出现顺序打印
    seen = []
    for u in units:
        if u["prov"] not in seen:
            seen.append(u["prov"])
    for p in seen:
        print(f"  {p}: {cnt[p]}")
    b24 = sorted(set(u["name"] for u in units if u["batch_year"] == 2024))
    print(f"\n2024 batch rows: {len(b24)}")
    for n in b24:
        print(f"   - {n}")

    units.sort(key=lambda u: (u["prov"], u["batch_year"] or 0, u["name"]))
    for i, u in enumerate(units, 1):
        u["id"] = i
    with open("tools/5a_units.json", "w", encoding="utf-8") as f:
        json.dump(units, f, ensure_ascii=False, indent=1)
    print("wrote tools/5a_units.json")

if __name__ == "__main__":
    main()
