// 深空方舟 · 主编排
// 负责：渲染器 / 状态机 / 相机 / 输入 / HUD 绑定 / 跃迁流程
import * as THREE from 'three';
import { createWorld } from './world.js';
import { createStation } from './station.js';
import { createShip } from './ship.js';
import { createPostFX } from './postfx.js';
import { createAudio } from './audio.js';
import { createMissions } from './missions.js';
import { createInterior } from './interior.js';
import { createPlanetarium } from './planetarium.js';

/* ────────────────────────── 参数与工具 ─────────────────────────── */
const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') === '1';
const CAM_DBG = Q.get('cam');   // 调试取景：cam=x,y,z[,lx,ly,lz[,fov]]
const DBG = Q.get('dbg');       // 调试取景：earth | sun | station
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const $ = (id) => document.getElementById(id);

// ?log=1：把 console.error / 未捕获异常直接画在页面上，方便无头截图定位（尤其是 GLSL 编译错误）
if (Q.get('log') === '1') {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:46vh;overflow:hidden;z-index:99999;' +
    'font:11px/1.45 Consolas,Menlo,monospace;color:#ff9a9a;background:rgba(0,0,0,.86);padding:8px 10px;' +
    'white-space:pre-wrap;border:1px solid #ff5c5c;border-radius:3px';
  const lines = [];
  const push = (t) => { lines.push(t); if (lines.length > 26) lines.shift(); box.textContent = lines.join('\n'); };
  const orig = console.error.bind(console);
  console.error = (...a) => { push(a.map((x) => String(x)).join(' ').slice(0, 1200)); orig(...a); };
  addEventListener('error', (e) => push('onerror: ' + String(e.message).slice(0, 600)));
  addEventListener('unhandledrejection', (e) => push('rejection: ' + String(e.reason).slice(0, 400)));
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(box));
  if (document.body) document.body.appendChild(box);
}

/* ────────────────────────── 渲染器 / 场景 ────────────────────────── */
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
  stencil: false,
});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.06, 20000);
camera.position.set(4, 2.4, 6);

// 主光源：太阳方向（世界 origin 是太阳）
const sunLight = new THREE.DirectionalLight(0xfff0dc, 3.6);
sunLight.position.set(-1, 0.2, 0);
scene.add(sunLight);
scene.add(sunLight.target);
const rimLight = new THREE.DirectionalLight(0x4a7dff, 0.55);
rimLight.position.set(1, -0.4, -0.6);
scene.add(rimLight);
const ambient = new THREE.AmbientLight(0x0d1a2a, 0.55);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0x14314d, 0x02040a, 0.35);
scene.add(hemi);

/* ────────────────────────── 场景内容 ────────────────────────── */
const world = createWorld(scene, { quality: 'high', renderer });
const station = createStation(scene, { quality: 'high' });
scene.add(station.group);
const ship = createShip(scene, camera, { quality: 'high' });

const postfx = createPostFX(renderer, scene, camera, { strength: 0.44, threshold: 0.85, radius: 0.68 });
const audio = createAudio();

// 扩展模块：任务线 / 站内漫游 / 行星展厅
const missions = createMissions({ world, ship, onEvent: onMissionEvent });
const interior = createInterior({ renderer, quality: 'high' });
const planetarium = createPlanetarium({ renderer, quality: 'high' });

/* ────────────────────────── 状态 ─────────────────────────── */
const STATE = {
  mode: 'title',            // title | orbit | flight | interior | planet
  t: 0,
  fps: 60,
  hovered: null,            // 被悬停的 station module
  selected: null,           // 被选中的 station module
  mouse: { x: innerWidth / 2, y: innerHeight / 2, ndc: new THREE.Vector2(0, 0) },
  dragging: false,
  orbit: { theta: 0.72, phi: 1.28, dist: 4.8, tTheta: 0.72, tPhi: 1.28, tDist: 4.8 },
  camTween: null,           // { fromPos, fromQuat, toPos, toQuat, t, dur }
  introT: 99,               // 入场推镜计时（<6 时用慢速阻尼）
  targetIdx: 2,             // 默认锁地球
  warpFx: 0,
  lastWarpToast: 0,
  pointerLocked: false,
  autoRotate: 1,
  // 扩展模块状态
  interiorInput: { forward: 0, back: 0, left: 0, right: 0, run: false, lookX: 0, lookY: 0 },
  interiorHotspot: null,
  planetInput: { dragX: 0, dragY: 0, zoom: 0, auto: 0 },
  planetId: 'saturn',
  planetDrag: false,
  missionMini: false,
  lastNavUpdate: 0,
};
const keys = Object.create(null);
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.2;

/* ────────────────────────── HUD ────────────────────────── */
const HUD = {
  hud: $('hud'),
  modeText: $('mode-text'),
  telMode: $('tel-mode'),
  fps: $('fps'),
  list: $('module-list'),
  inspect: $('inspect'),
  inId: $('in-id'), inNm: $('in-nm'), inDesc: $('in-desc'), inStat: $('in-stat'),
  hints: $('hints'),
  toasts: $('toasts'),
  reticle: $('reticle'),
  flightPanel: $('flight-panel'),
  fSpeed: $('f-speed'), fSpeedBar: $('f-speedbar'),
  fWarp: $('f-warp'), fWarpBar: $('f-warpbar'),
  fThrottle: $('f-throttle'), fThrottleBar: $('f-throttlebar'),
  tlName: $('tl-name'), tlDist: $('tl-dist'), targetLock: $('target-lock'),
  stationPanel: $('station-panel'),
  btnExplode: $('btn-explode'), btnSingle: $('btn-single'), btnLaunch: $('btn-launch'),
  letterboxTop: document.querySelector('#letterbox .top'),
  letterboxBottom: document.querySelector('#letterbox .bottom'),
  flash: $('warp-flash'),
  fade: $('fade'),
  title: $('title'),
  radar: $('radar'),
  // 扩展：任务线 / 内景 / 行星展厅
  missionPanel: $('mission-panel'),
  mDots: $('m-dots'), mTitle: $('m-title'), mDesc: $('m-desc'), mStep: $('m-step'), mDist: $('m-dist'),
  navArrow: $('nav-arrow'),
  cross: $('cross'),
  ipanel: $('interior-card'), iId: $('i-id'), iNm: $('i-nm'), iDesc: $('i-desc'), iKey: $('i-key'),
  planetPanel: $('planet-panel'), pName: $('p-name'), pEn: $('p-en'), pDesc: $('p-desc'),
  pStats: $('p-stats'), pTabs: $('planet-tabs'),
  planetName: $('planet-name'), pnCn: $('pn-cn'), pnEn: $('pn-en'),
};
const radarCtx = HUD.radar.getContext('2d');

