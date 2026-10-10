# 点亮中国 · 用户与房间系统重构设计方案

> 版本：v1.0（2026-10-10）
> 背景：用户反馈房间逻辑混乱——房间号靠记忆、成员名单曾与数据对不上。目标：引入轻量用户体系 + 大厅 + 可管理的家庭房间。
> 约束：纯静态前端（Cloudflare Pages）+ Cloudflare Worker + KV，无框架；家庭可信场景，不做密码/OAuth。

---

## 一、先说结论：四个关键决策

| # | 决策 | 一句话理由 |
|---|------|-----------|
| 1 | **足迹归属从"房间成员"改为"用户本人"（全局）** | "我的足迹跟我走"。现在同一个人进两个房间会有两份足迹，认知负担大；改完后房间只是"一起看足迹"的视图 |
| 2 | **身份只做"档案"不做"账号"**：userId 是 UUID，无密码 | 家庭场景摩擦最小；但必须配套"认领"流程，否则清浏览器数据依然丢身份（详见 §7） |
| 3 | **"房主"是便利性概念，不是安全边界** | 无认证体系下，任何拿到房间码的人调 API 都能踢人/改名。UI 保留现有警告并扩展，不对外宣称安全 |
| 4 | **入口保持地图优先，大厅作为独立视图** | 现有用户习惯是打开即地图；大厅是房间管理中心，不是 landing 页（§8 展开） |

---

## 二、数据模型

### 2.1 localStorage（Store version 4 → 5，key 不变：`footprint_china_v1_store`）

```jsonc
{
  "version": 5,
  "theme": "dark",
  "soundEnabled": true,
  // 身份层：本机档案（支持一机多档案，如全家共用一台平板）
  "users": [
    {
      "userId": "u_kx3m9pq2",          // 新：u_ 前缀；老 m_ 前缀继续有效
      "nickname": "爸爸",
      "color": "#C9A25E",
      "createdAt": 1791194398000,
      "updatedAt": 1791194398743
    }
  ],
  "activeUserId": "u_kx3m9pq2",         // 当前使用的档案（替代 currentMemberId）
  // 足迹层：按 userId 存放（替代原来挂在 member 下）
  "footprints": {
    "u_kx3m9pq2": {
      "provinces": { "110000": { "name": "北京市", "litAt": 1789000000000 } },
      "cities": { "320500": true },
      "spots": { "5a:1": 1791000000000 },
      "memos": { "320500": { "text": "…", "updatedAt": 1791000000000 } },
      "unlockedAchievements": ["first_light"],
      "maxTitleLevel": 3,
      "updatedAt": 1791194398743
    }
  },
  // 房间层：我加入过的房间列表（替代单个 roomCode）
  "rooms": [
    {
      "code": "542591",
      "name": "我们家",                 // 从服务端同步，本地缓存
      "role": "owner",                 // owner | member（本地缓存，服务端为准）
      "joinedAt": 1791163495000,
      "lastOpenedAt": 1791194400000
    }
  ],
  "activeRoomCode": "542591"           // 当前正在查看的房间；null = 只看自己
}
```

字段说明：
- `users[]` 替代 `members[]`；`footprints{}` 与 users 解耦存放，避免大对象嵌套导致整包读写放大。
- `rooms[]` 按 `lastOpenedAt` 倒序排，大厅展示用。
- `activeRoomCode=null` 时地图只渲染 activeUser 自己的足迹（纯本机/个人模式）。

### 2.2 KV（Cloudflare）

```
user:{userId}                  → 用户档案（全局唯一数据源）
room:{code}                    → 房间元数据
transfer:{otp}                 → 身份迁移一次性码（Phase 3，TTL 600 秒）
```

**`user:{userId}`**
```jsonc
{
  "userId": "u_kx3m9pq2",
  "nickname": "爸爸",
  "color": "#C9A25E",
  "footprint": { "provinces": {}, "cities": {}, "spots": {}, "memos": {},
                 "unlockedAchievements": [], "maxTitleLevel": 0 },
  "roomCodes": ["542591"],            // 加入过的房间（用于新设备认领身份后自动恢复房间列表）
  "createdAt": 1791194398000,
  "updatedAt": 1791194398743,
  "mergedInto": null                  // 被认领合并后指向新 userId（保留原记录防误操作）
}
```

