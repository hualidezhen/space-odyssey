// 深空方舟 · 任务线（纯逻辑模块）
// 契约：docs/FEATURES-CONTRACT.md 第 1 节
//   createMissions({ world, ship, onEvent }) -> {
//     list, index, active, progress,
//     update(dt, shipPos), current(), start(), reset(), completeNow(i), dispose()
//   }
// 本模块只做 Vector3 运算：不创建 Object3D、不接触 DOM、不加载外部资源。
import * as THREE from 'three';

/* ────────────────────────── 参数 ────────────────────────── */

/** 第 1 步「离站校准」：校准点在起飞点之外多远（世界单位） */
const DEPART_OFFSET = 40;
/** 第 1 步到达球半径（契约未指定，取值保证飞行中能稳定命中） */
const POINT_RADIUS = 12;
/** 第 6 步「返航」空间站对接半径 */
const STATION_RADIUS = 18;

/** world 未提供某颗行星时的兜底半径（与 world.js 的 BODY_CFG 一致） */
const FALLBACK_BODY_RADIUS = { mars: 1.2, jupiter: 9.0, saturn: 7.4, neptune: 3.4 };

/* ────────────────────────── 任务文案 ────────────────────────── */

const MISSION_DEFS = [
  {
    id: 'depart',
    cn: '离站校准',
    en: 'DEPARTURE CALIBRATION',
    kind: 'point',
    radius: POINT_RADIUS,
    label: '校准点 · CALIBRATION POINT',
    desc: '脱离深空方舟泊位，沿背离空间站的方向推进 40 个世界单位，校准惯性导航与姿态基准。',
    hint: 'W/S 控制推力，鼠标微调航向；抵达校准点后跃迁引擎将同步航路。',
  },
  {
    id: 'mars',
    cn: '火星勘测',
    en: 'MARS SURVEY',
    kind: 'body',
    body: 'mars',
    factor: 6,
    desc: '切入火星近拱点，扫描水手谷与极冠冰层，为方舟建立第一座深空中继信标。',
    hint: 'TAB 锁定火星后按 SPACE 跃迁至近轨道，再手动贴近到 6 倍行星半径以内。',
  },
  {
    id: 'jupiter',
    cn: '木星风暴观测',
    en: 'JUPITER STORM WATCH',
    kind: 'body',
    body: 'jupiter',
    factor: 3.5,
    desc: '掠过木星辐射带边缘，记录大红斑涡旋的风速剖面与磁场扰动。',
    hint: '跃迁抵达后向木星本体推进，进入 3.5 倍行星半径即可开始观测。',
  },
  {
    id: 'saturn',
    cn: '土星环穿越',
    en: 'SATURN RING TRANSIT',
    kind: 'body',
    body: 'saturn',
    factor: 4,
    desc: '借土星引力弹弓切入环系外侧，自卡西尼缝采样冰粒并记录环影。',
    hint: '环系宽而薄，保持航向穿过 4 倍行星半径的观测球面即可。',
  },
  {
    id: 'neptune',
    cn: '海王星·太阳系边缘',
    en: 'NEPTUNE · SOLAR FRONTIER',
    kind: 'body',
    body: 'neptune',
    factor: 4,
    desc: '抵达太阳系最外侧的蓝色巨行星，部署深空监听阵列，确认方舟航路的终点坐标。',
    hint: '这是最远的一程：先跃迁，再收拢到 4 倍行星半径以内，注意行星仍在高速公转。',
  },
  {
    id: 'return',
    cn: '返航·深空方舟',
    en: 'RETURN · DEEP SPACE ARK',
    kind: 'station',
    radius: STATION_RADIUS,
    label: '深空方舟 · DEEP SPACE ARK',
    desc: '航程闭环：返回地球轨道上的深空方舟，上传全部勘测数据，完成首次远征。',
    hint: '用跃迁引擎回到地球轨道，靠近空间站 18 个单位内即可自动对接。',
  },
];

/* ────────────────────────── 工具 ────────────────────────── */

