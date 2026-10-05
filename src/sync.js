/**
 * 点亮中国 · 同步层（封装 Worker API 客户端与离线容灾）
 * 2 秒防抖自动 PUT 同步、打开/加入拉取全家数据、无网络静默降级
 */
import { SYNC_DEBOUNCE_MS, SYNC_API_BASE } from './config.js?v=20261005c';

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
 * 创建新房间
 * @param {string} name 初始成员名字
 * @returns {Promise<{code: string, memberId: string}|null>}
 */
export async function createRoom(name) {
  setStatus('syncing');
  const res = await apiRequest('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (res && res.code && res.memberId) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 加入现有房间
 * @param {string} code 6 位房间码
 * @param {string} name 成员名字
 * @returns {Promise<{memberId: string, members: Array}|null>}
 */
export async function joinRoom(code, name) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (res && res.memberId) {
    setStatus('saved');
    return res;
  }
  setStatus('offline');
  return null;
}

/**
 * 获取房间全家足迹数据
 * @param {string} code 6 位房间码
 * @returns {Promise<{members: Array}|null>}
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
 * 推送当前成员足迹数据
 * @param {string} code 6 位房间码
 * @param {string} memberId 成员 ID
 * @param {Object} memberData { name, color, footprint }
 * @returns {Promise<boolean>}
 */
export async function putMember(code, memberId, memberData) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/members/${memberId}`, {
    method: 'PUT',
    body: JSON.stringify(memberData),
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/**
 * 从云端房间移除成员
 * @param {string} code 6 位房间码
 * @param {string} memberId 成员 ID
 * @returns {Promise<boolean>}
 */
export async function deleteMember(code, memberId) {
  setStatus('syncing');
  const res = await apiRequest(`/api/rooms/${code}/members/${memberId}`, {
    method: 'DELETE',
  });
  if (res && res.ok) {
    setStatus('saved');
    return true;
  }
  setStatus('offline');
  return false;
}

/* ========== 防抖自动同步引擎 ========== */

let lastSyncedTimestamp = 0;

/**
 * 调度防抖自动同步（2 秒内无新变更后触发 PUT）
 * @param {Object} store Store 实例
 */
export function scheduleAutoSync(store) {
  const code = store.getRoomCode();
  const currentMember = store.getCurrentMember();
  if (!code || !currentMember) return;

  // 如果该成员暂无最新改动，跳过
  if (currentMember.updatedAt && currentMember.updatedAt <= lastSyncedTimestamp) {
    return;
  }

  clearTimeout(syncTimer);
  setStatus('syncing');

  syncTimer = setTimeout(async () => {
    const memberNow = store.getCurrentMember();
    if (!memberNow || store.getRoomCode() !== code) return;

    const ok = await putMember(code, memberNow.id, {
      name: memberNow.name,
      color: memberNow.color,
      footprint: memberNow.footprint,
    });

    if (ok) {
      lastSyncedTimestamp = memberNow.updatedAt || Date.now();
      setStatus('saved');
    } else {
      setStatus('offline');
    }
  }, SYNC_DEBOUNCE_MS);
}

/**
 * 初始化同步层：启动拉取并在 Store 订阅中绑定自动同步
 * @param {Object} store Store 实例
 */
export function initSync(store) {
  const roomCode = store.getRoomCode();

  // 若本地已加入房间，打开页面时静默 GET 拉取全家数据
  if (roomCode) {
    fetchRoom(roomCode).then((res) => {
      if (res && Array.isArray(res.members)) {
        store.mergeRemoteMembers(res.members);
      }
    }).catch(() => {
      // 离线静默处理
      setStatus('offline');
    });
  }

  // 监听本地 Store 变化，若足迹变更则防抖同步
  store.subscribe(() => {
    scheduleAutoSync(store);
  });
}
