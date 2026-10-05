/**
 * 点亮中国 · 状态管理（单向 Store，支持 Phase 3 多用户与云同步）
 * 本地多成员隔离 + 老数据平滑迁移 + 离线缓存
 */
import { TOTAL_PROVINCES, MAX_MEMBERS, MEMBER_COLORS } from './config.js?v=20261005c';
import { storage } from './geo.js?v=20261005c';
import { KNOWN_ACHIEVEMENTS } from './achievements.js?v=20261005c';
import { spotKey } from './spots.js?v=20261005c';

const VALID_THEMES = ['dark', 'light'];

function sanitizeProvinces(rawProvinces) {
  const provinces = {};
  if (!rawProvinces || typeof rawProvinces !== 'object' || Array.isArray(rawProvinces)) {
    return provinces;
  }
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
  return provinces;
}

function sanitizeCities(rawCities) {
  const cities = {};
  if (!rawCities || typeof rawCities !== 'object' || Array.isArray(rawCities)) {
    return cities;
  }
  for (const [code, val] of Object.entries(rawCities)) {
    const c = typeof code === 'string' ? code.trim() : '';
    if (val === true && /^\d{6}$/.test(c)) {
      cities[c] = true;
    }
  }
  return cities;
}

function sanitizeAchievements(rawUnlocked) {
  const unlocked = [];
  if (!Array.isArray(rawUnlocked)) return unlocked;
  const seen = new Set();
  for (const item of rawUnlocked) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (KNOWN_ACHIEVEMENTS.includes(id) && !seen.has(id)) {
      seen.add(id);
      unlocked.push(id);
    }
  }
  return unlocked;
}

function sanitizeMaxTitle(rawMax) {
  return Number.isInteger(rawMax) && rawMax >= 0 && rawMax <= 8 ? rawMax : 0;
}

/** 清洗 5A 打卡记录：{ '5a:1': timestamp } */
function sanitizeSpots(rawSpots) {
  const spots = {};
  if (!rawSpots || typeof rawSpots !== 'object' || Array.isArray(rawSpots)) {
    return spots;
  }
  for (const [key, val] of Object.entries(rawSpots)) {
    const k = typeof key === 'string' ? key.trim() : '';
    if (/^5a:\d+$/.test(k) && typeof val === 'number' && val > 0) {
      spots[k] = val;
    }
  }
  return spots;
}

class Store {
  constructor() {
    const raw = storage.read() || {};
    const theme = VALID_THEMES.includes(raw.theme) ? raw.theme : 'dark';
    const soundEnabled = Boolean(raw.soundEnabled ?? true);
    const roomCode = typeof raw.roomCode === 'string' && /^\d{6}$/.test(raw.roomCode) ? raw.roomCode : null;

    let members = [];
    let currentMemberId = '';

    // 检测是否为旧版单用户数据或无成员数据 → 首次升级迁移
    if (!raw.members || !Array.isArray(raw.members) || raw.members.length === 0) {
      const initialMemberId = 'm_' + Date.now().toString(36);
      const migratedMember = {
        id: initialMemberId,
        name: '我',
        color: MEMBER_COLORS[0].value,
        updatedAt: Date.now(),
        footprint: {
          provinces: sanitizeProvinces(raw.provinces),
          cities: sanitizeCities(raw.cities),
          unlockedAchievements: sanitizeAchievements(raw.unlockedAchievements),
          maxTitleLevel: sanitizeMaxTitle(raw.maxTitleLevel),
          spots: sanitizeSpots(raw.spots),
        },
      };
      members = [migratedMember];
      currentMemberId = initialMemberId;
    } else {
      // 多成员数据校验与清洗
      for (let i = 0; i < Math.min(raw.members.length, MAX_MEMBERS); i++) {
        const rm = raw.members[i];
        if (!rm || typeof rm !== 'object') continue;
        const id = typeof rm.id === 'string' && rm.id ? rm.id : 'm_' + (i + 1);
        const name = typeof rm.name === 'string' && rm.name.trim() ? rm.name.trim().slice(0, 16) : `成员${i + 1}`;
        const color = typeof rm.color === 'string' && rm.color ? rm.color : MEMBER_COLORS[i % MEMBER_COLORS.length].value;
        const updatedAt = typeof rm.updatedAt === 'number' ? rm.updatedAt : Date.now();
        const fp = rm.footprint || {};

        members.push({
          id,
          name,
          color,
          updatedAt,
          footprint: {
            provinces: sanitizeProvinces(fp.provinces),
            cities: sanitizeCities(fp.cities),
            unlockedAchievements: sanitizeAchievements(fp.unlockedAchievements),
            maxTitleLevel: sanitizeMaxTitle(fp.maxTitleLevel),
            spots: sanitizeSpots(fp.spots),
          },
        });
      }

      if (members.length === 0) {
        const id = 'm_' + Date.now().toString(36);
        members = [{
          id,
          name: '我',
          color: MEMBER_COLORS[0].value,
          updatedAt: Date.now(),
          footprint: { provinces: {}, cities: {}, unlockedAchievements: [], maxTitleLevel: 0, spots: {} },
        }];
      }

      const rawCurr = typeof raw.currentMemberId === 'string' ? raw.currentMemberId : '';
      currentMemberId = members.some((m) => m.id === rawCurr) ? rawCurr : members[0].id;
    }

    this.state = {
      version: 3,
      theme,
      soundEnabled,
      roomCode,
      currentMemberId,
      members,
      pkMode: false,
      // 为保持单用户旧代码（如 main.js）平滑兼容，在 state 上映射当前活跃成员数据
      provinces: {},
      cities: {},
      unlockedAchievements: [],
      maxTitleLevel: 0,
      spots: {},
    };

    this.listeners = new Set();
    this._syncActiveMember();
    // 首次迁移后持久化
    if (!raw.members || raw.version !== 3) {
      this._commit();
    }
  }

