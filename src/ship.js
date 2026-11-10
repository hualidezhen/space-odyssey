// 深空方舟 · 飞船模块
// 程序化星际战机（约 0.9 世界单位长）+ 电影级飞行手感 + 第三人称追尾相机 + 跃迁。
// 只依赖 three 的基础几何 / 材质 / 数学，无外部贴图与模型。
import * as THREE from 'three';

/* ────────────────────────── 通用小工具 ────────────────────────── */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
// 摇杆死区：-1..1 的输入在中心附近压平，再平滑展开回 -1..1
function deadzone(v, dz) {
  const a = Math.abs(clamp(v, -1, 1));
  if (a <= dz) return 0;
  return ((a - dz) / (1 - dz)) * Math.sign(v);
}

/* ────────────────────────── 程序化贴图 ────────────────────────── */
// 引擎/航行灯共用的径向辉光
function makeGlowTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(214,246,255,0.88)');
  g.addColorStop(0.5, 'rgba(96,180,255,0.30)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 引擎专用辉光：中心更小更亮、外圈衰减更陡（避免大块"棉花球"贴图光斑）
function makeEngineGlowTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.07, 'rgba(232,250,255,0.95)');
  g.addColorStop(0.16, 'rgba(178,235,255,0.62)');
  g.addColorStop(0.28, 'rgba(110,196,255,0.24)');
  g.addColorStop(0.46, 'rgba(52,130,235,0.07)');
  g.addColorStop(0.70, 'rgba(20,70,170,0.015)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 机身编号贴花（机翼上的涂装）
function makeNumberTexture() {
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  // 外框
  ctx.strokeStyle = 'rgba(158,214,244,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(9, 9, W - 18, H - 18);
  // 角标
  ctx.fillStyle = 'rgba(158,214,244,0.55)';
  ctx.fillRect(9, 9, 16, 2);
  ctx.fillRect(9, 9, 2, 16);
  ctx.fillRect(W - 25, H - 11, 16, 2);
  ctx.fillRect(W - 11, H - 25, 2, 16);
  // 编号
  ctx.fillStyle = '#e9f2fb';
  ctx.font = 'bold 58px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NX-07', W / 2, H / 2 - 10);
  // 红色识别条
  ctx.fillStyle = '#b8402f';
  ctx.fillRect(W / 2 - 44, H / 2 + 24, 88, 7);
  // 小字
  ctx.fillStyle = 'rgba(176,212,238,0.78)';
  ctx.font = '15px "Consolas", "Courier New", monospace';
  ctx.fillText('DEEP ARK · SF', W / 2, H / 2 + 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ────────────────────────── 几何辅助 ────────────────────────── */
// 机身：沿 z 摆一串截面环（12 边形 => 扁平顶/底），拼成流线形；用内点判定统一朝外
function buildHullGeometry(stations, sides, interiorX, interiorY) {
  const rings = [];
  for (const s of stations) {
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      ring.push(new THREE.Vector3(Math.cos(a) * s.w, s.y + Math.sin(a) * s.h, s.z));
    }
    rings.push(ring);
  }
  const verts = [];
  const tri = (a, b, c) => {
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  // 侧面
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(A[i], A[j], B[j]);
      tri(A[i], B[j], B[i]);
    }
  }
  // 头 / 尾封口
  const first = rings[0], last = rings[rings.length - 1];
  const nose = new THREE.Vector3(0, first[0].y, first[0].z - 0.014);
  const tail = new THREE.Vector3(0, last[0].y, last[0].z);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(nose, first[j], first[i]);
    tri(tail, last[i], last[j]);
  }
  // 翻转朝向：三角形法线必须背离机体内部
  const pos = new Float32Array(verts);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3();
  for (let t = 0; t < pos.length; t += 9) {
    a.set(pos[t], pos[t + 1], pos[t + 2]);
    b.set(pos[t + 3], pos[t + 4], pos[t + 5]);
    c.set(pos[t + 6], pos[t + 7], pos[t + 8]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    cen.x -= interiorX;
    cen.y -= interiorY;
    if (n.dot(cen) < 0) {
      for (let k = 0; k < 3; k++) {
        const tmp = pos[t + 3 + k];
        pos[t + 3 + k] = pos[t + 6 + k];
        pos[t + 6 + k] = tmp;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// 薄板：把 XZ 平面上的多边形沿 Y 挤出 thickness，居中于 y=0（机翼 / 尾板用）
function makePlateGeometry(pts, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// 沿 X 轴镜像几何：翻转 x，并把每个三角形的绕序反过来（保证正面仍朝外）
function mirrorGeometryX(src) {
  const geo = src.clone();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  const names = ['position', 'normal', 'uv'];
  if (geo.index) {
    const idx = geo.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i];
      idx[i] = idx[i + 2];
      idx[i + 2] = t;
    }
    geo.index.needsUpdate = true;
  } else {
    for (const name of names) {
      const attr = geo.attributes[name];
      if (!attr) continue;
      const s = attr.itemSize;
      const arr = attr.array;
      for (let i = 0; i + 2 < pos.count; i += 3) {
        for (let k = 0; k < s; k++) {
          const t = arr[i * s + k];
          arr[i * s + k] = arr[(i + 2) * s + k];
          arr[(i + 2) * s + k] = t;
        }
      }
      attr.needsUpdate = true;
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// 尾焰：顶点（apex）落在局部原点，沿 +Z 张开成长锥；顶点 alpha 沿长度陡衰减 =>
// 喷口处亮、尾端透明，侧面看是细长喷流，追尾视角也不会糊成大圆盘。
function makePlumeGeometry(radius, length, segments = 16, heightSegments = 7, taper = 3.2) {
  const geo = new THREE.ConeGeometry(radius, length, segments, heightSegments, true);
  geo.translate(0, -length / 2, 0);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const u = clamp(pos.getZ(i) / Math.max(length, 1e-5), 0, 1);
    col[i * 4] = 1;
    col[i * 4 + 1] = 1;
    col[i * 4 + 2] = 1;
    col[i * 4 + 3] = Math.pow(1 - u, taper);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return geo;
}

/* ────────────────────────── 主体 ────────────────────────── */
export function createShip(scene, camera, opts = {}) {
  const quality = opts.quality || 'high';
  const BASE_FOV = camera.fov || 52;

  /* ── 飞行参数 ── */
  const CRUISE_SPEED = 24;      // 巡航
  const MAX_SPEED = 90;         // Shift 加速上限
  const THROTTLE_SPAN = 22;     // W/S 在巡航基础上 ±22
  const SPEED_UP_LAMBDA = 1.6;  // 加速惯性
  const SPEED_DOWN_LAMBDA = 0.9;// 回落惯性（更慢，拉力感）
  const VELOCITY_LAMBDA = 4.0;  // 速度矢量追赶机头的阻尼（侧滑感）
  const PITCH_RATE = 0.95;      // rad/s
  const YAW_RATE = 0.88;
  const ROLL_RATE = 2.4;
  const CONTROL_DAMP = 5.5;
  const ROLL_DAMP = 4.8;
  const BANK_ANGLE = 0.55;      // 转弯时的自动侧倾角（rad）
  const LEVEL_GAIN = 1.35;      // 松杆后的自稳强度
  const CHASE_DIST = 1.95;      // 追尾机位：静止
  const CHASE_DIST_MAX = 2.45;  // 全速拉远
  const CHASE_HEIGHT = 0.42;    // 略低机位，让机身侧面/上缘轮廓立起来
  const WARP_DURATION = 0.95;
  const WARP_CHARGE_MAX = 1;
  const WARP_COST = 0.5;
  const WARP_REGEN = 0.12;      // 每秒恢复

  /* ── 飞船容器 ── */
  const group = new THREE.Group();
  group.name = 'ship';
  group.visible = false;
  scene.add(group);

  const glowTex = makeGlowTexture();
  const engineGlowTex = makeEngineGlowTexture();
  const decalTex = makeNumberTexture();

  /* ── 材质（场景无 envMap，金属度刻意压低，避免机体发黑、轮廓读不出来） ── */
  const matHull = new THREE.MeshStandardMaterial({
    color: 0xd2dae4, metalness: 0.34, roughness: 0.48, flatShading: true,
  });
  const matHullDark = new THREE.MeshStandardMaterial({
    color: 0x39424e, metalness: 0.5, roughness: 0.5, flatShading: true,
  });
  const matPlate = new THREE.MeshStandardMaterial({
    color: 0x9fabb9, metalness: 0.42, roughness: 0.44, flatShading: true,
  });
  const matAccent = new THREE.MeshStandardMaterial({
    color: 0xa8382b, metalness: 0.3, roughness: 0.58, flatShading: true,
  });
  const matTrim = new THREE.MeshStandardMaterial({
    color: 0x5b6572, metalness: 0.56, roughness: 0.36, flatShading: true,
  });
  const matGlass = new THREE.MeshPhysicalMaterial({
    color: 0x0a1620,
    metalness: 0.5,
    roughness: 0.07,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    emissive: 0x0d2a38,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.95,
  });
  const matNozzle = new THREE.MeshStandardMaterial({
    color: 0x1b2129, metalness: 0.6, roughness: 0.4, flatShading: true,
  });
  const matFlameOuter = new THREE.MeshBasicMaterial({
    color: 0x2f7dff, vertexColors: true, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const matFlameInner = new THREE.MeshBasicMaterial({
    color: 0xcdefff, vertexColors: true, transparent: true, opacity: 0.65,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  const decalMat = new THREE.MeshBasicMaterial({
    map: decalTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.96,
  });

  /* ── 机身 ── */
  const HULL_STATIONS = [
    { z: -0.450, w: 0.006, h: 0.006, y: 0.000 },
    { z: -0.360, w: 0.030, h: 0.024, y: 0.004 },
    { z: -0.240, w: 0.058, h: 0.044, y: 0.010 },
    { z: -0.100, w: 0.078, h: 0.056, y: 0.012 },
    { z: 0.060, w: 0.084, h: 0.058, y: 0.010 },
    { z: 0.220, w: 0.070, h: 0.050, y: 0.006 },
    { z: 0.400, w: 0.052, h: 0.038, y: 0.002 },
  ];
  const hull = new THREE.Mesh(buildHullGeometry(HULL_STATIONS, 12, 0, 0.02), matHull);
  group.add(hull);

  // 背脊装甲板
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.012, 0.22), matHullDark);
  spine.position.set(0, 0.062, -0.22);
  group.add(spine);

  // 机头小装甲 + 传感器
  const nosePlate = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.010, 0.11), matTrim);
  nosePlate.position.set(0, 0.034, -0.34);
  group.add(nosePlate);

  // 座舱玻璃 + 中脊框
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), matGlass);
  canopy.scale.set(0.048, 0.032, 0.115);
  canopy.position.set(0, 0.068, -0.135);
  group.add(canopy);
  const canopyRib = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.13), matTrim);
  canopyRib.position.set(0, 0.099, -0.135);
  group.add(canopyRib);

  // 两侧进气 / 设备舱
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.026, 0.20), matHullDark);
    pod.position.set(side * 0.078, 0.012, -0.03);
    group.add(pod);
    const podTrim = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.008, 0.14), matTrim);
    podTrim.position.set(side * 0.088, 0.028, -0.03);
    group.add(podTrim);
  }

  // 机头天线
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.07, 5), matTrim);
  antenna.position.set(0, 0.085, -0.36);
  antenna.rotation.x = 0.22;
  group.add(antenna);

  /* ── 机翼（前掠翼尖 + 后掠主翼） ── */
  const WING_PTS = [
    [0.050, -0.075],  // 根部前缘
    [0.300, 0.050],   // 中段前缘
    [0.470, 0.020],   // 翼尖前掠
    [0.470, 0.150],   // 翼尖后缘
    [0.300, 0.235],   // 中段后缘
    [0.060, 0.255],   // 根部后缘
  ];
  const WING_THICK = 0.018;
  const DIHEDRAL = 0.055;
  const wingGeoR = makePlateGeometry(WING_PTS, WING_THICK);
  const wingGeoL = mirrorGeometryX(wingGeoR);
  const navLights = [];
  const wingGroups = [];

  for (const side of [-1, 1]) {
    const wingGroup = new THREE.Group();
    wingGroup.position.set(0, 0.012, 0);
    wingGroup.rotation.z = side * DIHEDRAL;
    group.add(wingGroup);
    wingGroups.push(wingGroup);

    const wing = new THREE.Mesh(side > 0 ? wingGeoR : wingGeoL, matHull);
    wingGroup.add(wing);

    // 翼面识别条
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.003, 0.016), matAccent);
    stripe.position.set(side * 0.18, 0.011, 0.045);
    wingGroup.add(stripe);

    // 编号贴花
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.065), decalMat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(side * 0.19, 0.0115, 0.115);
    wingGroup.add(decal);

    // 翼上炮管
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.26, 8), matTrim);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(side * 0.30, 0.012, 0.055);
    wingGroup.add(gun);
    const gunTip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), matHullDark);
    gunTip.position.set(side * 0.30, 0.012, -0.075);
    wingGroup.add(gunTip);

    // 翼尖航行灯：左红右绿（相机在机后，左翼在 -x）
    const isLeft = side < 0;
    const navMat = new THREE.MeshBasicMaterial({
      color: isLeft ? 0xff3a2e : 0x2eff7a, transparent: true, opacity: 0.9, toneMapped: false,
    });
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.010, 8, 6), navMat);
    nav.position.set(side * 0.462, 0.047, 0.085);
    group.add(nav);
    const navGlowMat = new THREE.SpriteMaterial({
      map: glowTex, color: isLeft ? 0xff4433 : 0x39ff8a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.75, toneMapped: false,
    });
    const navGlow = new THREE.Sprite(navGlowMat);
    navGlow.position.copy(nav.position);
    navGlow.scale.setScalar(0.075);
    group.add(navGlow);
    navLights.push({ mat: navMat, glowMat: navGlowMat, phase: isLeft ? 0 : 1.55 });
  }

  /* ── 双引擎：短舱 / 喷口 / 喷口短焰 / 尾焰 / 辉光 ── */
  const FLAME_Z = 0.44;
  const engines = [];
  const flameGeoOuter = makePlumeGeometry(0.050, 0.50, 16, 7, 3.2);
  const flameGeoInner = makePlumeGeometry(0.026, 0.34, 12, 6, 3.2);
  // 喷口短焰用"锥口"而不是正圆发光盘：盘在追尾视角永远是硬边圆（像车灯），锥口能读出喷流
  const corePlumeGeo = makePlumeGeometry(0.034, 0.10, 14, 4, 3.6);
  const matFlameCore = new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });

  for (const side of [-1, 1]) {
    const x = side * 0.108;
    // 短舱
    const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.054, 0.30, 12, 1, true), matHullDark);
    nacelle.rotation.x = Math.PI / 2;
    nacelle.position.set(x, -0.002, 0.245);
    group.add(nacelle);
    // 短舱前端整流罩
    const nacelleCap = new THREE.Mesh(new THREE.SphereGeometry(0.054, 12, 8), matHull);
    nacelleCap.scale.set(1, 1, 0.5);
    nacelleCap.position.set(x, -0.002, 0.095);
    group.add(nacelleCap);
    // 喷口
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.046, 0.06, 12, 1, true), matNozzle);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, -0.002, 0.42);
    group.add(nozzle);
    // 喷口短焰：从喷口沿 +Z 喷出的锥口，update 里靠 scale.z 拉长
    const coreCone = new THREE.Mesh(corePlumeGeo, matFlameCore);
    coreCone.position.set(x, -0.002, FLAME_Z);
    coreCone.renderOrder = 6;
    group.add(coreCone);
    // 尾焰
    const outer = new THREE.Mesh(flameGeoOuter, matFlameOuter);
    outer.position.set(x, -0.002, FLAME_Z);
    outer.renderOrder = 4;
    group.add(outer);
    const inner = new THREE.Mesh(flameGeoInner, matFlameInner);
    inner.position.set(x, -0.002, FLAME_Z);
    inner.renderOrder = 5;
    group.add(inner);
    // 白热点：尺寸只有核心的 0.5 倍，接近纯白，只负责 Bloom 上的那一点刺眼
    const glowHotMat = new THREE.SpriteMaterial({
      map: engineGlowTex, color: 0xe9feff, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.95, toneMapped: false,
    });
    const glowHot = new THREE.Sprite(glowHotMat);
    glowHot.position.set(x, -0.002, 0.455);
    glowHot.scale.setScalar(0.032);
    glowHot.renderOrder = 7;
    group.add(glowHot);
    // 辉光精灵：小尺寸核心 + 更小更淡的外晕（避免大面积柔光斑）
    const glowCoreMat = new THREE.SpriteMaterial({
      map: engineGlowTex, color: 0xbff4ff, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.95, toneMapped: false,
    });
    const glowCore = new THREE.Sprite(glowCoreMat);
    glowCore.position.set(x, -0.002, 0.462);
    glowCore.scale.setScalar(0.062);
    glowCore.renderOrder = 6;
    group.add(glowCore);
    const glowWideMat = new THREE.SpriteMaterial({
      map: engineGlowTex, color: 0x2f8cff, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0.14, toneMapped: false,
    });
    const glowWide = new THREE.Sprite(glowWideMat);
    glowWide.position.set(x, -0.002, 0.50);
    glowWide.scale.set(0.075, 0.12, 1);
    glowWide.renderOrder = 6;
    group.add(glowWide);

    engines.push({ outer, inner, coreCone, glowHot, glowCore, glowWide });
  }

  /* ── 跃迁 / 加速光条（随机半径的线段，随飞船） ── */
  const streakCount = quality === 'low' ? 64 : 110;
  const streakPos = new Float32Array(streakCount * 6);
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
  const streakMat = new THREE.LineBasicMaterial({
    color: 0x9fe8ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const streakLine = new THREE.LineSegments(streakGeo, streakMat);
  streakLine.frustumCulled = false;
  streakLine.visible = false;
  streakLine.renderOrder = 3;
  group.add(streakLine);
  const streaks = [];
  for (let i = 0; i < streakCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.35 + Math.random() * 2.1;
    streaks.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      z: -1 - Math.random() * 18,
      seed: 0.55 + Math.random() * 0.9,
    });
  }

  /* ── 拖尾：两条细线，世界坐标，顶点色做淡出 ── */
  function createTrail() {
    const N = quality === 'low' ? 14 : 22;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 2;
    line.visible = false;
    scene.add(line);
    const pts = [];
    for (let i = 0; i < N; i++) pts.push(new THREE.Vector3());
    return { N, geo, pos, col, mat, line, pts, ready: false };
  }
  const trails = [createTrail(), createTrail()];
  const TRAIL_OFFSETS = [new THREE.Vector3(-0.108, -0.002, 0.47), new THREE.Vector3(0.108, -0.002, 0.47)];

  /* ── 状态 ── */
  const state = {
    speed: 0,
    maxSpeed: MAX_SPEED,
    throttle: 0,
    boosting: false,
    warping: false,
    warpCharge: WARP_CHARGE_MAX,
  };

  let active = false;
  let cameraMode = 'chase';

  /* ── 物理 / 相机状态（全部复用，不在 update 里 new） ── */
  const vel = new THREE.Vector3();          // 世界速度矢量（可略微偏离机头 => 侧滑）
  const angVel = new THREE.Vector3();       // 机体角速度：x 俯仰 / y 偏航 / z 滚转
  const rigQ = new THREE.Quaternion();      // 平滑后的追尾机位朝向
  let smoothDist = CHASE_DIST;
  let smoothHeight = CHASE_HEIGHT;
  let boostMix = 0;
  let warpMix = 0;

  const camBlend = {
    active: false,
    t: 0,
    dur: 1.2,
    fromPos: new THREE.Vector3(),
    fromQuat: new THREE.Quaternion(),
  };

  const warp = {
    active: false,
    t: 0,
    dur: WARP_DURATION,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    hasRot: false,
  };

  // 临时对象（闭包外，避免每帧分配）
  const _fwd = new THREE.Vector3();
  const _upShip = new THREE.Vector3();
  const _upCam = new THREE.Vector3();
  const _flatUp = new THREE.Vector3();
  const _cross = new THREE.Vector3();
  const _lookDir = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _desiredPos = new THREE.Vector3();
  const _desiredQuat = new THREE.Quaternion();
  const _velTarget = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _zero = new THREE.Vector3(0, 0, 0);
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _upAlt = new THREE.Vector3(0, 0, 1);
  const _euler = new THREE.Euler();
  const _dq = new THREE.Quaternion();
  const _mat = new THREE.Matrix4();
  const _tiltQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.03, 0, 0));

  /* ────────────────────────── 定位 / 激活 ────────────────────────── */
  function resetTrails() {
    for (const tr of trails) {
      tr.ready = false;
      tr.line.visible = false;
    }
  }

  function placeAt(pos, euler) {
    if (pos) group.position.copy(pos);
    if (euler) group.quaternion.setFromEuler(euler);
    group.quaternion.normalize();

    vel.set(0, 0, 0);
    angVel.set(0, 0, 0);
    state.speed = 0;
    state.throttle = 0;
    state.boosting = false;
    state.warping = false;
    warp.active = false;
    boostMix = 0;
    warpMix = 0;
    rigQ.copy(group.quaternion);
    smoothDist = CHASE_DIST;
    smoothHeight = CHASE_HEIGHT;
    camBlend.active = false;
    resetTrails();
    streakLine.visible = false;
    group.visible = active;
  }

  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    group.visible = on;
    resetTrails();
    streakLine.visible = false;

    if (on) {
      // 记录当前相机，1.2 秒平滑过渡到追尾机位（Lead 依赖这个过渡）
      rigQ.copy(group.quaternion);
      smoothDist = CHASE_DIST;
      smoothHeight = CHASE_HEIGHT;
      camBlend.fromPos.copy(camera.position);
      camBlend.fromQuat.copy(camera.quaternion);
      camBlend.t = 0;
      camBlend.dur = 1.2;
      camBlend.active = true;
    } else {
      camBlend.active = false;
      cameraMode = 'chase';
      canopy.visible = true;
      canopyRib.visible = true;
      antenna.visible = true;
      if (Math.abs(camera.fov - BASE_FOV) > 0.001) {
        camera.fov = BASE_FOV;
        camera.updateProjectionMatrix();
      }
    }
  }

  function toggleCamera() {
    cameraMode = cameraMode === 'chase' ? 'cockpit' : 'chase';
    canopy.visible = cameraMode !== 'cockpit';
    canopyRib.visible = canopy.visible;
    // 机头天线正常只有 4mm 粗，但在座舱视点下离眼 0.16、正好戳在画面正中，座舱视角内隐藏
    antenna.visible = canopy.visible;
    if (active) {
      camBlend.fromPos.copy(camera.position);
      camBlend.fromQuat.copy(camera.quaternion);
      camBlend.t = 0;
      camBlend.dur = 0.55;
      camBlend.active = true;
    }
  }

  /* ────────────────────────── 跃迁 ────────────────────────── */
  function warpTo(target) {
    if (state.warping || !target) return;
    state.warping = true;
    state.warpCharge = Math.max(0, state.warpCharge - WARP_COST);
    warp.active = true;
    warp.t = 0;
    warp.dur = WARP_DURATION;
    warp.from.copy(group.position);
    warp.to.copy(target);

    _dir.subVectors(target, group.position);
    if (_dir.lengthSq() > 1e-8) {
      _dir.normalize();
      // 目标方向几乎垂直时换个 up，避免 lookAt 退化
      const up = Math.abs(_dir.y) > 0.97 ? _upAlt : _worldUp;
      _mat.lookAt(_zero, _dir, up);
      warp.quat.setFromRotationMatrix(_mat);
      warp.hasRot = true;
    } else {
      warp.hasRot = false;
    }

    vel.set(0, 0, 0);
    angVel.set(0, 0, 0);
    state.speed = 0;
    resetTrails();
  }

  function updateWarp(dt) {
    const w = warp;
    w.t += dt;
    const k = clamp(w.t / w.dur, 0, 1);
    const stretch = smoothstep(0, 0.3, k);   // 先拉长光条
    const travel = smoothstep(0.26, 0.97, k); // 再平滑位移

    group.position.lerpVectors(w.from, w.to, travel);
    if (w.hasRot) group.quaternion.slerp(w.quat, 1 - Math.exp(-7 * dt));
    // 追尾机位同步跟上跃迁姿态，避免到达后镜头绕一大圈
    rigQ.slerp(group.quaternion, 1 - Math.exp(-8 * dt));

    // 速度读数：跃迁峰值，收尾自动落回低速
    const env = Math.sin(k * Math.PI);
    state.speed = 4 + 1500 * env * stretch;
    vel.set(0, 0, 0);

    if (k >= 1) {
      group.position.copy(w.to);
      group.quaternion.normalize();
      state.warping = false;
      w.active = false;
      state.speed = 4;
      _fwd.set(0, 0, -1).applyQuaternion(group.quaternion);
      vel.copy(_fwd).multiplyScalar(4);
      angVel.multiplyScalar(0.2);
      resetTrails();
    }
  }

  /* ────────────────────────── 飞行物理 ────────────────────────── */
  function updateFlight(dt, input) {
    // 推力 / 速度
    const throttle = clamp(input.throttle || 0, -1, 1);
    const boost = !!input.boost;
    state.throttle = throttle;
    state.boosting = boost;

    let targetSpeed = CRUISE_SPEED + throttle * THROTTLE_SPAN;
    if (boost) targetSpeed = MAX_SPEED;
    const speedingUp = targetSpeed > state.speed;
    const lambda = speedingUp ? SPEED_UP_LAMBDA : SPEED_DOWN_LAMBDA;
    state.speed = Math.max(0, damp(state.speed, targetSpeed, lambda, dt));

    // 输入（鼠标位置绝对值 -> 角速度目标，带死区）
    const pitchIn = deadzone(input.pitch || 0, 0.07);
    const yawIn = deadzone(input.yaw || 0, 0.07);
    const rollIn = clamp(input.roll || 0, -1, 1);

    // 姿态基向量
    _fwd.set(0, 0, -1).applyQuaternion(group.quaternion);
    _upShip.set(0, 1, 0).applyQuaternion(group.quaternion);

    // 上下视角限制：接近垂直时不再继续抬头/低头（同时避免相机 up 退化）
    let pitchRate = pitchIn * PITCH_RATE;
    if ((_fwd.y > 0.93 && pitchRate > 0) || (_fwd.y < -0.93 && pitchRate < 0)) pitchRate = 0;
    const yawRate = -yawIn * YAW_RATE;

    // 滚转：A/D 手动；松杆时朝"水平"缓慢自稳，转弯时自动压坡度
    let rollRate = -rollIn * ROLL_RATE;
    _flatUp.copy(_worldUp).addScaledVector(_fwd, -_worldUp.dot(_fwd));
    if (_flatUp.lengthSq() > 0.04) {
      _flatUp.normalize();
      _cross.crossVectors(_upShip, _flatUp);
      const rollErr = Math.atan2(_cross.dot(_fwd), _upShip.dot(_flatUp));
      const bankTarget = -yawIn * BANK_ANGLE;
      const manual = Math.min(1, Math.abs(rollIn) * 4);
      rollRate += clamp(-LEVEL_GAIN * (rollErr - bankTarget) * (1 - manual), -1.9, 1.9);
    }

    angVel.x = damp(angVel.x, pitchRate, CONTROL_DAMP, dt);
    angVel.y = damp(angVel.y, yawRate, CONTROL_DAMP, dt);
    angVel.z = damp(angVel.z, rollRate, ROLL_DAMP, dt);

    // 机体角速度积分（局部轴）
    _euler.set(angVel.x * dt, angVel.y * dt, angVel.z * dt, 'YXZ');
    _dq.setFromEuler(_euler);
    group.quaternion.multiply(_dq).normalize();

    // 位移：速度矢量向机头方向有限插值 => 有惯性 / 轻微侧滑，但不会失控
    _fwd.set(0, 0, -1).applyQuaternion(group.quaternion);
    _velTarget.copy(_fwd).multiplyScalar(state.speed);
    vel.lerp(_velTarget, 1 - Math.exp(-VELOCITY_LAMBDA * dt));
    group.position.addScaledVector(vel, dt);
  }

  /* ────────────────────────── 引擎 / 灯光 / 光条 / 拖尾 ────────────────────────── */
  function updateStreaks(dt) {
    const amt = Math.max(warpMix, clamp((state.speed - 34) / 56, 0, 1) * 0.7);
    const show = amt > 0.02 && active;
    streakLine.visible = show;
    if (!show) return;
    streakMat.opacity = 0.55 * amt;
    const vz = 6 + state.speed * 1.35 + warpMix * 260;
    const lenBase = 0.5 + amt * 11;
    for (let i = 0; i < streakCount; i++) {
      const s = streaks[i];
      s.z += vz * dt * s.seed;
      if (s.z > 4.5) s.z -= 22;
      const len = lenBase * s.seed;
      const o = i * 6;
      streakPos[o] = s.x;
      streakPos[o + 1] = s.y;
      streakPos[o + 2] = s.z - len;
      streakPos[o + 3] = s.x;
      streakPos[o + 4] = s.y;
      streakPos[o + 5] = s.z;
    }
    streakGeo.attributes.position.needsUpdate = true;
  }

  function updateTrail(tr, offsetLocal) {
    const emit = _dir.copy(offsetLocal).applyQuaternion(group.quaternion).add(group.position);
    if (!tr.ready) {
      for (const p of tr.pts) p.copy(emit);
      tr.ready = true;
    } else if (tr.pts[0].distanceToSquared(emit) > 0.0004) {
      for (let i = tr.N - 1; i > 0; i--) tr.pts[i].copy(tr.pts[i - 1]);
      tr.pts[0].copy(emit);
    }
    const intensity = clamp(state.speed / 55, 0, 1) * (0.55 + 0.45 * boostMix);
    tr.line.visible = active && intensity > 0.04;
    if (!tr.line.visible) return;
    for (let i = 0; i < tr.N; i++) {
      const f = 1 - i / (tr.N - 1);
      const k = Math.pow(f, 1.7) * intensity;
      tr.pos[i * 3] = tr.pts[i].x;
      tr.pos[i * 3 + 1] = tr.pts[i].y;
      tr.pos[i * 3 + 2] = tr.pts[i].z;
      tr.col[i * 3] = 0.30 * k;
      tr.col[i * 3 + 1] = 0.68 * k;
      tr.col[i * 3 + 2] = 1.0 * k;
    }
    tr.geo.attributes.position.needsUpdate = true;
    tr.geo.attributes.color.needsUpdate = true;
  }

  function updateVisuals(dt, t) {
    const boosting = state.boosting && !state.warping;
    boostMix = damp(boostMix, boosting ? 1 : 0, boosting ? 5 : 2.6, dt);
    warpMix = damp(warpMix, state.warping ? 1 : 0, state.warping ? 12 : 4.2, dt);

    const spd01 = clamp(state.speed / MAX_SPEED, 0, 1);
    const thrust = clamp(0.16 + spd01 * 0.9 + boostMix * 0.2, 0.05, 1.15);
    const flicker = 1 + Math.sin(t * 37.1) * 0.05 + Math.sin(t * 21.7 + 1.3) * 0.035;

    // 尾焰：细长喷流（几何本身沿长度 alpha 衰减），这里调长度/透明度/核心亮度
    const lenScale = (0.50 + thrust * 1.05 + boostMix * 0.75 + warpMix * 1.4) * flicker;
    const radial = (0.80 + thrust * 0.22) * flicker;
    matFlameOuter.opacity = clamp(0.10 + 0.16 * thrust + 0.10 * boostMix + 0.08 * warpMix, 0.05, 0.42);
    matFlameInner.opacity = clamp(0.20 + 0.28 * thrust + 0.14 * boostMix, 0.12, 0.7);

    for (const e of engines) {
      e.outer.scale.set(radial, radial, lenScale);
      e.inner.scale.set(radial * 0.95, radial * 0.95, lenScale * 0.66);
      // 喷口短焰：沿 +Z 拉长 1.9~2.2 倍，读成"喷出来的锥口"而不是端点上的圆灯
      const coreStretch = 1.9 + 0.18 * thrust + 0.12 * boostMix + 0.45 * warpMix;
      e.coreCone.scale.set(0.95 + 0.10 * thrust, 0.95 + 0.10 * thrust, coreStretch);
      e.coreCone.material.opacity = clamp(0.82 + 0.18 * thrust, 0.75, 1.0);
      // 白热点：核心的 0.5 倍，接近纯白
      const hotS = (0.026 + 0.010 * thrust + 0.008 * boostMix + 0.020 * warpMix) * flicker;
      e.glowHot.scale.setScalar(hotS);
      e.glowHot.material.opacity = clamp(0.85 + 0.15 * thrust, 0.7, 1.0);
      // 核心辉光压低：只给一点层次，不再负责"亮"
      const coreS = (0.048 + 0.030 * thrust + 0.018 * boostMix + 0.050 * warpMix) * flicker;
      e.glowCore.scale.setScalar(coreS);
      e.glowCore.material.opacity = clamp(0.38 + 0.24 * thrust, 0.30, 0.64);
      // 蓝色外雾压到很淡（0.02~0.06），纵向拉长读成沿视线的尾迹，避免把机身两侧染蓝
      const wideS = 0.068 + 0.030 * thrust + 0.040 * boostMix + 0.22 * warpMix;
      e.glowWide.scale.set(wideS * 0.62, wideS * 1.9, 1);
      e.glowWide.material.opacity = clamp(0.018 + 0.030 * thrust + 0.030 * warpMix, 0.012, 0.06);
    }

    // 航行灯闪烁（左红右绿，错相）
    for (const n of navLights) {
      const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3.4 + n.phase));
      n.mat.opacity = blink;
      n.glowMat.opacity = 0.2 + 0.65 * blink;
    }

    updateStreaks(dt);

    if (state.warping) {
      for (const tr of trails) {
        tr.line.visible = false;
        tr.ready = false;
      }
    } else {
      updateTrail(trails[0], TRAIL_OFFSETS[0]);
      updateTrail(trails[1], TRAIL_OFFSETS[1]);
    }
  }

  /* ────────────────────────── 相机 ────────────────────────── */
  function updateCamera(dt, t) {
    // FOV：boost 52 -> ~68，跃迁再拉一点
    const fovTarget = BASE_FOV + 16 * boostMix + 9 * warpMix;
    if (Math.abs(camera.fov - fovTarget) > 0.01) {
      camera.fov = damp(camera.fov, fovTarget, 6, dt);
      camera.updateProjectionMatrix();
    }

    if (cameraMode === 'cockpit') {
      // 座舱视点：挪到座舱前部并抬高一点，让机首沉到画面下缘之外，正前方留给星空
      _desiredPos.set(0, 0.135, -0.20).applyQuaternion(group.quaternion).add(group.position);
      const vib = 0.0009 + boostMix * 0.0018 + clamp(state.speed / MAX_SPEED, 0, 1) * 0.0008;
      _desiredPos.x += Math.sin(t * 51) * vib;
      _desiredPos.y += Math.cos(t * 46) * vib;
      _desiredQuat.copy(group.quaternion).multiply(_tiltQ);
    } else {
      const spd01 = clamp((state.speed - CRUISE_SPEED) / (MAX_SPEED - CRUISE_SPEED), 0, 1);
      smoothDist = damp(smoothDist, CHASE_DIST + (CHASE_DIST_MAX - CHASE_DIST) * spd01 + warpMix * 0.2, 5, dt);
      smoothHeight = damp(smoothHeight, CHASE_HEIGHT + 0.07 * spd01, 5, dt);

      // 机位姿态用四元数弹簧：转向 / 滚转都略有滞后
      rigQ.slerp(group.quaternion, 1 - Math.exp(-4.4 * dt));

      _desiredPos.set(0, smoothHeight, smoothDist).applyQuaternion(rigQ).add(group.position);

      // 引擎/加速震动（平滑的正弦，不用随机，避免抖动）
      const shake = 0.0035 * boostMix + 0.0012 * spd01 + 0.02 * warpMix;
      if (shake > 0.0002) {
        _desiredPos.x += Math.sin(t * 43.0) * shake;
        _desiredPos.y += Math.cos(t * 37.0) * shake * 0.7;
        _desiredPos.z += Math.sin(t * 29.0 + 2.0) * shake * 0.5;
      }

      // 看向机头前方一点：飞船落在画面偏下，前方留出大片星空
      _fwd.set(0, 0, -1).applyQuaternion(group.quaternion);
      _upShip.set(0, 1, 0).applyQuaternion(group.quaternion);
      _look.copy(group.position).addScaledVector(_fwd, 1.15 + 0.35 * spd01).addScaledVector(_upShip, 0.10);

      _upCam.set(0, 1, 0).applyQuaternion(rigQ);
      _lookDir.subVectors(_look, _desiredPos).normalize();
      if (Math.abs(_upCam.dot(_lookDir)) > 0.985) _upCam.set(0, 0, 1).applyQuaternion(rigQ);

      _mat.lookAt(_desiredPos, _look, _upCam);
      _desiredQuat.setFromRotationMatrix(_mat);
    }

    if (camBlend.active) {
      camBlend.t += dt;
      const k = easeInOut(clamp(camBlend.t / camBlend.dur, 0, 1));
      camera.position.lerpVectors(camBlend.fromPos, _desiredPos, k);
      camera.quaternion.slerpQuaternions(camBlend.fromQuat, _desiredQuat, k);
      if (k >= 1) camBlend.active = false;
    } else {
      camera.position.copy(_desiredPos);
      camera.quaternion.slerp(_desiredQuat, 1 - Math.exp(-18 * dt));
    }
  }

  /* ────────────────────────── 每帧更新 ────────────────────────── */
  function update(dt, t, input = {}) {
    dt = Math.min(Math.max(dt, 0), 0.05);

    // 跃迁充能：消耗一次 0.5，平时每秒回 0.12
    if (!state.warping) {
      state.warpCharge = Math.min(WARP_CHARGE_MAX, state.warpCharge + WARP_REGEN * dt);
    }

    if (!active) return;

    if (warp.active) updateWarp(dt);
    else updateFlight(dt, input);

    updateVisuals(dt, t);
    updateCamera(dt, t);
  }

  /* ────────────────────────── 对外接口 ────────────────────────── */
  return {
    group,
    state,
    placeAt,
    setActive,
    update,
    warpTo,
    toggleCamera,
    get position() {
      return group.position;
    },
    get cameraMode() {
      return cameraMode;
    },
    get active() {
      return active;
    },
  };
}
