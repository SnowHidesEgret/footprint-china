/**
 * 点亮中国 · 入口：组装地图 / 状态 / 视听反馈与交互
 */
import { TOTAL_PROVINCES } from './config.js?v=20260930b';
import { loadGeo, loadCityGeo } from './geo.js?v=20260930b';
import { store } from './store.js?v=20260930b';
import { buildMainMap, buildInset, applyThemeVars } from './map.js?v=20260930b';
import { ensureCtx, setEnabled as setAudioEnabled, playLight, playUnlight, playAchievement } from './audio.js?v=20260930b';
import { initParticles, burst as burstParticles, confetti as confettiParticles, setParticlesTheme, resizeParticles } from './particles.js?v=20260930b';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

let mapApi = null;
let provinces = [];
let islandsFeature = null;
let pendingUnlight = null; // { adcode, name, isCity, feature }
let currentTheme = store.state.theme;

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

/* ---------- 进度胶囊 ---------- */
function renderProgress(animate = true) {
  const n = Math.min(Math.max(store.litCount(), 0), TOTAL_PROVINCES);
  const pct = Math.min(Math.max((n / TOTAL_PROVINCES) * 100, 0), 100);
  $('lit-num').textContent = n;
  $('lit-pct').textContent = pct.toFixed(1).replace(/\.0$/, '') + '%';
  const bar = $('lit-bar');
  if (!animate) bar.style.transition = 'none';
  bar.style.width = pct + '%';
  if (!animate) requestAnimationFrame(() => (bar.style.transition = ''));
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

/* ---------- tooltip / popover ---------- */
const tooltip = $('tooltip');
function showTooltip(name, lit, x, y, isProvince = true) {
  $('tooltip-name').textContent = name;
  $('tooltip-st').textContent = lit ? '已点亮' : '未点亮';
  const subEl = $('tooltip-sub');
  if (subEl) {
    if (isProvince && !isTouch) {
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
    } catch {
      // 忽略聚焦异常
    }
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

  currentDrill = { feature: provinceFeature, cities, adcode, name };
  mapApi.drillDown(provinceFeature, cities, (c) => store.isCityLit(c));
  updateBreadcrumb();
  $('breadcrumb').classList.add('show');
  $('inset-wrap').classList.add('hide');
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
    void comboEl.offsetWidth; // 触发 reflow 重置动画
    comboEl.classList.add('show');
  }
  clearTimeout(comboTimer);
  comboTimer = setTimeout(() => {
    const comboEl = $('combo');
    if (comboEl) comboEl.classList.remove('show');
    combo = 0;
  }, 3000);

  // 升半音播放点亮音效（第 n 次连击用半音数 n - 1）
  playLight(combo >= 2 ? combo - 1 : 0);

  // 粒子爆裂喷发
  burstParticles(clientX, clientY, store.state.theme);

  // 原有地图光晕与数字动画
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

  // 2. 关键冲突：单击点亮保持即时；300ms 内对同一省份发生第二次点击，则压制确认框、直接进入下钻
  const now = Date.now();
  if (now - lastProvinceClick.time <= 300 && lastProvinceClick.adcode === adcode) {
    lastProvinceClick = { time: 0, adcode: '' };
    hidePopover();
    startDrillDown(f);
    return;
  }
  lastProvinceClick = { time: now, adcode };

  if (store.isLit(adcode)) {
    // 已点亮 → 确认气泡（防误触，使用视口坐标精确定位）
    pendingUnlight = { adcode, name, isCity: false, feature: f };
    showPopover(name, clientX, clientY, false, f);
  } else {
    hidePopover();
    const litBefore = store.litCount();
    const pctBefore = litBefore / TOTAL_PROVINCES;

    const litSuccess = store.light(adcode, name);
    if (!litSuccess) return;

    triggerComboAndLightEffects(clientX, clientY, svgX, svgY, name);
    mapApi.update((c) => store.isLit(c), (c) => store.isCityLit(c));

    // 里程碑阈值礼花判定
    const litAfter = store.litCount();
    const pctAfter = litAfter / TOTAL_PROVINCES;
    for (const t of THRESHOLDS) {
      if (pctBefore < t && pctAfter >= t && !firedThresholds.has(t)) {
        firedThresholds.add(t);
        confettiParticles(store.state.theme);
        playAchievement();
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
    // 已点亮城市 → 确认气泡（防误触）
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

    // 城市点亮复用现有配色、粒子爆裂、音效、Combo 链路
    triggerComboAndLightEffects(clientX, clientY, svgX, svgY, cname);
    mapApi.updateCity(cadcode, true);
    updateBreadcrumb();

    // 城市点亮同样触发阈值礼花判断（按省级进度口径）
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
  }
}

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
        mapApi.update((c) => store.isLit(c), (c) => store.isCityLit(c));
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

// 面包屑根节点点击返回全国视图
$('bc-root').addEventListener('click', (e) => {
  e.stopPropagation();
  returnToNational();
});

// 支持按 Esc 键关闭 popover 或拉回全国视图
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') {
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

// 首次用户手势（pointerdown 或 keydown）时按策略解锁 AudioContext
const unlockAudio = () => ensureCtx();
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

function createMapCallbacks() {
  return {
    onHover: (f, e) => {
      if (isTouch || popover.classList.contains('show')) return;
      showTooltip(f.properties.name, store.isLit(f.properties.adcode), e.clientX, e.clientY, true);
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
  setAudioEnabled(store.state.soundEnabled);
  setParticlesTheme(store.state.theme);
  initParticles($('fx'));
  drawStars();
  mapApi = buildMainMap($('map'), provinces, createMapCallbacks(), store.state.theme);
  mapApi.update((c) => store.isLit(c), (c) => store.isCityLit(c));
  buildInset($('inset'), islandsFeature, store.state.theme);
  renderProgress(false);
}

async function init() {
  try {
    const geo = await loadGeo();
    provinces = geo.provinces;
    islandsFeature = geo.islands;
    if (provinces.length !== TOTAL_PROVINCES) {
      console.warn(`省份数量异常: ${provinces.length}`);
    }
  } catch (err) {
    $('loading').querySelector('p').textContent = '地图加载失败，请检查网络后刷新';
    console.error(err);
    return;
  }

  buildAll();

  // 状态变化：普通点亮只更新点亮类名与进度，避免每次销毁重建静态插图
  store.subscribe((s) => {
    if (mapApi) mapApi.update((c) => store.isLit(c), (c) => store.isCityLit(c));
    renderProgress();
    renderSoundBtn(s.soundEnabled);
    setAudioEnabled(s.soundEnabled);
    if (s.theme !== currentTheme) {
      currentTheme = s.theme;
      applyThemeVars(s.theme);
      renderThemeIcon();
      drawStars();
      buildInset($('inset'), islandsFeature, s.theme);
      setParticlesTheme(s.theme);
    }
  });

  // 尺寸变化 → 重建投影与粒子适配（防抖）
  let rt = null;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      mapApi = buildMainMap($('map'), provinces, createMapCallbacks(), store.state.theme);
      mapApi.update((c) => store.isLit(c), (c) => store.isCityLit(c));
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
