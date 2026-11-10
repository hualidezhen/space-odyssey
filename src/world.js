// 深空方舟 · 宇宙环境：太阳 / 地球 / 八大行星 / 星海 / 小行星带
// 全部程序化生成（GLSL + Canvas2D 均不依赖外部资源），只 import three。
//
// 对外接口（见 docs/CONTRACT.md）：
//   createWorld(scene, { quality, renderer }) -> {
//     group, update(dt, t), sunPosition, earth:{ center, radius },
//     stationAnchor, bodies, bodyById(id), dispose()
//   }
import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const linear = (r, g, b) => new THREE.Vector3(r, g, b);

/* ════════════════════════════════════════════════════════════════
   GLSL 公共代码
   ════════════════════════════════════════════════════════════════ */

// 值噪声 + fbm（球面 3D 采样，用于所有行星表面）
const GLSL_NOISE = /* glsl */`
float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + vec3(33.33));
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
  p = p * 2.03 + vec3(1.7, 2.3, 0.9);
  s += 0.25 * vnoise(p);
  p = p * 2.01 + vec3(3.1, 1.1, 4.3);
  s += 0.125 * vnoise(p);
  p = p * 1.97 + vec3(5.3, 3.7, 2.1);
  s += 0.0625 * vnoise(p);
  return s / 0.9375;
}
// 3 倍频 fbm，返回 0..1（省算力）
float fbm3(vec3 p){
  float s = 0.55 * vnoise(p);
  p = p * 2.07 + vec3(2.1, 4.3, 1.5);
  s += 0.28 * vnoise(p);
  p = p * 2.03 + vec3(6.7, 1.9, 3.3);
  s += 0.15 * vnoise(p);
  return s / 0.98;
}
`;

// 所有球体共用的顶点着色器
const SPHERE_VERT = /* glsl */`
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
void main(){
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* ── 太阳 ───────────────────────────────────────────── */
const SUN_FRAG = /* glsl */`
uniform float uTime;
uniform float uFlare;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
${GLSL_NOISE}
void main(){
  vec3 p = normalize(vObj);
  vec3 n = normalize(vNW);
  vec3 toCam = normalize(cameraPosition - vWorld);

  // 米粒组织：两层不同尺度的噪声，对比拉大
  float g1 = fbm(p * 15.0 + vec3(uTime * 0.028));
  float g2 = fbm3(p * 40.0 + vec3(uTime * 0.055, 1.0, 0.0));
  float gran = mix(g1, g2, 0.45);

  // 黑子：只在大尺度活动区里出现，成双极群、小而暗
  float belt = smoothstep(0.55, 0.70, fbm(p * 2.2 + vec3(13.0, 5.0, 7.0)));
  // 双极对：沿切向把采样点挪开一点（+eps 防止 p 与轴平行时 normalize(0) 出 NaN）
  vec3 pol = normalize(cross(p, vec3(0.31, 0.77, 0.55)) + vec3(1e-5, 1e-5, 1e-5));
  float pa = fbm3((p + pol * 0.055) * 14.0 + vec3(31.0));
  float pb = fbm3((p - pol * 0.055) * 14.0 + vec3(31.0));
  float spotF = max(smoothstep(0.615, 0.740, pa), smoothstep(0.615, 0.740, pb)) * belt;
  float penumbra = smoothstep(0.18, 0.66, spotF);
  float umbra = smoothstep(0.58, 0.92, spotF);
  // 光斑（faculae）：活动区旁的亮斑
  float fac = smoothstep(0.62, 0.80, fbm3(p * 8.5 + vec3(3.0))) * belt;

  float mu = clamp(dot(n, toCam), 0.0, 1.0);
  float limbT = pow(clamp(1.0 - mu, 0.0, 1.0), 1.6);   // 临边昏暗

  // 盘面色温：中心近白，向边缘过渡到暖橙
  vec3 c = mix(vec3(1.00, 0.97, 0.90), vec3(0.98, 0.62, 0.28), limbT * 0.92);
  c *= 0.74 + 0.62 * gran;
  c *= mix(1.0, 0.55, limbT);
  c = mix(c, vec3(0.46, 0.19, 0.055), penumbra * 0.70);   // 半影
  c = mix(c, vec3(0.22, 0.085, 0.020), umbra * 0.92);     // 本影：必须比周围暗
  c += vec3(1.0, 0.84, 0.56) * fac * 0.22;

  // 恒星不该是"一个球"：盘面推到过曝区间，让 Bloom 接过刺眼与光晕
  gl_FragColor = vec4(c * 1.42 * uFlare, 1.0);
}
`;

// 日冕 billboard：面向相机的圆盘，径向衰减 + 角向噪声
const CORONA_VERT = /* glsl */`
uniform float uSize;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;
const CORONA_FRAG = /* glsl */`
uniform float uTime;
uniform float uInner;
uniform float uIntensity;
uniform float uSeed;
uniform float uFlare;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec2 vUv;
${GLSL_NOISE}
void main(){
  vec2 q = vUv - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float ang = atan(q.y, q.x);
  float n1 = fbm(vec3(cos(ang) * 2.1 + uSeed, sin(ang) * 2.1 + uSeed * 0.7, uTime * 0.035 + uSeed));
  float n2 = fbm3(vec3(cos(ang) * 5.0 + uSeed, sin(ang) * 5.0, uTime * 0.06 + uSeed * 1.7));

  float t = clamp((r - uInner) / max(1.0 - uInner, 0.001), 0.0, 1.0);
  float rim = smoothstep(uInner * 0.78, uInner, r);
  float halo = pow(1.0 - t, 2.8) * rim;
  halo *= 0.60 + 0.78 * n1;
  halo *= 0.70 + 0.56 * n2;

  vec3 c = mix(uColA, uColB, clamp(t * 1.3, 0.0, 1.0));
  float a = clamp(halo * uIntensity * uFlare, 0.0, 1.0);
  gl_FragColor = vec4(c, a);
}
`;

