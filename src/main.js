/**
 * 点亮中国 · 入口：组装地图 / 状态 / 视听反馈与交互
 * 包含 Phase 2（音效/粒子/成就/城市下钻/称号/主题）与 Phase 3（多用户云同步/PK透视对战）
 */
import { TOTAL_PROVINCES, MAX_MEMBERS, MEMBER_COLORS } from './config.js?v=20261005a';
import { loadGeo, loadCityGeo, isCityGeoLoaded, getLoadedCityGeo } from './geo.js?v=20261005a';
import { store } from './store.js?v=20261005a';
import { buildMainMap, buildInset, applyThemeVars } from './map.js?v=20261005a';
import { ensureCtx, setEnabled as setAudioEnabled, playLight, playUnlight, playAchievement } from './audio.js?v=20261005a';
import { initParticles, burst as burstParticles, confetti as confettiParticles, setParticlesTheme, resizeParticles } from './particles.js?v=20261005a';
import {
  TITLES,
  ACHIEVEMENTS,
  getTitleByCount,
  initProvinceAdcodes,
  getAdcode,
  checkAchievements,
} from './achievements.js?v=20261005a';
import {
  initSync,
  createRoom,
  joinRoom,
  fetchRoom,
  deleteMember as deleteRemoteMember,
  subscribeSyncStatus,
} from './sync.js?v=20261005a';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

let mapApi = null;
let provinces = [];
let islandsFeature = null;
let pendingUnlight = null; // { adcode, name, isCity, feature }
let currentTheme = store.state.theme;

// 成就解锁队列状态
const unlockQueue = [];
let isShowingUnlockModal = false;
let unlockTriggerEl = null;

// 成就墙焦点记忆
let galleryPrevFocus = null;
let familyPrevFocus = null;
let pkPrevFocus = null;

// 下钻层级状态
let currentDrill = null; // { feature, cities, adcode, name }
let lastProvinceClick = { time: 0, adcode: '' };
const firedCityThresholds = new Set();

// 连击状态与阈值触发记录（会话级）
let lastLightAt = 0;
let combo = 0;
let comboTimer = null;
const firedThresholds = new Set();
const THRESHOLDS = [0.1, 0.25, 0.5, 0.75, 1.0];

// 成就判定辅助器
const achievementHelper = {
  isLit: (shortName) => {
    const code = getAdcode(shortName);
    return code ? store.isLit(code) : false;
  },
  isCityGeoLoaded,
  getCityGeo: getLoadedCityGeo,
  getAdcode,
};

/* ---------- 星尘背景（一次性绘制，零运行时开销） ---------- */
function drawStars() {
  const cv = $('stars');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const dark = store.state.theme === 'dark';
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * innerWidth;
    const y = Math.random() * innerHeight * 0.75;
    const r = Math.random() * 1.1 + 0.2;
    const a = dark ? Math.random() * 0.5 + 0.08 : Math.random() * 0.18 + 0.04;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = dark ? `rgba(200,220,255,${a})` : `rgba(150,110,70,${a})`;
    ctx.fill();
  }
}

/* ---------- 称号徽章与进度胶囊 ---------- */
function renderTitleBadge() {
  const currentTitle = getTitleByCount(store.litCount());
  const titleEl = $('current-title');
  if (!titleEl) return;
  if (currentTitle) {
    titleEl.textContent = currentTitle.name;
    titleEl.style.display = 'inline-flex';
  } else {
    titleEl.textContent = '';
    titleEl.style.display = 'none';
  }
}

function renderProgress(animate = true) {
  const n = Math.min(Math.max(store.litCount(), 0), TOTAL_PROVINCES);
  const pct = Math.min(Math.max((n / TOTAL_PROVINCES) * 100, 0), 100);
  $('lit-num').textContent = n;
  $('lit-pct').textContent = pct.toFixed(1).replace(/\.0$/, '') + '%';
  const bar = $('lit-bar');
  if (!animate) bar.style.transition = 'none';
  bar.style.width = pct + '%';
  if (!animate) requestAnimationFrame(() => (bar.style.transition = ''));
  renderTitleBadge();
}

