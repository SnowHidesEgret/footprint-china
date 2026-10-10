#!/usr/bin/env python3
"""
点亮中国 Phase 1 KV 迁移脚本
将旧模型（room:{code} + room:{code}:member:{id}）迁移到新模型（user:{id} + room:{code}）
- 旧 memberId（m_ 前缀）原样作为 userId
- 房间 owner = 足迹量最大者
- 旧键保留不删（可回滚）
"""
import sys
sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import dynamic_credential_entry
import subprocess, json, urllib.parse

entry = dynamic_credential_entry("custom.cloudflare")
surrogate = str(entry["surrogate"]).strip()
HEADER = f"Authorization: Bearer {surrogate}"
ACCOUNT = "37cdf1e041a4b69430ec3072bb507829"
NS = "b554cebe888e4ae19ce8a142c937b454"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{NS}"

def api_get(path):
    out = subprocess.run(
        ["curl", "-sS", "-m", "30", "-H", HEADER, BASE + path],
        capture_output=True, text=True
    )
    return json.loads(out.stdout)

def api_put(key, data):
    url = BASE + "/values/" + urllib.parse.quote(key, safe='')
    out = subprocess.run(
        ["curl", "-sS", "-m", "30", "-X", "PUT", "-H", HEADER,
         "-H", "Content-Type: application/json",
         "--data", json.dumps(data, ensure_ascii=False), url],
        capture_output=True, text=True
    )
    result = json.loads(out.stdout)
    return result.get("success", False)

def kv_get(key):
    url = BASE + "/values/" + urllib.parse.quote(key, safe='')
    out = subprocess.run(
        ["curl", "-sS", "-m", "30", "-H", HEADER, url],
        capture_output=True, text=True
    )
    try:
        return json.loads(out.stdout)
    except:
        return None

def count_footprint(fp):
    if not fp or not isinstance(fp, dict):
        return 0
    return len(fp.get("provinces", {})) + len(fp.get("cities", {}))

# 要迁移的房间
ROOM_CODES = ["542591", "784463", "101298"]

for code in ROOM_CODES:
    print(f"\n=== 迁移房间 {code} ===")
    
    # 1. 列出该房间的所有成员键
    keys_res = api_get("/keys?prefix=" + urllib.parse.quote(f"room:{code}:member:"))
    member_keys = [k["name"] for k in keys_res.get("result", [])]
    print(f"  找到 {len(member_keys)} 个成员键")
    
    if not member_keys:
        print(f"  跳过（无成员）")
        continue
    
    # 2. 读取每个成员，写入 user:{id}
    users = []
    for mk in member_keys:
        member_id = mk.split(":")[-1]
        data = kv_get(mk)
        if not data:
            print(f"  警告：{mk} 读取失败，跳过")
            continue
        
        fp = data.get("footprint", {})
        user = {
            "userId": member_id,
            "nickname": data.get("name", "家人")[:16],
            "color": data.get("color", "#C9A25E"),
            "footprint": {
                "provinces": fp.get("provinces", {}),
                "cities": fp.get("cities", {}),
                "spots": fp.get("spots", {}),
                "memos": fp.get("memos", {}),
                "unlockedAchievements": fp.get("unlockedAchievements", []),
                "maxTitleLevel": fp.get("maxTitleLevel", 0),
            },
            "roomCodes": [code],
            "createdAt": data.get("updatedAt", 0) or 0,
            "updatedAt": data.get("updatedAt", 0) or 0,
            "mergedInto": None,
        }
        if api_put(f"user:{member_id}", user):
            print(f"  ✓ user:{member_id} ({user['nickname']})")
            users.append((member_id, count_footprint(fp), data.get("updatedAt", 0)))
        else:
            print(f"  ✗ user:{member_id} 写入失败")
    
    # 3. 选足迹量最大者为 owner
    if not users:
        print(f"  无有效用户，跳过房间写入")
        continue
    users.sort(key=lambda x: (-x[1], x[2]))
    owner_id = users[0][0]
    print(f"  房主：{owner_id}（足迹量 {users[0][1]}）")
    
    # 4. 写入新 room:{code}
    # 读取旧房间的 createdAt
    old_room = kv_get(f"room:{code}")
    created_at = (old_room.get("createdAt", 0) if old_room else 0) or 0
    
    new_room = {
        "code": code,
        "name": "家庭房间",
        "ownerUserId": owner_id,
        "createdAt": created_at,
        "memberUserIds": [
            {"userId": uid, "joinedAt": 0} for uid, _, _ in users
        ],
    }
    if api_put(f"room:{code}", new_room):
        print(f"  ✓ room:{code} 已更新（{len(users)} 成员，房主 {owner_id}）")
    else:
        print(f"  ✗ room:{code} 写入失败")

print("\n迁移完成。旧 room:{code}:member:* 键保留未删（可回滚）。")
