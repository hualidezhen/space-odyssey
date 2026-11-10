# 扩展功能契约（v2）

在现有 `src/main.js` 状态机（`title | orbit | flight`）上新增三种模式：

| 模式 | 说明 | 进入方式 |
|---|---|---|
| `flight` | 已有：第三人称飞行 | 已有 |
| `interior` | **新增**：空间站内部第一人称漫游（独立 scene + camera） | 环绕视角按 `I` |
| `planet` | **新增**：行星特写展厅（独立 scene + camera） | 任意视角按 `P`，或用 `←/→` 切换星球 |

任务线跨全部模式常驻：HUD 左上角显示当前目标、距离、完成度；到达目标即推进。

**文件归属（严格）**
- `src/missions.js`、`src/interior.js`、`src/planetarium.js` 由各自负责人独占。
- `index.html` / `src/main.js` / `src/postfx.js` / `src/world.js` / `src/station.js` / `src/ship.js` **禁止改动**（Lead 负责集成）。
- 禁止任何外部资源（贴图/字体/模型/CDN），全部程序化；`three` 从 importmap 拿。

**通用约束**
- 纯 ES Module，`node --check <file>` 必须通过。
- 渲染器由 Lead 提供，`renderer.getPixelRatio()`、`renderer.getSize(v2)` 可用。
- 每个模块必须提供 `dispose()` 释放 GPU 资源（Lead 调试时会调用）。
- 性能：模块自身 draw call ≤ 120，三角面 ≤ 8 万；`update(dt)` JS 侧 ≤ 1.5ms。
- 时间参数 `dt` 已 clamp 到 ≤0.05，`t` 为全局秒数。
- 相机/场景由模块内部持有，Lead 每帧调用 `update(dt, t, input)` 后直接渲染模块的 `scene`/`camera`。

---

## 1) `src/missions.js` — 任务线

```js
import { createMissions } from './missions.js';

const missions = createMissions({
  world,            // createWorld 的返回值（有 bodies / bodyById / stationAnchor / sunPosition）
  ship,             // createShip 的返回值（有 position / state）
  onEvent,          // (evt) => void; evt = { type:'start'|'complete'|'all'|'fail', mission, index }
});
```

返回对象：
```js
{
  list,              // [{ id, cn, en, desc, hint, target:{kind:'body'|'station'|'point', id?, pos?, label}, radius, done }]
  index,             // 当前任务下标（0-based），全部完成时 === list.length
  active,            // 当前任务对象或 null
  progress,          // 0..1
  update(dt, shipPos),          // 每帧调用：检测到达、推进任务、回调 onEvent
  current(),                    // { mission, distance, dir:THREE.Vector3, arrived:boolean } 或 null
  start(),                      // 开始任务线（把 index 归零）
  reset(),                      // 复位
  completeNow(i),               // 调试用：直接完成第 i 个
}
```

任务线内容（固定 6 步，文案自己写得有科幻感，中文为主）：
1. **离站校准** — 起飞后离开空间站 40 单位（`kind:'point'`，pos = 起飞点附近）
2. **火星勘测** — 抵达火星（`radius` 取火星半径 ×6）
3. **木星风暴观测** — 抵达木星（radius ×3.5）
4. **土星环穿越** — 抵达土星（radius ×4）
5. **海王星·太阳系边缘** — 抵达海王星（radius ×4）
6. **返航·深空方舟** — 回到空间站（radius 18）

要求：
- `distance` 用世界单位；`dir` 是 `(target - shipPos).normalize()`，供 HUD 罗盘使用。
- 第 1 步用 `kind:'point'`，起点在 `ship.position` 首次 `start()` 时记录，偏移 40 单位沿远离空间站方向。
- 全部完成后 `onEvent({type:'all'})` 且 `index === list.length`。
- 纯逻辑模块，**不创建任何 Object3D**、不碰 DOM。

---

## 2) `src/interior.js` — 空间站内部漫游

```js
import { createInterior } from './interior.js';

const interior = createInterior({ renderer, quality });
```

返回对象：
```js
{
  scene, camera,          // 独立场景与相机（Lead 负责渲染）
  group,                  // 内部根节点（可选，方便 dispose）
  isInside,               // 是否在内部
  enter(t),               // 进入：重置玩家到气闸舱，黑场由 Lead 做
  exit(),                 // 离开
  update(dt, t, input),   // input = { forward, back, left, right, run, lookX, lookY }
  hotspots,               // [{ id, cn, desc, pos:THREE.Vector3 }]
  interact(),             // 返回最近的可交互点（距离 < 2.2）或 null
  position,               // 玩家世界坐标（Vector3，可读）
  dispose()
}
```

