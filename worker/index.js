/**
 * 点亮中国 · 多用户云同步 Worker（Phase 1：用户与房间系统 + v2 账号）
 * 基于 Cloudflare Workers & D1（SQLite），提供用户档案、家庭房间与足迹同步服务
 *
 * 数据模型（D1，2026-10-20 由 KV 迁移）：
 * - users 表：user_id 主键，含 username/password_hash/nickname/color/footprint(JSON)
 * - rooms 表：code 主键，含 name/password/owner_user_id
 * - room_members 表：(room_code, user_id) 关系表；user.roomCodes 与 room.memberUserIds 均为其派生视图
 *
 * 设计原则：房间成员实时读用户档案，一处真相，从结构上消灭"名单与数据不一致"。
 */

const PRODUCTION_ORIGIN = 'https://map.snowyegret.top';

/**
 * 跨域白名单：正式站 + 本项目 Pages 预览域名 + 本地开发。
 * 预览域名形如 https://<分支>.footprint-china.pages.dev（Cloudflare Pages 分支预览），
 * 没有它，预览站上的登录/同步请求会被浏览器 CORS 拦截（表现为“网络不通”）。
 * 注意 CORS 不是安全边界（curl 可绕过），真正的鉴权靠各接口自身的校验；这里只放行自家域名。
 */