/* 数字滚动小动画（点亮时的满足感） */
function popNumber() {
  const el = $('lit-num');
  el.style.transform = 'scale(1.35)';
  el.style.transition = 'transform .18s cubic-bezier(0.16, 1, 0.3, 1)';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transform = 'scale(1)';
    })
  );
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(html) {
  const t = $('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------- 通用确认弹窗（替代原生 confirm：原生弹窗在部分浏览器/自动化环境会被拦截导致无响应） ---------- */
let confirmResolve = null;
function closeConfirm(val) {
  const bd = document.getElementById('confirm-backdrop');
  if (bd) {
    bd.classList.remove('show');
    bd.setAttribute('inert', '');
    bd.setAttribute('aria-hidden', 'true');
  }
  if (confirmResolve) {
    confirmResolve(val);
    confirmResolve = null;
  }
}
function confirmDialog(message, { confirmText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let bd = document.getElementById('confirm-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'confirm-backdrop';
      bd.className = 'modal-backdrop';
      bd.style.zIndex = '90';
      bd.setAttribute('inert', '');
      bd.setAttribute('aria-hidden', 'true');
      bd.innerHTML = `
        <div class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
          <p id="confirm-msg" class="confirm-msg"></p>
          <div class="confirm-actions">
            <button type="button" class="btn-subtle" id="confirm-cancel-btn">取消</button>
            <button type="button" class="btn-primary" id="confirm-ok-btn">确定</button>
          </div>
        </div>`;
      document.body.appendChild(bd);
      bd.querySelector('#confirm-cancel-btn').addEventListener('click', () => closeConfirm(false));
      bd.querySelector('#confirm-ok-btn').addEventListener('click', () => closeConfirm(true));
      bd.addEventListener('click', (e) => {
        if (e.target === bd) closeConfirm(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && confirmResolve) closeConfirm(false);
      });
    }
    confirmResolve = resolve;
    bd.querySelector('#confirm-msg').textContent = message;
    const okBtn = bd.querySelector('#confirm-ok-btn');
    okBtn.textContent = confirmText;
    okBtn.classList.toggle('danger', danger);
    bd.removeAttribute('inert');
    bd.setAttribute('aria-hidden', 'false');
    bd.classList.add('show');
  });
}

/* ---------- tooltip / popover ---------- */
const tooltip = $('tooltip');
function showTooltip(name, lit, x, y, isProvince = true, customStatusText = '', customSubText = '') {
  $('tooltip-name').textContent = name;
  $('tooltip-st').textContent = customStatusText || (lit ? '已点亮' : '未点亮');
  const subEl = $('tooltip-sub');
  if (subEl) {
    if (customSubText) {
      subEl.textContent = ' · ' + customSubText;
      subEl.style.display = '';
    } else if (isProvince && !isTouch && !store.isPkMode()) {
      subEl.textContent = ' · 双击探索城市';
      subEl.style.display = '';
    } else {
      subEl.style.display = 'none';
    }
  }
  tooltip.classList.toggle('lit', lit);
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
  tooltip.classList.add('show');
}
function hideTooltip() {
  tooltip.classList.remove('show');
}

const popover = $('popover');
let lastFocusedEl = null;

function showPopover(name, x, y, isCity = false, feature = null) {
  lastFocusedEl = document.activeElement;
  $('popover-name').textContent = name;
  const drillBtn = $('popover-drill');
  if (drillBtn) {
    drillBtn.style.display = isCity ? 'none' : '';
  }
  const popoverWidth = popover.offsetWidth || 180;
  const pad = Math.floor(popoverWidth / 2) + 12;
  const clampedX = Math.min(Math.max(x, pad), window.innerWidth - pad);
  const clampedY = Math.min(Math.max(y, 110), window.innerHeight - 80);
  popover.style.left = clampedX + 'px';
  popover.style.top = clampedY + 'px';
  popover.classList.add('show');
  const cancelBtn = $('popover-cancel');
  if (cancelBtn) cancelBtn.focus();
}
function hidePopover() {
  popover.classList.remove('show');
  pendingUnlight = null;
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    try {
      lastFocusedEl.focus();
    } catch {}
    lastFocusedEl = null;
  }
}

/* ---------- 面包屑与下钻视图 ---------- */
function updateBreadcrumb() {
  if (!currentDrill) return;
  const litCount = currentDrill.cities.filter((c) => store.isCityLit(c.properties.adcode)).length;
  const totalCount = currentDrill.cities.length;
  $('bc-current').innerHTML = `${currentDrill.name}<span class="bc-count">（已亮 <b>${litCount}</b>/${totalCount}）</span>`;
}

async function startDrillDown(provinceFeature) {
  if (!provinceFeature || !provinceFeature.properties) return;
  const adcode = String(provinceFeature.properties.adcode);
  const name = provinceFeature.properties.name;
  if (currentDrill && currentDrill.adcode === adcode) return;

  hidePopover();
  hideTooltip();

  let cities;
  try {
    cities = await loadCityGeo(adcode);
  } catch (err) {
    console.error(err);
    toast('城市数据加载失败，请重试');
    return;
  }
  if (!Array.isArray(cities) || cities.length === 0) {
    console.error('城市数据为空:', adcode);
    toast('城市数据加载失败，请重试');
    return;
  }

  try {
    currentDrill = { feature: provinceFeature, cities, adcode, name };
    mapApi.drillDown(provinceFeature, cities, (c) => store.isCityLit(c));
    updateBreadcrumb();
    $('breadcrumb').classList.add('show');
    $('inset-wrap').classList.add('hide');
  } catch (err) {
    console.error(err);
    currentDrill = null;
    $('breadcrumb').classList.remove('show');
    $('inset-wrap').classList.remove('hide');
    try {
      mapApi.returnToNational(adcode);
    } catch {}
    toast('城市数据加载失败，请重试');
  }
}

function returnToNational() {
  if (!currentDrill) return;
  const prevAdcode = currentDrill.adcode;
  currentDrill = null;
  hidePopover();
  hideTooltip();
  $('breadcrumb').classList.remove('show');
  $('inset-wrap').classList.remove('hide');
  mapApi.returnToNational(prevAdcode);
}

/* ---------- 共享视听动效管线（连击、音效、粒子） ---------- */
function triggerComboAndLightEffects(clientX, clientY, svgX, svgY, name) {
  const now = Date.now();
  if (now - lastLightAt <= 3000) {
    combo++;
  } else {
    combo = 1;
  }
  lastLightAt = now;

  if (combo >= 2) {
    const comboEl = $('combo');
    $('combo-text').textContent = `Combo x${combo}!`;
    comboEl.classList.remove('show');
    void comboEl.offsetWidth;
    comboEl.classList.add('show');
  }
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => {
    const comboEl = $('combo');
    if (comboEl) comboEl.classList.remove('show');
    combo = 0;
  }, 3000);

  playLight(combo >= 2 ? combo - 1 : 0);
  burstParticles(clientX, clientY, store.state.theme);
  mapApi.burst(svgX, svgY);
  if (!currentDrill) {
    popNumber();
  }
  if (isTouch) toast(`✦ 已点亮 <b>${name}</b>`);
}

