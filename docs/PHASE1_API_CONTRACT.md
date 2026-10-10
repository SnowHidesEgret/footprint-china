# Phase 1 API 契约（Worker ↔ 前端）

> 2026-10-10 定稿。Worker 先行，前端随后。旧客户端 24h 缓存窗口内必须可用。

## KV 数据模型

### `user:{userId}`
```json
{
  "userId": "u_kx3m9pq2",
  "nickname": "爸爸",
  "color": "#C9A25E",
  "footprint": {
    "provinces": {"110000": 1791000000000},
    "cities": {"320500": 1791000000000},
    "spots": {"5a:1": 1791000000000},
    "memos": {"320500": {"text": "...", "updatedAt": 1791000000000}},
    "unlockedAchievements": [],
    "maxTitleLevel": 3
  },
  "roomCodes": ["542591"],
  "createdAt": 1791000000000,
  "updatedAt": 1791000000000,
  "mergedInto": null
}
```

### `room:{code}`
```json
{
  "code": "542591",
  "name": "我们家",
  "ownerUserId": "u_xxxx",
  "createdAt": 1791000000000,
  "memberUserIds": [
    {"userId": "u_xxxx", "joinedAt": 1791000000000}
  ]
}
```

## 新 API

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| PUT | `/api/users/:userId` | `{nickname?, color?, footprint?, roomCodes?}` | `{ok:true}` | upsert，服务端盖 updatedAt |
| GET | `/api/users/:userId` | - | user 对象或 404 | |
| POST | `/api/rooms` | `{name, ownerUserId}` | `{code}` | 建房，owner 自动加入 |
| GET | `/api/rooms/:code` | - | `{code, name, ownerUserId, createdAt, members:[{userId, nickname, color, footprint, updatedAt, joinedAt}]}` | 读不到的 userId 跳过 |
| POST | `/api/rooms/:code/join` | `{userId}` | `{ok:true, members}` | 幂等；满 8 人 → 400 |
| POST | `/api/rooms/:code/claim` | `{fromUserId, toUserId}` | `{ok:true}` | 合并足迹，from 标 mergedInto |
| POST | `/api/rooms/:code/leave` | `{userId}` | `{ok:true}` | 房主退出 → 最早加入者继任；房空删房间 |
| DELETE | `/api/rooms/:code/members/:userId` | - | `{ok:true}` | 移出房间，不删 user |
| PATCH | `/api/rooms/:code` | `{name?, ownerUserId?}` | `{ok:true}` | 改名/转让 |

## 旧 API 兼容（必须保留）

| 旧接口 | 映射到新模型 |
|---|---|
| `POST /api/rooms {name}` | 按新接口处理，ownerUserId = 新生成的 userId |
| `POST /api/rooms/:code/join {name}` | 用 name 创建 user（userId = `m_` + 随机），加入房间 |
| `PUT /api/rooms/:code/members/:id {name,color,footprint}` | 写入 `user:{id}`（upsert），并确保 id 在房间 memberUserIds 中 |
| `GET /api/rooms/:code` | 返回新形状（前端已更新；旧前端在 24h 后自然淘汰） |

## 合并规则（claim 用）

- 省：取较早 `litAt`（首次点亮时间）
- 市：布尔并集
- 5A：取较早时间戳
- memos：取 `updatedAt` 较晚者
- 成就：并集
- 称号：取大（maxTitleLevel 取 max）

## 迁移脚本要点

对现有房间（542591、784463、101298）：
1. 扫描 `room:{code}:member:*` 全部成员键
2. 每个写成 `user:{memberId}`（memberId 保持 `m_` 前缀不变）
3. 写新 `room:{code}`（name 默认为"家庭房间"；owner = 足迹量最大者）
4. 旧成员键保留 30 天 TTL（可回滚）