function resolveAllowedOrigin(origin) {
  if (!origin) return PRODUCTION_ORIGIN;
  if (origin === PRODUCTION_ORIGIN) return origin;
  if (/^https:\/\/[a-z0-9-]+\.footprint-china\.pages\.dev$/.test(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return PRODUCTION_ORIGIN;
}
const DEFAULT_COLORS = ['#C9A25E', '#7FB3A3', '#C4574E', '#5B7FA6', '#9B7FB3', '#D08A4E', '#7BA05B', '#C47F9B'];
const MAX_MEMBERS = 8;

// v2 用户系统：密码哈希（SHA-256 + 用户名作盐）
async function hashPassword(username, password) {
  const data = new TextEncoder().encode(`footprint:${username}:${password}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isValidUsername(username) {
  // 2-12 字符，中文/字母/数字/下划线
  return /^[\u4e00-\u9fa5a-zA-Z0-9_]{2,12}$/.test(username);
}

function isValidPin(password) {
  return /^\d{4}$/.test(password);
}

function corsHeaders(origin = PRODUCTION_ORIGIN) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status = 200, origin = PRODUCTION_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 400, origin = PRODUCTION_ORIGIN) {
  return jsonResponse({ error: message }, status, origin);
}

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateUserId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyFootprint() {
  return {
    provinces: {},
    cities: {},
    spots: {},
    memos: {},
    unlockedAchievements: [],
    maxTitleLevel: 0,
  };
}

/* ---------- D1 读写 helper ---------- */

function rowToUser(row, roomCodes) {
  if (!row) return null;
  let footprint;
  try {
    footprint = JSON.parse(row.footprint || '{}');
  } catch {
    footprint = emptyFootprint();
  }
  if (!footprint || typeof footprint !== 'object' || !footprint.provinces) {
    footprint = { ...emptyFootprint(), ...footprint };
  }
  const user = {
    userId: row.user_id,
    nickname: row.nickname || '',
    color: row.color || DEFAULT_COLORS[0],
    footprint,
    roomCodes: roomCodes || [],
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
    mergedInto: row.merged_into || null,
  };
  if (row.username) user.username = row.username;
  if (row.password_hash) user.passwordHash = row.password_hash;
  if (row.v2) user.v2 = true;
  if (row.claimed_from) user.claimedFrom = row.claimed_from;
  return user;
}

async function getUserRoomCodes(env, userId) {
  const res = await env.DB.prepare(
    'SELECT room_code FROM room_members WHERE user_id = ?'
  ).bind(userId).all();
  return (res.results || []).map((r) => r.room_code);
}

/** 读取用户档案，不存在返回 null */
async function getUser(env, userId) {
  if (!userId) return null;
  try {
    const row = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
    if (!row) return null;
    const roomCodes = await getUserRoomCodes(env, userId);
    return rowToUser(row, roomCodes);
  } catch {
    return null;
  }
}

async function putUser(env, user) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, username, password_hash, nickname, color, footprint, created_at, updated_at, merged_into, v2, claimed_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       password_hash = excluded.password_hash,
       nickname = excluded.nickname,
       color = excluded.color,
       footprint = excluded.footprint,
       updated_at = excluded.updated_at,
       merged_into = excluded.merged_into,
       v2 = excluded.v2,
       claimed_from = excluded.claimed_from`
  ).bind(
    user.userId,
    user.username || null,
    user.passwordHash || null,
    user.nickname || '',
    user.color || DEFAULT_COLORS[0],
    JSON.stringify(user.footprint || emptyFootprint()),
    user.createdAt || Date.now(),
    user.updatedAt || Date.now(),
    user.mergedInto || null,
    user.v2 ? 1 : 0,
    user.claimedFrom || null
  ).run();

  // 成员关系以 user.roomCodes 为准做对账（增删 room_members 行）
  if (Array.isArray(user.roomCodes)) {
    const current = await getUserRoomCodes(env, user.userId);
    const target = new Set(user.roomCodes.filter((c) => /^\d{6}$/.test(c)));
    for (const code of current) {
      if (!target.has(code)) {
        await env.DB.prepare(
          'DELETE FROM room_members WHERE room_code = ? AND user_id = ?'
        ).bind(code, user.userId).run();
      }
    }
    for (const code of target) {
      if (!current.includes(code)) {
        const roomRow = await env.DB.prepare('SELECT code FROM rooms WHERE code = ?').bind(code).first();
        if (roomRow) {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO room_members (room_code, user_id, joined_at) VALUES (?, ?, ?)'
          ).bind(code, user.userId, Date.now()).run();
        }
      }
    }
  }
}

/** 读取房间（含成员名单），不存在返回 null */
async function getRoom(env, code) {
  try {
    const row = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
    if (!row) return null;
    const mres = await env.DB.prepare(
      'SELECT user_id, joined_at FROM room_members WHERE room_code = ? ORDER BY joined_at ASC'
    ).bind(code).all();
    const room = {
      code: row.code,
      name: row.name || '家庭房间',
      ownerUserId: row.owner_user_id || null,
      createdAt: row.created_at || 0,
      memberUserIds: (mres.results || []).map((r) => ({ userId: r.user_id, joinedAt: r.joined_at || 0 })),
    };
    if (row.password) room.password = row.password;
    return room;
  } catch {
    return null;
  }
}

async function putRoom(env, room) {
  await env.DB.prepare(
    `INSERT INTO rooms (code, name, password, owner_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name,
       password = excluded.password,
       owner_user_id = excluded.owner_user_id`
  ).bind(
    room.code,
    room.name || '家庭房间',
    room.password || null,
    room.ownerUserId || null,
    room.createdAt || Date.now()
  ).run();

  // 成员名单以 room.memberUserIds 为准做对账
  const entries = getMemberEntries(room);
  const cres = await env.DB.prepare(
    'SELECT user_id FROM room_members WHERE room_code = ?'
  ).bind(room.code).all();
  const currentIds = new Set((cres.results || []).map((r) => r.user_id));
  const targetIds = new Set(entries.map((e) => e.userId));
  for (const uid of currentIds) {
    if (!targetIds.has(uid)) {
      await env.DB.prepare(
        'DELETE FROM room_members WHERE room_code = ? AND user_id = ?'
      ).bind(room.code, uid).run();
    }
  }
  for (const e of entries) {
    if (!currentIds.has(e.userId)) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO room_members (room_code, user_id, joined_at) VALUES (?, ?, ?)'
      ).bind(room.code, e.userId, e.joinedAt || Date.now()).run();
    }
  }
}

/** 删除房间及其全部成员关系 */
async function deleteRoom(env, code) {
  await env.DB.prepare('DELETE FROM room_members WHERE room_code = ?').bind(code).run();
  await env.DB.prepare('DELETE FROM rooms WHERE code = ?').bind(code).run();
}

/** 按房间密码查房间码，不存在返回 null */
async function findRoomCodeByPassword(env, password) {
  const row = await env.DB.prepare('SELECT code FROM rooms WHERE password = ?').bind(password).first();
  return row ? row.code : null;
}

