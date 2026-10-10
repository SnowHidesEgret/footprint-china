/**
 * 点亮中国 · Canvas 粒子引擎（零依赖）
 * 高性能对象池复用，平时零 rAF 开销，支持点亮爆裂与里程碑全屏彩带
 */

import { THEMES } from './config.js?v=20261005i';

const POOL_SIZE = 320;
const pool = [];

let canvas = null;
let ctx = null;
let dpr = 1;
let width = 0;
let height = 0;
let currentTheme = 'dark';
let animId = null;
let lastTime = 0;

// 预先分配对象池，彻底杜绝运行时 GC 造成的帧率抖动
for (let i = 0; i < POOL_SIZE; i++) {
  pool.push({
    active: false,
    type: 'burst', // 'burst' | 'confetti'
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    gravity: 0,
    color: '#FFB84D',
    size: 2,
    w: 6,
    h: 10,
    rotation: 0,
    vRotation: 0,
    wobbleSpeed: 0,
    wobblePhase: 0,
    life: 0,
    maxLife: 1,
  });
}

function getIdleParticle() {
  for (let i = 0; i < pool.length; i++) {
    if (!pool[i].active) return pool[i];
  }
  // 池满时扩容一个
  const p = {
    active: false,
    type: 'burst',
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    gravity: 0,
    color: '#FFB84D',
    size: 2,
    w: 6,
    h: 10,
    rotation: 0,
    vRotation: 0,
    wobbleSpeed: 0,
    wobblePhase: 0,
    life: 0,
    maxLife: 1,
  };
  pool.push(p);
  return p;
}

function getThemeColors(themeName) {
  const t = themeName || currentTheme;
  return THEMES[t]?.particleColors || THEMES.dark.particleColors;
}

function randomColor(colors) {
  return colors[Math.floor(Math.random() * colors.length)];
}

function startLoop() {
  if (animId) return;
  lastTime = performance.now();
  animId = requestAnimationFrame(loop);
}

function loop(now) {
  if (!ctx) {
    animId = null;
    return;
  }

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  ctx.clearRect(0, 0, width, height);

  let activeCount = 0;

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active) continue;

    p.life += dt;
    if (p.life >= p.maxLife) {
      p.active = false;
      continue;
    }

    activeCount++;
    const progress = p.life / p.maxLife;

    p.px = p.x;
    p.py = p.y;
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rotation += p.vRotation * dt;

    if (p.type === 'burst') {
      const alpha = Math.max(0, 1 - progress);
      ctx.save();
      ctx.globalAlpha = alpha;

      // 绘制速度尾迹
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(0.8, p.size * 0.7);
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      // 绘制主体圆形微粒
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (p.type === 'confetti') {
      // 尾部 25% 寿命线性淡出
      const alpha = progress > 0.75 ? Math.max(0, (1 - progress) / 0.25) : 1;
      const wobble = Math.sin(p.life * p.wobbleSpeed + p.wobblePhase);
      const flip = Math.cos(p.life * p.wobbleSpeed * 1.2);

      ctx.save();
      ctx.translate(p.x + wobble * 4, p.y);
      ctx.rotate(p.rotation);
      ctx.scale(flip, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  }

  if (activeCount === 0) {
    ctx.clearRect(0, 0, width, height);
    animId = null;
  } else {
    animId = requestAnimationFrame(loop);
  }
}

/**
 * 重新适配 Canvas 尺寸与像素比
 */
export function resizeParticles() {
  if (!canvas || !ctx) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * 初始化粒子系统
 */
export function initParticles(canvasEl) {
  if (!canvasEl) return;
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resizeParticles();
}

/**
 * 切换粒子主题色彩
 */
export function setParticlesTheme(themeName) {
  currentTheme = themeName || 'dark';
}

/**
 * 点亮爆裂微粒（单点喷发）
 */
export function burst(clientX, clientY, themeName) {
  if (!canvas || !ctx) return;

  const isNarrow = window.innerWidth < 640;
  const count = isNarrow ? 8 : Math.floor(12 + Math.random() * 5); // 12~16
  const colors = getThemeColors(themeName);

  for (let i = 0; i < count; i++) {
    const p = getIdleParticle();
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 200; // 60~260 px/s

    p.active = true;
    p.type = 'burst';
    p.x = clientX;
    p.y = clientY;
    p.px = clientX;
    p.py = clientY;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.gravity = 520;
    p.color = randomColor(colors);
    p.size = 2.2 + Math.random() * 1.8;
    p.rotation = Math.random() * Math.PI * 2;
    p.vRotation = (Math.random() - 0.5) * 8;
    p.life = 0;
    p.maxLife = 0.15 + Math.random() * 0.5; // 150~650ms
  }

  startLoop();
}

/**
 * 全屏礼花雨（里程碑达成）
 */
export function confetti(themeName) {
  if (!canvas || !ctx) return;

  const total = Math.floor(80 + Math.random() * 41); // 80~120
  const bottomCount = Math.round(total * 0.2);
  const topCount = total - bottomCount;
  const colors = getThemeColors(themeName);

  // 顶部随机飘落
  for (let i = 0; i < topCount; i++) {
    const p = getIdleParticle();
    p.active = true;
    p.type = 'confetti';
    p.x = Math.random() * width;
    p.y = -10 - Math.random() * 30;
    p.px = p.x;
    p.py = p.y;
    p.vx = (Math.random() - 0.5) * 80;
    p.vy = 80 + Math.random() * 120;
    p.gravity = 110;
    p.w = 5 + Math.random() * 4;
    p.h = 8 + Math.random() * 6;
    p.rotation = Math.random() * Math.PI * 2;
    p.vRotation = (Math.random() - 0.5) * 10;
    p.wobbleSpeed = 3 + Math.random() * 4;
    p.wobblePhase = Math.random() * Math.PI * 2;
    p.color = randomColor(colors);
    p.life = 0;
    p.maxLife = 1.5 + Math.random() * 1.5; // 1.5~3s
  }

  // 底部两侧斜向上喷
  for (let i = 0; i < bottomCount; i++) {
    const p = getIdleParticle();
    const fromLeft = i % 2 === 0;

    p.active = true;
    p.type = 'confetti';
    p.x = fromLeft ? Math.random() * 0.18 * width : width - Math.random() * 0.18 * width;
    p.y = height + 10;
    p.px = p.x;
    p.py = p.y;
    p.vx = fromLeft ? 140 + Math.random() * 220 : -(140 + Math.random() * 220);
    p.vy = -(320 + Math.random() * 240);
    p.gravity = 480;
    p.w = 5 + Math.random() * 4;
    p.h = 8 + Math.random() * 6;
    p.rotation = Math.random() * Math.PI * 2;
    p.vRotation = (Math.random() - 0.5) * 12;
    p.wobbleSpeed = 2 + Math.random() * 4;
    p.wobblePhase = Math.random() * Math.PI * 2;
    p.color = randomColor(colors);
    p.life = 0;
    p.maxLife = 1.8 + Math.random() * 1.2;
  }

  startLoop();
}