**`room:{code}`**
```jsonc
{
  "code": "542591",
  "name": "我们家",
  "ownerUserId": "u_kx3m9pq2",
  "createdAt": 1791163494896,
  "memberUserIds": [                  // 对象数组（带加入时间，供房主转让排序）
    { "userId": "u_kx3m9pq2", "joinedAt": 1791163494896 },
    { "userId": "u_ab12cd34", "joinedAt": 1791164777000 }
  ]
}
```

**不再需要的键**：`room:{code}:member:{id}`（成员快照）。房间成员数据改为实时读 `user:{userId}`。**这从根本上消灭了"名单与数据不一致"这类 bug**——成员关系只有一处真相（`room.memberUserIds`），数据只有一处真相（`user:{userId}`）。

> KV 读放大评估：GET 房间 = 1（room）+ N（users），N≤8，完全可接受。

### 2.3 新旧对照（迁移用）

| 旧 | 新 | 说明 |
|---|---|---|
| `members[].id` (`m_*`) | `users[].userId` | `m_` 前缀继续有效，无需重命名 |
| `members[].footprint` | `footprints[userId]` | 解耦存放 |
| `currentMemberId` | `activeUserId` | 改名 |
| `roomCode`（单个） | `rooms[]` + `activeRoomCode` | 支持多房间 |
| `room:{code}` = `{createdAt, memberIds[]}` | `{code, name, ownerUserId, createdAt, memberUserIds[{userId,joinedAt}]}` | 加名、加房主、加加入时间 |
| `room:{code}:member:{m_id}` | `user:{m_id}`（直接复用旧 id！） | **旧成员 id 原样成为 userId，零重命名** |

---

## 三、API 变更

基础规则不变：REST over Worker，无认证，6 位数字码，CORS 保持。**部署顺序：先 Worker，后前端**（旧前端缓存 24h，新 Worker 必须双语兼容，见 §6）。

### 3.1 用户

```
PUT /api/users/:userId
  body: { nickname?, color?, footprint?, roomCodes? }   // 部分更新
  → { ok: true }
  说明：upsert；服务端盖 updatedAt = Date.now()；roomCodes 做并集合并。
  幂等，可高频调用（防抖仍由前端做）。

GET /api/users/:userId
  → { user: { userId, nickname, color, footprint, roomCodes, updatedAt } } | 404
  用途：身份迁移码认领后拉取档案。
```

### 3.2 房间

```
POST /api/rooms
  body: { name, ownerUserId }                 // name 为空 → "XX的家庭房间"
  → 201 { code }
  说明：建房即自动加入（memberUserIds=[owner]）；6 位码碰撞重试逻辑保留。

GET /api/rooms/:code
  → { code, name, ownerUserId, createdAt,
      members: [{ userId, nickname, color, footprint, updatedAt, joinedAt }] }
  说明：members 按 joinedAt 排序；读不到的 userId 自动跳过（数据自愈，不再崩）。

POST /api/rooms/:code/join
  body: { userId }                            // 新；兼容旧 { name }（见 §6）
  → { room }  // 同 GET 形状
  说明：幂等——userId 已在成员中则直接返回房间（多设备重复加入不产生重复）；
        未加入且人数 ≥ MAX_MEMBERS(8) → 400 { error: '房间成员已满' }。

POST /api/rooms/:code/claim
  body: { fromUserId, toUserId }
  → { ok: true, merged: { provinces: n, cities: n, spots: n, memos: n } }
  说明：认领流程（§5.5）。from 须在房间成员中；to 须是已存在的 user。
        服务端按 §5.6 合并规则把 from 的足迹并入 to，房间名单 from→to（保留原 joinedAt），
        user:{from}.mergedInto = to（原记录保留防误操作）。

POST /api/rooms/:code/leave
  body: { userId }
  → { ok: true, newOwnerUserId? }
  说明：成员退出。若退出者是房主 → 房主自动转让给 joinedAt 最早的剩余成员并返回；
        若房间空了 → 删除 room:{code}（§7.4）。

DELETE /api/rooms/:code/members/:userId
  → { ok: true }
  说明：房主移出成员（客户端校验 role=owner；服务端信任，见 §8 风险 2）。
        只删房间名单，不删 user:{userId}（足迹是用户自己的）。

PATCH /api/rooms/:code
  body: { name?, ownerUserId? }               // ownerUserId 须是现任成员
  → { ok: true, room }
  说明：改房间名 / 转让房主。客户端校验操作者是房主；服务端信任。
```

