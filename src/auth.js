/**
 * 点亮中国 · v2 用户认证模块
 *
 * 两种身份：
 * - 注册用户：用户名 + 4 位密码，云端 KV，全设备同步
 * - 游客：一键登录，只存浏览器 localStorage，不上云
 *
 * 会话保存在 localStorage，下次打开自动登录。
 */

const SESSION_KEY = 'footprint.session.v2';
const GUEST_FP_KEY = 'footprint.guest.fp.v2';

// 复用 sync.js 的 apiRequest
let apiRequestFn = null;
export function setApiRequest(fn) {
  apiRequestFn = fn;
}

async function api(path, body) {
  if (!apiRequestFn) throw new Error('apiRequest 未初始化');
  return apiRequestFn(path, { method: 'POST', body: JSON.stringify(body) });
}

/* ---------- 会话管理 ---------- */

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, loginedAt: Date.now() }));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

/* ---------- 注册 / 登录 / 改密码 ---------- */

export async function register(username, password, nickname) {
  const res = await api('/api/auth/register', { username, password, nickname });
  return res && res.user ? res.user : null;
}

export async function login(username, password) {
  const res = await api('/api/auth/login', { username, password });
  return res && res.user ? res.user : null;
}

export async function changePassword(username, oldPassword, newPassword) {
  const res = await api('/api/auth/change-password', { username, oldPassword, newPassword });
  return !!(res && res.ok);
}

export async function claimLegacy(nickname, password, legacyUserId) {
  const res = await api('/api/auth/claim-legacy', { nickname, password, legacyUserId });
  return res && res.user ? res.user : null;
}

/* ---------- 游客 ---------- */

export function guestLogin(nickname) {
  const guestId = `guest_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const session = {
    type: 'guest',
    guestId,
    nickname: nickname || `游客_${guestId.slice(-4).toUpperCase()}`,
  };
  saveSession(session);
  return session;
}

export function getGuestFootprint(guestId) {
  try {
    const raw = localStorage.getItem(`${GUEST_FP_KEY}.${guestId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveGuestFootprint(guestId, footprint) {
  localStorage.setItem(`${GUEST_FP_KEY}.${guestId}`, JSON.stringify(footprint));
}

export function isGuest(session) {
  return session && session.type === 'guest';
}

export function isUser(session) {
  return session && session.type === 'user';
}
