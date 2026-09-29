/**
 * 点亮中国 · 入口：组装地图 / 状态 / 交互
 */
import { TOTAL_PROVINCES } from './config.js';
import { loadGeo } from './geo.js';
import { store } from './store.js';
import { buildMainMap, buildInset, applyThemeVars } from './map.js';

const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

let mapApi = null;
let provinces = [];
let islandsFeature = null;
let pendingUnlight = null; // { adcode, name }
let currentTheme = store.state.theme;

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
function showTooltip(name, lit, x, y) {
  $('tooltip-name').textContent = name;
  $('tooltip-st').textContent = lit ? '已点亮' : '未点亮';
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

function showPopover(name, x, y) {
  lastFocusedEl = document.activeElement;
  $('popover-name').textContent = name;
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

/* ---------- 地图交互 ---------- */
function onTap(f, svgX, svgY, clientX, clientY) {
  const adcode = String(f.properties.adcode);
  const name = f.properties.name;
  hideTooltip();
  if (store.isLit(adcode)) {
    // 已点亮 → 确认气泡（防误触，使用视口坐标精确定位）
    pendingUnlight = { adcode, name };
    showPopover(name, clientX, clientY);
  } else {
    hidePopover();
    store.light(adcode, name);
    mapApi.update((c) => store.isLit(c));
    mapApi.burst(svgX, svgY);
    popNumber();
    if (isTouch) toast(`✦ 已点亮 <b>${name}</b>`);
  }
}

$('popover-ok').addEventListener('click', (e) => {
  e.stopPropagation();
  if (pendingUnlight) {
    store.unlight(pendingUnlight.adcode);
    mapApi.update((c) => store.isLit(c));
    if (isTouch) toast(`已熄灭 ${pendingUnlight.name}`);
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

// 支持按 Esc 键关闭 popover
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Escape' || e.key === 'Esc') && popover.classList.contains('show')) {
    hidePopover();
  }
});

/* ---------- 主题 ---------- */
function renderThemeIcon() {
  const dark = store.state.theme === 'dark';
  $('icon-moon').style.display = dark ? '' : 'none';
  $('icon-sun').style.display = dark ? 'none' : '';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#080c16' : '#f7f4ec';
}
$('theme-btn').addEventListener('click', () => {
  store.toggleTheme();
});

/* ---------- 构建 ---------- */
function buildAll() {
  applyThemeVars(store.state.theme);
  renderThemeIcon();
  drawStars();
  mapApi = buildMainMap($('map'), provinces, {
    onHover: (f, e) => {
      if (isTouch || popover.classList.contains('show')) return;
      showTooltip(f.properties.name, store.isLit(f.properties.adcode), e.clientX, e.clientY);
    },
    onLeave: hideTooltip,
    onTap,
  }, store.state.theme);
  mapApi.update((c) => store.isLit(c));
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
    if (mapApi) mapApi.update((c) => store.isLit(c));
    renderProgress();
    if (s.theme !== currentTheme) {
      currentTheme = s.theme;
      applyThemeVars(s.theme);
      renderThemeIcon();
      drawStars();
      buildInset($('inset'), islandsFeature, s.theme);
    }
  });

  // 尺寸变化 → 重建投影（防抖）
  let rt = null;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      mapApi = buildMainMap($('map'), provinces, {
        onHover: (f, e) => {
          if (isTouch || popover.classList.contains('show')) return;
          showTooltip(f.properties.name, store.isLit(f.properties.adcode), e.clientX, e.clientY);
        },
        onLeave: hideTooltip,
        onTap,
      }, store.state.theme);
      mapApi.update((c) => store.isLit(c));
      buildInset($('inset'), islandsFeature, store.state.theme);
      drawStars();
    }, 220);
  });

  $('loading').classList.add('hide');
}

init();
