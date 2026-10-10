/**
 * 点亮中国 · 诗词数据层
 * 加载 maps/poetry.json，提供按 adcode 查询诗句（城市优先精确匹配，查不到回落到省级）
 */

const POETRY_URL = 'maps/poetry.json';

let cache = null;
let byAdcode = new Map();

/** 加载诗句表（带缓存） */
export async function loadPoetry() {
  if (cache) return cache;
  const res = await fetch(POETRY_URL);
  if (!res.ok) throw new Error(`poetry.json 加载失败: ${res.status}`);
  cache = await res.json();
  byAdcode = new Map();
  for (const p of cache) {
    byAdcode.set(String(p.adcode), p);
  }
  return cache;
}

/**
 * 按 adcode 取诗句
 * @param {string} adcode 6 位城市码或省级码
 * @returns {Object|null} { adcode, name, line, from, author } 或 null
 */
export function getPoetry(adcode) {
  const code = String(adcode);
  // 1. 精确匹配（城市 6 位 / 省级）
  if (byAdcode.has(code)) return byAdcode.get(code);
  // 2. 城市码回落到省级：前 2 位 + 0000
  if (code.length === 6) {
    const provCode = code.slice(0, 2) + '0000';
    if (byAdcode.has(provCode)) return byAdcode.get(provCode);
  }
  return null;
}
