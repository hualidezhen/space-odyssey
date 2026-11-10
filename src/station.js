// ===========================================================================
// 深空方舟 · 空间站（station.js）
//
// 程序化建模 + 可拆解交互。全部几何由 three.js 原生 primitive 拼装，
// 全部贴图由 Canvas2D 现场绘制（不联网、不加载外部资源）。
//
// 对外接口（见 docs/CONTRACT.md）：
//   createStation(scene, { quality })
//     -> { group, modules, focusPoint, update, raycast,
//          setHover, setSelected, toggleExplode, setExploded,
//          explodeAmount, detach, attach, isDetached }
//
// 坐标约定：局部坐标为站体几何中心；group.position 由 main.js 每帧设为
// world.stationAnchor；站体总跨度约 2.4 世界单位（地球半径 3.2）。
// ===========================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

const UP = new THREE.Vector3(0, 1, 0);
const SUN_FALLBACK = new THREE.Vector3(-0.92, 0.22, 0.32).normalize();

// 固定种子伪随机：保证每次刷新纹理一致
function rngFactory(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HAS_CANVAS = (() => {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    return !!(c && c.getContext && c.getContext('2d'));
  } catch (e) {
    return false;
  }
})();

function canvasTex(w, h, draw, repeat) {
  if (!HAS_CANVAS) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

// ---------------------------------------------------------------------------
// 程序化贴图
// ---------------------------------------------------------------------------

// 通用船体：8x8 面板 + 铆钉 + 污渍 + 少量橙色/青色结构标记
function drawHull(g, w, h) {
  const rnd = rngFactory(20260401);
  g.fillStyle = '#7d8794';
  g.fillRect(0, 0, w, h);

  const cols = 8;
  const rows = 8;
  const cw = w / cols;
  const ch = h / rows;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = 0.8 + rnd() * 0.3;
      g.fillStyle = 'rgb(' + ((125 * v) | 0) + ',' + ((135 * v) | 0) + ',' + ((146 * v) | 0) + ')';
      g.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);

      const n = 2 + ((rnd() * 3) | 0);
      for (let i = 0; i < n; i++) {
        g.fillStyle = 'rgba(255,255,255,' + (0.03 + rnd() * 0.05).toFixed(3) + ')';
        g.fillRect(
          x * cw + 3 + rnd() * (cw - 14),
          y * ch + 3 + i * (ch / n),
          (cw - 10) * (0.4 + rnd() * 0.5),
          (ch / n) * 0.5
        );
      }
      if (rnd() < 0.14) {
        g.fillStyle = 'rgba(26,32,40,0.45)';
        g.fillRect(x * cw + 3, y * ch + 3, cw - 6, ch - 6);
      }
      if (rnd() < 0.1) {
        g.fillStyle = 'rgba(200,120,50,0.5)';
        g.fillRect(x * cw + 6, y * ch + 6, cw * 0.25, ch * 0.12);
      }
      if (rnd() < 0.07) {
        g.fillStyle = 'rgba(90,200,220,0.4)';
        g.fillRect(x * cw + 6, y * ch + ch * 0.7, cw * 0.4, ch * 0.06);
      }
    }
  }

  g.strokeStyle = 'rgba(40,47,55,0.85)';
  g.lineWidth = 2;
  for (let i = 0; i <= cols; i++) {
    g.beginPath();
    g.moveTo(i * cw, 0);
    g.lineTo(i * cw, h);
    g.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    g.beginPath();
    g.moveTo(0, i * ch);
    g.lineTo(w, i * ch);
    g.stroke();
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (let k = 0; k < 4; k++) {
        const rx = x * cw + (k % 2 ? cw - 8 : 6);
        const ry = y * ch + (k < 2 ? 6 : ch - 8);
        g.fillStyle = 'rgba(215,225,235,0.35)';
        g.beginPath();
        g.arc(rx, ry, 1.6, 0, 7);
        g.fill();
        g.fillStyle = 'rgba(20,25,32,0.4)';
        g.beginPath();
        g.arc(rx + 1, ry + 1, 1.2, 0, 7);
        g.fill();
      }
    }
  }

  for (let i = 0; i < 16; i++) {
    const cx = rnd() * w;
    const cy = rnd() * h;
    const r = 20 + rnd() * 60;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0, 'rgba(16,20,26,0.30)');
    grd.addColorStop(1, 'rgba(16,20,26,0)');
    g.fillStyle = grd;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}

// 太阳能板：深蓝紫电池片 + 金色栅线 + 斜向反光
function drawSolar(g, w, h) {
  const rnd = rngFactory(90210);
  g.fillStyle = '#080d1e';
  g.fillRect(0, 0, w, h);

  const cols = 8;
  const rows = 8;
  const cw = w / cols;
  const ch = h / rows;
  const palette = ['#131f45', '#1a2450', '#221a4e', '#0e1730', '#2a2058'];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      g.fillStyle = palette[(rnd() * palette.length) | 0];
      g.fillRect(x * cw + 3, y * ch + 3, cw - 6, ch - 6);
      g.strokeStyle = 'rgba(140,170,255,0.10)';
      g.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(x * cw + 3, y * ch + 8 + i * 10);
        g.lineTo(x * cw + cw - 3, y * ch + 8 + i * 10);
        g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(x * cw + 4, y * ch + 4, (cw - 8) * 0.5, 3);
    }
  }

  g.strokeStyle = 'rgba(206,164,84,0.85)';
  g.lineWidth = 2;
  for (let i = 0; i <= cols; i++) {
    g.beginPath();
    g.moveTo(i * cw, 0);
    g.lineTo(i * cw, h);
    g.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    g.beginPath();
    g.moveTo(0, i * ch);
    g.lineTo(w, i * ch);
    g.stroke();
  }

  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, 'rgba(190,220,255,0.14)');
  grd.addColorStop(0.35, 'rgba(190,220,255,0)');
  grd.addColorStop(0.65, 'rgba(190,220,255,0.10)');
  grd.addColorStop(1, 'rgba(190,220,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = '#d9b06a';
  g.lineWidth = 6;
  g.strokeRect(3, 3, w - 6, h - 6);
}

// 警示条纹：橙黑 45°
function drawHazard(g, w, h) {
  g.fillStyle = '#14171c';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#d9772a';
  const st = 28;
  for (let i = -h; i < w + h; i += st * 2) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + st, 0);
    g.lineTo(i + st + h, h);
    g.lineTo(i + h, h);
    g.closePath();
    g.fill();
  }
  const rnd = rngFactory(4242);
  for (let i = 0; i < 44; i++) {
    g.fillStyle = 'rgba(20,23,28,' + (0.15 + rnd() * 0.35).toFixed(3) + ')';
    g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 8, 1 + rnd() * 3);
  }
}

// 舷窗（自发光贴图）：暗底 + 两排暖光窗
function drawWindows(g, w, h) {
  g.fillStyle = '#04060a';
  g.fillRect(0, 0, w, h);
  const rnd = rngFactory(555);
  const rowsY = [h * 0.3, h * 0.7];
  for (let r = 0; r < rowsY.length; r++) {
    const y = rowsY[r];
    for (let x = 8; x < w - 8; x += 26) {
      if (rnd() < 0.2) continue;
      const cool = rnd() < 0.12;
      g.shadowColor = cool ? '#7fd6ff' : '#ffb066';
      g.shadowBlur = 9;
      g.fillStyle = cool ? '#bfeaff' : rnd() < 0.3 ? '#ffe1b3' : '#ffc084';
      g.fillRect(x, y, 13, 7);
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x + 6, y, 1, 7);
    }
  }
  g.fillStyle = '#000000';
  g.fillRect(0, 0, w, 3);
  g.fillRect(0, h - 3, w, 3);
}

// 实验舱舷窗：单排大窗，偏冷白
function drawWindowsLab(g, w, h) {
  g.fillStyle = '#03050a';
  g.fillRect(0, 0, w, h);
  const rnd = rngFactory(7777);
  for (let x = 10; x < w - 10; x += 40) {
    if (rnd() < 0.16) continue;
    g.shadowColor = rnd() < 0.4 ? '#8fe0ff' : '#ffcf9a';
    g.shadowBlur = 12;
    g.fillStyle = rnd() < 0.4 ? '#d8f4ff' : '#ffd9a8';
    g.fillRect(x, h * 0.42, 24, 14);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x + 11, h * 0.42, 2, 14);
  }
  g.fillStyle = '#000000';
  g.fillRect(0, 0, w, 4);
  g.fillRect(0, h - 4, w, 4);
}