/* ---------- 表结构自动初始化（Worker 绑定 D1 自带写权限；API token 无建表权限时兜底） ---------- */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     user_id TEXT PRIMARY KEY,
     username TEXT,
     password_hash TEXT,
     nickname TEXT NOT NULL DEFAULT '',
     color TEXT,
     footprint TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER,
     updated_at INTEGER,
     merged_into TEXT,
     v2 INTEGER NOT NULL DEFAULT 0,
     claimed_from TEXT
   )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)',
  'CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)',
  `CREATE TABLE IF NOT EXISTS rooms (
     code TEXT PRIMARY KEY,
     name TEXT,
     password TEXT,
     owner_user_id TEXT,
     created_at INTEGER
   )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_password ON rooms(password)',
  `CREATE TABLE IF NOT EXISTS room_members (
     room_code TEXT NOT NULL,
     user_id TEXT NOT NULL,
     joined_at INTEGER,
     PRIMARY KEY (room_code, user_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_members_user ON room_members(user_id)',
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  schemaReady = true;
}

/* ---------- 房间成员名单 helper ---------- */

/** 成员列表归一化：兼容旧格式 memberIds（字符串数组） */
function getMemberEntries(room) {
  if (Array.isArray(room.memberUserIds)) {
    return room.memberUserIds.filter((e) => e && e.userId);
  }
  if (Array.isArray(room.memberIds)) {
    return room.memberIds
      .filter((id) => typeof id === 'string')
      .map((userId) => ({ userId, joinedAt: room.createdAt || Date.now() }));
  }
  return [];
}

function setMemberEntries(room, entries) {
  room.memberUserIds = entries;
  delete room.memberIds; // 清理旧字段，避免双写
}

/** 确保用户在房间名单中（幂等），返回是否新增 */
function ensureMember(room, userId, joinedAt) {
  const entries = getMemberEntries(room);
  if (entries.some((e) => e.userId === userId)) return false;
  entries.push({ userId, joinedAt: joinedAt || Date.now() });
  setMemberEntries(room, entries);
  return true;
}

/** 从房间名单移除用户，返回 {removed, wasOwner} */
function removeMember(room, userId) {
  const entries = getMemberEntries(room);
  const filtered = entries.filter((e) => e.userId !== userId);
  const removed = filtered.length !== entries.length;
  const wasOwner = room.ownerUserId === userId;
  setMemberEntries(room, filtered);
  return { removed, wasOwner };
}

/** 房主继任：最早加入者接任；无人则返回 false */
function succeedOwner(room) {
  const entries = getMemberEntries(room);
  if (entries.length === 0) return false;
  entries.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  room.ownerUserId = entries[0].userId;
  return true;
}

/** 读取房间成员完整信息，读不到的 userId 自动跳过（不拖垮整个房间） */
async function getRoomMembers(env, room) {
  const entries = getMemberEntries(room);
  const members = [];
  for (const e of entries) {
    const user = await getUser(env, e.userId);
    if (!user) continue;
    members.push({
      userId: user.userId,
      nickname: user.nickname || '',
      color: user.color || DEFAULT_COLORS[0],
      footprint: user.footprint || emptyFootprint(),
      updatedAt: user.updatedAt || 0,
      joinedAt: e.joinedAt || 0,
    });
  }
  return members;
}

/** 为新成员挑选未使用的颜色 */
function pickColor(usedColors, index) {
  const used = new Set(usedColors);
  const found = DEFAULT_COLORS.find((c) => !used.has(c));
  if (found) return found;
  return DEFAULT_COLORS[index % DEFAULT_COLORS.length];
}

/** 从用户房间列表中移除指定房间码 */
function dropRoomCode(user, code) {
  if (user && Array.isArray(user.roomCodes)) {
    user.roomCodes = user.roomCodes.filter((c) => c !== code);
  }
}

/* ---------- 足迹合并（claim 用） ---------- */
/**
 * 合并规则：
 * - 省：取较早 litAt（首次点亮为准）
 * - 市：布尔并集（重叠取较早）
 * - 5A：取较早时间戳
 * - memos：取 updatedAt 较晚者
 * - 成就：并集
 * - 称号：取大
 */
function mergeFootprints(fromFp, toFp) {
  const from = fromFp || {};
  const to = toFp || {};
  const result = emptyFootprint();

  const mergeEarlier = (fromObj, toObj) => {
    const out = {};
    for (const [k, v] of Object.entries(fromObj || {})) {
      if (typeof v === 'number') out[k] = v;
    }
    for (const [k, v] of Object.entries(toObj || {})) {
      if (typeof v !== 'number') continue;
      out[k] = out[k] !== undefined ? Math.min(out[k], v) : v;
    }
    return out;
  };

  result.provinces = mergeEarlier(from.provinces, to.provinces);
  result.cities = mergeEarlier(from.cities, to.cities);
  result.spots = mergeEarlier(from.spots, to.spots);

  const memos = {};
  for (const [k, v] of Object.entries(from.memos || {})) {
    if (v && typeof v === 'object' && v.text) memos[k] = v;
  }
  for (const [k, v] of Object.entries(to.memos || {})) {
    if (!v || typeof v !== 'object' || !v.text) continue;
    const existing = memos[k];
    memos[k] = !existing || (v.updatedAt || 0) >= (existing.updatedAt || 0) ? v : existing;
  }
  result.memos = memos;

  const achSet = new Set();
  for (const a of from.unlockedAchievements || []) achSet.add(a);
  for (const a of to.unlockedAchievements || []) achSet.add(a);
  result.unlockedAchievements = [...achSet];

  result.maxTitleLevel = Math.max(from.maxTitleLevel || 0, to.maxTitleLevel || 0);

  return result;
}

export default {
  async fetch(request, env, ctx) {
    // 本次请求的放行源（正式站 / Pages 预览 / 本地），其余一律回落正式站
    const reqOrigin = resolveAllowedOrigin(request.headers.get('Origin'));
    // fetch 内所有 JSON 回复统一带本次放行源（避免逐处改 59 个调用点）
    const reply = (data, status = 200) => jsonResponse(data, status, reqOrigin);
    const fail = (message, status = 400) => errorResponse(message, status, reqOrigin);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(reqOrigin),
      });
    }

    // 首次请求时自动建表（IF NOT EXISTS 幂等）
    try {
      await ensureSchema(env);
    } catch (err) {
      console.error('Schema init failed:', err);
      return fail('数据库初始化失败', 500);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    async function readBody() {
      try {
        return await request.json();
      } catch {
        return {};
      }
    }

    try {
      /* ============ 用户 API ============ */

      // PUT /api/users/:userId — upsert 用户档案，服务端盖 updatedAt
      const userPutMatch = pathname.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/);
      if (method === 'PUT' && userPutMatch) {
        const userId = userPutMatch[1];
        const body = await readBody();
        const now = Date.now();
        let user = await getUser(env, userId);
        if (!user) {
          user = {
            userId,
            nickname: '',
            color: DEFAULT_COLORS[0],
            footprint: emptyFootprint(),
            roomCodes: [],
            createdAt: now,
            updatedAt: now,
            mergedInto: null,
          };
        }
        if (typeof body.nickname === 'string') {
          user.nickname = body.nickname.trim().slice(0, 20);
        }
        if (typeof body.color === 'string' && body.color.trim()) {
          user.color = body.color.trim();
        }
        if (body.footprint && typeof body.footprint === 'object') {
          user.footprint = body.footprint;
        }
        if (Array.isArray(body.roomCodes)) {
          user.roomCodes = [...new Set(body.roomCodes.filter((c) => typeof c === 'string' && /^\d{6}$/.test(c)))];
        }
        user.updatedAt = now;
        await putUser(env, user);
        return reply({ ok: true });
      }

      // GET /api/users/:userId — 拉取用户档案
      if (method === 'GET' && userPutMatch) {
        const user = await getUser(env, userPutMatch[1]);
        if (!user) return fail('用户不存在', 404);
        return reply(user);
      }

      /* ============ 房间 API ============ */

      // POST /api/rooms — 建房；新流程 {name, ownerUserId}，旧流程兼容 {name}（name 为成员昵称）
      if (method === 'POST' && pathname === '/api/rooms') {
        const body = await readBody();
        const now = Date.now();

        // 生成唯一的 6 位数字房间码
        let code = '';
        for (let i = 0; i < 5; i++) {
          const tryCode = generateRoomCode();
          const existing = await getRoom(env, tryCode);
          if (!existing) {
            code = tryCode;
            break;
          }
        }
        if (!code) code = generateRoomCode();

        if (body.ownerUserId) {
          // 新流程：name 为房间名
          const ownerUserId = String(body.ownerUserId);
          const roomName = (body.name || '家庭房间').trim().slice(0, 20) || '家庭房间';
          const password = typeof body.password === 'string' ? body.password.trim() : '';
          
          // 密码为 4 位数字，唯一性检查（rooms.password 唯一索引）
          if (password) {
            if (!/^\d{4}$/.test(password)) {
              return fail('密码必须为 4 位数字', 400);
            }
            const existingCode = await findRoomCodeByPassword(env, password);
            if (existingCode) {
              return fail('该密码已被使用，请换一个', 400);
            }
          }

          // 确保 owner 用户存在（没有则创建占位档案）
          let owner = await getUser(env, ownerUserId);
          if (!owner) {
            owner = {
              userId: ownerUserId,
              nickname: '',
              color: DEFAULT_COLORS[0],
              footprint: emptyFootprint(),
              roomCodes: [],
              createdAt: now,
              updatedAt: now,
              mergedInto: null,
            };
          }
          if (!owner.roomCodes.includes(code)) owner.roomCodes.push(code);
          owner.updatedAt = now;
          await putUser(env, owner);

          const room = {
            code,
            name: roomName,
            ownerUserId,
            createdAt: now,
            memberUserIds: [{ userId: ownerUserId, joinedAt: now }],
          };
          if (password) {
            room.password = password;
          }
          await putRoom(env, room);
          return reply({ code }, 201);
        }

        // 旧流程兼容：{name} 为创建者昵称
        const nickname = (body.name || '我').trim().slice(0, 20) || '我';
        const userId = generateUserId('m_');
        await putUser(env, {
          userId,
          nickname,
          color: DEFAULT_COLORS[0],
          footprint: emptyFootprint(),
          roomCodes: [code],
          createdAt: now,
          updatedAt: now,
          mergedInto: null,
        });
        await putRoom(env, {
          code,
          name: '家庭房间',
          ownerUserId: userId,
          createdAt: now,
          memberUserIds: [{ userId, joinedAt: now }],
        });
        return reply({ code, memberId: userId }, 201);
      }

      // ========== v2 用户系统：注册/登录/改密码 ==========

      // POST /api/auth/register — 注册 {username, password, nickname?}
      if (method === 'POST' && pathname === '/api/auth/register') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        const nickname = (body.nickname || username).trim().slice(0, 20) || username;

        if (!isValidUsername(username)) {
          return fail('用户名需为 2-12 个字符（中文/字母/数字/下划线）', 400);
        }
        if (!isValidPin(password)) {
          return fail('密码必须为 4 位数字', 400);
        }
        // 用户名全站唯一（v2 用户名即 userId，users 表主键/唯一索引保证）
        const existing = await getUser(env, username);
        if (existing) {
          return fail('用户名已被注册', 409);
        }
        const now = Date.now();
        const user = {
          userId: username, // v2：用户名即 userId
          username,
          passwordHash: await hashPassword(username, password),
          nickname,
          color: DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)],
          footprint: emptyFootprint(),
          roomCodes: [],
          createdAt: now,
          updatedAt: now,
          mergedInto: null,
          v2: true,
        };
        await putUser(env, user);
        // 返回时去掉密码哈希
        const { passwordHash, ...safe } = user;
        return reply({ user: safe }, 201);
      }

      // POST /api/auth/login — 登录 {username, password}
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        if (!username || !password) {
          return fail('请输入用户名和密码', 400);
        }
        const user = await getUser(env, username);
        if (!user || !user.passwordHash) {
          return fail('用户名或密码错误', 401);
        }
        const hash = await hashPassword(username, password);
        if (hash !== user.passwordHash) {
          return fail('用户名或密码错误', 401);
        }
        const { passwordHash, ...safe } = user;
        return reply({ user: safe });
      }

      // POST /api/auth/change-password — 改密码 {username, oldPassword, newPassword}
      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const oldPassword = (body.oldPassword || '').trim();
        const newPassword = (body.newPassword || '').trim();
        if (!isValidPin(newPassword)) {
          return fail('新密码必须为 4 位数字', 400);
        }
        const user = await getUser(env, username);
        if (!user || !user.passwordHash) {
          return fail('用户不存在', 404);
        }
        const oldHash = await hashPassword(username, oldPassword);
        if (oldHash !== user.passwordHash) {
          return fail('原密码错误', 401);
        }
        user.passwordHash = await hashPassword(username, newPassword);
        user.updatedAt = Date.now();
        await putUser(env, user);
        return reply({ ok: true });
      }

      // GET /api/auth/find-legacy?nickname=xxx — 按昵称查找老用户（用于领回数据）
      if (method === 'GET' && pathname === '/api/auth/find-legacy') {
        const nickname = (url.searchParams.get('nickname') || '').trim();
        if (!nickname) return fail('请输入昵称', 400);
        // D1 直接按昵称查未迁移的老用户（v1 的 user_id 以 m_ 开头）
        const res = await env.DB.prepare(
          "SELECT * FROM users WHERE nickname = ? AND merged_into IS NULL AND v2 = 0 AND user_id LIKE 'm_%'"
        ).bind(nickname).all();
        const matches = [];
        for (const row of res.results || []) {
          const roomCodes = await getUserRoomCodes(env, row.user_id);
          const user = rowToUser(row, roomCodes);
          const provCount = Object.keys(user.footprint?.provinces || {}).length;
          const cityCount = Object.keys(user.footprint?.cities || {}).length;
          matches.push({
            userId: user.userId,
            nickname: user.nickname,
            color: user.color,
            provCount,
            cityCount,
            roomCodes: user.roomCodes || [],
          });
        }
        return reply({ matches });
      }

      // POST /api/auth/claim-legacy — 老数据领回 {nickname, password, roomCode?}
      // v1 老用户（m_ 开头）首次用新版时，输入原昵称+设 4 位密码，绑定老数据
      if (method === 'POST' && pathname === '/api/auth/claim-legacy') {
        const body = await readBody();
        const nickname = (body.nickname || '').trim();
        const password = (body.password || '').trim();
        if (!nickname) return fail('请输入原来的昵称', 400);
        if (!isValidPin(password)) return fail('密码必须为 4 位数字', 400);
        // 用户名默认为昵称拼音化？不，直接用昵称作用户名（需符合规则）
        // 若昵称不符合用户名规则，用 nickname 的 hash 生成
        let username = nickname;
        if (!isValidUsername(username)) {
          // 生成合法用户名：u_ + 时间戳后 6 位
          username = `u_${Date.now().toString(36).slice(-6)}`;
        }
        // 检查用户名是否已被占用
        const acctUser = await getUser(env, username);
        if (acctUser) {
          return fail(`"${username}" 已被注册，请换个用户名或联系家人`, 409);
        }
        // 查找老数据：在所有 user:{m_*} 中找昵称匹配的
        // 为简化，要求前端传入老 userId（从房间成员列表获取）
        const legacyUserId = (body.legacyUserId || '').trim();
        let legacyUser = null;
        if (legacyUserId) {
          legacyUser = await getUser(env, legacyUserId);
        }
        const now = Date.now();
        const newUser = {
          userId: username,
          username,
          passwordHash: await hashPassword(username, password),
          nickname,
          color: (legacyUser && legacyUser.color) || DEFAULT_COLORS[0],
          footprint: (legacyUser && legacyUser.footprint) || emptyFootprint(),
          roomCodes: (legacyUser && legacyUser.roomCodes) || [],
          createdAt: now,
          updatedAt: now,
          mergedInto: null,
          v2: true,
          claimedFrom: legacyUserId || null,
        };
        await putUser(env, newUser);
        // 更新房间成员列表中的 userId（把老 id 换成新 username）
        if (legacyUser && newUser.roomCodes.length > 0) {
          for (const code of newUser.roomCodes) {
            const room = await getRoom(env, code);
            if (room) {
              const entries = getMemberEntries(room);
              const idx = entries.findIndex((e) => e.userId === legacyUserId);
              if (idx >= 0) {
                entries[idx].userId = username;
                setMemberEntries(room, entries);
                if (room.ownerUserId === legacyUserId) room.ownerUserId = username;
                await putRoom(env, room);
              }
            }
          }
          // 标记老用户已迁移
          legacyUser.mergedInto = username;
          legacyUser.updatedAt = now;
          await putUser(env, legacyUser);
        }
        const { passwordHash, ...safe } = newUser;
        return reply({ user: safe }, 201);
      }

      // GET /api/rooms — 列出所有房间（供加入时浏览）
      if (method === 'GET' && pathname === '/api/rooms') {
        const res = await env.DB.prepare(
          `SELECT r.code, r.name, r.password, r.created_at,
                  (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code) AS member_count
           FROM rooms r
           ORDER BY member_count DESC`
        ).all();
        const rooms = (res.results || []).map((row) => ({
          code: row.code,
          name: row.name || '家庭房间',
          memberCount: row.member_count || 0,
          hasPassword: !!row.password,
          createdAt: row.created_at || 0,
        }));
        return reply({ rooms });
      }

      // GET /api/rooms/by-password/:password — 根据密码查房间码（用于密码加入）
      const pwdMatch = pathname.match(/^\/api\/rooms\/by-password\/(.+)$/);
      if (method === 'GET' && pwdMatch) {
        const password = decodeURIComponent(pwdMatch[1]).trim();
        if (!/^\d{4}$/.test(password)) return fail('密码为 4 位数字', 400);
        const code = await findRoomCodeByPassword(env, password);
        if (!code) return fail('密码不正确或房间不存在', 404);
        return reply({ code });
      }

      // GET /api/rooms/:code — 房间详情（含成员足迹）
      // PATCH /api/rooms/:code — 改名 / 转让房主
      const roomMatch = pathname.match(/^\/api\/rooms\/(\d{6})$/);
      if (roomMatch && (method === 'GET' || method === 'PATCH')) {
        const code = roomMatch[1];
        const room = await getRoom(env, code);
        if (!room) return fail('房间不存在', 404);

        if (method === 'GET') {
          const members = await getRoomMembers(env, room);
          return reply({
            code: room.code,
            name: room.name || '家庭房间',
            ownerUserId: room.ownerUserId || null,
            createdAt: room.createdAt || 0,
            members,
          });
        }

        // PATCH
        const body = await readBody();
        if (typeof body.name === 'string' && body.name.trim()) {
          room.name = body.name.trim().slice(0, 20);
        }
        if (typeof body.ownerUserId === 'string' && body.ownerUserId) {
          const entries = getMemberEntries(room);
          if (!entries.some((e) => e.userId === body.ownerUserId)) {
            return fail('新房主必须是房间成员', 400);
          }
          room.ownerUserId = body.ownerUserId;
        }
        // 重设密码（4 位数字，空字符串则清除密码）
        if (body.password !== undefined) {
          const newPwd = typeof body.password === 'string' ? body.password.trim() : '';
          if (newPwd && !/^\d{4}$/.test(newPwd)) {
            return fail('密码必须为 4 位数字', 400);
          }
          if (newPwd) {
            const existingCode = await findRoomCodeByPassword(env, newPwd);
            if (existingCode && existingCode !== code) {
              return fail('该密码已被使用，请换一个', 400);
            }
            room.password = newPwd;
          } else {
            delete room.password;
          }
        }
        await putRoom(env, room);
        return reply({ ok: true });
      }

      // POST /api/rooms/:code/join — 加入房间；新流程 {userId}（幂等），旧流程兼容 {name}
      const joinMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/join$/);
      if (method === 'POST' && joinMatch) {
        const code = joinMatch[1];
        const room = await getRoom(env, code);
        if (!room) return fail('房间不存在', 404);
        const body = await readBody();
        const now = Date.now();

        if (body.userId) {
          // 新流程：幂等加入
          const userId = String(body.userId);
          const entries = getMemberEntries(room);
          const alreadyIn = entries.some((e) => e.userId === userId);
          if (!alreadyIn && entries.length >= MAX_MEMBERS) {
            return fail(`房间成员已满（上限${MAX_MEMBERS}人）`, 400);
          }
          ensureMember(room, userId, now);
          const user = await getUser(env, userId);
          if (user) {
            if (!user.roomCodes.includes(code)) user.roomCodes.push(code);
            user.updatedAt = now;
            await putUser(env, user);
          }
          await putRoom(env, room);
          const members = await getRoomMembers(env, room);
          return reply({ ok: true, members });
        }

        // 旧流程兼容：{name} → 创建用户并加入
        const entries = getMemberEntries(room);
        if (entries.length >= MAX_MEMBERS) {
          return fail(`房间成员已满（上限${MAX_MEMBERS}人）`, 400);
        }
        const nickname = (body.name || `成员${entries.length + 1}`).trim().slice(0, 20) || `成员${entries.length + 1}`;
        const existingMembers = await getRoomMembers(env, room);
        const userId = generateUserId('m_');
        await putUser(env, {
          userId,
          nickname,
          color: pickColor(existingMembers.map((m) => m.color), entries.length),
          footprint: emptyFootprint(),
          roomCodes: [code],
          createdAt: now,
          updatedAt: now,
          mergedInto: null,
        });
        ensureMember(room, userId, now);
        await putRoom(env, room);
        const members = await getRoomMembers(env, room);
        return reply({ memberId: userId, members });
      }

      // POST /api/rooms/:code/claim — 认领身份：{fromUserId, toUserId}
      const claimMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/claim$/);
      if (method === 'POST' && claimMatch) {
        const code = claimMatch[1];
        const room = await getRoom(env, code);
        if (!room) return fail('房间不存在', 404);
        const body = await readBody();
        const fromUserId = body.fromUserId ? String(body.fromUserId) : '';
        const toUserId = body.toUserId ? String(body.toUserId) : '';
        if (!fromUserId || !toUserId) return fail('缺少 fromUserId 或 toUserId', 400);
        if (fromUserId === toUserId) return fail('不能认领自己', 400);

        const fromUser = await getUser(env, fromUserId);
        const toUser = await getUser(env, toUserId);
        if (!fromUser) return fail('被认领的用户不存在', 404);
        if (!toUser) return fail('当前用户不存在', 404);
        if (fromUser.mergedInto) return fail('该身份已被认领过', 400);

        const now = Date.now();
        // 合并足迹与房间列表，采用被认领者的昵称配色
        toUser.footprint = mergeFootprints(fromUser.footprint, toUser.footprint);
        toUser.roomCodes = [...new Set([...(toUser.roomCodes || []), ...(fromUser.roomCodes || [])])].filter((c) => /^\d{6}$/.test(c));
        if (fromUser.nickname) toUser.nickname = fromUser.nickname;
        if (fromUser.color) toUser.color = fromUser.color;
        toUser.updatedAt = now;
        await putUser(env, toUser);

        // 原记录标记 mergedInto（保留可审计）
        fromUser.mergedInto = toUserId;
        fromUser.updatedAt = now;
        await putUser(env, fromUser);

        // 房间名单替换 from → to（保留原加入时间；to 已在则去重）
        const entries = getMemberEntries(room);
        const fromEntry = entries.find((e) => e.userId === fromUserId);
        const toExists = entries.some((e) => e.userId === toUserId);
        let newEntries;
        if (toExists) {
          newEntries = entries.filter((e) => e.userId !== fromUserId);
        } else if (fromEntry) {
          newEntries = entries.map((e) =>
            e.userId === fromUserId ? { userId: toUserId, joinedAt: e.joinedAt } : e
          );
        } else {
          newEntries = entries;
        }
        setMemberEntries(room, newEntries);
        if (room.ownerUserId === fromUserId) room.ownerUserId = toUserId;
        await putRoom(env, room);

        return reply({ ok: true });
      }

      // POST /api/rooms/:code/leave — 退出房间；房主退出最早加入者继任，房空删房间
      const leaveMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/leave$/);
      if (method === 'POST' && leaveMatch) {
        const code = leaveMatch[1];
        const room = await getRoom(env, code);
        if (!room) return fail('房间不存在', 404);
        const body = await readBody();
        const userId = body.userId ? String(body.userId) : '';
        if (!userId) return fail('缺少 userId', 400);

        const { wasOwner } = removeMember(room, userId);
        const user = await getUser(env, userId);
        if (user) {
          dropRoomCode(user, code);
          user.updatedAt = Date.now();
          await putUser(env, user);
        }

        if (getMemberEntries(room).length === 0) {
          await deleteRoom(env, code);
          return reply({ ok: true });
        }
        if (wasOwner) succeedOwner(room);
        await putRoom(env, room);
        return reply({ ok: true });
      }

      // PUT /api/rooms/:code/members/:id — 旧客户端兼容：写入 user:{id} 并确保进房间名单
      // DELETE /api/rooms/:code/members/:userId — 移出房间（不删 user 记录，足迹是用户自己的）
      const memberMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/members\/([a-zA-Z0-9_-]+)$/);
      if (memberMatch && method === 'PUT') {
        const [, code, memberId] = memberMatch;
        const body = await readBody();
        const now = Date.now();

        let user = await getUser(env, memberId);
        if (!user) {
          user = {
            userId: memberId,
            nickname: '',
            color: DEFAULT_COLORS[0],
            footprint: emptyFootprint(),
            roomCodes: [],
            createdAt: now,
            updatedAt: now,
            mergedInto: null,
          };
        }
        if (typeof body.name === 'string' && body.name.trim()) {
          user.nickname = body.name.trim().slice(0, 20);
        }
        if (typeof body.color === 'string' && body.color.trim()) {
          user.color = body.color.trim();
        }
        if (body.footprint && typeof body.footprint === 'object') {
          user.footprint = body.footprint;
        }
        if (!user.roomCodes.includes(code)) user.roomCodes.push(code);
        user.updatedAt = now;
        await putUser(env, user);

        const room = await getRoom(env, code);
        if (room) {
          ensureMember(room, memberId, now);
          await putRoom(env, room);
        }
        return reply({ ok: true });
      }

      if (memberMatch && method === 'DELETE') {
        const [, code, userId] = memberMatch;
        const room = await getRoom(env, code);
        if (!room) return fail('房间不存在', 404);

        const { wasOwner } = removeMember(room, userId);
        const user = await getUser(env, userId);
        if (user) {
          dropRoomCode(user, code);
          user.updatedAt = Date.now();
          await putUser(env, user);
        }

        if (getMemberEntries(room).length === 0) {
          await deleteRoom(env, code);
          return reply({ ok: true });
        }
        if (wasOwner) succeedOwner(room);
        await putRoom(env, room);
        return reply({ ok: true });
      }

      return fail('未找到对应的 API 接口', 404);
    } catch (err) {
      console.error('Worker request error:', err);
      return fail('服务器内部错误', 500);
    }
  },
};
