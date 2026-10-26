/**
 * 点亮中国 · v2 登录页 UI 逻辑
 *
 * 两种打开方式：
 * - initial：无会话时的登录页（不可关闭）
 * - switch ：已登录状态下「登录其他账号 / 去注册」，带「返回」按钮；
 *            登录失败或点返回时原账号原封不动
 *
 * 本模块只负责收集凭据、调用认证接口，**不自己保存会话**：成功后把
 * (session, cloudUser) 交给 onAuthed，由 account.js 统一完成
 * 「保存旧账号改动 → 用新账号云端档案覆盖本地 → 写会话 → 刷新」，
 * 保证初次登录与切换账号走同一条路径，不会出现两套逻辑。
 */

import {
  register,
  login,
  createGuestSession,
  claimLegacy,
  getSession,
  getKnownAccounts,
  forgetAccount,
  accountKey,
} from './auth.js?v=20261026a';
import { apiRequest } from './sync.js?v=20261026a';

let onAuthed = null; // async (session, cloudUser) => boolean(是否已接手；false 表示被取消)
let onCancel = null; // () => void（switch 模式点返回）
let confirmFn = null; // (msg, opts) => Promise<boolean>
let mode = 'initial';
let bound = false;
let busy = false; // 任一认证请求进行中：防止重复点击 / 同时点登录和游客

export function initAuthUI(callbacks) {
  onAuthed = callbacks.onAuthed;
  onCancel = callbacks.onCancel || null;
  confirmFn = callbacks.confirm || null;
  if (!bound) {
    bindEvents();
    bound = true;
  }
}

/**
 * @param {{mode?: 'initial'|'switch', tab?: 'login'|'register', currentName?: string}} opts
 */
export function showAuth(opts = {}) {
  mode = opts.mode === 'switch' ? 'switch' : 'initial';
  const cancelBtn = $('auth-cancel-btn');
  if (cancelBtn) {
    cancelBtn.style.display = mode === 'switch' ? '' : 'none';
    cancelBtn.textContent = opts.currentName ? `← 返回「${opts.currentName}」` : '← 返回';
  }
  const sub = $('auth-sub');
  if (sub) {
    sub.textContent = mode === 'switch'
      ? '登录家人的账号，或注册一个新账号'
      : '点亮你去过的每一寸山河';
  }
  selectTab(opts.tab === 'register' ? 'register' : 'login');
  renderKnownAccounts();
  $('auth-overlay').style.display = 'flex';
  hideAuthError();
  // 有记住的账号时焦点给第一个账号，否则给用户名输入框
  const firstChip = document.querySelector('#auth-known-list .auth-known-pick');
  setTimeout(() => (firstChip || $('auth-login-username')).focus(), 30);
}

export function hideAuth() {
  $('auth-overlay').style.display = 'none';
  $('auth-login-password').value = '';
  $('auth-register-password').value = '';
  $('auth-register-password2').value = '';
}

function $(id) {
  return document.getElementById(id);
}

/** 把成功结果交给 account.js；它会刷新页面，返回 false 表示用户中途取消 */
async function handOff(session, user) {
  if (!onAuthed) return false;
  return onAuthed(session, user);
}

let selectedLegacyId = null;