/* ── 地球 ───────────────────────────────────────────── */
const EARTH_FRAG = /* glsl */`
uniform vec3 uSunPos;
uniform vec3 uAtmoColor;
uniform float uTime;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
${GLSL_NOISE}
void main(){
  vec3 p = normalize(vObj);
  vec3 n = normalize(vNW);
  vec3 toSun = normalize(uSunPos - vWorld);
  vec3 toCam = normalize(cameraPosition - vWorld);
  float ndl = dot(n, toSun);
  float day = smoothstep(-0.07, 0.24, ndl);
  float night = 1.0 - smoothstep(-0.16, 0.10, ndl);

  // ── 大陆：域扭曲后的球面 fbm
  float w = fbm(p * 2.3 + vec3(3.0));
  vec3 q = p * 2.05 + vec3(w * 0.55, w * 0.30, w * 0.42);
  float cont = fbm(q + vec3(7.0));
  float det = fbm(p * 6.5 + vec3(1.3));
  float h = cont * 0.76 + det * 0.30;

  float land = smoothstep(0.555, 0.595, h);
  float shelf = (1.0 - land) * smoothstep(0.480, 0.562, h);

  float alat = abs(p.y);
  float dry = smoothstep(0.40, 0.62, fbm(p * 3.7 + vec3(17.0)));
  float dt = (alat - 0.38) / 0.18;
  float arid = clamp(exp(-dt * dt) * (0.30 + dry * 1.1), 0.0, 1.0);

  vec3 deepSea = vec3(0.020, 0.062, 0.165);
  vec3 shelfSea = vec3(0.045, 0.175, 0.270);
  vec3 ocean = mix(deepSea, shelfSea, shelf);
  ocean += vec3(0.012, 0.030, 0.045) * smoothstep(0.55, 0.80, det);

  vec3 forest = vec3(0.048, 0.135, 0.055);
  vec3 grass = vec3(0.125, 0.225, 0.085);
  vec3 desert = vec3(0.355, 0.258, 0.118);
  vec3 rock = vec3(0.150, 0.128, 0.104);
  vec3 landCol = mix(forest, grass, smoothstep(0.30, 0.72, det));
  landCol = mix(landCol, desert, arid * 0.88);
  float mtn = smoothstep(0.63, 0.80, h + (det - 0.5) * 0.18);
  landCol = mix(landCol, rock, mtn * 0.72);

  // 极冠
  float ice = smoothstep(0.865, 0.955, alat + (det - 0.5) * 0.10);
  ice = max(ice, smoothstep(0.900, 0.975, alat));

  vec3 albedo = mix(ocean, landCol, land);
  albedo = mix(albedo, vec3(0.66, 0.74, 0.82), ice);

  // ── 日照（ACES 前整体压得偏暗，这里给足增益）
  vec3 sunCol = vec3(1.0, 0.955, 0.88);
  vec3 col = albedo * sunCol * (0.05 + 1.45 * day);

  // ── 海面高光：窄 lobe + 只在掠射区出现 + 噪声打碎，避免整块死白
  float ndv = clamp(dot(n, toCam), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  vec3 hv = normalize(toSun + toCam + vec3(1e-4, 2e-4, 1e-4));
  float ndh = max(dot(n, hv), 0.0);
  float spec = pow(ndh, 320.0) * (1.0 - land) * (1.0 - ice)
             * smoothstep(0.15, 0.75, fres) * smoothstep(-0.05, 0.25, ndl);
  spec *= 0.35 + 0.65 * smoothstep(0.44, 0.76, fbm3(p * 38.0 + vec3(9.0)));
  float sheen = pow(ndh, 14.0) * 0.07 * (1.0 - land);
  col += sunCol * (spec * 0.5 + sheen * day);

  // ── 夜侧城市灯光
  float cn = fbm3(p * 22.0 + vec3(5.0, 2.0, 9.0));
  float cluster = smoothstep(0.50, 0.68, cn);
  float ct = (h - 0.565) / 0.05;
  float coast = exp(-ct * ct);
  float pop = cluster * cluster * (0.18 + 0.82 * coast) * (1.0 - smoothstep(0.48, 0.90, alat)) * land;
  col += vec3(1.0, 0.52, 0.17) * pop * night * 1.05;

  // ── 大气边缘散射 + 晨昏线暖色（只留细边，盘面内部不加色）
  float rim = pow(1.0 - clamp(dot(n, toCam), 0.0, 1.0), 4.2);
  col += uAtmoColor * rim * (0.30 + 0.70 * smoothstep(-0.15, 0.60, ndl)) * 0.42;
  float tt = (ndl - 0.04) / 0.10;
  float term = exp(-tt * tt);
  col += vec3(0.95, 0.34, 0.10) * term * 0.18 * (0.35 + 0.65 * rim);

  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */`