const HINTS = {
  title: '',
  orbit: '<kbd>拖动</kbd> 环绕　<kbd>滚轮</kbd> 缩放　<kbd>单击</kbd> 检视　<kbd>X</kbd> 拆解　<kbd>I</kbd> 进舱　<kbd>P</kbd> 星球档案　<kbd>F</kbd> 起飞　<kbd>M</kbd> 静音',
  flight: '<kbd>W</kbd><kbd>S</kbd> 推力　<kbd>鼠标</kbd> 转向　<kbd>A</kbd><kbd>D</kbd> 滚转　<kbd>SHIFT</kbd> 加速　<kbd>TAB</kbd> 目标　<kbd>SPACE</kbd> 跃迁　<kbd>P</kbd> 星球档案　<kbd>F</kbd> 视角　<kbd>ESC</kbd> 返回',
  interior: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 行走　<kbd>鼠标</kbd> 环视　<kbd>SHIFT</kbd> 快走　<kbd>E</kbd> 交互　<kbd>J</kbd> 任务　<kbd>ESC</kbd> 离舱',
  planet: '<kbd>拖动</kbd> 环绕　<kbd>滚轮</kbd> 远近　<kbd>←</kbd><kbd>→</kbd> 切换星球　<kbd>J</kbd> 任务　<kbd>ESC</kbd> 退出展厅',
};

function toast(text, cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  HUD.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .6s ease, transform .6s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
  }, 2200);
  setTimeout(() => el.remove(), 3000);
  while (HUD.toasts.children.length > 3) HUD.toasts.firstChild.remove();
}

function buildModuleList() {
  HUD.list.innerHTML = '';
  station.modules.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mod';
    row.dataset.id = m.id;
    row.innerHTML = `<span class="id">${String(i + 1).padStart(2, '0')}</span>
      <span class="nm">${m.cn}</span><span class="st">${m.stat || 'NOMINAL'}</span>`;
    row.addEventListener('mouseenter', () => station.setHover(m));
    row.addEventListener('mouseleave', () => station.setHover(null));
    row.addEventListener('click', () => selectModule(m));
    HUD.list.appendChild(row);
  });
}

function refreshModuleRow(module, state) {
  const row = HUD.list.querySelector(`.mod[data-id="${module.id}"]`);
  if (!row) return;
  if (state === 'detached') {
    row.classList.add('gone');
    row.querySelector('.st').textContent = 'DETACHED';
  } else if (state === 'attached') {
    row.classList.remove('gone');
    row.querySelector('.st').textContent = module.stat || 'NOMINAL';
  }
}

function selectModule(m) {
  STATE.selected = m;
  station.setSelected(m);
  HUD.list.querySelectorAll('.mod').forEach((r) => r.classList.toggle('on', !!m && r.dataset.id === m.id));
  if (m) {
    HUD.btnSingle.textContent = station.isDetached(m.id) ? '装回选中模块 · REATTACH' : '拆解选中模块 · DETACH';
    toast(`已锁定舱段 · ${m.en || m.cn}`, 'amber');
    audio.blip(920);
  }
  updateInspect(m);
}

function updateInspect(m) {
  if (!m) {
    HUD.inspect.style.opacity = '0';
    return;
  }
  HUD.inId.textContent = m.id.toUpperCase();
  HUD.inNm.textContent = m.cn;
  HUD.inDesc.textContent = m.desc || '';
  HUD.inStat.textContent = m.stat || '';
}

function setHints(mode) {
  HUD.hints.innerHTML = HINTS[mode] || '';
}

function setModeHUD(mode) {
  const MODE_TXT = {
    title: '序章 · 抵达轨道',
    orbit: '空间站环绕视角',
    flight: '第三人称 · 星际巡航',
    interior: '站内漫游 · 第一人称',
    planet: '行星档案 · 特写展厅',
  };
  const MODE_EN = { title: 'CINEMA', orbit: 'ORBIT', flight: 'FLIGHT', interior: 'INTERIOR', planet: 'ARCHIVE' };
  HUD.modeText.textContent = MODE_TXT[mode] || MODE_TXT.orbit;
  HUD.telMode.textContent = MODE_EN[mode] || 'ORBIT';

  const orbitish = mode === 'orbit' || mode === 'title';
  HUD.stationPanel.style.transform = orbitish ? 'none' : 'translateX(120%)';
  HUD.stationPanel.style.opacity = orbitish ? '1' : '0';
  HUD.flightPanel.style.opacity = mode === 'flight' ? '1' : '0';
  HUD.reticle.style.opacity = mode === 'flight' ? '1' : '0';
  HUD.targetLock.style.opacity = mode === 'flight' ? '1' : '0';
  if (HUD.radar && HUD.radar.parentElement) {
    HUD.radar.parentElement.style.opacity = mode === 'interior' || mode === 'planet' ? '0' : '1';
    HUD.radar.parentElement.style.transition = 'opacity .5s ease';
  }
  HUD.planetPanel.classList.toggle('on', mode === 'planet');
  HUD.planetName.classList.toggle('on', mode === 'planet');
  HUD.cross.classList.toggle('on', mode === 'interior');
  if (mode !== 'interior') HUD.ipanel.classList.remove('on');
  HUD.navArrow.classList.toggle('on', false);

  const barH = mode === 'flight' || mode === 'planet' ? '5.2vh' : mode === 'title' ? '7vh' : '2.4vh';
  HUD.letterboxTop.style.height = barH;
  HUD.letterboxBottom.style.height = barH;
  HUD.hud.style.opacity = mode === 'title' ? '0' : '1';
  HUD.missionPanel.classList.toggle('on', mode !== 'title' && mode !== 'interior' && mode !== 'planet');
  setHints(mode);
}

/* ────────────────────────── 相机 ────────────────────────── */
const camTarget = V3();
const tmpV = V3();
const tmpQ = new THREE.Quaternion();

function stationCenter(out) {
  station.group.updateMatrixWorld();
  out.copy(station.focusPoint).applyMatrix4(station.group.matrixWorld);
  return out;
}

