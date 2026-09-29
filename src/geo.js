/**
 * 点亮中国 · 地理数据层
 * 加载本地 GeoJSON，拆分为 34 个省级行政区 + 南海诸岛要素
 */
import { STORE_KEY } from './config.js?v=20260930d';

const GEO_URL = 'maps/china.json';
const ISLANDS_ADCODE = '100000_JD';

let cache = null;

/**
 * 计算平面多边形环的带符号面积（Shoelace formula）
 * 经度为 x，纬度为 y：
 * area > 0: 逆时针 (CCW)
 * area < 0: 顺时针 (CW)
 */
export function ringSignedArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, len = ring.length - 1; i < len; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/**
 * 纠正多边形环的绕向：
 * 外环（clockwise = true）：必须确保为顺时针（signed area < 0），若 > 0 则反转
 * 洞（clockwise = false）：必须确保为逆时针（signed area > 0），若 < 0 则反转
 */
export function rewindRing(ring, clockwise) {
  const area = ringSignedArea(ring);
  if (clockwise) {
    if (area > 0) ring.reverse();
  } else {
    if (area < 0) ring.reverse();
  }
}

/**
 * 对要素几何体进行环绕向校正
 * d3-geo 对向子午线裁剪器使用球面绕向语义：
 * 平面逆时针外环会被判定包裹除该多边形外的全世界，导致生成世界矩形；
 * 顺时针外环（signed area < 0）才能正确表达有限多边形区域。
 */
export function rewindGeometry(geometry) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach((ring, i) => {
      rewindRing(ring, i === 0);
    });
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => {
      polygon.forEach((ring, i) => {
        rewindRing(ring, i === 0);
      });
    });
  }
}

export async function loadGeo() {
  if (cache) return cache;
  const res = await fetch(GEO_URL);
  if (!res.ok) throw new Error('地图数据加载失败: ' + res.status);
  const fc = await res.json();

  const provinces = [];
  let islands = null;
  for (const f of fc.features) {
    if (!f || !f.properties) continue;
    if (f.geometry) {
      rewindGeometry(f.geometry);
    }
    const adcode = String(f.properties.adcode || '').trim();
    const name = String(f.properties.name || '').trim();

    // 明确排除 100000_JD（单独作为插图要素）
    if (adcode === ISLANDS_ADCODE) {
      islands = f;
      continue;
    }

    // 明确排除无名称要素，保证省份列表纯净
    if (!name) {
      continue;
    }

    provinces.push(f);
  }
  // 按 adcode 排序，保证渲染顺序稳定
  provinces.sort((a, b) => String(a.properties.adcode).localeCompare(String(b.properties.adcode)));

  cache = { provinces, islands };
  return cache;
}

const cityCache = new Map();

/**
 * 懒加载省份下属城市/区县 GeoJSON（内存 Map 缓存）
 * @param {string|number} provinceAdcode 省份 adcode
 * @returns {Promise<Array>} 纠正环绕向后的要素数组
 */
export async function loadCityGeo(provinceAdcode) {
  const code = String(provinceAdcode || '').trim();
  if (!code) throw new Error('无效的省份编码');
  if (cityCache.has(code)) {
    return cityCache.get(code);
  }

  // 同源懒加载本地城市 GeoJSON（不再跨域请求 DataV，避开 CORS 与源站可用性问题）
  // 优先 _full.json（地级市要素集合），404 时回退 .json（如台湾省）
  let res = await fetch(`/maps/cities/${code}_full.json`);
  if (!res.ok && res.status === 404) {
    res = await fetch(`/maps/cities/${code}.json`);
  }
  if (!res.ok) {
    throw new Error(`城市数据加载失败: ${res.status}`);
  }

  const fc = await res.json();
  if (!fc || !Array.isArray(fc.features)) {
    throw new Error('城市数据格式异常');
  }

  const cities = [];
  for (const f of fc.features) {
    if (!f || !f.properties) continue;
    if (f.geometry) {
      rewindGeometry(f.geometry);
    }
    const adcode = String(f.properties.adcode || '').trim();
    const name = String(f.properties.name || '').trim();
    if (!name || !adcode) continue;
    cities.push(f);
  }

  cities.sort((a, b) => String(a.properties.adcode).localeCompare(String(b.properties.adcode)));

  cityCache.set(code, cities);
  return cities;
}

/**
 * 检查指定省份城市数据是否已加载到内存中
 * @param {string|number} provinceAdcode
 * @returns {boolean}
 */
export function isCityGeoLoaded(provinceAdcode) {
  const code = String(provinceAdcode || '').trim();
  return cityCache.has(code);
}

/**
 * 获取已加载到内存中的城市要素数组，未加载则返回 null
 * @param {string|number} provinceAdcode
 * @returns {Array|null}
 */
export function getLoadedCityGeo(provinceAdcode) {
  const code = String(provinceAdcode || '').trim();
  return cityCache.get(code) || null;
}

/** localStorage 读写（带完整容错） */
export const storage = {
  read() {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      return data;
    } catch {
      return null;
    }
  },
  write(data) {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },
};