设计要求：
- 第一人称**步行**（不飞行）：眼高 1.62、步速 2.6 m/s、`run` 时 4.6，带加速/减速阻尼与轻微头部晃动。
- `lookX/lookY` 是**每帧增量**（弧度），内部累加到 yaw/pitch，pitch 限制 ±80°。
- 空间体量用「米」为单位建（站体外部 2.4 单位 ≈ 120 米），内部单独一套尺度即可，不需要和外部严格对齐。
- 结构：气闸舱（出生点）→ 主通道 → 中央环形大厅（三层挑空、可俯视轮毂）→ 三条支廊（观景廊 / 实验舱 / 指挥席）。走廊带肋框、地板导光条、舷窗、管道、告示牌。
- 别做真实碰撞物理：用**走廊/房间的 AABB 白名单**限制玩家位置（在任意房间盒内即可移动，不能穿墙）；实现方式自选（列出 rect 列表，把位置夹到最近盒内）。
- **观景廊必须有一个朝向地球的大舷窗**（窗外用内部自建的星空 + 一个地球球体，或直接黑底+星点+蓝色弧线，不必接主场景 world）。
- 至少 6 个 `hotspots`：观景窗、指挥席、实验台、住舱、舷梯、反应堆监视屏；`interact()` 返回具体对象，Lead 用它显示检视卡。
- 光照：内部自己打光（暖白顶灯 + 青色指示灯 + 应急橙），允许用 `MeshStandardMaterial` + 少量自发光，**不要后期依赖**（Lead 会用同一套 postfx，参数较温和）。
- 出口：气闸舱处返回 `interact()` 一个 `{ id:'exit' }` 的热点，Lead 处理退出。

---

## 3) `src/planetarium.js` — 行星特写展厅

```js
import { createPlanetarium } from './planetarium.js';

const planetarium = createPlanetarium({ renderer, quality });
```

返回对象：
```js
{
  scene, camera,
  isOpen,
  bodies,                 // [{ id, cn, en, desc, stats:[{k,v}], radius }]
  open(id, t),            // 打开某颗星球（id ∈ bodies）
  close(),
  next(), prev(),         // 切换星球
  current,                // 当前 body 对象
  update(dt, t, input),   // input = { dragX, dragY, zoom, auto }（drag 为每帧增量）
  dispose()
}
```

首批必须支持 4 颗：`saturn`（土星环特写）、`jupiter`（大红斑风暴）、`earth`（地球夜景 + 城市灯）、`mars`（水手谷/极冠）。
- 每颗用**高细分球**（球体 ≥ 128×96）+ 自写 shader，比主场景版本更细腻：
  - `saturn`：环系分层（C/B/A 环 + Cassini 缝 + 环影 + 小卫星），球体云带柔和。
  - `jupiter`：纬向条带 + 涡旋 fbm，**大红斑**用旋转椭圆域扭曲做出风暴眼墙。
  - `earth`：大陆/海洋/云 + 夜侧城市灯，允许沿用主场景思路但重写得更锐。
  - `mars`：铁锈色 + 极冠 + 峡谷/撞击坑（噪声脊）。
- 机位：默认 3/4 侧光、缓慢自转 + 轻微自动环绕；`dragX/dragY` 改变环绕角，`zoom` 改变距离（clamp 1.4R~8R）。
- 每颗星球给出 `stats`（直径/公转/自转/温度/趣味点），Lead 渲染到 HUD。
- 背景自建深空（星点 + 星云薄雾），不要用主场景的 world。

---

## 集成方式（Lead 负责，供参考）

1. `postfx` 增加 `use(scene, camera)`：把内部 `RenderPass` 的 scene/camera 换成模块的，退出时换回主场景。
2. `main.js` 状态机新增 `interior` / `planet` 两个状态，切换走已有的 `transitionTo()`（黑场 0.5s → 换场景 → 1.4s 亮起）。
3. HUD 新增：`#mission-panel`（任务线）、`#nav-arrow`（目标罗盘箭头）、`#interior-panel`（热点卡 + 操作提示）、`#planet-panel`（星球档案）、`#planet-tabs`。
4. 键位：`I` 进/出空间站内部；`P` 进/出行星展厅；`←/→` 展厅内切换星球；`Esc` 退出当前子模式；`J` 折叠任务面板。
