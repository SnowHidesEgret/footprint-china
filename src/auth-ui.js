/**
 * 点亮中国 · v2 登录页 UI 逻辑
 */

import { register, login, guestLogin, saveSession, claimLegacy } from './auth.js';
import { apiRequest } from './sync.js';

let onAuthed = null; // (session) => void

export function initAuthUI(callbacks) {
  onAuthed = callbacks.onAuthed;
  bindEvents();
}

export function showAuth() {
  $('auth-overlay').style.display = 'flex';
  hideAuthError();
}

export function hideAuth() {
  $('auth-overlay').style.display = 'none';
}

function $(id) {
  return document.getElementById(id);
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
  // 如果已选中，直接领回
  if (selectedLegacyId) {
    btn.disabled = true;
    btn.textContent = '领回中…';
    try {
      const user = await claimLegacy(nickname, p1, selectedLegacyId);
      if (user) {
        const session = { type: 'user', username: user.username, nickname: user.nickname };
        saveSession(session);
        $('legacy-overlay').style.display = 'none';
        if (onAuthed) onAuthed(session, user);
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

function bindEvents() {
  // Tab 切换
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      $('auth-login-form').style.display = isLogin ? '' : 'none';
      $('auth-register-form').style.display = isLogin ? 'none' : '';
      hideAuthError();
    });
  });

  // 登录
  $('auth-login-btn').addEventListener('click', async () => {
    const username = $('auth-login-username').value.trim();
    const password = $('auth-login-password').value.trim();
    if (!username || !password) {
      showAuthError('请输入用户名和密码');
      return;
    }
    const btn = $('auth-login-btn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const user = await login(username, password);
      if (user) {
        const session = { type: 'user', username: user.username, nickname: user.nickname };
        saveSession(session);
        hideAuth();
        if (onAuthed) onAuthed(session, user);
      } else {
        showAuthError('用户名或密码错误');
      }
    } catch (e) {
      showAuthError('登录失败，请检查网络');
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  // 注册
  $('auth-register-btn').addEventListener('click', async () => {
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
    const btn = $('auth-register-btn');
    btn.disabled = true;
    btn.textContent = '注册中…';
    try {
      const user = await register(username, p1, nickname);
      if (user) {
        const session = { type: 'user', username: user.username, nickname: user.nickname };
        saveSession(session);
        hideAuth();
        if (onAuthed) onAuthed(session, user);
      } else {
        showAuthError('注册失败，请重试');
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('已被注册')) showAuthError('用户名已被注册，换一个试试');
      else showAuthError('注册失败，请检查网络');
    } finally {
      btn.disabled = false;
      btn.textContent = '注册';
    }
  });

  // 游客
  $('auth-guest-btn').addEventListener('click', () => {
    const session = guestLogin();
    hideAuth();
    if (onAuthed) onAuthed(session, null);
  });

  // 老用户领回
  $('auth-legacy-btn').addEventListener('click', () => {
    hideAuth();
    $('legacy-overlay').style.display = 'flex';
  });
  $('legacy-back-btn').addEventListener('click', () => {
    $('legacy-overlay').style.display = 'none';
    showAuth();
  });
  $('legacy-search-btn').addEventListener('click', handleLegacySearch);

  // 回车登录
  $('auth-login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-login-btn').click();
  });
}