/* ---------- 地图交互与视听反馈 ---------- */
function onTap(f, svgX, svgY, clientX, clientY) {
  const adcode = String(f.properties.adcode);
  const name = f.properties.name;
  hideTooltip();

  const now = Date.now();
  if (now - lastProvinceClick.time <= 300 && lastProvinceClick.adcode === adcode) {
    lastProvinceClick = { time: 0, adcode: '' };
    hidePopover();
    startDrillDown(f);
    return;
  }
  lastProvinceClick = { time: now, adcode };

  if (store.isLit(adcode)) {
    pendingUnlight = { adcode, name, isCity: false, feature: f };
    showPopover(name, clientX, clientY, false, f);
  } else {
    hidePopover();
    const litBefore = store.litCount();
    const pctBefore = litBefore / TOTAL_PROVINCES;
    const titleBefore = getTitleByCount(litBefore);
    const titleBeforeLevel = titleBefore ? titleBefore.level : 0;

    const litSuccess = store.light(adcode, name);
    if (!litSuccess) return;

    triggerComboAndLightEffects(clientX, clientY, svgX, svgY, name);
    mapApi.update(
      (c) => store.isLit(c),
      (c) => store.isCityLit(c),
      store.isPkMode() ? store.getPkStats() : null
    );

    const newAch = handleAchievementChecks();
    const unlockSoundPlayed = newAch.length > 0;

    const litAfter = store.litCount();
    const pctAfter = litAfter / TOTAL_PROVINCES;
    const titleAfter = getTitleByCount(litAfter);
    const titleAfterLevel = titleAfter ? titleAfter.level : 0;
    if (titleAfterLevel > titleBeforeLevel && titleAfter) {
      store.bumpMaxTitleLevel(titleAfterLevel);
      toast(`🎉 荣膺称号：<b>${titleAfter.name}</b>`);
      if (!unlockSoundPlayed) playAchievement();
    }

    for (const t of THRESHOLDS) {
      if (pctBefore < t && pctAfter >= t && !firedThresholds.has(t)) {
        firedThresholds.add(t);
        confettiParticles(store.state.theme);
        if (!unlockSoundPlayed) playAchievement();
        toast('点亮进度 ' + Math.round(t * 100) + '%！');
      }
    }
  }
}

function onProvinceDblClick(f) {
  hidePopover();
  lastProvinceClick = { time: 0, adcode: '' };
  startDrillDown(f);
}

function onCityTap(cf, svgX, svgY, clientX, clientY) {
  const cadcode = String(cf.properties.adcode);
  const cname = cf.properties.name;
  hideTooltip();

  if (store.isCityLit(cadcode)) {
    pendingUnlight = { adcode: cadcode, name: cname, isCity: true, feature: cf };
    showPopover(cname, clientX, clientY, true, cf);
  } else {
    hidePopover();
    const currentCities = currentDrill ? currentDrill.cities : [];
    const totalCities = currentCities.length || 1;
    const litBefore = currentCities.filter((c) => store.isCityLit(c.properties.adcode)).length;
    const pctBefore = litBefore / totalCities;

    const success = store.lightCity(cadcode);
    if (!success) return;

    triggerComboAndLightEffects(clientX, clientY, svgX, svgY, cname);
    mapApi.updateCity(cadcode, true);
    updateBreadcrumb();

    const litAfter = litBefore + 1;
    const pctAfter = litAfter / totalCities;
    for (const t of THRESHOLDS) {
      const key = `${currentDrill?.adcode}_${t}`;
      if (pctBefore < t && pctAfter >= t && !firedCityThresholds.has(key)) {
        firedCityThresholds.add(key);
        confettiParticles(store.state.theme);
        playAchievement();
        toast(`${currentDrill?.name || ''}点亮进度 ${Math.round(t * 100)}%！`);
      }
    }

    handleAchievementChecks();
  }
}

/* ---------- 成就解锁弹窗队列 ---------- */
function queueAchievementUnlock(ach) {
  if (!unlockTriggerEl) {
    unlockTriggerEl = document.activeElement;
  }
  unlockQueue.push(ach);
  if (!isShowingUnlockModal) {
    showNextUnlockModal();
  }
}

function showNextUnlockModal() {
  if (unlockQueue.length === 0) {
    isShowingUnlockModal = false;
    if (unlockTriggerEl && typeof unlockTriggerEl.focus === 'function') {
      try {
        unlockTriggerEl.focus();
      } catch {}
      unlockTriggerEl = null;
    }
    return;
  }

  isShowingUnlockModal = true;
  const ach = unlockQueue.shift();

  playAchievement();
  confettiParticles(store.state.theme);

  $('unlock-icon').textContent = ach.icon;
  $('unlock-title').textContent = ach.name;
  $('unlock-copy').textContent = ach.copy;

  const modal = $('unlock-modal');
  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('show');

  const okBtn = $('unlock-ok');
  if (okBtn) okBtn.focus();
}

