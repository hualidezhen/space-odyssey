# 模块契约（CONTRACT）

工程根目录：`C:\work\code\AI\space-odyssey\`

```
index.html              主页面：importmap / HUD DOM / CSS / 启动     ← Lead 独占
src/main.js             主编排：状态机 / 相机 / 输入 / HUD 绑定      ← Lead 独占
src/postfx.js           后期：Bloom + 电影感调色 + 胶片颗粒           ← Lead 独占
src/world.js            宇宙：太阳 / 地球 / 行星 / 星海 / 小行星带     ← 队友 A
src/station.js          空间站：模块化建模 / 悬停高亮 / 拆解动画       ← 队友 B
src/ship.js             飞船：程序化模型 / 飞行物理 / 第三人称相机     ← 队友 C
vendor/                 本地 three.js r160（离线，勿改）
```

**硬性规则**
1. 只写自己负责的文件，不要动别人的文件、不要改 index.html、不要新增依赖。
2. 依赖只有 `three`（importmap 已映射到 `./vendor/three.module.js`）。不要联网、不要用外部贴图/字体/模型。
3. 全部程序化生成：几何用 `THREE.BufferGeometry` / 基础体拼装，贴图一律用 GLSL 或 Canvas2D 现场生成。
4. 代码为原生 ES Module，`node --check 文件` 必须通过（package.json 已 `type: module`）。
5. 单位：1 世界单位 ≈ 1000km（大致）。y 轴向上。所有动画基于 `update(dt, t)` 的入参，不要用 `Date.now()`。
6. 性能预算：单帧更新 < 2ms，三角面 < 30 万，每个模块 draw call 尽量 < 150。用 `InstancedMesh` 合并星点/碎片。
7. 不要在全屏后期上做文章（Bloom/颗粒/暗角由 postfx.js 统一处理），模块内部只做自身材质与光效。
8. 颜色空间：`renderer.outputColorSpace = SRGBColorSpace`，材质颜色按 sRGB 直觉给即可，自发光强度别爆（emissiveIntensity ≤ 2，除太阳）。

---

## world.js

```js
import { createWorld } from './world.js';
const world = createWorld(scene, { quality: 'high', renderer });
// 每帧：
world.update(dt, t);
// 读取：
world.sunPosition        // THREE.Vector3 世界坐标
world.earth.center       // THREE.Vector3 世界坐标（每帧刷新）
world.earth.radius       // number（地球半径，约 3.2）
world.stationAnchor      // THREE.Vector3：空间站应该待的地球轨道点（每帧刷新）
world.bodies             // [{ id, name, cn, en, radius, color, group, orbitRadius, desc }]
world.bodyById(id)       // 返回 body 或 undefined
world.dispose()          // 可选
```

- 行星轨道尺度（单位=世界单位，太阳在原点）：水星 62 / 金星 86 / 地球 116 / 火星 158 / 木星 232 / 土星 300 / 天王星 366 / 海王星 430。
- 半径：水星 0.9 / 金星 1.5 / 地球 3.2 / 火星 1.2 / 木星 9.0 / 土星 7.4 / 天王星 3.6 / 海王星 3.4。太阳半径 22，位于原点。
- 行星公转周期做成 40~240 秒之间（视觉上能看出在动），地球自转约 24 秒一圈。
- `stationAnchor`：地球附近、朝向太阳一侧稍偏的稳定轨道点，距离地心约 `radius * 1.75`，带缓慢绕地公转。
- 地球必须是全场最惊艳的：程序化大陆/海洋/云层/冰盖 + 大气边缘散射光（Fresnel）+ 夜景灯光可选。太阳要有日冕/耀斑辉光（用面向相机的 billboard 或 sprite 叠加），但别做成纯白大光球。
- 星空：≥12000 颗，颜色温度有差异（冷蓝白 ↔ 暖黄红），另加银河带（沿某大圆的星点密度更高）+ 远处星云（大球壳 + 噪声 shader，透明度极低）。
- 土星必须有环（程序化径向 alpha），且环有阴影/透明度层次。
- 木星有带状云纹 + 大红斑；火星有极冠；天王星/海王星偏青紫。
- 小行星带：火星与木星之间，`InstancedMesh`，≥600 块，缓慢公转。

---

## station.js

```js
import { createStation } from './station.js';
const station = createStation(scene, { quality: 'high' });
station.update(dt, t, camera);      // 自转、灯光闪烁、拆解动画推进
scene.add(station.group);           // 位置由 main.js 每帧设置（stationAnchor）
station.raycast(raycaster)          // → module | null
station.setHover(moduleOrNull)      // 悬停高亮（描边/发光）
station.setSelected(moduleOrNull)
station.toggleExplode()             // 全部拆解 ↔ 全部复位
station.setExploded(bool)
station.explodeAmount               // 0..1
station.modules                     // [{ id, name, cn, desc, stat, object }] 长度 14~22
station.focusPoint                  // THREE.Vector3 局部坐标（相机观察中心）
```

- 站体总跨度约 2.4 世界单位（地球半径 3.2，视觉上像一座城市级空间站）。
- 结构参考：中央增压核心舱 + 十字桁架 + 双旋转居住环 + 4 组太阳能翼（每翼 3 块板）+ 对接环 + 雷达天线 + 散热片 + 尾部推进段 + 若干细节(舷窗、警示灯、编号)。
- 可拆解：每个 module 在 Explode 时沿自身径向/轴向平移 0.6~1.6 单位并轻微旋转，有缓动与错峰（stagger），复位时按相反顺序。模块悬停时高亮（自发光提升 + 轮廓），被选中时脉冲。
- 细节质感：金属 `MeshStandardMaterial(metalness≈0.9, roughness≈0.35)` + 少量暖色自发光窗灯；不要廉价“塑料感”。
- 站体自身缓慢自转（居住环自转更快，√ 真实感）。

---

## ship.js

```js
import { createShip } from './ship.js';
const ship = createShip(scene, camera, { quality: 'high' });
ship.setActive(true);
ship.update(dt, t, input);   // input: { throttle:-1..1, yaw:-1..1, pitch:-1..1, roll:-1..1, boost:bool }
ship.setActive(false);
ship.warpTo(targetVec3);     // 跃迁：内部把飞船平滑移到目标附近，含加速拉扯与到达减速
ship.state                   // { speed, maxSpeed, boosting, warping, warpCharge }
ship.position                // Vector3
ship.cameraMode              // 'chase' | 'cockpit'
ship.toggleCamera()
```

- 飞船：流线型单座星际战机（约 0.9 单位长），机翼/座舱/双引擎；引擎尾焰 + 拖尾（面向相机的发光锥或 sprite），加速时 FOV 拉伸。
- 第三人称追尾相机：位于机身后方 1.6、上方 0.55，带弹簧阻尼、速度越快视距越远、转向时轻微侧倾；用 `camera.position`/`quaternion` 直接驱动（不要 lookAt 抖动，用四元数平滑）。
- 飞行：默认 24 单位/秒巡航，Shift 加速到 90，松开回落到巡航；`throttle` 控制 0~1 推力（W/S），转向由 mouse 增量驱动 pitch/yaw，A/D 滚转。惯性感：速度矢量向机头方向插值（0.9 左右阻尼）。
- `warpTo`：0.9 秒内完成，视觉上拉出光条（自己实现，用点/线几何即可），到达后速度归零缓冲。
- 相机可被中键/滚轮微调距离（可选）。