function orbitCameraPose(outPos, outQuat, theta = STATE.orbit.theta, phi = STATE.orbit.phi, dist = STATE.orbit.dist) {
  const c = stationCenter(camTarget);
  const r = dist;
  const st = theta, sp = clamp(phi, 0.22, Math.PI - 0.22);
  outPos.set(
    c.x + r * Math.sin(sp) * Math.sin(st),
    c.y + r * Math.cos(sp),
    c.z + r * Math.sin(sp) * Math.cos(st)
  );
  // 防止相机钻进地球（站体就在地球上方约 2.4 单位）
  const er = world.earth.radius * 1.16;
  const d = outPos.distanceTo(world.earth.center);
  if (d < er) {
    outPos.sub(world.earth.center).normalize().multiplyScalar(er).add(world.earth.center);
  }
  const m = new THREE.Matrix4().lookAt(outPos, c, new THREE.Vector3(0, 1, 0));
  outQuat.setFromRotationMatrix(m);
  // 构图偏移：把站体推到画面左侧三分线，右侧留给 HUD 面板
  outQuat.multiply(FRAME_TILT);
}

const FRAME_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.015, -0.10, 0, 'YXZ'));

// 以"太阳所在方位"为基准的 3/4 侧光机位：sunSw 越大越接近逆光，越小越正打光
function sunSideOrbitAngles(sunSw = 0.85, elev = 0.40, out = { theta: 0.72, phi: 1.28 }) {
  const c = stationCenter(V3());
  const toSun = V3().copy(world.sunPosition).sub(c).normalize();
  const d = toSun.applyAxisAngle(V3(0, 1, 0), sunSw);
  d.y = elev;
  d.normalize();
  out.phi = Math.acos(clamp(d.y, -1, 1));
  out.theta = Math.atan2(d.x, d.z);
  return out;
}

const wrapDelta = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// 把机位对准受光面，避免空间站逆光剪影
function aimAtSunSide(sunSw = 0.85, elev = 0.40) {
  const ang = sunSideOrbitAngles(sunSw, elev);
  const o = STATE.orbit;
  o.tTheta = o.theta + wrapDelta(o.theta, ang.theta);
  o.tPhi = ang.phi;
  STATE.titlePhiBase = ang.phi;
}

/* ────────────────────────── 模式切换 ────────────────────────── */
// 黑场过渡：先压黑、在中点切换场景状态、再缓慢亮起（电影感硬切）
let transitioning = false;
function transitionTo(fn) {
  if (transitioning) return;
  if (SHOT) { fn(); return; }
  transitioning = true;
  HUD.fade.style.transition = 'opacity .5s ease';
  HUD.fade.style.opacity = '1';
  setTimeout(() => {
    try { fn(); } catch (err) { console.error(err); }
    HUD.fade.style.transition = 'opacity 1.4s ease';
    HUD.fade.style.opacity = '0';
    setTimeout(() => { transitioning = false; }, 1500);
  }, 520);
}

function enterOrbit(instant = false, intro = false) {
  STATE.mode = 'orbit';
  ship.setActive(false);
  setModeHUD('orbit');
  HUD.title.classList.add('hidden');
  document.body.style.cursor = 'default';
  if (document.pointerLockElement) document.exitPointerLock();
  const pos = V3(), q = new THREE.Quaternion();
  aimAtSunSide(0.85, 0.40);
  if (intro && !SHOT) {
    // 建立镜头：从远景缓慢推近空间站
    const o = STATE.orbit;
    o.theta = o.tTheta; o.phi = o.tPhi;
    o.dist = 26; o.tDist = 4.8;
    STATE.introT = 0;
    orbitCameraPose(pos, q, o.theta, o.phi, o.dist);
    camera.position.copy(pos);
    camera.quaternion.copy(q);
  } else orbitCameraPose(pos, q);
  if (instant || SHOT) {
    camera.position.copy(pos);
    camera.quaternion.copy(q);
  } else if (!intro) {
    STATE.camTween = { fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone(), toPos: pos, toQuat: q, t: 0, dur: 1.4, orbitFollow: true };
  }
  toast('空间站已建立链路 · STATION LINK ESTABLISHED');
}

function enterFlight(instant = false) {
  STATE.mode = 'flight';
  audio.unlock();
  const anchor = world.stationAnchor;
  // 出生点：站体侧后方，机头沿地球切向，地球压在下半屏——电影感开场
  const start = anchor.clone().add(V3(1.9, 0.6, 1.9));
  const up = start.clone().sub(world.earth.center).normalize();     // 背离地心
  const fwd = V3(0, 1, 0).cross(up).normalize();                    // 轨道切向
  const mtx = new THREE.Matrix4().lookAt(start, start.clone().add(fwd), up);
  const quat = new THREE.Quaternion().setFromRotationMatrix(mtx);
  const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
  ship.placeAt(start, euler);
  // 相机先落到追尾位置，避免 1.2s 过渡里从别处飞过画面
  const back = V3(0, 0.52, 2.0).applyQuaternion(quat);
  camera.position.copy(start).add(back);
  camera.lookAt(start.clone().add(fwd.clone().multiplyScalar(4)));
  ship.setActive(true);
  setModeHUD('flight');
  // 清掉站体检视卡与描边，进入飞行后不该再挂着舱段信息
  STATE.hovered = null;
  STATE.selected = null;
  try { station.setHover(null); station.setSelected(null); } catch {}
  HUD.inspect.style.opacity = '0';
  HUD.title.classList.add('hidden');
  if (!instant && !SHOT) toast('引擎点火 · 深空方舟已解锁', 'amber');
  if (!STATE.missionStarted) {
    STATE.missionStarted = true;
    try { missions.start(); } catch (err) { console.error(err); }
  }
  if (document.pointerLockElement === null && !SHOT) {
    try {
      const req = renderer.domElement.requestPointerLock?.();
      if (req && req.catch) req.catch(() => {});
    } catch {}
  }
}

function exitFlight() {
  if (STATE.mode !== 'flight') return;
  transitionTo(() => {
    enterOrbit(true);
    toast('已脱离飞行姿态 · 返回轨道视角');
  });
}

/* ────────────────────────── 任务线 ────────────────────────── */
const NAV_V = new THREE.Vector3();
const CAM_INV_Q = new THREE.Quaternion();

