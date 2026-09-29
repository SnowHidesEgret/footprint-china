/**
 * 点亮中国 · 状态管理（单向 Store）
 * 状态 → 持久化 → 通知订阅者重渲染，保持单一数据源
 */
import { STORE_KEY } from './config.js';
import { storage } from './geo.js';

function defaultState() {
  return {
    version: 1,
    theme: 'dark',
    provinces: {},          // adcode -> { name, litAt }
    soundEnabled: true,     // Phase 2 音效预留字段
  };
}

class Store {
  constructor() {
    this.state = Object.assign(defaultState(), storage.read() || {});
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
    return Object.keys(this.state.provinces).length;
  }

  light(adcode, name) {
    adcode = String(adcode);
    if (this.isLit(adcode)) return false;
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

  setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    if (this.state.theme === theme) return;
    this.state.theme = theme;
    this._commit();
  }

  toggleTheme() {
    this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark');
  }
}

export const store = new Store();
