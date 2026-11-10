/**
 * human.js —— 真人操作模块：像素级虚拟光标（看得见过程）+ 真实指针隔离。
 *
 * ## 引擎实测结论（cua-driver 0.28.2 / Windows，见 evidence/real-pointer-probe/）
 *
 * 1. `move_cursor` + `target:{kind:'window',...}`（**现用滑行载荷**）：
 *    只移动 agent overlay，真实鼠标指针一动不动（3 轮独立实验一致）。
 * 2. `move_cursor` + `scope:'window'` + `target:{kind:'window'}`：
 *    引擎直接拒绝 `invalid_action_target`；**不能加**，加了滑行会静默失效。
 * 3. `move_cursor` + `scope:'desktop'`：
 *    把真实 OS 指针精确搬到 (x,y)，且不报错 ⇒ 这是「把指针放回去」的唯一手段。
 *    注意：**不传 target 也不传 scope** 时行为不稳定（probe4 实测搬过真实指针，
 *    probe3/probe5 又没搬），所以滑行在缺 target 时一律补 scope:'window' 兜底。
 * 4. `click` 前台投递（delivery_mode:'foreground'，route=global_input）：
 *    SendInput 会把真实指针**搬到点击落点**，而且**不还原**（实测落点与窗口
 *    偏移完全吻合）。用户的「点击时鼠标指针被拽走」就是这条路径。
 * 5. `click` 后台投递 / `drag` / `scroll` / `press_key` / `hotkey`：
 *    实测都不动真实指针。
 *
 * 因此本模块的隔离策略：
 *   - 滑行（glideCursor）永远只动 overlay（载荷保持不传 scope，并防御性兜底）；
 *   - 只有**前台投递**的动作才启用 withPointerGuard：动作前记下真实指针，
 *     动作后立即把它放回原位，再把 overlay 挪回落点（详见 withPointerGuard 注释）。
 *
 * 坐标语义（cua-driver 0.21+）：click / drag / scroll 的 x,y 均为
 * "窗口本地截图像素"（get_window_state 返回的 PNG 同一空间，左上原点）。
 *
 * 点击寻址：
 *   - element 编号模式 → 用引擎官方推荐的 element_token（AX 路径，精确定位，
 *     支持后台/隐藏窗口，无需坐标；引擎文档明确 "Prefer element_token"）
 *   - x/y 坐标模式 → 像素路径（CGEvent），坐标 = 窗口本地截图像素
 */
import { cuaCall, CUA_SESSION, withSession } from './cua.js'
import { getSnapshot, isFresh, clearSnapshot } from './snapshot.js'

/**
 * 依赖注入点（单测可替换）：本模块所有引擎调用都走 deps.cuaCall，
 * 默认等价于直接调用 cua.js 的 cuaCall，生产行为完全不变。
 * 仿 actions.js 的 `export const deps = { humanClick }` 写法。
 */
export const deps = { cuaCall }

/**
 * 前台投递检测：只有走 OS 级合成输入（SendInput）的路径才会搬真实指针。
 * 引擎返回 {delivery:{mode:'foreground'}, route:'global_input'} 即此路径。
 * @param {any} value - 引擎返回值
 * @returns {boolean}
 */
export function isForegroundRoute(value) {
  if (!value || typeof value !== 'object') return false
  if (value.delivery?.mode === 'foreground') return true
  return value.route === 'global_input'
}

/** 指针还原/守卫的最近一次结果（测试与结果文案用；空表示没走守卫）。 */
let lastPointerGuard = null

/** @returns {{before:{x:number,y:number}|null, after:{x:number,y:number}|null, restored:boolean, reparked:boolean}|null} */
export function getLastPointerGuard() {
  return lastPointerGuard ? { ...lastPointerGuard } : null
}

/** 清空守卫记录（单测用）。 */
export function resetPointerGuard() {
  lastPointerGuard = null
}