async function handleLegacySearch() {
  const nickname = $('legacy-nickname').value.trim();
  const p1 = $('legacy-password').value.trim();
  const p2 = $('legacy-password2').value.trim();
  const errEl = $('legacy-error');
  errEl.style.display = 'none';

  if (!nickname) {
    errEl.textContent = '请输入原来的昵称';
    errEl.style.display = 'block';
    return;
  }
  if (!/^\d{4}$/.test(p1)) {
    errEl.textContent = '密码必须为 4 位数字';
    errEl.style.display = 'block';
    return;
  }
  if (p1 !== p2) {
    errEl.textContent = '两次输入的密码不一致';
    errEl.style.display = 'block';
    return;
  }

  const btn = $('legacy-search-btn');
  if (btn.disabled) return;
  // 如果已选中，直接领回
  if (selectedLegacyId) {
    btn.disabled = true;
    btn.textContent = '领回中…';
    try {
      const user = await claimLegacy(nickname, p1, selectedLegacyId);
      if (user) {
        const session = { type: 'user', username: user.username, nickname: user.nickname };
        $('legacy-overlay').style.display = 'none';
        const taken = await handOff(session, user);
        if (!taken) showAuth({ mode });
        return;
      }
    } catch (e) {
      errEl.textContent = '领回失败：' + (e.message || '请重试');
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '查找我的足迹';
    }
    return;
  }

  // 否则先查找
  btn.disabled = true;
  btn.textContent = '查找中…';
  try {
    const res = await apiRequest(`/api/auth/find-legacy?nickname=${encodeURIComponent(nickname)}`);
    const matches = (res && res.matches) || [];
    const box = $('legacy-matches');
    if (matches.length === 0) {
      box.innerHTML = '<p style="color:#8a9bb0;font-size:13px">没找到这个昵称的老数据，请检查昵称是否正确</p>';
    } else if (matches.length === 1) {
      selectedLegacyId = matches[0].userId;
      box.innerHTML = `<div class="legacy-match-item selected">
        <div>📍 ${esc(matches[0].nickname)}（${matches[0].provCount} 省 ${matches[0].cityCount} 市）</div>
        <div style="font-size:12px;color:#8a9bb0">已选中，点"领回"完成</div>
      </div>`;
      btn.textContent = '确认领回';
    } else {
      box.innerHTML = '<p style="color:#8a9bb0;font-size:13px">找到多个，请选择你是哪一个：</p>' +
        matches.map((m) => `
          <div class="legacy-match-item" data-uid="${esc(m.userId)}">
            📍 ${esc(m.nickname)}（${m.provCount} 省 ${m.cityCount} 市）
          </div>`).join('');
      box.querySelectorAll('.legacy-match-item').forEach((el) => {
        el.addEventListener('click', () => {
          box.querySelectorAll('.legacy-match-item').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          selectedLegacyId = el.dataset.uid;
          btn.textContent = '确认领回';
        });
      });
      btn.textContent = '查找我的足迹';
    }
  } catch (e) {
    errEl.textContent = '查找失败，请检查网络';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    if (!selectedLegacyId) btn.textContent = '查找我的足迹';
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showAuthError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideAuthError() {
  $('auth-error').style.display = 'none';
}

function selectTab(name) {
  document.querySelectorAll('.auth-tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const isLogin = name === 'login';
  $('auth-login-form').style.display = isLogin ? '' : 'none';
  $('auth-register-form').style.display = isLogin ? 'none' : '';
}

/* ---------- 本机曾登录账号（登录页快捷选择） ---------- */

function renderKnownAccounts() {
  const box = $('auth-known');
  const list = $('auth-known-list');
  if (!box || !list) return;
  const curKey = accountKey(getSession());
  // switch 模式下不显示当前账号（它就是「返回」按钮的目标）
  const accounts = getKnownAccounts().filter((a) => accountKey(a) !== curKey);
  if (accounts.length === 0) {
    box.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  box.style.display = '';
  list.innerHTML = accounts.map((a) => {
    const key = esc(accountKey(a));
    const isGuestAcc = a.type === 'guest';
    const initial = esc(Array.from(a.nickname || '?')[0]);
    const sub = isGuestAcc ? '游客 · 本机' : `@${esc(a.username)}`;
    const forgetLabel = isGuestAcc
      ? `删除游客档案「${esc(a.nickname)}」及其本机足迹`
      : `不再在本机显示「${esc(a.nickname)}」`;
    return `
      <div class="auth-known-item" data-account-key="${key}">
        <button type="button" class="auth-known-pick" data-account-key="${key}"
          aria-label="${isGuestAcc ? '继续使用' : '登录'}「${esc(a.nickname)}」">
          <span class="account-avatar${isGuestAcc ? ' guest' : ''}" aria-hidden="true">${isGuestAcc ? '👤' : initial}</span>
          <span class="auth-known-text">
            <span class="auth-known-name">${esc(a.nickname)}</span>
            <span class="auth-known-sub">${sub}</span>
          </span>
        </button>
        <button type="button" class="auth-known-forget" data-forget-key="${key}"
          aria-label="${forgetLabel}" title="${isGuestAcc ? '删除游客档案' : '从本机列表移除'}">×</button>
      </div>`;
  }).join('');
}

function findKnown(key) {
  return getKnownAccounts().find((a) => accountKey(a) === key) || null;
}

async function onKnownPick(key) {
  const acc = findKnown(key);
  if (!acc || busy) return;
  hideAuthError();
  if (acc.type === 'guest') {
    // 游客没有密码可验：直接恢复该游客档案（足迹从本机读）
    busy = true;
    try {
      const taken = await handOff({ type: 'guest', guestId: acc.guestId, nickname: acc.nickname }, null);
      if (!taken) busy = false;
    } catch {
      busy = false;
    }
    return;
  }
  // 注册账号：只帮忙填好用户名，密码必须本人输入
  selectTab('login');
  $('auth-login-username').value = acc.username;
  const pwd = $('auth-login-password');
  pwd.value = '';
  pwd.placeholder = `「${acc.nickname}」的 4 位密码`;
  pwd.focus();
}

async function onKnownForget(key) {
  const acc = findKnown(key);
  if (!acc) return;
  if (acc.type === 'guest') {
    const msg = `游客「${acc.nickname}」的足迹只保存在这台设备上，删除后无法找回。确定删除吗？`;
    const ok = confirmFn ? await confirmFn(msg, { confirmText: '删除', danger: true, above: true }) : false;
    if (!ok) return;
  }
  forgetAccount(acc);
  renderKnownAccounts();
}

/* ---------- 事件 ---------- */

async function runAuth(btn, idleText, busyText, fn) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  btn.textContent = busyText;
  let handedOff = false;
  try {
    const result = await fn();
    if (result) {
      handedOff = await handOff(result.session, result.user);
    }
  } catch (e) {
    showAuthError(e.message || '操作失败，请重试');
  } finally {
    // 交接成功会刷新页面；只有失败 / 被取消时才恢复按钮
    if (!handedOff) {
      busy = false;
      btn.disabled = false;
      btn.textContent = idleText;
    }
  }
}

function bindEvents() {
  // Tab 切换
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      selectTab(tab.dataset.tab);
      hideAuthError();
    });
  });

  // 登录
  $('auth-login-btn').addEventListener('click', () => {
    const username = $('auth-login-username').value.trim();
    const password = $('auth-login-password').value.trim();
    if (!username || !password) {
      showAuthError('请输入用户名和密码');
      return;
    }
    if (!/^\d{4}$/.test(password)) {
      showAuthError('密码是 4 位数字');
      return;
    }
    runAuth($('auth-login-btn'), '登录', '登录中…', async () => {
      const user = await login(username, password);
      if (!user) {
        showAuthError('用户名或密码错误');
        return null;
      }
      return { session: { type: 'user', username: user.username, nickname: user.nickname }, user };
    });
  });

  // 注册
  $('auth-register-btn').addEventListener('click', () => {
    const username = $('auth-register-username').value.trim();
    const nickname = $('auth-register-nickname').value.trim() || username;
    const p1 = $('auth-register-password').value.trim();
    const p2 = $('auth-register-password2').value.trim();
    if (!username) {
      showAuthError('请输入用户名');
      return;
    }
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,12}$/.test(username)) {
      showAuthError('用户名需为 2-12 个字符（中文/字母/数字/下划线）');
      return;
    }
    if (!/^\d{4}$/.test(p1)) {
      showAuthError('密码必须为 4 位数字');
      return;
    }
    if (p1 !== p2) {
      showAuthError('两次输入的密码不一致');
      return;
    }
    runAuth($('auth-register-btn'), '注册', '注册中…', async () => {
      const user = await register(username, p1, nickname);
      if (!user) {
        showAuthError('注册失败，请重试');
        return null;
      }
      return { session: { type: 'user', username: user.username, nickname: user.nickname }, user };
    });
  });

  // 游客：每次都新建一个空白游客，绝不复用上一个游客的足迹（避免下一个人看到上一个人的数据）；
  // 想回到之前的游客档案，从上方「这台设备上的账号」里点它
  $('auth-guest-btn').addEventListener('click', () => {
    runAuth($('auth-guest-btn'), $('auth-guest-btn').textContent, '进入中…', async () => (
      { session: createGuestSession(), user: null }
    ));
  });

  // switch 模式：返回原账号
  const cancelBtn = $('auth-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (busy) return;
      hideAuth();
      if (onCancel) onCancel();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'switch' && !busy && $('auth-overlay').style.display !== 'none') {
      hideAuth();
      if (onCancel) onCancel();
    }
  });

  // 本机账号列表（事件委托）
  const knownList = $('auth-known-list');
  if (knownList) {
    knownList.addEventListener('click', (e) => {
      const forget = e.target.closest('[data-forget-key]');
      if (forget) {
        onKnownForget(forget.dataset.forgetKey);
        return;
      }
      const pick = e.target.closest('.auth-known-pick');
      if (pick) onKnownPick(pick.dataset.accountKey);
    });
  }

  // 老用户领回
  $('auth-legacy-btn').addEventListener('click', () => {
    hideAuth();
    $('legacy-overlay').style.display = 'flex';
  });
  $('legacy-back-btn').addEventListener('click', () => {
    $('legacy-overlay').style.display = 'none';
    showAuth({ mode });
  });
  $('legacy-search-btn').addEventListener('click', handleLegacySearch);

  // 回车：用户名 → 密码 → 登录；注册确认密码回车即注册
  $('auth-login-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-login-password').focus();
  });
  $('auth-login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-login-btn').click();
  });
  $('auth-register-password2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-register-btn').click();
  });
}
