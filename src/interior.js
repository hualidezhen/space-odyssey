// ===========================================================================
// 深空方舟 · 空间站内景（interior.js）
//
// 独立 scene + camera 的第一人称步行模块。全部几何与贴图都在运行时程序化生成，
// 不加载任何外部资源（贴图一律用 Canvas2D 现画，Node 环境下自动降级为纯材质色）。
//
// 对外接口（见 docs/FEATURES-CONTRACT.md 第 2 节）：
//   export function createInterior({ renderer, quality })
//     -> { scene, camera, group, isInside, enter(t), exit(),
//          update(dt, t, input), hotspots, interact(), position, dispose(),
//          stats }   // stats 为附加调试信息 { drawCalls, triangles }
//
// 输入 input = { forward, back, left, right, run, lookX, lookY }
//   forward/back/left/right/run : 布尔（或 0/1）
//   lookX / lookY               : 每帧鼠标增量（弧度），右上为正（与 movementX/Y 同向）
//                                 内部累加 yaw / pitch，pitch 限制 ±80°
//
// 尺度：内部单独一套米制尺度。站体外部 2.4 世界单位 ≈ 120 米。
// 布局（俯视，+z 为气闸方向，-z 为指挥席方向）：
//   气闸舱 (0, 0, 7~13) → 主通道 (z 7 ~ -15) → 中央环形大厅（圆心 (0,-26)，R=11）
//     大厅三条地面支廊：+x 观景廊（尽头 8×3 舷窗，窗外是地球）/
//                       -x 实验舱 / -z 指挥席；+z 是主通道入口
//     大厅 4.3 米高的一层环廊（舷梯可上，可俯视下层与反应堆井）
//   主通道旁 +x 侧是住舱。
// 碰撞：walk 区域白名单（轴对齐盒 / 极坐标扇环），逐轴移动 + 逐轴校验，
//       台阶用「地板高度差」处理（上 ≤0.55m，下 ≤1.15m），不写物理引擎。
// ===========================================================================

import * as THREE from 'three';

/* ───────────────────────── 小工具 ───────────────────────── */
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

// 固定种子伪随机：保证每次生成的贴图/星点完全一致
function rngFactory(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Node（无 document）下不能画 Canvas：所有贴图退化为纯材质色
const HAS_CANVAS = (() => {
  try {
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    return !!(c && c.getContext && c.getContext('2d'));
  } catch (e) {
    return false;
  }
})();

/* ───────────────────────── 程序化贴图 ───────────────────────── */

function makeCanvas(w, h, draw) {
  if (!HAS_CANVAS) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  draw(g, w, h);
  return c;
}

function makeTexture(canvas, opt = {}) {
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = opt.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = opt.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.anisotropy = opt.anisotropy || 4;
  if (opt.repeat) tex.repeat.set(opt.repeat[0], opt.repeat[1]);
  tex.needsUpdate = true;
  return tex;
}

// 舱壁：4×4 面板 + 铆钉 + 磨损 + 少量青色/琥珀标记
function drawPanel(g, w, h) {
  const rnd = rngFactory(20260510);
  const cols = 4, rows = 4;
  const cw = w / cols, ch = h / rows;
  g.fillStyle = '#2c3742';
  g.fillRect(0, 0, w, h);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = 0.82 + rnd() * 0.3;
      g.fillStyle = 'rgb(' + ((70 * v) | 0) + ',' + ((84 * v) | 0) + ',' + ((98 * v) | 0) + ')';
      g.fillRect(x * cw + 2, y * ch + 2, cw - 4, ch - 4);
      // 面板内凹高光
      g.fillStyle = 'rgba(170,200,225,' + (0.02 + rnd() * 0.05).toFixed(3) + ')';
      g.fillRect(x * cw + 6, y * ch + 5, cw - 12, 2);
      // 铆钉
      for (let i = 0; i < 4; i++) {
        g.fillStyle = 'rgba(20,26,32,0.55)';
        g.beginPath();
        g.arc(x * cw + 8 + i * (cw - 16) / 3, y * ch + 9, 1.4, 0, TAU);
        g.fill();
        g.beginPath();
        g.arc(x * cw + 8 + i * (cw - 16) / 3, y * ch + ch - 9, 1.4, 0, TAU);
        g.fill();
      }
      // 随机污渍 / 刮痕
      if (rnd() > 0.62) {
        g.strokeStyle = 'rgba(12,18,24,' + (0.1 + rnd() * 0.2).toFixed(2) + ')';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x * cw + 6 + rnd() * cw, y * ch + 8);
        g.lineTo(x * cw + 6 + rnd() * cw, y * ch + ch - 8);
        g.stroke();
      }
    }
  }
  // 分缝
  g.strokeStyle = 'rgba(10,15,21,0.85)';
  g.lineWidth = 3;
  for (let x = 0; x <= cols; x++) {
    g.beginPath(); g.moveTo(x * cw, 0); g.lineTo(x * cw, h); g.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    g.beginPath(); g.moveTo(0, y * ch); g.lineTo(w, y * ch); g.stroke();
  }
  // 青色标识条 / 琥珀警示块
  g.fillStyle = 'rgba(126,243,255,0.5)';
  g.fillRect(w * 0.04, h * 0.34, 2, h * 0.2);
  g.fillStyle = 'rgba(255,180,92,0.55)';
  g.fillRect(w * 0.72, h * 0.06, w * 0.1, h * 0.035);
  g.fillStyle = 'rgba(126,243,255,0.22)';
  g.font = '10px "Consolas", monospace';
  g.fillText('DS-ARK · HULL A3', w * 0.62, h * 0.955);
}

// 地板：深色甲板格栅 + 防滑纹 + 走道磨损
function drawDeck(g, w, h) {
  const rnd = rngFactory(77123);
  g.fillStyle = '#1d242c';
  g.fillRect(0, 0, w, h);
  const n = 8;
  const cw = w / n, ch = h / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 0.85 + rnd() * 0.28;
      g.fillStyle = 'rgb(' + ((36 * v) | 0) + ',' + ((44 * v) | 0) + ',' + ((53 * v) | 0) + ')';
      g.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
      // 格栅纹
      g.strokeStyle = 'rgba(8,12,16,0.5)';
      g.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        g.beginPath();
        g.moveTo(x * cw + 4, y * ch + (ch * i) / 5);
        g.lineTo(x * cw + cw - 4, y * ch + (ch * i) / 5);
        g.stroke();
      }
      if (rnd() > 0.75) {
        g.fillStyle = 'rgba(120,160,190,0.05)';
        g.fillRect(x * cw, y * ch + ch * 0.4, cw, ch * 0.2);
      }
    }
  }
  g.strokeStyle = 'rgba(8,12,16,0.9)';
  g.lineWidth = 4;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * cw, 0); g.lineTo(i * cw, h); g.stroke();
    g.beginPath(); g.moveTo(0, i * ch); g.lineTo(w, i * ch); g.stroke();
  }
  // 边角小螺栓
  for (let i = 0; i < 16; i++) {
    g.fillStyle = 'rgba(160,185,205,0.18)';
    g.beginPath();
    g.arc(12 + rnd() * (w - 24), 12 + rnd() * (h - 24), 2, 0, TAU);
    g.fill();
  }
}

// 警示斜条（琥珀/黑）
function drawWarn(g, w, h) {
  g.fillStyle = '#14181c';
  g.fillRect(0, 0, w, h);
  const sw = w / 8;
  g.fillStyle = '#ffb45c';
  for (let i = -2; i < 10; i++) {
    g.beginPath();
    g.moveTo(i * sw, 0);
    g.lineTo(i * sw + sw * 0.5, 0);
    g.lineTo(i * sw + sw * 0.5 - h * 0.6, h);
    g.lineTo(i * sw - h * 0.6, h);
    g.closePath();
    g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, w, 2);
  g.fillRect(0, h - 2, w, 2);
}

// 指示牌图集：2 列 × 4 行，每格 512×256
const SIGNS = [
  ['气闸舱', 'AIRLOCK · A-01'],
  ['主通道', 'MAIN CONDUIT'],
  ['中央环形大厅', 'CENTRAL ATRIUM'],
  ['观景廊', 'OBSERVATION GALLERY'],
  ['实验舱', 'LIFE SCIENCE LAB'],
  ['指挥席', 'COMMAND DECK'],
  ['住舱', 'CREW QUARTERS'],
  ['反应堆井', 'REACTOR SHAFT'],
];
function drawSigns(g, w, h) {
  const rnd = rngFactory(9091);
  g.fillStyle = '#050a10';
  g.fillRect(0, 0, w, h);
  const cw = w / 2, ch = h / 4;
  for (let i = 0; i < 8; i++) {
    const x = (i % 2) * cw;
    const y = ((i / 2) | 0) * ch;
    // 背板
    g.fillStyle = '#08141d';
    g.fillRect(x + 4, y + 4, cw - 8, ch - 8);
    // 边角框
    g.strokeStyle = 'rgba(126,243,255,0.6)';
    g.lineWidth = 2;
    g.strokeRect(x + 9, y + 9, cw - 18, ch - 18);
    g.fillStyle = 'rgba(126,243,255,0.9)';
    g.fillRect(x + 9, y + 9, 30, 3);
    g.fillRect(x + 9, y + 9, 3, 22);
    g.fillRect(x + cw - 39, y + ch - 12, 30, 3);
    g.fillRect(x + cw - 12, y + ch - 34, 3, 22);
    // 中文大字
    g.fillStyle = '#c8f6ff';
    g.font = '700 58px "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(SIGNS[i][0], x + cw / 2, y + ch / 2 - 8);
    // 英文小字
    g.fillStyle = 'rgba(255,180,92,0.92)';
    g.font = '500 21px "Consolas","Courier New",monospace';
    g.fillText(SIGNS[i][1], x + cw / 2, y + ch / 2 + 44);
    // 编号
    g.fillStyle = 'rgba(126,243,255,0.5)';
    g.font = '16px "Consolas",monospace';
    g.textAlign = 'right';
    g.fillText('0' + (i + 1), x + cw - 18, y + 26);
    // 噪点
    for (let k = 0; k < 60; k++) {
      g.fillStyle = 'rgba(160,220,240,' + (0.02 + rnd() * 0.05).toFixed(3) + ')';
      g.fillRect(x + 10 + rnd() * (cw - 20), y + 10 + rnd() * (ch - 20), 2, 1);
    }
  }
  g.textAlign = 'left';
}

