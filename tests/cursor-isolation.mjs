/**
 * cursor-isolation.mjs —— 真实鼠标指针隔离回归测试（纯离线：桩化 deps.cuaCall，不启动引擎、不动真实鼠标）。
 *
 * ## 引擎事实（cua-driver 0.28.2 实测，见 evidence/real-pointer-probe/）
 *  1. move_cursor + target:{kind:'window',...}（插件滑行载荷）→ 只动 overlay，真实指针不动。
 *  2. move_cursor + scope:'window' + target → 引擎 invalid_action_target 拒绝
 *     ⇒ 滑行绝不能加 scope（上一轮「每段都加 scope」是错误假设，会让滑行静默失效）。
 *  3. click 前台投递（delivery_mode:foreground，route:global_input）→ 把真实指针搬到落点且不还原。
 *  4. move_cursor + scope:'desktop' → 精确把真实指针搬回 (x,y)（唯一的还原手段）。
 *  5. 后台 click / drag / scroll / press_key / hotkey → 不动真实指针。
 *
 * ## 断言范围（A–I）
 *  A glideCursor：先 set_agent_cursor_motion（单段定时缓动），再**一次** move_cursor；
 *    载荷 {x,y,target,session} 且不含 scope；坐标=精确目标；链式续滑；抛错不阻断。
 *  B 无 target 兜底：必须补 scope:'window'（否则引擎按 desktop 搬真实指针）。
 *  C 默认后台点击：照旧滑行；click 载荷不变；全程 0 次 get_cursor_position（不给普通点击加延迟）。
 *  D 显式前台：点击前恰 1 次读指针；click 返回 foreground/global_input →
 *    **立即** move_cursor scope:'desktop' 还原到 before + repark overlay 到落点 →
 *    最后复核一次指针并写入 guard.after；restored/reparked === true、after≈before。
 *    调用顺序固定为 before-read → click → restore → repark → after-read。
 *  E 复核读回远离 before（用户自己动过 / 还原失败）→ restored === false，
 *    但还原调用与 repark 仍然发生过（立即还原不依赖复核结果）。
 *  F restorePointer:false → 不读指针、不还原。
 *  G token 路径载荷逐字段不变；token + foreground 时守卫按 sx/sy 算落点并还原。
 *  H actions.js 集成：restorePointer 透传、background_unavailable 自动前台重投、
 *    cfg.restoreRealPointer=false、结果文案（已放回原位）。
 *  I 保留旧断言中仍然成立的项（deliveryMode / fromZoom 不滑行、非前台 route 不还原）。
 *  Z 全局审计：move_cursor 只允许三种合法载荷形状（绝不 scope+target 并存）；click 不带 scope。
 *
 * ## 运行 / 退出码
 *   node verify-scripts/cursor-isolation.mjs      → 0 = 全过，1 = 有失败
 *   node --check verify-scripts/cursor-isolation.mjs
 *
 * ## 阴性对照（证明测试真能抓住回归；把 plugin/lib 与本文件复制到临时目录后做突变，必须退出码 1）
 *   M1 守卫失效：mayWarpPointer 恒 false                      → D/G/H 段 FAIL
 *   M2 去掉无 target 的 scope:'window' 兜底                     → B 段 FAIL
 *   M3 滑行一律加 scope:'window'（上一轮的错误假设）           → A/C/G 段 FAIL
 *   M4 后台点击也进守卫：mayWarpPointer = restorePointer       → C 段 FAIL
 *   M5 去掉复核回退（不把 restored 标记回 false）              → E 段 FAIL
 */
import * as human from '../lib/human.js'
import * as actions from '../lib/actions.js'
import { setSnapshot } from '../lib/snapshot.js'
import { CUA_SESSION, cuaCall } from '../lib/cua.js'

// ── 测试约定常量（与 human.js 内部实现常量保持一致） ────────────────────
const PID = 4242
const WID = 777
/** 测试窗口在屏幕上的位置：humanClick 的 cursorPointFor 会把它加到 PNG 坐标上。 */
const BOUNDS = { x: 100, y: 50, width: 800, height: 600 }
/** glideCursor 的窗口 target（插件真实滑行载荷）。 */
const TARGET = { target: { kind: 'window', pid: PID, window_id: WID } }
/** human.js 现在是「1 次 set_agent_cursor_motion + 1 次 move_cursor」的单段缓动。 */
const GLIDE_CALLS = 1
/** set_agent_cursor_motion 的载荷字段（会话 + 运动参数，键名按 keysOf 的排序）。 */
const MOTION_KEYS = 'arc_flow,arc_size,glide_duration_ms,session,spring,turn_radius'

// ── PASS/FAIL 记账 ───────────────────────────────────────────────────
let pass = 0
let fail = 0
const failures = []
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`PASS  ${name}${detail ? ' :: ' + detail : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`)
  }
}

// ── 断言小工具 ──────────────────────────────────────────────────────
const keysOf = (obj) => Object.keys(obj || {}).sort().join(',')
const keySet = (...names) => names.slice().sort().join(',')
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps
const nearPoint = (a, b, tol = 0) => !!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol)
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fmt = (p) => (p ? `(${p.x},${p.y})` : 'null')

// ── 桩基础设施：所有引擎调用都被记录，绝不落到真实 cua-driver ─────────
let calls = []
/** 全量审计（跨段累积；用于最后的载荷形状审计）。 */
const audit = []

/**
 * 装桩：替换 human.js 的 deps.cuaCall。
 * @param {(tool:string,args:object)=>any} [impl] 返回值实现；抛错会原样冒泡给被测代码
 */
function stub(impl) {
  human.deps.cuaCall = async (tool, args = {}) => {
    const rec = { tool, args: { ...args } }
    calls.push(rec)
    audit.push(rec)
    return impl ? await impl(tool, args) : { ok: true }
  }
}

