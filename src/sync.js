/**
 * 点亮中国 · 同步层（封装 Worker API 客户端与离线容灾）
 * 2 秒防抖自动 PUT 同步、打开/加入拉取全家数据、无网络静默降级
 */
import { SYNC_DEBOUNCE_MS, SYNC_API_BASE } from './config.js?v=20261005z';

let syncTimer = null;
let syncStatus = 'idle'; // 'idle' | 'syncing' | 'saved' | 'offline'
const statusListeners = new Set();

// v2：游客模式标志（游客不上云，只存本地）
let guestMode = false;
let guestSaveFn = null;

export function setGuestMode(enabled, saveFn) {
  guestMode = enabled;
  guestSaveFn = saveFn;
}

export function isGuestMode() {
  return guestMode;
}

function setStatus(s) {
  if (syncStatus === s) return;
  syncStatus = s;
  for (const fn of statusListeners) {
    try { fn(syncStatus); } catch {}
  }
}

export function subscribeSyncStatus(fn) {
  statusListeners.add(fn);
  fn(syncStatus);
  return () => statusListeners.delete(fn);
}

export function getSyncStatus() {
  return syncStatus;
}

/**
 * 通用 Fetch 包装，带 6 秒超时与静默容灾
 */
export async function apiRequest(path, options = {}) {
  const url = (SYNC_API_BASE || '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`Sync API [${options.method || 'GET'} ${path}] returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    // 静默降级，不抛出异常打扰用户
    console.warn(`Sync API [${options.method || 'GET'} ${path}] offline/failed:`, err.message || err);
    return null;
  }
}

/* ========== REST API 封装 ========== */

/**
 * 创建新房间（v5）
 * @param {string} name 房间名
 * @param {string} ownerUserId 房主用户 ID
 * @param {string} password 可选的加入密码
 * @returns {Promise<{code: string}|null>}
 */
export async function createRoom(name, ownerUserId, password = '') {
  setStatus('syncing');
  const res = await apiRequest('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, ownerUserId, password }),
  });
  if (res && res.code) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 列出所有房间（v5 新增，供加入时浏览）
 * @returns {Promise<Array<{code, name, memberCount, hasPassword}>|null>}
 */
export async function listRooms() {
  const res = await apiRequest('/api/rooms');
  if (res && Array.isArray(res.rooms)) {
    return res.rooms;
  }
  return null;
}

/**
 * 根据密码查询房间码（v5 新增）
 * @param {string} password 房间密码（4 位数字）
 * @returns {Promise<{code: string}|null>}
 */