function closeUnlockModal() {
  const modal = $('unlock-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.style.display = 'none';
    showNextUnlockModal();
  }, 220);
}

/* ---------- 成就陈列室浮层 ---------- */
function renderGallery() {
  const litCount = store.litCount();
  const currentTitle = getTitleByCount(litCount);
  const maxTitle = TITLES.find((t) => t.level === store.getMaxTitleLevel()) || null;
  const unlockedCount = store.state.unlockedAchievements.length;

  $('gallery-stats').innerHTML = `已解锁 <b>${unlockedCount}</b> / 12 个成就 · 当前称号：<b>${currentTitle ? currentTitle.name : '尚未启程'}</b>${maxTitle && (!currentTitle || maxTitle.level > currentTitle.level) ? ` · 历史最高：<b>${maxTitle.name}</b>` : ''}`;

  const titleListEl = $('gallery-title-list');
  titleListEl.innerHTML = '';
  for (const t of TITLES) {
    const isUnlocked = litCount >= t.min;
    const isCurrent = currentTitle && currentTitle.level === t.level;

    const card = document.createElement('div');
    card.className = `title-card ${isUnlocked ? 'unlocked' : 'locked'}`;
    card.innerHTML = `
      <div class="tc-head">
        <span class="tc-lvl">Lv.${t.level}</span>
        ${isCurrent ? '<span class="tc-tag">当前称号</span>' : (isUnlocked ? '<span class="tc-tag" style="background:transparent;color:var(--lit-stroke);border:1px solid var(--lit-stroke)">已达成</span>' : '')}
      </div>
      <div class="tc-name">${t.name}</div>
      <div class="tc-desc">${isUnlocked ? t.desc : `需点亮 ${t.min} 个省份（当前 ${litCount}/${t.min}）`}</div>
    `;
    titleListEl.appendChild(card);
  }

  const achieveGridEl = $('gallery-achieve-list');
  achieveGridEl.innerHTML = '';
  for (const ach of ACHIEVEMENTS) {
    const isUnlocked = store.isAchievementUnlocked(ach.id);
    const card = document.createElement('div');
    card.className = `achieve-card ${isUnlocked ? 'unlocked' : 'locked'}`;
    card.innerHTML = `
      <div class="ac-icon">${ach.icon}</div>
      <div class="ac-main">
        <div class="ac-head">
          <span class="ac-name">${ach.name}</span>
          <span class="ac-status">${isUnlocked ? '已达成' : '未解锁'}</span>
        </div>
        <div class="ac-cond">解锁条件：${ach.conditionText}</div>
        ${isUnlocked ? `<div class="ac-copy">“${ach.copy}”</div>` : ''}
      </div>
    `;
    achieveGridEl.appendChild(card);
  }
}

function openGallery() {
  galleryPrevFocus = document.activeElement;
  renderGallery();
  const modal = $('gallery-modal');
  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('show');
  const closeBtn = $('gallery-close');
  if (closeBtn) closeBtn.focus();
}

function closeGallery() {
  const modal = $('gallery-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.style.display = 'none';
    if (galleryPrevFocus && typeof galleryPrevFocus.focus === 'function') {
      try {
        galleryPrevFocus.focus();
      } catch {}
      galleryPrevFocus = null;
    }
  }, 220);
}

function handleAchievementChecks() {
  const newlyUnlocked = checkAchievements(store, achievementHelper);
  for (const ach of newlyUnlocked) {
    queueAchievementUnlock(ach);
  }
  if ($('gallery-modal').classList.contains('show')) {
    renderGallery();
  }
  return newlyUnlocked;
}

/* ---------- Phase 3: 顶部胶囊与 PK 开关渲染 ---------- */
function renderMemberButton() {
  const member = store.getCurrentMember();
  const roomCode = store.getRoomCode();

  if (member) {
    $('member-btn-name').textContent = member.name;
    $('member-btn-dot').style.background = member.color;
    $('member-btn-dot').style.boxShadow = `0 0 8px ${member.color}`;
  }

  const roomBadge = $('member-btn-room');
  if (roomCode) {
    roomBadge.textContent = roomCode;
    roomBadge.style.display = 'inline-block';
  } else {
    roomBadge.style.display = 'none';
  }
}

function renderPkToggle() {
  const isPk = store.isPkMode();
  const btn = $('pk-btn');
  const panelBtn = $('pk-panel-btn');
  const hintEl = $('main-hint');

  btn.classList.toggle('active', isPk);
  btn.setAttribute('aria-pressed', isPk ? 'true' : 'false');
  if (panelBtn) {
    panelBtn.style.display = isPk ? 'inline-flex' : 'none';
  }

  if (hintEl) {
    if (isPk) {
      hintEl.textContent = '⚔️ PK 透视开启：单人独占显示成员色，多人同游金紫交辉高亮';
    } else {
      hintEl.textContent = '点选省份 · 镌刻足迹  ·  再次点击已点亮的省份可熄灭（需确认）';
    }
  }
}