const resetCalls = () => { calls = [] }
const callsOf = (tool) => calls.filter((c) => c.tool === tool)
const moveCalls = () => callsOf('move_cursor')
const readCalls = () => callsOf('get_cursor_position')
const clickCalls = () => callsOf('click')

/** 与 observe.js 落库形状一致的快照（humanClick 用它换算屏幕点 / actions.js 用它解析窗口）。 */
function freshSnapshot(extra = {}) {
  setSnapshot({
    at: Date.now(),
    ttlMs: 60000,
    pid: PID,
    windowId: WID,
    appName: 'cursor-isolation-test',
    snapshotId: 'snap-test',
    entries: new Map(),
    elementCount: 0,
    totalElementCount: 0,
    mode: 'ax',
    space: {
      pngW: BOUNDS.width, pngH: BOUNDS.height,
      bounds: { ...BOUNDS }, scaleX: 1, scaleY: 1, downscaled: false,
    },
    frameSpace: 'png',
    zoom: null,
    ...extra,
  })
}

// 引擎返回形状：前台投递（真实指针会被搬动的那条路径）
const CLICK_FG = { effect: 'ok', delivery: { mode: 'foreground' }, route: 'global_input' }

try {
  // ══════════════════════════════════════════════════════════════════
  // 0. 契约与注入点
  // ══════════════════════════════════════════════════════════════════
  console.log('── 0. 契约与注入点 ──')
  check('0a deps.cuaCall 可注入且默认就是 cua.js 的 cuaCall（生产行为不变）', human.deps.cuaCall === cuaCall)
  check('0b actions.deps.humanClick 默认就是 human.js 的 humanClick', actions.deps.humanClick === human.humanClick)
  const api = [
    'isForegroundRoute', 'readRealPointer', 'restoreRealPointer', 'reparkOverlay',
    'withPointerGuard', 'getLastPointerGuard', 'resetPointerGuard', 'cursorPointFor',
    'getLastAgentPoint', 'glideCursor', 'humanClick',
  ]
  const missingApi = api.filter((name) => typeof human[name] !== 'function')
  check('0c 指针守卫 API 全部导出', missingApi.length === 0, missingApi.length ? `缺 ${missingApi.join(',')}` : `${api.length} 个`)
  check('0d isForegroundRoute：delivery.mode=foreground → true', human.isForegroundRoute({ delivery: { mode: 'foreground' } }) === true)
  check('0e isForegroundRoute：route=global_input → true', human.isForegroundRoute({ route: 'global_input' }) === true)
  check(
    '0f isForegroundRoute：后台投递 / 普通结果 / 空值 → false',
    human.isForegroundRoute({ delivery: { mode: 'background' }, route: 'window_input' }) === false
      && human.isForegroundRoute({ effect: 'ok' }) === false
      && human.isForegroundRoute(null) === false
      && human.isForegroundRoute('global_input') === false,
  )
  check('0g 初始 lastAgentPoint = null（进程内首次滑行从目标点起步）', human.getLastAgentPoint() === null, fmt(human.getLastAgentPoint()))

  // ══════════════════════════════════════════════════════════════════
  // A. glideCursor：set_motion（单段定时缓动）+ 一次 move_cursor
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── A. glideCursor：单段缓动 + 只动 overlay 的滑行载荷 ──')
  freshSnapshot()
  stub()
  resetCalls()
  const T1 = { x: 500, y: 300 }
  await human.glideCursor(T1.x, T1.y, TARGET)
  const moves1 = moveCalls()
  const motions1 = callsOf('set_agent_cursor_motion')
  check('A1 只发 1 次 move_cursor（不再有插件侧 6 段插值）', moves1.length === GLIDE_CALLS, `实际 ${moves1.length}`)
  check(
    'A2 载荷恰为 {session,x,y,target}，不含 scope（含 scope+target 会被引擎拒绝）',
    moves1.every((c) => keysOf(c.args) === keySet('session', 'x', 'y', 'target')),
    moves1.map((c) => keysOf(c.args)).find((k) => k !== keySet('session', 'x', 'y', 'target')) || 'ok',
  )
  check(
    'A3 绑定同一窗口 target（只动 overlay 的依据）',
    moves1.every((c) => c.args.target?.kind === 'window'
      && c.args.target?.pid === PID && c.args.target?.window_id === WID),
  )
  check('A4 使用同一 overlay 会话', moves1.every((c) => c.args.session === CUA_SESSION), CUA_SESSION)
  check('A5 坐标精确等于目标（动画终点由引擎负责，不再逐段插值）',
    moves1[0]?.args.x === T1.x && moves1[0]?.args.y === T1.y, `实际${fmt(moves1[0]?.args)}`)
  check('A6 先设运动参数再移动（1 次 set_agent_cursor_motion）', motions1.length === 1
    && calls.findIndex((c) => c.tool === 'set_agent_cursor_motion') < calls.findIndex((c) => c.tool === 'move_cursor'),
  `motion=${motions1.length}`)
  const m1 = motions1[0]?.args || {}
  check('A7 运动参数 = 单段定时缓动（glide_duration_ms 为正且 ≤ 2000，键集合不变）',
    keysOf(m1) === MOTION_KEYS
      && m1.session === CUA_SESSION
      && Number.isFinite(m1.glide_duration_ms) && m1.glide_duration_ms > 0 && m1.glide_duration_ms <= 2000,
    JSON.stringify(m1))
  check('A8 lastAgentPoint 更新为落点', nearPoint(human.getLastAgentPoint(), T1, 0), fmt(human.getLastAgentPoint()))

  // A9-A11：链式续滑（载荷形状不变、落点精确、lastAgentPoint 推进）
  resetCalls()
  const T2 = { x: 700, y: 400 }
  await human.glideCursor(T2.x, T2.y, TARGET)
  const moves2 = moveCalls()
  check('A9 链式续滑仍 1 次且载荷形状不变', moves2.length === GLIDE_CALLS
    && moves2.every((c) => keysOf(c.args) === keySet('session', 'x', 'y', 'target')), `实际 ${moves2.length}`)
  check('A10 落点精确等于新目标', moves2[0]?.args.x === T2.x && moves2[0]?.args.y === T2.y,
    `实际${fmt(moves2[0]?.args)}`)
  check('A11 lastAgentPoint 前进到新目标', nearPoint(human.getLastAgentPoint(), T2, 0), fmt(human.getLastAgentPoint()))

  // A12-A14：best-effort，move_cursor 抛错不阻断
  stub((tool) => {
    if (tool === 'move_cursor') throw new Error('engine down（测试桩）')
    return { ok: true }
  })
  resetCalls()
  const T3 = { x: 900, y: 520 }
  let glideErr = null
  try {
    await human.glideCursor(T3.x, T3.y, TARGET)
  } catch (err) {
    glideErr = err
  }
  check('A12 move_cursor 抛错时 glideCursor 不抛错（不阻断后续点击）', glideErr === null, glideErr?.message || '')
  check('A13 失败时只尝试了 1 次', moveCalls().length === GLIDE_CALLS, `实际 ${moveCalls().length}`)
  check('A14 失败时 lastAgentPoint 仍推进到目标', nearPoint(human.getLastAgentPoint(), T3, 0), fmt(human.getLastAgentPoint()))

  // ══════════════════════════════════════════════════════════════════
  // B. glideCursor 无 target：必须补 scope:'window' 兜底
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── B. glideCursor 无 target：补 scope=window 兜底 ──')
  stub()
  resetCalls()
  const B1 = { x: 810, y: 410 }
  await human.glideCursor(B1.x, B1.y) // 故意不给 target
  const movesB = moveCalls()
  check('B1 无 target 时仍发出 1 次 move_cursor', movesB.length === GLIDE_CALLS, `实际 ${movesB.length}`)
  check(
    'B2 无 target 时补 scope=window（否则引擎按 desktop 搬真实指针）',
    movesB.length === GLIDE_CALLS && movesB.every((c) => c.args.scope === 'window'),
    movesB.map((c) => String(c.args.scope)).join(','),
  )
  check(
    'B3 无 target 时载荷恰为 {session,x,y,scope}',
    movesB.every((c) => keysOf(c.args) === keySet('session', 'x', 'y', 'scope')),
    movesB.map((c) => keysOf(c.args)).find((k) => k !== keySet('session', 'x', 'y', 'scope')) || 'ok',
  )
  check('B4 无 target 时绝不落 desktop 作用域', movesB.every((c) => c.args.scope !== 'desktop'))
  check('B5 无 target 时落点精确等于目标', movesB[0]?.args.x === B1.x && movesB[0]?.args.y === B1.y,
    `落点=${fmt(movesB[0]?.args)}`)

  // ══════════════════════════════════════════════════════════════════
  // C. 默认后台点击：照旧滑行、0 次 get_cursor_position
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── C. humanClick 默认后台投递：不读指针、不加延迟 ──')
  freshSnapshot()
  human.resetPointerGuard()
  const CLICK_BG = { effect: 'ok', delivery: { mode: 'background' }, route: 'window_input' }
  stub((tool) => {
    if (tool === 'click') return CLICK_BG
    if (tool === 'get_cursor_position') return { x: 1, y: 2 }
    return { ok: true }
  })
  resetCalls()
  const valueC = await human.humanClick({ pid: PID, windowId: WID, x: 120, y: 80, sx: 120, sy: 80 })
  const movesC = moveCalls()
  const clicksC = clickCalls()
  const expectedC = human.cursorPointFor(120, 80)
  check('C1 默认后台点击照旧滑行（1 次 move_cursor）', movesC.length === GLIDE_CALLS, `实际 ${movesC.length}`)
  check(
    'C2 滑行载荷全部带 target 且不含 scope',
    movesC.every((c) => c.args.target?.window_id === WID && !('scope' in c.args)),
  )
  check('C3 全程 0 次 get_cursor_position（不给普通点击增加引擎往返延迟）', readCalls().length === 0, `实际 ${readCalls().length}`)
  check('C4 只发出 1 次 click', clicksC.length === 1, `实际 ${clicksC.length}`)
  const pC = clicksC[0]?.args || {}
  check(
    'C5 坐标点击载荷逐字段不变',
    keysOf(pC) === keySet('session', 'pid', 'window_id', 'x', 'y', 'count', 'button')
      && pC.session === CUA_SESSION && pC.pid === PID && pC.window_id === WID
      && pC.x === 120 && pC.y === 80 && pC.count === 1 && pC.button === 'left',
    JSON.stringify(pC),
  )
  check('C6 顺序正确：滑行（motion → move）之后才 click',
    calls.findIndex((c) => c.tool === 'set_agent_cursor_motion') >= 0
      && calls.findIndex((c) => c.tool === 'move_cursor') >= 0
      && calls.findIndex((c) => c.tool === 'move_cursor') < calls.findIndex((c) => c.tool === 'click')
      && calls.findIndex((c) => c.tool === 'set_agent_cursor_motion') < calls.findIndex((c) => c.tool === 'move_cursor'),
    calls.map((c) => c.tool).join(' → '))
  check(
    'C7 滑行落点 = cursorPointFor(sx,sy) = 窗口左上角 + PNG 坐标',
    movesC[0]?.args.x === expectedC.x && movesC[0]?.args.y === expectedC.y,
    `实际${fmt(movesC[0]?.args)} 期望${fmt(expectedC)}`,
  )
  check('C8 lastAgentPoint = 目标屏幕点', nearPoint(human.getLastAgentPoint(), expectedC, 0), fmt(human.getLastAgentPoint()))
  check('C9 后台点击不进入指针守卫（getLastPointerGuard 为 null）', human.getLastPointerGuard() === null)
  check('C10 引擎返回值原样透传', jsonEq(valueC, CLICK_BG))

  // ══════════════════════════════════════════════════════════════════
  // D. 显式前台：立即还原 → repark（before→click→restore→repark，不做复核）
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── D. humanClick 显式前台：点击后立即把真实指针放回原位 ──')
  freshSnapshot()
  human.resetPointerGuard()
  const BEFORE_D = { x: 100, y: 200 }
  stub((tool) => {
    if (tool === 'get_cursor_position') return { ...BEFORE_D }
    if (tool === 'click') return { ...CLICK_FG }
    return { ok: true }
  })
  resetCalls()
  const expectedD = human.cursorPointFor(120, 80)
  const valueD = await human.humanClick({
    pid: PID, windowId: WID, x: 120, y: 80, sx: 120, sy: 80, deliveryMode: 'foreground',
  })
  const dCalls = calls
  const dClickIdx = dCalls.findIndex((c) => c.tool === 'click')
  const dReads = dCalls.filter((c) => c.tool === 'get_cursor_position')
  const dReadBefore = dCalls.slice(0, dClickIdx).filter((c) => c.tool === 'get_cursor_position')
  const dReadAfter = dCalls.slice(dClickIdx + 1).filter((c) => c.tool === 'get_cursor_position')
  const dMoves = dCalls.filter((c) => c.tool === 'move_cursor')
  const dRestore = dMoves.find((c) => c.args.scope === 'desktop')
  const dRepark = dMoves.find((c) => c.args.target)
  const dRestoreIdx = dCalls.indexOf(dRestore)
  const dReparkIdx = dCalls.indexOf(dRepark)
  const dSecondReadIdx = dCalls.indexOf(dReadAfter[0])
  const dClicks = dCalls.filter((c) => c.tool === 'click')
  check('D1 只发出 1 次 click', dClicks.length === 1, `实际 ${dClicks.length}`)
  check('D2 get_cursor_position 只在 click 之前读 1 次（不做事后复核）',
    dReads.length === 1 && dReadBefore.length === 1 && dReadAfter.length === 0,
    `总 ${dReads.length} 次（前 ${dReadBefore.length} / 后 ${dReadAfter.length}）`)
  const pD = dClicks[0]?.args || {}
  check(
    'D3 click 载荷含 delivery_mode=foreground 且不含 scope/指针字段',
    keysOf(pD) === keySet('session', 'pid', 'window_id', 'x', 'y', 'count', 'button', 'delivery_mode')
      && pD.delivery_mode === 'foreground' && pD.x === 120 && pD.y === 80,
    JSON.stringify(pD),
  )
  check('D4 共 2 次 move_cursor（前台不滑行：点击前 0 次移动）', dMoves.length === 2
    && dCalls.slice(0, dClickIdx).filter((c) => c.tool === 'move_cursor').length === 0,
  `实际 ${dMoves.length}`)
  check(
    'D5 还原调用 = move_cursor + scope:desktop + 坐标恰为动作前指针，且不带 target',
    !!dRestore && keysOf(dRestore.args) === keySet('session', 'x', 'y', 'scope')
      && dRestore.args.scope === 'desktop'
      && dRestore.args.x === BEFORE_D.x && dRestore.args.y === BEFORE_D.y
      && !('target' in dRestore.args),
    dRestore ? JSON.stringify(dRestore.args) : '未发出还原调用',
  )
  check(
    'D6 顺序正确：click → 立即还原 → repark（不做复核读指针）',
    dClickIdx > -1 && dRestoreIdx > dClickIdx && dReparkIdx > dRestoreIdx && dReads.length === 1,
    `click=${dClickIdx} restore=${dRestoreIdx} repark=${dReparkIdx} reads=${dReads.length}`,
  )
  check(
    'D7 repark = move_cursor 带窗口 target 且坐标=落点（overlay 继续停在目标上）',
    !!dRepark && keysOf(dRepark.args) === keySet('session', 'x', 'y', 'target')
      && dRepark.args.target?.pid === PID && dRepark.args.target?.window_id === WID
      && dRepark.args.x === expectedD.x && dRepark.args.y === expectedD.y
      && !('scope' in dRepark.args),
    dRepark ? JSON.stringify(dRepark.args) : '未发出 repark 调用',
  )
  const gD = human.getLastPointerGuard() || {}
  check('D8 守卫记录 before=动作前指针、after=null（不做复核）',
    jsonEq(gD.before, BEFORE_D) && gD.after === null,
    `before=${fmt(gD.before)} after=${fmt(gD.after)}`)
  check('D9 还原调用成功 ⇒ getLastPointerGuard().restored === true', gD.restored === true, JSON.stringify(gD))
  check('D10 getLastPointerGuard().reparked === true', gD.reparked === true)
  check('D11 不做事后复核（after=null，少一次引擎读取）', gD.after === null, fmt(gD.after))
  check('D12 lastAgentPoint = 落点（overlay 复停在点击目标）', nearPoint(human.getLastAgentPoint(), expectedD, 0),
    fmt(human.getLastAgentPoint()))
  check('D13 引擎返回值原样透传', jsonEq(valueD, CLICK_FG))

  // ══════════════════════════════════════════════════════════════════
  // E. 还原调用失败 → restored=false（不抛错、不中断点击结果）
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── E. 还原调用失败 → restored=false（点击本身不受影响）──')
  freshSnapshot()
  human.resetPointerGuard()
  const BEFORE_E = { x: 100, y: 200 }
  stub((tool, args) => {
    if (tool === 'get_cursor_position') return { ...BEFORE_E }
    if (tool === 'move_cursor' && args.scope === 'desktop') throw new Error('restore failed (mock)')
    if (tool === 'click') return { ...CLICK_FG }
    return { ok: true }
  })
  resetCalls()
  const valueE = await human.humanClick({
    pid: PID, windowId: WID, x: 120, y: 80, sx: 120, sy: 80, deliveryMode: 'foreground',
  })
  const eCalls = calls
  const eMoves = eCalls.filter((c) => c.tool === 'move_cursor')
  const eRestore = eMoves.find((c) => c.args.scope === 'desktop')
  const eRepark = eMoves.find((c) => c.args.target)
  const eReads = eCalls.filter((c) => c.tool === 'get_cursor_position')
  const gE = human.getLastPointerGuard() || {}
  check('E1 只在点击前读 1 次指针（不做事后复核）', eReads.length === 1, `实际 ${eReads.length}`)
  check(
    'E2 仍然尝试了还原调用（desktop + 坐标=before + 无 target）',
    !!eRestore && eRestore.args.scope === 'desktop'
      && eRestore.args.x === BEFORE_E.x && eRestore.args.y === BEFORE_E.y
      && !('target' in eRestore.args),
    eRestore ? JSON.stringify(eRestore.args) : '未发出还原调用',
  )
  check(
    'E3 还原失败也照样 repark（overlay 停到落点）',
    !!eRepark && eRepark.args.target?.window_id === WID,
    eRepark ? JSON.stringify(eRepark.args) : '未发出 repark 调用',
  )
  check('E4 还原调用失败 ⇒ restored === false（如实标记，不冒充成功）', gE.restored === false, JSON.stringify(gE))
  check('E5 守卫 before=动作前指针、after=null', jsonEq(gE.before, BEFORE_E) && gE.after === null,
    `before=${fmt(gE.before)} after=${fmt(gE.after)}`)
  check('E6 reparked === true（overlay 复停独立于指针还原）', gE.reparked === true)
  check('E7 引擎返回值原样透传（点击结果不受还原失败影响）', jsonEq(valueE, CLICK_FG))

  // ══════════════════════════════════════════════════════════════════
  // F. restorePointer:false → 不读指针、不还原
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── F. restorePointer:false → 完全跳过指针守卫 ──')
  freshSnapshot()
  human.resetPointerGuard()
  stub()
  resetCalls()
  const valueF = await human.humanClick({
    pid: PID, windowId: WID, x: 120, y: 80, sx: 120, sy: 80,
    deliveryMode: 'foreground', restorePointer: false,
  })
  const pF = clickCalls()[0]?.args || {}
  check('F1 0 次 get_cursor_position（连动作前读取都省掉）', readCalls().length === 0, `实际 ${readCalls().length}`)
  check('F2 0 次 move_cursor（无还原、无 repark）', moveCalls().length === 0, `实际 ${moveCalls().length}`)
  check('F3 只发出 1 次前台 click，载荷不变', clickCalls().length === 1 && pF.delivery_mode === 'foreground'
    && keysOf(pF) === keySet('session', 'pid', 'window_id', 'x', 'y', 'count', 'button', 'delivery_mode'),
  JSON.stringify(pF))
  check('F4 不创建守卫记录（getLastPointerGuard 为 null）', human.getLastPointerGuard() === null)
  check('F5 引擎返回值原样透传', jsonEq(valueF, { ok: true }))

  // ══════════════════════════════════════════════════════════════════
  // G. token 路径：载荷不变；token + foreground 也能按 sx/sy 还原
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── G. token 路径载荷不变 + token 前台守卫 ──')
  freshSnapshot()
  human.resetPointerGuard()
  stub()
  resetCalls()
  const valueG1 = await human.humanClick({
    pid: PID, windowId: WID, x: 55, y: 66, sx: 30, sy: 40,
    token: 'tok-abc', count: 2, button: 'right',
  })
  const movesG1 = moveCalls()
  const pG1 = clickCalls()[0]?.args || {}
  const expectedG1 = human.cursorPointFor(30, 40)
  check('G1a token 后台路径依旧滑行 1 次（带 target、无 scope）', movesG1.length === GLIDE_CALLS
    && movesG1.every((c) => c.args.target?.window_id === WID && !('scope' in c.args)), `实际 ${movesG1.length}`)
  check('G1b token 路径 0 次 get_cursor_position', readCalls().length === 0, `实际 ${readCalls().length}`)
  check(
    'G1c token 点击载荷逐字段不变（session/pid/element_token/count/button）',
    keysOf(pG1) === keySet('session', 'pid', 'element_token', 'count', 'button')
      && pG1.session === CUA_SESSION && pG1.pid === PID && pG1.element_token === 'tok-abc'
      && pG1.count === 2 && pG1.button === 'right',
    JSON.stringify(pG1),
  )
  check('G1d token 路径不混入坐标字段（无 window_id/x/y/from_zoom/delivery_mode）',
    ['window_id', 'x', 'y', 'from_zoom', 'delivery_mode', 'scope'].every((k) => !(k in pG1)))
  check('G1e 落点 = cursorPointFor(sx,sy)', nearPoint(movesG1[0]?.args, expectedG1, 0),
    `实际${fmt(movesG1[0]?.args)} 期望${fmt(expectedG1)}`)
  check('G1f token 后台路径不进入守卫', human.getLastPointerGuard() === null)
  check('G1g 引擎返回值原样透传', jsonEq(valueG1, { ok: true }))

  // G2：token + foreground：守卫用 sx/sy 算落点（不是 x/y）
  freshSnapshot()
  human.resetPointerGuard()
  const BEFORE_G = { x: 900, y: 700 }
  const READBACK_G = { x: 901, y: 702 } // 复核偏差 ≤3px：还原成功
  const expectedG2 = human.cursorPointFor(200, 150)
  let readsG2 = 0
  stub((tool) => {
    if (tool === 'get_cursor_position') {
      readsG2++
      return readsG2 === 1 ? { ...BEFORE_G } : { ...READBACK_G }
    }
    if (tool === 'click') return { ...CLICK_FG }
    return { ok: true }
  })
  resetCalls()
  const valueG2 = await human.humanClick({
    pid: PID, windowId: WID, x: 999, y: 888, sx: 200, sy: 150,
    token: 'tok-fg', deliveryMode: 'foreground',
  })
  const gG2 = human.getLastPointerGuard() || {}
  const g2Calls = calls
  const g2ClickIdx = g2Calls.findIndex((c) => c.tool === 'click')
  const g2Reads = g2Calls.filter((c) => c.tool === 'get_cursor_position')
  const g2Moves = g2Calls.filter((c) => c.tool === 'move_cursor')
  const g2Restore = g2Moves.find((c) => c.args.scope === 'desktop')
  const g2Repark = g2Moves.find((c) => c.args.target)
  const pG2 = clickCalls()[0]?.args || {}
  check('G2a token+foreground：只在点击前读 1 次指针（不做事后复核）',
    g2Reads.length === 1
      && g2Calls.slice(0, g2ClickIdx).filter((c) => c.tool === 'get_cursor_position').length === 1,
    `实际 ${g2Reads.length}`)
  check(
    'G2b token 前台载荷 = element_token + delivery_mode，且无坐标字段',
    keysOf(pG2) === keySet('session', 'pid', 'element_token', 'count', 'button', 'delivery_mode')
      && pG2.element_token === 'tok-fg' && pG2.delivery_mode === 'foreground',
    JSON.stringify(pG2),
  )
  check('G2c 前台不滑行：共 2 次 move_cursor（还原 + repark）', g2Moves.length === 2, `实际 ${g2Moves.length}`)
  check(
    'G2d 还原调用坐标 = 动作前指针（scope:desktop，不带 target）',
    !!g2Restore && g2Restore.args.x === BEFORE_G.x && g2Restore.args.y === BEFORE_G.y
      && !('target' in g2Restore.args),
    g2Restore ? JSON.stringify(g2Restore.args) : '未发出还原调用',
  )
  check(
    'G2e repark 落点按 sx/sy 换算（=cursorPointFor(200,150)，不是 x/y=999/888）',
    !!g2Repark && g2Repark.args.x === expectedG2.x && g2Repark.args.y === expectedG2.y
      && g2Repark.args.target?.window_id === WID && !('scope' in g2Repark.args),
    g2Repark ? JSON.stringify(g2Repark.args) : '未发出 repark 调用',
  )
  check('G2f token 前台守卫 restored === true（还原调用成功）', gG2.restored === true, JSON.stringify(gG2))
  check('G2g token 前台守卫 reparked === true', gG2.reparked === true)
  check(
    'G2h 顺序正确：click → restore → repark，且 after=null（不做复核）',
    gG2.after === null
      && g2Calls.indexOf(g2Restore) > g2ClickIdx
      && g2Calls.indexOf(g2Repark) > g2Calls.indexOf(g2Restore),
    `click=${g2ClickIdx} restore=${g2Calls.indexOf(g2Restore)} repark=${g2Calls.indexOf(g2Repark)} after=${fmt(gG2.after)}`,
  )
  check('G2i 引擎返回值原样透传', jsonEq(valueG2, CLICK_FG))

  // ══════════════════════════════════════════════════════════════════
  // I. deliveryMode / fromZoom 不滑行；显式 foreground 即便引擎返回值
  //    不带 delivery/route 也按 force 还原（不靠猜返回值形状）
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── I. deliveryMode / fromZoom 不滑行；显式 foreground 走 force 还原 ──')
  freshSnapshot()
  human.resetPointerGuard()
  stub((tool) => {
    if (tool === 'get_cursor_position') return { x: 10, y: 20 }
    return { ok: true } // click 返回不带 delivery/route 字段：显式前台按 force 处理
  })
  resetCalls()
  const agentBeforeI1 = human.getLastAgentPoint()
  const valueI1 = await human.humanClick({
    pid: PID, windowId: WID, x: 120, y: 80, sx: 120, sy: 80, deliveryMode: 'foreground',
  })
  const gI1 = human.getLastPointerGuard() || {}
  const expectedI1 = human.cursorPointFor(120, 80)
  check('I1a 显式 foreground：不滑行，但发 desktop 还原 + 窗口 repark 共 2 次 move_cursor',
    moveCalls().length === 2
      && !!moveCalls().find((c) => c.args.scope === 'desktop' && c.args.x === 10 && c.args.y === 20)
      && !!moveCalls().find((c) => c.args.target && c.args.x === expectedI1.x && c.args.y === expectedI1.y),
    `实际 ${moveCalls().length}`)
  check('I1b 只在动作前读 1 次指针（不做事后复核）', readCalls().length === 1, `实际 ${readCalls().length}`)
  check('I1c click 载荷原样带 delivery_mode', clickCalls()[0]?.args.delivery_mode === 'foreground')
  check(
    'I1d force 路径：还原调用成功 ⇒ guard.restored=true 且 after=null',
    gI1.restored === true && gI1.after === null, JSON.stringify(gI1),
  )
  check('I1e 未滑行，但 overlay 被复停到落点', jsonEq(human.getLastAgentPoint(), expectedI1), fmt(human.getLastAgentPoint()))
  check('I1f 引擎返回值原样透传', jsonEq(valueI1, { ok: true }))

  // I2：fromZoom 坐标无法换算成屏幕点 ⇒ 不滑行、不读指针
  freshSnapshot()
  human.resetPointerGuard()
  stub()
  resetCalls()
  const agentBeforeI2 = human.getLastAgentPoint()
  const valueI2 = await human.humanClick({
    pid: PID, windowId: WID, x: 11, y: 22, sx: 30, sy: 40, fromZoom: true,
  })
  const pI2 = clickCalls()[0]?.args || {}
  check('I2a fromZoom 不滑行（0 次 move_cursor）', moveCalls().length === 0, `实际 ${moveCalls().length}`)
  check('I2b fromZoom 默认后台不再额外读指针', readCalls().length === 0, `实际 ${readCalls().length}`)
  check(
    'I2c 坐标点击载荷不变（window_id/x/y/from_zoom）',
    keysOf(pI2) === keySet('session', 'pid', 'window_id', 'x', 'y', 'count', 'button', 'from_zoom')
      && pI2.window_id === WID && pI2.x === 11 && pI2.y === 22 && pI2.from_zoom === true
      && !('element_token' in pI2) && !('scope' in pI2),
    JSON.stringify(pI2),
  )
  check('I2d 不进入守卫', human.getLastPointerGuard() === null)
  check('I2e 未滑行 ⇒ lastAgentPoint 不变', jsonEq(human.getLastAgentPoint(), agentBeforeI2))
  check('I2f 引擎返回值原样透传', jsonEq(valueI2, { ok: true }))

  // ══════════════════════════════════════════════════════════════════
  // H. actions.js 集成：restorePointer 透传 / 自动前台重投 / 结果文案
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── H. actions.js 集成：restorePointer 透传与前台重投 ──')
  const CFG = { ttlMs: 60000 }
  const CFG_NO_RESTORE = { ttlMs: 60000, restoreRealPointer: false }
  human.resetPointerGuard()
  freshSnapshot()
  const h1 = []
  actions.deps.humanClick = async (opts) => { h1.push({ ...opts }); return { effect: 'ok' } }
  const r1 = await actions.click({ x: 10, y: 20 }, CFG)
  check('H1a 默认后台点击只调用 1 次 humanClick', h1.length === 1, `实际 ${h1.length}`)
  check('H1b restorePointer===true（cfg.restoreRealPointer 默认开）', h1[0]?.restorePointer === true,
    String(h1[0]?.restorePointer))
  check('H1c 未指定 delivery 时 deliveryMode 为 undefined（保持后台默认）', h1[0]?.deliveryMode === undefined,
    String(h1[0]?.deliveryMode))
  check(
    'H1d 目标字段按快照解析（pid/windowId/x/y/sx/sy）',
    h1[0]?.pid === PID && h1[0]?.windowId === WID && h1[0]?.x === 10 && h1[0]?.y === 20
      && h1[0]?.sx === 10 && h1[0]?.sy === 20,
    JSON.stringify(h1[0]),
  )
  check('H1e 结果 ok 且无指针还原文案（守卫未触发）',
    r1.ok === true && !/已放回原位/.test(r1.result), String(r1.result).slice(0, 160))

  // H2：引擎明确报 background_unavailable → 第二次带 foreground 重投
  freshSnapshot()
  const h2 = []
  let seq2 = 0
  actions.deps.humanClick = async (opts) => {
    h2.push({ ...opts })
    seq2++
    if (seq2 === 1) return { code: 'background_unavailable', message: 'window has no background input path' }
    return { delivery: { mode: 'foreground' }, route: 'global_input', effect: 'ok' }
  }
  const r2 = await actions.click({ x: 10, y: 20 }, CFG)
  check('H2a background_unavailable 时自动前台重投（共 2 次）', h2.length === 2, `实际 ${h2.length}`)
  check('H2b 第一次后台尝试：deliveryMode undefined + restorePointer true',
    h2[0]?.deliveryMode === undefined && h2[0]?.restorePointer === true, JSON.stringify(h2[0]))
  check('H2c 第二次前台重投：deliveryMode=foreground + restorePointer true',
    h2[1]?.deliveryMode === 'foreground' && h2[1]?.restorePointer === true, JSON.stringify(h2[1]))
  check('H2d 两次目标字段一致',
    h2[0]?.pid === h2[1]?.pid && h2[0]?.windowId === h2[1]?.windowId
      && h2[0]?.x === h2[1]?.x && h2[0]?.y === h2[1]?.y)
  check('H2e 结果 ok 且文案标注已自动改前台投递',
    r2.ok === true && /已自动改前台投递/.test(r2.result), String(r2.result).slice(0, 200))
  check('H2f 无残留守卫 ⇒ 不出现指针还原文案', !/已放回原位/.test(r2.result))

  // H3：cfg.restoreRealPointer=false → 两次调用都传 false
  freshSnapshot()
  const h3 = []
  actions.deps.humanClick = async (opts) => { h3.push({ ...opts }); return { effect: 'ok' } }
  await actions.click({ x: 10, y: 20 }, CFG_NO_RESTORE)
  check('H3a cfg.restoreRealPointer=false → restorePointer=false', h3[0]?.restorePointer === false,
    String(h3[0]?.restorePointer))
  freshSnapshot()
  const h3b = []
  let seq3 = 0
  actions.deps.humanClick = async (opts) => {
    h3b.push({ ...opts })
    seq3++
    if (seq3 === 1) return { code: 'background_unavailable' }
    return { delivery: { mode: 'foreground' }, route: 'global_input', effect: 'ok' }
  }
  await actions.click({ x: 10, y: 20 }, CFG_NO_RESTORE)
  check('H3b 前台重投也保持 restorePointer=false',
    h3b.length === 2 && h3b[0]?.restorePointer === false && h3b[1]?.restorePointer === false
      && h3b[1]?.deliveryMode === 'foreground',
    h3b.map((x) => `${x.deliveryMode}/${x.restorePointer}`).join(' '))

  // H4：真实 humanClick + 桩引擎走 actions.js 前台点击 → 结果文案含「已放回原位」
  freshSnapshot()
  human.resetPointerGuard()
  const BEFORE_H = { x: 500, y: 400 }
  const READBACK_H = { x: 501, y: 402 } // 复核偏差 ≤3px：还原成功
  const expectedH = human.cursorPointFor(10, 20)
  let readsH = 0
  stub((tool) => {
    if (tool === 'get_cursor_position') {
      readsH++
      return readsH === 1 ? { ...BEFORE_H } : { ...READBACK_H }
    }
    if (tool === 'click') return { ...CLICK_FG }
    return { ok: true }
  })
  actions.deps.humanClick = human.humanClick // 恢复生产默认（真实 humanClick + 桩引擎）
  resetCalls()
  const r4 = await actions.click({ x: 10, y: 20, delivery: 'foreground' }, CFG)
  const gH = human.getLastPointerGuard() || {}
  check('H4a 前台点击经 actions.js 成功返回 ok', r4.ok === true, String(r4.result).slice(0, 160))
  check('H4b 结果文案：真实鼠标指针被前台投递搬动过，已放回原位（500,400）',
    /真实鼠标指针被前台投递搬动过，已放回原位（500,400）/.test(r4.result), String(r4.result).slice(0, 240))
  check('H4c 文案标注投递=foreground', /投递=foreground/.test(r4.result))
  check('H4d 2 次 move_cursor：desktop 还原 + 窗口 repark', moveCalls().length === 2
    && !!moveCalls().find((c) => c.args.scope === 'desktop')
    && !!moveCalls().find((c) => c.args.target
      && c.args.x === expectedH.x && c.args.y === expectedH.y), `实际 ${moveCalls().length}`)
  check('H4e 守卫 restored=true（复核偏差 ≤3px）', gH.restored === true, JSON.stringify(gH))
  check('H4f 守卫 after=null（不做复核判定）', gH.after === null, fmt(gH.after))

  // H5（回归 C1）：前台点击之后紧接着的后台点击，不得复用上一次的守卫记录误报
  //「已放回原位」（守卫状态是模块级共享的，humanAction 入口必须重置）。
  resetCalls()
  const r5 = await actions.click({ x: 30, y: 40 }, CFG)
  check('H5a 后台点击结果不再误报"已放回原位"/"未能确认已还原"',
    !/已放回原位/.test(r5.result) && !/未能确认已还原/.test(r5.result), String(r5.result).slice(0, 200))
  check('H5b 后台点击没有 desktop 还原调用',
    !moveCalls().some((c) => c.args.scope === 'desktop'), `move=${moveCalls().length}`)

  // ══════════════════════════════════════════════════════════════════
  // Z. 全局审计：载荷形状合法、绝不 scope+target 并存、click 不带 scope
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── Z. 全局审计：所有引擎载荷的形状 ──')
  const allMoves = audit.filter((c) => c.tool === 'move_cursor')
  check('Z1 审计样本充足', allMoves.length >= 15, `共 ${allMoves.length} 次 move_cursor`)
  // 合法形状只有三种：
  //   1) 带窗口 target、不带 scope（滑行 / repark，只动 overlay）
  //   2) scope:'desktop'、不带 target（还原真实指针）
  //   3) scope:'window'、不带 target（无 target 兜底）
  const illegal = allMoves.filter(({ args }) => {
    const hasTarget = !!args.target
    const hasScope = 'scope' in args
    if (hasTarget && hasScope) return true // 0.28.2 会 invalid_action_target
    if (hasTarget) {
      return args.target.kind !== 'window' || args.target.pid == null || args.target.window_id == null
    }
    return args.scope !== 'window' && args.scope !== 'desktop'
  })
  check('Z2 所有 move_cursor 都落在合法载荷形状（目标窗口 / desktop 还原 / window 兜底）',
    illegal.length === 0,
    illegal.length ? `异常 ${illegal.length} 次，例如 ${JSON.stringify(illegal[0].args)}` : `${allMoves.length} 次`)
  check('Z3 没有任何 move_cursor 同时带 scope 和 target（会被引擎拒绝）',
    allMoves.every(({ args }) => !(args.target && 'scope' in args)))
  check('Z4 所有 move_cursor 都绑定 overlay 会话', allMoves.every(({ args }) => args.session === CUA_SESSION))
  const allClicks = audit.filter((c) => c.tool === 'click')
  check('Z5 所有 click 都不带 scope', allClicks.every(({ args }) => !('scope' in args)), `共 ${allClicks.length} 次`)
  check('Z6 所有 click 都带 session + pid，且坐标/token 二选一',
    allClicks.length > 0 && allClicks.every(({ args }) => args.session === CUA_SESSION && args.pid === PID
      && ((args.element_token && !('x' in args)) || (args.window_id != null && Number.isFinite(args.x) && Number.isFinite(args.y)))))
  const reads = audit.filter((c) => c.tool === 'get_cursor_position')
  check('Z7 get_cursor_position 载荷只有 session（只读、不掺参数）',
    reads.every(({ args }) => keysOf(args) === keySet('session')), `共 ${reads.length} 次`)
  check('Z8 审计中只出现 move_cursor / set_agent_cursor_motion / click / get_cursor_position（无其它引擎调用泄漏）',
    audit.every((c) => ['move_cursor', 'set_agent_cursor_motion', 'click', 'get_cursor_position'].includes(c.tool)),
    [...new Set(audit.map((c) => c.tool))].join(','))
  check('Z9 只有前台/守卫路径读指针（本套件共 5 次：D 1 + E 1 + G2 1 + I1 1 + H4 1），后台点击 0 次',
    reads.length === 5, `实际 ${reads.length}`)

  // 恢复生产默认注入点（证明测试没有污染默认值）
  human.deps.cuaCall = cuaCall
  actions.deps.humanClick = human.humanClick
  check('Z10 注入点可恢复默认（生产行为等价）',
    human.deps.cuaCall === cuaCall && actions.deps.humanClick === human.humanClick)
} catch (err) {
  fail++
  failures.push('测试脚本异常中止')
  console.log(`FAIL  测试脚本异常中止 :: ${err?.stack || err?.message || err}`)
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const name of failures) console.log(` - ${name}`)
}
process.exitCode = fail === 0 ? 0 : 1