### 3.3 兼容层（过渡期约 7 天，之后可删）

| 旧调用 | 新 Worker 的行为 |
|---|---|
| `POST /api/rooms` body `{name}` | 创建 user（nickname=name）+ 房间（owner=该 user），返回 `{code, memberId}`（旧形状，旧前端照常工作） |
| `POST /join` body `{name}` | 同上逻辑，返回 `{memberId, members}`（members 为旧形状数组） |
| `PUT /members/:id` body `{name,color,footprint}` | 视为 `PUT /api/users/:id` + 确保进房间名单（即已部署的自愈逻辑，保留） |
| `GET /api/rooms/:code` | 在新形状基础上多返回 `members` 数组（旧前端只读此字段，忽略新增字段） |
| `DELETE /members/:id` | 从名单移除；保留 user 记录 |

---

## 四、核心流程

### 4.1 首次打开（新用户）

```
用户                    前端                          Worker
 │                       │                               │
 │  打开 App             │                               │
 │──────────────────────▶│  store v5 初始化，无 users    │
 │                       │  生成 userId=u_xxx             │
 │                       │  弹窗：给自己起个名字（默认"我"）│
 │                       │  本地落盘 users[0]             │
 │                       │──PUT /api/users/u_xxx─────────▶│  upsert（离线则跳过）
 │                       │                               │
 │  看到地图（个人模式）  │                               │
 │◀──────────────────────│  右上角"大厅"按钮呼吸提示一次   │
```

### 4.2 建房 → 分享 → 家人加入

```
爸爸                     前端A                  Worker              前端B（妈妈）
 │                       │                       │                    │
 │ 大厅→[创建家庭房间]    │                       │                    │
 │ 输入"我们家"          │                       │                    │
 │──────────────────────▶│──POST /api/rooms─────▶│                    │
 │                       │  {name:"我们家",      │  生成 542591       │
 │                       │   ownerUserId:u_爸}   │  memberUserIds=[爸] │
 │                       │◀────{code:542591}────│                    │
 │  看到分享卡：         │                       │                    │
 │  房间码 542591 [复制] │                       │                    │
 │◀──────────────────────│                       │                    │
 │                       │                       │                    │
 │  (微信发码给妈妈)      │                       │                    │
 │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶│
 │                       │                       │                    │
 │                       │                       │       妈妈：大厅→[加入房间]
 │                       │                       │       输入 542591   │
 │                       │                       │◀──GET /api/rooms───│
 │                       │                       │──房间预览卡────────▶│
 │                       │                       │  "我们家 · 1人"    │
 │                       │                       │       [确认加入]    │
 │                       │                       │◀─POST /join────────│
 │                       │                       │    {userId:u_妈}   │
 │                       │                       │  幂等加入          │
 │                       │◀──(爸爸下次打开      │                    │
 │                          GET room 看到妈妈)   │                    │
```

### 4.3 日常同步（变化点）

- 本地足迹变更 → 防抖 2s → `PUT /api/users/:userId {footprint}`（原来是 PUT 到房间成员路径）。
- 打开 App / 切换房间 → `GET /api/rooms/:code` → 刷新**房间成员视图**（只读，不再像旧 `mergeRemoteMembers` 那样把云端成员并入本地档案——"我的档案"与"房间成员"彻底分离）。
- 本机多档案（共用平板）：每个档案独立 userId，各自 PUT，互不干扰。

### 4.4 大厅（视图，非入口）

