/**
 * 点亮中国 · 全局配置
 * 所有色值、常量集中于此（对应 DESIGN.md Phase 0 准出要求：色值固化到配置文件）
 */

export const STORE_KEY = 'footprint_china_v1_store';
export const TOTAL_PROVINCES = 34;

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
    bg0: '#0a0e1a',
    bg1: '#0d1424',
    provinceFill: 'rgba(255,255,255,0.035)',
    provinceStroke: 'rgba(148,163,184,0.28)',
    provinceHoverFill: 'rgba(255,255,255,0.09)',
    provinceHoverStroke: 'rgba(255,224,178,0.75)',
    litStroke: '#FFE0B2',
    glow: 'rgba(255,140,56,0.55)',
    text: '#f1f5f9',
    textDim: '#94a3b8',
    capsuleBg: 'rgba(13,20,36,0.72)',
    capsuleBorder: 'rgba(148,163,184,0.22)',
    insetBorder: 'rgba(148,163,184,0.45)',
    dashLine: '#cbd5e1',
    tooltipBg: 'rgba(10,14,26,0.92)',
  },
  light: {
    name: '水墨素绢',
    bg0: '#faf7f0',
    bg1: '#f3ecdf',
    provinceFill: 'rgba(120,80,40,0.06)',
    provinceStroke: 'rgba(120,90,60,0.35)',
    provinceHoverFill: 'rgba(200,60,40,0.12)',
    provinceHoverStroke: 'rgba(180,50,35,0.8)',
    litStroke: '#a32e22',
    glow: 'rgba(200,60,40,0.35)',
    text: '#2b2118',
    textDim: '#8a7a66',
    capsuleBg: 'rgba(250,247,240,0.8)',
    capsuleBorder: 'rgba(120,90,60,0.25)',
    insetBorder: 'rgba(90,70,50,0.55)',
    dashLine: '#57534e',
    tooltipBg: 'rgba(43,33,24,0.92)',
  },
};

/** 点亮渐变（深色模式：落日金；浅色模式：朱砂红） */
export const LIT_GRADIENT = {
  dark: ['#FFA959', '#FF8C38'],
  light: ['#e0604a', '#c23a28'],
};
