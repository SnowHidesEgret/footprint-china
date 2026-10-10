/**
 * 点亮中国 · 同步层（封装 Worker API 客户端与离线容灾）
 * 2 秒防抖自动 PUT 同步、打开/加入拉取全家数据、无网络静默降级
 */
import { SYNC_DEBOUNCE_MS, SYNC_API_BASE } from './config.js?v=20261005k';

let syncTimer = null;
let syncStatus = 'idle'; // 'idle' | 'syncing' | 'saved' | 'offline'
const statusListeners = new Set();

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
async function apiRequest(path, options = {}) {
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
 * @returns {Promise<{code: string}|null>}
 */
export async function createRoom(name, ownerUserId) {
  setStatus('syncing');
  const res = await apiRequest('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, ownerUserId }),
  });
  if (res && res.code) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
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
export async function putUser(userId, userData) {
  setStatus('syncing');
  const res = await apiRequest(`/api/users/${userId}`, {
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

let lastSyncedTimestamp = 0;

/**
 * 调度防抖自动同步（2 秒内无新变更后触发 PUT）
 * v5：同步的是用户本人的全局足迹（PUT /api/users/:userId），不再绑定房间
 * @param {Object} store Store 实例
 */
export function scheduleAutoSync(store) {
  const user = store.getActiveUser();
  if (!user) return;

  const fp = store.getActiveFootprint();
  if (fp && fp.updatedAt && fp.updatedAt <= lastSyncedTimestamp) {
    return;
  }

  clearTimeout(syncTimer);
  setStatus('syncing');

  syncTimer = setTimeout(async () => {
    const userNow = store.getActiveUser();
    if (!userNow || store.getActiveUserId() !== user.userId) return;

    const fpNow = store.getActiveFootprint();
    const roomCodes = store.getRooms().map((r) => r.code);
    const ok = await putUser(userNow.userId, {
      nickname: userNow.nickname,
      color: userNow.color,
      footprint: fpNow,
      roomCodes,
    });

    if (ok) {
      lastSyncedTimestamp = fpNow?.updatedAt || Date.now();
    }
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 初始化同步层：v5 不再自动拉取合并房间成员（房间成员为只读视图）
 * 仅订阅 Store 变更以触发自动同步
 * @param {Object} store Store 实例
 */
export function initSync(store) {
  // v5：房间成员视图由大厅/房间页面按需拉取，不再全局自动合并
  // 自动同步通过 store.subscribe 在 main.js 中绑定
}

  // 监听本地 Store 变化，若足迹变更则防抖同步
  store.subscribe(() => {
    scheduleAutoSync(store);
  });
}
