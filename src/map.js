/**
 * 点亮中国 · 地图渲染层（原生 SVG + d3-geo）
 * 主地图：34 省 path；右下角：南海诸岛插图（真实岛礁数据 + 十段线示意）
 */
import { geoMercator, geoPath, geoCentroid, geoBounds } from 'd3-geo';
import { THEMES, LIT_GRADIENT, TEN_DASH_LINE, SMALL_REGION_HIT, HIT_CIRCLE_R } from './config.js?v=20261005g';

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
 * 缓动函数：easeOutCubic (阻尼平滑减速)
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * 构建主地图
 * @param {SVGSVGElement} svg
 * @param {Array} provinces GeoJSON features
 * @param {Object} cbs { onHover, onLeave, onTap, onDblClick, onDblTap, onCityHover, onCityLeave, onCityTap, onCityDblClick, onCityDblTap, onBackgroundClick }
 * @param {string} themeName 当前主题名
 */
export function buildMainMap(svg, provinces, cbs, themeName = 'dark') {
  svg.innerHTML = '';
  const W = svg.clientWidth || window.innerWidth;
  const H = svg.clientHeight || window.innerHeight;

  // 初始化 SVG viewBox
  let currentViewBox = [0, 0, W, H];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const defs = el('defs');
  const grad = el('radialGradient', { id: 'litGrad', cx: '50%', cy: '42%', r: '75%' });
  const [g0, g1] = LIT_GRADIENT[themeName] || LIT_GRADIENT.dark;
  grad.appendChild(el('stop', { id: 'litStop0', offset: '0%', 'stop-color': g0 }));
  grad.appendChild(el('stop', { id: 'litStop1', offset: '100%', 'stop-color': g1 }));
  defs.appendChild(grad);

  // 金紫交辉渐变（合家欢特制高亮）
  const familyGrad = el('radialGradient', { id: 'pkGradFamily', cx: '50%', cy: '42%', r: '80%' });
  familyGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#FDE047' }));
  familyGrad.appendChild(el('stop', { offset: '45%', 'stop-color': '#F59E0B' }));
  familyGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#9333EA' }));
  defs.appendChild(familyGrad);

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

  let cityLayer = null;
  const cityGroups = new Map();
  let activeDrilledAdcode = null;
  let viewBoxAnimId = null;

  function setViewBox(box) {
    currentViewBox = box.slice();
    svg.setAttribute('viewBox', `${box[0]} ${box[1]} ${box[2]} ${box[3]}`);
  }

  function animateViewBox(targetBox, duration = 600, onComplete) {
    if (viewBoxAnimId) {
      cancelAnimationFrame(viewBoxAnimId);
      viewBoxAnimId = null;
    }
    const startBox = currentViewBox.slice();
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const t = easeOutCubic(progress);

      const box = [
        startBox[0] + (targetBox[0] - startBox[0]) * t,
        startBox[1] + (targetBox[1] - startBox[1]) * t,
        startBox[2] + (targetBox[2] - startBox[2]) * t,
        startBox[3] + (targetBox[3] - startBox[3]) * t,
      ];
      setViewBox(box);

      if (progress < 1) {
        viewBoxAnimId = requestAnimationFrame(step);
      } else {
        viewBoxAnimId = null;
        if (onComplete) onComplete();
      }
    }

    viewBoxAnimId = requestAnimationFrame(step);
  }

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

    g.addEventListener('mouseenter', (e) => cbs.onHover && cbs.onHover(f, e));
    g.addEventListener('mousemove', (e) => cbs.onHover && cbs.onHover(f, e));
    g.addEventListener('mouseleave', () => cbs.onLeave && cbs.onLeave());

    // 移动端 300ms 双击下钻识别（通过 touchend 时间戳判断）
    let lastTouchEndTime = 0;
    g.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEndTime <= 300) {
        lastTouchEndTime = 0;
        if (cbs.onDblTap) cbs.onDblTap(f, e);
      } else {
        lastTouchEndTime = now;
      }
    }, { passive: true });

    // 桌面端 dblclick 事件
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (cbs.onDblClick) cbs.onDblClick(f, e);
    });

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

  // 飞地省份（北京、天津位于河北境内，香港、澳门位于广东境内）必须绘制在
  // 包围它的省份之后，否则会被包围省份的 path 盖住，点击永远落不到它们身上
  // （2026-09-30 实测：北京 110000、天津 120000 无法点亮）。
  for (const code of ['110000', '120000', '810000', '820000']) {
    const eg = groups.get(code);
    if (eg) layer.appendChild(eg);
  }

  svg.appendChild(layer);
  svg.appendChild(burstLayer);

  // 地图空白暗区点击
  svg.addEventListener('click', (e) => {
    if (cbs.onBackgroundClick) cbs.onBackgroundClick(e);
  });

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
    /** 按 store 状态刷新点亮 class 与无障碍状态（支持普通单人与 PK 透视模式） */
    update(isLit, isCityLit, pkStats = null) {
      if (pkStats && pkStats.provinceMap) {
        // PK 透视模式渲染
        for (const [adcode, g] of groups) {
          const p = pkStats.provinceMap[adcode];
          const name = g.getAttribute('data-name') || '';
          const litMembers = p ? p.litMembers : [];

          if (litMembers.length === 0) {
            g.classList.remove('lit', 'pk-solo', 'pk-family');
            g.style.removeProperty('--pk-color');
            g.setAttribute('aria-label', `${name}，全家未点亮`);
            g.setAttribute('aria-pressed', 'false');
          } else if (litMembers.length === 1) {
            const owner = litMembers[0];
            g.classList.add('lit', 'pk-solo');
            g.classList.remove('pk-family');
            g.style.setProperty('--pk-color', owner.color);
            g.setAttribute('aria-label', `${name}，${owner.name}独占点亮`);
            g.setAttribute('aria-pressed', 'true');
          } else {
            // >= 2 人：合家欢
            g.classList.add('lit', 'pk-family');
            g.classList.remove('pk-solo');
            g.style.removeProperty('--pk-color');
            const names = litMembers.map((m) => m.name).join('、');
            g.setAttribute('aria-label', `${name}，合家欢（${names}共同点亮）`);
            g.setAttribute('aria-pressed', 'true');
          }
        }
      } else {
        // 普通单人模式渲染
        for (const [adcode, g] of groups) {
          const lit = isLit(adcode);
          g.classList.toggle('lit', lit);
          g.classList.remove('pk-solo', 'pk-family');
          g.style.removeProperty('--pk-color');
          const name = g.getAttribute('data-name') || '';
          g.setAttribute('aria-label', `${name}，${lit ? '已点亮' : '未点亮'}`);
          g.setAttribute('aria-pressed', lit ? 'true' : 'false');
        }
      }
      if (cityLayer && isCityLit) {
        for (const [cadcode, cg] of cityGroups) {
          const lit = isCityLit(cadcode);
          cg.classList.toggle('lit', lit);
          const cname = cg.getAttribute('data-name') || '';
          cg.setAttribute('aria-label', `${cname}，${lit ? '已点亮' : '未点亮'}`);
          cg.setAttribute('aria-pressed', lit ? 'true' : 'false');
        }
      }
    },
    /** 单个城市状态更新 */
    updateCity(adcode, lit) {
      const cg = cityGroups.get(String(adcode));
      if (cg) {
        cg.classList.toggle('lit', lit);
        const cname = cg.getAttribute('data-name') || '';
        cg.setAttribute('aria-label', `${cname}，${lit ? '已点亮' : '未点亮'}`);
        cg.setAttribute('aria-pressed', lit ? 'true' : 'false');
      }
    },
    /** 点亮时的光晕爆发（一次性） */
    burst(x, y) {
      const c = el('circle', { cx: x, cy: y, r: 8, class: 'burst-ring' });
      burstLayer.appendChild(c);
      c.addEventListener('animationend', () => c.remove());
    },
    /** 下钻平滑聚焦到指定省份 */
    drillDown(provinceFeature, cities, isCityLit) {
      activeDrilledAdcode = String(provinceFeature.properties.adcode);

      // 计算地理 bbox 并根据 SVG 宽高比等比居中留白
      const [[minLng, minLat], [maxLng, maxLat]] = geoBounds(provinceFeature);
      const p0 = projection([minLng, maxLat]);
      const p1 = projection([maxLng, minLat]);
      const bx0 = Math.min(p0[0], p1[0]);
      const by0 = Math.min(p0[1], p1[1]);
      const bx1 = Math.max(p0[0], p1[0]);
      const by1 = Math.max(p0[1], p1[1]);
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;

      let bw = Math.max(bx1 - bx0, 20) * 1.35;
      let bh = Math.max(by1 - by0, 20) * 1.35;
      const aspect = W / H;
      if (bw / bh > aspect) {
        bh = bw / aspect;
      } else {
        bw = bh * aspect;
      }
      const targetBox = [cx - bw / 2, cy - bh / 2, bw, bh];

      // 阻尼插值过渡 viewBox
      animateViewBox(targetBox, 600);

      // 背景省份隐入 0.2 透明度
      layer.classList.add('drilled');
      for (const [code, g] of groups) {
        g.classList.toggle('active-drilled', code === activeDrilledAdcode);
      }

      // 渲染城市层
      if (cityLayer) {
        cityLayer.remove();
        cityGroups.clear();
      }
      cityLayer = el('g', { class: 'city-layer' });
      for (const cf of cities) {
        const cadcode = String(cf.properties.adcode);
        const cname = cf.properties.name;
        const lit = isCityLit(cadcode);
        const cg = el('g', {
          class: `city ${lit ? 'lit' : ''}`,
          role: 'button',
          tabindex: '0',
          'data-adcode': cadcode,
          'data-name': cname,
          'aria-label': `${cname}，${lit ? '已点亮' : '未点亮'}`,
          'aria-pressed': lit ? 'true' : 'false',
        });

        const cvis = el('path', { d: path(cf), class: 'cvis' });
        cg.appendChild(cvis);

        cg.addEventListener('mouseenter', (e) => cbs.onCityHover && cbs.onCityHover(cf, e));
        cg.addEventListener('mousemove', (e) => cbs.onCityHover && cbs.onCityHover(cf, e));
        cg.addEventListener('mouseleave', () => cbs.onCityLeave && cbs.onCityLeave());

        cg.addEventListener('click', (e) => {
          e.stopPropagation();
          const pt = svgPoint(svg, e);
          if (cbs.onCityTap) cbs.onCityTap(cf, pt.x, pt.y, e.clientX, e.clientY);
        });

        // 城市双击：桌面端 dblclick
        cg.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (cbs.onCityDblClick) cbs.onCityDblClick(cf, e);
        });

        // 城市双击：移动端 300ms 双击识别
        let lastCityTouchEndTime = 0;
        cg.addEventListener('touchend', (e) => {
          const now = Date.now();
          if (now - lastCityTouchEndTime <= 300) {
            lastCityTouchEndTime = 0;
            if (cbs.onCityDblTap) cbs.onCityDblTap(cf, e);
          } else {
            lastCityTouchEndTime = now;
          }
        }, { passive: true });

        cg.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();
            let cx = 0, cy = 0;
            try {
              const pt = projection(geoCentroid(cf));
              if (pt && !isNaN(pt[0]) && !isNaN(pt[1])) [cx, cy] = pt;
            } catch {}
            const rect = cg.getBoundingClientRect ? cg.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            if (cbs.onCityTap) cbs.onCityTap(cf, cx, cy, clientX, clientY);
          }
        });

        cityLayer.appendChild(cg);
        cityGroups.set(cadcode, cg);
      }

      svg.insertBefore(cityLayer, burstLayer);
      requestAnimationFrame(() => {
        if (cityLayer) cityLayer.classList.add('show');
      });
    },
    /** 平滑拉回全国视图 */
    returnToNational(targetProvinceAdcode, onComplete) {
      animateViewBox([0, 0, W, H], 600, () => {
        if (cityLayer) {
          cityLayer.remove();
          cityLayer = null;
          cityGroups.clear();
        }
        if (targetProvinceAdcode && groups.has(targetProvinceAdcode)) {
          try {
            groups.get(targetProvinceAdcode).focus();
          } catch {}
        }
        if (onComplete) onComplete();
      });

      layer.classList.remove('drilled');
      for (const [, g] of groups) {
        g.classList.remove('active-drilled');
      }

      if (cityLayer) {
        cityLayer.classList.remove('show');
      }
      activeDrilledAdcode = null;
    },
    /** 聚焦省份节点（无障碍适配） */
    focusProvince(adcode) {
      const g = groups.get(String(adcode));
      if (g && typeof g.focus === 'function') {
        try { g.focus(); } catch {}
      }
    },
    /**
     * 5A 模式：平滑聚焦到指定省份地理范围（不渲染城市层）
     * @param {Object} provinceFeature GeoJSON 要素
     */
    focusFeature(provinceFeature) {
      if (!provinceFeature) return;
      const [[minLng, minLat], [maxLng, maxLat]] = geoBounds(provinceFeature);
      const p0 = projection([minLng, maxLat]);
      const p1 = projection([maxLng, minLat]);
      const bx0 = Math.min(p0[0], p1[0]);
      const by0 = Math.min(p0[1], p1[1]);
      const bx1 = Math.max(p0[0], p1[0]);
      const by1 = Math.max(p0[1], p1[1]);
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;
      let bw = Math.max(bx1 - bx0, 20) * 1.35;
      let bh = Math.max(by1 - by0, 20) * 1.35;
      const aspect = W / H;
      if (bw / bh > aspect) {
        bh = bw / aspect;
      } else {
        bw = bh * aspect;
      }
      animateViewBox([cx - bw / 2, cy - bh / 2, bw, bh], 600);
    },
    /** 返回全国视图（5A 模式用，不触碰城市层） */
    zoomToNational() {
      animateViewBox([0, 0, W, H], 600);
    },
    /** 暴露 svg 供 5A 散点层挂载 */
    getSvg() {
      return svg;
    },
    isDrilled() {
      return Boolean(activeDrilledAdcode);
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
