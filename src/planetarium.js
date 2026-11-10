// 深空方舟 · 行星特写展厅（独立 scene + camera）
//
// 对外接口（见 docs/FEATURES-CONTRACT.md 第 3 节）：
//   createPlanetarium({ renderer, quality }) -> {
//     scene, camera, isOpen, bodies,
//     open(id, t), close(), next(), prev(), current,
//     update(dt, t, input), dispose()
//   }
//
// 设计要点：
//   · 4 颗高细分球（共享同一份单位球几何，材质实例各一份，永不每帧重建）
//   · 每颗星球一套独立手写 shader：saturn / jupiter / earth / mars
//   · 全部光照在「物体空间」完成：太阳方向与相机位置每帧由 JS 反变换进星球本地系，
//     这样既能做环影射线求交，也能做火星的地形 bump，不依赖任何贴图
//   · 自建深空：6500 颗 Points 星点 + 一层极淡星云雾球壳
//   · 机位 3/4 侧光；dragX/dragY 累加环绕角，zoom 改变距离（clamp 1.4R~8R）；
//     3 秒无操作自动缓慢环绕
//
// 本模块不 import world.js，所有 shader 均为新写。

import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (Number.isFinite(v) ? v : 0);

/** 主光方向：从星球指向太阳（世界空间）。侧后方 3/4 光。 */
const SUN_DIR = new THREE.Vector3(-0.60, 0.31, 0.70).normalize();
/** 银河带法线（星点分布与星云亮带共用） */
const GAL_NORMAL = new THREE.Vector3(0.30, 0.72, -0.62).normalize();

/** 大红斑在木星本地系的经度（rad） */
const GRS_LON = 0.55;

const EMPTY_INPUT = Object.freeze({ dragX: 0, dragY: 0, zoom: 0, auto: false });

/* ════════════════════════════════════════════════════════════════════════
   GLSL 公共库（本模块自写，不用 world.js 的版本）
   ════════════════════════════════════════════════════════════════════════ */
const GLSL_COMMON = /* glsl */ `
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float a = mix(n000, n100, f.x);
  float b = mix(n010, n110, f.x);
  float c = mix(n001, n101, f.x);
  float d = mix(n011, n111, f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

// 4 倍频 fbm，返回 0..1
float fbm(vec3 p){
  float s = 0.50 * vnoise(p);
  p = p * 2.02 + vec3(1.7, 2.3, 0.9);
  s += 0.25 * vnoise(p);
  p = p * 2.03 + vec3(3.1, 1.1, 4.3);
  s += 0.125 * vnoise(p);
  p = p * 1.97 + vec3(5.3, 3.7, 2.1);
  s += 0.0625 * vnoise(p);
  return s / 0.9375;
}

// 3 倍频 fbm（省算力），返回 0..1
float fbm3(vec3 p){
  float s = 0.55 * vnoise(p);
  p = p * 2.07 + vec3(2.1, 4.3, 1.5);
  s += 0.28 * vnoise(p);
  p = p * 2.03 + vec3(6.7, 1.9, 3.3);
  s += 0.15 * vnoise(p);
  return s / 0.98;
}
`;

/* ── 球体顶点着色器：只用物体空间坐标（法线 = 单位球上的 position） ── */
const SPHERE_VERT = /* glsl */ `
varying vec3 vObj;
void main(){
  vObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ══════════════════════ 土星 ══════════════════════
   柔和奶油色纬向云带 + 环投在球面上的影子
   环的径向密度函数 ringDensity 与 RING_FRAG 中的保持同源（半径以 R 为单位，本模块 R=1）
*/
const SATURN_FRAG = /* glsl */ `
uniform vec3  uSunObj;      // 太阳方向（星球物体空间）
uniform vec3  uCamObj;      // 相机位置（星球物体空间）
uniform float uShadow;      // 环影强度
varying vec3  vObj;
${GLSL_COMMON}

float ringDensity(float rr){
  float dens = 0.0;
  // C 环：内侧暗淡
  dens += smoothstep(1.13, 1.19, rr) * (1.0 - smoothstep(1.45, 1.49, rr)) * 0.30;
  // B 环：主环、最亮
  dens += smoothstep(1.49, 1.52, rr) * (1.0 - smoothstep(1.92, 1.95, rr)) * 0.95;
  // A 环
  dens += smoothstep(2.03, 2.06, rr) * (1.0 - smoothstep(2.25, 2.29, rr)) * 0.62;
  // F 环细线
  dens += smoothstep(2.320, 2.330, rr) * (1.0 - smoothstep(2.335, 2.345, rr)) * 0.34;
  // Cassini 缝
  float cassini = smoothstep(1.950, 1.972, rr) * (1.0 - smoothstep(2.014, 2.036, rr));
  // Encke 缝
  float encke = smoothstep(2.201, 2.207, rr) * (1.0 - smoothstep(2.213, 2.219, rr));
  dens *= 1.0 - cassini * 0.96;
  dens *= 1.0 - encke * 0.86;
  // 环纹细结构（两层频率，避免高频摩尔纹）
  dens *= 0.74 + 0.26 * sin(rr * 315.0 + sin(rr * 41.0) * 1.8);
  dens *= 0.84 + 0.16 * vnoise(vec3(rr * 165.0, 3.7, 1.3));
  return clamp(dens, 0.0, 1.0);
}

