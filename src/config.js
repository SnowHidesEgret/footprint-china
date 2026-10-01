/**
 * 点亮中国 · 全局配置
 * 所有色值、常量集中于此（新中式墨色/宣纸/朱砂/鎏金配色）
 */

export const STORE_KEY = 'footprint_china_v1_store';
export const TOTAL_PROVINCES = 34;
export const MAX_MEMBERS = 4;
export const SYNC_DEBOUNCE_MS = 2000;

/** 家庭成员 4 人新中式配色 */
export const MEMBER_COLORS = [
  { name: '鎏金', value: '#C9A25E', glow: 'rgba(201, 162, 94, 0.55)', lightStroke: '#E6C98A' },
  { name: '青瓷', value: '#7FB3A3', glow: 'rgba(127, 179, 163, 0.55)', lightStroke: '#A6D5C7' },
  { name: '朱砂', value: '#C4574E', glow: 'rgba(196, 87, 78, 0.55)', lightStroke: '#E8857D' },
  { name: '黛蓝', value: '#5B7FA6', glow: 'rgba(91, 127, 166, 0.55)', lightStroke: '#88A9CE' },
];

/** 合家欢（多人点亮）金紫交辉配色 */
export const FAMILY_GLOW = {
  stroke: '#FAD961',
  glow: 'rgba(168, 85, 247, 0.65)',
  gradient: ['#F59E0B', '#A855F7'],
};

/** 同步 Worker API 端点基址（本地开发或部署域名） */
export const SYNC_API_BASE = '';

/** 十段线示意坐标（南海诸岛插图用，U 形走向：台湾以东 → 菲律宾以西 → 南沙以南 → 越南以东 → 粤琼以南） */
export const TEN_DASH_LINE = [
  [123.8, 25.8], [122.8, 23.0], [121.8, 20.5], [120.3, 18.0],
  [118.8, 15.0], [117.2, 12.0], [115.5, 9.5], [113.8, 7.0],
  [112.3, 4.5], [110.8, 5.5], [109.8, 8.5], [109.0, 12.0],
  [108.6, 15.5], [109.2, 18.5], [110.2, 21.0],
];

/** 需要加大点击热区的小行政区（adcode → 显示名） */
export const SMALL_REGION_HIT = {
  '110000': '北京市',
  '120000': '天津市',
  '310000': '上海市',
  '810000': '香港特别行政区',
  '820000': '澳门特别行政区',
};
export const HIT_CIRCLE_R = 22;

export const THEMES = {
  dark: {
    name: '暗夜曜石',
    bg0: '#080c16',
    bg1: '#0e1626',
    provinceFill: 'rgba(255, 255, 255, 0.032)',
    provinceStroke: 'rgba(148, 163, 184, 0.40)',
    provinceHoverFill: 'rgba(255, 215, 140, 0.08)',
    provinceHoverStroke: 'rgba(255, 224, 160, 0.78)',
    litStroke: '#FFE4B5',
    glow: 'rgba(255, 145, 50, 0.52)',
    text: '#f1f5f9',
    textDim: '#94a3b8',
    capsuleBg: 'rgba(12, 18, 32, 0.78)',
    capsuleBorder: 'rgba(255, 215, 140, 0.16)',
    insetBorder: 'rgba(148, 163, 184, 0.38)',
    dashLine: '#94a3b8',
    tooltipBg: 'rgba(10, 15, 28, 0.94)',
    dangerText: '#1a1005',
    particleColors: ['#FFB84D', '#FF8C38', '#FFE0B2', '#FFD27A'],
  },
  light: {
    name: '水墨素绢',
    bg0: '#f7f4ec',
    bg1: '#ebe4d3',
    provinceFill: 'rgba(80, 60, 45, 0.045)',
    provinceStroke: 'rgba(110, 90, 70, 0.46)',
    provinceHoverFill: 'rgba(190, 55, 38, 0.08)',
    provinceHoverStroke: 'rgba(185, 45, 30, 0.78)',
    litStroke: '#a3281b',
    glow: 'rgba(195, 55, 38, 0.32)',
    text: '#241a12',
    textDim: '#786856',
    capsuleBg: 'rgba(247, 244, 236, 0.86)',
    capsuleBorder: 'rgba(130, 100, 75, 0.22)',
    insetBorder: 'rgba(110, 85, 65, 0.48)',
    dashLine: '#6b5c4d',
    tooltipBg: 'rgba(247, 244, 236, 0.96)',
    dangerText: '#ffffff',
    particleColors: ['#d98a2b', '#c47b26', '#e8a94e', '#b86a1e'],
  },
};

/** 点亮渐变（深色模式：鎏金落霞；浅色模式：朱砂印泥） */
export const LIT_GRADIENT = {
  dark: ['#FFB066', '#FF822E'],
  light: ['#e0543e', '#b82b1c'],
};
