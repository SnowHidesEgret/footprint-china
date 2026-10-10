/**
 * 点亮中国 · 状态管理（单向 Store，支持 Phase 3 多用户与云同步）
 * v5: 用户身份解耦（users + footprints），房间列表化（rooms），支持大厅与认领
 * 本地多用户隔离 + 老数据平滑迁移 + 离线缓存
 */
import { TOTAL_PROVINCES, MAX_MEMBERS, MEMBER_COLORS } from './config.js?v=20261005i';
import { storage } from './geo.js?v=20261005i';
import { KNOWN_ACHIEVEMENTS } from './achievements.js?v=20261005i';
import { spotKey } from './spots.js?v=20261005i';

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

/** 清洗城市记忆：{ adcode: { text, updatedAt } } */
function sanitizeMemos(rawMemos) {
  const memos = {};
  if (!rawMemos || typeof rawMemos !== 'object' || Array.isArray(rawMemos)) {
    return memos;
  }
  for (const [key, val] of Object.entries(rawMemos)) {
    const k = typeof key === 'string' ? key.trim() : '';
    if (!/^\d{4,6}$/.test(k)) continue;
    if (!val || typeof val !== 'object') continue;
    const text = typeof val.text === 'string' ? val.text.trim().slice(0, 200) : '';
    if (!text) continue;
    const updatedAt = typeof val.updatedAt === 'number' && val.updatedAt > 0 ? val.updatedAt : Date.now();
    memos[k] = { text, updatedAt };
  }
  return memos;
}

