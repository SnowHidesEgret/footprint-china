/**
 * 点亮中国 · 地图渲染层（原生 SVG + d3-geo）
 * 主地图：34 省 path；右下角：南海诸岛插图（真实岛礁数据 + 十段线示意）
 */
import { geoMercator, geoPath, geoCentroid } from 'd3-geo';
import { THEMES, LIT_GRADIENT, TEN_DASH_LINE, SMALL_REGION_HIT, HIT_CIRCLE_R } from './config.js?v=20260930a';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** 把主题色写入 CSS 变量 */
export function applyThemeVars(themeName) {
  const t = THEMES[themeName] || THEMES.dark;
  const root = document.documentElement;
  const map = {
    '--bg0': t.bg0, '--bg1': t.bg1,
    '--prov-fill': t.provinceFill, '--prov-stroke': t.provinceStroke,
    '--prov-hover-fill': t.provinceHoverFill, '--prov-hover-stroke': t.provinceHoverStroke,
    '--lit-stroke': t.litStroke, '--glow': t.glow,
    '--text': t.text, '--text-dim': t.textDim,
    '--capsule-bg': t.capsuleBg, '--capsule-border': t.capsuleBorder,
    '--inset-border': t.insetBorder, '--dash-line': t.dashLine,
    '--tooltip-bg': t.tooltipBg,
    '--danger-text': t.dangerText || (themeName === 'light' ? '#ffffff' : '#1a1005'),
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  const [g0, g1] = LIT_GRADIENT[themeName] || LIT_GRADIENT.dark;
  for (const id of ['litStop0', 'litStop1']) {
    const s = document.getElementById(id);
    if (s) s.setAttribute('stop-color', id === 'litStop0' ? g0 : g1);
  }
}

/**
 * 构建主地图
 * @param {SVGSVGElement} svg
 * @param {Array} provinces GeoJSON features
 * @param {Object} cbs { onHover(f, evt), onLeave(), onTap(f, svgX, svgY, clientX, clientY) }
 * @param {string} themeName 当前主题名
 */
export function buildMainMap(svg, provinces, cbs, themeName = 'dark') {
  svg.innerHTML = '';
  const W = svg.clientWidth || window.innerWidth;
  const H = svg.clientHeight || window.innerHeight;

  const defs = el('defs');
  const grad = el('radialGradient', { id: 'litGrad', cx: '50%', cy: '42%', r: '75%' });
  const [g0, g1] = LIT_GRADIENT[themeName] || LIT_GRADIENT.dark;
  grad.appendChild(el('stop', { id: 'litStop0', offset: '0%', 'stop-color': g0 }));
  grad.appendChild(el('stop', { id: 'litStop1', offset: '100%', 'stop-color': g1 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const fc = { type: 'FeatureCollection', features: provinces };
  const pad = Math.min(W, H) * 0.045;
  const projection = geoMercator().fitExtent([[pad, pad], [W - pad, H - pad]], fc);
  const path = geoPath(projection);

  // 预计算小行政区投影中心与自适应热区半径，避免京津、港澳小屏重叠误触
  const smallCenters = new Map();
  for (const f of provinces) {
    const adcode = String(f.properties.adcode);
    if (SMALL_REGION_HIT[adcode]) {
      smallCenters.set(adcode, projection(geoCentroid(f)));
    }
  }

  const baseHitR = Math.max(9, Math.min(HIT_CIRCLE_R, Math.round(Math.min(W, H) * 0.022)));
  const hitRadii = new Map();
  for (const [adcode, [cx, cy]] of smallCenters) {
    let minDist = Infinity;
    for (const [otherCode, [ox, oy]] of smallCenters) {
      if (otherCode === adcode) continue;
      const d = Math.hypot(cx - ox, cy - oy);
      if (d < minDist) minDist = d;
    }
    const safeMaxR = minDist < Infinity ? Math.floor(minDist * 0.45) : baseHitR;
    hitRadii.set(adcode, Math.max(6, Math.min(baseHitR, safeMaxR)));
  }

  const layer = el('g', { class: 'prov-layer' });
  const burstLayer = el('g', { class: 'burst-layer', 'pointer-events': 'none' });
  const groups = new Map();

  for (const f of provinces) {
    const adcode = String(f.properties.adcode);
    const name = f.properties.name;
    const g = el('g', {
      class: 'prov',
      role: 'button',
      tabindex: '0',
      'data-adcode': adcode,
      'data-name': name,
      'aria-label': `${name}，未点亮`,
      'aria-pressed': 'false',
    });

    const vis = el('path', { d: path(f), class: 'pvis' });
    g.appendChild(vis);

    // 小行政区加自适应点击热区
    if (SMALL_REGION_HIT[adcode] && smallCenters.has(adcode)) {
      const [cx, cy] = smallCenters.get(adcode);
      const r = hitRadii.get(adcode) || baseHitR;
      const hit = el('circle', {
        cx, cy, r, class: 'hit',
        fill: 'rgba(0,0,0,0)',
      });
      g.appendChild(hit);
    }

    g.addEventListener('mouseenter', (e) => cbs.onHover(f, e));
    g.addEventListener('mousemove', (e) => cbs.onHover(f, e));
    g.addEventListener('mouseleave', () => cbs.onLeave());

    // 点击事件：阻止冒泡，避免被 document 全局点击立即关闭 popover
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      const pt = svgPoint(svg, e);
      cbs.onTap(f, pt.x, pt.y, e.clientX, e.clientY);
    });

    // 键盘无障碍交互：Enter/Space 触发
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        let cx = 0, cy = 0;
        try {
          const pt = projection(geoCentroid(f));
          if (pt && !isNaN(pt[0]) && !isNaN(pt[1])) {
            [cx, cy] = pt;
          }
        } catch {
          // 降级使用 0,0
        }
        const rect = g.getBoundingClientRect ? g.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        cbs.onTap(f, cx, cy, clientX, clientY);
      }
    });

    layer.appendChild(g);
    groups.set(adcode, g);
  }
  svg.appendChild(layer);
  svg.appendChild(burstLayer);

  function svgPoint(svgEl, evt) {
    if (!svgEl) return { x: 0, y: 0 };
    const clientX = typeof evt.clientX === 'number' ? evt.clientX : 0;
    const clientY = typeof evt.clientY === 'number' ? evt.clientY : 0;

    if (typeof svgEl.createSVGPoint === 'function' && typeof svgEl.getScreenCTM === 'function') {
      try {
        const ctm = svgEl.getScreenCTM();
        if (ctm) {
          const pt = svgEl.createSVGPoint();
          pt.x = clientX;
          pt.y = clientY;
          return pt.matrixTransform(ctm.inverse());
        }
      } catch {
        // CTM inverse 失败降级
      }
    }

    const rect = svgEl.getBoundingClientRect ? svgEl.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: clientX - (rect ? rect.left : 0),
      y: clientY - (rect ? rect.top : 0),
    };
  }

  return {
    /** 按 store 状态刷新点亮 class 与无障碍状态 */
    update(isLit) {
      for (const [adcode, g] of groups) {
        const lit = isLit(adcode);
        g.classList.toggle('lit', lit);
        const name = g.getAttribute('data-name') || '';
        g.setAttribute('aria-label', `${name}，${lit ? '已点亮' : '未点亮'}`);
        g.setAttribute('aria-pressed', lit ? 'true' : 'false');
      }
    },
    /** 点亮时的光晕爆发（一次性） */
    burst(x, y) {
      const c = el('circle', { cx: x, cy: y, r: 8, class: 'burst-ring' });
      burstLayer.appendChild(c);
      c.addEventListener('animationend', () => c.remove());
    },
    project: projection,
  };
}

