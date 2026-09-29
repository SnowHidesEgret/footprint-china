/**
 * 点亮中国 · 地理数据层
 * 加载本地 GeoJSON，拆分为 34 个省级行政区 + 南海诸岛要素
 */
import { STORE_KEY } from './config.js';

const GEO_URL = 'maps/china.json';
const ISLANDS_ADCODE = '100000_JD';

let cache = null;

export async function loadGeo() {
  if (cache) return cache;
  const res = await fetch(GEO_URL);
  if (!res.ok) throw new Error('地图数据加载失败: ' + res.status);
  const fc = await res.json();

  const provinces = [];
  let islands = null;
  for (const f of fc.features) {
    const adcode = String(f.properties.adcode || '');
    if (adcode === ISLANDS_ADCODE || !f.properties.name) {
      islands = f; // 南海诸岛（插图用）
    } else {
      provinces.push(f);
    }
  }
  // 按 adcode 排序，保证渲染顺序稳定
  provinces.sort((a, b) => String(a.properties.adcode).localeCompare(String(b.properties.adcode)));

  cache = { provinces, islands };
  return cache;
}

/** localStorage 读写（带容错） */
export const storage = {
  read() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.provinces) return null;
      return data;
    } catch {
      return null;
    }
  },
  write(data) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },
};
