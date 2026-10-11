/**
 * 点亮中国 · 大厅视图（Lobby）
 * Phase 1 用户系统：身份区 / 用户切换 / 我的房间 / 创建&加入房间
 *
 * 约定：
 * - 只读 store v5 方法（getUsers/getActiveUser/getRooms/addRoom/removeRoom/setActiveRoom/updateUser/setActiveUser）
 * - 只调 syncApi 传入的方法（createRoom/joinRoom/fetchRoom/leaveRoom/claimIdentity）
 * - 不直接操作地图；进房/切用户通过 hooks 通知 main.js
 */

let storeRef = null;
let syncRef = null;
let hooksRef = {};
let prevFocus = null;
let memberCountCache = new Map(); // code -> {count, at}

/* ---------- 小工具 ---------- */

function $(id) { return document.getElementById(id); }

function notify(msg) {
  if (typeof hooksRef.toast === 'function') hooksRef.toast(msg);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60 * 1000) return '刚刚';
  if (d < 60 * 60 * 1000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 24 * 60 * 60 * 1000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(d / 86400000)} 天前`;
  const t = new Date(ts);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/* ---------- 渲染 ---------- */

function renderIdentity() {
  const user = storeRef.getActiveUser();
  if (!user) return;
  const fp = storeRef.getActiveFootprint() || {};
  const provCount = Object.keys(fp.provinces || {}).length;
  const cityCount = Object.keys(fp.cities || {}).length;

  $('lobby-user-dot').style.background = user.color;
  $('lobby-user-dot').style.boxShadow = `0 0 10px ${user.color}`;
  $('lobby-user-name').textContent = user.nickname;
  $('lobby-user-stats').textContent = `点亮 ${provCount} 省 · ${cityCount} 市`;
}

function renderUserSwitch() {
  const users = storeRef.getUsers();
  const box = $('lobby-users-section');
  if (users.length <= 1) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  const activeId = storeRef.getActiveUserId();
  $('lobby-users-list').innerHTML = users.map((u) => `
    <button type="button" class="lobby-user-chip${u.userId === activeId ? ' active' : ''}"
      data-user-id="${esc(u.userId)}" aria-pressed="${u.userId === activeId}">
      <span class="lobby-user-chip-dot" style="background:${esc(u.color)}"></span>
      <span>${esc(u.nickname)}</span>
    </button>
  `).join('');
}

/**
 * 渲染当前房间成员（只读，从服务端拉取）
 */
async function renderRoomMembers() {
  const box = $('lobby-members-section');
  const listEl = $('lobby-members-list');
  const nameEl = $('lobby-members-room-name');
  if (!box || !listEl) return;
  
  const activeCode = storeRef.getActiveRoomCode();
  if (!activeCode) {
    box.style.display = 'none';
    return;
  }
  
  box.style.display = '';
  const room = storeRef.getRooms().find((r) => r.code === activeCode);
  if (nameEl) nameEl.textContent = room ? `（${room.name}）` : '';
  
  listEl.innerHTML = '<div class="lobby-empty">加载中…</div>';
  try {
    const data = await syncRef.fetchRoom(activeCode);
    const members = (data && Array.isArray(data.members)) ? data.members : [];
    const meId = storeRef.getActiveUserId();
    if (members.length === 0) {
      listEl.innerHTML = '<div class="lobby-empty">暂无成员</div>';
      return;
    }
    listEl.innerHTML = members.map((m) => {
      const provCount = Object.keys(m.footprint?.provinces || {}).length;
      const cityCount = Object.keys(m.footprint?.cities || {}).length;
      const isMe = m.userId === meId;
      return `
      <div class="lobby-user-chip${isMe ? ' active' : ''}" style="cursor:default">
        <span class="lobby-user-chip-dot" style="background:${esc(m.color || '#999')}"></span>
        <span>${esc(m.nickname || '成员')}${isMe ? '（我）' : ''}</span>
        <span style="font-size:11px;color:#999;margin-left:4px">${provCount}省${cityCount}市</span>
      </div>`;
    }).join('');
  } catch {
    listEl.innerHTML = '<div class="lobby-empty">加载失败</div>';
  }
}

function renderRooms() {
  const rooms = storeRef.getRooms();
  const activeCode = storeRef.getActiveRoomCode();
  const list = $('lobby-rooms-list');
  const empty = $('lobby-rooms-empty');

  if (rooms.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = rooms.map((r) => {
    const cached = memberCountCache.get(r.code);
    const countText = cached ? `${cached.count} 人` : '…';
    const pwdBtn = r.role === 'owner'
      ? `<button type="button" class="lobby-room-leave" data-action="password" data-room-code="${esc(r.code)}"
        aria-label="重设${esc(r.name)}密码" title="重设密码">密码</button>`
      : '';
    return `
    <div class="lobby-room-item${r.code === activeCode ? ' active' : ''}" data-room-code="${esc(r.code)}">
      <button type="button" class="lobby-room-main" data-action="enter" data-room-code="${esc(r.code)}">
        <div class="lobby-room-name">${esc(r.name)}${r.role === 'owner' ? ' <span class="lobby-room-owner">房主</span>' : ''}</div>
        <div class="lobby-room-meta">
          <span class="lobby-room-code">${esc(r.code)}</span>
          <span>·</span><span data-member-count="${esc(r.code)}">${countText}</span>
          <span>·</span><span>${relTime(r.lastOpenedAt)}</span>
        </div>
      </button>
      ${pwdBtn}
      <button type="button" class="lobby-room-leave" data-action="leave" data-room-code="${esc(r.code)}"
        aria-label="退出${esc(r.name)}" title="退出房间">退出</button>
    </div>`;
  }).join('');

  // 后台刷新成员数
  refreshMemberCounts(rooms);
}

async function refreshMemberCounts(rooms) {
  if (!syncRef || typeof syncRef.fetchRoom !== 'function') return;
  const now = Date.now();
  await Promise.all(rooms.map(async (r) => {
    const cached = memberCountCache.get(r.code);
    if (cached && now - cached.at < 60 * 1000) {
      updateCountDom(r.code, cached.count);
      return;
    }
    try {
      const data = await syncRef.fetchRoom(r.code);
      const count = data && Array.isArray(data.members) ? data.members.length : 0;
      memberCountCache.set(r.code, { count, at: now });
      updateCountDom(r.code, count);
    } catch { /* 离线时保持占位 */ }
  }));
}

function updateCountDom(code, count) {
  const el = document.querySelector(`[data-member-count="${code}"]`);
  if (el) el.textContent = `${count} 人`;
}

function renderAll() {
  renderIdentity();
  renderUserSwitch();
  renderRooms();
  renderRoomMembers();
  hideSubPanels();
}

/* ---------- 子面板（创建/加入/预览/认领） ---------- */

function hideSubPanels() {
  for (const id of ['lobby-create-panel', 'lobby-join-panel', 'lobby-preview-panel', 'lobby-claim-panel']) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }
  const actions = $('lobby-actions');
  if (actions) actions.style.display = '';
}

function showSubPanel(id) {
  hideSubPanels();
  $('lobby-actions').style.display = 'none';
  $(id).style.display = '';
}

/* ---------- 改名 ---------- */

function startRename() {
  const nameEl = $('lobby-user-name');
  const user = storeRef.getActiveUser();
  if (!user || nameEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 16;
  input.value = user.nickname;
  input.className = 'lobby-rename-input';
  input.setAttribute('aria-label', '修改昵称');
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    if (v && v !== user.nickname) {
      storeRef.updateUser(user.userId, { nickname: v });
      notify(`已改名为 ${v}`);
      if (typeof hooksRef.onUserSwitched === 'function') hooksRef.onUserSwitched();
    }
    renderIdentity();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') renderIdentity();
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ---------- 创建房间 ---------- */

async function doCreateRoom() {
  const nameInput = $('lobby-create-name');
  const name = (nameInput.value || '').trim() || '我们家';
  const pwdInput = $('lobby-create-password');
  const password = (pwdInput.value || '').trim();
  if (password && !/^\d{4}$/.test(password)) {
    notify('密码必须为 4 位数字');
    return;
  }
  const user = storeRef.getActiveUser();
  if (!user) return;

  const btn = $('lobby-create-confirm');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const res = await syncRef.createRoom(name, user.userId, password);
    if (res && res.code) {
      storeRef.addRoom(res.code, name, 'owner');
      memberCountCache.set(res.code, { count: 1, at: Date.now() });
      const pwdTip = password ? `，加入密码：${password}` : '（未设密码，用房间码加入）';
      notify(`房间「${name}」创建成功，房间码 ${res.code}${pwdTip}`);
      // 清空输入
      nameInput.value = '';
      if (pwdInput) pwdInput.value = '';
      enterRoom(res.code);
    } else {
      notify('创建失败，请检查网络后重试');
    }
  } catch {
    notify('创建失败，请检查网络后重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '确定创建';
  }
}

/* ---------- 加入房间 ---------- */

let pendingJoin = null; // { code, data }

async function loadAllRooms() {
  const listEl = $('lobby-all-rooms-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="lobby-empty">加载中…</div>';
  try {
    if (typeof syncRef.listRooms !== 'function') {
      listEl.innerHTML = '<div class="lobby-empty">当前版本不支持</div>';
      return;
    }
    const rooms = await syncRef.listRooms();
    if (!rooms || rooms.length === 0) {
      listEl.innerHTML = '<div class="lobby-empty">暂无房间</div>';
      return;
    }
    // 过滤掉已加入的
    const joinedCodes = new Set(storeRef.getRooms().map((r) => r.code));
    const available = rooms.filter((r) => !joinedCodes.has(r.code));
    if (available.length === 0) {
      listEl.innerHTML = '<div class="lobby-empty">所有房间都已加入</div>';
      return;
    }
    listEl.innerHTML = available.map((r) => `
      <div class="lobby-room-item" data-room-code="${esc(r.code)}">
        <button type="button" class="lobby-room-main" data-action="preview-join" data-room-code="${esc(r.code)}">
          <div class="lobby-room-name">${esc(r.name)}${r.hasPassword ? ' 🔒' : ''}</div>
          <div class="lobby-room-meta">
            <span class="lobby-room-code">${esc(r.code)}</span>
            <span>·</span><span>${r.memberCount} 人</span>
          </div>
        </button>
      </div>`).join('');
  } catch {
    listEl.innerHTML = '<div class="lobby-empty">加载失败，请重试</div>';
  }
}

async function doPreviewJoin() {
  const codeInput = $('lobby-join-code');
  const input = (codeInput.value || '').trim();
  if (!input) {
    notify('请输入房间码或密码');
    return;
  }
  const btn = $('lobby-join-preview-btn');
  btn.disabled = true;
  btn.textContent = '查找中…';
  try {
    let code = input;
    // 4 位数字按密码查，6 位数字按房间码
    if (/^\d{4}$/.test(input)) {
      if (typeof syncRef.getRoomByPassword !== 'function') {
        notify('当前版本不支持密码加入，请更新后重试');
        return;
      }
      const pwdRes = await syncRef.getRoomByPassword(input);
      if (!pwdRes || !pwdRes.code) {
        notify('密码不正确或房间不存在');
        return;
      }
      code = pwdRes.code;
    } else if (!/^\d{6}$/.test(input)) {
      notify('请输入 6 位房间码或 4 位密码');
      return;
    }
    const data = await syncRef.fetchRoom(code);
    if (!data) {
      notify('找不到该房间，请检查输入');
      return;
    }
    pendingJoin = { code, data };
    const members = Array.isArray(data.members) ? data.members : [];
    $('lobby-preview-name').textContent = data.name || '家庭房间';
    $('lobby-preview-code').textContent = code;
    $('lobby-preview-members').innerHTML = members.length
      ? members.map((m) => `
        <span class="lobby-preview-member">
          <span class="lobby-user-chip-dot" style="background:${esc(m.color || '#999')}"></span>
          ${esc(m.nickname || m.name || '成员')}
        </span>`).join('')
      : '<span class="lobby-preview-empty">房间暂无成员</span>';
    showSubPanel('lobby-preview-panel');
  } catch {
    notify('查找失败，请检查网络后重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '查找房间';
  }
}

async function doConfirmJoin() {
  if (!pendingJoin) return;
  const { code, data } = pendingJoin;
  const user = storeRef.getActiveUser();
  if (!user) return;

  const btn = $('lobby-join-confirm');
  btn.disabled = true;
  btn.textContent = '加入中…';
  try {
    const res = await syncRef.joinRoom(code, user.userId);
    if (!res || !res.ok) {
      notify('加入失败，请重试');
      return;
    }
    const roomName = data.name || '家庭房间';
    storeRef.addRoom(code, roomName, 'member');
    memberCountCache.delete(code);

    // 认领检查：房间里有没有和我同名的人
    const members = Array.isArray(res.members) ? res.members : [];
    const sameName = members.find((m) =>
      m.userId !== user.userId &&
      (m.nickname || m.name) === user.nickname
    );
    if (sameName) {
      showClaimPanel(code, sameName);
    } else {
      notify(`已加入「${roomName}」`);
      enterRoom(code, { isNewJoin: true });
    }
  } catch {
    notify('加入失败，请检查网络后重试');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认加入';
    pendingJoin = null;
  }
}

/* ---------- 认领（UI 框架，具体合并逻辑后续补） ---------- */

function showClaimPanel(code, matched) {
  $('lobby-claim-text').innerHTML =
    `这个房间已有「<b>${esc(matched.nickname || matched.name)}</b>」，你是 TA 吗？` +
    `<br><span class="lobby-claim-hint">认领后可合并足迹数据</span>`;
  $('lobby-claim-confirm').dataset.fromUserId = matched.userId;
  $('lobby-claim-confirm').dataset.roomCode = code;
  showSubPanel('lobby-claim-panel');
}

function doClaim() {
  const btn = $('lobby-claim-confirm');
  const fromUserId = btn.dataset.fromUserId;
  const code = btn.dataset.roomCode;
  if (typeof hooksRef.onClaim === 'function') {
    hooksRef.onClaim(code, fromUserId);
  } else {
    notify('认领功能即将上线');
  }
  hideSubPanels();
  if (code) enterRoom(code);
}

/* ---------- 进房 / 退房 ---------- */

function enterRoom(code, opts = {}) {
  storeRef.setActiveRoom(code);
  hideLobby();
  if (typeof hooksRef.onEnterRoom === 'function') hooksRef.onEnterRoom(code, opts);
}

async function doLeaveRoom(code, roomName) {
  const user = storeRef.getActiveUser();
  // 二次确认用原生 confirm（lobby 内轻量场景）
  if (!window.confirm(`确定退出「${roomName}」吗？本地房间记录将被移除。`)) return;

  storeRef.removeRoom(code);
  memberCountCache.delete(code);
  if (user && syncRef && typeof syncRef.leaveRoom === 'function') {
    try { await syncRef.leaveRoom(code, user.userId); } catch { /* 离线也算退出 */ }
  }
  notify(`已退出「${roomName}」`);
  renderRooms();
  if (typeof hooksRef.onRoomLeft === 'function') hooksRef.onRoomLeft(code);
}

async function doResetPassword(code, roomName) {
  const newPwd = window.prompt(`为「${roomName}」设置新的 4 位数字密码（留空则清除密码）：`, '');
  if (newPwd === null) return; // 取消
  const pwd = newPwd.trim();
  if (pwd && !/^\d{4}$/.test(pwd)) {
    notify('密码必须为 4 位数字');
    return;
  }
  if (typeof syncRef.updateRoomPassword !== 'function') {
    notify('当前版本不支持，请更新后重试');
    return;
  }
  const ok = await syncRef.updateRoomPassword(code, pwd);
  if (ok) {
    notify(pwd ? `「${roomName}」密码已更新为 ${pwd}` : `「${roomName}」密码已清除`);
  } else {
    notify('密码更新失败，请检查网络后重试');
  }
}

/* ---------- 显示 / 隐藏 ---------- */

function showLobby() {
  prevFocus = document.activeElement;
  renderAll();
  const overlay = $('lobby-overlay');
  overlay.style.display = 'flex';
  void overlay.offsetWidth;
  overlay.classList.add('show');
  const closeBtn = $('lobby-close');
  if (closeBtn) closeBtn.focus();
}

function hideLobby() {
  const overlay = $('lobby-overlay');
  if (!overlay || !overlay.classList.contains('show')) return;
  overlay.classList.remove('show');
  setTimeout(() => {
    overlay.style.display = 'none';
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch {}
      prevFocus = null;
    }
  }, 250);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  $('lobby-close').addEventListener('click', (e) => { e.stopPropagation(); hideLobby(); });
  $('lobby-overlay').addEventListener('click', (e) => {
    if (e.target === $('lobby-overlay')) hideLobby();
  });
  document.querySelector('.lobby-sheet').addEventListener('click', (e) => e.stopPropagation());

  // 改名
  $('lobby-user-name').addEventListener('click', (e) => { e.stopPropagation(); startRename(); });

  // 用户切换（事件委托）
  $('lobby-users-list').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-user-id]');
    if (!chip) return;
    e.stopPropagation();
    const uid = chip.dataset.userId;
    if (uid === storeRef.getActiveUserId()) return;
    if (storeRef.setActiveUser(uid)) {
      renderAll();
      notify(`已切换到 ${storeRef.getActiveUser().nickname}`);
      if (typeof hooksRef.onUserSwitched === 'function') hooksRef.onUserSwitched();
    }
  });

  // 所有房间列表（加入时浏览，点击直接预览）
  const allRoomsList = $('lobby-all-rooms-list');
  if (allRoomsList) {
    allRoomsList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="preview-join"]');
      if (!btn) return;
      e.stopPropagation();
      const code = btn.dataset.roomCode;
      if (!code) return;
      $('lobby-join-code').value = code;
      doPreviewJoin();
    });
  }

  // 房间列表（事件委托：进入 / 退出）
  $('lobby-rooms-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const code = btn.dataset.roomCode;
    const room = storeRef.getRooms().find((r) => r.code === code);
    if (!room) return;
    if (btn.dataset.action === 'enter') {
      enterRoom(code);
    } else if (btn.dataset.action === 'leave') {
      doLeaveRoom(code, room.name);
    } else if (btn.dataset.action === 'password') {
      doResetPassword(code, room.name);
    }
  });

  // 创建房间
  $('lobby-create-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('lobby-create-name').value = '';
    $('lobby-create-name').placeholder = '房间名（默认：我们家）';
    showSubPanel('lobby-create-panel');
    setTimeout(() => $('lobby-create-name').focus(), 50);
  });
  $('lobby-create-confirm').addEventListener('click', (e) => { e.stopPropagation(); doCreateRoom(); });
  $('lobby-create-cancel').addEventListener('click', (e) => { e.stopPropagation(); hideSubPanels(); });
  $('lobby-create-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreateRoom();
    e.stopPropagation();
  });

  // 加入房间
  $('lobby-join-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('lobby-join-code').value = '';
    showSubPanel('lobby-join-panel');
    loadAllRooms();
    setTimeout(() => $('lobby-join-code').focus(), 50);
  });
  $('lobby-join-preview-btn').addEventListener('click', (e) => { e.stopPropagation(); doPreviewJoin(); });
  $('lobby-join-cancel').addEventListener('click', (e) => { e.stopPropagation(); hideSubPanels(); });
  $('lobby-join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPreviewJoin();
    e.stopPropagation();
  });

  // 预览确认
  $('lobby-join-confirm').addEventListener('click', (e) => { e.stopPropagation(); doConfirmJoin(); });
  $('lobby-preview-back').addEventListener('click', (e) => {
    e.stopPropagation();
    pendingJoin = null;
    showSubPanel('lobby-join-panel');
  });

  // 认领
  $('lobby-claim-confirm').addEventListener('click', (e) => { e.stopPropagation(); doClaim(); });
  $('lobby-claim-skip').addEventListener('click', (e) => {
    e.stopPropagation();
    const code = $('lobby-claim-confirm').dataset.roomCode;
    hideSubPanels();
    if (code) enterRoom(code);
  });
}

/* ---------- 对外接口 ---------- */

/**
 * 初始化大厅
 * @param {Object} store Store v5 实例
 * @param {Object} syncApi { createRoom, joinRoom, fetchRoom, leaveRoom, claimIdentity }
 * @param {Object} hooks { toast(msg), onEnterRoom(code), onUserSwitched(), onRoomLeft(code), onClaim(code, fromUserId) }
 */
export function initLobby(store, syncApi, hooks = {}) {
  storeRef = store;
  syncRef = syncApi || {};
  hooksRef = hooks || {};
  bindEvents();
}

export { showLobby, hideLobby };
