/**
 * 点亮中国 · 5A 景区数据层
 * 加载 maps/scenic-5a.json，提供按省/市查询与分类元数据
 */

const SPOTS_URL = 'maps/scenic-5a.json';

let cache = null;

/** 分类标签（人文语义） */
export const CAT_LABELS = {
  red: '红色印记',
  hist: '人文古迹',
  modn: '现代乐园',
  nat: '自然山水',
};

/** 名胜行者称号线（独立于八级山河称号） */
export const SPOT_TITLES = [
  { level: 1, name: '初窥胜境', min: 1, desc: '打卡 1 个 5A 景区' },
  { level: 2, name: '十里胜踪', min: 10, desc: '打卡 10 个 5A 景区' },
  { level: 3, name: '卅胜在握', min: 30, desc: '打卡 30 个 5A 景区' },
  { level: 4, name: '八方胜览', min: 80, desc: '打卡 80 个 5A 景区' },
  { level: 5, name: '半壁胜景', min: 180, desc: '打卡 180 个 5A 景区' },
  // 第 6 档为"全部"，min 在运行时用 spots.length 动态判定
  { level: 6, name: '胜境大满贯', min: Infinity, desc: '打卡全部 5A 景区' },
];

/**
 * 根据打卡数推导名胜行者称号
 * @param {number} count 已打卡数
 * @param {number} total 5A 总数（动态）
 */
export function getSpotTitleByCount(count, total) {
  const n = typeof count === 'number' ? count : 0;
  const t = typeof total === 'number' && total > 0 ? total : 0;
  let current = null;
  for (const s of SPOT_TITLES) {
    const need = s.min === Infinity ? t : s.min;
    if (t > 0 && n >= need) {
      current = { ...s, min: need };
    }
  }
  return current;
}

/**
 * 加载 5A 数据集（内存缓存）
 * @returns {Promise<Array>} 景区数组
 */
export async function loadSpots() {
  if (cache) return cache;
  const res = await fetch(SPOTS_URL);
  if (!res.ok) throw new Error('5A 数据加载失败: ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('5A 数据格式异常');
  cache = data;
  return cache;
}

/** 5A 总数（数据驱动，未加载时返回 0） */
export function getSpotTotal() {
  return cache ? cache.length : 0;
}

/**
 * 按省 adcode 查询
 * @param {string|number} provinceAdcode
 */
export function getSpotsByProvince(provinceAdcode) {
  if (!cache) return [];
  const code = String(provinceAdcode || '').trim();
  if (!code) return [];
  return cache.filter((s) => String(s.p) === code);
}

/**
 * 按市/区 adcode 查询（用于"你点亮了某市"卡片）
 * @param {string|number} cityAdcode
 */
export function getSpotsByCity(cityAdcode) {
  if (!cache) return [];
  const code = String(cityAdcode || '').trim();
  if (!code) return [];
  return cache.filter((s) => String(s.c) === code);
}

/** 打卡 key：5a:{id} */
export function spotKey(id) {
  return `5a:${id}`;
}
