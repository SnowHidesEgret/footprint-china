/**
 * 点亮中国 · v2 登录页 UI 逻辑
 */

import { register, login, guestLogin, saveSession, isValidUsername } from './auth.js';

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

  // 回车登录
  $('auth-login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('auth-login-btn').click();
  });
}
