/**
 * 点亮中国 · 多用户云同步 Worker（Phase 1：用户与房间系统）
 * 基于 Cloudflare Workers & KV，提供用户档案、家庭房间与足迹同步服务
 *
 * 数据模型：
 * - user:{userId} → {userId, nickname, color, footprint, roomCodes[], createdAt, updatedAt, mergedInto}
 * - room:{code}   → {code, name, ownerUserId, createdAt, memberUserIds: [{userId, joinedAt}]}
 *
 * 设计原则：房间成员实时读用户档案，一处真相，从结构上消灭"名单与数据不一致"。
 */

const ALLOWED_ORIGIN = 'https://map.snowyegret.top';
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
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

/* ---------- KV 读写 helper ---------- */

/** 读取用户档案，不存在返回 null */
async function getUser(env, userId) {
  if (!userId) return null;
  try {
    const raw = await env.ROOMS_KV.get(`user:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putUser(env, user) {
  await env.ROOMS_KV.put(`user:${user.userId}`, JSON.stringify(user));
}

/** 读取房间，不存在返回 null */
async function getRoom(env, code) {
  try {
    const raw = await env.ROOMS_KV.get(`room:${code}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putRoom(env, room) {
  await env.ROOMS_KV.put(`room:${room.code}`, JSON.stringify(room));
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
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
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
        return jsonResponse({ ok: true });
      }

      // GET /api/users/:userId — 拉取用户档案
      if (method === 'GET' && userPutMatch) {
        const user = await getUser(env, userPutMatch[1]);
        if (!user) return errorResponse('用户不存在', 404);
        return jsonResponse(user);
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
          const existing = await env.ROOMS_KV.get(`room:${tryCode}`);
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
          
          // 密码为 4 位数字，唯一性检查
          if (password) {
            if (!/^\d{4}$/.test(password)) {
              return errorResponse('密码必须为 4 位数字', 400);
            }
            const existingCode = await env.ROOMS_KV.get(`pwd:${password}`);
            if (existingCode) {
              return errorResponse('该密码已被使用，请换一个', 400);
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
            await env.ROOMS_KV.put(`pwd:${password}`, code);
          }
          await putRoom(env, room);
          return jsonResponse({ code }, 201);
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
        return jsonResponse({ code, memberId: userId }, 201);
      }

      // ========== v2 用户系统：注册/登录/改密码 ==========

      // POST /api/auth/register — 注册 {username, password, nickname?}
      if (method === 'POST' && pathname === '/api/auth/register') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        const nickname = (body.nickname || username).trim().slice(0, 20) || username;

        if (!isValidUsername(username)) {
          return errorResponse('用户名需为 2-12 个字符（中文/字母/数字/下划线）', 400);
        }
        if (!isValidPin(password)) {
          return errorResponse('密码必须为 4 位数字', 400);
        }
        // 用户名全站唯一，key 为 acct:{username}
        const existing = await env.ROOMS_KV.get(`acct:${username}`);
        if (existing) {
          return errorResponse('用户名已被注册', 409);
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
        await env.ROOMS_KV.put(`acct:${username}`, JSON.stringify({ username }));
        await putUser(env, user);
        // 返回时去掉密码哈希
        const { passwordHash, ...safe } = user;
        return jsonResponse({ user: safe }, 201);
      }

      // POST /api/auth/login — 登录 {username, password}
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        if (!username || !password) {
          return errorResponse('请输入用户名和密码', 400);
        }
        const user = await getUser(env, username);
        if (!user || !user.passwordHash) {
          return errorResponse('用户名或密码错误', 401);
        }
        const hash = await hashPassword(username, password);
        if (hash !== user.passwordHash) {
          return errorResponse('用户名或密码错误', 401);
        }
        const { passwordHash, ...safe } = user;
        return jsonResponse({ user: safe });
      }

      // POST /api/auth/change-password — 改密码 {username, oldPassword, newPassword}
      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const body = await readBody();
        const username = (body.username || '').trim();
        const oldPassword = (body.oldPassword || '').trim();
        const newPassword = (body.newPassword || '').trim();
        if (!isValidPin(newPassword)) {
          return errorResponse('新密码必须为 4 位数字', 400);
        }
        const user = await getUser(env, username);
        if (!user || !user.passwordHash) {
          return errorResponse('用户不存在', 404);
        }
        const oldHash = await hashPassword(username, oldPassword);
        if (oldHash !== user.passwordHash) {
          return errorResponse('原密码错误', 401);
        }
        user.passwordHash = await hashPassword(username, newPassword);
        user.updatedAt = Date.now();
        await putUser(env, user);
        return jsonResponse({ ok: true });
      }

      // GET /api/auth/find-legacy?nickname=xxx — 按昵称查找老用户（用于领回数据）
      if (method === 'GET' && pathname === '/api/auth/find-legacy') {
        const nickname = (url.searchParams.get('nickname') || '').trim();
        if (!nickname) return errorResponse('请输入昵称', 400);
        // 遍历所有 user:{m_*} 找昵称匹配且未被领走的
        const listRes = await env.ROOMS_KV.list({ prefix: 'user:m_' });
        const matches = [];
        for (const k of listRes.keys || []) {
          const user = await getUser(env, k.name.slice(5)); // 去掉 'user:' 前缀
          if (user && user.nickname === nickname && !user.mergedInto && !user.v2) {
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
        }
        return jsonResponse({ matches });
      }

      // POST /api/auth/claim-legacy — 老数据领回 {nickname, password, roomCode?}
      // v1 老用户（m_ 开头）首次用新版时，输入原昵称+设 4 位密码，绑定老数据
      if (method === 'POST' && pathname === '/api/auth/claim-legacy') {
        const body = await readBody();
        const nickname = (body.nickname || '').trim();
        const password = (body.password || '').trim();
        if (!nickname) return errorResponse('请输入原来的昵称', 400);
        if (!isValidPin(password)) return errorResponse('密码必须为 4 位数字', 400);
        // 用户名默认为昵称拼音化？不，直接用昵称作用户名（需符合规则）
        // 若昵称不符合用户名规则，用 nickname 的 hash 生成
        let username = nickname;
        if (!isValidUsername(username)) {
          // 生成合法用户名：u_ + 时间戳后 6 位
          username = `u_${Date.now().toString(36).slice(-6)}`;
        }
        // 检查用户名是否已被占用
        const acctExists = await env.ROOMS_KV.get(`acct:${username}`);
        if (acctExists) {
          return errorResponse(`"${username}" 已被注册，请换个用户名或联系家人`, 409);
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
        await env.ROOMS_KV.put(`acct:${username}`, JSON.stringify({ username }));
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
        return jsonResponse({ user: safe }, 201);
      }

      // GET /api/rooms — 列出所有房间（供加入时浏览）
      if (method === 'GET' && pathname === '/api/rooms') {
        const listRes = await env.ROOMS_KV.list({ prefix: 'room:' });
        const rooms = [];
        for (const k of listRes.keys || []) {
          const m = k.name.match(/^room:(\d{6})$/);
          if (!m) continue;
          const code = m[1];
          const room = await getRoom(env, code);
          if (!room) continue;
          const entries = getMemberEntries(room);
          rooms.push({
            code,
            name: room.name || '家庭房间',
            memberCount: entries.length,
            hasPassword: !!room.password,
            createdAt: room.createdAt || 0,
          });
        }
        // 按成员数倒序
        rooms.sort((a, b) => b.memberCount - a.memberCount);
        return jsonResponse({ rooms });
      }

      // GET /api/rooms/by-password/:password — 根据密码查房间码（用于密码加入）
      const pwdMatch = pathname.match(/^\/api\/rooms\/by-password\/(.+)$/);
      if (method === 'GET' && pwdMatch) {
        const password = decodeURIComponent(pwdMatch[1]).trim();
        if (!/^\d{4}$/.test(password)) return errorResponse('密码为 4 位数字', 400);
        const code = await env.ROOMS_KV.get(`pwd:${password}`);
        if (!code) return errorResponse('密码不正确或房间不存在', 404);
        return jsonResponse({ code });
      }

      // GET /api/rooms/:code — 房间详情（含成员足迹）
      // PATCH /api/rooms/:code — 改名 / 转让房主
      const roomMatch = pathname.match(/^\/api\/rooms\/(\d{6})$/);
      if (roomMatch && (method === 'GET' || method === 'PATCH')) {
        const code = roomMatch[1];
        const room = await getRoom(env, code);
        if (!room) return errorResponse('房间不存在', 404);

        if (method === 'GET') {
          const members = await getRoomMembers(env, room);
          return jsonResponse({
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
            return errorResponse('新房主必须是房间成员', 400);
          }
          room.ownerUserId = body.ownerUserId;
        }
        // 重设密码（4 位数字，空字符串则清除密码）
        if (body.password !== undefined) {
          const newPwd = typeof body.password === 'string' ? body.password.trim() : '';
          if (newPwd && !/^\d{4}$/.test(newPwd)) {
            return errorResponse('密码必须为 4 位数字', 400);
          }
          // 清除旧密码索引
          if (room.password) {
            await env.ROOMS_KV.delete(`pwd:${room.password}`);
          }
          if (newPwd) {
            const existingCode = await env.ROOMS_KV.get(`pwd:${newPwd}`);
            if (existingCode && existingCode !== code) {
              return errorResponse('该密码已被使用，请换一个', 400);
            }
            room.password = newPwd;
            await env.ROOMS_KV.put(`pwd:${newPwd}`, code);
          } else {
            delete room.password;
          }
        }
        await putRoom(env, room);
        return jsonResponse({ ok: true });
      }

      // POST /api/rooms/:code/join — 加入房间；新流程 {userId}（幂等），旧流程兼容 {name}
      const joinMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/join$/);
      if (method === 'POST' && joinMatch) {
        const code = joinMatch[1];
        const room = await getRoom(env, code);
        if (!room) return errorResponse('房间不存在', 404);
        const body = await readBody();
        const now = Date.now();

        if (body.userId) {
          // 新流程：幂等加入
          const userId = String(body.userId);
          const entries = getMemberEntries(room);
          const alreadyIn = entries.some((e) => e.userId === userId);
          if (!alreadyIn && entries.length >= MAX_MEMBERS) {
            return errorResponse(`房间成员已满（上限${MAX_MEMBERS}人）`, 400);
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
          return jsonResponse({ ok: true, members });
        }

        // 旧流程兼容：{name} → 创建用户并加入
        const entries = getMemberEntries(room);
        if (entries.length >= MAX_MEMBERS) {
          return errorResponse(`房间成员已满（上限${MAX_MEMBERS}人）`, 400);
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
        return jsonResponse({ memberId: userId, members });
      }

      // POST /api/rooms/:code/claim — 认领身份：{fromUserId, toUserId}
      const claimMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/claim$/);
      if (method === 'POST' && claimMatch) {
        const code = claimMatch[1];
        const room = await getRoom(env, code);
        if (!room) return errorResponse('房间不存在', 404);
        const body = await readBody();
        const fromUserId = body.fromUserId ? String(body.fromUserId) : '';
        const toUserId = body.toUserId ? String(body.toUserId) : '';
        if (!fromUserId || !toUserId) return errorResponse('缺少 fromUserId 或 toUserId', 400);
        if (fromUserId === toUserId) return errorResponse('不能认领自己', 400);

        const fromUser = await getUser(env, fromUserId);
        const toUser = await getUser(env, toUserId);
        if (!fromUser) return errorResponse('被认领的用户不存在', 404);
        if (!toUser) return errorResponse('当前用户不存在', 404);
        if (fromUser.mergedInto) return errorResponse('该身份已被认领过', 400);

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

        return jsonResponse({ ok: true });
      }

      // POST /api/rooms/:code/leave — 退出房间；房主退出最早加入者继任，房空删房间
      const leaveMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/leave$/);
      if (method === 'POST' && leaveMatch) {
        const code = leaveMatch[1];
        const room = await getRoom(env, code);
        if (!room) return errorResponse('房间不存在', 404);
        const body = await readBody();
        const userId = body.userId ? String(body.userId) : '';
        if (!userId) return errorResponse('缺少 userId', 400);

        const { wasOwner } = removeMember(room, userId);
        const user = await getUser(env, userId);
        if (user) {
          dropRoomCode(user, code);
          user.updatedAt = Date.now();
          await putUser(env, user);
        }

        if (getMemberEntries(room).length === 0) {
          await env.ROOMS_KV.delete(`room:${code}`);
          return jsonResponse({ ok: true });
        }
        if (wasOwner) succeedOwner(room);
        await putRoom(env, room);
        return jsonResponse({ ok: true });
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
        return jsonResponse({ ok: true });
      }

      if (memberMatch && method === 'DELETE') {
        const [, code, userId] = memberMatch;
        const room = await getRoom(env, code);
        if (!room) return errorResponse('房间不存在', 404);

        const { wasOwner } = removeMember(room, userId);
        const user = await getUser(env, userId);
        if (user) {
          dropRoomCode(user, code);
          user.updatedAt = Date.now();
          await putUser(env, user);
        }

        if (getMemberEntries(room).length === 0) {
          await env.ROOMS_KV.delete(`room:${code}`);
          return jsonResponse({ ok: true });
        }
        if (wasOwner) succeedOwner(room);
        await putRoom(env, room);
        return jsonResponse({ ok: true });
      }

      return errorResponse('未找到对应的 API 接口', 404);
    } catch (err) {
      console.error('Worker request error:', err);
      return errorResponse('服务器内部错误', 500);
    }
  },
};