function onMissionEvent(evt) {
  if (!evt || !evt.mission) {
    if (evt && evt.type === 'all') toast('太阳系航线全部签收 · LOG COMPLETE', 'amber');
    return;
  }
  if (evt.type === 'start') toast(`新任务 · ${evt.mission.cn}`, 'amber');
  else if (evt.type === 'complete') {
    audio.blip(760);
    toast(`任务完成 · ${evt.mission.cn}`);
  } else if (evt.type === 'all') {
    audio.blip(1040);
    toast('太阳系航线全部签收 · LOG COMPLETE', 'amber');
  }
}

function missionTargetWorld(out) {
  const c = missions.current();
  if (!c) return null;
  const t = c.mission.target || {};
  if (t.kind === 'station') return out.copy(world.stationAnchor);
  if (t.kind === 'body') {
    const b = world.bodyById ? world.bodyById(t.id) : null;
    if (b && b.group) return b.group.getWorldPosition(out);
    if (b && b.pos) return out.copy(b.pos);
  }
  if (t.pos) return out.copy(t.pos);
  return null;
}

function updateMissionHUD() {
  const list = missions.list || [];
  if (!list.length) return;
  if (HUD.mDots.children.length !== list.length) {
    HUD.mDots.innerHTML = '';
    list.forEach(() => HUD.mDots.appendChild(document.createElement('i')));
  }
  const arr = [...HUD.mDots.children];
  arr.forEach((d, i) => {
    d.className = i < missions.index ? 'done' : i === missions.index ? 'now' : '';
  });
  const c = missions.current();
  if (!c) {
    HUD.mTitle.textContent = '航线已完成';
    HUD.mDesc.textContent = '全部节点已签收。空间站记录器已归档本次航行日志 —— 随时可以再次出航。';
    HUD.mStep.textContent = 'COMPLETE';
    HUD.mDist.textContent = '—';
    return;
  }
  HUD.mTitle.textContent = c.mission.cn + (c.mission.en ? ` · ${c.mission.en}` : '');
  HUD.mDesc.textContent = c.mission.desc || c.mission.hint || '';
  HUD.mStep.textContent = `STEP ${missions.index + 1} / ${list.length}`;
  const d = c.distance || 0;
  HUD.mDist.textContent = (d < 1000 ? d.toFixed(1) : d.toFixed(0)) + ' u';
}

function updateNavArrow() {
  const show = STATE.mode === 'flight';
  if (!show) { HUD.navArrow.classList.remove('on'); return; }
  const p = missionTargetWorld(NAV_V);
  if (!p) { HUD.navArrow.classList.remove('on'); return; }
  CAM_INV_Q.copy(camera.quaternion).invert();
  const local = p.clone().sub(camera.position).applyQuaternion(CAM_INV_Q).normalize();
  const ndc = p.clone().project(camera);
  const onScreen = local.z < 0 && Math.abs(ndc.x) < 0.84 && Math.abs(ndc.y) < 0.78;
  if (onScreen) { HUD.navArrow.classList.remove('on'); return; }
  const ang = local.z < 0 ? Math.atan2(local.y, local.x) : Math.atan2(-local.y, -local.x);
  const r = Math.min(innerWidth, innerHeight) * 0.33;
  const x = innerWidth / 2 + Math.cos(ang) * r;
  const y = innerHeight / 2 - Math.sin(ang) * r;
  HUD.navArrow.style.left = x.toFixed(0) + 'px';
  HUD.navArrow.style.top = y.toFixed(0) + 'px';
  HUD.navArrow.style.transform = `rotate(${(90 - ang * 180 / Math.PI).toFixed(1)}deg)`;
  HUD.navArrow.classList.add('on');
}

/* ────────────────────────── 空间站内部漫游 ────────────────────────── */
function enterInterior() {
  if (STATE.mode !== 'orbit' && STATE.mode !== 'flight') return;
  transitionTo(() => {
    if (STATE.mode === 'flight') ship.setActive(false);
    HUD.inspect.style.opacity = '0';
    STATE.hovered = null; STATE.selected = null;
    try { station.setHover(null); station.setSelected(null); } catch {}
    interior.enter(STATE.t);
    STATE.mode = 'interior';
    setModeHUD('interior');
    postfx.use(interior.scene, interior.camera);
    HUD.ipanel.classList.remove('on');
    if (!SHOT) {
      try {
        const req = renderer.domElement.requestPointerLock?.();
        if (req && req.catch) req.catch(() => {});
      } catch {}
    }
    toast('已进入站内 · 气闸舱 A2 · 步行');
  });
}

function exitInterior() {
  if (STATE.mode !== 'interior') return;
  if (document.pointerLockElement) document.exitPointerLock();
  transitionTo(() => {
    interior.exit();
    STATE.mode = 'orbit';
    HUD.ipanel.classList.remove('on');
    postfx.use(scene, camera);
    enterOrbit(true);
    toast('已离开站体 · 回到环绕视角');
  });
}

function interactInterior() {
  const h = interior.interact();
  if (!h) { HUD.ipanel.classList.remove('on'); return; }
  if (h.id === 'exit') { exitInterior(); return; }
  HUD.iId.textContent = String(h.id || 'hotspot').toUpperCase();
  HUD.iNm.textContent = h.cn || '舱内设施';
  HUD.iDesc.textContent = h.desc || '';
  HUD.iKey.textContent = 'E 交互 · ESC 离舱';
  HUD.ipanel.classList.add('on');
  audio.blip(880);
}

/* ────────────────────────── 行星特写展厅 ────────────────────────── */
function setPlanet(id) {
  const bodies = planetarium.bodies || [];
  if (!bodies.length) return;
  const body = bodies.find((b) => b.id === id) || bodies[0];
  STATE.planetId = body.id;
  planetarium.open(body.id, STATE.t);
  HUD.pName.textContent = body.cn;
  HUD.pEn.textContent = body.en;
  HUD.pDesc.textContent = body.desc || '';
  HUD.pStats.innerHTML = (body.stats || [])
    .map((s) => `<div class="row"><span>${s.k}</span><b>${s.v}</b></div>`).join('');
  HUD.pnCn.textContent = body.cn;
  HUD.pnEn.textContent = body.en;
  HUD.pTabs.innerHTML = '';
  bodies.forEach((b) => {
    const btn = document.createElement('button');
    btn.textContent = b.cn;
    btn.className = b.id === body.id ? 'on' : '';
    btn.addEventListener('click', () => { setPlanet(b.id); audio.blip(700); });
    HUD.pTabs.appendChild(btn);
  });
}