/**
 * 最近一次读到的真实指针 + 时间戳。
 * 引擎一次 get_cursor_position 子进程往返约 0.8–3s（实测），所以只在必要时读；
 * 这里的缓存只用于「动作结果告诉我们走了前台、但我们没来得及在动作前读指针」的兜底。
 */
let lastKnownRealPointer = null
let lastKnownRealPointerAt = 0
/** 缓存有效期：超过这个时间就不敢拿来还原（用户可能已经自己移动了鼠标）。 */
const REAL_POINTER_CACHE_MS = 8000

/**
 * 读取真实鼠标指针位置（引擎坐标系 = 物理像素）。
 * 失败返回 null（best-effort：拿不到指针绝不能让点击失败）。
 * @returns {Promise<{x:number,y:number}|null>}
 */
export async function readRealPointer() {
  try {
    const v = await deps.cuaCall('get_cursor_position', withSession({}))
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      lastKnownRealPointer = { x: v.x, y: v.y }
      lastKnownRealPointerAt = Date.now()
      return { x: v.x, y: v.y }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 把真实 OS 指针放回 (x,y)。
 * 只有 desktop 作用域的 move_cursor 会移动真实指针（实测精确落点），
 * 注意它可能顺带把 overlay 也带到该处 —— 调用方随后应调用 reparkOverlay 把
 * overlay 挪回点击落点，避免视觉光标停在用户指针那里。
 * @param {{x:number,y:number}|null} pt
 * @returns {Promise<boolean>} 是否成功下发还原调用
 */
export async function restoreRealPointer(pt) {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false
  try {
    await deps.cuaCall('move_cursor', withSession({ x: pt.x, y: pt.y, scope: 'desktop' }))
    lastKnownRealPointer = { x: pt.x, y: pt.y }
    lastKnownRealPointerAt = Date.now()
    return true
  } catch {
    return false
  }
}

/**
 * 把 overlay 停到窗口内某个屏幕点（只动 overlay，不动真实指针）。
 * @param {{x:number,y:number}} pt - 屏幕坐标（引擎物理像素）
 * @param {{pid:number, windowId:number}} target
 * @returns {Promise<boolean>}
 */
export async function reparkOverlay(pt, { pid, windowId } = {}) {
  if (!pt || pid == null || windowId == null) return false
  try {
    // 同样吃「单段定时缓动」：否则引擎默认 spring 物理在远距离要等 2.4s 才收敛。
    await ensureMotionProfile()
    await deps.cuaCall('move_cursor', withSession({
      x: pt.x,
      y: pt.y,
      target: { kind: 'window', pid, window_id: windowId },
    }))
    lastAgentPoint = { x: pt.x, y: pt.y }
    return true
  } catch {
    return false
  }
}

/**
 * 前台动作的真实指针守卫。
 *
 * 用法：`const value = await withPointerGuard({ before, expectedPoint, target }, () => click(...))`
 *   - before：动作前读到的真实指针（可为 null，空则退回用最近缓存兜底）
 *   - expectedPoint：动作落点的屏幕坐标（引擎坐标）；null 表示未知（如 zoom 坐标）
 *
 * 行为：动作返回后若判定走了前台路径（isForegroundRoute）或 force，就**立即**把指针
 * 放回 before（实测前台点击必把指针搬到落点，所以不等再读一次，少一次引擎往返），
 * 随后把 overlay 复停到 expectedPoint，最后复核一次指针位置写进 lastPointerGuard。
 *
 * 取舍：立即还原的窗口很短（一次引擎往返内），极端情况下用户正好在这期间主动移动
 * 鼠标会被带回原位；换来的是「指针错位可见时间」最短。只在显式前台/force 场景启用。
 * `force:true` 用于引擎返回值里没有 delivery/route 字段、但实测可能搬指针的动作
 * （如 bring_to_front）。
 * @template T
 * @param {{before?:{x:number,y:number}|null, expectedPoint?:{x:number,y:number}|null, pid?:number, windowId?:number, force?:boolean}} ctx
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
export async function withPointerGuard(ctx, action) {
  const { expectedPoint = null, pid = null, windowId = null, force = false } = ctx || {}
  let before = ctx?.before || null
  // 兜底：调用方没在动作前读指针时，若缓存足够新就用它。
  if (!before && lastKnownRealPointer && Date.now() - lastKnownRealPointerAt <= REAL_POINTER_CACHE_MS) {
    before = lastKnownRealPointer
  }
  let value
  try {
    value = await action()
  } catch (err) {
    // 动作本身抛错（引擎超时/半途失败）也可能已经把指针搬走了：
    // 照样尝试还原一次再抛，避免"点了失败但指针留在落点"。
    if (before) {
      lastPointerGuard = {
        before,
        after: null,
        restored: await restoreRealPointer(before),
        reparked: await reparkOverlay(expectedPoint, { pid, windowId }),
        error: String(err?.message || err),
      }
    }
    throw err
  }
  lastPointerGuard = { before, after: null, restored: false, reparked: false }
  if (!before) return value
  if (!force && !isForegroundRoute(value)) return value

  // 前台投递已知会把真实指针搬到落点（实测）。这里**不做任何复核/判断**：
  // 点击返回后立刻把指针放回原位，然后复停 overlay。
  // （用户要求：不用判断是否还原 —— 少一次引擎读取，也不会有"未能确认"的误报。）
  lastPointerGuard.restored = await restoreRealPointer(before)
  // 还原可能把 overlay 一起带到用户指针处；把 overlay 挪回点击落点，保证视觉反馈还在目标上。
  lastPointerGuard.reparked = await reparkOverlay(expectedPoint, { pid, windowId })
  return value
}

/**
 * 单段滑行时长（ms）。引擎用 `glide_duration_ms` 做固定时长的平滑缓动，
 * 且实测 `move_cursor` 会**阻塞到动画结束**（glide=240 → 251ms，glide=600 → 610ms），
 * 返回时 overlay 已精确到位，点击可以紧跟其后。
 */
const GLIDE_MS = 240
/**
 * 单段滑行的光标运动参数（引擎会话级配置）。
 * - 不给 glide_duration_ms 时引擎按 spring 物理自行收敛：700px 实测要 2461ms，
 *   而且连续喂目标会不停重算（历史上「绕圈」的来源之一）；
 * - arc_size 保留一点点弧度（0 = 纯直线），不再由插件自己插值。
 */
const GLIDE_MOTION = {
  glide_duration_ms: GLIDE_MS,
  spring: 1,
  arc_size: 0.05,
  arc_flow: 0,
  turn_radius: 1,
}

/**
 * 确保本次会话的虚拟光标走「单段定时缓动」。
 * 运动参数是**会话级**的（引擎重启/会话重建会丢），所以每次滑行前重设一次，
 * 成本约一次引擎往返（实测 3–4ms）。失败静默：老版本引擎没有该工具时退回默认物理。
 */
async function ensureMotionProfile() {
  try {
    await deps.cuaCall('set_agent_cursor_motion', withSession({ ...GLIDE_MOTION }))
  } catch { /* 老引擎 / 会话未建立：退回引擎默认运动参数 */ }
}

/**
 * 唯一的「窗口 PNG 像素 → move_cursor 目标坐标」换算入口。
 * 调用方（humanClick）只传 PNG 坐标，坐标空间由 CURSOR_COORD_SPACE 一处决定。
 * 现在固定用屏幕坐标（窗口 bounds 左上角 + PNG 像素），与引擎实测一致：
 * move_cursor 吃屏幕坐标（物理像素）。
 * 注意：若 get_window_state 的 PNG 被 downscale，严格换算应走 space.js 的
 * pngToScreen（含 scaleX/scaleY），需要时在这个函数里改一处即可。
 * @param {number} sx - 窗口 PNG 像素 x
 * @param {number} sy - 窗口 PNG 像素 y
 * @returns {{x:number, y:number}}
 */
export function cursorPointFor(sx, sy) {
  const b = getSnapshot()?.space?.bounds
  return { x: b ? b.x + sx : sx, y: b ? b.y + sy : sy }
}

/**
 * 上一次虚拟光标停在的位置（屏幕坐标）。
 * 注意：引擎的 get_cursor_position 返回的是**真实鼠标**（虚拟光标不动它），
 * 拿它当滑行起点会导致光标从无关位置飞过来，所以这里自己记。
 */
let lastAgentPoint = null

/**
 * 只读当前虚拟光标位置（测试/诊断用；返回副本，外部改不到内部状态）。
 * @returns {{x:number,y:number}|null}
 */
export function getLastAgentPoint() {
  return lastAgentPoint ? { x: lastAgentPoint.x, y: lastAgentPoint.y } : null
}

/**
 * 光标滑行：把 overlay 平滑移动到目标。最佳努力，失败不阻断点击。
 *
 * 现在是**一次** `move_cursor` = 引擎的一段定时缓动；调用返回时动画已结束、overlay
 * 精确到位。历史实现是插件自己插值 5 段 + 弧线，引擎侧弹簧又去追每一段的目标，
 * 两层动画叠加才出现「绕好几圈」（见 evidence/motion-probe/）。
 *
 * 隔离保证（实测，见文件头）：
 *   - 带 `target:{kind:'window'}` 的 move_cursor 只动 overlay，不动真实指针；
 *   - **不能**再传 scope:'window'（0.28.2 会 invalid_action_target 拒绝）；
 *   - 万一调用方没给 target（默认会落到 desktop scope、搬真实指针），补一个
 *     scope:'window' 兜底。
 * @param {number} tx - 目标 x（屏幕坐标）
 * @param {number} ty - 目标 y（屏幕坐标）
 * @param {object} opts - { target: { kind:'window', pid, window_id } }
 */
export async function glideCursor(tx, ty, opts = {}) {
  const payload = { x: tx, y: ty, ...opts }
  // 防御：没有窗口 target 时引擎默认按 desktop 作用域处理（实测会搬真实指针）。
  if (!payload.target) payload.scope = 'window'
  await ensureMotionProfile()
  await deps.cuaCall('move_cursor', withSession(payload)).catch(() => undefined)
  lastAgentPoint = { x: tx, y: ty }
}

/**
 * 窗口本地截图像素 ⇄ 屏幕坐标换算不再需要：0.21.0 直接接受截图像素。
 * 保留函数仅为兼容旧调用（坐标原样返回）。
 */
export function windowLocalOf(x, y, _snap) {
  return { x, y }
}

/**
 * 真人点击：滑行到目标 + 点击。
 * element 模式（带 token）走引擎 AX 路径（element_token，精确定位）；
 * 坐标模式走像素路径（x/y = 窗口本地截图像素，模型直接可见的坐标）。
 *
 * 真实指针隔离：
 *   - 滑行只动 overlay（见 glideCursor）；
 *   - `deliveryMode:'foreground'` 时启用指针守卫：点击前记下真实指针，
 *     点击后若引擎把指针搬到了落点，就还原回原位并让 overlay 继续停在落点；
 *   - 后台投递不读指针、不加任何额外引擎调用（保持原有性能）。
 * @param {object} opts - { pid, windowId, x, y, sx, sy, token, count, button,
 *                           deliveryMode, fromZoom, restorePointer }
 */
export async function humanClick(opts) {
  const {
    pid, windowId, x, y, sx, sy, token, count = 1, button = 'left',
    deliveryMode, preferForeground = false, fromZoom, restorePointer = true,
  } = opts

  // 实际投递模式：显式 deliveryMode 优先；preferForeground 表示「这次点击要真实发生」，
  // 用于坐标/画布/Electron 内容的像素路径 —— 仍然先滑行，再走前台投递（可见、有效）。
  const effectiveDelivery = deliveryMode || (preferForeground ? 'foreground' : undefined)

  // 落点的屏幕坐标（用于「指针是不是被引擎搬到这儿了」的判定与 overlay 复停）。
  // zoom 图内坐标的屏幕位置只能由引擎换算，这里不冒充。
  const expectedPoint = (sx != null && sy != null && !fromZoom) ? cursorPointFor(sx, sy) : null

  // 1. 光标滑行到目标（最佳努力，看得见过程；move_cursor 只动 overlay，不碰真实鼠标）
  //    只有「显式指定 deliveryMode」才跳过滑行；preferForeground 属于自动升级，照常滑行。
  //    zoom 坐标无法换算则跳过。
  let before = null
  if (sx != null && sy != null && !deliveryMode && !fromZoom) {
    const pt = cursorPointFor(sx, sy)
    await glideCursor(pt.x, pt.y, { target: { kind: 'window', pid, window_id: windowId } })
  }
  // 前台投递必搬真实指针：动作前读一次，动作后放回原位（滑行之后再读，顺序安全）。
  if (restorePointer && effectiveDelivery === 'foreground') {
    before = await readRealPointer()
  }

  // 2. 点击：token 优先（AX 路径），否则像素路径（PNG 像素）
  const payload = { session: CUA_SESSION, pid }
  if (token) {
    payload.element_token = token
    // token 路径同样透传计数/按钮，否则双击/右键会静默退化成单次左键
    payload.count = count
    payload.button = button
  } else {
    if (x == null || y == null) throw new Error('humanClick: 缺少点击坐标（x/y）。')
    payload.window_id = windowId
    payload.x = x
    payload.y = y
    payload.count = count
    payload.button = button
    // zoom 图内坐标 → 由引擎换算回窗口坐标（含它自己加的 20% 内边距）
    if (fromZoom) payload.from_zoom = true
  }
  if (effectiveDelivery) payload.delivery_mode = effectiveDelivery

  // 3. 走注入点（单测可桩掉并检查载荷）；前台投递才加指针守卫。
  //    自动路径若引擎报 background_unavailable，actions.js 会改前台重投一次，
  //    那时才读指针并还原——顺序安全，因为后台尝试本身不搬指针。
  const mayWarpPointer = restorePointer && effectiveDelivery === 'foreground'
  if (!mayWarpPointer) return deps.cuaCall('click', payload)
  // 前台投递：不依赖引擎返回值里的 delivery/route 字段（不同版本/路径可能不带），
  // 直接用 force 守卫——反正前台投递必搬指针，还原到「动作前位置」总是安全的。
  return withPointerGuard(
    { before, expectedPoint, pid, windowId, force: effectiveDelivery === 'foreground' },
    () => deps.cuaCall('click', payload),
  )
}

/** 快照辅助：解析编号 → token + 坐标（截图像素空间）。 */
export function resolveClickTarget(index, ttlMs) {
  const snap = getSnapshot()
  if (!snap) throw new Error('没有可用的观察快照：请先调用 screen_observe。')
  // 与 resolveToken / resolveWindow 对齐：过期快照必须拒绝，
  // 否则 click 会按旧坐标/旧 token 盲点（guard 只判快照存在，不判新鲜度）。
  if (ttlMs != null && !isFresh(ttlMs)) {
    clearSnapshot()
    throw new Error(`观察快照已过期（超过 ${Math.round(ttlMs / 1000)} 秒）：请重新调用 screen_observe。`)
  }
  const entry = snap.entries?.get(index)
  if (!entry) throw new Error(`编号 [${index}] 不在当前快照中。`)
  const pt = screenPointOf(entry, snap)
  const local = windowLocalOf(entry.x, entry.y, snap)
  return {
    pid: snap.pid,
    windowId: snap.windowId,
    token: entry.token || null,
    x: local.x,
    y: local.y,
    sx: pt?.sx,
    sy: pt?.sy,
  }
}

/** 快照辅助：元素坐标（截图像素空间）。 */
export function screenPointOf(entry, _snap) {
  if (!entry || entry.x == null || entry.y == null) return null
  return { sx: entry.x, sy: entry.y }
}