// 结构编号贴花
function drawDecal(g, w, h, title, sub) {
  g.fillStyle = '#171d25';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#b98a44';
  g.lineWidth = 5;
  g.strokeRect(5, 5, w - 10, h - 10);
  g.strokeStyle = 'rgba(185,138,68,0.5)';
  g.lineWidth = 2;
  g.strokeRect(14, 14, w - 28, h - 28);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#e8dcc0';
  g.font = 'bold 42px "Courier New", monospace';
  g.fillText(title, w / 2, h * 0.43);
  g.fillStyle = '#c9a15a';
  g.font = 'bold 17px "Courier New", monospace';
  g.fillText(sub, w / 2, h * 0.72);
}

// 程序化环境立方体贴图（无 envMap 时金属会发黑，这里给一层冷色天光 + 恒星亮斑）
function drawEnvFace(g, w, h, kind) {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#3c4d63');
  grd.addColorStop(0.55, '#16202c');
  grd.addColorStop(1, '#070a10');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);

  const rnd = rngFactory(1000 + kind);
  for (let i = 0; i < 20; i++) {
    g.fillStyle = 'rgba(200,220,255,' + (0.12 + rnd() * 0.5).toFixed(3) + ')';
    const s = rnd() < 0.15 ? 2 : 1;
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }

  if (kind === 1) {
    // -X 方向：恒星
    const cx = w * 0.62;
    const cy = h * 0.34;
    const sun = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.9);
    sun.addColorStop(0, '#fffdf4');
    sun.addColorStop(0.1, '#ffeec2');
    sun.addColorStop(0.34, 'rgba(220,200,170,0.5)');
    sun.addColorStop(1, 'rgba(70,110,170,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(40,80,150,0.35)';
    g.fillRect(0, h * 0.72, w, h * 0.28);
  } else if (kind === 4) {
    g.fillStyle = 'rgba(70,110,170,0.18)';
    g.fillRect(0, h * 0.6, w, h * 0.4);
  }
}

// ---------------------------------------------------------------------------
// 几何缓存
// ---------------------------------------------------------------------------
const GEO = new Map();
function keyed(key, fn) {
  let g = GEO.get(key);
  if (!g) {
    g = fn();
    GEO.set(key, g);
  }
  return g;
}
const boxGeo = () => keyed('box', () => new THREE.BoxGeometry(1, 1, 1));
const planeGeo = () => keyed('plane', () => new THREE.PlaneGeometry(1, 1));
const sphereGeo = () => keyed('sphere', () => new THREE.SphereGeometry(1, 18, 14));
const circleGeo = () => keyed('circle', () => new THREE.CircleGeometry(1, 28));
const capsuleGeo = () => keyed('capsule', () => new THREE.CapsuleGeometry(1, 1, 6, 14));
const cylGeo = (seg = 20, open = false) =>
  keyed('cyl' + seg + '_' + open, () => new THREE.CylinderGeometry(1, 1, 1, seg, 1, open));
const coneGeo = (seg = 20, open = true) =>
  keyed('cone' + seg + '_' + open, () => new THREE.ConeGeometry(1, 1, seg, 1, open));
const taperGeo = (rTop, rBot, seg = 20) =>
  keyed('taper_' + rTop.toFixed(3) + '_' + rBot.toFixed(3) + '_' + seg, () =>
    new THREE.CylinderGeometry(rTop, rBot, 1, seg, 1, false)
  );
const torusGeo = (R, tube, radial = 8, tubular = 36) =>
  keyed('torus_' + R.toFixed(3) + '_' + tube.toFixed(3) + '_' + radial + '_' + tubular, () =>
    new THREE.TorusGeometry(R, tube, radial, tubular)
  );
// 抛物面天线（Lathe 旋转成型，开口朝 +Y）
const dishGeo = () =>
  keyed('dish', () => {
    const pts = [];
    const N = 14;
    const R = 0.16;
    for (let i = 0; i <= N; i++) {
      const r = (i / N) * R;
      pts.push(new THREE.Vector2(i === 0 ? 0.004 : r, 0.062 * (r / R) * (r / R)));
    }
    return new THREE.LatheGeometry(pts, 36);
  });