class Store {
  constructor() {
    const raw = storage.read() || {};
    const theme = VALID_THEMES.includes(raw.theme) ? raw.theme : 'dark';
    const soundEnabled = Boolean(raw.soundEnabled ?? true);

    let users = [];
    let footprints = {};
    let activeUserId = '';
    let rooms = [];
    let activeRoomCode = null;

    // v5 迁移：从 v4（members 内嵌 footprint、单个 roomCode）升级
    if (raw.version === 5 && Array.isArray(raw.users)) {
      // v5 数据校验与清洗
      for (const ru of raw.users) {
        if (!ru || typeof ru !== 'object') continue;
        const userId = typeof ru.userId === 'string' && ru.userId ? ru.userId : '';
        if (!userId) continue;
        const nickname = typeof ru.nickname === 'string' && ru.nickname.trim()
          ? ru.nickname.trim().slice(0, 16) : '我';
        const color = typeof ru.color === 'string' && ru.color ? ru.color : MEMBER_COLORS[users.length % MEMBER_COLORS.length].value;
        users.push({
          userId,
          nickname,
          color,
          createdAt: typeof ru.createdAt === 'number' ? ru.createdAt : Date.now(),
          updatedAt: typeof ru.updatedAt === 'number' ? ru.updatedAt : Date.now(),
        });
      }
      const rawFp = raw.footprints || {};
      for (const u of users) {
        const fp = rawFp[u.userId] || {};
        footprints[u.userId] = {
          provinces: sanitizeProvinces(fp.provinces),
          cities: sanitizeCities(fp.cities),
          unlockedAchievements: sanitizeAchievements(fp.unlockedAchievements),
          maxTitleLevel: sanitizeMaxTitle(fp.maxTitleLevel),
          spots: sanitizeSpots(fp.spots),
          memos: sanitizeMemos(fp.memos),
          updatedAt: typeof fp.updatedAt === 'number' ? fp.updatedAt : Date.now(),
        };
      }
      if (Array.isArray(raw.rooms)) {
        for (const rr of raw.rooms) {
          if (!rr || typeof rr !== 'object') continue;
          const code = typeof rr.code === 'string' && /^\d{6}$/.test(rr.code) ? rr.code : '';
          if (!code) continue;
          rooms.push({
            code,
            name: typeof rr.name === 'string' && rr.name.trim() ? rr.name.trim().slice(0, 20) : '家庭房间',
            role: rr.role === 'owner' ? 'owner' : 'member',
            joinedAt: typeof rr.joinedAt === 'number' ? rr.joinedAt : Date.now(),
            lastOpenedAt: typeof rr.lastOpenedAt === 'number' ? rr.lastOpenedAt : Date.now(),
          });
        }
      }
      const rawActive = typeof raw.activeUserId === 'string' ? raw.activeUserId : '';
      activeUserId = users.some((u) => u.userId === rawActive) ? rawActive : (users[0]?.userId || '');
      const rawRoom = typeof raw.activeRoomCode === 'string' && /^\d{6}$/.test(raw.activeRoomCode) ? raw.activeRoomCode : null;
      activeRoomCode = rooms.some((r) => r.code === rawRoom) ? rawRoom : null;
    } else {
      // 从 v4 或更早版本迁移
      const v4members = Array.isArray(raw.members) ? raw.members : [];
      if (v4members.length === 0) {
        // 全新用户：创建一个默认身份
        const userId = 'u_' + Date.now().toString(36);
        users = [{ userId, nickname: '我', color: MEMBER_COLORS[0].value, createdAt: Date.now(), updatedAt: Date.now() }];
        footprints[userId] = { provinces: {}, cities: {}, unlockedAchievements: [], maxTitleLevel: 0, spots: {}, memos: {}, updatedAt: Date.now() };
        activeUserId = userId;
      } else {
        // v4 members → v5 users + footprints（id 原样作为 userId，无需映射表）
        for (let i = 0; i < Math.min(v4members.length, MAX_MEMBERS); i++) {
          const rm = v4members[i];
          if (!rm || typeof rm !== 'object') continue;
          const userId = typeof rm.id === 'string' && rm.id ? rm.id : 'u_' + (i + 1);
          const nickname = typeof rm.name === 'string' && rm.name.trim() ? rm.name.trim().slice(0, 16) : `成员${i + 1}`;
          const color = typeof rm.color === 'string' && rm.color ? rm.color : MEMBER_COLORS[i % MEMBER_COLORS.length].value;
          const updatedAt = typeof rm.updatedAt === 'number' ? rm.updatedAt : Date.now();
          const fp = rm.footprint || {};
          users.push({ userId, nickname, color, createdAt: updatedAt, updatedAt });
          footprints[userId] = {
            provinces: sanitizeProvinces(fp.provinces),
            cities: sanitizeCities(fp.cities),
            unlockedAchievements: sanitizeAchievements(fp.unlockedAchievements),
            maxTitleLevel: sanitizeMaxTitle(fp.maxTitleLevel),
            spots: sanitizeSpots(fp.spots),
            memos: sanitizeMemos(fp.memos),
            updatedAt,
          };
        }
        if (users.length === 0) {
          const userId = 'u_' + Date.now().toString(36);
          users = [{ userId, nickname: '我', color: MEMBER_COLORS[0].value, createdAt: Date.now(), updatedAt: Date.now() }];
          footprints[userId] = { provinces: {}, cities: {}, unlockedAchievements: [], maxTitleLevel: 0, spots: {}, memos: {}, updatedAt: Date.now() };
        }
        const rawCurr = typeof raw.currentMemberId === 'string' ? raw.currentMemberId : '';
        activeUserId = users.some((u) => u.userId === rawCurr) ? rawCurr : users[0].userId;
      }
      // v4 roomCode → v5 rooms[]（单个房间，名称稍后从服务端补）
      const v4room = typeof raw.roomCode === 'string' && /^\d{6}$/.test(raw.roomCode) ? raw.roomCode : null;
      if (v4room) {
        rooms = [{ code: v4room, name: '家庭房间', role: 'member', joinedAt: Date.now(), lastOpenedAt: Date.now() }];
        activeRoomCode = v4room;
      }
    }

    this.state = {
      version: 5,
      theme,
      soundEnabled,
      users,
      footprints,
      activeUserId,
      rooms,
      activeRoomCode,
      pkMode: false,
      // 兼容层：在 state 上映射当前活跃用户足迹（供 main.js 旧代码平滑过渡）
      provinces: {},
      cities: {},
      unlockedAchievements: [],
      maxTitleLevel: 0,
      spots: {},
      memos: {},
    };

    this.listeners = new Set();
    this._syncActiveUser();
    // 迁移后持久化
    if (raw.version !== 5) {
      this._commit();
    }
  }