function enterPlanet(id) {
  if (STATE.mode === 'planet' || STATE.mode === 'title') return;
  transitionTo(() => {
    if (STATE.mode === 'flight') ship.setActive(false);
    HUD.inspect.style.opacity = '0';
    setPlanet(id || STATE.planetId);
    STATE.mode = 'planet';
    setModeHUD('planet');
    postfx.use(planetarium.scene, planetarium.camera);
    toast(`行星档案 · ${HUD.pName.textContent}`, 'amber');
  });
}

function exitPlanet() {
  if (STATE.mode !== 'planet') return;
  transitionTo(() => {
    planetarium.close();
    STATE.mode = 'orbit';
    postfx.use(scene, camera);
    enterOrbit(true);
    toast('已离开行星档案 · 返回轨道视角');
  });
}

function collectInteriorInput() {
  const i = STATE.interiorInput;
  i.forward = keys['KeyW'] ? 1 : 0;
  i.back = keys['KeyS'] ? 1 : 0;
  i.left = keys['KeyA'] ? 1 : 0;
  i.right = keys['KeyD'] ? 1 : 0;
  i.run = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  return i;
}

/* ────────────────────────── 交互 ────────────────────────── */
const dom = renderer.domElement;

dom.addEventListener('pointerdown', (e) => {
  if (STATE.mode === 'orbit') {
    STATE.dragging = true;
    STATE.autoRotate = 0;
    dom.setPointerCapture?.(e.pointerId);
  } else if (STATE.mode === 'flight' && !document.pointerLockElement && !SHOT) {
    dom.requestPointerLock?.();
  } else if (STATE.mode === 'interior' && !document.pointerLockElement && !SHOT) {
    try {
      const req = dom.requestPointerLock?.();
      if (req && req.catch) req.catch(() => {});
    } catch {}
  } else if (STATE.mode === 'planet') {
    STATE.planetDrag = true;
    dom.setPointerCapture?.(e.pointerId);
  }
});

dom.addEventListener('pointerup', (e) => {
  STATE.dragging = false;
  STATE.planetDrag = false;
  dom.releasePointerCapture?.(e.pointerId);
  handleClick(e);
});

dom.addEventListener('pointermove', (e) => {
  STATE.mouse.x = e.clientX;
  STATE.mouse.y = e.clientY;
  STATE.mouse.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (STATE.dragging && STATE.mode === 'orbit') {
    STATE.orbit.tTheta -= e.movementX * 0.006;
    STATE.orbit.tPhi = clamp(STATE.orbit.tPhi - e.movementY * 0.005, 0.25, Math.PI - 0.25);
  }
  if (STATE.planetDrag && STATE.mode === 'planet') {
    STATE.planetInput.dragX += e.movementX;
    STATE.planetInput.dragY += e.movementY;
    STATE.planetInput.auto = 0;
  }
});

dom.addEventListener('wheel', (e) => {
  if (STATE.mode === 'planet') {
    STATE.planetInput.zoom += Math.sign(e.deltaY) * 0.12;
    STATE.planetInput.auto = 0;
    return;
  }
  if (STATE.mode !== 'orbit') return;
  STATE.orbit.tDist = clamp(STATE.orbit.tDist * (1 + Math.sign(e.deltaY) * 0.09), 2.0, 20);
}, { passive: true });

function pickStationModule(clientX, clientY) {
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return station.raycast(raycaster);
}

function handleClick(e) {
  if (STATE.mode !== 'orbit') return;
  const m = pickStationModule(e.clientX, e.clientY);
  selectModule(m);
  if (m) HUD.inspect.style.opacity = '1';
}

document.addEventListener('pointerlockchange', () => {
  STATE.pointerLocked = document.pointerLockElement === dom;
});