```
┌─ 大厅 ─────────────────────────────┐
│ 👤 爸爸  [切换档案] [改名]          │  ← 身份区：昵称/配色/我的统计
│    29省 · 69市 · 5A 12/359        │     （统计来自本地 footprints[activeUserId]）
│                                    │
│ 🏠 我的房间                        │
│  ┌──────────────────────────────┐  │
│  │ 我们家  542591 · 房主 · 4人  │  │ ← 点击进入（设为 activeRoomCode，看全家地图）
│  │ 上次打开 2小时前      [进入] │  │
│  └──────────────────────────────┘  │
│  [+ 创建家庭房间]  [加入房间：      ]│
│                                    │
│  (未加入任何房间时显示引导文案)      │
└────────────────────────────────────┘
```

### 4.5 认领流程（清浏览器数据后的恢复）

```
用户（清过数据，新 userId=u_new）      前端                    Worker
 │                                    │                         │
 │  大厅→[加入房间]→输入 542591        │                         │
 │───────────────────────────────────▶│──GET /api/rooms─────────▶│
 │                                    │◀──members:[爸,妈,逍,遥]──│
 │  看到："这个房间已有 4 位成员，      │                         │
 │   你是他们中的一位吗？"             │                         │
 │  [我是爸爸] [我是新成员]            │                         │
 │───────────────────────────────────▶│                         │
 │  选[我是爸爸]→二次确认              │                         │
 │  "认领后，爸爸的足迹将并入你当前身份"│                         │
 │───────────────────────────────────▶│─POST /claim────────────▶│
 │                                    │  {from:u_爸old,          │ 合并足迹(§5.6)
 │                                    │   to:u_new}             │ 名单替换
 │                                    │◀──{ok, merged}──────────│ user:{old}.mergedInto=u_new
 │  本地：nickname/color 采用"爸爸"     │                         │
 │◀───────────────────────────────────│ toast"已认领爸爸的身份"  │
```

### 4.6 足迹合并规则（claim / 多设备冲突统一用）

| 数据 | 规则 | 理由 |
|---|---|---|
| `provinces[adcode]` | 保留 **较早** 的 `litAt`；name 取非空者 | 第一次到达的时间是事实 |
| `cities[adcode]` | 布尔并集 | 去过就是去过 |
| `spots["5a:id"]` | 保留较早的时间戳 | 首次打卡为准 |
| `memos[adcode]` | 保留 `updatedAt` 较晚的一条 | 记忆以最后一次编辑为准 |
| `unlockedAchievements` | 数组并集去重 | 只多不少 |
| `maxTitleLevel` | 取较大值 | 同上 |

---

## 五、迁移方案（不能丢数据）

### 5.1 前端 localStorage v4 → v5（代码内自动）

```js
// 伪代码
if (raw.version === 4) {
  users = raw.members.map(m => ({ userId: m.id, nickname: m.name, color: m.color, ... }));
  footprints = Object.fromEntries(raw.members.map(m => [m.id, m.footprint]));
  activeUserId = raw.currentMemberId;
  rooms = raw.roomCode
    ? [{ code: raw.roomCode, name: "家庭房间", role: "member", joinedAt: Date.now(), lastOpenedAt: 0 }]
    : [];
  // name/role 在下次 GET room 时校准
  activeRoomCode = raw.roomCode || null;
}
```
- `m_` 前缀的旧 id **原样作为 userId**，云端 `user:{m_xxx}` 与之一一对应，无需映射表。
- 迁移后立即 PUT 一次 `user:{userId}`（带 roomCodes），把身份在云端"扶正"。

### 5.2 后端 KV 迁移（一次性脚本，实施人手动跑一次）

已知房间：`542591`（4 成员）、`784463`（2 测试成员）、`101298`（空）。

对每个 `room:{code}`：
1. `memberIds = room.memberIds ∪ { KV LIST prefix="room:{code}:member:" 的全部 id }`（取并集，防名单丢失）。
2. 对每个 mid：读 `room:{code}:member:{mid}` → 写 `user:{mid}` = `{userId: mid, nickname, color, footprint, roomCodes: [code], createdAt, updatedAt}`。
3. 写新 `room:{code}` = `{code, name: "家庭房间", ownerUserId: pickOwner(members), createdAt, memberUserIds: [{userId, joinedAt: createdAt}…]}`。
   - `pickOwner`：足迹量（省+市）最大者；并列取原 memberIds 第一个。542591 → 爸爸（29省69市）。
