/**
 * 点亮中国 · 地图渲染层（原生 SVG + d3-geo）
 * 主地图：34 省 path；右下角：南海诸岛插图（真实岛礁数据 + 十段线示意）
 */
import { geoMercator, geoPath, geoCentroid } from 'd3-geo';
import { THEMES, LIT_GRADIENT, TEN_DASH_LINE, SMALL_REGION_HIT, HIT_CIRCLE_R } from './config.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** 把主题色写入 CSS 变量 */
export function applyThemeVars(themeName) {
  const t = THEMES[themeName];
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
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  const [g0, g1] = LIT_GRADIENT[themeName];
  for (const id of ['litStop0', 'litStop1']) {
    const s = document.getElementById(id);
    if (s) s.setAttribute('stop-color', id === 'litStop0' ? g0 : g1);
  }
}

/**
 * 构建主地图
 * @param {SVGSVGElement} svg
 * @param {Array} provinces GeoJSON features
 * @param {Object} cbs { onHover(f, evt), onLeave(), onTap(f, x, y) }
 */
export function buildMainMap(svg, provinces, cbs) {
  svg.innerHTML = '';
  const W = svg.clientWidth || window.innerWidth;
  const H = svg.clientHeight || window.innerHeight;

  const defs = el('defs');
  const grad = el('radialGradient', { id: 'litGrad', cx: '50%', cy: '42%', r: '75%' });
  grad.appendChild(el('stop', { id: 'litStop0', offset: '0%', 'stop-color': '#FFA959' }));
  grad.appendChild(el('stop', { id: 'litStop1', offset: '100%', 'stop-color': '#FF8C38' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const fc = { type: 'FeatureCollection', features: provinces };
  const pad = Math.min(W, H) * 0.045;
  const projection = geoMercator().fitExtent([[pad, pad], [W - pad, H - pad]], fc);
  const path = geoPath(projection);

  const layer = el('g', { class: 'prov-layer' });
  const burstLayer = el('g', { class: 'burst-layer', 'pointer-events': 'none' });
  const groups = new Map();

  for (const f of provinces) {
    const adcode = String(f.properties.adcode);
    const name = f.properties.name;
    const g = el('g', { class: 'prov', 'data-adcode': adcode, 'data-name': name });

    const vis = el('path', { d: path(f), class: 'pvis' });
    g.appendChild(vis);

    // 小行政区加隐形点击热区
    if (SMALL_REGION_HIT[adcode]) {
      const [cx, cy] = projection(geoCentroid(f));
      const hit = el('circle', {
        cx, cy, r: HIT_CIRCLE_R, class: 'hit',
        fill: 'rgba(0,0,0,0)',
      });
      g.appendChild(hit);
    }

    g.addEventListener('mouseenter', (e) => cbs.onHover(f, e));
    g.addEventListener('mousemove', (e) => cbs.onHover(f, e));
    g.addEventListener('mouseleave', () => cbs.onLeave());
    g.addEventListener('click', (e) => {
      const pt = svgPoint(svg, e);
      cbs.onTap(f, pt.x, pt.y);
    });
    layer.appendChild(g);
    groups.set(adcode, g);
  }
  svg.appendChild(layer);
  svg.appendChild(burstLayer);

  function svgPoint(svgEl, evt) {
    const pt = svgEl.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svgEl.getScreenCTM().inverse());
  }

  return {
    /** 按 store 状态刷新点亮 class */
    update(isLit) {
      for (const [adcode, g] of groups) {
        g.classList.toggle('lit', isLit(adcode));
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
  const t = THEMES[themeName];
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
    fill: 'none', stroke: t.dashLine, 'stroke-width': 2,
    'stroke-dasharray': '7 5', 'stroke-linecap': 'round',
  });
  svg.appendChild(dash);

  const label = el('text', {
    x: W / 2, y: H - 8, 'text-anchor': 'middle', class: 'inset-label',
  });
  label.textContent = '南海诸岛';
  svg.appendChild(label);
}