// 星空（等距柱状投影，贴在 500 米球内壁）
function drawStars(g, w, h) {
  const rnd = rngFactory(31415);
  g.fillStyle = '#01030a';
  g.fillRect(0, 0, w, h);
  // 银河薄雾
  for (let i = 0; i < 26; i++) {
    const y = h * (0.3 + rnd() * 0.4);
    const grd = g.createRadialGradient(rnd() * w, y, 0, rnd() * w, y, 120 + rnd() * 260);
    grd.addColorStop(0, 'rgba(120,160,255,0.035)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }
  // 星点
  const colors = ['#ffffff', '#cfe6ff', '#ffe9c8', '#bcd4ff', '#ffd6d0'];
  for (let i = 0; i < (HAS_CANVAS ? 1100 : 0); i++) {
    const x = rnd() * w;
    // 向银河带聚集
    const y = rnd() < 0.45 ? h * (0.3 + rnd() * 0.4) + (rnd() - 0.5) * h * 0.14 : rnd() * h;
    const r = rnd() < 0.9 ? 0.6 + rnd() * 0.8 : 1.1 + rnd() * 1.3;
    const a = 0.25 + rnd() * 0.75;
    g.fillStyle = colors[(rnd() * colors.length) | 0];
    g.globalAlpha = a;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    if (r > 1.5) {
      g.globalAlpha = a * 0.25;
      g.beginPath();
      g.arc(x, y, r * 3.6, 0, TAU);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

// 地球：海洋 + 大陆块 + 云带 + 烘焙晨昏线（自发光，不依赖场景灯）
function drawEarth(g, w, h) {
  const rnd = rngFactory(20260422);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#0a2a4e');
  grd.addColorStop(0.28, '#0f4a86');
  grd.addColorStop(0.5, '#1466b0');
  grd.addColorStop(0.72, '#0f4a86');
  grd.addColorStop(1, '#0a2a4e');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);

  // 大陆：软边块的聚合
  for (let c = 0; c < 26; c++) {
    const cx = rnd() * w;
    const cy = h * (0.12 + rnd() * 0.76);
    const blocks = 8 + ((rnd() * 12) | 0);
    for (let b = 0; b < blocks; b++) {
      const bx = cx + (rnd() - 0.5) * 120;
      const by = cy + (rnd() - 0.5) * 90;
      const rr = 14 + rnd() * 42;
      const green = 0.35 + rnd() * 0.35;
      g.fillStyle = 'rgba(' + ((70 + green * 60) | 0) + ',' + ((96 + green * 50) | 0) + ',' + ((56 + green * 30) | 0) + ',0.88)';
      g.beginPath();
      g.ellipse(bx, by, rr, rr * (0.55 + rnd() * 0.6), rnd() * TAU, 0, TAU);
      g.fill();
      // 内陆沙漠
      if (rnd() > 0.6) {
        g.fillStyle = 'rgba(186,150,96,0.5)';
        g.beginPath();
        g.ellipse(bx + (rnd() - 0.5) * 30, by + (rnd() - 0.5) * 22, rr * 0.5, rr * 0.32, rnd() * TAU, 0, TAU);
        g.fill();
      }
    }
  }
  // 极冠
  g.fillStyle = 'rgba(230,245,255,0.92)';
  g.fillRect(0, 0, w, h * 0.055);
  g.fillRect(0, h * 0.955, w, h * 0.045);
  g.fillStyle = 'rgba(220,240,255,0.5)';
  g.fillRect(0, h * 0.05, w, h * 0.03);
  g.fillRect(0, h * 0.92, w, h * 0.03);
  // 云带：水平拉伸的絮状
  for (let i = 0; i < 150; i++) {
    const x = rnd() * w;
    const y = h * (0.05 + rnd() * 0.9);
    const rx = 16 + rnd() * 55;
    const ry = 4 + rnd() * 12;
    g.fillStyle = 'rgba(255,255,255,' + (0.06 + rnd() * 0.22).toFixed(3) + ')';
    g.beginPath();
    g.ellipse(x, y, rx, ry, (rnd() - 0.5) * 0.3, 0, TAU);
    g.fill();
  }
  // 晨昏线：右侧压暗（乘性渐变）
  g.globalCompositeOperation = 'multiply';
  const term = g.createLinearGradient(0, 0, w, 0);
  term.addColorStop(0.0, '#1e2a3a');
  term.addColorStop(0.18, '#5f7d9c');
  term.addColorStop(0.46, '#dfe9f2');
  term.addColorStop(0.72, '#b9c9d8');
  term.addColorStop(1.0, '#20293a');
  g.fillStyle = term;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  // 高光
  const spec = g.createRadialGradient(w * 0.34, h * 0.4, 0, w * 0.34, h * 0.4, w * 0.22);
  spec.addColorStop(0, 'rgba(210,240,255,0.18)');
  spec.addColorStop(1, 'rgba(210,240,255,0)');
  g.fillStyle = spec;
  g.fillRect(0, 0, w, h);
}

// 反应堆监视屏
function drawReactorScreen(g, w, h) {
  g.fillStyle = '#04121a';
  g.fillRect(0, 0, w, h);
  const rnd = rngFactory(5150);
  g.strokeStyle = 'rgba(126,243,255,0.14)';
  g.lineWidth = 1;
  for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.fillStyle = '#7ef3ff';
  g.font = '700 20px "Consolas",monospace';
  g.fillText('REACTOR CORE  ▸  STABLE', 16, 30);
  g.fillStyle = 'rgba(126,243,255,0.75)';
  g.font = '13px "Consolas",monospace';
  g.fillText('OUT  4.12 GW   FLUX  98.6%   TEMP  640K', 16, 52);
  // 波形
  g.strokeStyle = '#7ef3ff';
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x < w; x += 4) {
    const y = h * 0.62 + Math.sin(x * 0.05) * 12 + Math.sin(x * 0.13) * 5 + (rnd() - 0.5) * 3;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  // 柱状
  for (let i = 0; i < 12; i++) {
    const bh = 10 + rnd() * 34;
    g.fillStyle = i > 9 ? 'rgba(255,180,92,0.85)' : 'rgba(126,243,255,0.6)';
    g.fillRect(w - 210 + i * 16, h - 18 - bh, 9, bh);
  }
  g.fillStyle = 'rgba(255,180,92,0.9)';
  g.font = '13px "Consolas",monospace';
  g.fillText('COOLANT LOOP B · 2.1 bar', 16, h - 16);
  g.fillStyle = 'rgba(255,90,90,0.8)';
  g.beginPath(); g.arc(w - 24, 24, 5, 0, TAU); g.fill();
}

// 实验舱数据屏
function drawLabScreen(g, w, h) {
  g.fillStyle = '#03131a';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#7ef3ff';
  g.font = '700 18px "Consolas",monospace';
  g.fillText('CULTURE BAY  ·  SAMPLE 07', 14, 26);
  g.strokeStyle = 'rgba(126,243,255,0.7)';
  g.lineWidth = 2;
  // DNA 双螺旋
  for (let i = 0; i < 90; i++) {
    const x = 26 + i * ((w - 52) / 90);
    const y1 = h * 0.52 + Math.sin(i * 0.24) * h * 0.22;
    const y2 = h * 0.52 - Math.sin(i * 0.24) * h * 0.22;
    g.fillStyle = 'rgba(126,243,255,' + (0.35 + 0.5 * Math.abs(Math.sin(i * 0.24))).toFixed(2) + ')';
    g.beginPath(); g.arc(x, y1, 2.2, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,180,92,' + (0.3 + 0.5 * Math.abs(Math.cos(i * 0.24))).toFixed(2) + ')';
    g.beginPath(); g.arc(x, y2, 2.2, 0, TAU); g.fill();
    if (i % 3 === 0) {
      g.strokeStyle = 'rgba(160,220,240,0.18)';
      g.beginPath(); g.moveTo(x, y1); g.lineTo(x, y2); g.stroke();
    }
  }
  g.fillStyle = 'rgba(126,243,255,0.65)';
  g.font = '12px "Consolas",monospace';
  g.fillText('VIT  98.2%', 16, h - 40);
  g.fillText('PH   7.31', 16, h - 22);
  g.fillStyle = 'rgba(255,180,92,0.8)';
  g.fillText('GROWTH +0.42 mm/h', w - 176, h - 22);
}

// 指挥席星图屏
function drawCommandScreen(g, w, h) {
  const rnd = rngFactory(80808);
  g.fillStyle = '#020a12';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#7ef3ff';
  g.font = '700 18px "Consolas",monospace';
  g.fillText('NAV PLOT · SOL SYSTEM', 14, 26);
  // 轨道弧
  g.strokeStyle = 'rgba(126,243,255,0.22)';
  g.lineWidth = 1;
  for (let i = 1; i <= 5; i++) {
    g.beginPath();
    g.ellipse(w * 0.55, h * 0.55, 30 + i * 34, 18 + i * 22, 0.18, 0, TAU);
    g.stroke();
  }
  // 太阳
  const sg = g.createRadialGradient(w * 0.55, h * 0.55, 0, w * 0.55, h * 0.55, 26);
  sg.addColorStop(0, 'rgba(255,220,150,0.95)');
  sg.addColorStop(1, 'rgba(255,180,92,0)');
  g.fillStyle = sg;
  g.beginPath(); g.arc(w * 0.55, h * 0.55, 26, 0, TAU); g.fill();
  // 行星点
  for (let i = 0; i < 8; i++) {
    const a = rnd() * TAU;
    const rx = 40 + rnd() * (w * 0.42);
    const ry = 24 + rnd() * (h * 0.3);
    const x = w * 0.55 + Math.cos(a) * rx;
    const y = h * 0.55 + Math.sin(a) * ry;
    g.fillStyle = i === 3 ? '#ffb45c' : 'rgba(126,243,255,0.9)';
    g.beginPath(); g.arc(x, y, i === 3 ? 4 : 2.4, 0, TAU); g.fill();
  }
  // 航线
  g.strokeStyle = 'rgba(255,180,92,0.85)';
  g.lineWidth = 2;
  g.setLineDash([7, 6]);
  g.beginPath();
  g.moveTo(w * 0.55, h * 0.55);
  g.quadraticCurveTo(w * 0.72, h * 0.24, w * 0.9, h * 0.4);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,180,92,0.9)';
  g.font = '12px "Consolas",monospace';
  g.fillText('VECTOR LOCK  0.38c', 16, h - 20);
}

/* ───────────────────────── 几何合并 ───────────────────────── */

// 把若干同材质几何合并成一个（减少 draw call）。只处理 position/normal/uv。
function mergeGeoms(list) {
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const u = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (g.index) {
      const gi = g.index;
      for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
      io += gi.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// 盒子按面尺寸缩放 UV：让 2.4 米的贴图块在长走廊上不被拉伸
function scaleBoxUV(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  const n = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    let su, sv;
    if (ax > 0.5) { su = d; sv = h; }
    else if (ay > 0.5) { su = w; sv = d; }
    else { su = w; sv = h; }
    uv.setXY(i, (uv.getX(i) * su) / tile, (uv.getY(i) * sv) / tile);
  }
  uv.needsUpdate = true;
}

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _mat = new THREE.Matrix4();

function mat4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _euler.set(rx, ry, rz, 'XYZ');
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scl.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_pos, _quat, _scl);
}

/* ========================================================================= */
/*                              主模块                                       */
/* ========================================================================= */

export function createInterior({ renderer = null, quality = 'high' } = {}) {
  const HQ = quality !== 'low';

  /* ── 场景 / 相机 ───────────────────────────────────────────── */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02040a);
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.08, 1400);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 1.62, 11.2);

  const group = new THREE.Group();
  group.visible = false;
  group.name = 'station-interior';
  scene.add(group);

  // 前向声明：构建期先把挂载点/引用建好，后续各 build 函数填充
  const scrs = [];                          // 需要逐帧扫描动画的屏幕
  const holoGroup = new THREE.Group();      // 指挥席全息星图
  group.add(holoGroup);
  let starSphereRef = null;
  let atmosRef = null;
  let earth = null;
  let hubGlow = null;
  let hubCore = null;
  let reactorCore = null;
  let reactorGlow = null;
  let holoPointsMat = null;

  /* ── 纹理（Node 下全为 null） ─────────────────────────────── */
  const TEX = {};
  const texList = [];
  const addTex = (key, canvas, opt) => {
    const t = makeTexture(canvas, opt);
    TEX[key] = t;
    if (t) texList.push(t);
    return t;
  };
  addTex('panel', makeCanvas(512, 512, drawPanel));
  addTex('deck', makeCanvas(512, 512, drawDeck));
  addTex('warn', makeCanvas(256, 128, drawWarn));
  addTex('sign', makeCanvas(1024, 1024, drawSigns), { clamp: true });
  addTex('stars', makeCanvas(2048, 1024, drawStars), { clamp: true });
  addTex('earth', makeCanvas(1024, 512, drawEarth), { clamp: true });
  addTex('reactor', makeCanvas(512, 256, drawReactorScreen), { clamp: true });
  addTex('lab', makeCanvas(512, 256, drawLabScreen), { clamp: true });
  addTex('command', makeCanvas(512, 256, drawCommandScreen), { clamp: true });

  /* ── 材质（共享，合并后每种材质 1 个 draw call） ──────────── */
  const CYAN = new THREE.Color(0x7ef3ff);
  const AMBER = new THREE.Color(0xffb45c);
  const cyanBase = CYAN.clone().multiplyScalar(1.55);
  const amberBase = AMBER.clone().multiplyScalar(1.35);

  const MATS = {
    wall: new THREE.MeshStandardMaterial({ color: 0xa9b9c8, map: TEX.panel, roughness: 0.78, metalness: 0.22 }),
    wallRing: new THREE.MeshStandardMaterial({ color: 0x93a4b5, map: TEX.panel, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide }),
    ceil: new THREE.MeshStandardMaterial({ color: 0x8d9aa8, map: TEX.panel, roughness: 0.72, metalness: 0.28 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xffffff, map: TEX.deck, roughness: 0.9, metalness: 0.12 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x333d48, roughness: 0.44, metalness: 0.74 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x10171f, roughness: 0.62, metalness: 0.4 }),
    white: new THREE.MeshStandardMaterial({ color: 0xcfdae2, roughness: 0.52, metalness: 0.12 }),
    cyan: new THREE.MeshBasicMaterial({ color: cyanBase }),
    amber: new THREE.MeshBasicMaterial({ color: amberBase }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xf3fcff }),
    warn: new THREE.MeshStandardMaterial({ color: 0xffffff, map: TEX.warn, roughness: 0.7, metalness: 0.2 }),
    sign: new THREE.MeshBasicMaterial({ color: 0xffffff, map: TEX.sign }),
    glass: new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
    reactorCore: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9dfff0).multiplyScalar(1.5) }),
    reactorGlow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a4a).multiplyScalar(1.4), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    screenA: new THREE.MeshBasicMaterial({ color: 0xffffff, map: TEX.reactor }),
    screenB: new THREE.MeshBasicMaterial({ color: 0xffffff, map: TEX.lab }),
    screenC: new THREE.MeshBasicMaterial({ color: 0xffffff, map: TEX.command }),
    holo: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7ef3ff).multiplyScalar(1.2), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    hubDark: new THREE.MeshStandardMaterial({ color: 0x232d38, roughness: 0.36, metalness: 0.82 }),
    stars: new THREE.MeshBasicMaterial({ map: TEX.stars, side: THREE.BackSide, depthWrite: false, fog: false }),
    earth: new THREE.MeshBasicMaterial({ map: TEX.earth, fog: false }),
    atmos: new THREE.MeshBasicMaterial({ color: 0x4a9dff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false, fog: false }),
  };
  const TEXUV = { wall: 2.4, wallRing: 2.4, ceil: 2.4, floor: 2.0, warn: 1.4 };

  /* ── 合并桶 + 摆放工具 ───────────────────────────────────── */
  const buckets = new Map();

  function put(key, geo, matrix) {
    if (matrix) geo.applyMatrix4(matrix);
    const list = buckets.get(key);
    if (list) list.push(geo);
    else buckets.set(key, [geo]);
  }

  function rawBox(key, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (TEXUV[key]) scaleBoxUV(g, w, h, d, TEXUV[key]);
    put(key, g, mat4(x, y, z, rx, ry, rz));
  }

  // 用 min/max 边界放盒子（房间墙体/地板最常用）
  function box(key, x1, x2, y1, y2, z1, z2) {
    rawBox(key, Math.max(1e-4, x2 - x1), Math.max(1e-4, y2 - y1), Math.max(1e-4, z2 - z1),
      (x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  }

  function tube(key, x1, y1, z1, x2, y2, z2, r, seg = 8) {
    const a = new THREE.Vector3(x1, y1, z1);
    const b = new THREE.Vector3(x2, y2, z2);
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    d.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    put(key, new THREE.CylinderGeometry(r, r, len, seg), m);
  }

  function beam(key, x1, y1, z1, x2, y2, z2, thick) {
    const a = new THREE.Vector3(x1, y1, z1);
    const b = new THREE.Vector3(x2, y2, z2);
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    d.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    put(key, new THREE.BoxGeometry(len, thick, thick), m);
  }

  function torusArc(key, R, tubeR, a0, a1, x, y, z, radialSeg = 6) {
    const arc = a1 - a0;
    const g = new THREE.TorusGeometry(R, tubeR, radialSeg, Math.max(6, Math.ceil(arc * (HQ ? 14 : 8))), arc <= 0 ? 0.0001 : arc);
    g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(-a0));
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
    put(key, g, null);
  }

  // 环形/扇形楼板（top 面在 yTop，向下厚 thick；含内/外沿立面）
  function ringSlab(key, rIn, rOut, yTop, thick, a0, a1, seg) {
    const yBot = yTop - thick;
    const P = [], N = [], U = [];
    const tile = 2.0;
    const push = (x, y, z, nx, ny, nz, u, v) => {
      P.push(x, y, z); N.push(nx, ny, nz); U.push(u, v);
    };
    const dA = (a1 - a0) / seg;
    for (let i = 0; i < seg; i++) {
      const a = a0 + i * dA;
      const b = a + dA;
      const ca = Math.cos(a), sa = Math.sin(a);
      const cb = Math.cos(b), sb = Math.sin(b);
      const ua = (a * ((rIn + rOut) * 0.5)) / tile;
      const ub = (b * ((rIn + rOut) * 0.5)) / tile;
      // 顶面（法线 +y）—— 绕序必须从上方看是逆时针，否则会被背面剔除
      push(rIn * ca, yTop, rIn * sa, 0, 1, 0, rIn / tile, ua);
      push(rOut * cb, yTop, rOut * sb, 0, 1, 0, rOut / tile, ub);
      push(rOut * ca, yTop, rOut * sa, 0, 1, 0, rOut / tile, ua);
      push(rIn * ca, yTop, rIn * sa, 0, 1, 0, rIn / tile, ua);
      push(rIn * cb, yTop, rIn * sb, 0, 1, 0, rIn / tile, ub);
      push(rOut * cb, yTop, rOut * sb, 0, 1, 0, rOut / tile, ub);
      // 底面（法线 -y）
      push(rIn * ca, yBot, rIn * sa, 0, -1, 0, rIn / tile, ua);
      push(rOut * ca, yBot, rOut * sa, 0, -1, 0, rOut / tile, ua);
      push(rOut * cb, yBot, rOut * sb, 0, -1, 0, rOut / tile, ub);
      push(rIn * ca, yBot, rIn * sa, 0, -1, 0, rIn / tile, ua);
      push(rOut * cb, yBot, rOut * sb, 0, -1, 0, rOut / tile, ub);
      push(rIn * cb, yBot, rIn * sb, 0, -1, 0, rIn / tile, ub);
      if (rIn > 0.001) {
        // 内沿（法线朝圆心）
        push(rIn * ca, yBot, rIn * sa, -ca, 0, -sa, ua, 0);
        push(rIn * cb, yTop, rIn * sb, -cb, 0, -sb, ub, 1);
        push(rIn * ca, yTop, rIn * sa, -ca, 0, -sa, ua, 1);
        push(rIn * ca, yBot, rIn * sa, -ca, 0, -sa, ua, 0);
        push(rIn * cb, yBot, rIn * sb, -cb, 0, -sb, ub, 0);
        push(rIn * cb, yTop, rIn * sb, -cb, 0, -sb, ub, 1);
      }
      // 外沿（法线朝外）
      push(rOut * ca, yBot, rOut * sa, ca, 0, sa, ua, 0);
      push(rOut * ca, yTop, rOut * sa, ca, 0, sa, ua, 1);
      push(rOut * cb, yTop, rOut * sb, cb, 0, sb, ub, 1);
      push(rOut * ca, yBot, rOut * sa, ca, 0, sa, ua, 0);
      push(rOut * cb, yTop, rOut * sb, cb, 0, sb, ub, 1);
      push(rOut * cb, yBot, rOut * sb, cb, 0, sb, ub, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    put(key, g, null);
  }

  // 圆柱弧墙（内表面朝圆心；DoubleSide 材质，仰视也不漏）
  function arcWall(key, r, y0, y1, a0, a1, seg) {
    const P = [], N = [], U = [];
    const tile = 2.4;
    const dA = (a1 - a0) / seg;
    for (let i = 0; i < seg; i++) {
      const a = a0 + i * dA;
      const b = a + dA;
      const ca = Math.cos(a), sa = Math.sin(a);
      const cb = Math.cos(b), sb = Math.sin(b);
      const am = (a + b) * 0.5;
      const nmx = -Math.cos(am), nmz = -Math.sin(am);
      const ua = (am * r) / tile;
      const v0 = y0 / tile, v1 = y1 / tile;
      const x0 = r * ca, z0 = r * sa, x1 = r * cb, z1 = r * sb;
      // 两个三角形（顶点法线取中角，接缝平滑）
      P.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
      for (let k = 0; k < 6; k++) N.push(nmx, 0, nmz);
      U.push(ua - (dA * r) / tile, v0, ua, v0, ua, v1, ua - (dA * r) / tile, v0, ua, v1, ua - (dA * r) / tile, v1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    put(key, g, null);
  }

  /* ── 布局常量 ─────────────────────────────────────────────── */
  const HALL = {
    cx: 0,
    cz: -26,
    R: 11,             // 墙内半径
    rPit: 3.9,         // 中央反应堆井半径
    rFloorIn: 4.3,     // 一层可走内边界（离栏杆 0.4）
    rWalkOut: 10.35,   // 可走外边界（离墙 0.65）
    galleryY: 4.3,     // 一层环廊标高
    galleryRIn: 8.55,  // 环廊楼板内半径
    galleryA0: 40 * DEG,
    galleryA1: 130 * DEG,
    l2Y: 8.85,         // 二层环廊（装饰）
    l2RIn: 7.2,
    ceilY: 12.9,
  };
  const STAIR = { a: 58 * DEG, half: 0.17, topR: 8.55, botR: 4.93, steps: 22 };
  const AIR = { x: 2.9, z1: 7.0, z2: 13.0, h: 5.0 };       // 气闸舱
  const COR = { hw: 1.4, zA: -15.6, zB: 7.0, h: 3.4 };    // 主通道
  const DORM = { x1: 1.55, x2: 7.6, z1: -1.0, z2: 5.0, h: 3.2 };
  const OBS = { cA: 11.0, cB: 20.0, z1: -26 - 1.6, z2: -26 + 1.6, h: 4.4, dx1: 20.0, dx2: 25.6, dz1: -31, dz2: -21, dh: 5.6 };
  const LAB = { cA: -15.2, cB: -11.0, z1: -26 - 1.4, z2: -26 + 1.4, h: 3.8, rx1: -24.5, rx2: -15.2, rz1: -31, rz2: -21, rh: 4.4 };
  const CMD = { cA: -40.6, cB: -37.0, hw: 1.3, h: 3.8, rx1: -8.3, rx2: 8.3, rz1: -48.6, rz2: -40.6, rh: 4.6 };

  const SPAWN = { x: 0, y: 0, z: 11.2, yaw: 0 };

  /* ── 通行白名单 / 障碍 ───────────────────────────────────── */
  const WALK = [];
  const BLOCK = [];
  const wBox = (x1, x2, z1, z2, floor) => WALK.push({ type: 'box', x1, x2, z1, z2, floor });
  const wPolar = (cx, cz, a0, a1, r0, r1, floor) => WALK.push({ type: 'polar', cx, cz, a0, a1, r0, r1, floor });
  const bBox = (x1, x2, z1, z2, y0, y1) => BLOCK.push({ type: 'box', x1, x2, z1, z2, y0, y1 });
  const bPolar = (cx, cz, a0, a1, r0, r1, y0, y1) => BLOCK.push({ type: 'polar', cx, cz, a0, a1, r0, r1, y0, y1 });

  function containsXZ(rg, x, z) {
    if (rg.type === 'box') return x >= rg.x1 && x <= rg.x2 && z >= rg.z1 && z <= rg.z2;
    const dx = x - rg.cx, dz = z - rg.cz;
    const r2 = dx * dx + dz * dz;
    if (r2 < rg.r0 * rg.r0 || r2 > rg.r1 * rg.r1) return false;
    let a = Math.atan2(dz, dx);
    if (a < 0) a += TAU;
    let da = a - rg.a0;
    while (da < 0) da += TAU;
    return da <= rg.a1 - rg.a0;
  }

  /* ── 指示牌 / 屏幕 ───────────────────────────────────────── */
  function signQuad(cell, w, h, x, y, z, ry = 0) {
    if (!MATS.sign.map) return;
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    const col = cell % 2;
    const row = (cell / 2) | 0;
    const u0 = col * 0.5, u1 = u0 + 0.5;
    const v1 = 1 - row * 0.25, v0 = v1 - 0.25;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    uv.needsUpdate = true;
    put('sign', g, mat4(x, y, z, 0, ry, 0));
  }

  /* ── 门框 ────────────────────────────────────────────────── */
  function doorFrame(side, at, w, h, y0, x1, x2, z1, z2, t) {
    const fw = 0.14;
    if (side === 's' || side === 'n') {
      const zc = side === 's' ? z1 - t / 2 : z2 + t / 2;
      rawBox('frame', fw, h, t + 0.12, at - w / 2 - fw / 2, y0 + h / 2, zc);
      rawBox('frame', fw, h, t + 0.12, at + w / 2 + fw / 2, y0 + h / 2, zc);
      rawBox('frame', w + fw * 2, fw, t + 0.12, at, y0 + h + fw / 2, zc);
      rawBox('amber', 0.06, 0.06, 0.04, at, y0 + h + fw + 0.06, zc);
    } else {
      const xc = side === 'w' ? x1 - t / 2 : x2 + t / 2;
      rawBox('frame', t + 0.12, h, fw, xc, y0 + h / 2, at - w / 2 - fw / 2);
      rawBox('frame', t + 0.12, h, fw, xc, y0 + h / 2, at + w / 2 + fw / 2);
      rawBox('frame', t + 0.12, fw, w + fw * 2, xc, y0 + h + fw / 2, at);
      rawBox('amber', 0.04, 0.06, 0.06, xc, y0 + h + fw + 0.06, at);
    }
  }

  // 房间外壳：地板/天花 + 四面墙（可开门洞）
  function shell(o) {
    const t = o.t || 0.16;
    const x1 = o.x1, x2 = o.x2, z1 = o.z1, z2 = o.z2, y0 = o.y0, y1 = o.y1;
    box('floor', x1, x2, y0 - 0.3, y0, z1, z2);
    box('ceil', x1, x2, y1, y1 + t, z1, z2);
    const doors = o.doors || [];
    const dOf = (side) => doors.find((d) => d.side === side) || null;

    // 西墙 x = x1
    const dW = dOf('w');
    if (dW) {
      box('wall', x1 - t, x1, y0, y1, z1 - t, dW.at - dW.w / 2);
      box('wall', x1 - t, x1, y0, y1, dW.at + dW.w / 2, z2 + t);
      box('wall', x1 - t, x1, y0 + dW.h, y1, dW.at - dW.w / 2, dW.at + dW.w / 2);
      doorFrame('w', dW.at, dW.w, dW.h, y0, x1, x2, z1, z2, t);
    } else box('wall', x1 - t, x1, y0, y1, z1 - t, z2 + t);

    // 东墙 x = x2
    const dE = dOf('e');
    if (dE) {
      box('wall', x2, x2 + t, y0, y1, z1 - t, dE.at - dE.w / 2);
      box('wall', x2, x2 + t, y0, y1, dE.at + dE.w / 2, z2 + t);
      box('wall', x2, x2 + t, y0 + dE.h, y1, dE.at - dE.w / 2, dE.at + dE.w / 2);
      doorFrame('e', dE.at, dE.w, dE.h, y0, x1, x2, z1, z2, t);
    } else box('wall', x2, x2 + t, y0, y1, z1 - t, z2 + t);

    // 南墙 z = z1
    const dS = dOf('s');
    if (dS) {
      box('wall', x1 - t, dS.at - dS.w / 2, y0, y1, z1 - t, z1);
      box('wall', dS.at + dS.w / 2, x2 + t, y0, y1, z1 - t, z1);
      box('wall', dS.at - dS.w / 2, dS.at + dS.w / 2, y0 + dS.h, y1, z1 - t, z1);
      doorFrame('s', dS.at, dS.w, dS.h, y0, x1, x2, z1, z2, t);
    } else box('wall', x1 - t, x2 + t, y0, y1, z1 - t, z1);

    // 北墙 z = z2
    const dN = dOf('n');
    if (dN) {
      box('wall', x1 - t, dN.at - dN.w / 2, y0, y1, z2, z2 + t);
      box('wall', dN.at + dN.w / 2, x2 + t, y0, y1, z2, z2 + t);
      box('wall', dN.at - dN.w / 2, dN.at + dN.w / 2, y0 + dN.h, y1, z2, z2 + t);
      doorFrame('n', dN.at, dN.w, dN.h, y0, x1, x2, z1, z2, t);
    } else box('wall', x1 - t, x2 + t, y0, y1, z2, z2 + t);

    // 踢脚线 + 顶部灯带
    if (o.skirting !== false) {
      box('frame', x1 + 0.02, x1 + 0.08, y0, y0 + 0.14, z1, z2);
      box('frame', x2 - 0.08, x2 - 0.02, y0, y0 + 0.14, z1, z2);
      box('frame', x1, x2, y0, y0 + 0.14, z1 + 0.02, z1 + 0.08);
      box('frame', x1, x2, y0, y0 + 0.14, z2 - 0.08, z2 - 0.02);
    }
  }

  /* ── 光照 ────────────────────────────────────────────────── */
  scene.add(new THREE.AmbientLight(0x8fa8c0, 0.62));
  scene.add(new THREE.HemisphereLight(0x33506b, 0x0a0d12, 0.7));
  const sun = new THREE.DirectionalLight(0xffe2bd, 1.05);
  sun.position.set(7, 18, 6);
  scene.add(sun);
  scene.add(sun.target);

  const lights = [];
  function addPoint(color, intensity, dist, x, y, z) {
    const l = new THREE.PointLight(color, intensity, dist, 1.6);
    l.position.set(x, y, z);
    scene.add(l);
    lights.push(l);
    return l;
  }
  addPoint(0xffd9a8, 1.9, 18, 0, 4.35, 11.0);            // 气闸舱
  addPoint(0xffd9a8, 1.8, 22, 0, 3.05, -4.0);            // 主通道
  addPoint(0xffd2a0, 2.6, 34, 0, 11.2, HALL.cz);         // 大厅顶部
  addPoint(0xffd2a0, 1.3, 16, 0, 7.6, -16.6);            // 一层环廊
  addPoint(0xffe0bc, 1.7, 18, 22.6, 4.6, -26);           // 观景舱
  addPoint(0xdbeaff, 1.6, 18, -19.0, 3.7, -26);          // 实验舱
  addPoint(0xffd9a8, 1.6, 20, 0, 3.9, -44.0);            // 指挥席
  addPoint(0xffcf9a, 1.1, 12, 4.5, 2.6, 2.0);            // 住舱
  addPoint(0xff7a3c, 2.6, 18, 0, -2.6, HALL.cz);         // 反应堆井（橙色应急）
  const pitLight = lights[lights.length - 1];

  /* ── 气闸舱 ──────────────────────────────────────────────── */
  (function buildAirlock() {
    const { x, z1, z2, h } = AIR;
    const t = 0.16;
    shell({
      x1: -x, x2: x, z1, z2, y0: 0, y1: h, t,
      doors: [{ side: 's', at: 0, w: 3.0, h: 3.4 }],
    });
    // 外层舱门（+z 墙上的圆舱门）
    const hz = z2 + t - 0.02;
    torusArc('frame', 1.16, 0.1, 0, TAU, 0, 2.25, hz);
    const hatch = new THREE.CylinderGeometry(1.1, 1.1, 0.16, 28);
    put('frame', hatch, mat4(0, 2.25, hz - 0.06, Math.PI / 2, 0, 0));
    const hatchIn = new THREE.CylinderGeometry(0.92, 0.92, 0.1, 28);
    put('warn', hatchIn, mat4(0, 2.25, hz - 0.14, Math.PI / 2, 0, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      rawBox('frame', 0.12, 0.12, 0.1, Math.cos(a) * 1.02, 2.25 + Math.sin(a) * 1.02, hz - 0.16);
    }
    // 门上状态灯
    rawBox('amber', 0.16, 0.16, 0.06, -0.55, 3.65, hz - 0.2);
    rawBox('cyan', 0.16, 0.16, 0.06, 0.55, 3.65, hz - 0.2);
    // 地面警示带（舱门正下方）
    box('warn', -1.7, 1.7, 0.004, 0.02, z2 - 0.9, z2 - 0.15);
    // 储物柜（西墙）
    for (let i = 0; i < 3; i++) {
      const z0 = 8.5 + i * 1.0;
      rawBox('frame', 0.55, 2.0, 0.86, -x + 0.32, 1.0, z0);
      rawBox('cyan', 0.05, 0.05, 0.03, -x + 0.06, 1.55, z0 - 0.2);
      rawBox('dark', 0.4, 0.03, 0.6, -x + 0.34, 2.02, z0);
    }
    // 长凳（东墙）
    rawBox('white', 0.6, 0.1, 2.4, x - 0.48, 0.5, 10.2);
    rawBox('frame', 0.08, 0.5, 0.08, x - 0.48, 0.25, 9.2);
    rawBox('frame', 0.08, 0.5, 0.08, x - 0.48, 0.25, 11.2);
    // 天花灯 ×2
    for (const lx of [-1.2, 1.2]) {
      rawBox('lamp', 1.2, 0.05, 0.8, lx, h - 0.03, 9.4);
      rawBox('frame', 1.34, 0.1, 0.94, lx, h - 0.08, 9.4);
      rawBox('lamp', 1.2, 0.05, 0.8, lx, h - 0.03, 11.4);
      rawBox('frame', 1.34, 0.1, 0.94, lx, h - 0.08, 11.4);
    }
    // 管道
    tube('frame', -x + 0.3, h - 0.35, z1, -x + 0.3, h - 0.35, z2, 0.07);
    tube('frame', -x + 0.55, h - 0.32, z1, -x + 0.55, h - 0.32, z2, 0.05);
    // 墙角灯带
    box('cyan', -x + 0.03, -x + 0.06, 0.16, 0.2, z1 + 0.1, z2 - 0.1);
    box('cyan', x - 0.06, x - 0.03, 0.16, 0.2, z1 + 0.1, z2 - 0.1);
    // 指示牌
    signQuad(0, 1.5, 0.5, 0, 4.35, z2 + t - 0.03, Math.PI);
    // 气闸舱侧壁小屏（对接状态）
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), MATS.screenA);
    scr.position.set(-x + 0.1, 2.4, 12.0);
    scr.rotation.y = Math.PI / 2;
    group.add(scr);
    scrs.push({ mesh: scr, mat: MATS.screenA, speed: 0.01 });
  })();

  /* ── 主通道 ──────────────────────────────────────────────── */
  (function buildCorridor() {
    const hw = COR.hw, zA = COR.zA, zB = COR.zB, h = COR.h, t = 0.16;
    box('floor', -hw, hw, -0.3, 0, zA, zB);
    box('ceil', -hw, hw, h, h + t, zA, zB);
    box('wall', -hw - t, -hw, 0, h, zA, zB);
    // 东墙：在住舱门口（z 1.0~3.0）留洞，门洞上方补过梁
    box('wall', hw, hw + t, 0, h, zA, 1.0);
    box('wall', hw, hw + t, 0, h, 3.0, zB);
    box('wall', hw, hw + t, 2.4, h, 1.0, 3.0);
    // 人行道中央深色带 + 两侧青色导光条
    box('dark', -0.62, 0.62, 0.002, 0.012, zA, zB);
    box('cyan', -0.98, -0.92, 0.012, 0.026, zA + 0.4, zB - 0.2);
    box('cyan', 0.92, 0.98, 0.012, 0.026, zA + 0.4, zB - 0.2);
    // 肋框（每 1.5m 一道）
    const nRib = Math.round((zB - zA) / 1.5);
    for (let i = 0; i <= nRib; i++) {
      const z = zA + 0.35 + i * 1.5;
      if (z > zB - 0.3) break;
      rawBox('frame', 0.14, h, 0.16, -hw + 0.07, h / 2, z);
      rawBox('frame', 0.14, h, 0.16, hw - 0.07, h / 2, z);
      rawBox('frame', 2 * hw, 0.16, 0.16, 0, h - 0.1, z);
      if (i % 2 === 0) {
        rawBox('cyan', 0.03, 0.55, 0.04, -hw + 0.16, 1.65, z + 0.09);
        rawBox('cyan', 0.03, 0.55, 0.04, hw - 0.16, 1.65, z + 0.09);
      }
    }
    // 顶部管线 + 卡箍
    for (const px of [-0.55, 0.0, 0.55]) {
      tube('frame', px, h - 0.28, zA, px, h - 0.28, zB, px === 0 ? 0.09 : 0.06, 8);
    }
    for (let i = 0; i < 8; i++) {
      const z = zA + 1.0 + i * 2.9;
      rawBox('frame', 1.5, 0.1, 0.1, 0, h - 0.22, z);
    }
    // 顶部灯带
    for (let z = zA + 1.6; z < zB - 0.6; z += 3.2) {
      rawBox('lamp', 0.5, 0.05, 1.15, 0, h - 0.035, z);
      rawBox('frame', 0.62, 0.08, 1.3, 0, h - 0.075, z);
    }
    // 两侧壁面嵌板 + 偶尔的屏幕/设备箱
    for (let i = 0; i < 10; i++) {
      const z = zA + 1.2 + i * 2.2;
      rawBox('dark', 0.04, 0.9, 1.1, -hw + 0.02, 1.5, z);
      rawBox('frame', 0.06, 1.0, 1.2, -hw + 0.05, 1.5, z);
      if (i % 3 === 0) {
        rawBox('cyan', 0.05, 0.04, 0.5, -hw + 0.09, 2.05, z);
        rawBox('dark', 0.6, 0.7, 0.8, hw - 0.32, 1.4, z + 0.6);
        rawBox('amber', 0.03, 0.1, 0.1, hw - 0.62, 1.75, z + 0.25);
      }
    }
    // 门框（两端）+ 地面警示带
    rawBox('frame', 2 * hw + 0.3, 0.16, 0.2, 0, h - 0.05, zA + 0.1);
    rawBox('amber', 2.6, 0.006, 0.16, 0, 0.02, zA + 0.55);
    box('warn', -hw, hw, 0.004, 0.014, zB - 0.55, zB - 0.3);
    // 指示牌：通道两端
    signQuad(1, 1.4, 0.46, 0, 3.02, zB - 0.06, 0);
    signQuad(2, 1.5, 0.5, 0, 3.02, zA + 0.06, 0);
    // 端口警示灯
    rawBox('amber', 0.1, 0.1, 0.04, -hw + 0.2, 2.7, zA + 0.12);
    rawBox('amber', 0.1, 0.1, 0.04, hw - 0.2, 2.7, zA + 0.12);
  })();

  /* ── 住舱 ────────────────────────────────────────────────── */
  (function buildDorm() {
    const { x1, x2, z1, z2, h } = DORM;
    shell({
      x1, x2, z1, z2, y0: 0, y1: h, t: 0.16,
      doors: [{ side: 'w', at: 2.0, w: 2.0, h: 2.4 }],
    });
    // 双层铺位（东侧）
    for (let b = 0; b < 2; b++) {
      const y = 0.45 + b * 1.0;
      rawBox('frame', 1.35, 0.1, 2.3, x2 - 0.75, y, 2.1);
      rawBox('white', 1.25, 0.14, 2.15, x2 - 0.75, y + 0.11, 2.1);
      rawBox('dark', 0.9, 0.06, 0.45, x2 - 0.75, y + 0.21, 1.2);
      rawBox('frame', 0.06, 0.9, 0.06, x2 - 1.4, y + 0.45, 1.0);
      rawBox('frame', 0.06, 0.9, 0.06, x2 - 1.4, y + 0.45, 3.2);
    }
    // 储物柜（北墙）
    for (let i = 0; i < 4; i++) {
      rawBox('frame', 0.62, 1.9, 0.5, x1 + 0.4 + i * 0.66, 0.95, z2 - 0.24);
      rawBox('cyan', 0.05, 0.05, 0.03, x1 + 0.4 + i * 0.66, 1.55, z2 - 0.5);
    }
    // 折叠桌 + 舷窗式装饰画
    rawBox('white', 1.2, 0.08, 0.7, x1 + 1.1, 0.76, z1 + 1.0);
    rawBox('frame', 0.06, 0.76, 0.06, x1 + 0.6, 0.38, z1 + 1.0);
    rawBox('frame', 0.06, 0.76, 0.06, x1 + 1.6, 0.38, z1 + 1.0);
    // 天花暖光灯
    rawBox('lamp', 1.1, 0.05, 0.7, 4.4, h - 0.03, 2.0);
    rawBox('frame', 1.24, 0.09, 0.84, 4.4, h - 0.08, 2.0);
    // 墙面装饰：星图切片
    rawBox('dark', 1.2, 0.8, 0.03, 4.4, 1.9, z1 + 0.06);
    rawBox('cyan', 1.05, 0.02, 0.01, 4.4, 2.25, z1 + 0.08);
    rawBox('amber', 0.3, 0.02, 0.01, 4.9, 1.6, z1 + 0.08);
    // 门口指示牌
    signQuad(6, 1.1, 0.36, x1 + 0.12, 2.75, 2.0, Math.PI / 2);
    // 壁灯
    rawBox('amber', 0.05, 0.16, 0.05, x1 + 0.04, 1.6, z1 + 0.5);
  })();

  /* ── 中央环形大厅 ────────────────────────────────────────── */
  (function buildHall() {
    const { cx, cz, R, rPit, galleryY, galleryRIn, galleryA0, galleryA1, l2Y, l2RIn, ceilY } = HALL;
    const gapHalf = Math.asin(1.9 / R);   // 四个门洞（+z/-z/+x/-x）的半角

    // 地板 / 一层环廊 / 二层环廊 / 天花
    ringSlab('floor', rPit, R, 0, 0.35, 0, TAU, HQ ? 96 : 64);
    ringSlab('floor', galleryRIn, R, galleryY, 0.3, galleryA0, galleryA1, HQ ? 34 : 24);
    ringSlab('ceil', l2RIn, R, l2Y, 0.3, 0, TAU, HQ ? 72 : 48);
    ringSlab('ceil', 0, R, ceilY, 0.4, 0, TAU, HQ ? 72 : 48);
    // 井壁 / 井底
    arcWall('dark', rPit, -4.8, 0, 0, TAU, HQ ? 64 : 40);
    ringSlab('dark', 0, rPit, -4.8, 0.3, 0, TAU, HQ ? 48 : 32);
    // 下层地板发光环
    ringSlab('cyan', 1.1, 1.22, -4.66, 0.02, 0, TAU, 40);
    // 外墙：下段留 4 个门洞，上段整圈
    for (let k = 0; k < 4; k++) {
      const base = k * (Math.PI / 2);
      arcWall('wallRing', R, 0, galleryY, base + gapHalf, base + Math.PI / 2 - gapHalf, HQ ? 14 : 10);
    }
    arcWall('wallRing', R, galleryY, ceilY, 0, TAU, HQ ? 72 : 48);
    // 墙面竖肋（避开四个门洞）
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      let nearGap = false;
      for (let g = 0; g < 4; g++) {
        let d = a - g * (Math.PI / 2);
        while (d < -Math.PI) d += TAU;
        while (d > Math.PI) d -= TAU;
        if (Math.abs(d) < gapHalf + 0.1) nearGap = true;
      }
      if (nearGap) continue;
      const x = Math.cos(a) * (R - 0.09);
      const z = cz + Math.sin(a) * (R - 0.09);
      rawBox('frame', 0.16, ceilY - 0.6, 0.16, x, (ceilY - 0.6) / 2 + 0.3, z, 0, -a, 0);
    }
    // 各层发光环带
    for (const yy of [0.03, galleryY + 0.02, l2Y + 0.02]) {
      ringSlab('cyan', R - 0.32, R - 0.2, yy, 0.02, 0, TAU, HQ ? 72 : 48);
    }
    // 顶部中央吊环灯
    torusArc('lamp', 3.6, 0.09, 0, TAU, cx, ceilY - 0.55, cz, 8);
    torusArc('frame', 3.9, 0.05, 0, TAU, cx, ceilY - 0.35, cz, 6);
    // 井口栏杆（一层）
    const railR = rPit + 0.05;
    const nPost = 24;
    for (let i = 0; i < nPost; i++) {
      const a = (i / nPost) * TAU;
      rawBox('frame', 0.06, 1.05, 0.06, Math.cos(a) * railR, 0.52, cz + Math.sin(a) * railR, 0, -a, 0);
    }
    torusArc('frame', railR, 0.04, 0, TAU, cx, 0.55, cz, 6);
    torusArc('cyan', railR, 0.045, 0, TAU, cx, 1.06, cz, 6);
    // 一层环廊栏杆（避开舷梯口）
    const gRailR = galleryRIn + 0.02;
    const stairA0 = STAIR.a - STAIR.half - 0.02;
    const stairA1 = STAIR.a + STAIR.half + 0.02;
    const railSpans = [[galleryA0, stairA0], [stairA1, galleryA1]];
    for (const [a0, a1] of railSpans) {
      const n = Math.max(3, Math.ceil((a1 - a0) / 0.14));
      for (let i = 0; i <= n; i++) {
        const a = a0 + (i / n) * (a1 - a0);
        rawBox('frame', 0.06, 1.05, 0.06, Math.cos(a) * gRailR, galleryY + 0.52, cz + Math.sin(a) * gRailR, 0, -a, 0);
      }
      torusArc('frame', gRailR, 0.04, a0, a1, cx, galleryY + 0.55, cz, 6);
      torusArc('cyan', gRailR, 0.045, a0, a1, cx, galleryY + 1.06, cz, 6);
    }
    // 二层环廊栏杆（整圈）
    const l2Rail = l2RIn + 0.06;
    const nPost2 = 44;
    for (let i = 0; i < nPost2; i++) {
      const a = (i / nPost2) * TAU;
      rawBox('frame', 0.06, 1.05, 0.06, Math.cos(a) * l2Rail, l2Y + 0.52, cz + Math.sin(a) * l2Rail, 0, -a, 0);
    }
    torusArc('frame', l2Rail, 0.04, 0, TAU, cx, l2Y + 0.55, cz, 6);
    torusArc('cyan', l2Rail, 0.045, 0, TAU, cx, l2Y + 1.06, cz, 6);
    // 结构柱（8 根，避开门洞角度）
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + Math.PI / 8;
      const rr = R - 0.35;
      const x = Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      rawBox('frame', 0.34, l2Y, 0.34, x, l2Y / 2, z, 0, -a, 0);
      rawBox('dark', 0.5, 0.18, 0.5, x, l2Y - 0.1, z, 0, -a, 0);
      rawBox('cyan', 0.06, 0.5, 0.06, x, 2.4, z, 0, -a, 0);
    }
    // 门洞框 + 地面警示 + 门槛灯
    for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      addPortal(dx, dz);
    }
    // 舷梯（22 级，从一层地面盘旋上到 4.3m 环廊）
    const run = (STAIR.topR - STAIR.botR) / STAIR.steps;
    const rise = galleryY / STAIR.steps;
    const a = STAIR.a;
    const ca = Math.cos(a), sa = Math.sin(a);
    const latX = -sa, latZ = ca;
    for (let i = 0; i < STAIR.steps; i++) {
      const rOut = STAIR.topR - i * run;
      const rIn = rOut - run;
      const rMid = (rIn + rOut) / 2;
      const top = galleryY - (i + 1) * rise;
      if (top <= 0.001) continue;
      const halfW = rMid * STAIR.half;
      const w = 2 * halfW;
      rawBox('floor', w, top, run + 0.02, rMid * ca, top / 2, cz + rMid * sa, 0, Math.PI / 2 - a, 0);
      // 踏板前缘警示
      rawBox('amber', w, 0.03, 0.05, rMid * ca, top + 0.015, cz + rMid * sa, 0, Math.PI / 2 - a, 0);
      // 台阶下的实体挡板（防止钻到楼梯底下）
      bPolar(cx, cz, a - STAIR.half, a + STAIR.half, rIn, rOut, 0, Math.max(0.06, top - 0.24));
      // 走向/行走区域
      wPolar(cx, cz, a - STAIR.half, a + STAIR.half, rIn, rOut + 0.005, top);
    }
    // 最底一级（贴地）只作为可走面
    wPolar(cx, cz, a - STAIR.half, a + STAIR.half, STAIR.botR, STAIR.botR + run, 0);
    // 楼梯底部的接地挡块（挡住从侧面直接穿入楼梯实体）
    // 舷梯扶手 + 立柱（沿扇形两侧边缘，随半径线性外扩）
    for (const s of [-1, 1]) {
      const latBot = latX * s * STAIR.botR * STAIR.half * 0.95;
      const latBotZ = latZ * s * STAIR.botR * STAIR.half * 0.95;
      const latTop = latX * s * STAIR.topR * STAIR.half * 0.95;
      const latTopZ = latZ * s * STAIR.topR * STAIR.half * 0.95;
      beam('frame',
        STAIR.botR * ca + latBot, 0.95, cz + STAIR.botR * sa + latBotZ,
        STAIR.topR * ca + latTop, galleryY + 0.95, cz + STAIR.topR * sa + latTopZ,
        0.06);
      for (let q = 0; q < 6; q++) {
        const kk = q / 5;
        const r = STAIR.botR + kk * (STAIR.topR - STAIR.botR);
        const top = galleryY * kk;
        const ox = latX * s * r * STAIR.half * 0.95;
        const oz = latZ * s * r * STAIR.half * 0.95;
        rawBox('frame', 0.05, 0.95, 0.05, r * ca + ox, top + 0.475, cz + r * sa + oz, 0, Math.PI / 2 - a, 0);
      }
    }
    // 大厅指示牌（主通道入口上方）
    signQuad(2, 2.0, 0.62, 0, 5.0, cz + R - 0.2, Math.PI);

    // 反应堆监视台（正对主通道入口，可俯视反应堆井）
    const conZ = -21.3;
    rawBox('frame', 2.7, 0.92, 0.8, 0, 0.46, conZ);
    rawBox('white', 2.5, 0.08, 0.72, 0, 0.94, conZ - 0.02, -0.32, 0, 0);
    rawBox('dark', 2.7, 0.12, 0.86, 0, 0.04, conZ);
    rawBox('amber', 0.5, 0.06, 0.03, -1.05, 0.75, conZ + 0.41);
    rawBox('cyan', 0.5, 0.06, 0.03, 1.05, 0.75, conZ + 0.41);
    // 监视屏（单独 mesh，方便做扫描动画）
    const conScr = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.62), MATS.screenA);
    conScr.position.set(0, 1.24, conZ + 0.28);
    conScr.rotation.x = -0.22;
    group.add(conScr);
    scrs.push({ mesh: conScr, mat: MATS.screenA, speed: 0.02 });
    bBox(-1.4, 1.4, conZ - 0.5, conZ + 0.5, 0, 1.15);
    // 监视台上方指示牌
    signQuad(7, 1.5, 0.48, 0, 2.45, conZ + 0.05, 0);
    // 环廊靠墙长凳
    for (const aa of [70 * DEG, 112 * DEG]) {
      const rr = 9.85;
      rawBox('white', 1.9, 0.12, 0.6, Math.cos(aa) * rr, galleryY + 0.45, cz + Math.sin(aa) * rr, 0, -aa, 0);
      rawBox('frame', 0.1, 0.45, 0.5, Math.cos(aa) * rr, galleryY + 0.22, cz + Math.sin(aa) * rr, 0, -aa, 0);
    }
  })();

  // 大厅四个门洞的框（在地面层）
  function addPortal(dx, dz) {
    const R = HALL.R;
    const cx = dx * (R - 0.04);
    const cz = HALL.cz + dz * (R - 0.04);
    const lx = -dz, lz = dx;
    const phi = Math.atan2(-lz, lx);
    for (const s of [-1, 1]) {
      rawBox('frame', 0.36, 4.32, 0.6, cx + lx * 1.98 * s, 2.16, cz + lz * 1.98 * s, 0, phi, 0);
    }
    rawBox('frame', 4.32, 0.4, 0.6, cx, 4.12, cz, 0, phi, 0);
    rawBox('cyan', 3.9, 0.02, 0.12, cx, 0.02, cz, 0, phi, 0);
    rawBox('amber', 3.9, 0.006, 0.22, cx - lx * 0.55, 0.012, cz - lz * 0.55, 0, phi, 0);
  }

  /* ── 观景廊 + 观景舱（大舷窗 → 地球） ──────────────────────── */
  (function buildObservation() {
    const { cA, cB, z1, z2, h, dx1, dx2, dz1, dz2, dh } = OBS;
    const t = 0.16;
    // 廊道
    box('floor', cA, cB, -0.3, 0, z1, z2);
    box('ceil', cA, cB, h, h + t, z1, z2);
    box('wall', cA, cB, 0, h, z1 - t, z1);
    box('wall', cA, cB, 0, h, z2, z2 + t);
    // 廊道肋框
    for (let x = cA + 0.7; x < cB - 0.2; x += 1.6) {
      rawBox('frame', 0.14, h, 0.16, x, h / 2, z1 + 0.07);
      rawBox('frame', 0.14, h, 0.16, x, h / 2, z2 - 0.07);
      rawBox('frame', 0.16, 0.16, z2 - z1, x, h - 0.1, (z1 + z2) / 2);
    }
    // 廊道灯 + 导光条
    for (let x = cA + 1.2; x < cB; x += 3.0) {
      rawBox('lamp', 1.0, 0.05, 0.5, x, h - 0.03, -26);
      rawBox('frame', 1.14, 0.08, 0.62, x, h - 0.075, -26);
    }
    box('cyan', cA, cB, 0.012, 0.026, z1 + 0.25, z1 + 0.31);
    box('cyan', cA, cB, 0.012, 0.026, z2 - 0.31, z2 - 0.25);
    // 观察舱包围墙
    box('floor', dx1, dx2, -0.3, 0, dz1, dz2);
    box('ceil', dx1, dx2, dh, dh + t, dz1, dz2);
    box('wall', dx1, dx2, 0, dh, dz1 - t, dz1);
    box('wall', dx1, dx2, 0, dh, dz2, dz2 + t);
    // 西墙（长廊开口）：开口上方与两侧墙
    box('wall', dx1 - t, dx1, h, dh, dz1 - t, dz2 + t);
    box('wall', dx1 - t, dx1, 0, dh, dz1 - t, z1);
    box('wall', dx1 - t, dx1, 0, dh, z2, dz2 + t);
    // 东端墙 + 8×3 舷窗（窗 z -30..-22，y 1.2..4.2）
    const winZ0 = -30, winZ1 = -22, winY0 = 1.2, winY1 = 4.2;
    box('wall', dx2, dx2 + t, 0, dh, dz1 - t, winZ0);
    box('wall', dx2, dx2 + t, 0, dh, winZ1, dz2 + t);
    box('wall', dx2, dx2 + t, 0, winY0, winZ0, winZ1);
    box('wall', dx2, dx2 + t, winY1, dh, winZ0, winZ1);
    // 窗框
    rawBox('frame', 0.3, 0.14, winZ1 - winZ0 + 0.4, dx2 + 0.1, winY0 - 0.07, -26);
    rawBox('frame', 0.3, 0.18, winZ1 - winZ0 + 0.4, dx2 + 0.1, winY1 + 0.09, -26);
    for (const zz of [winZ0, -28, -26, -24, winZ1]) {
      rawBox('frame', 0.26, winY1 - winY0, 0.1, dx2 + 0.08, (winY0 + winY1) / 2, zz);
    }
    rawBox('cyan', 0.1, 0.04, 6.6, dx2 + 0.02, winY0 + 0.05, -26);
    // 玻璃
    const glass = new THREE.PlaneGeometry(8, 3);
    put('glass', glass, mat4(dx2 + 0.02, (winY0 + winY1) / 2, -26, 0, -Math.PI / 2, 0));
    // 观景长凳（面向舷窗）
    for (const zz of [-29.1, -22.9]) {
      rawBox('white', 1.0, 0.12, 2.3, 22.5, 0.46, zz);
      rawBox('frame', 0.8, 0.4, 0.16, 22.5, 0.22, zz - 0.9);
      rawBox('frame', 0.8, 0.4, 0.16, 22.5, 0.22, zz + 0.9);
      bBox(21.95, 23.05, zz - 1.2, zz + 1.2, 0, 0.9);
    }
    // 舱内地板导光 + 观景指示
    box('cyan', dx1 + 0.5, dx2 - 0.2, 0.012, 0.026, -26.06, -25.94);
    // 侧墙数据屏
    for (const side of [-1, 1]) {
      const zz = side < 0 ? dz1 + 0.9 : dz2 - 0.9;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.72), MATS.screenB);
      scr.position.set(22.8, 2.35, zz);
      scr.rotation.y = side < 0 ? 0 : Math.PI;
      group.add(scr);
      scrs.push({ mesh: scr, mat: MATS.screenB, speed: 0.008 });
      rawBox('frame', 1.42, 0.84, 0.06, 22.8, 2.35, zz + (side < 0 ? 0.03 : -0.03));
    }
    // 指示牌
    signQuad(3, 1.7, 0.54, dx1 + 0.16, dh - 0.4, -26, -Math.PI / 2);
    // 台阶式观景台（窗前抬高一级）
    rawBox('floor', dx1 + 0.8, dx2 - 0.2, 0, 0.12, winZ0 + 0.4, winZ1 - 0.4);
    rawBox('amber', 0.06, 0.13, winZ1 - winZ0 - 0.8, dx1 + 0.78, 0.06, -26);
  })();

  /* ── 实验舱 ──────────────────────────────────────────────── */
  (function buildLab() {
    const { cA, cB, z1, z2, h, rx1, rx2, rz1, rz2, rh } = LAB;
    const t = 0.16;
    // 支廊
    box('floor', cA, cB, -0.3, 0, z1, z2);
    box('ceil', cA, cB, h, h + t, z1, z2);
    box('wall', cA, cB, 0, h, z1 - t, z1);
    box('wall', cA, cB, 0, h, z2, z2 + t);
    for (let x = cA - 0.8; x > cB; x += 1.5) {
      rawBox('frame', 0.14, h, 0.14, x, h / 2, z1 + 0.07);
      rawBox('frame', 0.14, h, 0.14, x, h / 2, z2 - 0.07);
    }
    box('cyan', cA, cB, 0.012, 0.026, z1 + 0.25, z1 + 0.31);
    box('cyan', cA, cB, 0.012, 0.026, z2 - 0.31, z2 - 0.25);
    // 实验舱主体
    shell({
      x1: rx1, x2: rx2, z1: rz1, z2: rz2, y0: 0, y1: rh, t,
      doors: [{ side: 'e', at: -26, w: 3.0, h: 3.2 }],
    });
    // 主实验台（北侧长台）
    rawBox('white', 5.6, 0.1, 1.05, -19.6, 0.98, -29.6);
    rawBox('frame', 5.5, 0.9, 0.9, -19.6, 0.48, -29.6);
    rawBox('cyan', 5.3, 0.03, 0.06, -19.6, 0.9, -30.08);
    // 台面设备
    for (let i = 0; i < 5; i++) {
      const x = -21.7 + i * 1.05;
      rawBox('dark', 0.62, 0.42, 0.5, x, 1.24, -29.7);
      rawBox('cyan', 0.5, 0.03, 0.36, x, 1.46, -29.7);
      rawBox('amber', 0.06, 0.05, 0.04, x + 0.24, 1.32, -29.46);
    }
    // 培养舱（玻璃柱 + 内部辉光）
    for (let i = 0; i < 3; i++) {
      const x = -22.4 + i * 1.7;
      tube('glass', x, 0.1, -25.0, x, 2.6, -25.0, 0.42, 16);
      tube('reactorCore', x, 0.2, -25.0, x, 2.45, -25.0, 0.3, 12);
      rawBox('frame', 0.96, 0.12, 0.96, x, 0.06, -25.0);
      rawBox('frame', 0.96, 0.14, 0.96, x, 2.66, -25.0);
      rawBox('cyan', 0.1, 0.1, 2.4, x - 0.5, 1.35, -25.0);
      rawBox('amber', 0.08, 0.08, 0.06, x, 2.2, -24.5);
    }
    // 南侧副台 + 培养柜
    rawBox('white', 3.4, 0.1, 0.95, -19.0, 0.95, -22.0);
    rawBox('frame', 3.3, 0.85, 0.8, -19.0, 0.46, -22.0);
    for (let i = 0; i < 4; i++) {
      rawBox('dark', 0.7, 0.5, 0.5, -22.6, 1.4 + i * 0.62, -21.4);
      rawBox('cyan', 0.5, 0.02, 0.36, -22.6, 1.66 + i * 0.62, -21.4);
    }
    // 西墙设备机柜
    for (let i = 0; i < 3; i++) {
      rawBox('frame', 0.9, 2.4, 0.8, rx1 + 0.55, 1.2, -28.6 + i * 1.3);
      rawBox('cyan', 0.04, 0.3, 0.5, rx1 + 1.02, 1.9, -28.6 + i * 1.3);
      rawBox('dark', 0.5, 0.35, 0.06, rx1 + 0.55, 1.0, -28.6 + i * 1.3);
    }
    // 数据屏（北墙）
    const s1 = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), MATS.screenB);
    s1.position.set(-16.9, 2.55, rz1 + 0.03);
    group.add(s1);
    scrs.push({ mesh: s1, mat: MATS.screenB, speed: 0.012 });
    rawBox('frame', 2.16, 1.14, 0.06, -16.9, 2.55, rz1 + 0.01);
    // 天花灯
    for (const xx of [-21.5, -18.5, -16.0]) {
      rawBox('lamp', 1.3, 0.05, 0.9, xx, rh - 0.03, -26);
      rawBox('frame', 1.44, 0.09, 1.04, xx, rh - 0.08, -26);
    }
    // 顶棚管线
    tube('frame', rx1 + 0.4, rh - 0.25, rz1 + 0.6, rx1 + 0.4, rh - 0.25, rz2 - 0.6, 0.07);
    tube('frame', rx1 + 0.75, rh - 0.22, rz1 + 0.6, rx1 + 0.75, rh - 0.22, rz2 - 0.6, 0.05);
    // 门口警示 + 指示牌
    box('warn', -11.35, -10.9, 0.004, 0.014, -27.6, -24.4);
    signQuad(4, 1.5, 0.48, rx2 - 0.2, 3.5, -26, Math.PI / 2);
    signQuad(4, 1.2, 0.38, cB - 0.1, h - 0.35, -26 + 1.1, -Math.PI / 2);
    bBox(-22.5, -16.2, -30.3, -28.9, 0, 1.05);
    bBox(-21.0, -16.8, -22.6, -21.4, 0, 1.0);
  })();

  /* ── 指挥席 ──────────────────────────────────────────────── */
  (function buildCommand() {
    const { cA, cB, hw, h, rx1, rx2, rz1, rz2, rh } = CMD;
    const t = 0.16;
    // 支廊
    box('floor', -hw, hw, -0.3, 0, cA, cB);
    box('ceil', -hw, hw, h, h + t, cA, cB);
    box('wall', -hw - t, -hw, 0, h, cA, cB);
    box('wall', hw, hw + t, 0, h, cA, cB);
    for (let z = cA + 0.6; z < cB; z += 1.4) {
      rawBox('frame', 0.14, h, 0.14, -hw + 0.07, h / 2, z);
      rawBox('frame', 0.14, h, 0.14, hw - 0.07, h / 2, z);
    }
    box('cyan', -0.9, -0.84, 0.012, 0.026, cA, cB);
    box('cyan', 0.84, 0.9, 0.012, 0.026, cA, cB);
    // 指挥舱主体
    shell({
      x1: rx1, x2: rx2, z1: rz1, z2: rz2, y0: 0, y1: rh, t,
      doors: [{ side: 'n', at: 0, w: 3.0, h: 3.2 }],
    });
    // 半环控制台（中段 5.4m + 两侧 2.6m 折角翼）
    rawBox('frame', 5.4, 0.95, 0.85, 0, 0.48, -47.25);
    rawBox('white', 5.2, 0.09, 0.72, 0, 1.0, -47.15, -0.34, 0, 0);
    rawBox('cyan', 4.9, 0.03, 0.05, 0, 0.93, -46.86);
    for (const s of [-1, 1]) {
      const a = s * 0.42;
      rawBox('frame', 2.7, 0.95, 0.8, s * 3.95, 0.48, -46.35, 0, a * s, 0);
      rawBox('white', 2.55, 0.09, 0.68, s * 3.95, 1.0, -46.3, -0.34, a * s, 0);
    }
    // 控制台屏幕
    const cs = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.72), MATS.screenC);
    cs.position.set(0, 1.28, -46.72);
    cs.rotation.x = -0.28;
    group.add(cs);
    scrs.push({ mesh: cs, mat: MATS.screenC, speed: 0.014 });
    // 座椅 ×3
    for (const xx of [-1.9, 0, 1.9]) {
      rawBox('dark', 0.62, 0.12, 0.6, xx, 0.62, -45.7);
      rawBox('dark', 0.62, 0.85, 0.12, xx, 1.05, -45.42);
      rawBox('frame', 0.14, 0.6, 0.14, xx, 0.3, -45.7);
    }
    // 全息星图（投影台 + 悬浮环）
    rawBox('frame', 1.5, 0.9, 1.5, 0, 0.45, -43.4);
    rawBox('dark', 1.3, 0.06, 1.3, 0, 0.92, -43.4);
    rawBox('cyan', 1.2, 0.02, 1.2, 0, 0.96, -43.4);
    holoGroup.position.set(0, 1.05, -43.4);
    // 远端大屏
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.5), MATS.screenC);
      m.position.set(s * 3.4, 2.75, rz1 + 0.03);
      group.add(m);
      scrs.push({ mesh: m, mat: MATS.screenC, speed: 0.01 + 0.004 * s });
      rawBox('frame', 3.18, 1.66, 0.06, s * 3.4, 2.75, rz1 + 0.01);
    }
    // 侧墙灯带 / 顶部灯
    box('cyan', rx1 + 0.02, rx1 + 0.05, 0.2, 0.26, rz1 + 0.5, rz2 - 0.5);
    box('cyan', rx2 - 0.05, rx2 - 0.02, 0.2, 0.26, rz1 + 0.5, rz2 - 0.5);
    for (const xx of [-4.5, 0, 4.5]) {
      rawBox('lamp', 1.6, 0.05, 0.8, xx, rh - 0.03, -44.5);
      rawBox('frame', 1.74, 0.09, 0.94, xx, rh - 0.08, -44.5);
    }
    signQuad(5, 1.9, 0.58, 0, 3.95, rz2 + t - 0.04, 0);
    signQuad(5, 1.3, 0.42, -0.3, h - 0.35, cA + 0.08, 0);
    bBox(-4.7, 4.7, -47.9, -46.8, 0, 1.2);
    bBox(-1.0, 1.0, -44.4, -42.4, 0, 1.0);
  })();

  /* ── 走廊连接口 / 门槛 ───────────────────────────────────── */
  // 主通道 → 大厅：地面开口处的门框（在地面层，通过大厅墙上的门洞）
  (function buildJunctions() {
    const t = 0.16;
    // 主通道南端（进大厅）：墙洞由大厅的 +z 门框负责，这里补走廊侧的收口
    rawBox('frame', 3.1, 0.18, 0.24, 0, 3.4 - 0.09, COR.zA + 0.05);
    // 观景廊两段交界（走廊 → 观察舱）上方门楣
    rawBox('frame', OBS.z2 - OBS.z1 + 0.3, 0.24, 0.2, OBS.dx1 + 0.05, OBS.h - 0.12, -26);
    // 实验舱支廊 → 实验舱：门框已由 shell 生成
    // 住舱门槛
    rawBox('cyan', 2.1, 0.02, 0.12, 1.55, 0.012, 2.0);
    // 气闸舱 → 主通道门槛灯
    rawBox('cyan', 2.6, 0.02, 0.12, 0, 0.012, AIR.z1 - 0.02);
    // 支廊地面导光
    box('cyan', OBS.cA + 0.4, OBS.cB - 0.2, 0.012, 0.024, -26.02, -25.98);
    box('cyan', LAB.cB, LAB.cA - 0.3, 0.012, 0.024, -26.02, -25.98);
    box('cyan', -0.03, 0.03, 0.012, 0.024, CMD.cA + 0.3, CMD.cB - 0.3);
    void t;
  })();

  /* ── 星空 / 地球（观景窗外的自建宇宙） ────────────────────── */
  (function buildSpace() {
    const starSphere = new THREE.Mesh(new THREE.SphereGeometry(500, HQ ? 40 : 24, HQ ? 24 : 16), MATS.stars);
    starSphere.frustumCulled = false;
    scene.add(starSphere);
    starSphereRef = starSphere;

    earth = new THREE.Mesh(new THREE.SphereGeometry(26, HQ ? 56 : 32, HQ ? 40 : 24), MATS.earth);
    earth.position.set(170, 6, -26);
    earth.rotation.y = 2.1;
    scene.add(earth);

    const atmo = new THREE.Mesh(new THREE.SphereGeometry(27.6, 40, 24), MATS.atmos);
    atmo.position.copy(earth.position);
    scene.add(atmo);
    atmosRef = atmo;
  })();

  /* ── 环廊舷梯的进入区（楼梯底部的行走区已在楼梯生成里加了） ── */

  /* ── 通行区域定义 ────────────────────────────────────────── */
  (function defineWalk() {
    // 气闸舱
    wBox(-AIR.x + 0.28, AIR.x - 0.28, AIR.z1 + 0.38, AIR.z2 - 0.38, 0);
    // 气闸 → 主通道连接段
    wBox(-1.2, 1.2, AIR.z1 - 0.83, AIR.z1 + 0.9, 0);
    // 主通道
    wBox(-COR.hw + 0.28, COR.hw - 0.28, COR.zA + 0.55, COR.zB - 0.33, 0);
    // 主通道 → 大厅（穿过门洞的短连接段）
    wBox(-1.0, 1.0, -16.6, -14.4, 0);
    // 住舱
    wBox(DORM.x1 + 0.28, DORM.x2 - 0.32, DORM.z1 + 0.28, DORM.z2 - 0.28, 0);
    wBox(0.62, DORM.x1 + 0.85, 1.2, 2.8, 0);          // 住舱门连接段
    // 大厅一层（环形）
    wPolar(HALL.cx, HALL.cz, 0, TAU, HALL.rFloorIn, HALL.rWalkOut, 0);
    // 一层环廊（4.3m）
    wPolar(HALL.cx, HALL.cz, HALL.galleryA0, HALL.galleryA1, HALL.galleryRIn, HALL.rWalkOut, HALL.galleryY);
    // 主通道 → 一层环廊（穿过 +z 门洞、跨过环廊楼板）
    // 注意：走廊地面 0m，环廊 4.3m，所以这条连接段只服务环廊层，需单独一条从楼梯上来后才用
    // 观景廊支廊
    wBox(OBS.cA - 1.3, OBS.cB + 0.5, -26 - 1.32, -26 + 1.32, 0);
    // 观察舱
    wBox(OBS.dx1, OBS.dx2 - 0.38, OBS.dz1 + 0.28, OBS.dz2 - 0.28, 0);
    wBox(OBS.dx1 + 0.8, OBS.dx2 - 0.2, OBS.dz1 + 1.4, OBS.dz2 - 1.4, 0.12); // 窗前抬高观景台
    // 实验舱支廊
    wBox(LAB.cA, LAB.cB + 1.3, -26 - 1.12, -26 + 1.12, 0);
    // 实验舱
    wBox(LAB.rx1 + 0.28, LAB.rx2 + 0.5, LAB.rz1 + 0.28, LAB.rz2 - 0.28, 0);
    // 指挥席支廊
    wBox(-CMD.hw + 0.28, CMD.hw - 0.28, CMD.cA, CMD.cB + 0.9, 0);
    // 指挥席
    wBox(CMD.rx1 + 0.28, CMD.rx2 - 0.28, CMD.rz1 + 0.28, CMD.rz2 + 0.5, 0);
    // 障碍：反应堆监视台 / 指挥控制台 / 实验台 / 观景长凳 / 住舱铺位 / 气闸储物柜
    bBox(-1.4, 1.4, -21.8, -20.8, 0, 1.15);
    bBox(-4.75, 4.75, -47.8, -46.8, 0, 1.2);
    bBox(-22.5, -16.2, -30.3, -28.9, 0, 1.05);
    bBox(-21.0, -16.8, -22.6, -21.4, 0, 1.0);
    bBox(21.95, 23.05, -30.35, -27.85, 0, 0.92);
    bBox(21.95, 23.05, -24.15, -21.65, 0, 0.92);
    bBox(6.0, 7.55, 0.4, 3.9, 0, 1.95);
    bBox(-AIR.x, -AIR.x + 0.62, 8.1, 11.0, 0, 2.1);
    // 家具 / 设备障碍（补全，避免能穿过桌子柜子）
    bBox(-2.3, 2.3, -46.15, -45.3, 0, 1.5);              // 指挥席座椅 x3
    bBox(-1.0, 1.0, -44.4, -42.4, 0, 1.0);               // 全息星图投影台
    bBox(-24.5, -23.4, -29.1, -25.5, 0, 2.5);            // 实验舱西墙机柜
    bBox(-22.9, -18.5, -25.55, -24.45, 0, 2.8);          // 培养舱 x3
    bBox(1.6, 4.3, 4.45, 5.0, 0, 1.95);                  // 住舱储物柜
    bBox(2.0, 3.3, -0.4, 0.4, 0, 0.85);                  // 住舱折叠桌
    bBox(2.1, 2.75, 8.95, 11.45, 0, 0.6);                // 气闸舱长凳
    for (const ci of [0, 3, 6, 9]) {
      const cz2 = COR.zA + 1.2 + ci * 2.2;
      bBox(0.75, 1.42, cz2 + 0.2, cz2 + 1.0, 0, 1.8);    // 主通道东侧设备箱
    }

    // 大厅一层中央井口栏杆（环形障碍兜底，避免从缝隙里蹭出去）
    bPolar(HALL.cx, HALL.cz, 0, TAU, HALL.rPit - 0.15, HALL.rFloorIn - 0.02, 0, 1.2);
  })();

  /* ── 静态几何合并 ────────────────────────────────────────── */
  for (const [key, list] of buckets) {
    const mat = MATS[key];
    if (!mat || !list.length) continue;
    const geo = mergeGeoms(list);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    for (const g of list) g.dispose();
  }
  buckets.clear();

  /* ── 动态对象（不自发光的部分单独放外面做动画） ──────────── */
  const hubGroup = new THREE.Group();
  hubGroup.position.set(HALL.cx, 0, HALL.cz);
  group.add(hubGroup);
  (function buildHub() {
    const parts = [];
    const pushG = (g, m) => { if (m) g.applyMatrix4(m); parts.push(g); };
    // 中央轴柱（从井底一直伸到轮毂）
    const col = new THREE.CylinderGeometry(0.55, 0.7, 9.0, HQ ? 20 : 12);
    pushG(col, mat4(0, -0.3, 0));
    // 上下两个箍
    for (const [yy, rr] of [[1.35, 1.9], [2.55, 2.7]]) {
      const t = new THREE.TorusGeometry(rr, 0.11, 8, HQ ? 48 : 28);
      t.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      pushG(t, mat4(0, yy, 0));
      // 辐条
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const sp = new THREE.BoxGeometry(rr - 0.5, 0.1, 0.12);
        sp.applyMatrix4(new THREE.Matrix4().makeRotationY(-a));
        sp.applyMatrix4(new THREE.Matrix4().makeTranslation(Math.cos(a) * (rr + 0.5) / 2, yy, Math.sin(a) * (rr + 0.5) / 2));
        pushG(sp, null);
      }
    }
    const mesh = new THREE.Mesh(mergeGeoms(parts), MATS.hubDark);
    for (const g of parts) g.dispose();
    hubGroup.add(mesh);
    // 轮毂上的青色光环（单独材质，方便脉冲）
    hubGlow = new THREE.Mesh(new THREE.TorusGeometry(2.35, 0.05, 6, 48), MATS.cyan);
    hubGlow.rotation.x = Math.PI / 2;
    hubGlow.position.y = 1.9;
    hubGroup.add(hubGlow);
    // 中央核心
    hubCore = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 3.4, 16), MATS.reactorCore);
    hubCore.position.y = 1.6;
    hubGroup.add(hubCore);
  })();

  // 反应堆核心（井底）
  reactorCore = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.7, 1.2, HQ ? 32 : 20), MATS.reactorCore);
  reactorCore.position.set(HALL.cx, -3.6, HALL.cz);
  group.add(reactorCore);
  reactorGlow = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.35, 32), MATS.reactorGlow);
  reactorGlow.position.set(HALL.cx, -4.3, HALL.cz);
  group.add(reactorGlow);
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.5 - i * 0.35, 0.05, 6, 40), MATS.cyan);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(HALL.cx, -2.6 + i * 0.5, HALL.cz);
    group.add(ring);
  }

  // 全息星图
  (function buildHolo() {
    const parts = [];
    const disc = new THREE.RingGeometry(0.25, 1.35, 48);
    disc.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    parts.push(disc);
    for (let i = 0; i < 3; i++) {
      const rr = 0.55 + i * 0.35;
      const t = new THREE.TorusGeometry(rr, 0.012, 4, 48);
      t.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2 + (i - 1) * 0.12));
      parts.push(t);
    }
    const mesh = new THREE.Mesh(mergeGeoms(parts), MATS.holo);
    for (const g of parts) g.dispose();
    holoGroup.add(mesh);
    // 星点
    const n = HQ ? 160 : 80;
    const arr = new Float32Array(n * 3);
    const rnd = rngFactory(4444);
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU;
      const rr = 0.35 + rnd() * 1.2;
      arr[i * 3] = Math.cos(a) * rr;
      arr[i * 3 + 1] = (rnd() - 0.5) * 0.5 + 0.35;
      arr[i * 3 + 2] = Math.sin(a) * rr;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const pm = new THREE.PointsMaterial({
      color: new THREE.Color(0x9ff8ff).multiplyScalar(1.3),
      size: 0.055,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    holoPointsMat = pm;
    holoGroup.add(new THREE.Points(pg, pm));
  })();

  /* ── 玩家 / 控制器状态 ───────────────────────────────────── */
  const EYE = 1.62;
  const WALK_SPEED = 2.6;
  const RUN_SPEED = 4.6;
  const STEP_UP = 0.55;
  const STEP_DOWN = 1.15;
  const PITCH_MAX = 80 * DEG;

  const foot = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);
  const vel = { x: 0, z: 0 };
  const position = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);
  let yaw = SPAWN.yaw;
  let pitch = 0;
  let bobPhase = 0;
  let animTime = 0;
  let smoothFloor = foot.y;
  let isInside = false;
  let disposed = false;

  function floorAt(x, z, curFloor) {
    let best = -Infinity;
    for (let i = 0; i < WALK.length; i++) {
      const rg = WALK[i];
      if (!containsXZ(rg, x, z)) continue;
      const f = rg.floor;
      if (f > curFloor + STEP_UP || f < curFloor - STEP_DOWN) continue;
      if (f > best) best = f;
    }
    return best;
  }

  function blockedAt(x, z, floorY) {
    const yLo = floorY + 0.06;
    const yHi = floorY + 1.55;
    for (let i = 0; i < BLOCK.length; i++) {
      const b = BLOCK[i];
      if (b.y1 <= yLo || b.y0 >= yHi) continue;
      if (containsXZ(b, x, z)) return true;
    }
    return false;
  }

  function applyCamera() {
    const bx = Math.cos(yaw) * (Math.sin(bobPhase) * 0.0065 * bobFactor());
    const bz = -Math.sin(yaw) * (Math.sin(bobPhase) * 0.0065 * bobFactor());
    const bobY = Math.sin(bobPhase * 2) * 0.012 * bobFactor() + Math.sin(animTime * 1.35) * 0.0022;
    camera.position.set(foot.x + bx, smoothFloor + EYE + bobY, foot.z + bz);
    camera.rotation.set(pitch, yaw, 0);
  }

  let bobSpeed = 0;
  function bobFactor() {
    return clamp(bobSpeed / RUN_SPEED, 0, 1);
  }

  /* ── 热点 ────────────────────────────────────────────────── */
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const hotspots = [
    { id: 'exit', cn: '离舱返回', desc: '外舱门 A-01 · 解锁气闸并返回轨道视角。', pos: V3(0, 1.55, 12.86) },
    { id: 'viewport', cn: '观景窗', desc: '8 × 3 米主舷窗 · 地球悬在舷外，云层与晨昏线一览无余。', pos: V3(25.1, 2.0, -26) },
    { id: 'command', cn: '指挥席', desc: '半环控制台 · 全息星图与航线推演在这里进行。', pos: V3(0, 1.35, -46.6) },
    { id: 'lab', cn: '实验台', desc: '生命科学实验台 · 培养舱内的样本仍在缓慢生长。', pos: V3(-20.0, 1.2, -29.0) },
    { id: 'dorm', cn: '住舱', desc: '轮班休息舱 · 双层铺位与私人储物柜。', pos: V3(6.5, 1.2, 2.1) },
    { id: 'ladder', cn: '舷梯', desc: '通往一层环廊的舷梯 · 从这里可以俯瞰中央轮毂与反应堆井。', pos: V3(2.65, 1.35, -21.8) },
    { id: 'reactor', cn: '反应堆监视屏', desc: '聚变堆实时工况 · 脚下就是主反应堆井。', pos: V3(0, 1.35, -21.05) },
  ];

  /* ── 交互 ────────────────────────────────────────────────── */
  function interact() {
    if (!isInside || disposed) return null;
    const ex = camera.position.x, ey = camera.position.y, ez = camera.position.z;
    let best = null;
    let bestD = 2.2 * 2.2;
    for (let i = 0; i < hotspots.length; i++) {
      const h = hotspots[i];
      const dx = h.pos.x - ex, dy = h.pos.y - ey, dz = h.pos.z - ez;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /* ── 主更新 ──────────────────────────────────────────────── */
  const sizeTmp = new THREE.Vector2();
  function update(dt, t, input) {
    if (disposed) return;
    dt = clamp(dt || 0, 0, 0.05);
    animTime += dt;
    // 相机等比跟随画布
    if (renderer && renderer.getSize) {
      renderer.getSize(sizeTmp);
      if (sizeTmp.x > 0 && sizeTmp.y > 0) {
        const asp = sizeTmp.x / sizeTmp.y;
        if (Math.abs(asp - camera.aspect) > 1e-4) {
          camera.aspect = asp;
          camera.updateProjectionMatrix();
        }
      }
    }
    // 环境动效
    hubGroup.rotation.y += dt * 0.22;
    if (hubGlow) hubGlow.rotation.z += dt * 0.5;
    if (reactorCore) {
      const pu = 1 + Math.sin(animTime * 2.4) * 0.035;
      reactorCore.scale.set(pu, 1 + Math.sin(animTime * 1.7) * 0.02, pu);
    }
    if (reactorGlow) reactorGlow.material.opacity = 0.62 + Math.sin(animTime * 3.1) * 0.18;
    if (holoGroup) {
      holoGroup.rotation.y += dt * 0.2;
      holoGroup.position.y = 1.05 + Math.sin(animTime * 0.9) * 0.03;
    }
    if (holoPointsMat) holoPointsMat.opacity = 0.65 + Math.sin(animTime * 2.2) * 0.2;
    MATS.cyan.color.copy(cyanBase).multiplyScalar(0.94 + Math.sin(animTime * 2.0) * 0.06);
    MATS.amber.color.copy(amberBase).multiplyScalar(0.94 + Math.sin(animTime * 3.3 + 1.2) * 0.06);
    if (pitLight) pitLight.intensity = 2.4 + Math.sin(animTime * 1.6) * 0.4;
    for (let i = 0; i < scrs.length; i++) {
      const s = scrs[i];
      if (s.mat.map) {
        s.mat.map.offset.y = (s.mat.map.offset.y + s.speed * dt) % 1;
      } else {
        const k = 0.75 + Math.sin(animTime * 6 + i) * 0.18;
        s.mat.color.setScalar(k);
      }
    }
    if (earth) earth.rotation.y += dt * 0.012;

    if (!isInside) return;

    const inp = input || {};
    // 视角（lookX/lookY 为每帧增量）
    yaw -= (inp.lookX || 0);
    pitch -= (inp.lookY || 0);
    pitch = clamp(pitch, -PITCH_MAX, PITCH_MAX);
    if (yaw > Math.PI) yaw -= TAU;
    if (yaw < -Math.PI) yaw += TAU;

    // 目标速度
    const f = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0);
    const s = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    const run = !!inp.run;
    const maxSpd = run ? RUN_SPEED : WALK_SPEED;
    let tvx = 0, tvz = 0;
    const len = Math.hypot(f, s);
    if (len > 1e-4) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const wx = fx * f + rx * s;
      const wz = fz * f + rz * s;
      const inv = 1 / Math.hypot(wx, wz);
      tvx = wx * inv * maxSpd;
      tvz = wz * inv * maxSpd;
    }
    const k = 1 - Math.exp(-(len > 1e-4 ? 11 : 15) * dt);
    vel.x += (tvx - vel.x) * k;
    vel.z += (tvz - vel.z) * k;
    if (Math.abs(vel.x) < 0.002) vel.x = 0;
    if (Math.abs(vel.z) < 0.002) vel.z = 0;

    // 逐轴移动 + 逐轴校验（不能穿墙）
    if (vel.x !== 0) {
      const nx = foot.x + vel.x * dt;
      const nf = floorAt(nx, foot.z, foot.y);
      if (nf > -Infinity && !blockedAt(nx, foot.z, nf)) {
        foot.x = nx; foot.y = nf;
      } else vel.x = 0;
    }
    if (vel.z !== 0) {
      const nz = foot.z + vel.z * dt;
      const nf = floorAt(foot.x, nz, foot.y);
      if (nf > -Infinity && !blockedAt(foot.x, nz, nf)) {
        foot.z = nz; foot.y = nf;
      } else vel.z = 0;
    }
    if (foot.x !== foot.x || foot.z !== foot.z) { foot.set(SPAWN.x, SPAWN.y, SPAWN.z); }

    // 头部晃动 / 平滑楼层过渡
    bobSpeed = Math.hypot(vel.x, vel.z);
    bobPhase += dt * (2.0 + bobSpeed * 1.7);
    smoothFloor = damp(smoothFloor, foot.y, 18, dt);
    position.set(foot.x, foot.y, foot.z);
    applyCamera();
  }

  /* ── 进入 / 离开 ─────────────────────────────────────────── */
  function enter(t) {
    if (disposed) return;
    isInside = true;
    group.visible = true;
    foot.set(SPAWN.x, SPAWN.y, SPAWN.z);
    smoothFloor = SPAWN.y;
    vel.x = vel.z = 0;
    yaw = SPAWN.yaw;
    pitch = 0;
    bobPhase = 0;
    bobSpeed = 0;
    position.copy(foot);
    scene.visible = true;
    applyCamera();
    void t;
  }

  function exit() {
    isInside = false;
    vel.x = vel.z = 0;
    bobSpeed = 0;
  }

  /* ── 资源统计（供 Lead / 冒烟测试读） ───────────────────── */
  function computeStats() {
    let drawCalls = 0;
    let triangles = 0;
    group.traverse((o) => {
      if (!o.isMesh && !o.isPoints) return;
      drawCalls++;
      const g = o.geometry;
      if (!g) return;
      const cnt = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
      triangles += Math.floor(cnt / 3);
    });
    return { drawCalls, triangles };
  }
  const stats = computeStats();

  /* ── 释放 ────────────────────────────────────────────────── */
  function dispose() {
    if (disposed) return;
    disposed = true;
    isInside = false;
    scene.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    // 材质：MATS 里的共享材质 + 动态材质
    const seen = new Set();
    const killMat = (m) => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    };
    for (const k in MATS) killMat(MATS[k]);
    killMat(holoPointsMat);
    for (const t of texList) t.dispose();
    texList.length = 0;
    if (starSphereRef) starSphereRef.geometry.dispose();
    if (earth) earth.geometry.dispose();
    if (atmosRef) atmosRef.geometry.dispose();
    lights.length = 0;
    WALK.length = 0;
    BLOCK.length = 0;
    hotspots.length = 0;
    vel.x = vel.z = 0;
  }

  /* ── 对外接口 ────────────────────────────────────────────── */
  return {
    scene,
    camera,
    group,
    get isInside() { return isInside; },
    enter,
    exit,
    update,
    hotspots,
    interact,
    position,
    dispose,
    stats,
    // 仅供冒烟测试/调试使用（游戏逻辑不要依赖）
    _debug: {
      walkRegions: WALK,
      blockers: BLOCK,
      floorAt,
      blockedAt,
      get yaw() { return yaw; },
      get pitch() { return pitch; },
      get eyeHeight() { return smoothFloor + EYE; },
      spawn: SPAWN,
      layout: { AIR, COR, DORM, OBS, LAB, CMD, HALL, STAIR },
    },
  };
}
