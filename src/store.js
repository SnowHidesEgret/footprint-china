/**
 * 点亮中国 · 状态管理（单向 Store）
 * 状态 → 持久化 → 通知订阅者重渲染，保持单一数据源
 */
import { TOTAL_PROVINCES } from './config.js?v=20260930d';
import { storage } from './geo.js?v=20260930d';
import { KNOWN_ACHIEVEMENTS } from './achievements.js?v=20260930d';

const VALID_THEMES = ['dark', 'light'];

class Store {
  constructor() {
    const raw = storage.read() || {};
    // theme 枚举校验，非法值回退默认
    const theme = VALID_THEMES.includes(raw.theme) ? raw.theme : 'dark';

    // provinces 防御性校验，过滤脏数据并限制 34 个上限
    const rawProvinces = (raw.provinces && typeof raw.provinces === 'object' && !Array.isArray(raw.provinces))
      ? raw.provinces
      : {};
    const provinces = {};
    let count = 0;
    for (const [code, val] of Object.entries(rawProvinces)) {
      if (count >= TOTAL_PROVINCES) break;
      if (val && typeof val === 'object' && val.name) {
        provinces[String(code)] = {
          name: String(val.name),
          litAt: typeof val.litAt === 'number' ? val.litAt : Date.now(),
        };
        count++;
      }
    }

    // cities 防御性校验：只接受 6 位数字 adcode -> true，引用了无城市数据省份的脏条目直接丢弃
    const rawCities = (raw.cities && typeof raw.cities === 'object' && !Array.isArray(raw.cities))
      ? raw.cities
      : {};
    const cities = {};
    for (const [code, val] of Object.entries(rawCities)) {
      const c = typeof code === 'string' ? code.trim() : '';
      if (val === true && /^\d{6}$/.test(c)) {
        cities[c] = true;
      }
    }

    // unlockedAchievements 防御性校验：只接受已知 12 个 id，去重
    const rawUnlocked = Array.isArray(raw.unlockedAchievements)
      ? raw.unlockedAchievements
      : [];
    const unlockedAchievements = [];
    const seenAch = new Set();
    for (const item of rawUnlocked) {
      const id = typeof item === 'string' ? item.trim() : '';
      if (KNOWN_ACHIEVEMENTS.includes(id) && !seenAch.has(id)) {
        seenAch.add(id);
        unlockedAchievements.push(id);
      }
    }

    // maxTitleLevel 防御性校验：只接受 0~8 的整数
    const rawMaxTitle = raw.maxTitleLevel;
    const maxTitleLevel =
      Number.isInteger(rawMaxTitle) && rawMaxTitle >= 0 && rawMaxTitle <= 8
        ? rawMaxTitle
        : 0;

    this.state = {
      version: 1,
      theme,
      provinces,
      cities,
      soundEnabled: Boolean(raw.soundEnabled ?? true),
      unlockedAchievements,
      maxTitleLevel,
    };
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _commit() {
    storage.write(this.state);
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (e) { console.error(e); }
    }
  }

  isLit(adcode) {
    return Boolean(this.state.provinces[String(adcode)]);
  }

  litCount() {
    return Math.min(Object.keys(this.state.provinces).length, TOTAL_PROVINCES);
  }

  light(adcode, name) {
    adcode = String(adcode);
    if (this.isLit(adcode)) return false;
    // 34 上限防御，防脏数据与越界
    if (this.litCount() >= TOTAL_PROVINCES) return false;
    this.state.provinces[adcode] = { name, litAt: Date.now() };
    this._commit();
    return true;
  }

  unlight(adcode) {
    adcode = String(adcode);
    if (!this.isLit(adcode)) return false;
    delete this.state.provinces[adcode];
    this._commit();
    return true;
  }

  isCityLit(adcode) {
    if (adcode === undefined || adcode === null) return false;
    const code = String(adcode).trim();
    if (!code) return false;
    return Boolean(this.state.cities[code]);
  }

  lightCity(adcode) {
    if (typeof adcode !== 'string' && typeof adcode !== 'number') return false;
    const code = String(adcode).trim();
    if (!code) return false;
    if (this.state.cities[code] === true) return false;
    this.state.cities[code] = true;
    this._commit();
    return true;
  }

  unlightCity(adcode) {
    if (typeof adcode !== 'string' && typeof adcode !== 'number') return false;
    const code = String(adcode).trim();
    if (!code || !this.state.cities[code]) return false;
    delete this.state.cities[code];
    this._commit();
    return true;
  }

  cityLitCount(provinceAdcode) {
    if (!provinceAdcode) {
      return Object.keys(this.state.cities).length;
    }
    const prefix = String(provinceAdcode).trim().slice(0, 2);
    if (!prefix) return 0;
    let count = 0;
    for (const code of Object.keys(this.state.cities)) {
      if (code.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  setTheme(theme) {
    if (!VALID_THEMES.includes(theme)) return;
    if (this.state.theme === theme) return;
    this.state.theme = theme;
    this._commit();
  }

  toggleTheme() {
    this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark');
  }

  setSoundEnabled(v) {
    if (typeof v !== 'boolean') return;
    if (this.state.soundEnabled === v) return;
    this.state.soundEnabled = v;
    this._commit();
  }

  isAchievementUnlocked(id) {
    if (typeof id !== 'string') return false;
    return this.state.unlockedAchievements.includes(id.trim());
  }

  unlockAchievement(id) {
    if (typeof id !== 'string') return false;
    const cleanId = id.trim();
    if (!KNOWN_ACHIEVEMENTS.includes(cleanId)) return false;
    if (this.state.unlockedAchievements.includes(cleanId)) return false;
    this.state.unlockedAchievements.push(cleanId);
    this._commit();
    return true;
  }

  getMaxTitleLevel() {
    return this.state.maxTitleLevel || 0;
  }

  bumpMaxTitleLevel(level) {
    const lv = Number.isInteger(level) ? level : 0;
    if (lv > (this.state.maxTitleLevel || 0)) {
      this.state.maxTitleLevel = Math.min(lv, 8);
      this._commit();
      return true;
    }
    return false;
  }
}

export const store = new Store();