/* ---------- Phase 3: 家庭成员与房间管理浮层 ---------- */
function renderFamilyModal() {
  const roomCode = store.getRoomCode();
  const members = store.getMembers();
  const currentMemberId = store.getCurrentMemberId();

  // 1. 渲染房间区域
  const roomSection = $('room-section');
  if (!roomCode) {
    roomSection.innerHTML = `
      <div class="room-offline-box">
        <p class="room-desc">当前为本机离线模式。可创建房间生成 6 位房间码，或输入房间码加入家人房间进行足迹云同步。</p>
        <div class="room-actions">
          <button class="btn-primary" id="btn-create-room" type="button">✨ 创建家庭房间</button>
          <div class="room-join-row">
            <input type="text" id="join-room-code-input" class="room-code-input" maxlength="6" placeholder="6位房间码">
            <button class="btn-subtle" id="btn-join-room" type="button">加入房间</button>
          </div>
        </div>
        <p class="room-notice">⚠️ 注：知道房间码的人都能读写家庭足迹数据，请在可信家人间共享。</p>
      </div>
    `;

    $('btn-create-room').addEventListener('click', async () => {
      const curMember = store.getCurrentMember();
      const res = await createRoom(curMember.name);
      if (res && res.code) {
        store.setRoomCode(res.code);
        toast(`🎉 家庭房间创建成功！房间码：<b>${res.code}</b>`);
        renderFamilyModal();
      } else {
        toast('房间创建失败，已保持本机模式');
      }
    });

    $('btn-join-room').addEventListener('click', async () => {
      const input = $('join-room-code-input');
      const code = (input.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        toast('请输入 6 位数字房间码');
        return;
      }
      const curMember = store.getCurrentMember();
      const res = await joinRoom(code, curMember.name);
      if (res && res.memberId) {
        store.setRoomCode(code);
        if (Array.isArray(res.members)) {
          store.mergeRemoteMembers(res.members);
        }
        toast(`🤝 已加入家庭房间 <b>${code}</b>`);
        renderFamilyModal();
      } else {
        toast('加入房间失败，请核对房间码');
      }
    });
  } else {
    roomSection.innerHTML = `
      <div class="room-online-box">
        <div class="room-code-display">
          <span class="room-code-label">家庭房间码：</span>
          <span class="room-code-val">${roomCode}</span>
          <button class="btn-subtle" id="btn-copy-room-code" type="button">复制</button>
        </div>
        <div class="room-actions">
          <button class="btn-subtle" id="btn-sync-now" type="button">🔄 立即拉取全家数据</button>
          <button class="btn-danger-sm" id="btn-leave-room" type="button">退出房间</button>
        </div>
        <p class="room-notice">⚠️ 注：知道房间码的人都能读写家庭足迹数据。</p>
      </div>
    `;

    $('btn-copy-room-code').addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(roomCode);
        toast('已复制房间码');
      } else {
        toast(`房间码：${roomCode}`);
      }
    });

    $('btn-sync-now').addEventListener('click', async () => {
      toast('正在拉取全家数据…');
      const res = await fetchRoom(roomCode);
      if (res && Array.isArray(res.members)) {
        store.mergeRemoteMembers(res.members);
        toast('全家数据同步完成！');
      } else {
        toast('同步失败，请检查网络');
      }
    });

    $('btn-leave-room').addEventListener('click', async () => {
      const ok = await confirmDialog('确定要退出当前家庭房间吗？退出后将转为纯本机模式。');
      if (ok) {
        store.setRoomCode(null);
        toast('已退出房间，转为本机模式');
        renderFamilyModal();
      }
    });
  }

  // 2. 渲染成员列表
  const memberListEl = $('family-member-list');
  memberListEl.innerHTML = '';

  for (const m of members) {
    const isCurrent = m.id === currentMemberId;
    const litCount = Object.keys(m.footprint?.provinces || {}).length;

    const card = document.createElement('div');
    card.className = `member-card ${isCurrent ? 'active' : ''}`;
    card.style.setProperty('--card-color', m.color);

    card.innerHTML = `
      <div class="member-card-left">
        <span class="member-card-dot" style="background:${m.color};color:${m.color}"></span>
        <div class="member-card-info">
          <span class="member-card-name">
            ${m.name}
            ${isCurrent ? '<span class="member-card-tag">当前操作人</span>' : ''}
          </span>
          <span class="member-card-stats">已点亮 ${litCount} / 34 省份</span>
        </div>
      </div>
      <div class="member-card-right">
        ${!isCurrent ? `<button class="btn-subtle btn-switch-member" data-id="${m.id}" type="button">切换</button>` : ''}
        ${members.length > 1 ? `<button class="btn-danger-sm btn-del-member" data-id="${m.id}" data-name="${m.name}" type="button" title="删除成员">&times;</button>` : ''}
      </div>
    `;
    memberListEl.appendChild(card);
  }

  // 绑定切换成员
  memberListEl.querySelectorAll('.btn-switch-member').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      store.setCurrentMember(id);
      renderFamilyModal();
      toast(`已切换为 <b>${store.getCurrentMember().name}</b>`);
    });
  });

  // 绑定删除成员
  memberListEl.querySelectorAll('.btn-del-member').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      const ok = await confirmDialog(`确定删除家庭成员【${name}】的足迹档案吗？此操作不可逆。`, { confirmText: '删除', danger: true });
      if (ok) {
        if (roomCode) {
          deleteRemoteMember(roomCode, id);
        }
        store.removeMember(id);
        renderFamilyModal();
        toast(`已删除成员【${name}】`);
      }
    });
  });

  // 成员上限控制
  const addToggleBtn = $('add-member-toggle-btn');
  const addForm = $('add-member-form');
  if (members.length >= MAX_MEMBERS) {
    addToggleBtn.disabled = true;
    addToggleBtn.textContent = '已达4人上限';
    addForm.style.display = 'none';
  } else {
    addToggleBtn.disabled = false;
    addToggleBtn.textContent = '+ 添加成员';
  }
}