uniform vec3 uSunPos;
uniform float uTime;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
${GLSL_NOISE}
void main(){
  vec3 p = normalize(vObj);
  vec3 n = normalize(vNW);
  vec3 toSun = normalize(uSunPos - vWorld);

  // 域扭曲主层 + 两层高频细节：云边细碎，避免大团块糊成雪球
  float w = fbm(p * 2.9 + vec3(1.0) + vec3(uTime * 0.004));
  vec3 q = p * 3.5 + vec3(w * 0.85, w * 0.45, w * 0.65);
  float c1 = fbm(q + vec3(4.0));
  float c2 = fbm3(p * 12.0 + vec3(2.0));
  float c3 = fbm3(p * 26.0 + vec3(6.0));
  float m = c1 * 0.74 + c2 * 0.18 + c3 * 0.08;
  float cov = smoothstep(0.532, 0.655, m);
  cov *= 0.60 + 0.40 * smoothstep(0.34, 0.72, c3);

  // 纬向云带（赤道辐合带 / 中纬风暴带）
  cov *= clamp(0.70 + 0.40 * sin(p.y * 9.0 + c1 * 3.0), 0.0, 1.0);

  float ndl = dot(n, toSun);
  float lit = smoothstep(-0.12, 0.32, ndl);
  vec3 col = mix(vec3(0.10, 0.13, 0.22), vec3(0.72, 0.76, 0.84), lit);
  float a = min(cov * (0.07 + 0.93 * lit), 0.82);
  gl_FragColor = vec4(col, a);
}
`;

// 大气壳：Fresnel 边缘散射（朝太阳一侧更亮），叠加混合
const ATMO_FRAG = /* glsl */`
uniform vec3 uSunPos;
uniform vec3 uTint;
uniform float uStrength;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
void main(){
  vec3 n = normalize(vNW);
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(n, viewDir), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 5.2);

  vec3 toSun = normalize(uSunPos - vWorld);
  float ndl = dot(n, toSun);
  float lit = smoothstep(-0.30, 0.55, ndl);

  // 晨昏线处偏暖
  float tt = (ndl - 0.02) / 0.10;
  float sunset = exp(-tt * tt);
  vec3 col = mix(uTint, vec3(1.0, 0.46, 0.18), 0.35 * sunset);

  // 昼侧边缘压暗（避免整圈发白），夜侧保留一条偏蓝的细线
  float a = fres * uStrength * (0.38 + 0.62 * (1.0 - lit));
  a *= 1.0 + 0.85 * sunset;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/* ── 岩石行星 / 卫星 ────────────────────────────────── */
const ROCKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uIceCol;
uniform vec3 uAtmoCol;
uniform float uIce;
uniform float uRough;
uniform float uAtmoAmt;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
${GLSL_NOISE}
void main(){
  vec3 p = normalize(vObj);
  vec3 n = normalize(vNW);
  vec3 toCam = normalize(cameraPosition - vWorld);

  float n1 = fbm(p * 3.4 + vec3(2.0));
  float n2 = fbm3(p * 9.0 + vec3(4.0));
  float ridged = 1.0 - abs(fbm3(p * 6.5 + vec3(7.0)) * 2.0 - 1.0);
  float crater = smoothstep(0.55, 0.80, ridged) * smoothstep(0.35, 0.70, n2);

  vec3 c = mix(uColB, uColA, smoothstep(0.28, 0.66, n1));
  c = mix(c, uColC, smoothstep(0.55, 0.85, n2) * 0.45);
  c = mix(c, uColB * 0.55, crater * uRough * 0.85);

  float alat = abs(p.y);
  float polar = smoothstep(0.74, 0.92, alat + (n2 - 0.5) * 0.14) * uIce;
  c = mix(c, uIceCol, clamp(polar, 0.0, 1.0));

  float ndl = dot(n, uSunDir);
  float day = smoothstep(-0.10, 0.24, ndl);
  vec3 col = c * (0.030 + 1.16 * day);
  float rim = pow(1.0 - clamp(dot(n, toCam), 0.0, 1.0), 3.0);
  col += uAtmoCol * rim * (0.25 + 0.75 * day) * uAtmoAmt;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ── 气态行星 / 浓云行星 ────────────────────────────── */
const GAS_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uSpotCol;
uniform vec3 uRimCol;
uniform vec2 uSpotPos;
uniform vec2 uSpotSize;
uniform float uSpotAmt;
uniform float uBand;
uniform float uFine;
uniform float uTurb;
uniform float uRim;
uniform float uTime;
varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNW;
${GLSL_NOISE}
void main(){
  vec3 p = normalize(vObj);
  vec3 n = normalize(vNW);
  vec3 toCam = normalize(cameraPosition - vWorld);

  float lat = p.y;
  float lon = atan(p.z, p.x);

  float w = fbm(vec3(p.xz * 2.4, lat * 6.0) + vec3(uTime * 0.005));
  float bands = 0.5 + 0.5 * sin(lat * uBand + w * uTurb * 6.0 + sin(lon * 2.0) * 0.35);
  float fine = 0.5 + 0.5 * sin(lat * uBand * 3.3 + w * uTurb * 11.0);

  vec3 c = mix(uColB, uColA, smoothstep(0.12, 0.88, bands));
  c = mix(c, uColC, fine * uFine);
  c *= 0.90 + 0.20 * w;

  if (uSpotAmt > 0.001) {
    vec2 sp = vec2(lon - uSpotPos.x, lat - uSpotPos.y);
    sp.x = mod(sp.x + 3.14159265, 6.2831853) - 3.14159265;
    vec2 sd = vec2(sp.x / uSpotSize.x, sp.y / uSpotSize.y);
    float d = length(sd);
    float spot = (1.0 - smoothstep(0.30, 1.15, d)) * uSpotAmt;
    float swirl = 0.72 + 0.28 * sin(atan(sd.y, sd.x) * 3.0 + w * 8.0);
    c = mix(c, uSpotCol * swirl, clamp(spot, 0.0, 1.0) * 0.92);
  }

  float ndl = dot(n, uSunDir);
  vec3 col = c * (0.028 + 1.18 * smoothstep(-0.08, 0.22, ndl));
  float rim = pow(1.0 - clamp(dot(n, toCam), 0.0, 1.0), 3.2);
  col += uRimCol * rim * (0.28 + 0.72 * smoothstep(-0.20, 0.50, ndl)) * uRim;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ── 土星环 ─────────────────────────────────────────── */
const RING_VERT = /* glsl */`
varying vec3 vLocal;
varying vec3 vWorld;
void main(){
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RING_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uPlanetCenter;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uInner;
uniform float uOuter;
uniform float uPlanetRadius;
varying vec3 vLocal;
varying vec3 vWorld;
${GLSL_NOISE}
void main(){
  float rad = length(vLocal.xy);
  float t = (rad - uInner) / (uOuter - uInner);
  if (t < 0.0 || t > 1.0) discard;

  float n1 = fbm(vec3(rad * 0.085, 1.0, 0.0));
  float n2 = fbm3(vec3(rad * 0.34, 2.0, 0.0));
  float bands = 0.5 + 0.5 * sin(rad * 1.15 + n1 * 9.0);
  float fine = 0.5 + 0.5 * sin(rad * 5.7 + n2 * 12.0);

  float a = (0.30 + 0.70 * bands) * (0.52 + 0.48 * fine);
  a *= smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.93, 1.0, t));
  // 卡西尼缝 + 一条内圈暗带
  float gap = smoothstep(0.480, 0.500, t) * (1.0 - smoothstep(0.545, 0.565, t));
  a *= 1.0 - gap * 0.94;
  float gap2 = smoothstep(0.215, 0.230, t) * (1.0 - smoothstep(0.250, 0.265, t));
  a *= 1.0 - gap2 * 0.55;
  a *= mix(1.0, 0.42, smoothstep(0.72, 1.0, t));

  // 行星投在环上的影子
  vec3 rel = vWorld - uPlanetCenter;
  float along = dot(rel, uSunDir);
  float perp = length(rel - uSunDir * along);
  float behind = clamp(-along / (uPlanetRadius * 0.35), 0.0, 1.0);
  float shadow = behind * (1.0 - smoothstep(uPlanetRadius * 0.88, uPlanetRadius * 1.14, perp));
  float light = 1.0 - shadow * 0.90;

  vec3 c = mix(uColB, uColA, bands) * (0.60 + 0.40 * fine);
  c *= light * 1.30;
  gl_FragColor = vec4(c, clamp(a * (0.30 + 0.70 * light), 0.0, 1.0));
}
`;

/* ── 星空 ───────────────────────────────────────────── */
const STAR_VERT = /* glsl */`
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixel;
varying vec3 vColor;
varying float vBright;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 1.0 + 0.16 * sin(uTime * 1.9 + aPhase * 6.2831);
  vColor = aColor;
  vBright = tw;
  gl_PointSize = aSize * uPixel * 1.32;
}
`;
const STAR_FRAG = /* glsl */`
varying vec3 vColor;
varying float vBright;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5, 0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 1.0, r);
  core = core * core * (0.55 + 0.45 * core);
  gl_FragColor = vec4(vColor * vBright * 1.22, core);
}
`;

/* ── 星云球壳 ───────────────────────────────────────── */
const NEBULA_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const NEBULA_FRAG = /* glsl */`
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uGalPole;
varying vec3 vDir;
${GLSL_NOISE}
void main(){
  vec3 d = normalize(vDir);
  float gd = dot(d, uGalPole) / 0.26;
  float band = exp(-gd * gd);
  float n1 = fbm(d * 2.1 + vec3(4.0));
  float n2 = fbm3(d * 5.3 + vec3(11.0));
  float clouds = smoothstep(0.28, 0.86, n1) * (0.55 + 0.45 * n2);
  float dust = smoothstep(0.30, 0.62, n2);
  vec3 col = mix(uColA, uColB, n2) * (0.45 + 1.15 * band);
  col *= clouds;
  float a = clouds * (0.09 + 0.52 * band) + 0.010;
  a *= 0.55 + 0.45 * dust;
  gl_FragColor = vec4(col, clamp(a * 0.55, 0.0, 1.0));
}
`;

/* ── 小行星带 ───────────────────────────────────────── */
const AST_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;
void main(){
  vec4 lp = vec4(position, 1.0);
  vec3 nn = normal;
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
    nn = mat3(instanceMatrix) * nn;
  #endif
  vTint = vec3(0.085, 0.078, 0.070);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vec4 wp = modelMatrix * lp;
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * nn);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const AST_FRAG = /* glsl */`
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vTint;
void main(){
  vec3 n = normalize(vN);
  vec3 toSun = normalize(-vWorld);
  float ndl = dot(n, toSun);
  float lit = 0.020 + 1.10 * smoothstep(-0.08, 0.22, ndl);
  gl_FragColor = vec4(vTint * lit, 1.0);
}
`;

/* ════════════════════════════════════════════════════════════════
   静态数据
   ════════════════════════════════════════════════════════════════ */

// 轨道/半径严格按契约；period/spin 单位为秒
const BODY_CFG = [
  {
    id: 'mercury', cn: '水星', en: 'MERCURY', radius: 0.9, orbitRadius: 62,
    period: 44, spin: 34, node: 0.6, inc: 0.05, phase: 1.9,
    color: 'rgba(198,180,158,1)',
    desc: '太阳系最小的行星，几乎没有大气，昼夜温差接近 600℃。',
    rocky: {
      a: [0.300, 0.262, 0.216], b: [0.112, 0.098, 0.088], c: [0.440, 0.392, 0.340],
      ice: 0.0, iceCol: [0.70, 0.72, 0.75], rough: 0.95,
      atmo: [0.0, 0.0, 0.0], atmoAmt: 0.0,
    },
  },
  {
    id: 'venus', cn: '金星', en: 'VENUS', radius: 1.5, orbitRadius: 86,
    period: 68, spin: -52, node: 2.1, inc: 0.04, phase: 4.0,
    color: 'rgba(255,214,150,1)',
    desc: '浓密的硫酸云包裹整颗行星，温室效应让地表高达 460℃。',
    gas: {
      a: [0.870, 0.760, 0.500], b: [0.590, 0.470, 0.290], c: [0.960, 0.890, 0.690],
      band: 7.0, fine: 0.55, turb: 4.2, rim: 0.70, rimCol: [0.95, 0.74, 0.42],
      spot: null,
    },
  },
  {
    // 地球：geo / 材质在 buildEarth() 中单独创建
    id: 'earth', cn: '地球', en: 'EARTH', radius: 3.2, orbitRadius: 116,
    period: 240, spin: 24, node: 0.0, inc: 0.0, phase: 0.35,
    color: 'rgba(126,200,255,1)',
    desc: '唯一已知存在生命的行星：液氖海洋、程序化大陆、云带与夜侧灯火。'.replace('氖', '态'),
  },
  {
    id: 'mars', cn: '火星', en: 'MARS', radius: 1.2, orbitRadius: 158,
    period: 156, spin: 25, node: 3.4, inc: 0.035, phase: 2.6,
    color: 'rgba(255,124,84,1)',
    desc: '锈红色的沙漠行星，拥有太阳系最高的火山与干涸的河床。',
    rocky: {
      a: [0.360, 0.150, 0.078], b: [0.130, 0.062, 0.042], c: [0.560, 0.290, 0.150],
      ice: 0.90, iceCol: [0.78, 0.80, 0.84], rough: 0.62,
      atmo: [0.55, 0.20, 0.10], atmoAmt: 0.35,
    },
  },
  {
    id: 'jupiter', cn: '木星', en: 'JUPITER', radius: 9.0, orbitRadius: 232,
    period: 190, spin: 11, node: 1.2, inc: 0.028, phase: 5.1,
    color: 'rgba(255,204,150,1)',
    desc: '气态巨行星之王，赤道云带以 400 km/h 相向流动，大红斑已持续数百年。',
    gas: {
      a: [0.700, 0.580, 0.410], b: [0.310, 0.220, 0.140], c: [0.880, 0.790, 0.640],
      band: 16.0, fine: 0.70, turb: 3.4, rim: 0.55, rimCol: [0.85, 0.68, 0.45],
      spot: { pos: [2.10, -0.22], size: [0.52, 0.115], col: [0.520, 0.135, 0.070], amt: 0.95 },
    },
  },
  {
    id: 'saturn', cn: '土星', en: 'SATURN', radius: 7.4, orbitRadius: 300,
    period: 210, spin: 13, node: 2.7, inc: 0.032, phase: 0.9,
    color: 'rgba(255,232,176,1)',
    desc: '拥有最壮观的行星环：无数冰粒组成的薄盘，被卡西尼缝切分成多圈。',
    gas: {
      a: [0.760, 0.660, 0.470], b: [0.430, 0.340, 0.220], c: [0.900, 0.830, 0.670],
      band: 13.0, fine: 0.42, turb: 2.4, rim: 0.60, rimCol: [0.95, 0.82, 0.55],
      spot: null,
    },
    ring: true,
  },
  {
    id: 'uranus', cn: '天王星', en: 'URANUS', radius: 3.6, orbitRadius: 366,
    period: 226, spin: -20, node: 4.4, inc: 0.026, phase: 3.8,
    color: 'rgba(150,240,255,1)',
    desc: '青蓝色的冰巨星，自转轴几乎躺在轨道面上，四季长达 21 年。',
    gas: {
      a: [0.430, 0.760, 0.800], b: [0.290, 0.560, 0.640], c: [0.520, 0.820, 0.850],
      band: 4.0, fine: 0.08, turb: 0.8, rim: 0.85, rimCol: [0.55, 0.85, 1.0],
      spot: null,
    },
  },
  {
    id: 'neptune', cn: '海王星', en: 'NEPTUNE', radius: 3.4, orbitRadius: 430,
    period: 240, spin: 18, node: 5.2, inc: 0.022, phase: 1.4,
    color: 'rgba(120,150,255,1)',
    desc: '最遥远的蓝色巨行星，风速可达 2100 km/h，云层带着深蓝色的大暗斑。',
    gas: {
      a: [0.130, 0.280, 0.720], b: [0.045, 0.100, 0.400], c: [0.220, 0.400, 0.820],
      band: 8.0, fine: 0.30, turb: 2.0, rim: 0.75, rimCol: [0.35, 0.55, 1.0],
      spot: { pos: [4.2, 0.18], size: [0.70, 0.20], col: [0.020, 0.040, 0.180], amt: 0.55 },
    },
  },
];

// 伽利略卫星
const MOON_CFG = [
  { cn: '木卫一', dist: 18.0, radius: 0.30, period: 4.6, phase: 0.4, inc: 0.10,
    rocky: { a: [0.520, 0.420, 0.130], b: [0.210, 0.150, 0.055], c: [0.720, 0.620, 0.220],
             ice: 0.0, iceCol: [0.8, 0.8, 0.8], rough: 0.55, atmo: [0.0, 0.0, 0.0], atmoAmt: 0.0 } },
  { cn: '木卫二', dist: 23.0, radius: 0.26, period: 7.2, phase: 2.1, inc: 0.06,
    rocky: { a: [0.560, 0.560, 0.585], b: [0.300, 0.300, 0.330], c: [0.720, 0.720, 0.740],
             ice: 0.6, iceCol: [0.80, 0.82, 0.86], rough: 0.35, atmo: [0.0, 0.0, 0.0], atmoAmt: 0.0 } },
  { cn: '木卫三', dist: 29.0, radius: 0.36, period: 11.0, phase: 4.3, inc: 0.05,
    rocky: { a: [0.290, 0.270, 0.245], b: [0.130, 0.120, 0.110], c: [0.400, 0.375, 0.340],
             ice: 0.35, iceCol: [0.75, 0.76, 0.78], rough: 0.75, atmo: [0.0, 0.0, 0.0], atmoAmt: 0.0 } },
  { cn: '木卫四', dist: 36.0, radius: 0.33, period: 18.0, phase: 5.9, inc: 0.08,
    rocky: { a: [0.115, 0.105, 0.095], b: [0.050, 0.046, 0.042], c: [0.170, 0.155, 0.140],
             ice: 0.2, iceCol: [0.60, 0.60, 0.62], rough: 0.85, atmo: [0.0, 0.0, 0.0], atmoAmt: 0.0 } },
];

const SUN_RADIUS = 22;
const EARTH_RADIUS = 3.2;
const STATION_DIST = EARTH_RADIUS * 1.75; // 5.6
const STATION_UP = 2.1;                   // 偏离黄道面的高度

/* ════════════════════════════════════════════════════════════════
   createWorld
   ════════════════════════════════════════════════════════════════ */
export function createWorld(scene, opts = {}) {
  const quality = opts.quality || 'high';
  const hi = quality === 'high';
  const mdl = quality === 'medium';

  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  const renderer = opts.renderer || null;
  const pixelRatio = renderer ? Math.min(renderer.getPixelRatio() || 1, 2) : 1.5;

  // 共享 uniform：一次写入，全场景生效
  const timeU = { value: 0 };
  const flareU = { value: 1 };
  const sunPosU = { value: new THREE.Vector3(0, 0, 0) };

  const sunPosition = sunPosU.value;
  const earth = { center: new THREE.Vector3(116, 0, 0), radius: EARTH_RADIUS };
  const stationAnchor = new THREE.Vector3();
  const bodies = [];
  const byId = new Map();

  /* ───────────── 太阳 ───────────── */
  const sunMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uFlare: flareU },
    vertexShader: SPHERE_VERT,
    fragmentShader: SUN_FRAG,
  });
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, hi ? 72 : 48, hi ? 48 : 32),
    sunMat
  );
  sunMesh.name = 'sun';
  group.add(sunMesh);

  // 日冕：三层面向相机的圆盘叠加
  // 尺寸必须 > 44（=2*SUN_RADIUS），否则 uInner>1 整个圆盘被太阳本体完全挡住
  const CORONA_CFG = [
    { size: 52, colA: [1.00, 0.82, 0.55], colB: [1.00, 0.58, 0.24], inten: 0.66, seed: 0.0 },
    { size: 84, colA: [1.00, 0.72, 0.38], colB: [0.55, 0.72, 1.00], inten: 0.34, seed: 4.7 },
    { size: 124, colA: [1.00, 0.72, 0.38], colB: [0.55, 0.72, 1.00], inten: 0.17, seed: 9.3 },
  ];
  for (const c of CORONA_CFG) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: timeU,
        uFlare: flareU,
        uSize: { value: c.size },
        uInner: { value: SUN_RADIUS / (c.size * 0.5) },
        uIntensity: { value: c.inten },
        uSeed: { value: c.seed },
        uColA: { value: linear(c.colA[0], c.colA[1], c.colA[2]) },
        uColB: { value: linear(c.colB[0], c.colB[1], c.colB[2]) },
      },
      vertexShader: CORONA_VERT,
      fragmentShader: CORONA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    quad.frustumCulled = false;
    quad.renderOrder = 6;
    group.add(quad);
  }

  /* ───────────── 地球 ───────────── */
  const earthGroup = new THREE.Group();       // 轨道位置（= body.group）
  earthGroup.position.set(116, 0, 0);
  group.add(earthGroup);

  const earthTilt = new THREE.Group();        // 23.44° 自转轴倾角
  earthTilt.rotation.z = 23.44 * DEG;
  earthGroup.add(earthTilt);

  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunPos: sunPosU,
      uAtmoColor: { value: linear(0.32, 0.58, 1.0) },
      uTime: timeU,
    },
    vertexShader: SPHERE_VERT,
    fragmentShader: EARTH_FRAG,
  });
  const earthSurface = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, hi ? 96 : 64, hi ? 64 : 44),
    earthMat
  );
  earthTilt.add(earthSurface);

  const cloudMat = new THREE.ShaderMaterial({
    uniforms: { uSunPos: sunPosU, uTime: timeU },
    vertexShader: SPHERE_VERT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS * 1.012, hi ? 72 : 48, hi ? 48 : 32),
    cloudMat
  );
  cloudMesh.renderOrder = 1;
  earthTilt.add(cloudMesh);

  const makeShell = (scale, strength, tint, order) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSunPos: sunPosU,
        uTint: { value: tint },
        uStrength: { value: strength },
      },
      vertexShader: SPHERE_VERT,
      fragmentShader: ATMO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * scale, hi ? 64 : 44, hi ? 44 : 30),
      mat
    );
    m.renderOrder = order;
    earthGroup.add(m);
    return m;
  };
  makeShell(1.055, 0.55, linear(0.32, 0.58, 1.00), 2);   // 紧贴地表的蓝色散射环
  makeShell(1.245, 0.20, linear(0.26, 0.50, 0.98), 3);   // 更外层的薄晕

  /* ───────────── 行星 ───────────── */
  const moons = [];
  let saturnBody = null;
  let ringU = null;

  function makeRockyMat(sunDirU, cfg) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDirU,
        uColA: { value: linear(cfg.a[0], cfg.a[1], cfg.a[2]) },
        uColB: { value: linear(cfg.b[0], cfg.b[1], cfg.b[2]) },
        uColC: { value: linear(cfg.c[0], cfg.c[1], cfg.c[2]) },
        uIceCol: { value: linear(cfg.iceCol[0], cfg.iceCol[1], cfg.iceCol[2]) },
        uAtmoCol: { value: linear(cfg.atmo[0], cfg.atmo[1], cfg.atmo[2]) },
        uIce: { value: cfg.ice },
        uRough: { value: cfg.rough },
        uAtmoAmt: { value: cfg.atmoAmt },
      },
      vertexShader: SPHERE_VERT,
      fragmentShader: ROCKY_FRAG,
    });
  }

  function makeGasMat(sunDirU, cfg) {
    const sp = cfg.spot || { pos: [0, 0], size: [1, 1], col: [0, 0, 0], amt: 0 };
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: sunDirU,
        uColA: { value: linear(cfg.a[0], cfg.a[1], cfg.a[2]) },
        uColB: { value: linear(cfg.b[0], cfg.b[1], cfg.b[2]) },
        uColC: { value: linear(cfg.c[0], cfg.c[1], cfg.c[2]) },
        uSpotCol: { value: linear(sp.col[0], sp.col[1], sp.col[2]) },
        uRimCol: { value: linear(cfg.rimCol[0], cfg.rimCol[1], cfg.rimCol[2]) },
        uSpotPos: { value: new THREE.Vector2(sp.pos[0], sp.pos[1]) },
        uSpotSize: { value: new THREE.Vector2(sp.size[0], sp.size[1]) },
        uSpotAmt: { value: sp.amt },
        uBand: { value: cfg.band },
        uFine: { value: cfg.fine },
        uTurb: { value: cfg.turb },
        uRim: { value: cfg.rim },
        uTime: timeU,
      },
      vertexShader: SPHERE_VERT,
      fragmentShader: GAS_FRAG,
    });
  }

  for (const d of BODY_CFG) {
    const b = {
      id: d.id, name: d.en, cn: d.cn, en: d.en,
      radius: d.radius, color: d.color, orbitRadius: d.orbitRadius, desc: d.desc,
      group: null,
      // 内部动画参数
      _omega: TAU / d.period,
      _phase: d.phase,
      _spin: TAU / d.spin,
      _spinPhase: d.id === 'earth' ? 1.15 : Math.random() * TAU,
      _sinInc: Math.sin(d.inc),
      _cosInc: Math.cos(d.inc),
      _sinNode: Math.sin(d.node),
      _cosNode: Math.cos(d.node),
      _mesh: null,
      _sunDir: null,
    };

    // 地球：几何体已在上面创建
    if (d.id === 'earth') {
      b.group = earthGroup;
      b._mesh = earthSurface;
      bodies.push(b);
      byId.set(d.id, b);
      continue;
    }

    const g = new THREE.Group();
    group.add(g);
    b.group = g;

    const sunDirU = { value: new THREE.Vector3(-1, 0, 0) };
    b._sunDir = sunDirU;

    const segW = d.radius >= 7 ? (hi ? 56 : 40) : (hi ? 48 : 32);
    const segH = d.radius >= 7 ? (hi ? 40 : 30) : (hi ? 32 : 24);

    const mat = d.rocky ? makeRockyMat(sunDirU, d.rocky) : makeGasMat(sunDirU, d.gas);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radius, segW, segH), mat);

    if (d.id === 'saturn') {
      // 土星：轴倾 + 环
      const tilt = new THREE.Group();
      tilt.rotation.z = 26.7 * DEG;
      tilt.add(mesh);
      g.add(tilt);
      b._mesh = mesh;

      const inner = d.radius * 1.24;
      const outer = d.radius * 2.38;
      ringU = {
        uSunDir: sunDirU,
        uPlanetCenter: { value: new THREE.Vector3() },
        uColA: { value: linear(0.780, 0.700, 0.540) },
        uColB: { value: linear(0.420, 0.355, 0.255) },
        uInner: { value: inner },
        uOuter: { value: outer },
        uPlanetRadius: { value: d.radius },
      };
      const ringMat = new THREE.ShaderMaterial({
        uniforms: ringU,
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, hi ? 256 : 128, 1),
        ringMat
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 2;
      tilt.add(ring);
      saturnBody = b;
    } else if (d.id === 'jupiter') {
      g.add(mesh);
      b._mesh = mesh;
      // 伽利略卫星
      for (const mc of MOON_CFG) {
        const mSunDir = { value: new THREE.Vector3(-1, 0, 0) };
        const mm = new THREE.Mesh(
          new THREE.SphereGeometry(mc.radius, hi ? 24 : 16, hi ? 18 : 12),
          makeRockyMat(mSunDir, mc.rocky)
        );
        g.add(mm);
        moons.push({
          mesh: mm, sunDir: mSunDir, parent: g,
          dist: mc.dist, period: mc.period, phase: mc.phase, inc: mc.inc,
        });
      }
    } else {
      g.add(mesh);
      b._mesh = mesh;
    }

    bodies.push(b);
    byId.set(d.id, b);
  }

  /* ───────────── 星空 ───────────── */
  const GAL_POLE = new THREE.Vector3(0.44, 0.63, -0.64).normalize();

  {
    const count = hi ? 14000 : 12000;
    const pos = new Float32Array(count * 3);
    const cArr = new Float32Array(count * 3);
    const sArr = new Float32Array(count);
    const pArr = new Float32Array(count);

    // 与 GAL_POLE 正交的基，用于散布银河带
    const gu = new THREE.Vector3(1, 0, 0).cross(GAL_POLE).normalize();
    const gv = new THREE.Vector3().crossVectors(GAL_POLE, gu).normalize();

    const TEMP = [
      [0.56, 0.68, 1.00, 0.09],
      [0.74, 0.84, 1.00, 0.17],
      [0.96, 0.97, 1.00, 0.23],
      [1.00, 0.95, 0.84, 0.23],
      [1.00, 0.80, 0.56, 0.19],
      [1.00, 0.62, 0.38, 0.09],
    ];
    const cum = [];
    let acc = 0;
    for (const t of TEMP) { acc += t[3]; cum.push(acc); }

    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

    for (let i = 0; i < count; i++) {
      let dx, dy, dz;
      // 52% 的星点归属银河带
      if (Math.random() < 0.52) {
        const th = Math.random() * TAU;
        const off = gauss() * 0.15;
        dx = gu.x * Math.cos(th) + gv.x * Math.sin(th) + GAL_POLE.x * off;
        dy = gu.y * Math.cos(th) + gv.y * Math.sin(th) + GAL_POLE.y * off;
        dz = gu.z * Math.cos(th) + gv.z * Math.sin(th) + GAL_POLE.z * off;
      } else {
        const cz = Math.random() * 2 - 1;
        const ph = Math.random() * TAU;
        const rr = Math.sqrt(Math.max(0, 1 - cz * cz));
        dx = rr * Math.cos(ph);
        dy = cz;
        dz = rr * Math.sin(ph);
      }
      const inv = 1 / Math.max(1e-4, Math.hypot(dx, dy, dz));
      const dist = 4200 + Math.random() * 4000;
      pos[i * 3] = dx * inv * dist;
      pos[i * 3 + 1] = dy * inv * dist;
      pos[i * 3 + 2] = dz * inv * dist;

      // 色温
      const r = Math.random();
      let ti = 0;
      while (ti < cum.length - 1 && r > cum[ti]) ti++;
      const t = TEMP[ti];
      const bright = 0.20 + Math.pow(Math.random(), 5) * 3.1;
      cArr[i * 3] = t[0] * bright;
      cArr[i * 3 + 1] = t[1] * bright;
      cArr[i * 3 + 2] = t[2] * bright;

      // 少量“英雄星”显著更大
      const h = Math.random();
      sArr[i] = h > 0.997 ? 3.4 + Math.random() * 1.8 : 0.85 + Math.pow(Math.random(), 3) * 1.5;
      pArr[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cArr, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sArr, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(pArr, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: timeU, uPixel: { value: pixelRatio } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    stars.renderOrder = -5;
    group.add(stars);
  }

  /* ───────────── 星云球壳 ───────────── */
  {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColA: { value: linear(0.075, 0.095, 0.30) },
        uColB: { value: linear(0.24, 0.085, 0.30) },
        uGalPole: { value: GAL_POLE.clone() },
      },
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
    });
    const neb = new THREE.Mesh(new THREE.SphereGeometry(9000, hi ? 48 : 32, hi ? 32 : 24), mat);
    neb.frustumCulled = false;
    neb.renderOrder = -10;
    group.add(neb);
  }

  /* ───────────── 小行星带 ───────────── */
  const AST_COUNT = hi ? 780 : mdl ? 660 : 600;
  const astMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.ShaderMaterial({ vertexShader: AST_VERT, fragmentShader: AST_FRAG }),
    AST_COUNT
  );
  astMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  astMesh.frustumCulled = false;
  group.add(astMesh);

  const astData = [];
  {
    const tmpColor = new THREE.Color();
    for (let i = 0; i < AST_COUNT; i++) {
      const r = 176 + Math.random() * 36;
      astData.push({
        r,
        phase: Math.random() * TAU,
        inc: (Math.random() - 0.5) * 0.32,
        sx: (0.05 + Math.pow(Math.random(), 2) * 0.30),
        sy: (0.05 + Math.pow(Math.random(), 2) * 0.26),
        sz: (0.05 + Math.pow(Math.random(), 2) * 0.30),
        rx: Math.random() * TAU,
        ry: Math.random() * TAU,
        rz: Math.random() * TAU,
        wr: (Math.random() - 0.5) * 0.5,
        wx: (Math.random() - 0.5) * 0.5,
        wz: (Math.random() - 0.5) * 0.5,
      });
      const v = 0.055 + Math.random() * 0.085;
      tmpColor.setRGB(v * 1.06, v * 0.96, v * 0.86);
      astMesh.setColorAt(i, tmpColor);
    }
    if (astMesh.instanceColor) astMesh.instanceColor.needsUpdate = true;
  }
  const dummy = new THREE.Object3D();

  /* ───────────── 每帧更新 ───────────── */
  const anchorHr = Math.sqrt(STATION_DIST * STATION_DIST - STATION_UP * STATION_UP);

  function update(dt, t) {
    timeU.value = t;
    flareU.value = 1 + 0.055 * Math.sin(t * 2.3) + 0.035 * Math.sin(t * 5.7 + 1.3);

    // —— 行星公转 / 自转
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const ang = t * b._omega + b._phase;
      const x0 = Math.cos(ang) * b.orbitRadius;
      const z0 = Math.sin(ang) * b.orbitRadius;
      const y = -z0 * b._sinInc;
      const z = z0 * b._cosInc;
      const px = x0 * b._cosNode - z * b._sinNode;
      const pz = x0 * b._sinNode + z * b._cosNode;
      b.group.position.set(px, y, pz);
      if (b._mesh) b._mesh.rotation.y = t * b._spin + b._spinPhase;
      if (b._sunDir) b._sunDir.value.set(-px, -y, -pz).normalize();
    }

    // —— 地球
    earth.center.copy(earthGroup.position);
    cloudMesh.rotation.y = t * (TAU / 31.5) + 0.7;

    // —— 空间站锚点：始终停在日照侧，绕地球缓慢环行
    {
      const ex = earth.center.x;
      const ez = earth.center.z;
      const el = Math.hypot(ex, ez) || 1;
      const shx = -ex / el;             // 指向太阳的水平方向
      const shz = -ez / el;
      const a = 0.58 + 0.46 * Math.sin(t * TAU / 78); // 日照侧 ±26°缓慢环行
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const hx = shx * ca - shz * sa;
      const hz = shx * sa + shz * ca;
      stationAnchor.set(ex + hx * anchorHr, earth.center.y + STATION_UP, ez + hz * anchorHr);
    }

    // —— 伽利略卫星
    for (let i = 0; i < moons.length; i++) {
      const m = moons[i];
      const a = t * (TAU / m.period) + m.phase;
      const lx = Math.cos(a) * m.dist;
      const lz = Math.sin(a) * m.dist;
      const ly = lz * m.inc;
      m.mesh.position.set(lx, ly, lz);
      m.mesh.rotation.y = a * 2.0;
      const pp = m.parent.position;
      m.sunDir.value.set(-(pp.x + lx), -(pp.y + ly), -(pp.z + lz)).normalize();
    }

    // —— 土星环阴影所需的行星位置
    if (saturnBody && ringU) {
      ringU.uPlanetCenter.value.copy(saturnBody.group.position);
    }

    // —— 小行星带
    for (let i = 0; i < AST_COUNT; i++) {
      const a = astData[i];
      // 内圈角速度略快，避免整带刚性旋转
      const an = t * (TAU / (240 + (a.r - 176) * 2.4)) + a.phase;
      const x0 = Math.cos(an) * a.r;
      const z0 = Math.sin(an) * a.r;
      dummy.position.set(x0, z0 * a.inc, z0);
      dummy.rotation.set(a.rx + t * a.wr, a.ry + t * a.wx, a.rz + t * a.wz);
      dummy.scale.set(a.sx, a.sy, a.sz);
      dummy.updateMatrix();
      astMesh.setMatrixAt(i, dummy.matrix);
    }
    astMesh.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    scene.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) {
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
  }

  update(0, 0);

  return {
    group,
    update,
    dispose,
    sunPosition,
    sun: sunMesh,
    earth,
    stationAnchor,
    bodies,
    bodyById: (id) => byId.get(id),
  };
}