  _syncActiveMember() {
    const member = this.getCurrentMember();
    if (member && member.footprint) {
      this.state.provinces = member.footprint.provinces;
      this.state.cities = member.footprint.cities;
      this.state.unlockedAchievements = member.footprint.unlockedAchievements;
      this.state.maxTitleLevel = member.footprint.maxTitleLevel;
      this.state.spots = member.footprint.spots || {};
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _commit(skipNotify = false) {
    this._syncActiveMember();
    // 写入 localStorage
    const snapshot = {
      version: 3,
      theme: this.state.theme,
      soundEnabled: this.state.soundEnabled,
      roomCode: this.state.roomCode,
      currentMemberId: this.state.currentMemberId,
      members: this.state.members,
    };
    storage.write(snapshot);

    if (!skipNotify) {
      for (const fn of this.listeners) {
        try { fn(this.state); } catch (e) { console.error(e); }
      }
    }
  }

  /* ========== 成员档案管理 ========== */

  getMembers() {
    return this.state.members;
  }

  getCurrentMember() {
    return this.state.members.find((m) => m.id === this.state.currentMemberId) || this.state.members[0];
  }

  getCurrentMemberId() {
    return this.state.currentMemberId;
  }

  setCurrentMember(id) {
    if (!this.state.members.some((m) => m.id === id)) return false;
    if (this.state.currentMemberId === id) return true;
    this.state.currentMemberId = id;
    this._commit();
    return true;
  }

  addMember(name, color = '') {
    if (this.state.members.length >= MAX_MEMBERS) return null;
    const cleanName = (name || '').trim().slice(0, 16) || `成员${this.state.members.length + 1}`;

    let assignedColor = color;
    if (!assignedColor) {
      const usedColors = new Set(this.state.members.map((m) => m.color));
      const available = MEMBER_COLORS.find((c) => !usedColors.has(c.value));
      assignedColor = available ? available.value : MEMBER_COLORS[this.state.members.length % MEMBER_COLORS.length].value;
    }

    const newMember = {
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: cleanName,
      color: assignedColor,
      updatedAt: Date.now(),
      footprint: {
        provinces: {},
        cities: {},
        unlockedAchievements: [],
        maxTitleLevel: 0,
        spots: {},
      },
    };

    this.state.members.push(newMember);
    this.state.currentMemberId = newMember.id;
    this._commit();
    return newMember;
  }

  removeMember(id) {
    if (this.state.members.length <= 1) return false; // 至少保留 1 位成员
    const index = this.state.members.findIndex((m) => m.id === id);
    if (index === -1) return false;

    this.state.members.splice(index, 1);
    if (this.state.currentMemberId === id) {
      this.state.currentMemberId = this.state.members[0].id;
    }
    this._commit();
    return true;
  }

  updateMember(id, fields = {}) {
    const member = this.state.members.find((m) => m.id === id);
    if (!member) return false;
    let changed = false;

    if (typeof fields.name === 'string' && fields.name.trim()) {
      member.name = fields.name.trim().slice(0, 16);
      changed = true;
    }
    if (typeof fields.color === 'string' && fields.color) {
      member.color = fields.color;
      changed = true;
    }
    if (changed) {
      member.updatedAt = Date.now();
      this._commit();
    }
    return true;
  }

  /* ========== 房间管理与远程合并 ========== */

  getRoomCode() {
    return this.state.roomCode;
  }

  setRoomCode(code) {
    this.state.roomCode = code && /^\d{6}$/.test(code) ? code : null;
    this._commit();
  }

  mergeRemoteMembers(remoteMembers) {
    if (!Array.isArray(remoteMembers) || remoteMembers.length === 0) return;

    let localChanged = false;
    const localMap = new Map(this.state.members.map((m) => [m.id, m]));

    for (const rm of remoteMembers) {
      if (!rm || !rm.id) continue;
      const local = localMap.get(rm.id);

      if (!local) {
        if (this.state.members.length < MAX_MEMBERS) {
          const newM = {
            id: rm.id,
            name: rm.name || '家人',
            color: rm.color || MEMBER_COLORS[this.state.members.length % MEMBER_COLORS.length].value,
            updatedAt: rm.updatedAt || Date.now(),
            footprint: {
              provinces: sanitizeProvinces(rm.footprint?.provinces),
              cities: sanitizeCities(rm.footprint?.cities),
              unlockedAchievements: sanitizeAchievements(rm.footprint?.unlockedAchievements),
              maxTitleLevel: sanitizeMaxTitle(rm.footprint?.maxTitleLevel),
              spots: sanitizeSpots(rm.footprint?.spots),
            },
          };
          this.state.members.push(newM);
          localChanged = true;
        }
      } else {
        // 若云端更新时间比本地更新，合并覆盖本地
        const remoteTime = rm.updatedAt || 0;
        const localTime = local.updatedAt || 0;
        if (remoteTime > localTime) {
          local.name = rm.name || local.name;
          local.color = rm.color || local.color;
          local.updatedAt = remoteTime;
          local.footprint = {
            provinces: sanitizeProvinces(rm.footprint?.provinces),
            cities: sanitizeCities(rm.footprint?.cities),
            unlockedAchievements: sanitizeAchievements(rm.footprint?.unlockedAchievements),
            maxTitleLevel: sanitizeMaxTitle(rm.footprint?.maxTitleLevel),
            spots: sanitizeSpots(rm.footprint?.spots),
          };
          localChanged = true;
        }
      }
    }

    if (localChanged) {
      this._commit();
    }
  }

  /* ========== PK 透视统计 ========== */

  isPkMode() {
    return Boolean(this.state.pkMode);
  }

  setPkMode(enabled) {
    if (this.state.pkMode === Boolean(enabled)) return;
    this.state.pkMode = Boolean(enabled);
    this._commit();
  }

  togglePkMode() {
    this.setPkMode(!this.state.pkMode);
  }

  getPkStats() {
    const members = this.state.members;
    const provinceMap = {}; // adcode -> { litMembers: [{ id, name, color }], isFamily: boolean }

    // 统计每人点亮数和独占省份
    const memberStats = members.map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      litCount: Object.keys(m.footprint?.provinces || {}).length,
      soloProvinces: [],
    }));