function openFamilyModal() {
  familyPrevFocus = document.activeElement;
  renderFamilyModal();
  const modal = $('family-modal');
  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('show');
  const closeBtn = $('family-close');
  if (closeBtn) closeBtn.focus();
}

function closeFamilyModal() {
  const modal = $('family-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.style.display = 'none';
    if (familyPrevFocus && typeof familyPrevFocus.focus === 'function') {
      try { familyPrevFocus.focus(); } catch {}
      familyPrevFocus = null;
    }
  }, 220);
}

// 添加成员交互
/* ---------- Phase 3: 新建成员配色选择（鎏金/青瓷/朱砂/黛蓝） ---------- */
let selectedNewMemberColor = '';
function renderNewMemberColorRow() {
  const row = $('new-member-color-row');
  if (!row) return;
  const usedColors = new Set(store.getMembers().map((m) => m.color));
  const defaultColor = (MEMBER_COLORS.find((c) => !usedColors.has(c.value)) || MEMBER_COLORS[0]).value;
  if (!selectedNewMemberColor || usedColors.has(selectedNewMemberColor)) {
    selectedNewMemberColor = defaultColor;
  }
  row.innerHTML = '';
  for (const c of MEMBER_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-swatch' + (c.value === selectedNewMemberColor ? ' selected' : '');
    b.style.background = c.value;
    b.title = c.name;
    b.setAttribute('aria-label', `配色${c.name}`);
    b.setAttribute('aria-pressed', c.value === selectedNewMemberColor ? 'true' : 'false');
    b.addEventListener('click', () => {
      selectedNewMemberColor = c.value;
      renderNewMemberColorRow();
    });
    row.appendChild(b);
  }
}

$('add-member-toggle-btn').addEventListener('click', () => {
  const form = $('add-member-form');
  const isHidden = form.style.display === 'none';
  form.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) {
    renderNewMemberColorRow();
    $('new-member-name-input').focus();
  }
});

$('cancel-add-member-btn').addEventListener('click', () => {
  $('add-member-form').style.display = 'none';
  $('new-member-name-input').value = '';
});

$('confirm-add-member-btn').addEventListener('click', () => {
  const input = $('new-member-name-input');
  const name = (input.value || '').trim();
  if (!name) {
    toast('请输入成员称呼');
    return;
  }
  const newMember = store.addMember(name, selectedNewMemberColor);
  if (newMember) {
    input.value = '';
    selectedNewMemberColor = '';
    $('add-member-form').style.display = 'none';
    renderFamilyModal();
    toast(`已添加家庭成员 <b>${newMember.name}</b>`);
  } else {
    toast('家庭成员已满 4 人');
  }
});

/* ---------- Phase 3: PK 对战透视面板 ---------- */
function renderPkModal() {
  const pkStats = store.getPkStats();

  $('pk-family-count').textContent = `${pkStats.totalFamilyCount} 省`;
  $('pk-total-lit').textContent = `${pkStats.totalLitCount} / 34 (${Math.round((pkStats.totalLitCount / 34) * 100)}%)`;

  // 1. 横条对比
  const barsEl = $('pk-member-bars');
  barsEl.innerHTML = '';
  for (const m of pkStats.members) {
    const pct = Math.round((m.litCount / TOTAL_PROVINCES) * 100);
    const row = document.createElement('div');
    row.className = 'pk-bar-row';
    row.innerHTML = `
      <div class="pk-bar-name">
        <span class="member-dot" style="background:${m.color};color:${m.color}"></span>
        <span>${m.name}</span>
      </div>
      <div class="pk-bar-track">
        <div class="pk-bar-fill" style="width:${pct}%;background:${m.color}"></div>
      </div>
      <div class="pk-bar-num">${m.litCount} 省 (${pct}%)</div>
      <div class="pk-bar-solo">独占 ${m.soloProvinces.length} 省</div>
    `;
    barsEl.appendChild(row);
  }

  // 2. 独占省份网格
  const soloGridEl = $('pk-solo-grid');
  soloGridEl.innerHTML = '';
  for (const m of pkStats.members) {
    const box = document.createElement('div');
    box.className = 'pk-solo-box';
    const tagHtml = m.soloProvinces.length > 0
      ? m.soloProvinces.map((p) => `<span class="pk-tag" style="color:${m.color}">${p.name}</span>`).join('')
      : '<span class="empty-hint">暂无独占山河，快去点亮吧</span>';

    box.innerHTML = `
      <div class="pk-solo-box-head" style="color:${m.color}">
        <span>${m.name}的专属领地</span>
        <span>共 ${m.soloProvinces.length} 省</span>
      </div>
      <div class="pk-solo-tags">${tagHtml}</div>
    `;
    soloGridEl.appendChild(box);
  }

  // 3. 合家欢共同省份
  const familyTagsEl = $('pk-family-tags');
  if (pkStats.familyProvinces.length > 0) {
    familyTagsEl.innerHTML = pkStats.familyProvinces
      .map((p) => `<span class="pk-family-tag">✨ ${p.name} (${p.members.length}人点亮)</span>`)
      .join('');
  } else {
    familyTagsEl.innerHTML = '<span class="empty-hint">全家尚未有点亮同一省份，快去创造共同回忆吧</span>';
  }
}