export async function getRoomByPassword(password) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/by-password/${encodeURIComponent(password)}`);
  if (res && res.code) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 重设房间密码（v5 新增，仅房主）
 * @param {string} code 房间码
 * @param {string} password 新密码（4 位数字，空字符串清除）
 * @returns {Promise<boolean>}
 */
export async function updateRoomPassword(code, password) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}`, {
    method: 'PATCH',
    body: JSON.stringify({ password }),
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/**
 * 加入现有房间（v5）
 * @param {string} code 6 位房间码
 * @param {string} userId 用户 ID
 * @returns {Promise<{ok: boolean, members: Array}|null>}
 */
export async function joinRoom(code, userId) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  if (res && res.ok) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 获取房间全家足迹数据（v5 新形状）
 * @param {string} code 6 位房间码
 * @returns {Promise<{code, name, ownerUserId, members: Array}|null>}
 */
export async function fetchRoom(code) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}`);
  if (res && Array.isArray(res.members)) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 推送当前用户足迹数据（v5）
 * @param {string} userId 用户 ID
 * @param {Object} userData { nickname?, color?, footprint?, roomCodes? }
 * @returns {Promise<boolean>}
 */
export async function putUser(userId, userData, fetchOpts = {}) {
  setStatus('syncing');
  const res = await apiRequest(`/api/users/${userId}`, {
    ...fetchOpts,
    method: 'PUT',
    body: JSON.stringify(userData),
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/** @deprecated 旧名别名，用 putUser() */
export const putMember = putUser;

/**
 * 从云端房间移除成员（v5：语义改为移出房间，不删用户）
 * @param {string} code 6 位房间码
 * @param {string} userId 用户 ID
 * @returns {Promise<boolean>}
 */
export async function deleteMember(code, userId) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/members/${userId}`, {
    method: 'DELETE',
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/**
 * 认领身份（v5 新增）
 * @param {string} code 房间码
 * @param {string} fromUserId 被认领的用户 ID
 * @param {string} toUserId 认领者的用户 ID
 * @returns {Promise<boolean>}
 */
export async function claimIdentity(code, fromUserId, toUserId) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/claim`, {
    method: 'POST',
    body: JSON.stringify({ fromUserId, toUserId }),
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/**
 * 退出房间（v5 新增）
 * @param {string} code 房间码
 * @param {string} userId 用户 ID
 * @returns {Promise<boolean>}
 */
export async function leaveRoom(code, userId) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/leave`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/* ========== 防抖自动同步引擎（v5） ========== */

/*
 * 「有没有未同步的改动」按内容判断：记下最近一次成功上传（或刚从云端拉下）的
 * 载荷指纹，当前载荷指纹不同即为脏。
 *
 * 旧实现用 footprint.updatedAt 判断，但 store 的点亮操作只改了包装对象上的
 * updatedAt、从没更新 footprint.updatedAt，导致「每次刷新后只有第一处改动会上传」。
 * 退出/切换前必须准确知道还有没有没传上去的改动，所以改为内容指纹。
 */
let lastSyncedKey = null;   // 最近一次确认与云端一致的载荷指纹（含 userId）
let syncPaused = false;     // 暂停：退出/切换进行中，或云端档案未加载成功时禁止上传

function isUploadableUser(user) {
  // anon_ 为退出后的空白占位身份（store.resetLocal），永远不上传
  return Boolean(user && user.userId && !String(user.userId).startsWith('anon_'));
}

function buildPayload(store) {
  const user = store.getActiveUser();
  if (!user) return null;
  return {
    userId: user.userId,
    body: {
      nickname: user.nickname,
      color: user.color,
      footprint: store.getActiveFootprint(),
      roomCodes: store.getRooms().map((r) => r.code),
    },
  };
}

function payloadKey(p) {
  return p ? JSON.stringify([p.userId, p.body]) : '';
}

/**
 * 标记「当前本地状态 = 云端」：刚用云端档案覆盖本地后调用，
 * 避免刚登录就把原样数据再 PUT 一遍。云端拉取失败时不要调用（让本地改动有机会上传）。
 */
export function markSynced(store) {
  lastSyncedKey = payloadKey(buildPayload(store));
}

/** 暂停/恢复自动同步（暂停期间不上传、不写游客足迹） */
export function pauseSync(paused = true) {
  syncPaused = Boolean(paused);
  if (syncPaused) clearTimeout(syncTimer);
}

export function isSyncPaused() {
  return syncPaused;
}

/** 当前账号是否还有没保存到其归宿（云端 / 游客本机存储）的改动 */
export function hasUnsyncedChanges(store) {
  const p = buildPayload(store);
  if (!p) return false;
  if (!guestMode && !isUploadableUser(store.getActiveUser())) return false;
  return payloadKey(p) !== lastSyncedKey;
}

function saveGuestNow(store) {
  if (!guestSaveFn) return false;
  try {
    const p = buildPayload(store);
    guestSaveFn(p.body.footprint);
    lastSyncedKey = payloadKey(p);
    setStatus('saved');
    return true;
  } catch {
    setStatus('offline');
    return false;
  }
}

async function pushNow(store, fetchOpts) {
  const p = buildPayload(store);
  if (!p || !isUploadableUser(store.getActiveUser())) return false;
  const key = payloadKey(p);
  const ok = await putUser(p.userId, p.body, fetchOpts);
  if (ok) lastSyncedKey = key;
  return ok;
}

/**
 * 立即把当前账号未保存的改动落到归宿（退出 / 切换账号前调用）。
 * - 游客：同步写本机足迹
 * - 注册用户：立刻 PUT（apiRequest 自带 6 秒超时，不会无限卡住）
 * @returns {Promise<boolean>} true = 没有会丢的改动（原本就同步了或刚同步成功）
 */
export async function flushSync(store) {
  clearTimeout(syncTimer);
  if (!hasUnsyncedChanges(store)) return true;
  if (guestMode) return saveGuestNow(store);
  if (syncPaused) return false; // 云端档案未加载成功时不敢覆盖云端，如实报告「未同步」
  return pushNow(store);
}

/**
 * 调度防抖自动同步（2 秒内无新变更后触发 PUT）
 * v5：同步的是用户本人的全局足迹（PUT /api/users/:userId），不再绑定房间
 * @param {Object} store Store 实例
 */
export function scheduleAutoSync(store) {
  if (syncPaused) return;
  const user = store.getActiveUser();
  if (!user) return;

  // 内容没变（如只切换了主题/音效）就不发请求
  if (!hasUnsyncedChanges(store)) return;

  clearTimeout(syncTimer);

  // v2：游客模式只存本地，不上云
  if (guestMode) {
    syncTimer = setTimeout(() => {
      if (!syncPaused) saveGuestNow(store);
    }, 500);
    return;
  }

  setStatus('syncing');

  syncTimer = setTimeout(async () => {
    if (syncPaused) return;
    const userNow = store.getActiveUser();
    if (!userNow || store.getActiveUserId() !== user.userId) return;
    await pushNow(store);
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 初始化同步层：v5 不再自动拉取合并房间成员（房间成员为只读视图）
 * 仅订阅 Store 变更以触发自动同步
 * @param {Object} store Store 实例
 */
export function initSync(store) {
  // v5：房间成员视图由大厅/房间页面按需拉取，不再全局自动合并
  // 监听本地 Store 变化，若足迹变更则防抖同步
  store.subscribe(() => {
    scheduleAutoSync(store);
  });

  // 页面被切到后台 / 关闭时，不等 2 秒防抖，立刻把未同步改动发出去
  // （孩子点亮后马上关掉标签页是常见场景）。keepalive 让请求在页面卸载后仍能送达。
  const flushOnHide = () => {
    if (syncPaused || !hasUnsyncedChanges(store)) return;
    clearTimeout(syncTimer);
    if (guestMode) saveGuestNow(store);
    else pushNow(store, { keepalive: true });
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnHide();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushOnHide);
  }
}