4. 旧 `room:{code}:member:{mid}` 键：**设置 30 天 TTL 后保留**（`expirationTtl`），到期自动清理；期间可随时回滚。

空房间 `101298`：`memberUserIds: []`，`ownerUserId: null`，name 照旧。

### 5.3 部署顺序（重要）

1. 跑 KV 迁移脚本（读写都在新旧两套键上，无缝）。
2. 部署**双语 Worker**（§3.3）。
3. 观察 1 天（看旧客户端是否正常同步）。
4. 部署新前端（v5）。
5. 7 天后删除 Worker 兼容层（可选，留着也无妨，代码量小）。

---

## 六、边界情况

| # | 场景 | 处理 |
|---|---|---|
| 1 | 清浏览器数据 | userId 丢失 → 按 §4.5 认领流程恢复；房间码一般在家人聊天记录里能找到 |
| 2 | 同一人多设备 | Phase 1：会产生两个 userId（ duplicates），可用认领/合并处理；Phase 3：身份迁移码（§9）彻底解决 |
| 3 | 房主退出 | `POST /leave` 时自动转让给 `joinedAt` 最早的剩余成员，返回 `newOwnerUserId`，前端 toast 提示 |
| 4 | 房主被踢/账号丢失 | 同上——"最早加入者继任"规则兜底，不会出现无主房间 |
| 5 | 房间变空 | 删除 `room:{code}`；加入时统一提示"房间码不正确或房间已解散"（不做墓碑，KISS） |
| 6 | 6 位码碰撞 | 保留现有 5 次重试；90 万空间 + 房间极少删除，够用 |
| 7 | 成员上限 | 4 → **8**（KV 读放大 9 次以内；DEFAULT_COLORS 需补到 8 色，现有 6 色不够） |
| 8 | 被踢时离线 | 下次 GET 房间发现自己不在成员中 → 本地 rooms 移除该房间，toast" 你已被移出「我们家」" |
| 9 | 同一 userId 双开标签页 | PUT 整包 last-write-wins（与现状一致）；可接受，家庭场景极少冲突 |
| 10 | 改名为空/超长 | 沿用现有 sanitize（trim，≤16 字，空则回退） |
| 11 | 旧版前端（缓存 24h）打新 Worker | 双语兼容层覆盖（§3.3）；反向（新前端打旧 Worker）不可行，故先升 Worker |
| 12 | 房间名为空 | 建房时默认 `"${nickname}的家庭房间"` |

---

## 七、对初步想法的批判（不客气的版本）

1. **"userId 存 localStorage"并没有解决"清数据就丢身份"**——它只是把问题从"成员记录"搬到了"userId"。**真正解决问题的是认领流程（§4.5）**，userId 只是让认领成为可能（有稳定的认领目标）。方案里认领是 Phase 1 必须项，不是优化项。

2. **"进去后自动在大厅"建议否决**，理由：① 现有用户习惯是打开即地图，大厅 landing 会打断心流；② 大厅的本质是"房间管理"，低频操作，不配做入口；③ 地图首屏 + 大厅按钮 + 首次引导，体验更顺。坚持要大厅 landing 的话，A/B 看数据再说。

3. **"房主可踢人"在无认证体系下是纸糊的权限**。任何人拿到房间码调 `DELETE` 就能踢人。必须做到两点：① UI 保留并强化现有警告（"知道房间码的人都能管理房间"）；② 永远不要在对外文案里暗示"房主=安全"。这是便利性分工，不是权限体系。

4. **足迹归属的选择**：你原想法没明确说足迹跟人还是跟房间成员走。我选了**跟人走（全局）**，代价是迁移稍大，但换来三个好处：多房间不分裂足迹、大厅能显示"我的统计"、认领/迁移设备时语义清晰。如果选跟房间走，大厅的"我的"概念会塌掉。

5. **"不做实时在线状态"同意**，但要补一个细节：踢人/改名这类管理操作，被操作方**下次打开大厅或切换房间时**才感知（GET 时 diff）。不要在 App 打开时静默 GET 全量房间轮询——费电且没必要。