function openPkModal() {
  pkPrevFocus = document.activeElement;
  renderPkModal();
  const modal = $('pk-modal');
  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('show');
  const closeBtn = $('pk-close');
  if (closeBtn) closeBtn.focus();
}

function closePkModal() {
  const modal = $('pk-modal');
  if (!modal.classList.contains('show')) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.style.display = 'none';
    if (pkPrevFocus && typeof pkPrevFocus.focus === 'function') {
      try { pkPrevFocus.focus(); } catch {}
      pkPrevFocus = null;
    }
  }, 220);
}

/* ---------- 弹窗与控制事件绑定 ---------- */
$('unlock-ok').addEventListener('click', (e) => {
  e.stopPropagation();
  closeUnlockModal();
});

$('unlock-close').addEventListener('click', (e) => {
  e.stopPropagation();
  closeUnlockModal();
});

$('unlock-modal').addEventListener('click', (e) => {
  if (e.target === $('unlock-modal')) {
    closeUnlockModal();
  }
});

const unlockCard = document.querySelector('.unlock-card');
if (unlockCard) {
  unlockCard.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

$('achieve-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openGallery();
});

$('gallery-close').addEventListener('click', (e) => {
  e.stopPropagation();
  closeGallery();
});

$('gallery-modal').addEventListener('click', (e) => {
  if (e.target === $('gallery-modal')) {
    closeGallery();
  }
});

const gallerySheet = document.querySelector('.gallery-sheet');
if (gallerySheet) {
  gallerySheet.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// 成员与家庭房间管理弹窗
$('member-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openFamilyModal();
});

$('family-close').addEventListener('click', (e) => {
  e.stopPropagation();
  closeFamilyModal();
});

$('family-modal').addEventListener('click', (e) => {
  if (e.target === $('family-modal')) {
    closeFamilyModal();
  }
});

const familySheet = document.querySelector('.family-sheet');
if (familySheet) {
  familySheet.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// PK 透视开关与战报面板
$('pk-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  store.togglePkMode();
  renderPkToggle();
  if (mapApi) {
    mapApi.update(
      (c) => store.isLit(c),
      (c) => store.isCityLit(c),
      store.isPkMode() ? store.getPkStats() : null
    );
  }
  toast(store.isPkMode() ? '⚔️ PK 透视已开启' : 'PK 透视已关闭');
});

const pkPanelBtn = $('pk-panel-btn');
if (pkPanelBtn) {
  pkPanelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPkModal();
  });
}

$('pk-close').addEventListener('click', (e) => {
  e.stopPropagation();
  closePkModal();
});

$('pk-modal').addEventListener('click', (e) => {
  if (e.target === $('pk-modal')) {
    closePkModal();
  }
});

const pkSheet = document.querySelector('.pk-sheet');
if (pkSheet) {
  pkSheet.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// 熄灭气泡
$('popover-drill').addEventListener('click', (e) => {
  e.stopPropagation();
  if (pendingUnlight && pendingUnlight.feature) {
    const f = pendingUnlight.feature;
    hidePopover();
    startDrillDown(f);
  }
});

$('popover-ok').addEventListener('click', (e) => {
  e.stopPropagation();
  if (pendingUnlight) {
    if (pendingUnlight.isCity) {
      const unlitSuccess = store.unlightCity(pendingUnlight.adcode);
      if (unlitSuccess) {
        playUnlight();
        mapApi.updateCity(pendingUnlight.adcode, false);
        updateBreadcrumb();
        if (isTouch) toast(`已熄灭 ${pendingUnlight.name}`);
      }
    } else {
      const unlitSuccess = store.unlight(pendingUnlight.adcode);
      if (unlitSuccess) {
        playUnlight();
        mapApi.update(
          (c) => store.isLit(c),
          (c) => store.isCityLit(c),
          store.isPkMode() ? store.getPkStats() : null
        );
        if (isTouch) toast(`已熄灭 ${pendingUnlight.name}`);
      }
    }
  }
  hidePopover();
});

$('popover-cancel').addEventListener('click', (e) => {
  e.stopPropagation();
  hidePopover();
});

popover.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.addEventListener('click', (e) => {
  if (popover.classList.contains('show') && !popover.contains(e.target)) {
    hidePopover();
  }
});

$('bc-root').addEventListener('click', (e) => {
  e.stopPropagation();
  returnToNational();
});

// Esc 键关闭任意浮层
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') {
    if ($('unlock-modal').classList.contains('show')) {
      closeUnlockModal();
      return;
    }
    if ($('gallery-modal').classList.contains('show')) {
      closeGallery();
      return;
    }
    if ($('family-modal').classList.contains('show')) {
      closeFamilyModal();
      return;
    }
    if ($('pk-modal').classList.contains('show')) {
      closePkModal();
      return;
    }
    if (popover.classList.contains('show')) {
      hidePopover();
      return;
    }
    if (currentDrill) {
      returnToNational();
    }
  }
});

/* ---------- 主题与音效开关 ---------- */
function renderThemeIcon() {
  const dark = store.state.theme === 'dark';
  $('icon-moon').style.display = dark ? '' : 'none';
  $('icon-sun').style.display = dark ? 'none' : '';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#080c16' : '#f7f4ec';
}