document.addEventListener('mousemove', (e) => {
  if (STATE.mode === 'flight' && STATE.pointerLocked) {
    STATE.mouse.ndc.set(
      clamp(STATE.mouse.ndc.x + e.movementX * 0.0022, -1, 1),
      clamp(STATE.mouse.ndc.y - e.movementY * 0.0022, -1, 1)
    );
  }
  if (STATE.mode === 'interior' && STATE.pointerLocked) {
    STATE.interiorInput.lookX += e.movementX * 0.0024;
    STATE.interiorInput.lookY += e.movementY * 0.0024;
  }
});

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') {
    e.preventDefault();
    tryWarp();
  }
  if (e.code === 'KeyX' && STATE.mode === 'orbit') toggleExplode();
  if (e.code === 'Tab') {
    e.preventDefault();
    if (STATE.mode === 'flight') cycleTarget();
  }
  if (e.code === 'KeyF') {
    if (STATE.mode === 'orbit') transitionTo(() => enterFlight());
    else if (STATE.mode === 'flight') {
      ship.toggleCamera();
      toast(ship.cameraMode === 'cockpit' ? '第一人称座舱视角' : '第三人称追尾视角');
    }
  }
  if (e.code === 'Escape') {
    if (STATE.mode === 'flight') exitFlight();
    else if (STATE.mode === 'interior') exitInterior();
    else if (STATE.mode === 'planet') exitPlanet();
  }
  if (e.code === 'KeyE') {
    if (STATE.mode === 'orbit') {
      // 快捷拆解选中模块
      if (STATE.selected) toggleModule(STATE.selected);
      else toast('先在列表或画面里点选一个舱段', 'amber');
    } else if (STATE.mode === 'interior') {
      interactInterior();
    }
  }
  // 站内漫游：进舱 / 离舱
  if (e.code === 'KeyI') {
    if (STATE.mode === 'interior') exitInterior();
    else if (STATE.mode === 'orbit' || STATE.mode === 'flight') enterInterior();
  }
  // 行星档案：进入 / 退出 / 切换
  if (e.code === 'KeyP') {
    if (STATE.mode === 'planet') exitPlanet();
    else if (STATE.mode === 'orbit' || STATE.mode === 'flight') enterPlanet();
  }
  if (STATE.mode === 'planet') {
    if (e.code === 'ArrowLeft') { e.preventDefault(); planetarium.prev(); setPlanet(planetarium.current.id); }
    if (e.code === 'ArrowRight') { e.preventDefault(); planetarium.next(); setPlanet(planetarium.current.id); }
  }
  // 任务面板折叠
  if (e.code === 'KeyJ') {
    STATE.missionMini = !STATE.missionMini;
    HUD.missionPanel.classList.toggle('mini', STATE.missionMini);
  }
  if (e.code === 'Enter' && STATE.mode === 'title') start();
  if (e.code === 'KeyM') {
    audio.unlock();
    toast(audio.toggle() ? '音频已静音 · MUTED' : '音频已恢复 · AUDIO ON');
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

function toggleExplode() {
  station.toggleExplode();
  const exploded = station.explodeAmount > 0.5;
  // 拆解后站体跨度约 5.5 单位，镜头自动退到能装下全站的位置
  STATE.orbit.tDist = exploded ? 8.4 : 4.8;
  HUD.btnExplode.textContent = exploded ? '重组空间站 · REASSEMBLE' : '拆解空间站 · DISASSEMBLE';
  station.modules.forEach((m) => refreshModuleRow(m, station.isDetached(m.id) ? 'detached' : 'attached'));
  if (HUD.btnSingle) HUD.btnSingle.textContent = STATE.selected && station.isDetached(STATE.selected.id) ? '装回选中模块 · REATTACH' : '拆解选中模块 · DETACH';
  toast(exploded ? '结构解锁 · 22 个舱段进入自由漂浮' : '舱段归位 · 结构重新锁定', 'amber');
}

function toggleModule(m) {
  const detached = station.isDetached(m.id);
  if (detached) station.attach(m.id); else station.detach(m.id);
  refreshModuleRow(m, detached ? 'attached' : 'detached');
  HUD.btnSingle.textContent = detached ? '拆解选中模块 · DETACH' : '装回选中模块 · REATTACH';
  toast(`${detached ? '已装回' : '已拆下'} · ${m.cn}`);
}

HUD.btnExplode.addEventListener('click', toggleExplode);
HUD.btnSingle.addEventListener('click', () => {
  if (STATE.selected) toggleModule(STATE.selected);
  else toast('先在场景或列表中选择一个舱段', 'amber');
});
HUD.btnLaunch.addEventListener('click', () => transitionTo(() => enterFlight()));

$('enter').addEventListener('click', start);
function start() {
  if (STATE.mode !== 'title') return;
  audio.unlock();
  transitionTo(() => enterOrbit(false, true));
}

/* ────────────────────────── 目标 / 跃迁 ────────────────────────── */
function targetBody() {
  return world.bodies[STATE.targetIdx % world.bodies.length];
}

function bodyWorldPos(body, out = V3()) {
  return out.setFromMatrixPosition(body.group.matrixWorld);
}

function cycleTarget() {
  STATE.targetIdx = (STATE.targetIdx + 1) % world.bodies.length;
  const b = targetBody();
  toast(`目标锁定 · ${b.cn} / ${b.en}`, 'amber');
}

function tryWarp() {
  if (STATE.mode !== 'flight') return;
  if (ship.state.warping) return;
  if (ship.state.warpCharge < 0.34) {
    toast('跃迁引擎充能不足', 'amber');
    return;
  }
  const b = targetBody();
  const bp = bodyWorldPos(b);
  const dir = ship.position.clone().sub(bp).normalize();
  const arrive = bp.clone().add(dir.multiplyScalar(b.radius * 5 + 3));
  ship.warpTo(arrive);
  audio.warp();
  HUD.flash.classList.remove('on');
  void HUD.flash.offsetWidth;
  HUD.flash.classList.add('on');
  toast(`跃迁引擎点火 · 目标 ${b.cn}`, 'amber');
}

/* ────────────────────────── 雷达 ────────────────────────── */
const RADAR_RANGE = 620;
function drawRadar() {
  const w = HUD.radar.width, h = HUD.radar.height;
  const cx = w / 2, cy = h / 2, R = w / 2 - 6;
  radarCtx.clearRect(0, 0, w, h);

  // 网格
  radarCtx.strokeStyle = 'rgba(126,243,255,.16)';
  radarCtx.lineWidth = 1.4;
  for (const rr of [0.34, 0.67, 1]) {
    radarCtx.beginPath();
    radarCtx.arc(cx, cy, R * rr, 0, Math.PI * 2);
    radarCtx.stroke();
  }
  radarCtx.beginPath();
  radarCtx.moveTo(cx - R, cy); radarCtx.lineTo(cx + R, cy);
  radarCtx.moveTo(cx, cy - R); radarCtx.lineTo(cx, cy + R);
  radarCtx.strokeStyle = 'rgba(126,243,255,.1)';
  radarCtx.stroke();

  const origin = STATE.mode === 'flight' ? ship.position : stationCenter(V3());
  // 以飞船与空间站朝向为基准
  let heading = 0;
  if (STATE.mode === 'flight') {
    const fwd = V3(0, 0, -1).applyQuaternion(ship.group.quaternion);
    heading = Math.atan2(fwd.x, -fwd.z);
  } else {
    const fwd = V3(0, 0, -1).applyQuaternion(camera.quaternion);
    heading = Math.atan2(fwd.x, -fwd.z);
  }
  const cos = Math.cos(-heading), sin = Math.sin(-heading);

  radarCtx.font = '15px Consolas, monospace';
  const placed = [];
  const drawBlip = (pos, color, label, size = 6, ring = false) => {
    const dx = pos.x - origin.x, dz = pos.z - origin.z;
    const ax = (dx * cos - dz * sin), az = (dx * sin + dz * cos);
    const len = Math.hypot(ax, az);
    // 开方压缩：把内行星拉开，外行星仍贴边，保持方位角真实
    const nr = Math.min(len / RADAR_RANGE, 1);
    const sr = Math.sqrt(nr);
    const x = cx + (len > 1e-6 ? ax / len : 0) * sr * R;
    const y = cy + (len > 1e-6 ? az / len : 0) * sr * R;
    if (ring) {
      radarCtx.strokeStyle = color.replace('1)', '.35)');
      radarCtx.lineWidth = 1.2;
      radarCtx.beginPath(); radarCtx.arc(x, y, size + 5, 0, Math.PI * 2); radarCtx.stroke();
    }
    radarCtx.fillStyle = color;
    radarCtx.beginPath();
    radarCtx.arc(x, y, size, 0, Math.PI * 2);
    radarCtx.fill();
    if (label && size > 5) {
      const near = placed.some((p) => Math.hypot(p.x - x, p.y - y) < 26);
      if (!near) {
        placed.push({ x, y });
        radarCtx.fillStyle = color.replace('1)', '.6)');
        radarCtx.fillText(label, x + 10, y + 5);
      }
    }
  };

  const tgt = targetBody();
  drawBlip(world.sunPosition || V3(0, 0, 0), 'rgba(255,214,140,1)', '日', 6);
  for (const b of world.bodies) {
    drawBlip(bodyWorldPos(b), b.color || 'rgba(126,243,255,1)', b.cn, b.id === tgt.id ? 8 : 5, b.id === tgt.id);
  }
  drawBlip(stationCenter(V3()), 'rgba(255,180,92,1)', '站', 6);
  if (STATE.mode === 'flight') drawBlip(ship.position, 'rgba(255,255,255,.95)', '', 4);
}

/* ────────────────────────── 输入采集 ────────────────────────── */
function collectFlightInput() {
  const throttle = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  return {
    throttle,
    pitch: STATE.mouse.ndc.y,
    yaw: STATE.mouse.ndc.x,
    roll: (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0),
    boost: !!(keys['ShiftLeft'] || keys['ShiftRight']),
  };
}

/* ────────────────────────── 主循环 ────────────────────────── */
const clock = new THREE.Clock();
let acc = 0, frames = 0;

function syncWorldLight() {
  // 太阳在 origin，光从太阳射向当前区域
  const dir = world.earth.center.clone().normalize();
  sunLight.position.copy(dir).multiplyScalar(-120);
  sunLight.target.position.copy(dir).multiplyScalar(20);
  sunLight.target.updateMatrixWorld();
}

function updateOrbitCamera(dt) {
  const o = STATE.orbit;
  if (!STATE.dragging) STATE.autoRotate = Math.min(1, STATE.autoRotate + dt * 0.25);
  o.tTheta += dt * 0.045 * STATE.autoRotate;
  o.theta = damp(o.theta, o.tTheta, 6, dt);
  o.phi = damp(o.phi, o.tPhi, 6, dt);
  // 入场时用极慢的推镜速度（约 5 秒从远景推到近景）
  if (STATE.introT < 6) STATE.introT += dt;
  const distRate = STATE.introT < 6 ? 0.62 : 5;
  o.dist = damp(o.dist, o.tDist, distRate, dt);

  const pos = V3(), q = new THREE.Quaternion();
  orbitCameraPose(pos, q, o.theta, o.phi, o.dist);

  if (STATE.camTween) {
    const tw = STATE.camTween;
    tw.t += dt;
    const k = easeInOut(clamp(tw.t / tw.dur, 0, 1));
    camera.position.lerpVectors(tw.fromPos, pos, k);
    camera.quaternion.slerpQuaternions(tw.fromQuat, q, k);
    if (k >= 1) STATE.camTween = null;
  } else {
    camera.position.copy(pos);
    camera.quaternion.copy(q);
  }
}

// 悬停检视
function updateHover() {
  if (STATE.mode !== 'orbit') {
    if (STATE.hovered) { station.setHover(null); STATE.hovered = null; HUD.inspect.style.opacity = '0'; }
    return;
  }
  const m = pickStationModule(STATE.mouse.x, STATE.mouse.y);
  if (m !== STATE.hovered) {
    STATE.hovered = m;
    station.setHover(m);
    if (!STATE.selected) updateInspect(m);
  }
  if (m && !STATE.selected) {
    HUD.inspect.style.opacity = '1';
    const pad = 18;
    const x = Math.min(STATE.mouse.x, innerWidth - 270);
    const y = Math.min(STATE.mouse.y, innerHeight - 150);
    HUD.inspect.style.left = x + 'px';
    HUD.inspect.style.top = y + 'px';
  } else if (!STATE.selected) {
    HUD.inspect.style.opacity = '0';
  }
}

function updateHUD(dt) {
  acc += dt; frames++;
  if (acc > 0.4) {
    STATE.fps = frames / acc;
    HUD.fps.textContent = STATE.fps.toFixed(0);
    acc = 0; frames = 0;
  }
  if (STATE.mode === 'flight') {
    const st = ship.state;
    const maxV = st.maxSpeed || 90;
    HUD.fSpeed.textContent = st.speed.toFixed(1) + ' u/s';
    HUD.fSpeedBar.style.width = clamp(st.speed / maxV, 0, 1) * 100 + '%';
    HUD.fWarp.textContent = Math.round(st.warpCharge * 100) + '%';
    HUD.fWarpBar.style.width = clamp(st.warpCharge, 0, 1) * 100 + '%';
    const th = clamp((state_throttle() + 1) / 2, 0, 1);
    HUD.fThrottle.textContent = Math.round(th * 100) + '%';
    HUD.fThrottleBar.style.width = th * 100 + '%';

    const b = targetBody();
    const dist = ship.position.distanceTo(bodyWorldPos(b));
    HUD.tlName.textContent = `${b.cn} · ${b.en}`;
    HUD.tlDist.textContent = `${dist.toFixed(dist < 1000 ? 1 : 0)} u  /  ${st.warping ? 'WARPING' : 'TARGET LOCKED'}`;
  }
}
function state_throttle() {
  return ship.state.throttle ?? 0;
}

function updateWarpFx(dt) {
  const target = ship.state.warping ? 1 : 0;
  STATE.warpFx = damp(STATE.warpFx, target, ship.state.warping ? 6 : 2.2, dt);
  postfx.setWarp(STATE.warpFx);
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  STATE.t += dt;

  world.update(dt, STATE.t);
  syncWorldLight();

  // 空间站跟随地球轨道点
  station.group.position.copy(world.stationAnchor);
  const inStationScene = STATE.mode !== 'interior' && STATE.mode !== 'planet';
  if (inStationScene) station.update(dt, STATE.t, camera);

  if (STATE.mode === 'title') {
    STATE.orbit.tTheta += dt * 0.05;
    STATE.orbit.tPhi = (STATE.titlePhiBase ?? 1.24) + Math.sin(STATE.t * 0.16) * 0.06;
    STATE.orbit.tDist = 5.4 + Math.sin(STATE.t * 0.21) * 0.5;
    updateOrbitCamera(dt);
  } else if (STATE.mode === 'orbit') {
    updateOrbitCamera(dt);
    updateHover();
  } else if (STATE.mode === 'flight') {
    if (!SHOT) ship.update(dt, STATE.t, collectFlightInput());
    else ship.update(dt, STATE.t, { throttle: 0.4, pitch: 0, yaw: 0, roll: 0, boost: false });
    audio.setEngine((ship.state.speed || 0) / (ship.state.maxSpeed || 90));
    missions.update(dt, ship.position);
    // 离开星球太远时提示
    if (STATE.t - STATE.lastWarpToast > 6 && ship.state.warpCharge > 0.99) {
      STATE.lastWarpToast = STATE.t;
    }
  } else if (STATE.mode === 'interior') {
    interior.update(dt, STATE.t, collectInteriorInput());
    STATE.interiorInput.lookX = 0;
    STATE.interiorInput.lookY = 0;
    postfx.use(interior.scene, interior.camera);
  } else if (STATE.mode === 'planet') {
    planetarium.update(dt, STATE.t, STATE.planetInput);
    STATE.planetInput.dragX = 0;
    STATE.planetInput.dragY = 0;
    STATE.planetInput.zoom = 0;
    postfx.use(planetarium.scene, planetarium.camera);
  }
  if (inStationScene) postfx.use(scene, camera);
  if (STATE.mode !== 'flight') audio.setEngine(0);

  updateWarpFx(dt);
  updateHUD(dt);
  if (STATE.mode === 'orbit' || STATE.mode === 'flight' || STATE.mode === 'title') drawRadar();
  if (STATE.t - STATE.lastNavUpdate > 0.1) {
    STATE.lastNavUpdate = STATE.t;
    updateMissionHUD();
  }
  updateNavArrow();

  if (CAM_DBG) {
    const v = CAM_DBG.split(',').map(Number);
    camera.position.set(v[0], v[1], v[2]);
    if (v.length >= 6) camera.lookAt(v[3], v[4], v[5]);
    if (v.length >= 7 && v[6] > 0) { camera.fov = v[6]; camera.updateProjectionMatrix(); }
  }
  if (DBG === 'earth') {
    // 站在太阳与地球之间，看完整昼面
    const dir = world.earth.center.clone().normalize();
    camera.position.copy(world.earth.center).add(dir.multiplyScalar(-9.5));
    camera.lookAt(world.earth.center);
    camera.fov = 45; camera.updateProjectionMatrix();
  } else if (DBG === 'earthnight') {
    const dir = world.earth.center.clone().normalize();
    camera.position.copy(world.earth.center).add(dir.multiplyScalar(9.5));
    camera.lookAt(world.earth.center);
    camera.fov = 45; camera.updateProjectionMatrix();
  } else if (DBG === 'sun') {
    camera.position.set(0, 0, 60);
    camera.lookAt(0, 0, 0);
    camera.fov = 60; camera.updateProjectionMatrix();
  } else if (DBG === 'station') {
    camera.position.copy(stationCenter(V3())).add(V3(2.4, 1.2, 3.2));
    camera.lookAt(stationCenter(V3()));
    camera.fov = 45; camera.updateProjectionMatrix();
  }

  postfx.render(dt);
  if (!window.__READY) {
    window.__READY = true;
    $('boot').classList.add('hidden');
    setTimeout(() => $('boot').classList.add('off'), 900);
  }
}

/* ────────────────────────── 尺寸 / 启动 ────────────────────────── */
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  postfx.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);

