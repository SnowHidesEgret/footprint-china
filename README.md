# 点亮中国 🗺️

交互式中国地图足迹网站：点击你去过的省份，点亮属于你的山河版图。

**在线访问**：https://map.snowyegret.top

## 功能（第一期 MVP）

- 全国 34 个省级行政区 SVG 地图（含南海诸岛十段线插图）
- 点击点亮 / 再次点击熄灭（防误触确认）
- 顶部进度胶囊：已点亮 x/34 + 百分比
- localStorage 本地持久化，刷新不丢失
- 深色 / 浅色双主题，移动端适配

## 技术

原生 HTML + CSS + JavaScript，**零构建**（无 npm、无打包），直接部署到 Cloudflare Pages。

- 地图渲染：原生 SVG + [d3-geo](https://github.com/d3/d3-geo)（ESM CDN）
- 地图数据：阿里云 DataV GeoAtlas（已打包至 `maps/china.json`，十段线为示意绘制）
- 状态：`src/store.js` 单向 Store → localStorage（键名 `footprint_china_v1_store`）

```
├── index.html          页面骨架
├── styles.css          样式（含双主题 CSS 变量）
├── src/
│   ├── config.js       色值 / 常量（设计稿色值固化于此）
│   ├── geo.js          GeoJSON 加载 + storage 读写
│   ├── store.js        单向状态管理
│   ├── map.js          SVG 地图渲染 + 南海诸岛插图
│   └── main.js         入口：组装与交互
├── maps/china.json     全国省级 GeoJSON（DataV）
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

## 设计文档

详见 [DESIGN.md](DESIGN.md)。