    const memberStatMap = new Map(memberStats.map((s) => [s.id, s]));
    const allLitProvinceCodes = new Set();
    const familyProvinces = [];

    // 遍历所有成员点亮的省份
    for (const m of members) {
      const provs = m.footprint?.provinces || {};
      for (const [code, val] of Object.entries(provs)) {
        allLitProvinceCodes.add(code);
        if (!provinceMap[code]) {
          provinceMap[code] = {
            name: val.name,
            litMembers: [],
            isFamily: false,
          };
        }
        provinceMap[code].litMembers.push({
          id: m.id,
          name: m.name,
          color: m.color,
        });
      }
    }

    // 分析独占与合家欢（共同足迹）
    for (const [code, p] of Object.entries(provinceMap)) {
      if (p.litMembers.length >= 2) {
        p.isFamily = true;
        familyProvinces.push({ adcode: code, name: p.name, members: p.litMembers });
      } else if (p.litMembers.length === 1) {
        const ownerId = p.litMembers[0].id;
        const stat = memberStatMap.get(ownerId);
        if (stat) {
          stat.soloProvinces.push({ adcode: code, name: p.name });
        }
      }
    }

    return {
      members: memberStats,
      provinceMap,
      familyProvinces,
      totalFamilyCount: familyProvinces.length,
      totalLitCount: allLitProvinceCodes.size,
    };
  }

  /* ========== 现有操作代理到当前成员 ========== */

  isLit(adcode) {
    const member = this.getCurrentMember();
    return Boolean(member.footprint.provinces[String(adcode)]);
  }

  litCount() {
    const member = this.getCurrentMember();
    return Math.min(Object.keys(member.footprint.provinces).length, TOTAL_PROVINCES);
  }

  light(adcode, name) {
    adcode = String(adcode);
    const member = this.getCurrentMember();
    if (this.isLit(adcode)) return false;
    if (this.litCount() >= TOTAL_PROVINCES) return false;

    member.footprint.provinces[adcode] = { name, litAt: Date.now() };
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  unlight(adcode) {
    adcode = String(adcode);
    const member = this.getCurrentMember();
    if (!this.isLit(adcode)) return false;

    delete member.footprint.provinces[adcode];
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  isCityLit(adcode) {
    if (adcode === undefined || adcode === null) return false;
    const code = String(adcode).trim();
    if (!code) return false;
    const member = this.getCurrentMember();
    return Boolean(member.footprint.cities[code]);
  }

  lightCity(adcode) {
    if (typeof adcode !== 'string' && typeof adcode !== 'number') return false;
    const code = String(adcode).trim();
    if (!code) return false;
    const member = this.getCurrentMember();
    if (member.footprint.cities[code] === true) return false;

    member.footprint.cities[code] = true;
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  unlightCity(adcode) {
    if (typeof adcode !== 'string' && typeof adcode !== 'number') return false;
    const code = String(adcode).trim();
    const member = this.getCurrentMember();
    if (!code || !member.footprint.cities[code]) return false;

    delete member.footprint.cities[code];
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  cityLitCount(provinceAdcode) {
    const member = this.getCurrentMember();
    const cities = member.footprint.cities;
    if (!provinceAdcode) {
      return Object.keys(cities).length;
    }
    const prefix = String(provinceAdcode).trim().slice(0, 2);
    if (!prefix) return 0;
    let count = 0;
    for (const code of Object.keys(cities)) {
      if (code.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  /* ========== 5A 景区打卡（独立于省市点亮） ========== */

  /** 是否已打卡某 5A（spotId 为数字 id） */
  isSpotVisited(spotId) {
    const member = this.getCurrentMember();
    const spots = member.footprint.spots || {};
    return Boolean(spots[spotKey(spotId)]);
  }

  /** 打卡 5A（绝不联动省市点亮） */
  visitSpot(spotId) {
    const member = this.getCurrentMember();
    if (!member.footprint.spots) member.footprint.spots = {};
    const key = spotKey(spotId);
    if (member.footprint.spots[key]) return false;
    member.footprint.spots[key] = Date.now();
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  /** 取消 5A 打卡 */
  unvisitSpot(spotId) {
    const member = this.getCurrentMember();
    const spots = member.footprint.spots || {};
    const key = spotKey(spotId);
    if (!spots[key]) return false;
    delete spots[key];
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  /** 当前成员 5A 打卡总数 */
  spotVisitCount() {
    const member = this.getCurrentMember();
    const spots = member.footprint.spots || {};
    return Object.keys(spots).length;
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
    const member = this.getCurrentMember();
    return member.footprint.unlockedAchievements.includes(id.trim());
  }

  unlockAchievement(id) {
    if (typeof id !== 'string') return false;
    const cleanId = id.trim();
    if (!KNOWN_ACHIEVEMENTS.includes(cleanId)) return false;
    const member = this.getCurrentMember();
    if (member.footprint.unlockedAchievements.includes(cleanId)) return false;

    member.footprint.unlockedAchievements.push(cleanId);
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  getMaxTitleLevel() {
    const member = this.getCurrentMember();
    return member.footprint.maxTitleLevel || 0;
  }

  bumpMaxTitleLevel(level) {
    const lv = Number.isInteger(level) ? level : 0;
    const member = this.getCurrentMember();
    if (lv > (member.footprint.maxTitleLevel || 0)) {
      member.footprint.maxTitleLevel = Math.min(lv, 8);
      member.updatedAt = Date.now();
      this._commit();
      return true;
    }
    return false;
  }
}

export const store = new Store();