// ===========================================================================
// createStation
// ===========================================================================
export function createStation(scene, opts = {}) {
  const quality = opts.quality || 'high';
  const rich = quality !== 'low';

  // ---- 贴图 ----
  const T = {};
  T.hull = canvasTex(512, 512, drawHull);
  T.hullCyl = T.hull ? T.hull.clone() : null;
  if (T.hullCyl) {
    T.hullCyl.repeat.set(2, 1);
    T.hullCyl.needsUpdate = true;
  }
  T.solar = canvasTex(512, 512, drawSolar);
  T.hazard = canvasTex(128, 128, drawHazard, [2, 1]);
  T.windows = canvasTex(512, 128, drawWindows, [2, 1]);
  T.windowsLab = canvasTex(256, 128, drawWindowsLab);
  T.decals = [
    canvasTex(256, 128, (g, w, h) => drawDecal(g, w, h, 'ARK-01', 'SECTOR 04 · CORE')),
    canvasTex(256, 128, (g, w, h) => drawDecal(g, w, h, 'SECTOR 04', 'HABITAT RING A/B')),
    canvasTex(256, 128, (g, w, h) => drawDecal(g, w, h, 'DOCK 07', 'BERTH · SOFT CAPTURE')),
    canvasTex(256, 128, (g, w, h) => drawDecal(g, w, h, 'DANGER', 'HIGH VOLTAGE · TRUSS')),
  ];

  // ---- 环境贴图：优先使用场景自带，否则自建程序化 cube ----
  let envTex = scene && scene.environment ? scene.environment : null;
  if (!envTex && HAS_CANVAS) {
    const faces = [];
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d');
      if (g) drawEnvFace(g, 64, 64, i);
      faces.push(c);
    }
    envTex = new THREE.CubeTexture(faces);
    envTex.colorSpace = THREE.SRGBColorSpace;
    envTex.needsUpdate = true;
  }

  // ---- 材质模板 ----
  const S = (o) => new THREE.MeshStandardMaterial(o);
  const envOpt = envTex ? { envMap: envTex } : {};
  const M = {
    hull: S(Object.assign({ map: T.hull, color: T.hull ? 0xffffff : 0xa8b3c0, metalness: 0.86, roughness: 0.38, emissive: new THREE.Color(0x1b2d3c), emissiveIntensity: 0.62, envMapIntensity: 1.25 }, envOpt)),
    hullDark: S(Object.assign({ map: T.hull, color: 0x6b7682, metalness: 0.9, roughness: 0.42, emissive: new THREE.Color(0x131f2a), emissiveIntensity: 0.55, envMapIntensity: 1.0 }, envOpt)),
    core: S(Object.assign({ map: T.hullCyl, color: T.hullCyl ? 0xffffff : 0xb0bac6, metalness: 0.88, roughness: 0.34, emissiveMap: T.windows, emissive: new THREE.Color(0xffa56a), emissiveIntensity: 1.05, envMapIntensity: 1.3 }, envOpt)),
    lab: S(Object.assign({ map: T.hull, color: 0xd6dee7, metalness: 0.86, roughness: 0.36, emissiveMap: T.windowsLab, emissive: new THREE.Color(0xffc48a), emissiveIntensity: 1.0, envMapIntensity: 1.2 }, envOpt)),
    trim: S(Object.assign({ color: 0xdde4ec, metalness: 0.95, roughness: 0.26, emissive: new THREE.Color(0x1b2936), emissiveIntensity: 0.6, envMapIntensity: 1.5 }, envOpt)),
    gold: S(Object.assign({ color: 0xd8a24a, metalness: 0.95, roughness: 0.3, emissive: new THREE.Color(0x2a1f10), emissiveIntensity: 0.45, envMapIntensity: 1.6 }, envOpt)),
    solar: S(Object.assign({ map: T.solar, color: 0xffffff, metalness: 0.55, roughness: 0.34, emissiveMap: T.solar, emissive: new THREE.Color(0x0d1834), emissiveIntensity: 0.55, envMapIntensity: 1.35 }, envOpt)),
    radiator: S(Object.assign({ color: 0xd2dae4, metalness: 0.72, roughness: 0.44, emissive: new THREE.Color(0x18242e), emissiveIntensity: 0.55, envMapIntensity: 0.9 }, envOpt)),
    dark: S(Object.assign({ color: 0x2b313b, metalness: 0.9, roughness: 0.4, emissive: new THREE.Color(0x101820), emissiveIntensity: 0.5, envMapIntensity: 0.8 }, envOpt)),
    darkDouble: S(Object.assign({ color: 0x2b313b, metalness: 0.9, roughness: 0.4, side: THREE.DoubleSide, emissive: new THREE.Color(0x101820), emissiveIntensity: 0.5, envMapIntensity: 0.8 }, envOpt)),
    hazard: S(Object.assign({ map: T.hazard, metalness: 0.6, roughness: 0.5, emissiveMap: T.hazard, emissive: new THREE.Color(0xff7a22), emissiveIntensity: 0.5, envMapIntensity: 0.9 }, envOpt)),
    window: S({ color: 0x05070b, emissive: new THREE.Color(0xffb066), emissiveIntensity: 1.15, metalness: 0.25, roughness: 0.34 }),
    windowCool: S({ color: 0x05070b, emissive: new THREE.Color(0x7fe0ff), emissiveIntensity: 0.95, metalness: 0.25, roughness: 0.34 }),
    cyan: S({ color: 0x0a1418, emissive: new THREE.Color(0x4fe6ff), emissiveIntensity: 1.1, metalness: 0.4, roughness: 0.36 }),
    orange: S({ color: 0x1a0f06, emissive: new THREE.Color(0xff8a2a), emissiveIntensity: 0.95, metalness: 0.35, roughness: 0.42 }),
    engine: S({ color: 0x0b1a22, emissive: new THREE.Color(0x7fe6ff), emissiveIntensity: 1.05, metalness: 0.5, roughness: 0.4 }),
    dish: S(Object.assign({ color: 0xcdd6de, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide, emissive: new THREE.Color(0x1a2833), emissiveIntensity: 0.55, envMapIntensity: 1.45 }, envOpt)),
    decals: T.decals.map((tex) =>
      S(Object.assign({ map: tex, color: tex ? 0xffffff : 0x8f9aa6, metalness: 0.4, roughness: 0.5, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, envOpt))
    ),
  };

  // 大面积材质（太阳翼 / 散热板 / 金色骨架）高亮更克制，避免整片泛青成色块
  M.solar.userData.hlScale = 0.3;
  M.radiator.userData.hlScale = 0.55;
  M.gold.userData.hlScale = 0.6;

  // ---- 场景骨架 ----
  const group = new THREE.Group();
  group.name = 'deep-ark-station';
  const modules = [];
  const moduleById = new Map();
  const pickables = [];
  const ringSpinners = [];
  const wings = [];

  let hovered = null;
  let selected = null;
  let explodeTarget = 0;
  let explodeCur = 0;

  const focusPoint = new THREE.Vector3(0, 0.03, 0.03);

  // ---- 材质实例（每个模块独立 clone，保证高亮互不串色）----
  function matFor(m, tpl) {
    let mat = m.matCache.get(tpl);
    if (!mat) {
      mat = tpl.clone();
      mat.userData.baseEmissive = mat.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0);
      mat.userData.baseIntensity = mat.emissiveIntensity;
      mat.userData.hlScale = tpl.userData && tpl.userData.hlScale ? tpl.userData.hlScale : 1;
      m.mats.push(mat);
      m.matCache.set(tpl, mat);
    }
    return mat;
  }

  function reg(m, obj) {
    obj.userData.moduleId = m.id;
    pickables.push(obj);
  }

  // ---- 几何装配辅助 ----
  function addMesh(m, parent, geo, tpl, p, r, s) {
    const o = new THREE.Mesh(geo, matFor(m, tpl));
    if (p) o.position.set(p[0], p[1], p[2]);
    if (r) o.rotation.set(r[0] || 0, r[1] || 0, r[2] || 0);
    if (s) o.scale.set(s[0], s[1], s[2]);
    parent.add(o);
    reg(m, o);
    return o;
  }
  function addBox(m, parent, tpl, p, s, r) {
    return addMesh(m, parent, boxGeo(), tpl, p, r, s);
  }
  function addCyl(m, parent, tpl, p, radius, height, seg, r, open) {
    return addMesh(m, parent, cylGeo(seg || 20, !!open), tpl, p, r, [radius, height, radius]);
  }
  function addCone(m, parent, tpl, p, radius, height, seg, r, open) {
    return addMesh(m, parent, coneGeo(seg || 20, open !== false), tpl, p, r, [radius, height, radius]);
  }
  function addTorus(m, parent, tpl, p, R, tube, r, radial, tubular) {
    return addMesh(m, parent, torusGeo(R, tube, radial || 8, tubular || 36), tpl, p, r);
  }
  function addSphere(m, parent, tpl, p, radius, s) {
    return addMesh(m, parent, sphereGeo(), tpl, p, null, s || [radius, radius, radius]);
  }
  function addDecal(m, parent, idx, p, r, w, h) {
    return addMesh(m, parent, planeGeo(), M.decals[idx % M.decals.length], p, r, [w, h, 1]);
  }

  // 两点之间的杆件（单件）
  function addRod(m, parent, tpl, a, b, thick) {
    const A = new THREE.Vector3(a[0], a[1], a[2]);
    const B = new THREE.Vector3(b[0], b[1], b[2]);
    const d = new THREE.Vector3().subVectors(B, A);
    const len = d.length();
    d.normalize();
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const o = new THREE.Mesh(boxGeo(), matFor(m, tpl));
    o.position.copy(mid);
    o.scale.set(thick, len, thick);
    o.quaternion.setFromUnitVectors(UP, d);
    parent.add(o);
    reg(m, o);
    return o;
  }

  // 批量杆件：bars = [[ax,ay,az, bx,by,bz, thick], ...]，合并成 1 个 InstancedMesh
  function addBars(m, parent, tpl, bars) {
    const list = bars.map((b) => {
      const A = new THREE.Vector3(b[0], b[1], b[2]);
      const B = new THREE.Vector3(b[3], b[4], b[5]);
      const d = new THREE.Vector3().subVectors(B, A);
      const len = d.length();
      d.normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
      const e = new THREE.Euler().setFromQuaternion(q);
      const mid = A.clone().add(B).multiplyScalar(0.5);
      const t = b[6] || 0.008;
      return [mid.x, mid.y, mid.z, e.x, e.y, e.z, t, len, t];
    });
    return addInstanced(m, parent, boxGeo(), tpl, list);
  }

  // 实例化：list = [[x,y,z, rx,ry,rz, sx,sy,sz], ...]
  function addInstanced(m, parent, geo, tpl, list) {
    const count = list.length;
    const im = new THREE.InstancedMesh(geo, matFor(m, tpl), count);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const e = new THREE.Euler();
    for (let i = 0; i < count; i++) {
      const a = list[i];
      pos.set(a[0] || 0, a[1] || 0, a[2] || 0);
      e.set(a[3] || 0, a[4] || 0, a[5] || 0);
      q.setFromEuler(e);
      const sx = a[6] === undefined ? 1 : a[6];
      const sy = a[7] === undefined ? 1 : a[7];
      const sz = a[8] === undefined ? 1 : a[8];
      scl.set(sx, sy, sz);
      mtx.compose(pos, q, scl);
      im.setMatrixAt(i, mtx);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.computeBoundingSphere) im.computeBoundingSphere();
    parent.add(im);
    reg(m, im);
    return im;
  }

  // 航行灯（红/绿闪烁），材质不进高亮池
  function addNav(m, parent, p, color, phase, speed) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      emissive: new THREE.Color(color),
      emissiveIntensity: 1.0,
      metalness: 0.2,
      roughness: 0.5,
    });
    const o = new THREE.Mesh(boxGeo(), mat);
    o.position.set(p[0], p[1], p[2]);
    o.scale.set(0.012, 0.012, 0.012);
    parent.add(o);
    reg(m, o);
    m.navLights.push({ mat: mat, phase: phase, speed: speed });
    return o;
  }

  // ---- 模块收尾：包围盒描边 ----
  function finish(m, b) {
    const geo = new THREE.BoxGeometry(b[0] * 1.06, b[1] * 1.06, b[2] * 1.06);
    const eg = new THREE.EdgesGeometry(geo);
    geo.dispose();
    const mat = new THREE.LineBasicMaterial({
      color: 0x7fe6f2,
      transparent: true,
      opacity: 0.34,
      linewidth: 1,
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(eg, mat);
    line.position.set(b[3] || 0, b[4] || 0, b[5] || 0);
    line.renderOrder = 18;
    line.visible = false;
    line.frustumCulled = false;
    m.object.add(line);
    m.outline = line;
    m.outlineMat = mat;
  }

  // ---- 模块注册 ----
  function makeModule(def) {
    const object = new THREE.Group();
    object.name = 'mod-' + def.id;
    object.position.set(def.pos[0], def.pos[1], def.pos[2]);
    if (def.rot) object.rotation.set(def.rot[0] || 0, def.rot[1] || 0, def.rot[2] || 0);
    group.add(object);

    const m = {
      id: def.id,
      name: def.cn,
      cn: def.cn,
      en: def.en,
      desc: def.desc,
      stat: def.stat,
      object: object,
      basePos: object.position.clone(),
      baseQuat: object.quaternion.clone(),
      dir: new THREE.Vector3(def.dir[0], def.dir[1], def.dir[2]).normalize(),
      dist: def.dist,
      tiltAxis: new THREE.Vector3(def.tiltAxis[0], def.tiltAxis[1], def.tiltAxis[2]).normalize(),
      tiltAngle: def.tiltAngle,
      spinAxis: new THREE.Vector3(def.spinAxis[0], def.spinAxis[1], def.spinAxis[2]).normalize(),
      spinSpeed: def.spinSpeed,
      progress: 0,
      own: 0,
      spinAngle: 0,
      detachedTarget: false,
      globalOff: false,
      mats: [],
      matCache: new Map(),
      navLights: [],
      hl: 0,
      outline: null,
      outlineMat: null,
      tracker: null,
      trackerAngle: 0,
    };
    modules.push(m);
    moduleById.set(m.id, m);
    return m;
  }

  // =========================================================================
  // 01 中央增压核心舱
  // =========================================================================
  function buildCore() {
    const m = makeModule({
      id: 'core-hab',
      cn: '中央增压核心舱',
      en: 'CENTRAL CORE',
      desc: '全站气压与生命的锚点。六道环肋箍住长舱，舷窗在暗面透出暖光——人们在这里呼吸、交班、等一封横跨三光年的家书。',
      stat: 'CREW 168 · 1.00 ATM',
      pos: [0, 0, 0],
      dir: [0, 0, 1],
      dist: 1.0,
      tiltAxis: [0, 1, 0],
      tiltAngle: 0.14,
      spinAxis: [0.2, 1, 0.1],
      spinSpeed: 0.18,
    });
    const o = m.object;

    addCyl(m, o, M.core, [0, 0, 0], 0.155, 0.5, 28, [Math.PI / 2, 0, 0]);

    // 环肋
    const ribs = [];
    for (let i = 0; i < 7; i++) ribs.push([0, 0, -0.21 + i * 0.07, 0, 0, 0]);
    addInstanced(m, o, torusGeo(0.158, 0.01, 6, 28), M.trim, ribs);

    // 三排舷窗
    const wins = [];
    for (let r = 0; r < 3; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2 + r * 0.26;
        wins.push([Math.cos(ang) * 0.156, Math.sin(ang) * 0.156, -0.12 + r * 0.12, 0, 0, ang, 0.016, 0.012, 0.03]);
      }
    }
    addInstanced(m, o, boxGeo(), M.window, wins);

    // 背脊
    addBox(m, o, M.trim, [0, 0.158, 0], [0.052, 0.03, 0.46]);
    // 腹侧导管
    addBars(m, o, M.dark, [
      [-0.09, -0.135, -0.2, -0.09, -0.135, 0.2, 0.014],
      [0.09, -0.135, -0.2, 0.09, -0.135, 0.2, 0.014],
    ]);

    // 端部收口（锥形过渡，避免台阶缝隙）
    addInstanced(m, o, taperGeo(0.118, 0.158, 24), M.hullDark, [
      [0, 0, 0.2725, Math.PI / 2, 0, 0, 1, 0.045, 1],
      [0, 0, -0.2725, -Math.PI / 2, 0, 0, 1, 0.045, 1],
    ]);

    // 结构编号贴花
    addDecal(m, o, 0, [0.158, 0.02, 0.1], [0, Math.PI / 2, 0], 0.085, 0.045);
    addDecal(m, o, 1, [-0.158, 0.02, 0.1], [0, -Math.PI / 2, 0], 0.075, 0.04);

    // 抓握扶手
    const rails = [];
    for (let a = 0; a < 4; a++) {
      const ang = Math.PI / 4 + (a * Math.PI) / 2;
      rails.push([Math.cos(ang) * 0.164, Math.sin(ang) * 0.164, 0, 0, 0, ang, 0.008, 0.01, 0.34]);
    }
    addInstanced(m, o, boxGeo(), M.dark, rails);

    addNav(m, o, [0.0, 0.176, 0.24], 0xff3322, 0, 3.0);
    addNav(m, o, [0.0, 0.176, -0.24], 0x44ff88, 1.6, 3.0);

    finish(m, [0.44, 0.44, 0.64, 0, 0, 0]);
  }

  // =========================================================================
  // 02/03 双旋转居住环
  // =========================================================================
  function buildRing(def) {
    const m = makeModule(def);
    const o = m.object;
    const spin = new THREE.Group();
    spin.name = def.id + '-spin';
    o.add(spin);

    addTorus(m, spin, M.hull, [0, 0, 0], 0.36, 0.038, null, 10, 54);
    addTorus(m, spin, M.hullDark, [0, 0, 0], 0.328, 0.012, null, 6, 44);

    const pods = [];
    const wins = [];
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      pods.push([Math.cos(ang) * 0.368, Math.sin(ang) * 0.368, 0, 0, 0, ang, 0.09, 0.062, 0.115]);
      wins.push([Math.cos(ang) * 0.41, Math.sin(ang) * 0.41, 0, 0, 0, ang, 0.012, 0.022, 0.075]);
    }
    addInstanced(m, spin, boxGeo(), M.hull, pods);
    addInstanced(m, spin, boxGeo(), M.window, wins);

    // 辐条
    const spokes = [];
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2 + 0.2;
      const r = 0.245;
      spokes.push([Math.cos(ang) * r, Math.sin(ang) * r, 0, 0, 0, ang - Math.PI / 2, 0.018, 0.175, 0.018]);
    }
    addInstanced(m, spin, boxGeo(), M.trim, spokes);

    addNav(m, spin, [0.4, 0, 0.05], 0xff3322, 0.4, 2.4);
    addNav(m, spin, [-0.4, 0, -0.05], 0x44ff88, 2.0, 2.4);

    ringSpinners.push({ group: spin, speed: def.spinRate });

    finish(m, [0.88, 0.88, 0.18, 0, 0, 0]);
  }

  // =========================================================================
  // 04-07 十字桁架（沿 X 轴 4 段）
  // =========================================================================
  function buildTruss(def) {
    const m = makeModule(def);
    const o = m.object;
    const len = def.len;
    const half = len / 2;

    const lon = [];
    for (const yy of [0.048, -0.048]) for (const zz of [0.048, -0.048]) lon.push([0, yy, zz, 0, 0, 0, len, 0.011, 0.011]);
    addInstanced(m, o, boxGeo(), M.hullDark, lon);

    // 斜撑（上下两面锯齿）
    const bays = 5;
    const dx = len / bays;
    const diags = [];
    for (let b = 0; b < bays; b++) {
      const x0 = -half + b * dx;
      const sgn = b % 2 === 0 ? 1 : -1;
      const dzs = 0.096 * sgn;
      const L = Math.hypot(dx, dzs);
      for (const yy of [0.048, -0.048]) {
        diags.push([x0 + dx / 2, yy, 0, 0, -Math.atan2(dzs, dx), 0, L, 0.009, 0.009]);
      }
    }
    addInstanced(m, o, boxGeo(), M.trim, diags);

    // 端部框
    const frames = [];
    for (const ex of [-half + 0.012, half - 0.012]) {
      for (const yy of [0.048, -0.048]) frames.push([ex, yy, 0, 0, 0, 0, 0.012, 0.012, 0.108]);
      for (const zz of [0.048, -0.048]) frames.push([ex, 0, zz, 0, 0, 0, 0.012, 0.108, 0.012]);
    }
    addInstanced(m, o, boxGeo(), M.trim, frames);

    // 设备盒 / 走线
    const greeb = [];
    for (let i = 0; i < 10; i++) {
      const x = -half + 0.05 + (i / 10) * len * 0.9;
      greeb.push([x, i % 2 ? 0.058 : -0.058, i % 3 ? 0.055 : -0.055, 0, 0, 0, 0.03 + (i % 3) * 0.012, 0.016, 0.022]);
    }
    addInstanced(m, o, boxGeo(), M.dark, greeb);

    finish(m, [len + 0.06, 0.16, 0.16, 0, 0, 0]);
  }

  // =========================================================================
  // 08/09 端部节点
  // =========================================================================
  function buildNode(def) {
    const m = makeModule(def);
    const o = m.object;
    const sx = def.sign;

    addBox(m, o, M.hull, [0, 0, 0], [0.17, 0.15, 0.15]);
    addInstanced(m, o, boxGeo(), M.hullDark, [
      [0, 0, 0, 0, 0, 0, 0.19, 0.055, 0.055],
      [0, 0, 0, Math.PI / 2, 0, 0, 0.19, 0.055, 0.055],
    ]);

    // 对外接口环
    addCyl(m, o, M.hullDark, [sx * 0.095, 0, 0], 0.055, 0.05, 18, [0, 0, Math.PI / 2]);
    addTorus(m, o, M.hazard, [sx * 0.12, 0, 0], 0.055, 0.012, [0, Math.PI / 2, 0], 6, 28);

    // 四角块与抓具
    const caps = [];
    for (const yy of [0.075, -0.075]) for (const zz of [0.075, -0.075]) caps.push([sx * 0.075, yy, zz, 0, 0, 0, 0.03, 0.03, 0.03]);
    addInstanced(m, o, boxGeo(), M.trim, caps);
    addBars(m, o, M.dark, [
      [-0.04, 0.045, 0.06, 0.05, 0.1, 0.16, 0.008],
      [-0.04, -0.045, 0.06, 0.05, -0.1, 0.16, 0.008],
    ]);

    addDecal(m, o, 3, [0, 0.076, 0], [-Math.PI / 2, 0, 0], 0.11, 0.055);
    addNav(m, o, [0, 0.082, 0.07], 0xff3322, 0.8, 2.8);
    addNav(m, o, [0, 0.082, -0.07], 0x44ff88, 2.4, 2.8);

    finish(m, [0.27, 0.27, 0.27, 0, 0, 0]);
  }

  // =========================================================================
  // 10-13 太阳能翼（每翼 3 块板，太阳跟踪）
  // =========================================================================
  function buildWing(def) {
    const m = makeModule(def);
    const o = m.object;
    const tracker = new THREE.Group();
    tracker.name = def.id + '-tracker';
    o.add(tracker);
    m.tracker = tracker;

    // 桅杆与根部
    addCyl(m, tracker, M.dark, [0, 0, 0.085], 0.014, 0.17, 12, [Math.PI / 2, 0, 0]);
    addBox(m, tracker, M.trim, [0, 0, 0.006], [0.06, 0.05, 0.05]);

    const zs = [0.16, 0.35, 0.54];
    const panels = zs.map((z) => [0, 0, z, 0, 0, 0, 0.3, 0.008, 0.165]);
    const frames = zs.map((z) => [0, 0, z, 0, 0, 0, 0.328, 0.006, 0.192]);
    addInstanced(m, tracker, boxGeo(), M.solar, panels);
    addInstanced(m, tracker, boxGeo(), M.gold, frames);

    addInstanced(m, tracker, boxGeo(), M.trim, [
      [0, 0, 0.112, 0, 0, 0, 0.055, 0.014, 0.05],
      [0, 0, 0.255, 0, 0, 0, 0.32, 0.012, 0.02],
      [0, 0, 0.445, 0, 0, 0, 0.32, 0.012, 0.02],
    ]);

    addNav(m, tracker, [0.14, 0.012, 0.625], 0xff3322, 1.1, 3.2);

    wings.push(m);
    finish(m, [0.36, 0.06, 0.6, 0, 0, 0.33]);
    // 描边挂到跟踪组下，跟随太阳翼一起俯仰
    if (m.outline) {
      tracker.add(m.outline);
      m.outline.position.set(0, 0, 0.33);
    }
  }

  // =========================================================================
  // 14/15 前后对接枢纽
  // =========================================================================
  function buildDock(def) {
    const m = makeModule(def);
    const o = m.object;

    addCyl(m, o, M.hull, [0, 0, -0.04], 0.105, 0.19, 24, [Math.PI / 2, 0, 0]);
    addTorus(m, o, M.hazard, [0, 0, 0.048], 0.112, 0.017, null, 8, 36);
    addTorus(m, o, M.trim, [0, 0, 0.062], 0.086, 0.013, null, 6, 36);
    addMesh(m, o, circleGeo(), M.dark, [0, 0, 0.063], null, [0.078, 0.078, 1]);
    addDecal(m, o, 2, [0, 0, 0.0645], null, 0.085, 0.045);

    const latches = [];
    for (let a = 0; a < 4; a++) {
      const ang = Math.PI / 4 + (a * Math.PI) / 2;
      latches.push([Math.cos(ang) * 0.125, Math.sin(ang) * 0.125, 0.02, 0, 0, ang, 0.03, 0.022, 0.05]);
    }
    addInstanced(m, o, boxGeo(), M.trim, latches);

    const status = [];
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI * 2;
      status.push([Math.cos(ang) * 0.108, Math.sin(ang) * 0.108, -0.03, 0, 0, ang, 0.02, 0.008, 0.008]);
    }
    addInstanced(m, o, boxGeo(), M.cyan, status);

    addNav(m, o, [0.0, 0.128, 0.02], 0xff3322, 0.2, 2.6);
    addNav(m, o, [0.0, -0.128, 0.02], 0x44ff88, 1.8, 2.6);

    finish(m, [0.3, 0.3, 0.26, 0, 0, -0.02]);
  }

  // =========================================================================
  // 16 深空雷达
  // =========================================================================
  function buildRadar() {
    const m = makeModule({
      id: 'radar-dish',
      cn: '深空雷达',
      en: 'DEEP-SPACE RADAR',
      desc: '抛物面天线指向三光年外的母星，仍在扫描那段已经迟到了四十年的回波。',
      stat: 'SCAN · 0.42 AU',
      pos: [0, 0.26, -0.06],
      dir: [0, 1, -0.3],
      dist: 1.15,
      tiltAxis: [1, 0, 0],
      tiltAngle: 0.2,
      spinAxis: [1, 0.3, 0],
      spinSpeed: 0.22,
    });
    const o = m.object;

    addCyl(m, o, M.hullDark, [0, -0.085, 0], 0.05, 0.15, 16);
    addBox(m, o, M.trim, [0, 0.028, 0], [0.07, 0.045, 0.06]);

    const g = new THREE.Group();
    g.rotation.x = 0.42;
    o.add(g);
    addMesh(m, g, dishGeo(), M.dish, [0, 0, 0], null, null);
    addTorus(m, g, M.trim, [0, 0.062, 0], 0.16, 0.007, [Math.PI / 2, 0, 0], 6, 36);

    addBars(m, g, M.trim, [
      [0.0, 0.06, -0.155, 0.0, 0.17, 0.0, 0.007],
      [0.134, 0.06, 0.078, 0.0, 0.17, 0.0, 0.007],
      [-0.134, 0.06, 0.078, 0.0, 0.17, 0.0, 0.007],
    ]);
    addCone(m, g, M.dark, [0, 0.155, 0], 0.022, 0.05, 14, [0, 0, 0]);
    addNav(m, g, [0.0, 0.185, 0.0], 0x44ff88, 0.6, 2.2);

    addBox(m, o, M.dark, [0, -0.045, 0], [0.03, 0.02, 0.15]);

    finish(m, [0.4, 0.3, 0.4, 0, 0.09, 0]);
  }

  // =========================================================================
  // 17 通讯阵列
  // =========================================================================
  function buildComm() {
    const m = makeModule({
      id: 'comm-mast',
      cn: '通讯阵列',
      en: 'COMM ARRAY',
      desc: '相控阵与三根鞭状天线组成的通讯桅杆，每 11 分钟向地球方向压缩一次全站日志。',
      stat: 'UPLINK · 3.4 GB/s',
      pos: [0, 0.26, 0.16],
      dir: [0, 1, 0.3],
      dist: 1.15,
      tiltAxis: [1, 0, 0],
      tiltAngle: 0.18,
      spinAxis: [0.4, 1, 0],
      spinSpeed: 0.26,
    });
    const o = m.object;

    addCyl(m, o, M.trim, [0, 0.13, 0], 0.01, 0.3, 10);
    addBox(m, o, M.hullDark, [0, -0.055, 0], [0.05, 0.11, 0.05]);

    addInstanced(m, o, boxGeo(), M.trim, [
      [0, 0.09, 0, 0, 0, 0, 0.15, 0.008, 0.008],
      [0, 0.16, 0, 0, 0, 0, 0.12, 0.008, 0.008],
      [0, 0.23, 0, 0, 0, 0, 0.09, 0.008, 0.008],
    ]);

    addInstanced(m, o, circleGeo(), M.dish, [
      [0.06, 0.2, 0.02, 0, Math.PI / 2, 0, 0.045, 0.045, 1],
      [-0.05, 0.27, -0.01, 0, -Math.PI / 2, 0, 0.035, 0.035, 1],
    ]);

    addBars(m, o, M.dark, [
      [0.0, 0.28, 0.0, 0.1, 0.42, 0.06, 0.006],
      [0.0, 0.28, 0.0, -0.09, 0.4, -0.07, 0.006],
      [0.0, 0.28, 0.0, 0.02, 0.44, -0.08, 0.006],
    ]);

    addNav(m, o, [0.0, 0.285, 0.0], 0xff3322, 1.4, 3.4);
    addNav(m, o, [0.06, 0.2, 0.06], 0x4fe6ff, 0.3, 1.8);

    finish(m, [0.26, 0.46, 0.26, 0, 0.16, 0]);
  }

  // =========================================================================
  // 18/19 散热阵
  // =========================================================================
  function buildRadiator(def) {
    const m = makeModule(def);
    const o = m.object;
    const sx = def.pos[0] < 0 ? 1 : -1; // 指向核心舱的方向

    addRod(m, o, M.trim, [sx * 0.34, -0.14, 0], [0, 0, 0], 0.014);
    addBox(m, o, M.hullDark, [0, 0, 0], [0.05, 0.05, 0.05]);

    const out = -sx;
    const plates = [];
    for (let i = 0; i < 4; i++) {
      const z = -0.09 + i * 0.06;
      plates.push([out * 0.07, 0, z, 0, i % 2 ? 0.08 : -0.08, 0, 0.24, 0.16, 0.006]);
    }
    addInstanced(m, o, boxGeo(), M.radiator, plates);

    addInstanced(m, o, boxGeo(), M.dark, [
      [out * 0.07, 0.085, 0, 0, 0, 0, 0.22, 0.012, 0.014],
      [out * 0.07, -0.085, 0, 0, 0, 0, 0.22, 0.012, 0.014],
    ]);

    addNav(m, o, [out * 0.19, 0.06, 0.11], 0x4fe6ff, 0.9, 2.1);

    finish(m, [0.38, 0.2, 0.3, out * 0.08, 0, 0]);
  }

  // =========================================================================
  // 20 实验舱
  // =========================================================================
  function buildLab() {
    const m = makeModule({
      id: 'lab-module',
      cn: '实验舱',
      en: 'LABORATORY',
      desc: '悬挂在核心舱腹侧的实验舱，微重力晶体炉整夜嗡嗡作响，窗里是冷白色的实验灯。',
      stat: 'LAB · 6 CREW',
      pos: [0, -0.28, 0.06],
      dir: [0, -1, 0.2],
      dist: 1.1,
      tiltAxis: [0, 0, 1],
      tiltAngle: 0.16,
      spinAxis: [0.3, 1, 0.2],
      spinSpeed: 0.24,
    });
    const o = m.object;

    addCyl(m, o, M.lab, [0, 0, 0], 0.105, 0.22, 24);
    addCyl(m, o, M.trim, [0, 0.11, 0], 0.045, 0.1, 16);
    addInstanced(m, o, taperGeo(0.06, 0.105, 20), M.hullDark, [
      [0, -0.13, 0, Math.PI, 0, 0, 1, 0.06, 1],
      [0, 0.12, 0, 0, 0, 0, 1, 0.04, 1],
    ]);

    const wins = [];
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2 + 0.3;
      wins.push([Math.cos(ang) * 0.104, Math.sin(ang) * 0.104, 0.0, 0, 0, ang, 0.012, 0.12, 0.018]);
    }
    addInstanced(m, o, boxGeo(), M.windowCool, wins);

    addDecal(m, o, 1, [0.108, 0.0, 0.0], [0, Math.PI / 2, 0], 0.07, 0.035);

    addInstanced(m, o, boxGeo(), M.dark, [
      [0.0, 0.0, -0.108, 0, 0, 0, 0.12, 0.14, 0.02],
      [0.07, -0.07, 0.06, 0, 0, 0, 0.03, 0.05, 0.03],
      [-0.06, -0.06, 0.07, 0, 0, 0, 0.03, 0.04, 0.03],
    ]);

    finish(m, [0.26, 0.4, 0.26, 0, 0.02, 0]);
  }

  // =========================================================================
  // 21 推进剂储罐组
  // =========================================================================
  function buildTanks() {
    const m = makeModule({
      id: 'tank-farm',
      cn: '推进剂储罐组',
      en: 'PROPELLANT FARM',
      desc: '三只低温储罐像鱼雷一样束在尾部，管线里流动的是这座空间站最后的自持力。',
      stat: 'LOX/LH2 · 82%',
      pos: [0.16, -0.06, -0.36],
      dir: [0.45, -0.5, -1],
      dist: 1.0,
      tiltAxis: [1, 0, 0],
      tiltAngle: 0.18,
      spinAxis: [1, 0.4, 0.2],
      spinSpeed: 0.2,
    });
    const o = m.object;

    const tanks = [];
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * 0.075;
      tanks.push([off, (i % 2 ? 0.05 : -0.03), 0, Math.PI / 2, 0, 0, 0.042, 0.05, 0.042]);
    }
    addInstanced(m, o, capsuleGeo(), M.hull, tanks);

    const bands = [];
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * 0.075;
      const y = i % 2 ? 0.05 : -0.03;
      bands.push([off, y, -0.055], [off, y, 0.055]);
    }
    addInstanced(m, o, torusGeo(0.043, 0.006, 6, 20), M.trim, bands);

    addBars(m, o, M.dark, [
      [-0.075, -0.03, -0.06, 0.075, 0.05, -0.06, 0.012],
      [-0.075, -0.03, 0.06, 0.075, 0.05, 0.06, 0.012],
      [-0.16, 0.06, 0.36, 0, 0, 0, 0.016],
    ]);

    addBox(m, o, M.hullDark, [0, 0, 0.075], [0.2, 0.1, 0.03]);
    addNav(m, o, [0.06, 0.1, 0.06], 0xff3322, 1.7, 2.9);

    finish(m, [0.28, 0.22, 0.26, 0, 0, 0]);
  }

  // =========================================================================
  // 22 尾部推进段
  // =========================================================================
  function buildEngine() {
    const m = makeModule({
      id: 'engine-block',
      cn: '尾部推进段',
      en: 'PROPULSION BLOCK',
      desc: '四台磁等离子体发动机与一只主喷口。它们很少全开，但每一次点火都写着回家的方向。',
      stat: 'MAIN · 4 × 0.8 MN',
      pos: [0, 0, -0.64],
      dir: [0, -0.15, -1],
      dist: 1.55,
      tiltAxis: [1, 0, 0],
      tiltAngle: 0.1,
      spinAxis: [0.2, 1, 0],
      spinSpeed: 0.16,
    });
    const o = m.object;

    addCyl(m, o, M.hull, [0, 0, 0], 0.11, 0.16, 24, [Math.PI / 2, 0, 0]);
    addCyl(m, o, M.hullDark, [0, 0, 0.15], 0.06, 0.13, 16, [Math.PI / 2, 0, 0]);
    addCyl(m, o, M.hullDark, [0, 0, -0.085], 0.13, 0.05, 24, [Math.PI / 2, 0, 0]);
    addTorus(m, o, M.hazard, [0, 0, -0.05], 0.125, 0.014, null, 8, 32);

    // 主喷口（开口锥）
    addCone(m, o, M.darkDouble, [0, 0, -0.16], 0.105, 0.14, 24, [Math.PI / 2, 0, 0], true);
    addMesh(m, o, circleGeo(), M.engine, [0, 0, -0.155], [0, Math.PI, 0], [0.07, 0.07, 1]);

    // 姿控小喷口
    const vern = [];
    for (let a = 0; a < 4; a++) {
      const ang = Math.PI / 4 + (a * Math.PI) / 2;
      vern.push([Math.cos(ang) * 0.115, Math.sin(ang) * 0.115, -0.06, Math.PI / 2, 0, 0, 0.028, 0.05, 0.028]);
    }
    addInstanced(m, o, coneGeo(14, true), M.darkDouble, vern);

    addInstanced(m, o, boxGeo(), M.trim, [
      [0, 0.118, 0.02, 0, 0, 0, 0.06, 0.02, 0.1],
      [0, -0.118, 0.02, 0, 0, 0, 0.06, 0.02, 0.1],
      [0.118, 0, 0.02, 0, 0, 0, 0.02, 0.06, 0.1],
      [-0.118, 0, 0.02, 0, 0, 0, 0.02, 0.06, 0.1],
    ]);

    addNav(m, o, [0, 0.14, 0.04], 0xff3322, 1.2, 3.6);
    addNav(m, o, [0, -0.14, 0.04], 0x44ff88, 2.8, 3.6);

    finish(m, [0.34, 0.34, 0.52, 0, 0, -0.02]);
  }

  // =========================================================================
  // 建站
  // =========================================================================
  buildCore();

  buildRing({
    id: 'ring-a',
    cn: '居住环 A',
    en: 'HABITAT RING A',
    desc: '以 0.5 rad/s 自转制造离心重力，环上八间舱室昼夜不熄——这是全站唯一有"楼下"的地方。',
    stat: 'ROT 0.50 rad/s',
    pos: [0, 0, -0.14],
    dir: [-0.85, -0.5, -1],
    dist: 1.15,
    tiltAxis: [0, 1, 1],
    tiltAngle: 0.22,
    spinAxis: [0.3, 1, 0.2],
    spinSpeed: 0.3,
    spinRate: 0.5,
  });

  buildRing({
    id: 'ring-b',
    cn: '居住环 B',
    en: 'HABITAT RING B',
    desc: '与 A 环反向旋转以抵消角动量。两环的灯光在舷窗外交错成一整条旋转的星河。',
    stat: 'ROT -0.45 rad/s',
    pos: [0, 0, 0.14],
    dir: [0.85, -0.5, 1],
    dist: 1.15,
    tiltAxis: [0, 1, -1],
    tiltAngle: 0.22,
    spinAxis: [0.3, 1, -0.2],
    spinSpeed: 0.3,
    spinRate: -0.45,
  });

  buildTruss({
    id: 'truss-p-outer',
    cn: '十字桁架·左外段',
    en: 'TRUSS PORT OUTER',
    desc: '主桁架最外侧一段，铝锂合金桁条在恒星风里微微震颤，末端挂着整座电站的电力出口。',
    stat: 'LOAD · 42%',
    pos: [-0.765, 0, 0],
    dir: [-1, 0, 0],
    dist: 1.42,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.2,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.24,
    len: 0.51,
  });

  buildTruss({
    id: 'truss-p-inner',
    cn: '十字桁架·左内段',
    en: 'TRUSS PORT INNER',
    desc: '贴近核心舱的内侧桁架段，管线与检修通道在这里汇入增压舱，是全站最忙的一段"走廊"。',
    stat: 'LOAD · 61%',
    pos: [-0.335, 0, 0],
    dir: [-1, 0, 0],
    dist: 1.0,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.15,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.2,
    len: 0.37,
  });

  buildTruss({
    id: 'truss-s-inner',
    cn: '十字桁架·右内段',
    en: 'TRUSS STARBOARD INNER',
    desc: '右舷内侧桁架段，与左舷镜像。应急气闸与两条撤离索固定在它的下弦杆上。',
    stat: 'LOAD · 58%',
    pos: [0.335, 0, 0],
    dir: [1, 0, 0],
    dist: 1.0,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.15,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.2,
    len: 0.37,
  });

  buildTruss({
    id: 'truss-s-outer',
    cn: '十字桁架·右外段',
    en: 'TRUSS STARBOARD OUTER',
    desc: '右舷外侧桁架，承载两组太阳翼与散热阵。每一次结构热循环都被这里的应变片记录下来。',
    stat: 'LOAD · 45%',
    pos: [0.765, 0, 0],
    dir: [1, 0, 0],
    dist: 1.42,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.2,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.24,
    len: 0.51,
  });

  buildNode({
    id: 'node-port',
    cn: '端部节点·左',
    en: 'PORT NODE',
    desc: '桁架左端的多功能节点，四向对接接口与抓具让它成为舱外作业的中转站。',
    stat: 'BERTHS 4 · FREE 2',
    pos: [-1.02, 0, 0],
    dir: [-1, 0, 0],
    dist: 1.6,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.24,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.28,
    sign: -1,
  });

  buildNode({
    id: 'node-star',
    cn: '端部节点·右',
    en: 'STARBOARD NODE',
    desc: '桁架右端节点，太阳翼的力矩在这里汇总，再由一根主电缆送回核心舱。',
    stat: 'BERTHS 4 · FREE 3',
    pos: [1.02, 0, 0],
    dir: [1, 0, 0],
    dist: 1.6,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.24,
    spinAxis: [0, 1, 0],
    spinSpeed: 0.28,
    sign: 1,
  });

  buildWing({
    id: 'solar-port-fwd',
    cn: '太阳能翼·左前',
    en: 'SOLAR WING PF',
    desc: '三块深蓝紫电池板呈阶梯展开，逐日机构让它们永远侧身对着那颗白色的恒星。',
    stat: 'POWER · 1.9 MW',
    pos: [-1.05, 0, 0.06],
    rot: [0, 0, 0],
    dir: [-1, 0, 0.5],
    dist: 1.35,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.18,
    spinAxis: [0, 0, 1],
    spinSpeed: 0.2,
  });

  buildWing({
    id: 'solar-port-aft',
    cn: '太阳能翼·左后',
    en: 'SOLAR WING PA',
    desc: '左后翼反向安装，与左前翼在背光面互相遮挡的时间最短，是总体设计里最省结构重量的一笔。',
    stat: 'POWER · 1.9 MW',
    pos: [-1.05, 0, -0.06],
    rot: [0, Math.PI, 0],
    dir: [-1, 0, -0.5],
    dist: 1.35,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.18,
    spinAxis: [0, 0, 1],
    spinSpeed: 0.2,
  });

  buildWing({
    id: 'solar-star-fwd',
    cn: '太阳能翼·右前',
    en: 'SOLAR WING SF',
    desc: '右前翼，电池片表面的金色栅线在低角度恒星光照下会亮成一片细密的网。',
    stat: 'POWER · 1.9 MW',
    pos: [1.05, 0, 0.06],
    rot: [0, 0, 0],
    dir: [1, 0, 0.5],
    dist: 1.35,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.18,
    spinAxis: [0, 0, 1],
    spinSpeed: 0.2,
  });

  buildWing({
    id: 'solar-star-aft',
    cn: '太阳能翼·右后',
    en: 'SOLAR WING SA',
    desc: '右后翼，与对侧三翼共同维持 7.6 MW 的持续供电；一次日照周期内可充满四组缓冲电池。',
    stat: 'POWER · 1.9 MW',
    pos: [1.05, 0, -0.06],
    rot: [0, Math.PI, 0],
    dir: [1, 0, -0.5],
    dist: 1.35,
    tiltAxis: [0, 1, 0],
    tiltAngle: 0.18,
    spinAxis: [0, 0, 1],
    spinSpeed: 0.2,
  });

  buildDock({
    id: 'dock-fore',
    cn: '前对接枢纽',
    en: 'FORWARD DOCK',
    desc: '前向对接枢纽，橙色警示环一圈圈排开。补给船每九十天从这里靠泊，带来邮件与新鲜咖啡。',
    stat: 'BERTH 1 · READY',
    pos: [0, 0, 0.4],
    rot: null,
    dir: [0, 0, 1],
    dist: 1.2,
    tiltAxis: [1, 0, 0],
    tiltAngle: 0.12,
    spinAxis: [0.2, 1, 0.1],
    spinSpeed: 0.18,
  });

  buildDock({
    id: 'dock-aft',
    cn: '后对接枢纽',
    en: 'AFT DOCK',
    desc: '后向对接枢纽兼任舱外活动气闸，出舱的人从这里进入真空，回头看见的是一整座亮着灯的城市。',
    stat: 'BERTH 2 · EVA READY',
    pos: [0, 0, -0.4],
    rot: [0, Math.PI, 0],
    dir: [0, 0, -1],
    dist: 1.2,
    tiltAxis: [1, 0, 0],
    tiltAngle: 0.12,
    spinAxis: [0.2, 1, 0.1],
    spinSpeed: 0.18,
  });

  buildRadar();
  buildComm();

  buildRadiator({
    id: 'radiator-port',
    cn: '散热阵·左',
    en: 'RADIATOR PORT',
    desc: '四片散热板像鳍一样张开，把反应堆与生保系统的废热辐射进 3K 的深空。',
    stat: 'HEAT · 4.2 MW',
    pos: [-0.5, 0.14, 0],
    dir: [-1, 0.2, 0],
    dist: 0.95,
    tiltAxis: [0, 0, 1],
    tiltAngle: 0.2,
    spinAxis: [1, 0.3, 0],
    spinSpeed: 0.2,
  });

  buildRadiator({
    id: 'radiator-star',
    cn: '散热阵·右',
    en: 'RADIATOR STARBOARD',
    desc: '右舷散热阵，板面涂层随温度在深灰与银白之间缓慢变色，是站上最安静的一块"皮肤"。',
    stat: 'HEAT · 4.0 MW',
    pos: [0.5, 0.14, 0],
    dir: [1, 0.2, 0],
    dist: 0.95,
    tiltAxis: [0, 0, 1],
    tiltAngle: 0.2,
    spinAxis: [1, 0.3, 0],
    spinSpeed: 0.2,
  });

  buildLab();
  buildTanks();
  buildEngine();

  // =========================================================================
  // 动画 / 交互状态
  // =========================================================================
  const N = modules.length;
  const STAGGER = 0.45;

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _q3 = new THREE.Quaternion();
  const _sunLocal = new THREE.Vector3().copy(SUN_FALLBACK);
  const HULL_HL = new THREE.Color(0x59e6ff);

  let sunLight = null;
  let sunScanTimer = 0;
  let sunScanDone = false;

  function scanSun() {
    if (!scene) return;
    let best = null;
    scene.traverse((o) => {
      if (o.isDirectionalLight && (!best || o.intensity > best.intensity)) best = o;
    });
    sunLight = best;
    sunScanDone = !!best;
  }

  function update(dtIn, t, camera) {
    const dt = Math.min(Math.max(dtIn || 0, 0), 0.05);
    const time = t || 0;

    // 站体整体缓慢自转
    group.rotation.y += dt * 0.035;

    // 整体拆解进度
    const step = dt / 1.25;
    if (explodeCur < explodeTarget) explodeCur = Math.min(explodeTarget, explodeCur + step);
    else if (explodeCur > explodeTarget) explodeCur = Math.max(explodeTarget, explodeCur - step);

    const retracting = explodeTarget < 0.5;

    for (let i = 0; i < N; i++) {
      const m = modules[i];

      // 个体拆解进度
      const ownTarget = m.detachedTarget ? 1 : 0;
      if (m.own < ownTarget) m.own = Math.min(ownTarget, m.own + dt / 0.85);
      else if (m.own > ownTarget) m.own = Math.max(ownTarget, m.own - dt / 0.85);

      // 错峰展开 / 收拢
      // globalOff：整站已拆解时，个别模块可以选择"装回去"并在全局拆解下保持归位
      const gCur = m.globalOff ? 0 : explodeCur;
      const sIdx = retracting ? N - 1 - i : i;
      const raw = clamp01((gCur - (sIdx / (N - 1)) * STAGGER) / (1 - STAGGER));
      const gp = easeInOutCubic(raw);
      const op = easeInOutCubic(m.own);
      const p = Math.max(gp, op);
      m.progress = p;

      if (p <= 0.0005) {
        m.object.position.copy(m.basePos);
        m.object.quaternion.copy(m.baseQuat);
        m.spinAngle = 0;
      } else {
        // 失重漂移 + 缓慢自转
        m.spinAngle += dt * m.spinSpeed * p;
        const fx = Math.sin(time * 0.55 + i * 1.7) * 0.01 * p;
        const fy = Math.sin(time * 0.72 + i * 2.3) * 0.012 * p;
        const fz = Math.sin(time * 0.47 + i * 0.9) * 0.01 * p;
        m.object.position.set(
          m.basePos.x + m.dir.x * m.dist * p + fx,
          m.basePos.y + m.dir.y * m.dist * p + fy,
          m.basePos.z + m.dir.z * m.dist * p + fz
        );
        _q.setFromAxisAngle(m.tiltAxis, m.tiltAngle * p);
        _q2.setFromAxisAngle(m.spinAxis, m.spinAngle);
        m.object.quaternion.copy(m.baseQuat).multiply(_q).multiply(_q2);
      }

      // 高亮：克制——只留极淡自发光 + 细线框，绝不把模块烧成色块
      let hlTarget = 0;
      if (m === selected) hlTarget = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(time * 3.0));
      else if (m === hovered) hlTarget = 0.8;
      m.hl = damp(m.hl, hlTarget, 9, dt);

      const k = m.hl;
      for (let j = 0; j < m.mats.length; j++) {
        const mat = m.mats[j];
        const base = mat.userData.baseEmissive;
        if (k < 0.002) {
          mat.emissive.copy(base);
          mat.emissiveIntensity = mat.userData.baseIntensity;
        } else {
          const hs = mat.userData.hlScale || 1;
          mat.emissive.copy(base).lerp(HULL_HL, Math.min(0.1, k * 0.1 * hs));
          mat.emissiveIntensity = Math.min(1.38, mat.userData.baseIntensity + k * 0.1 * hs);
        }
      }

      // 焦点描边：细线、低透明度、无光晕
      const out = m.outline;
      if (out) {
        if (m === selected) {
          out.visible = true;
          m.outlineMat.color.setHex(0xffb45c);
          m.outlineMat.opacity = 0.34 + 0.06 * (0.5 + 0.5 * Math.sin(time * 3.0));
        } else if (m === hovered) {
          out.visible = true;
          m.outlineMat.color.setHex(0x7fe6f2);
          m.outlineMat.opacity = 0.34;
        } else if (out.visible) {
          out.visible = false;
        }
      }
    }

    // 居住环自转（比站体快得多）
    for (let i = 0; i < ringSpinners.length; i++) {
      ringSpinners[i].group.rotation.z += dt * ringSpinners[i].speed;
    }

    // 航行灯闪烁
    for (let i = 0; i < N; i++) {
      const navs = modules[i].navLights;
      for (let j = 0; j < navs.length; j++) {
        const L = navs[j];
        L.mat.emissiveIntensity = 0.22 + 1.02 * (0.5 + 0.5 * Math.sin(time * L.speed + L.phase));
      }
    }

    // 太阳方向 -> 太阳翼跟踪
    if (!sunScanDone && scene) {
      sunScanTimer += dt;
      if (sunScanTimer > 0.2) {
        sunScanTimer = 0;
        scanSun();
      }
    }
    if (sunLight) {
      sunLight.getWorldPosition(_v);
      if (sunLight.target) sunLight.target.getWorldPosition(_v2);
      else _v2.set(0, 0, 0);
      _v.sub(_v2);
      if (_v.lengthSq() < 1e-8) _v.copy(SUN_FALLBACK);
      else _v.normalize();
      group.getWorldQuaternion(_q3);
      _q3.invert();
      _sunLocal.copy(_v).applyQuaternion(_q3).normalize();
    }
    for (let i = 0; i < wings.length; i++) {
      const w = wings[i];
      if (!w.tracker) continue;
      _v.copy(_sunLocal).applyQuaternion(_q.copy(w.object.quaternion).invert());
      let ang = Math.atan2(-_v.x, _v.y);
      if (ang < -0.9) ang = -0.9;
      else if (ang > 0.9) ang = 0.9;
      w.trackerAngle = damp(w.trackerAngle, ang, 2.5, dt);
      w.tracker.rotation.z = w.trackerAngle;
    }
  }

  // =========================================================================
  // 拾取与外部控制
  // =========================================================================
  function raycast(raycaster) {
    if (!raycaster || pickables.length === 0) return null;
    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return null;
    for (let i = 0; i < hits.length; i++) {
      const id = hits[i].object.userData.moduleId;
      if (id && moduleById.has(id)) return moduleById.get(id);
    }
    return null;
  }

  function setHover(m) {
    hovered = m || null;
  }

  function setSelected(m) {
    selected = m || null;
  }

  function setExploded(v) {
    explodeTarget = v ? 1 : 0;
    if (!v) {
      for (let i = 0; i < modules.length; i++) { modules[i].detachedTarget = false; modules[i].globalOff = false; }
    } else {
      // 重新整站拆解时，之前"单独装回"的模块也要一起散开
      for (let i = 0; i < modules.length; i++) modules[i].globalOff = false;
    }
  }

  function toggleExplode() {
    setExploded(explodeTarget < 0.5);
  }

  function resolve(id) {
    if (!id) return null;
    if (typeof id === 'string') return moduleById.get(id) || null;
    return moduleById.get(id.id) || null;
  }

  function detach(id) {
    const m = resolve(id);
    if (m) { m.detachedTarget = true; m.globalOff = false; }
  }

  function attach(id) {
    const m = resolve(id);
    if (m) {
      m.detachedTarget = false;
      if (explodeTarget > 0.5) m.globalOff = true;   // 整站拆解中单独装回
    }
  }

  function isDetached(id) {
    const m = resolve(id);
    if (!m) return false;
    return m.detachedTarget || (!m.globalOff && explodeTarget > 0.5);
  }

  return {
    group: group,
    modules: modules,
    focusPoint: focusPoint,
    get explodeAmount() {
      return Math.abs(explodeTarget - explodeCur) > 1e-4 ? explodeTarget : explodeCur;
    },
    update: update,
    raycast: raycast,
    setHover: setHover,
    setSelected: setSelected,
    toggleExplode: toggleExplode,
    setExploded: setExploded,
    detach: detach,
    attach: attach,
    isDetached: isDetached,
  };
}