void main(){
  vec3 p = normalize(vObj);
  float lat = p.y;

  // ── 柔和奶油色纬向云带 ─────────────────────────────
  float stre = fbm(vec3(p.x * 2.1, p.y * 11.0, p.z * 2.1));
  float fine = fbm3(vec3(p.x * 3.6, p.y * 34.0, p.z * 3.6));
  float b1 = 0.5 + 0.5 * sin(lat * 21.0 + stre * 9.0 + fine * 2.0);
  float b2 = 0.5 + 0.5 * sin(lat * 8.0 + stre * 4.0);
  float b3 = 0.5 + 0.5 * sin(lat * 47.0 + fine * 13.0);

  vec3 cBelt  = vec3(0.50, 0.42, 0.29);
  vec3 cZone  = vec3(0.83, 0.76, 0.60);
  vec3 cPale  = vec3(0.89, 0.845, 0.71);
  vec3 cPolar = vec3(0.43, 0.45, 0.46);

  vec3 albedo = mix(cBelt, cZone, smoothstep(0.22, 0.78, b1));
  albedo = mix(albedo, cPale, smoothstep(0.55, 0.92, b2) * 0.42);
  albedo = mix(albedo, cBelt * 0.86, (1.0 - b3) * 0.16);

  float polar = smoothstep(0.52, 0.95, abs(lat) + (stre - 0.5) * 0.12);
  albedo = mix(albedo, cPolar, polar * 0.55);

  // ── 行星环投在球面上的影子（物体空间：从表面点沿太阳方向打到赤道面）─
  float ringShadow = 1.0;
  if (abs(uSunObj.y) > 0.002) {
    float sHit = -p.y / uSunObj.y;
    if (sHit > 0.0) {
      vec3 hit = p + uSunObj * sHit;
      ringShadow = 1.0 - ringDensity(length(hit.xz)) * uShadow;
    }
  }

  // ── 光照 ───────────────────────────────────────────
  vec3 toCam = normalize(uCamObj - p);
  float ndl = dot(p, uSunObj);
  float day = smoothstep(-0.06, 0.26, ndl);
  float ndv = clamp(dot(p, toCam), 0.0, 1.0);
  float limb = mix(0.60, 1.0, pow(ndv, 0.32));

  vec3 col = albedo * (0.042 + 0.94 * day) * limb * ringShadow;
  // 环反照的暖色二次照明（集中在赤道）
  col += vec3(0.045, 0.038, 0.026) * ringShadow * day * max(0.0, 1.0 - abs(lat) * 2.2);
  // 极薄的大气边
  float rim = pow(1.0 - ndv, 4.5);
  col += vec3(0.58, 0.55, 0.42) * rim * (0.10 + 0.90 * day) * 0.20;
  col *= mix(1.0, 0.95, polar);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ══════════════════════ 木星 ══════════════════════
   强烈纬向条带（明暗相间 + 边界湍流）+ 多尺度涡旋 fbm
   大红斑：旋转坐标下的椭圆域扭曲 → 风暴眼墙（内暗外亮的环流）+ 外围螺旋卷云
*/
const JUPITER_FRAG = /* glsl */ `
uniform vec3  uSunObj;
uniform vec3  uCamObj;
uniform float uGrsLon;      // 大红斑经度
uniform float uGrsLat;      // 大红斑纬度
uniform float uGrsAmt;      // 大红斑强度 0..1
varying vec3  vObj;
${GLSL_COMMON}

void main(){
  vec3 p = normalize(vObj);
  float lat = p.y;
  float lon = atan(p.z, p.x);

  // ── 多尺度纬向湍流：把噪声在 y 方向压缩 → 东西向拉长的条带 ──
  float t1 = fbm(vec3(p.x * 1.75, p.y * 5.6, p.z * 1.75));
  float t2 = fbm3(vec3(p.x * 3.6, p.y * 13.5, p.z * 3.6));
  float t3 = fbm3(vec3(p.x * 7.2, p.y * 30.0, p.z * 7.2));

  // 纬度被低频湍流扭曲 → 带边界起伏、拉丝
  float latW = lat + (t1 - 0.5) * 0.085 + (t2 - 0.5) * 0.030;
  float m1 = smoothstep(-0.35, 0.35, sin(latW * 20.0 + t2 * 5.0));
  float m2 = smoothstep(-0.30, 0.30, sin(latW * 54.0 + t1 * 9.0 + t3 * 4.0));
  float m3 = smoothstep(-0.20, 0.20, sin(latW * 118.0 + t3 * 16.0));

  vec3 cZone    = vec3(0.84, 0.78, 0.66);
  vec3 cZone2   = vec3(0.86, 0.81, 0.70);
  vec3 cBelt    = vec3(0.46, 0.31, 0.20);
  vec3 cBeltDk  = vec3(0.30, 0.195, 0.13);
  vec3 cPolar   = vec3(0.39, 0.395, 0.42);

  vec3 albedo = mix(cBelt, cZone, m1);
  albedo = mix(albedo, cZone2, m2 * 0.34);
  // 暗带里再叠一层细条
  albedo = mix(albedo, cBeltDk, (1.0 - m1) * (0.35 + 0.30 * (1.0 - m2)) * smoothstep(0.25, 0.80, t3));
  // 带边界的亮丝/暗丝（湍流最活跃的地方）
  float edgeCoord = (m1 - 0.5) / 0.16;
  float edge = exp(-edgeCoord * edgeCoord);
  albedo = mix(albedo, cZone * 0.98, edge * smoothstep(0.45, 0.85, t2) * 0.32);
  // 极区
  albedo = mix(albedo, cPolar, smoothstep(0.55, 0.95, abs(lat) + (t1 - 0.5) * 0.14) * 0.62);
  // 小尺度白色卵形涡旋
  float oval = smoothstep(0.70, 0.82, fbm3(vec3(p.x * 5.2, p.y * 13.0, p.z * 5.2) + vec3(11.0)));
  albedo = mix(albedo, vec3(0.87, 0.85, 0.79), oval * 0.42);
  // 极细带
  albedo *= 0.94 + 0.10 * m3;

  // ── 大红斑 ─────────────────────────────────────────
  float dlon = mod(lon - uGrsLon + 3.14159265, 6.28318530) - 3.14159265;
  vec2 qc = vec2(dlon / 0.40, (lat - uGrsLat) / 0.135);
  // 长轴略微倾斜的椭圆域
  float ca = 0.985, sa = 0.174;
  vec2 q = vec2(ca * qc.x - sa * qc.y, sa * qc.x + ca * qc.y);
  float d = length(q);
  float th = atan(q.y, q.x);

  // 域扭曲：让椭圆边界不规则
  float warp = fbm(vec3(q * 2.3, 7.0)) - 0.5;
  float dd = clamp(d * (1.0 + warp * 0.30), 0.0, 4.0);
  // 卷云相位（顺着环流旋进来的螺旋）
  float spin = 0.5 + 0.5 * sin(th * 3.0 - log(dd + 0.07) * 6.0 + t2 * 7.0);

  vec3 spot = vec3(0.50, 0.21, 0.12);
  spot = mix(vec3(0.295, 0.115, 0.075), spot, smoothstep(0.10, 0.60, dd));      // 中心暗
  spot = mix(spot, vec3(0.62, 0.39, 0.24), smoothstep(0.55, 0.78, dd) * 0.55);  // 中层过渡
  float wall = smoothstep(0.60, 0.72, dd) * (1.0 - smoothstep(0.86, 0.99, dd)); // 眼墙
  spot = mix(spot, vec3(0.84, 0.68, 0.48), wall * 0.85);                        // 亮环
  spot *= 0.88 + 0.12 * spin;

  float grs = (1.0 - smoothstep(0.90, 1.10, dd)) * uGrsAmt;
  albedo = mix(albedo, spot, grs);

  // 外围螺旋卷云
  float arms = smoothstep(1.02, 1.45, dd) * (1.0 - smoothstep(1.75, 2.15, dd)) * uGrsAmt;
  float sp = 0.5 + 0.5 * sin(th * 2.0 + log(dd + 0.20) * 5.0 - t2 * 5.0);
  albedo = mix(albedo, vec3(0.78, 0.64, 0.48), arms * sp * 0.28);

  // ── 光照 ───────────────────────────────────────────
  vec3 toCam = normalize(uCamObj - p);
  float ndl = dot(p, uSunObj);
  float day = smoothstep(-0.06, 0.26, ndl);
  float ndv = clamp(dot(p, toCam), 0.0, 1.0);
  float limb = mix(0.74, 1.0, pow(ndv, 0.30));

  vec3 col = albedo * (0.040 + 0.95 * day) * limb;
  float rim = pow(1.0 - ndv, 4.0);
  col += vec3(0.62, 0.56, 0.44) * rim * (0.12 + 0.88 * day) * 0.16;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ══════════════════════ 地球 ══════════════════════
   大陆/海洋/云 + 夜侧零星城市灯 + 大气边缘散射薄亮线
*/
const EARTH_FRAG = /* glsl */ `
uniform vec3  uSunObj;
uniform vec3  uCamObj;
uniform float uTime;
varying vec3  vObj;
${GLSL_COMMON}

void main(){
  vec3 p = normalize(vObj);
  float lat = p.y;
  float alat = abs(lat);

  // ── 大陆：域扭曲 fbm，海岸线再叠高频细节 ──────────
  float w = fbm(p * 2.15 + vec3(3.0));
  vec3  q = p * 2.55 + vec3(w * 0.62, w * 0.38, w * 0.52);
  float cont = fbm(q + vec3(7.0));
  float det  = fbm3(p * 7.5 + vec3(1.3));
  float det2 = fbm3(p * 18.0 + vec3(9.0));
  float h = cont * 0.78 + det * 0.17 + det2 * 0.05;

  float land  = smoothstep(0.545, 0.575, h);
  float shelf = (1.0 - land) * smoothstep(0.470, 0.548, h);
  float coastD = (h - 0.560) / 0.030;
  float coast = exp(-coastD * coastD);

  // ── 陆地配色：森林/草原/沙漠/岩石 ────────────────
  float db = (alat - 0.42) / 0.20;
  float aridBand = exp(-db * db);
  float dryness = smoothstep(0.42, 0.62, fbm3(p * 3.9 + vec3(17.0)));
  float arid = clamp(aridBand * (0.35 + 1.05 * dryness), 0.0, 1.0);

  vec3 forest = vec3(0.045, 0.135, 0.050);
  vec3 grass  = vec3(0.125, 0.225, 0.080);
  vec3 desert = vec3(0.400, 0.310, 0.155);
  vec3 rock   = vec3(0.165, 0.148, 0.128);
  vec3 landCol = mix(forest, grass, smoothstep(0.30, 0.72, det));
  landCol = mix(landCol, desert, arid * 0.90);
  float mtn = smoothstep(0.63, 0.82, h + (det - 0.5) * 0.20);
  landCol = mix(landCol, rock, mtn * 0.75);

  // ── 海洋：深水/陆架 + 涡流细节 ───────────────────
  vec3 deep = vec3(0.012, 0.035, 0.105);
  vec3 shal = vec3(0.030, 0.150, 0.235);
  vec3 ocean = mix(deep, shal, shelf);
  ocean += vec3(0.010, 0.026, 0.040) * smoothstep(0.55, 0.82, det2);

  // ── 极冠 ────────────────────────────────────────
  float iceN = smoothstep(0.880, 0.955, alat + (det - 0.5) * 0.09);
  iceN = max(iceN, smoothstep(0.905, 0.975, alat));
  iceN *= 0.72 + 0.28 * smoothstep(0.30, 0.70, det);

  vec3 albedo = mix(ocean, landCol, land);
  albedo = mix(albedo, vec3(0.70, 0.77, 0.84), iceN);

  // ── 云层（同 shader 内合成，省一个球壳 draw call）──
  float cw = fbm(p * 2.7 + vec3(uTime * 0.0022));
  vec3  cq = p * 3.3 + vec3(cw * 0.95, cw * 0.45, cw * 0.72) + vec3(0.0, uTime * 0.0012, 0.0);
  float cl = fbm(cq + vec3(4.0)) * 0.70
           + fbm3(p * 11.0 + vec3(2.0)) * 0.20
           + fbm3(p * 23.0 + vec3(6.0)) * 0.10;
  float cov = smoothstep(0.525, 0.630, cl);
  cov *= 0.62 + 0.38 * sin(lat * 10.0 + cl * 4.0);   // 赤道辐合带 / 中纬风暴带
  cov = clamp(cov, 0.0, 1.0);
  albedo = mix(albedo, vec3(0.80, 0.83, 0.87), cov * 0.82);

  // ── 光照 ────────────────────────────────────────
  vec3 toCam = normalize(uCamObj - p);
  float ndl = dot(p, uSunObj);
  float day = smoothstep(-0.05, 0.28, ndl);
  float night = 1.0 - smoothstep(-0.20, 0.06, ndl);
  float ndv = clamp(dot(p, toCam), 0.0, 1.0);

  vec3 sunCol = vec3(1.0, 0.96, 0.90);
  vec3 col = albedo * sunCol * (0.030 + 0.97 * day);

  // 海面窄高光（打碎成小块，避免整片死白）
  vec3 hv = normalize(uSunObj + toCam + vec3(1e-4, 2e-4, 1e-4));
  float ndh = max(dot(p, hv), 0.0);
  float glint = pow(ndh, 220.0) * (1.0 - land) * (1.0 - iceN)
              * smoothstep(0.10, 0.80, pow(1.0 - ndv, 3.0))
              * smoothstep(-0.03, 0.22, ndl);
  glint *= 0.40 + 0.60 * smoothstep(0.44, 0.76, fbm3(p * 34.0 + vec3(9.0)));
  col += sunCol * glint * 0.38;

  // ── 夜侧城市灯：高频散点 × 簇状分布 × 沿海/平原 ──
  float cn = fbm3(p * 25.0 + vec3(5.0, 2.0, 9.0));
  float cluster = smoothstep(0.50, 0.68, cn);
  float speck  = smoothstep(0.74, 0.92, vnoise(p * 165.0 + vec3(11.0)));
  float speck2 = smoothstep(0.78, 0.94, vnoise(p * 320.0 + vec3(31.0))) * 0.55;
  float popGeo = 0.34 + 0.66 * coast;
  float pop = cluster * cluster * popGeo * land * (1.0 - smoothstep(0.52, 0.90, alat));
  float lights = pop * (0.20 + 0.80 * max(speck, speck2)) * night;
  col += vec3(1.0, 0.56, 0.20) * lights * 0.62;

  // ── 大气边缘散射：只留一条薄的亮线 + 晨昏线暖色 ──
  float rim = pow(1.0 - ndv, 4.5);
  col += vec3(0.28, 0.48, 0.86) * rim * (0.16 + 0.84 * smoothstep(-0.10, 0.45, ndl)) * 0.55;
  float tt = (ndl - 0.02) / 0.09;
  col += vec3(0.95, 0.36, 0.10) * exp(-tt * tt) * 0.12 * (0.30 + 0.70 * rim);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ══════════════════════ 火星 ══════════════════════
   铁锈红基底 + 暗色反照率区 + 极冠 + 水手号峡谷 + 撞击坑（噪声浮雕 bump）
*/
const MARS_FRAG = /* glsl */ `
uniform vec3  uSunObj;
uniform vec3  uCamObj;
uniform vec3  uCanyonNormal;   // 峡谷所在大圆平面的法线（物体空间）
uniform vec3  uCanyonAlong;    // 峡谷走向（物体空间，垂直于法线）
varying vec3  vObj;
${GLSL_COMMON}

// 高度场：山脊 - 低洼 - 峡谷（单位球上直接采样，供有限差分求梯度用）
float marsRelief(vec3 p){
  float n1 = vnoise(p * 6.0 + vec3(2.0));
  float n2 = vnoise(p * 17.0 + vec3(5.0));
  float ridge = 1.0 - abs(n1 * 2.0 - 1.0);
  float c = dot(p, uCanyonNormal);
  float rift = exp(-(c / 0.050) * (c / 0.050));
  return ridge * 0.50 + n2 * 0.18 - rift * 1.30;
}

void main(){
  vec3 p = normalize(vObj);
  float lat = p.y;
  float alat = abs(lat);

  // ── 峡谷：大圆窄带 × 长度窗口（只保留一段，不是整圈） ──
  float cCoord = dot(p, uCanyonNormal);
  float arc = dot(p, uCanyonAlong);   // 峡谷中点为 arc=0，两端为 ±1
  float lenMask = smoothstep(-0.72, -0.42, arc) * (1.0 - smoothstep(0.42, 0.72, arc));

  // ── 地形浮雕（三点采样求切空间梯度，扰动法线做环形高光/阴影） ──
  vec3 upRef = abs(p.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tu = normalize(cross(p, upRef));
  vec3 tv = cross(p, tu);
  float eps = 0.008;
  float h0 = marsRelief(p);
  float h1 = marsRelief(normalize(p + tu * eps));
  float h2 = marsRelief(normalize(p + tv * eps));
  vec3 grad = tu * ((h1 - h0) / eps) + tv * ((h2 - h0) / eps);
  vec3 nPert = normalize(p - grad * 0.0075);

  // ── 反照率 ──────────────────────────────────────
  float n1 = fbm(p * 2.6 + vec3(1.0));
  float n2 = fbm3(p * 6.0 + vec3(4.0));
  float n3 = fbm3(p * 22.0 + vec3(8.0));

  vec3 rust  = vec3(0.470, 0.215, 0.105);
  vec3 rust2 = vec3(0.575, 0.300, 0.155);
  vec3 dark  = vec3(0.215, 0.115, 0.075);
  vec3 albedo = mix(rust, rust2, smoothstep(0.28, 0.78, n1));

  // 暗色反照率区（大流纹岩省）
  float darkRegion = smoothstep(0.52, 0.72, fbm3(p * 2.1 + vec3(21.0)));
  albedo = mix(albedo, dark, darkRegion * 0.70);
  // 沙尘亮纹
  albedo = mix(albedo, vec3(0.62, 0.40, 0.25), smoothstep(0.62, 0.85, n2) * 0.20);
  // 坑洼内部略暗
  albedo *= 0.90 + 0.10 * smoothstep(0.30, 0.70, n3);

  // 峡谷：谷底暗、谷缘亮
  float cw = 0.050 * (0.72 + 0.55 * n2);
  float rift = exp(-(cCoord / cw) * (cCoord / cw)) * lenMask;
  albedo = mix(albedo, vec3(0.125, 0.062, 0.042), rift * 0.90);
  albedo = mix(albedo, vec3(0.64, 0.40, 0.22), smoothstep(0.62, 0.88, n3) * lenMask * 0.26);

  // 极冠（边缘被噪声打碎）
  float capN = (n2 - 0.5) * 0.10;
  float north = smoothstep(0.840, 0.940, lat + capN);
  float south = smoothstep(0.860, 0.950, -lat + capN);
  float cap = clamp(max(north, south), 0.0, 1.0);
  vec3 capCol = mix(vec3(0.70, 0.73, 0.77), vec3(0.82, 0.845, 0.87), smoothstep(0.0, 0.6, cap));
  albedo = mix(albedo, capCol, cap);

  // ── 光照（用扰动的法线，让峡谷/撞击坑有立体感） ──
  vec3 toCam = normalize(uCamObj - p);
  float ndl = dot(nPert, uSunObj);
  float ndv = clamp(dot(p, toCam), 0.0, 1.0);
  float day = smoothstep(-0.05, 0.25, ndl);
  vec3 sunCol = vec3(1.0, 0.94, 0.86);
  vec3 col = albedo * sunCol * (0.030 + 0.96 * day);

  // 尘霾薄边 + 晨昏线暖色
  float rim = pow(1.0 - ndv, 3.6);
  col += vec3(0.85, 0.42, 0.20) * rim * (0.14 + 0.86 * day) * 0.28;
  float tt = (ndl - 0.02) / 0.10;
  col += vec3(0.95, 0.45, 0.18) * exp(-tt * tt) * 0.09;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ══════════════════════ 土星环 ══════════════════════
   径向分层（C 环暗淡 / B 环最亮 / Cassini 缝 / A 环 / Encke 缝 / F 环细线）
   + 径向细密条纹 + 内外边缘渐隐 + 行星投在环上的阴影
*/
const RING_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vNW;
void main(){
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3  uSunDir;         // 世界空间：星球 -> 太阳
uniform vec3  uPlanetCenter;   // 世界空间：行星中心
uniform float uPlanetRadius;   // 世界单位
varying vec3  vLocal;
varying vec3  vWorld;
varying vec3  vNW;
${GLSL_COMMON}

float ringDensity(float rr){
  float dens = 0.0;
  dens += smoothstep(1.13, 1.19, rr) * (1.0 - smoothstep(1.45, 1.49, rr)) * 0.30;
  dens += smoothstep(1.49, 1.52, rr) * (1.0 - smoothstep(1.92, 1.95, rr)) * 0.95;
  dens += smoothstep(2.03, 2.06, rr) * (1.0 - smoothstep(2.25, 2.29, rr)) * 0.62;
  dens += smoothstep(2.320, 2.330, rr) * (1.0 - smoothstep(2.335, 2.345, rr)) * 0.34;
  float cassini = smoothstep(1.950, 1.972, rr) * (1.0 - smoothstep(2.014, 2.036, rr));
  float encke = smoothstep(2.201, 2.207, rr) * (1.0 - smoothstep(2.213, 2.219, rr));
  dens *= 1.0 - cassini * 0.96;
  dens *= 1.0 - encke * 0.86;
  dens *= 0.74 + 0.26 * sin(rr * 315.0 + sin(rr * 41.0) * 1.8);
  dens *= 0.84 + 0.16 * vnoise(vec3(rr * 165.0, 3.7, 1.3));
  return clamp(dens, 0.0, 1.0);
}

void main(){
  float rr = length(vLocal.xy);
  float dens = ringDensity(rr);
  if (dens < 0.002) discard;

  // 分区配色：C 环灰褐 / B 环奶油 / A 环浅金
  float cW = smoothstep(1.13, 1.19, rr) * (1.0 - smoothstep(1.45, 1.49, rr));
  float bW = smoothstep(1.49, 1.52, rr) * (1.0 - smoothstep(1.92, 1.95, rr));
  float aW = smoothstep(2.03, 2.06, rr) * (1.0 - smoothstep(2.25, 2.29, rr));
  vec3 col = vec3(0.24, 0.225, 0.195);
  col = mix(col, vec3(0.55, 0.500, 0.400), clamp(cW, 0.0, 1.0));
  col = mix(col, vec3(0.82, 0.760, 0.620), clamp(bW, 0.0, 1.0));
  col = mix(col, vec3(0.66, 0.600, 0.500), clamp(aW, 0.0, 1.0));

  // 径向细纹的明暗起伏
  float fine = 0.5 + 0.5 * sin(rr * 210.0 + sin(rr * 29.0) * 2.4);
  col *= 0.86 + 0.14 * fine;

  // 光照：环面与太阳的夹角（掠射），背面转暗
  vec3 n = normalize(vNW);
  float sunUp = abs(dot(n, uSunDir));
  float lit = 0.28 + 0.72 * smoothstep(0.02, 0.52, sunUp);

  // 行星投在环上的阴影
  vec3 rel = vWorld - uPlanetCenter;
  float along = dot(rel, uSunDir);
  float perp = length(rel - uSunDir * along);
  float shadow = smoothstep(0.0, uPlanetRadius * 0.55, -along)
               * (1.0 - smoothstep(uPlanetRadius * 0.90, uPlanetRadius * 1.12, perp));
  lit *= 1.0 - shadow * 0.93;

  float t = clamp((rr - 1.13) / (2.36 - 1.13), 0.0, 1.0);
  float facing = gl_FrontFacing ? 1.0 : 0.62;
  float alpha = dens * lit * facing * mix(0.92, 0.52, t);
  gl_FragColor = vec4(col * lit, clamp(alpha, 0.0, 1.0));
}
`;

/* ══════════════════════ 土星小卫星 ══════════════════════ */
const MOON_VERT = /* glsl */ `
varying vec3 vNW;
varying vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const MOON_FRAG = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uColor;
uniform vec3  uRimColor;
varying vec3  vNW;
varying vec3  vWorld;
void main(){
  vec3 n = normalize(vNW);
  float ndl = dot(n, uSunDir);
  float day = smoothstep(-0.12, 0.30, ndl);
  vec3 col = uColor * (0.020 + 0.95 * day);
  vec3 toCam = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - clamp(dot(n, toCam), 0.0, 1.0), 3.0);
  col += uRimColor * rim * day * 0.12;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ══════════════════════ 深空背景 ══════════════════════ */
const STAR_VERT = /* glsl */ `
attribute vec3  aColor;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixel;
varying vec3  vColor;
varying float vTw;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vTw = 0.82 + 0.18 * sin(uTime * 1.7 + aPhase * 6.2831);
  vColor = aColor;
  gl_PointSize = aSize * uPixel;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vTw;
void main(){
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  float core = 1.0 - smoothstep(0.05, 0.5, d);
  float a = core * core * 0.85 + core * 0.15;
  gl_FragColor = vec4(vColor * vTw * a, a);
}
`;

const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAG = /* glsl */ `
uniform vec3 uGalNormal;
varying vec3 vDir;
${GLSL_COMMON}
void main(){
  vec3 d = normalize(vDir);
  float bd = dot(d, uGalNormal) / 0.22;
  float band = exp(-bd * bd);
  float n1 = fbm(d * 2.6 + vec3(3.0));
  float n2 = fbm3(d * 6.0 + vec3(9.0));
  float n3 = fbm3(d * 14.0 + vec3(1.0));
  float cloud = smoothstep(0.40, 0.86, n1 * 0.70 + n2 * 0.30);
  vec3 col = mix(vec3(0.018, 0.028, 0.065), vec3(0.050, 0.032, 0.072), n2);
  col = mix(col, vec3(0.070, 0.050, 0.042), n3 * 0.50);
  col += vec3(0.028, 0.032, 0.052) * band * (0.40 + 0.60 * cloud);
  float a = 0.15 * (0.35 + 0.65 * cloud) + 0.10 * band;
  gl_FragColor = vec4(col * (0.55 + 0.75 * band + 0.55 * cloud), clamp(a, 0.0, 0.30));
}
`;

/* ════════════════════════════════════════════════════════════════════════
   星球数据
   radius 全部归一化（土星/木星/地球 = 1，火星略小），机位距离以 R 为单位
   camDist 为默认机位；spin 为自转角速度（rad/s，展示用慢速）
   ════════════════════════════════════════════════════════════════════════ */
const BODY_DEFS = [
  {
    id: 'saturn',
    cn: '土星',
    en: 'Saturn',
    radius: 1.0,
    camDist: 5.5,
    baseYaw: 0.34,
    basePitch: 0.36,
    spin: 0.038,
    spin0: 0.15,
    tiltX: 26.7,
    tiltZ: 0,
    desc: '土星是太阳系第二大行星，平均密度只有 0.687 g/cm³，比水还轻——如果有一片足够大的海洋，它会浮起来。标志性的环系由数以千亿计的冰粒与岩屑组成，平均厚度却只有约十米，宽度接近 30 万公里。',
    stats: [
      { k: '直径', v: '116 460 km（地球的 9.14 倍）' },
      { k: '公转周期', v: '10 759 天 ≈ 29.5 地球年' },
      { k: '自转周期', v: '10 小时 33 分' },
      { k: '表面温度', v: '约 −178 ℃（云顶）' },
      { k: '趣味点', v: 'B 环最亮处几乎不透明；Cassini 缝宽约 4 800 km，由土卫一的轨道共振清空' },
    ],
  },
  {
    id: 'jupiter',
    cn: '木星',
    en: 'Jupiter',
    radius: 1.0,
    camDist: 3.35,
    baseYaw: 0.28,
    basePitch: 0.18,
    spin: 0.032,
    // 打开时让大红斑大致朝向镜头：面朝相机的点在本体空间的经度 = (π/2 − baseYaw) + spin0，
    // 令其等于 GRS_LON → spin0 = GRS_LON − π/2 + baseYaw
    spin0: GRS_LON - Math.PI / 2 + 0.28,
    tiltX: 3.1,
    tiltZ: 0,
    desc: '木星的质量是其余七颗行星总和的 2.5 倍，是名副其实的气态巨人之王。明暗相间的纬向云带由时速 500 公里的喷流雕刻而成；大红斑是一场至少持续了 350 年的反气旋风暴，宽度可以并排放进一个多地球。',
    stats: [
      { k: '直径', v: '139 820 km（地球的 11.21 倍）' },
      { k: '公转周期', v: '4 333 天 ≈ 11.86 地球年' },
      { k: '自转周期', v: '9 小时 56 分（太阳系最快）' },
      { k: '表面温度', v: '约 −145 ℃（云顶）' },
      { k: '趣味点', v: '大红斑边缘风速可达 430 km/h，约 3.5 天完成一次自转' },
    ],
  },
  {
    id: 'earth',
    cn: '地球',
    en: 'Earth',
    radius: 1.0,
    camDist: 3.15,
    baseYaw: 0.36,
    basePitch: 0.14,
    spin: 0.045,
    spin0: 0.9,
    tiltX: 23.44,
    tiltZ: 0,
    desc: '地球是目前已知唯一拥有液态水海洋与生命的世界。液态水覆盖 71% 的表面，大气中 21% 的氧气靠生物光合作用维持。夜侧零星的暖色灯点是人类文明最直观的痕迹，也是从轨道上最先认出的地球特征。',
    stats: [
      { k: '直径', v: '12 742 km' },
      { k: '公转周期', v: '365.256 天' },
      { k: '自转周期', v: '23 小时 56 分 4 秒' },
      { k: '表面温度', v: '平均 15 ℃（−89 ~ 58 ℃）' },
      { k: '趣味点', v: '从月球看地球，海面反光的亮度足以照亮月球夜晚的地平线' },
    ],
  },
  {
    id: 'mars',
    cn: '火星',
    en: 'Mars',
    radius: 0.86,
    camDist: 2.75,
    baseYaw: 0.32,
    basePitch: 0.22,
    spin: 0.022,
    spin0: 0.4,
    tiltX: 25.2,
    tiltZ: 0,
    desc: '火星表面被氧化铁染成铁锈色，因此被称为红色星球。它拥有太阳系最高的火山奥林帕斯山（约 22 km）与最长的峡谷水手号峡谷（长 4 000 km、深达 7 km）；极冠的二氧化碳与冰随季节消长，是火星最明显的时间刻度。',
    stats: [
      { k: '直径', v: '6 779 km（地球的 0.53 倍）' },
      { k: '公转周期', v: '687 天 ≈ 1.88 地球年' },
      { k: '自转周期', v: '24 小时 37 分' },
      { k: '表面温度', v: '平均 −63 ℃（−143 ~ 35 ℃）' },
      { k: '趣味点', v: '水手号峡谷若横跨地球，能从纽约一直延伸到洛杉矶' },
    ],
  },
];

/* ════════════════════════════════════════════════════════════════════════
   createPlanetarium
   ════════════════════════════════════════════════════════════════════════ */
export function createPlanetarium(opts = {}) {
  const { renderer = null, quality = 'high' } = opts;
  const high = quality !== 'low';

  const scene = new THREE.Scene();
  scene.name = 'planetarium';
  // 深空底色：极暗蓝黑，避免后期管线清屏色不一致时露出灰底
  scene.background = new THREE.Color(0x02030a);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.02, 5000);
  camera.position.set(0, 1.9, 5.1);
  camera.lookAt(0, 0, 0);

  const root = new THREE.Group();
  root.name = 'planetarium-root';
  scene.add(root);

  const _size = new THREE.Vector2(1, 1);
  const _q = new THREE.Quaternion();
  const _v = new THREE.Vector3();

  // 共享 uniform 对象（多个材质可共用同一个引用，省去逐帧多处赋值）
  const uTime = { value: 0 };
  const uPixel = { value: renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 1 };

  /* ── 深空背景 ─────────────────────────────────────── */
  const stars = buildStars(high ? 6500 : 4500, uTime, uPixel);
  root.add(stars);
  const nebula = buildNebula();
  root.add(nebula);

  /* ── 星球 ─────────────────────────────────────────── */
  const stage = new THREE.Group();
  stage.name = 'planetarium-stage';
  root.add(stage);

  // 4 颗球共享同一份高细分几何（三角面只算一次，切换零成本）
  const sphereGeo = new THREE.SphereGeometry(1, high ? 176 : 128, high ? 112 : 96);
  const moonGeo = new THREE.SphereGeometry(1, 20, 14);

  const bodies = BODY_DEFS.map((d) => ({
    id: d.id,
    cn: d.cn,
    en: d.en,
    desc: d.desc,
    stats: d.stats.map((s) => ({ k: s.k, v: s.v })),
    radius: d.radius,
    camDist: d.camDist,
    spin: d.spin,
  }));

  const planets = [];   // { mesh, holder, uSunObj, uCamObj }
  const holders = [];
  const spinAngles = BODY_DEFS.map((d) => d.spin0 || 0);

  let ringMesh = null;
  let ringU = null;
  const moons = [];

  for (let i = 0; i < BODY_DEFS.length; i++) {
    const d = BODY_DEFS[i];

    const holder = new THREE.Group();
    holder.name = 'body-' + d.id;
    stage.add(holder);
    holders.push(holder);

    const tilt = new THREE.Group();
    tilt.rotation.x = d.tiltX * DEG;
    tilt.rotation.z = d.tiltZ * DEG;
    holder.add(tilt);

    const uSunObj = { value: new THREE.Vector3(0, 0, 1) };
    const uCamObj = { value: new THREE.Vector3(0, 0, 8) };
    let mat;

    if (d.id === 'saturn') {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uSunObj,
          uCamObj,
          uShadow: { value: 0.88 },
        },
        vertexShader: SPHERE_VERT,
        fragmentShader: SATURN_FRAG,
      });

      // 环（和行星同一倾斜组，赤道面内）
      ringU = {
        uSunDir: { value: SUN_DIR },
        uPlanetCenter: { value: new THREE.Vector3(0, 0, 0) },
        uPlanetRadius: { value: d.radius },
      };
      const ringGeo = new THREE.RingGeometry(1.13, 2.36, high ? 320 : 200, 4);
      ringMesh = new THREE.Mesh(
        ringGeo,
        new THREE.ShaderMaterial({
          uniforms: ringU,
          vertexShader: RING_VERT,
          fragmentShader: RING_FRAG,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ringMesh.name = 'saturn-ring';
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.scale.setScalar(d.radius);
      ringMesh.renderOrder = 2;
      tilt.add(ringMesh);

      // 2~3 颗小卫星（球 + 轨道）。距离压在环外侧近处，保证 5.5R 机位下不被画幅裁掉
      const MOONS = [
        { name: 'Titan', dist: 2.52, radius: 0.055, speed: 0.16, phase: 0.4, inc: 0.05, color3: [0.50, 0.37, 0.23] },
        { name: 'Rhea', dist: 2.86, radius: 0.040, speed: 0.115, phase: 2.1, inc: 0.08, color3: [0.42, 0.40, 0.37] },
        { name: 'Enceladus', dist: 3.18, radius: 0.031, speed: 0.085, phase: 4.3, inc: 0.12, color3: [0.66, 0.70, 0.74] },
      ];
      for (const mc of MOONS) {
        const mm = new THREE.Mesh(
          moonGeo,
          new THREE.ShaderMaterial({
            uniforms: {
              uSunDir: { value: SUN_DIR },
              uColor: { value: new THREE.Vector3(mc.color3[0], mc.color3[1], mc.color3[2]) },
              uRimColor: { value: new THREE.Vector3(0.55, 0.52, 0.46) },
            },
            vertexShader: MOON_VERT,
            fragmentShader: MOON_FRAG,
          })
        );
        mm.name = 'moon-' + mc.name;
        mm.scale.setScalar(mc.radius * d.radius);
        tilt.add(mm);
        moons.push({
          mesh: mm,
          dist: mc.dist * d.radius,
          radius: mc.radius,
          speed: mc.speed,
          phase: mc.phase,
          inc: mc.inc,
        });
      }
    } else if (d.id === 'jupiter') {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uSunObj,
          uCamObj,
          uGrsLon: { value: GRS_LON },
          uGrsLat: { value: -0.335 },
          uGrsAmt: { value: 1.0 },
        },
        vertexShader: SPHERE_VERT,
        fragmentShader: JUPITER_FRAG,
      });
    } else if (d.id === 'earth') {
      mat = new THREE.ShaderMaterial({
        uniforms: { uSunObj, uCamObj, uTime },
        vertexShader: SPHERE_VERT,
        fragmentShader: EARTH_FRAG,
      });
    } else {
      // mars：峡谷大圆法线 + 走向
      // 走向取「垂直于法线且垂直于打开时相机方向」→ 峡谷中点正对镜头
      const cn = new THREE.Vector3(0.40, 0.87, -0.18).normalize();
      const cp0 = Math.cos(d.basePitch);
      const camDir = new THREE.Vector3(
        Math.sin(d.baseYaw) * cp0,
        Math.sin(d.basePitch),
        Math.cos(d.baseYaw) * cp0
      ).normalize();
      const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), d.tiltX * DEG);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.spin0 || 0);
      const qWorld = new THREE.Quaternion().multiplyQuaternions(qTilt, qSpin).invert();
      const camLocal = camDir.applyQuaternion(qWorld).normalize();
      let along = new THREE.Vector3().crossVectors(camLocal, cn);
      if (along.lengthSq() < 1e-6) along.set(1, 0, 0);
      along.normalize();
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uSunObj,
          uCamObj,
          uCanyonNormal: { value: cn },
          uCanyonAlong: { value: along },
        },
        vertexShader: SPHERE_VERT,
        fragmentShader: MARS_FRAG,
      });
    }

    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.name = 'planet-' + d.id;
    mesh.scale.setScalar(d.radius);
    mesh.rotation.y = spinAngles[i];
    tilt.add(mesh);

    planets.push({ mesh, holder, uSunObj, uCamObj });
  }

  /* ── 视角状态 ─────────────────────────────────────── */
  let isOpen = false;
  let currentIndex = 0;
  let disposed = false;
  let lastT = 0;

  let orbitYaw = BODY_DEFS[0].baseYaw;
  let orbitPitch = BODY_DEFS[0].basePitch;
  let autoYaw = 0;
  let dist = BODY_DEFS[0].camDist;
  let targetDist = BODY_DEFS[0].camDist;
  let idleTime = 0;

  holders.forEach((h, i) => { h.visible = i === 0; });

  /* ── 内部工具 ─────────────────────────────────────── */
  function applyCamera() {
    const cp = Math.cos(orbitPitch);
    const sp = Math.sin(orbitPitch);
    const y = orbitYaw + autoYaw;
    camera.position.set(Math.sin(y) * cp * dist, sp * dist, Math.cos(y) * cp * dist);
    camera.lookAt(0, 0, 0);
  }

  /** 把世界空间的太阳方向 / 相机位置反变换到每颗星的物体空间 */
  function syncUniforms() {
    for (let i = 0; i < planets.length; i++) {
      const P = planets[i];
      P.mesh.getWorldQuaternion(_q);
      _q.invert();
      P.uSunObj.value.copy(SUN_DIR).applyQuaternion(_q);
      P.uCamObj.value.copy(camera.position);
      P.mesh.worldToLocal(P.uCamObj.value);
    }
  }

  function updateMoons(t) {
    for (let i = 0; i < moons.length; i++) {
      const m = moons[i];
      const a = t * m.speed + m.phase;
      m.mesh.position.set(
        Math.cos(a) * m.dist,
        Math.sin(a * 1.7) * m.inc * m.dist,
        Math.sin(a) * m.dist
      );
      m.mesh.rotation.y = a * 1.7;
      m.mesh.rotation.x = a * 0.6;
    }
  }

  /* ── 每帧更新 ─────────────────────────────────────── */
  function update(dt, t, input) {
    if (disposed) return;

    const step = clamp(num(dt), 0, 0.05);
    const time = Number.isFinite(t) ? t : lastT;
    lastT = time;
    uTime.value = time;

    // 相机宽高比跟随渲染器
    if (renderer) {
      if (renderer.getPixelRatio) uPixel.value = renderer.getPixelRatio();
      if (renderer.getSize) {
        const sz = renderer.getSize(_size) || _size;
        if (sz.y > 0) {
          const aspect = sz.x / sz.y;
          if (Math.abs(aspect - camera.aspect) > 1e-4) {
            camera.aspect = aspect;
            camera.updateProjectionMatrix();
          }
        }
      }
    }

    const body = bodies[currentIndex];
    const R = body.radius;
    const inp = input || EMPTY_INPUT;

    const dx = num(inp.dragX);
    const dy = num(inp.dragY);
    const dz = num(inp.zoom);
    const moving = Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4;

    if (moving) idleTime = 0;
    else idleTime += step;

    // 环绕角按 drag 累加（drag 为每帧增量；main.js 传的是 pointermove 的像素增量，
    // 与轨道视角的 0.006 / 0.005 rad·px⁻¹ 手感保持一致）
    orbitYaw -= dx * 0.006;
    orbitPitch += dy * 0.005;
    orbitPitch = clamp(orbitPitch, -1.15, 1.15);

    // zoom 亦为每帧增量：正值拉远
    if (Math.abs(dz) > 1e-5) {
      const f = Math.exp(clamp(dz, -0.5, 0.5) * 1.8);
      targetDist = clamp(targetDist * f, R * 1.4, R * 8.0);
    }
    targetDist = clamp(targetDist, R * 1.4, R * 8.0);
    dist += (targetDist - dist) * Math.min(1, step * 6.5);
    dist = clamp(dist, R * 1.4, R * 8.0);

    // 3 秒无操作 → 自动缓慢环绕
    if (inp.auto === true || idleTime > 3.0) {
      autoYaw += step * 0.060;
    }

    // 自转（按星球各自累积，切换后接续）
    spinAngles[currentIndex] += step * body.spin;
    planets[currentIndex].mesh.rotation.y = spinAngles[currentIndex];

    applyCamera();
    updateMoons(time);

    root.updateMatrixWorld(true);
    syncUniforms();

    // 环阴影所需的行星中心（展厅里星球恒在原点，保险起见仍写一次）
    if (ringU) ringU.uPlanetCenter.value.set(0, 0, 0);
  }

  /* ── 打开 / 关闭 / 切换 ───────────────────────────── */
  function open(id, t) {
    if (disposed) return false;
    let idx = -1;
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return false;

    currentIndex = idx;
    isOpen = true;
    lastT = Number.isFinite(t) ? t : lastT;

    const d = BODY_DEFS[idx];
    orbitYaw = d.baseYaw;
    orbitPitch = d.basePitch;
    autoYaw = 0;
    idleTime = 0;
    dist = d.camDist;
    targetDist = d.camDist;

    for (let i = 0; i < holders.length; i++) holders[i].visible = i === idx;

    // 立刻刷新一帧（含相机、uniform、自转姿态）
    update(0, lastT, EMPTY_INPUT);
    return true;
  }

  function close() {
    isOpen = false;
  }

  function stepBody(delta) {
    const n = bodies.length;
    if (!n) return false;
    const idx = ((currentIndex + delta) % n + n) % n;
    return open(bodies[idx].id, lastT);
  }

  function next() { return stepBody(1); }
  function prev() { return stepBody(-1); }

  /** 调试/给 HUD 用：直接设置机位距离（会 clamp 到 1.4R~8R） */
  function setDistance(d) {
    if (disposed) return;
    const R = bodies[currentIndex].radius;
    targetDist = clamp(num(d), R * 1.4, R * 8.0);
    dist = targetDist;
  }

  /* ── 释放 ─────────────────────────────────────────── */
  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(root);
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) {
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    moons.length = 0;
    planets.length = 0;
    holders.length = 0;
    currentIndex = -1;
    isOpen = false;
    ringMesh = null;
    ringU = null;
    scene.clear();
  }

  const api = {
    scene,
    camera,
    bodies,
    open,
    close,
    next,
    prev,
    update,
    dispose,
    setDistance,
    get isOpen() { return isOpen; },
    get current() { return bodies[currentIndex] || null; },
    get index() { return currentIndex; },
    get distance() { return dist; },
    get zoomRatio() { return dist / (bodies[currentIndex] ? bodies[currentIndex].radius : 1); },
    get quality() { return high ? 'high' : 'low'; },
  };

  // 初始横幅：先摆好第 0 颗（土星），即使 Lead 还没调 open 也能正常渲染
  open('saturn', 0);
  isOpen = false;
  return api;
}

/* ════════════════════════════════════════════════════════════════════════
   深空背景生成
   ════════════════════════════════════════════════════════════════════════ */
function buildStars(count, uTime, uPixel) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);

  // 与银河法线正交的一组基，用于沿银道面散布
  const gu = new THREE.Vector3(1, 0, 0).cross(GAL_NORMAL);
  if (gu.lengthSq() < 1e-6) gu.set(0, 0, 1);
  gu.normalize();
  const gv = new THREE.Vector3().crossVectors(GAL_NORMAL, gu).normalize();

  // 色温表：色 + 权重
  const TEMP = [
    [0.58, 0.70, 1.00, 0.12],
    [0.76, 0.85, 1.00, 0.20],
    [0.97, 0.97, 1.00, 0.26],
    [1.00, 0.95, 0.86, 0.24],
    [1.00, 0.81, 0.58, 0.14],
    [1.00, 0.64, 0.42, 0.04],
  ];
  let acc = 0;
  const cum = TEMP.map((t) => (acc += t[3]));

  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

  for (let i = 0; i < count; i++) {
    let dx, dy, dz;
    if (Math.random() < 0.55) {
      // 银河带内
      const th = Math.random() * TAU;
      const off = gauss() * 0.16;
      dx = gu.x * Math.cos(th) + gv.x * Math.sin(th) + GAL_NORMAL.x * off;
      dy = gu.y * Math.cos(th) + gv.y * Math.sin(th) + GAL_NORMAL.y * off;
      dz = gu.z * Math.cos(th) + gv.z * Math.sin(th) + GAL_NORMAL.z * off;
    } else {
      const cz = Math.random() * 2 - 1;
      const ph = Math.random() * TAU;
      const rr = Math.sqrt(Math.max(0, 1 - cz * cz));
      dx = rr * Math.cos(ph);
      dy = cz;
      dz = rr * Math.sin(ph);
    }
    const inv = 1 / Math.max(1e-4, Math.hypot(dx, dy, dz));
    const dist = 900 + Math.random() * 500;
    pos[i * 3] = dx * inv * dist;
    pos[i * 3 + 1] = dy * inv * dist;
    pos[i * 3 + 2] = dz * inv * dist;

    const r = Math.random() * acc;
    let ti = 0;
    while (ti < cum.length - 1 && r > cum[ti]) ti++;
    const tc = TEMP[ti];
    const bright = 0.34 + Math.random() * 0.44;
    col[i * 3] = tc[0] * bright;
    col[i * 3 + 1] = tc[1] * bright;
    col[i * 3 + 2] = tc[2] * bright;

    const s = Math.random();
    size[i] = 0.75 + s * s * 2.3;
    phase[i] = Math.random();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uPixel },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    depthTest: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'planetarium-stars';
  points.frustumCulled = false;
  points.renderOrder = -5;
  return points;
}

function buildNebula() {
  const geo = new THREE.SphereGeometry(1600, 48, 32);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uGalNormal: { value: GAL_NORMAL } },
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'planetarium-nebula';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}