const isVec3 = (v) => !!v
  && typeof v.x === 'number'
  && typeof v.y === 'number'
  && typeof v.z === 'number';

/* ────────────────────────── 工厂 ────────────────────────── */

export function createMissions({ world, ship, onEvent } = {}) {
  const listener = typeof onEvent === 'function' ? onEvent : null;
  const worldBodies = world && Array.isArray(world.bodies) ? world.bodies : [];

  function findBody(id) {
    if (world && typeof world.bodyById === 'function') {
      const b = world.bodyById(id);
      if (b) return b;
    }
    for (let i = 0; i < worldBodies.length; i++) {
      const b = worldBodies[i];
      if (b && b.id === id) return b;
    }
    return null;
  }

  // 6 步任务链（契约要求的字段：id / cn / en / desc / hint / target / radius / done）
  const list = MISSION_DEFS.map((def) => {
    let target;
    let radius;

    if (def.kind === 'point') {
      target = { kind: 'point', pos: new THREE.Vector3(), label: def.label };
      radius = def.radius;
    } else if (def.kind === 'body') {
      const body = findBody(def.body);
      const base = body && Number.isFinite(body.radius) ? body.radius : (FALLBACK_BODY_RADIUS[def.body] || 1);
      const bodyCn = body && body.cn ? body.cn : def.body.toUpperCase();
      const bodyEn = body && (body.en || body.name) ? (body.en || body.name) : def.body.toUpperCase();
      target = { kind: 'body', id: def.body, label: `${bodyCn} · ${bodyEn}` };
      radius = base * def.factor;
    } else {
      target = { kind: 'station', label: def.label };
      radius = def.radius;
    }

    return {
      id: def.id,
      cn: def.cn,
      en: def.en,
      desc: def.desc,
      hint: def.hint,
      target,
      radius,
      done: false,
    };
  });

  /* ── 运行状态 ── */
  const pointTarget = list[0].target;   // 第 1 步的 point 目标；pos 在 start() 时重写
  let index = 0;
  let started = false;
  let allEmitted = false;
  let pointReady = false;

  /* ── 复用向量（模块内部运算，不对外暴露） ── */
  const _shipPos = new THREE.Vector3();
  const _stationPos = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _tmp = new THREE.Vector3();

  /* ── 位置读取 ── */
  function readShipPos(src, out) {
    if (isVec3(src)) return out.set(src.x, src.y, src.z);
    const p = ship && ship.position;
    if (isVec3(p)) return out.set(p.x, p.y, p.z);
    return out.set(0, 0, 0);
  }

  function readStationPos(out) {
    const anchor = world && world.stationAnchor;
    if (isVec3(anchor)) return out.set(anchor.x, anchor.y, anchor.z);
    const sg = world && world.station && world.station.group && world.station.group.position;
    if (isVec3(sg)) return out.set(sg.x, sg.y, sg.z);
    const ec = world && world.earth && world.earth.center;
    if (isVec3(ec)) return out.set(ec.x, ec.y, ec.z);
    return out.set(0, 0, 0);
  }

  function targetPos(mission, out) {
    const t = mission.target;
    if (t.kind === 'body') {
      const body = findBody(t.id);
      if (body) {
        if (body.group && isVec3(body.group.position)) return out.copy(body.group.position);
        if (isVec3(body.position)) return out.copy(body.position);
      }
      return out.set(0, 0, 0);
    }
    if (t.kind === 'station') return readStationPos(out);
    return out.copy(t.pos);
  }

  /** 第一次 start()/current()/update() 时记录校准点：起飞点 + 背离空间站方向 × 40 */
  function captureDeparture() {
    readShipPos(undefined, _shipPos);
    readStationPos(_stationPos);
    _tmp.subVectors(_shipPos, _stationPos);
    if (_tmp.lengthSq() < 1e-8) _tmp.copy(_shipPos);   // 恰好重合时的兜底
    if (_tmp.lengthSq() < 1e-8) _tmp.set(1, 0, 0);
    _tmp.normalize();
    pointTarget.pos.copy(_shipPos).addScaledVector(_tmp, DEPART_OFFSET);
    pointReady = true;
  }

  /* ── 事件 ── */
  function emit(type, mission, idx) {
    if (!listener) return;
    try {
      listener({ type, mission, index: idx });
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) console.error('[missions] onEvent 回调异常：', err);
    }
  }

  /* ── 对外方法 ── */

  /** 开始/重开任务线：index 归零，按当前 ship.position 重记第 1 步校准点 */
  function start() {
    index = 0;
    started = true;
    allEmitted = false;
    pointReady = false;
    for (let i = 0; i < list.length; i++) list[i].done = false;
    captureDeparture();
    emit('start', list[0], 0);
    return list[0];
  }

  /** 复位到未开始状态（不触发事件）；下次 start() 会重新记录校准点 */
  function reset() {
    index = 0;
    started = false;
    allEmitted = false;
    pointReady = false;
    pointTarget.pos.set(0, 0, 0);
    for (let i = 0; i < list.length; i++) list[i].done = false;
    return api;
  }

  /**
   * 每帧检测：shipPos 进入当前任务半径 → 完成当前任务并推进。
   * 返回是否发生了推进（便于调试）。未调用 start() 时容错自动开始（不重复抛 start 事件）。
   * @param {number} dt      帧时长（本模块为纯几何判定，不使用，保留契约签名）
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [shipPos] 不传则读 ship.position
   */
  function update(dt, shipPos) {
    void dt;
    if (index >= list.length) return false;
    if (!started) {
      started = true;
      if (!pointReady) captureDeparture();
    }

    readShipPos(shipPos, _shipPos);
    const mission = list[index];
    targetPos(mission, _target);
    const distance = _shipPos.distanceTo(_target);
    if (distance > mission.radius) return false;

    // 抵达：先标记完成、发 complete，再推进并发 start / all
    mission.done = true;
    const doneIndex = index;
    emit('complete', mission, doneIndex);
    index = doneIndex + 1;
    if (index >= list.length) {
      if (!allEmitted) {
        allEmitted = true;
        emit('all', list[list.length - 1], list.length);
      }
    } else {
      emit('start', list[index], index);
    }
    return true;
  }

  /**
   * 当前任务信息（供 HUD / 罗盘）：
   * { mission, distance, dir, arrived }；全部完成后返回 null。
   * distance 为世界单位（到行星中心的距离），dir = (target - shipPos).normalize()。
   */
  function current() {
    if (index >= list.length) return null;
    if (!pointReady) captureDeparture();
    readShipPos(undefined, _shipPos);
    const mission = list[index];
    targetPos(mission, _target);
    const distance = _shipPos.distanceTo(_target);
    const dir = new THREE.Vector3().subVectors(_target, _shipPos).normalize();
    return { mission, distance, dir, arrived: distance <= mission.radius };
  }

  /**
   * 调试用：直接完成第 i 个任务（0-based）。
   * 若 i 在当前进度之后，会依次完成 index..i（并逐个发 complete 事件）。
   * 越界/非整数/已完成的任务返回 false 且不改变状态。
   */
  function completeNow(i) {
    if (!Number.isInteger(i)) return false;
    if (i < 0 || i >= list.length) return false;
    if (index >= list.length) return false;
    if (i < index) return false;

    for (let k = index; k <= i; k++) {
      const mission = list[k];
      if (!mission.done) mission.done = true;
      emit('complete', mission, k);
    }
    index = i + 1;
    if (index >= list.length) {
      if (!allEmitted) {
        allEmitted = true;
        emit('all', list[list.length - 1], list.length);
      }
    } else {
      emit('start', list[index], index);
    }
    return true;
  }

  /** 纯逻辑模块无 GPU 资源，保留空实现以符合「每个模块提供 dispose()」的约束 */
  function dispose() {}

  const api = {
    list,
    get index() { return index; },
    get active() { return index < list.length ? list[index] : null; },
    get progress() { return index / list.length; },
    update,
    current,
    start,
    reset,
    completeNow,
    dispose,
  };

  return api;
}