buildModuleList();
setModeHUD('title');
$('boot').classList.add('hidden');

// 初始机位就对准受光面（否则空间站是逆光剪影）
station.group.position.copy(world.stationAnchor);
aimAtSunSide(0.85, 0.40);
STATE.orbit.theta = STATE.orbit.tTheta;
STATE.orbit.phi = STATE.orbit.tPhi;

// 调试 / 截图用：?t=秒数 快进世界时间；?mode=orbit|flight；?explode=1
(function applyQueryState() {
  const t = parseFloat(Q.get('t') || '0');
  if (t > 0) {
    const steps = Math.min(600, Math.ceil(t / 0.1));
    for (let i = 0; i < steps; i++) {
      world.update(t / steps, (t / steps) * i);
      station.group.position.copy(world.stationAnchor);
      station.update(t / steps, (t / steps) * i, camera);
    }
    STATE.t = t;
  }
  if (Q.get('explode') === '1') {
    station.setExploded(true);
    // 快进拆解动画，保证 ?explode=1 截图时是"完全展开"的稳定状态
    for (let i = 0; i < 40; i++) station.update(0.05, (STATE.t || 0) + i * 0.05, camera);
    STATE.orbit.tDist = 8.4;
    STATE.orbit.dist = 8.4;
    HUD.btnExplode.textContent = '重组空间站 · REASSEMBLE';
    station.modules.forEach((m) => refreshModuleRow(m, station.isDetached(m.id) ? 'detached' : 'attached'));
  }
  const mode = Q.get('mode');
  if (mode === 'title') {
    document.getElementById('boot').classList.add('off');
    HUD.hud.style.opacity = '0';
    HUD.title.classList.remove('hidden');
  } else if (mode === 'interior') {
    document.getElementById('boot').classList.add('off');
    HUD.title.classList.add('off');
    enterOrbit(true);
    // 调试：?at=<hotspotId> 把玩家摆到该热点前方并朝向它（截图用）
    const at = Q.get('at');
    if (at) {
      const h = interior.hotspots.find((x) => x.id === at);
      const sp = interior._debug && interior._debug.spawn;
      if (h && sp) {
        const dx = h.pos.x - 0, dz = h.pos.z - 0;
        const L = Math.hypot(dx, dz) || 1;
        const stand = 2.4;
        sp.x = h.pos.x - (dx / L) * stand;
        sp.z = h.pos.z - (dz / L) * stand;
        sp.y = 0;
        sp.yaw = Math.atan2(-(dx / L), -(dz / L));
      }
    }
    interior.enter(0);
    STATE.mode = 'interior';
    setModeHUD('interior');
    postfx.use(interior.scene, interior.camera);
  } else if (mode === 'planet') {
    document.getElementById('boot').classList.add('off');
    HUD.title.classList.add('off');
    enterOrbit(true);
    setPlanet(Q.get('planet') || 'saturn');
    STATE.mode = 'planet';
    setModeHUD('planet');
    postfx.use(planetarium.scene, planetarium.camera);
  } else if (mode === 'orbit' || mode === 'flight' || SHOT) {
    document.getElementById('boot').classList.add('off');
    HUD.title.classList.add('off');
    if (mode === 'flight') enterFlight(true);
    else enterOrbit(true);
  }
  if (SHOT && mode !== 'title') {
    HUD.hud.style.opacity = '1';
  }
  updateMissionHUD();
})();

window.__APP = {
  THREE, scene, camera, renderer, world, station, ship, postfx, STATE,
  missions, interior, planetarium,
  enterOrbit, enterFlight, enterInterior, exitInterior, enterPlanet, exitPlanet,
  setPlanet, interactInterior, toggleExplode, selectModule,
};
tick();