6. **颜色不够了**：成员上限提到 8，但 `MEMBER_COLORS` 只有 6 个、`DEFAULT_COLORS`（Worker）只有 4 个。实施时两处都要补色，否则第 7 个人没颜色。

7. **KV 最终一致性**：跨区写入后读可能短暂不一致，一家人都在国内，实际影响极小，知道即可，不用处理。

---

## 八、风险点直说

| 风险 | 等级 | 说明 |
|---|---|---|
| 迁移窗口的新旧交叉 | **高** | 旧前端（24h 缓存）× 新 Worker 必须可用 → 双语兼容是硬要求；部署顺序错不得（先 Worker 后前端） |
| 认领流程被冒用 | 中 | 无认证，拿到码就能认领任何人。本质是家庭信任模型；UI 上必须二次确认 + 显示合并的数据量，误操作可逆（原记录保留 `mergedInto` 标记 7 天……注：KV 需手动 TTL，写迁移脚本时一并处理） |
| claim 合并规则争议 | 中 | 如两条 memo 冲突只保留一条，用户可能觉得丢了数据。缓解：合并前展示"将合并 N 省 M 市 K 条记忆"，确认后再执行 |
| 本地 rooms 列表与服务端脱节 | 中 | 被踢/房间解散后本地列表 stale。缓解：每次进大厅 GET 校验，diff 后清理 + toast |
| 新概念教育成本 | 低 | "档案""大厅""认领"三个新词。缓解：大厅首屏一句话说明；认领流程用"你是他们中的一位吗？"这种大白话，不用术语 |
| Worker 单文件膨胀 | 低 | 双语兼容让 index.js 从 258 行涨到约 450 行。可接受；7 天后删兼容层回落 |

---

## 九、分阶段实施建议

### Phase 1：新身份与大厅（核心，必须一次做对）
- 前端：Store v5（users/footprints/rooms）、大厅视图、建房/加入/房间预览卡、认领流程、迁移代码
- 后端：新 API（§3.1–3.2）+ 双语兼容层（§3.3）、KV 迁移脚本、成员上限 8、补足配色
- 上线标准：老用户数据无损（抽查 542591 四人足迹前后一致）、旧版前端 24h 内同步正常
- **部署顺序：迁移脚本 → Worker →（观察1天）→ 前端**

### Phase 2：房间治理
- 房间改名、房主转让、移出成员、退出房间、空房自动删除
- 被踢/解散的本地感知与提示、房间成员上限 8 的完整校验
- 可独立上线，不依赖 Phase 3

### Phase 3：多设备与抛光
- 身份迁移码（`transfer:{otp}`，10 分钟有效）：`POST /api/transfer`、`GET /api/transfer/:otp`
- 重复身份合并工具（大厅"整理我的档案"：把两个 userId 的足迹按 §5.6 合并）
- 大厅体验打磨：我的统计、房间最后同步时间、空状态引导

---

## 十、附：关键 JSON 示例（实施时对照）

**建房请求/响应**
```jsonc
// POST /api/rooms
{ "name": "我们家", "ownerUserId": "u_kx3m9pq2" }
// → 201
{ "code": "542591" }
```

**加入预览（先 GET 再确认）**
```jsonc
// GET /api/rooms/542591
{
  "code": "542591", "name": "我们家", "ownerUserId": "u_kx3m9pq2",
  "createdAt": 1791163494896,
  "members": [
    { "userId": "u_kx3m9pq2", "nickname": "爸爸", "color": "#C9A25E",
      "joinedAt": 1791163494896, "updatedAt": 1791194398743,
      "footprint": { "provinces": {"110000": {"name": "北京市", "litAt": 1789…}}, "cities": {}, "spots": {}, "memos": {}, "unlockedAchievements": [], "maxTitleLevel": 3 } }
  ]
}
```

**认领**
```jsonc
// POST /api/rooms/542591/claim
{ "fromUserId": "m_muukidngvq0i", "toUserId": "u_newdevice99" }
// → 200
{ "ok": true, "merged": { "provinces": 29, "cities": 69, "spots": 3, "memos": 2 } }
```
