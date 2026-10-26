/**
 * 点亮中国 · v2 用户认证模块
 *
 * 两种身份：
 * - 注册用户：用户名 + 4 位密码，云端 KV，全设备同步
 * - 游客：一键登录，只存浏览器 localStorage，不上云
 *
 * 会话保存在 localStorage，下次打开自动登录。
 *
 * ⚠️ 诚实说明：会话只是 localStorage 里的一条 { type, username, nickname } 记录，
 * 没有服务端 token、没有过期机制。它表示「这台设备上当前是谁在用」，不是安全凭证。
 * 因此本模块绝不在本地保存密码 / PIN / 哈希，「曾登录账号」列表也只存用户名与昵称。
 */

const SESSION_KEY = 'footprint.session.v2';
const GUEST_FP_KEY = 'footprint.guest.fp.v2';
// 本机「曾登录账号」列表（多用户切换用）。只存 type + 用户名/游客ID + 昵称 + 最近使用时间
const ACCOUNTS_KEY = 'footprint.accounts.v2';
// 注册账号最多记住几个（一家人足够；超出时淘汰最久未用的注册账号——其数据在云端，淘汰不丢数据）
const MAX_REMEMBERED_USERS = 8;

// 认证专用请求：直接 fetch，保留服务端错误信息（sync.js 的 apiRequest 失败时只回 null）
import { SYNC_API_BASE } from './config.js?v=20261005z';

async function api(path, body) {
  let res;
  try {
    res = await fetch(`${SYNC_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('网络不通，请检查网络后重试');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data;
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

/**
 * 只挑白名单字段写入会话，防止调用方误把服务端返回的整个 user 对象
 * （可能含 passwordHash 等）原样塞进 localStorage
 */
function pickSessionFields(session) {
  if (!session || typeof session !== 'object') return null;
  if (session.type === 'user' && session.username) {
    return {
      type: 'user',
      username: String(session.username),
      nickname: String(session.nickname || session.username),
    };
  }
  if (session.type === 'guest' && session.guestId) {
    return {
      type: 'guest',
      guestId: String(session.guestId),
      nickname: String(session.nickname || '游客'),
    };
  }
  return null;
}

export function saveSession(session) {
  const clean = pickSessionFields(session);
  if (!clean) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...clean, loginedAt: Date.now() }));
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

/** 生成一个全新的游客会话对象（不落盘，由调用方决定何时保存） */
export function createGuestSession(nickname) {
  const guestId = `guest_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    type: 'guest',
    guestId,
    nickname: nickname || `游客_${guestId.slice(-4).toUpperCase()}`,
  };
}

/** 兼容旧调用：生成并立即保存游客会话 */
export function guestLogin(nickname) {
  const session = createGuestSession(nickname);
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

export function removeGuestFootprint(guestId) {
  localStorage.removeItem(`${GUEST_FP_KEY}.${guestId}`);
}

/** 游客足迹里有没有任何数据（省/市/5A/记忆任一非空） */
export function guestHasData(guestId) {
  const fp = getGuestFootprint(guestId);
  if (!fp || typeof fp !== 'object') return false;
  return ['provinces', 'cities', 'spots', 'memos'].some(
    (k) => fp[k] && typeof fp[k] === 'object' && Object.keys(fp[k]).length > 0
  );
}

export function isGuest(session) {
  return session && session.type === 'guest';
}

export function isUser(session) {
  return session && session.type === 'user';
}

/* ---------- 本机「曾登录账号」列表（多用户切换） ----------
 *
 * 设计：
 * - 存在 localStorage `footprint.accounts.v2`，每项只有：
 *     注册账号 { type:'user',  username, nickname, lastUsedAt }
 *     游客档案 { type:'guest', guestId,  nickname, lastUsedAt }
 *   读写都过 sanitizeAccount 白名单，严禁出现密码 / PIN / 哈希 / 足迹等任何其他字段。
 * - 只记「谁在这台设备上用过」，用于登录页 / 大厅里一键选人；
 *   选中注册账号后仍要输入 4 位密码（理由见 account.js 顶部注释）。
 * - 游客档案的足迹只在本机（GUEST_FP_KEY.<guestId>），把它记进列表才能在
 *   「游客 ↔ 注册账号」来回切换后找回；没有任何足迹的游客档案不值得记，读列表时自动隐藏。
 */

export function accountKey(entry) {
  if (!entry) return '';
  if (entry.type === 'user') return `user:${entry.username}`;
  if (entry.type === 'guest') return `guest:${entry.guestId}`;
  return '';
}

function sanitizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lastUsedAt = typeof raw.lastUsedAt === 'number' && raw.lastUsedAt > 0 ? raw.lastUsedAt : 0;
  if (raw.type === 'user' && typeof raw.username === 'string' && raw.username.trim()) {
    const username = raw.username.trim().slice(0, 32);
    const nickname = typeof raw.nickname === 'string' && raw.nickname.trim()
      ? raw.nickname.trim().slice(0, 20) : username;
    return { type: 'user', username, nickname, lastUsedAt };
  }
  if (raw.type === 'guest' && typeof raw.guestId === 'string' && /^guest_[a-z0-9]+$/i.test(raw.guestId)) {
    const nickname = typeof raw.nickname === 'string' && raw.nickname.trim()
      ? raw.nickname.trim().slice(0, 20) : '游客';
    return { type: 'guest', guestId: raw.guestId, nickname, lastUsedAt };
  }
  return null;
}

function readAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const list = [];
    for (const item of raw) {
      const a = sanitizeAccount(item);
      const k = accountKey(a);
      if (!a || seen.has(k)) continue;
      seen.add(k);
      list.push(a);
    }
    return list;
  } catch {
    return [];
  }
}

function writeAccounts(list) {
  try {
    const clean = list.map(sanitizeAccount).filter(Boolean);
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(clean));
  } catch { /* 存储满或被禁用时静默：列表只是便利功能 */ }
}

/**
 * 本机曾登录账号，按最近使用排序。
 * 没有足迹的游客档案（点了「游客试玩」又什么都没点亮）自动隐藏，避免列表被空游客塞满；
 * 但当前正在使用的游客永远保留。
 */
export function getKnownAccounts() {
  const cur = getSession();
  const curKey = accountKey(cur);
  return readAccounts()
    .filter((a) => a.type === 'user' || accountKey(a) === curKey || guestHasData(a.guestId))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** 记住（或刷新）一个账号；传入会话对象即可，多余字段会被白名单丢弃 */
export function rememberAccount(sessionLike) {
  const entry = sanitizeAccount({ ...sessionLike, lastUsedAt: Date.now() });
  if (!entry) return;
  const key = accountKey(entry);
  let list = readAccounts().filter((a) => accountKey(a) !== key);
  list.unshift(entry);
  // 只淘汰注册账号（云端有数据）；游客档案的足迹只在本机，绝不自动淘汰
  const users = list.filter((a) => a.type === 'user');
  if (users.length > MAX_REMEMBERED_USERS) {
    const drop = new Set(
      users.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(MAX_REMEMBERED_USERS).map(accountKey)
    );
    list = list.filter((a) => !drop.has(accountKey(a)));
  }
  writeAccounts(list);
}

/**
 * 从本机列表移除。注册账号只是「不再显示」，云端数据不受影响；
 * 游客档案连同本机足迹一并删除（调用方需先向用户确认）。
 */
export function forgetAccount(entry) {
  const key = accountKey(entry);
  if (!key) return;
  writeAccounts(readAccounts().filter((a) => accountKey(a) !== key));
  if (entry.type === 'guest') removeGuestFootprint(entry.guestId);
}
