/**
 * 点亮中国 · 多用户云同步 Worker
 * 基于 Cloudflare Workers & KV，提供家庭房间与成员足迹同步服务
 */

const ALLOWED_ORIGIN = 'https://map.snowyegret.top';
const DEFAULT_COLORS = ['#C9A25E', '#7FB3A3', '#C4574E', '#5B7FA6'];
const MAX_MEMBERS = 4;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

function generateMemberId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

    try {
      // POST /api/rooms {name} → {code, memberId}
      if (method === 'POST' && pathname === '/api/rooms') {
        let body = {};
        try {
          body = await request.json();
        } catch {}
        const name = (body.name || '我').trim().slice(0, 20) || '我';

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
        if (!code) {
          code = generateRoomCode();
        }

        const memberId = generateMemberId();
        const initialMember = {
          id: memberId,
          name,
          color: DEFAULT_COLORS[0],
          updatedAt: Date.now(),
          footprint: {
            provinces: {},
            cities: {},
            unlockedAchievements: [],
            maxTitleLevel: 0,
          },
        };

        const roomData = {
          createdAt: Date.now(),
          memberIds: [memberId],
        };

        await env.ROOMS_KV.put(`room:${code}`, JSON.stringify(roomData));
        await env.ROOMS_KV.put(`room:${code}:member:${memberId}`, JSON.stringify(initialMember));

        return jsonResponse({ code, memberId }, 201);
      }

      // POST /api/rooms/:code/join {name} → {memberId, members}
      const joinMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/join$/);
      if (method === 'POST' && joinMatch) {
        const code = joinMatch[1];
        const roomRaw = await env.ROOMS_KV.get(`room:${code}`);
        if (!roomRaw) {
          return errorResponse('房间不存在', 404);
        }

        const room = JSON.parse(roomRaw);
        const memberIds = Array.isArray(room.memberIds) ? room.memberIds : [];

        if (memberIds.length >= MAX_MEMBERS) {
          return errorResponse('房间成员已满（上限4人）', 400);
        }

        let body = {};
        try {
          body = await request.json();
        } catch {}
        const name = (body.name || `成员${memberIds.length + 1}`).trim().slice(0, 20) || `成员${memberIds.length + 1}`;

        // 获取已存在成员以推算未使用的颜色
        const existingMembers = [];
        for (const id of memberIds) {
          const raw = await env.ROOMS_KV.get(`room:${code}:member:${id}`);
          if (raw) {
            try {
              existingMembers.push(JSON.parse(raw));
            } catch {}
          }
        }

        const usedColors = new Set(existingMembers.map((m) => m.color));
        const color = DEFAULT_COLORS.find((c) => !usedColors.has(c)) || DEFAULT_COLORS[memberIds.length % DEFAULT_COLORS.length];

        const memberId = generateMemberId();
        const newMember = {
          id: memberId,
          name,
          color,
          updatedAt: Date.now(),
          footprint: {
            provinces: {},
            cities: {},
            unlockedAchievements: [],
            maxTitleLevel: 0,
          },
        };

        memberIds.push(memberId);
        room.memberIds = memberIds;

        await env.ROOMS_KV.put(`room:${code}`, JSON.stringify(room));
        await env.ROOMS_KV.put(`room:${code}:member:${memberId}`, JSON.stringify(newMember));

        existingMembers.push(newMember);
        return jsonResponse({ memberId, members: existingMembers });
      }

      // GET /api/rooms/:code → {members:[{id,name,color,updatedAt,footprint}]}
      const roomMatch = pathname.match(/^\/api\/rooms\/(\d{6})$/);
      if (method === 'GET' && roomMatch) {
        const code = roomMatch[1];
        const roomRaw = await env.ROOMS_KV.get(`room:${code}`);
        if (!roomRaw) {
          return errorResponse('房间不存在', 404);
        }

        const room = JSON.parse(roomRaw);
        const memberIds = Array.isArray(room.memberIds) ? room.memberIds : [];

        const members = [];
        for (const id of memberIds) {
          const raw = await env.ROOMS_KV.get(`room:${code}:member:${id}`);
          if (raw) {
            try {
              members.push(JSON.parse(raw));
            } catch {}
          }
        }

        return jsonResponse({ members });
      }

      // PUT /api/rooms/:code/members/:id {name,color,footprint} → {ok:true}
      const memberMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/members\/([a-zA-Z0-9_-]+)$/);
      if (method === 'PUT' && memberMatch) {
        const [, code, memberId] = memberMatch;
        const memberKey = `room:${code}:member:${memberId}`;
        const rawMember = await env.ROOMS_KV.get(memberKey);

        let body = {};
        try {
          body = await request.json();
        } catch {}

        let memberObj = {};
        if (rawMember) {
          try {
            memberObj = JSON.parse(rawMember);
          } catch {}
        }

        memberObj.id = memberId;
        if (typeof body.name === 'string' && body.name.trim()) {
          memberObj.name = body.name.trim().slice(0, 20);
        }
        if (typeof body.color === 'string' && body.color.trim()) {
          memberObj.color = body.color.trim();
        }
        if (body.footprint && typeof body.footprint === 'object') {
          memberObj.footprint = body.footprint;
        }
        memberObj.updatedAt = Date.now();

        await env.ROOMS_KV.put(memberKey, JSON.stringify(memberObj));

        // 自愈：确保成员 ID 在房间名单中（防止名单与数据不一致）
        try {
          const roomRaw = await env.ROOMS_KV.get(`room:${code}`);
          if (roomRaw) {
            const room = JSON.parse(roomRaw);
            if (Array.isArray(room.memberIds) && !room.memberIds.includes(memberId)) {
              room.memberIds.push(memberId);
              await env.ROOMS_KV.put(`room:${code}`, JSON.stringify(room));
            }
          }
        } catch {}

        return jsonResponse({ ok: true });
      }

      // DELETE /api/rooms/:code/members/:id → {ok:true}
      if (method === 'DELETE' && memberMatch) {
        const [, code, memberId] = memberMatch;
        const roomRaw = await env.ROOMS_KV.get(`room:${code}`);
        if (roomRaw) {
          try {
            const room = JSON.parse(roomRaw);
            if (Array.isArray(room.memberIds)) {
              room.memberIds = room.memberIds.filter((id) => id !== memberId);
              await env.ROOMS_KV.put(`room:${code}`, JSON.stringify(room));
            }
          } catch {}
        }
        await env.ROOMS_KV.delete(`room:${code}:member:${memberId}`);
        return jsonResponse({ ok: true });
      }

      return errorResponse('未找到对应的 API 接口', 404);
    } catch (err) {
      console.error('Worker request error:', err);
      return errorResponse('服务器内部错误', 500);
    }
  },
};