  _syncActiveUser() {
    const fp = this.getActiveFootprint();
    if (fp) {
      this.state.provinces = fp.provinces;
      this.state.cities = fp.cities;
      this.state.unlockedAchievements = fp.unlockedAchievements;
      this.state.maxTitleLevel = fp.maxTitleLevel;
      this.state.spots = fp.spots || {};
      this.state.memos = fp.memos || {};
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _commit(skipNotify = false) {
    this._syncActiveUser();
    // 写入 localStorage（v5 结构）
    const snapshot = {
      version: 5,
      theme: this.state.theme,
      soundEnabled: this.state.soundEnabled,
      users: this.state.users,
      activeUserId: this.state.activeUserId,
      footprints: this.state.footprints,
      rooms: this.state.rooms,
      activeRoomCode: this.state.activeRoomCode,
    };
    storage.write(snapshot);

    if (!skipNotify) {
      for (const fn of this.listeners) {
        try { fn(this.state); } catch (e) { console.error(e); }
      }
    }
  }

  /* ========== 用户身份管理（v5） ========== */

  getUsers() {
    return this.state.users;
  }

  getActiveUser() {
    return this.state.users.find((u) => u.userId === this.state.activeUserId) || this.state.users[0];
  }

  getActiveUserId() {
    return this.state.activeUserId;
  }

  getActiveFootprint() {
    return this.state.footprints[this.state.activeUserId] || null;
  }

  setActiveUser(userId) {
    if (!this.state.users.some((u) => u.userId === userId)) return false;
    if (this.state.activeUserId === userId) return true;
    this.state.activeUserId = userId;
    this._commit();
    return true;
  }

  addUser(nickname, color = '') {
    if (this.state.users.length >= MAX_MEMBERS) return null;
    const cleanName = (nickname || '').trim().slice(0, 16) || `成员${this.state.users.length + 1}`;

    let assignedColor = color;
    if (!assignedColor) {
      const usedColors = new Set(this.state.users.map((u) => u.color));
      const available = MEMBER_COLORS.find((c) => !usedColors.has(c.value));
      assignedColor = available ? available.value : MEMBER_COLORS[this.state.users.length % MEMBER_COLORS.length].value;
    }

    const userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = Date.now();
    this.state.users.push({ userId, nickname: cleanName, color: assignedColor, createdAt: now, updatedAt: now });
    this.state.footprints[userId] = {
      provinces: {}, cities: {}, unlockedAchievements: [], maxTitleLevel: 0,
      spots: {}, memos: {}, updatedAt: now,
    };
    this.state.activeUserId = userId;
    this._commit();
    return this.getActiveUser();
  }

  removeUser(userId) {
    if (this.state.users.length <= 1) return false;
    const index = this.state.users.findIndex((u) => u.userId === userId);
    if (index === -1) return false;
    this.state.users.splice(index, 1);
    delete this.state.footprints[userId];
    if (this.state.activeUserId === userId) {
      this.state.activeUserId = this.state.users[0].userId;
    }
    this._commit();
    return true;
  }

  updateUser(userId, fields = {}) {
    const user = this.state.users.find((u) => u.userId === userId);
    if (!user) return false;
    let changed = false;
    if (typeof fields.nickname === 'string' && fields.nickname.trim()) {
      user.nickname = fields.nickname.trim().slice(0, 16);
      changed = true;
    }
    if (typeof fields.color === 'string' && fields.color) {
      user.color = fields.color;
      changed = true;
    }
    if (changed) {
      user.updatedAt = Date.now();
      this._commit();
    }
    return true;
  }

  /* ========== 房间管理（v5） ========== */

  getRooms() {
    return [...this.state.rooms].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  getActiveRoomCode() {
    return this.state.activeRoomCode;
  }

  getActiveRoom() {
    return this.state.rooms.find((r) => r.code === this.state.activeRoomCode) || null;
  }

  addRoom(code, name = '家庭房间', role = 'member') {
    const c = String(code);
    if (!/^\d{6}$/.test(c)) return false;
    const existing = this.state.rooms.find((r) => r.code === c);
    const now = Date.now();
    if (existing) {
      existing.lastOpenedAt = now;
      if (name && name.trim()) existing.name = name.trim().slice(0, 20);
    } else {
      this.state.rooms.push({
        code: c,
        name: (name || '').trim().slice(0, 20) || '家庭房间',
        role: role === 'owner' ? 'owner' : 'member',
        joinedAt: now,
        lastOpenedAt: now,
      });
    }
    this.state.activeRoomCode = c;
    this._commit();
    return true;
  }

  removeRoom(code) {
    const index = this.state.rooms.findIndex((r) => r.code === code);
    if (index === -1) return false;
    this.state.rooms.splice(index, 1);
    if (this.state.activeRoomCode === code) {
      this.state.activeRoomCode = null;
    }
    this._commit();
    return true;
  }

  setActiveRoom(code) {
    if (code !== null && !this.state.rooms.some((r) => r.code === code)) return false;
    this.state.activeRoomCode = code;
    if (code) {
      const room = this.state.rooms.find((r) => r.code === code);
      if (room) room.lastOpenedAt = Date.now();
    }
    this._commit();
    return true;
  }

  updateRoomName(code, name) {
    const room = this.state.rooms.find((r) => r.code === code);
    if (!room || !name || !name.trim()) return false;
    room.name = name.trim().slice(0, 20);
    this._commit();
    return true;
  }

  /* ========== 兼容层（供 main.js 旧代码过渡） ========== */

  /** @deprecated 用 getUsers() */
  getMembers() {
    return this.state.users.map((u) => ({
      id: u.userId, name: u.nickname, color: u.color, updatedAt: u.updatedAt,
      footprint: this.state.footprints[u.userId] || {},
    }));
  }

  /** @deprecated 用 getActiveUser() */
  getCurrentMember() {
    const u = this.getActiveUser();
    if (!u) return null;
    return {
      id: u.userId, name: u.nickname, color: u.color, updatedAt: u.updatedAt,
      footprint: this.state.footprints[u.userId] || {},
    };
  }

  /** @deprecated 用 getActiveUserId() */
  getCurrentMemberId() {
    return this.state.activeUserId;
  }

  /** @deprecated 用 setActiveUser() */
  setCurrentMember(id) {
    return this.setActiveUser(id);
  }

  /** @deprecated 用 addUser() */
  addMember(name, color = '') {
    const u = this.addUser(name, color);
    return u ? this.getCurrentMember() : null;
  }

  /** @deprecated 用 removeUser() */
  removeMember(id) {
    return this.removeUser(id);
  }

  /** @deprecated 用 updateUser() */
  updateMember(id, fields = {}) {
    const mapped = {};
    if (fields.name !== undefined) mapped.nickname = fields.name;
    if (fields.color !== undefined) mapped.color = fields.color;
    return this.updateUser(id, mapped);
  }

  /** @deprecated 用 getActiveRoomCode() */
  getRoomCode() {
    return this.state.activeRoomCode;
  }

  /** @deprecated 用 addRoom() / setActiveRoom() */
  setRoomCode(code) {
    if (!code) {
      this.state.activeRoomCode = null;
      this._commit();
      return;
    }
    this.addRoom(code, '家庭房间', 'member');
  }

  /**
   * @deprecated v5 不再合并远程成员到本地。"我的档案"与"房间成员"彻底分离。
   * 房间成员改为只读视图，由 sync.js 直接管理。此方法保留为空操作以防旧代码调用。
   */
  mergeRemoteMembers(remoteMembers) {
    return;
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
    const members = this.getMembers(); // v5 兼容层：本地用户（房间成员视图由 sync.js 单独管理）
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

  /** 取城市记忆 */
  getMemo(adcode) {
    const member = this.getCurrentMember();
    const memos = member.footprint.memos || {};
    const m = memos[String(adcode)];
    return m && m.text ? m.text : '';
  }

  /** 写城市记忆（空文本则删除） */
  setMemo(adcode, text) {
    const member = this.getCurrentMember();
    if (!member.footprint.memos) member.footprint.memos = {};
    const key = String(adcode);
    const t = (text || '').trim().slice(0, 200);
    if (!t) {
      delete member.footprint.memos[key];
    } else {
      member.footprint.memos[key] = { text: t, updatedAt: Date.now() };
    }
    member.updatedAt = Date.now();
    this._commit();
    return true;
  }

  /** 是否有城市记忆 */
  hasMemo(adcode) {
    return Boolean(this.getMemo(adcode));
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