/**
 * 构建南海诸岛插图（独立小 svg，装饰性，不可交互）
 */
export function buildInset(svg, islandsFeature, themeName) {
  svg.innerHTML = '';
  const t = THEMES[themeName] || THEMES.dark;
  const W = svg.clientWidth || 150;
  const H = svg.clientHeight || 190;

  const dashFc = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: TEN_DASH_LINE },
  };
  const union = {
    type: 'FeatureCollection',
    features: islandsFeature ? [islandsFeature, dashFc] : [dashFc],
  };
  const projection = geoMercator().fitExtent([[14, 14], [W - 14, H - 30]], union);
  const path = geoPath(projection);

  if (islandsFeature) {
    svg.appendChild(el('path', {
      d: path(islandsFeature),
      fill: t.provinceFill, stroke: t.provinceStroke, 'stroke-width': 1,
    }));
  }
  const dash = el('path', {
    d: path(dashFc),
    fill: 'none', stroke: t.dashLine, 'stroke-width': 1.8,
    'stroke-dasharray': '6 4', 'stroke-linecap': 'round',
  });
  svg.appendChild(dash);

  const label = el('text', {
    x: W / 2, y: H - 8, 'text-anchor': 'middle', class: 'inset-label',
  });
  label.textContent = '南海诸岛';
  svg.appendChild(label);
}