function renderSoundBtn(enabled) {
  const btn = $('sound-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('muted', !enabled);
  $('icon-vol').style.display = enabled ? '' : 'none';
  $('icon-mute').style.display = enabled ? 'none' : '';
}

$('theme-btn').addEventListener('click', () => {
  store.toggleTheme();
});

$('sound-btn').addEventListener('click', () => {
  const next = !store.state.soundEnabled;
  store.setSoundEnabled(next);
  setAudioEnabled(next);
  renderSoundBtn(next);
  toast(next ? '音效已开启' : '已静音');
});

const unlockAudio = () => ensureCtx();
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

function createMapCallbacks() {
  return {
    onHover: (f, e) => {
      if (isTouch || popover.classList.contains('show')) return;
      const adcode = String(f.properties.adcode);
      const name = f.properties.name;

      if (store.isPkMode()) {
        const stats = store.getPkStats();
        const p = stats.provinceMap[adcode];
        const litMembers = p ? p.litMembers : [];

        if (litMembers.length === 0) {
          showTooltip(name, false, e.clientX, e.clientY, true, '全家尚未踏足', '点击为家庭开辟山河');
        } else if (litMembers.length === 1) {
          const m = litMembers[0];
          showTooltip(name, true, e.clientX, e.clientY, true, `独占 · ${m.name}`, '专属足迹');
        } else {
          const names = litMembers.map((m) => m.name).join('、');
          showTooltip(name, true, e.clientX, e.clientY, true, `✨ 合家欢 · ${names}`, `${litMembers.length}人同游`);
        }
      } else {
        showTooltip(name, store.isLit(adcode), e.clientX, e.clientY, true);
      }
    },
    onLeave: hideTooltip,
    onTap,
    onDblClick: (f) => onProvinceDblClick(f),
    onDblTap: (f) => onProvinceDblClick(f),
    onCityHover: (cf, e) => {
      if (isTouch || popover.classList.contains('show')) return;
      showTooltip(cf.properties.name, store.isCityLit(cf.properties.adcode), e.clientX, e.clientY, false);
    },
    onCityLeave: hideTooltip,
    onCityTap,
    onBackgroundClick: () => {
      if (popover.classList.contains('show')) {
        hidePopover();
        return;
      }
      if (currentDrill) {
        returnToNational();
      }
    },
  };
}

/* ---------- 构建与初始化 ---------- */
function buildAll() {
  applyThemeVars(store.state.theme);
  renderThemeIcon();
  renderSoundBtn(store.state.soundEnabled);
  renderMemberButton();
  renderPkToggle();
  setAudioEnabled(store.state.soundEnabled);
  setParticlesTheme(store.state.theme);
  initParticles($('fx'));
  drawStars();

  mapApi = buildMainMap($('map'), provinces, createMapCallbacks(), store.state.theme);
  mapApi.update(
    (c) => store.isLit(c),
    (c) => store.isCityLit(c),
    store.isPkMode() ? store.getPkStats() : null
  );

  buildInset($('inset'), islandsFeature, store.state.theme);
  renderProgress(false);
}

async function init() {
  try {
    const geo = await loadGeo();
    provinces = geo.provinces;
    islandsFeature = geo.islands;
    initProvinceAdcodes(provinces);
    if (provinces.length !== TOTAL_PROVINCES) {
      console.warn(`省份数量异常: ${provinces.length}`);
    }
  } catch (err) {
    $('loading').querySelector('p').textContent = '地图加载失败，请检查网络后刷新';
    console.error(err);
    return;
  }

  buildAll();

  // 初始化同步层与离线容灾
  initSync(store);
  subscribeSyncStatus((status) => {
    const indicator = $('family-sync-indicator');
    if (!indicator) return;
    indicator.className = `family-sync-indicator ${status}`;
    if (status === 'syncing') indicator.textContent = '🔄 同步中…';
    else if (status === 'saved') indicator.textContent = '🟢 已同步';
    else if (status === 'offline') indicator.textContent = '⚪ 离线模式';
    else indicator.textContent = '就绪';
  });

  // Store 状态订阅
  store.subscribe((s) => {
    if (mapApi) {
      mapApi.update(
        (c) => store.isLit(c),
        (c) => store.isCityLit(c),
        store.isPkMode() ? store.getPkStats() : null
      );
    }
    renderProgress();
    renderMemberButton();
    renderPkToggle();
    renderSoundBtn(s.soundEnabled);
    setAudioEnabled(s.soundEnabled);

    if ($('gallery-modal').classList.contains('show')) {
      renderGallery();
    }
    if ($('family-modal').classList.contains('show')) {
      renderFamilyModal();
    }
    if ($('pk-modal').classList.contains('show')) {
      renderPkModal();
    }

    if (s.theme !== currentTheme) {
      currentTheme = s.theme;
      applyThemeVars(s.theme);
      renderThemeIcon();
      drawStars();
      buildInset($('inset'), islandsFeature, s.theme);
      setParticlesTheme(s.theme);
    }
  });

  // 尺寸自适应防抖
  let rt = null;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      mapApi = buildMainMap($('map'), provinces, createMapCallbacks(), store.state.theme);
      mapApi.update(
        (c) => store.isLit(c),
        (c) => store.isCityLit(c),
        store.isPkMode() ? store.getPkStats() : null
      );
      if (currentDrill) {
        mapApi.drillDown(currentDrill.feature, currentDrill.cities, (c) => store.isCityLit(c));
      }
      buildInset($('inset'), islandsFeature, store.state.theme);
      drawStars();
      resizeParticles();
    }, 220);
  });

  $('loading').classList.add('hide');
}

init();
