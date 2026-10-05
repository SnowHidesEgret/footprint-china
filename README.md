# 点亮中国 🗺️

交互式中国地图足迹网站：点击你去过的省份，点亮属于你的山河版图。

**在线访问**：https://map.snowyegret.top

## 功能

### 第一期 MVP（2026-09-29）
- 全国 34 个省级行政区 SVG 地图（含南海诸岛插图）
- 点击点亮 / 再次点击熄灭（防误触确认）
- 顶部进度胶囊：已点亮 x/34 + 百分比
- localStorage 本地持久化，刷新不丢失
- 深色 / 浅色双主题，移动端适配

### 第二期：视听与成就（2026-09-30）
- Web Audio 音效引擎：点亮水滴音、熄灭音、成就琶音，Combo 连击时半音爬升；右上角静音开关（localStorage 持久化）
- Canvas 金色粒子爆裂（点亮瞬间），进度阈值 10/25/50/75/100% 全屏礼花
- Combo xN 连击徽记
- 8 级山河称号（初见山海 → 山河大满贯）
- 12 个特色成就 + 成就墙陈列室（如集齐边疆省份、岛屿、火锅省份等）
- 地级市下钻：双击省份或点"探索城市"进入，面包屑导航，ESC 返回；
  34 省城市 GeoJSON 本地化于 `maps/cities/`（共 3.8MB）；
  城市点亮独立持久化，**不计入省级 x/34**

### 第三期：家庭多成员 + 云同步 + PK（2026-10-02）
- 家庭多成员档案：新建 / 切换 / 删除 / ✎ 行内改名（回车保存、ESC 取消），最多 6 人，
  6 款新中式配色自选（墨 / 朱砂 / 赭石 / 绛紫等）
- 6 位房间码加入家庭房间，多人共享一份地图
- 云同步：Cloudflare Worker（`footprint-china-sync`）+ KV（`ROOMS_KV`），
  2 秒防抖自动 PUT 同步，打开 / 加入时拉取全家数据，无网络时静默降级（只本地存）
- PK 透视对战面板：成员间点亮版图对比

### 修复（2026-10-05）
- 城市无法取消点亮：`onCityTap` 误用未定义变量 `adcode`（应为 `cadcode`），严格模式下抛错导致熄灭确认气泡弹不出（v=20261005a）
- 成员卡片加改名按钮，成员上限 4 人 → 6 人，新增"绛紫""赭石"两款配色（v=20261005b）

### 第四期：5A 胜迹（2026-10-05，v=20261005c → v=20261005e）
- 顶部双模式切换：🗺️ 省市足迹 ⇄ 🏛️ 5A 胜迹
- 5A 数据集 `maps/scenic-5a.json`：359 条（2026-10 口径），GCJ-02 坐标，与底图坐标系一致；
  字段含省/市 adcode、分类（红色/人文/现代/自然）、评定年份、坐标来源标注
- 数据口径：北京"八达岭—慕田峪"计 1 家；乔家大院计入（山西文旅厅 2025-12 确认复牌）；
  桂林乐满地不计入（2025 年摘牌）；文旅部 2026-01 公布 358 家，差异系复牌计入时点不同
- 5A 模式：底图变暗，359 个星点（双圆 SVG 光晕，无滤镜）；
  全国视图按省聚合为数量气泡，点击/双击省份下钻散开为单点
- 点景点 → 底部卡片一键打卡（可取消）；打卡独立于省市点亮，**绝不联动**
- 省市模式点亮城市时，若该市有 5A，弹出可关闭的底部卡片："你点亮了{市名}，这里有 N 个 5A 景区"，列表一键打卡
- 进度胶囊：x / 359（动态取数）；新增独立"名胜行者"称号线（初窥胜境 → 胜境大满贯，6 档）
- Store version 3：每成员 `footprint.spots`（key `5a:{id}`），老数据自动迁移；云同步整包透传
- v=20261005d 修复：面包屑导航 z-index 15 → 35，解决下钻后「中国」返回按钮被地图 SVG 层拦截点击的问题
- v=20261005e 性能：5A 聚合气泡的省几何中心计算加缓存（`centroidCache`），避免每次渲染重复遍历 34 个省的多边形坐标；切模式/下钻/打卡不再卡顿

## 技术

原生 HTML + CSS + JavaScript，**零构建**（无 npm、无打包），直接部署到 Cloudflare Pages。

- 地图渲染：原生 SVG + [d3-geo](https://github.com/d3/d3-geo)（ESM CDN）
- 地图数据：阿里云 DataV GeoAtlas（打包至 `maps/china.json`）；城市数据：34 省地级市 GeoJSON（打包至 `maps/cities/`）
- 状态：`src/store.js` 单向 Store → localStorage（本机多成员隔离，老数据平滑迁移）
- 云同步服务端：`worker/index.js`（Cloudflare Worker + KV）

```
├── index.html          页面骨架
├── styles.css          样式（含双主题 CSS 变量）
├── src/
│   ├── config.js       色值 / 常量（新中式墨色/宣纸/朱砂/鎏金配色、6 人成员配色）
│   ├── geo.js          GeoJSON 加载 + storage 读写
│   ├── store.js        单向状态管理（支持多用户与云同步）
│   ├── map.js          SVG 地图渲染 + 南海诸岛插图
│   ├── audio.js        Web Audio 音效引擎（零依赖）
│   ├── particles.js    Canvas 粒子引擎（零依赖）
│   ├── achievements.js 成就与称号系统（8 称号 / 12 成就）
│   ├── spots.js        5A 数据层（加载/按省市查询/名胜行者称号）
│   ├── sync.js         云同步客户端（防抖 PUT + 离线容灾）
│   └── main.js         入口：组装与交互
├── maps/
│   ├── china.json      全国省级 GeoJSON（DataV）
│   ├── scenic-5a.json  359 条 5A 景区（GCJ-02，含省市 adcode/分类/批次）
│   └── cities/         34 省地级市 GeoJSON（本地化，约 3.8MB）
├── worker/
│   └── index.js        云同步 Worker（房间 / 成员足迹 API）
├── wrangler.toml       Worker 配置（KV 绑定 ROOMS_KV）
├── _headers            Cloudflare 缓存头
└── _redirects          SPA 回退
```

## 本地预览

```bash
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000
```

## 部署

推送到 GitHub 后，Cloudflare Pages 自动从仓库构建部署（无需构建命令，输出目录为 `/`）。

⚠️ **缓存约定（每次改 JS/CSS 必须遵守）**：入口资源（`styles.css`、`src/main.js` 等）在 `index.html`
中用 `?v=YYYYMMDDx` 手工打版本号，每次改动后必须 bump，否则用户浏览器 24 小时缓存旧文件。
`_headers` 对 `/src/*`、`/styles.css`、`/maps/*` 用 `Cache-Control: no-cache`（靠 ETag 304），只给 `/` 300 秒。

## 云同步配置

- Worker 脚本名：`footprint-china-sync`，KV 命名空间绑定名 `ROOMS_KV`
- **注意**：该 Cloudflare 账号的 workers.dev 对所有 Worker 返回 1042（平台侧路由问题），
  已改用自定义域名 `sync.snowyegret.top`（Worker 路由 + 代理 A 记录）；
  `src/config.js` 的 `SYNC_API_BASE` 指向 `https://sync.snowyegret.top`
- Cloudflare API Token 权限有限（不能创建 Pages 项目 / 绑域名 / 自助提权），
  相关操作需在 Cloudflare 后台手动完成

## 设计文档

详见 [DESIGN.md](DESIGN.md)。
