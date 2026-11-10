/**
 * actions.js —— 动作工具实现：点击 / 双击 / 右键 / 输入 / 按键 / 滚动 / 拖拽。
 *
 * 每个动作都基于 screen_observe 的快照：
 *  - element 编号模式 → 透传 element_token（引擎校验快照是否过期）
 *  - x/y 坐标模式 → 使用快照窗口的 window-local 像素坐标
 */
import { cuaCall, normalizeMcp, withSession } from './cua.js'
import { getSnapshot } from './snapshot.js'
import { resolveToken, resolveWindow } from './snapshot.js'
import {
  humanClick, resolveClickTarget, screenPointOf, windowLocalOf,
  getLastPointerGuard, resetPointerGuard, readRealPointer, withPointerGuard,
} from './human.js'
import { refreshSnapshot, refreshBrowserSnapshot } from './observe.js'
import { clickRef, typeRef, scrollPage } from './browser.js'

/**
 * 构造一次"基于编号或坐标"的引擎调用参数。
 * 坐标语义（cua-driver 0.28 契约）：click 的 x/y = get_window_state 返回的
 * **PNG 像素**（左上原点）；zoom 之后传 from_zoom=true 则 x/y 是裁剪图像素。
 * @returns {object} 传给 cua-driver 的参数字段
 */
function targetArgs(args, cfg, extra = {}) {
  const out = {}
  const snap = getSnapshot()
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(Number(args.element), cfg.ttlMs)
    out.pid = pid
    out.element_token = token
  } else if (args.x !== undefined || args.y !== undefined) {
    if (args.x === undefined || args.y === undefined) {
      throw new Error('坐标模式必须同时提供 x 和 y。')
    }
    const { pid, windowId } = resolveWindow(cfg.ttlMs)
    const local = windowLocalOf(Number(args.x), Number(args.y), snap)
    out.pid = pid
    out.window_id = windowId // 坐标点击需 window_id 定位目标窗口（避免多窗口歧义）
    out.x = local.x
    out.y = local.y
    // zoom 图内坐标：交给引擎换算（引擎会处理它自己加的 20% 内边距）
    if (args.zoom) out.from_zoom = true
  } else {
    throw new Error('必须提供 element（观察编号）或 x/y 坐标。')
  }
  return withSession({ ...out, ...extra })
}

/**
 * 投递是否"可能无效"：Chromium/Electron 内容会丢弃后台 PostMessage，
 * 引擎会回 effect:"unverifiable" 或 background_unavailable。
 * 这种结果绝不能当成功（旧版就是把它当成功，导致"点了没反应"）。
 */
export function deliveryUncertain(value) {
  if (!value || typeof value !== 'object') return false
  if (value.effect === 'unverifiable') return true
  try {
    return /background_unavailable/.test(JSON.stringify(value))
  } catch {
    return false
  }
}

/**
 * 引擎是否明确报告"后台投递没有送达"。
 * 只有这种明确信号才值得改前台重投；effect=unverifiable 表示输入已进入全局输入管线、
 * 只是没有回执，重投会造成重复输入（type 打两遍、click 点两次）。
 */
export function backgroundUnavailable(value) {
  if (!value || typeof value !== 'object') return false
  try {
    return /background_unavailable/.test(JSON.stringify(value))
  } catch {
    return false
  }
}

/** 解析投递模式参数：auto（默认）/ background / foreground。 */
function deliveryMode(args) {
  const d = args?.delivery
  return d === 'foreground' || d === 'background' ? d : undefined
}

/**
 * 带投递升级的通用调用：先按用户指定（或默认 background）投递，
 * 引擎回 unverifiable / background_unavailable 时自动改 foreground 重试一次。
 * @returns {Promise<{value:any, escalated:boolean}>}
 */
async function callWithEscalation(call, tool, payload, args) {
  const mode = deliveryMode(args)
  const first = await call(tool, mode ? { ...payload, delivery_mode: mode } : payload)
  // 只在引擎明确报告"后台未送达"时重投，避免重复输入。
  if (mode || !backgroundUnavailable(first)) return { value: first, escalated: false }
  const second = await call(tool, { ...payload, delivery_mode: 'foreground' })
  return { value: second, escalated: true }
}

/** 投递结果的人读提示。 */
export function deliveryNote(value, escalated) {
  if (escalated) {
    return '（后台投递对 Chromium/Electron 内容无效，已自动改前台投递；引擎对合成输入不回执，需要确认时用 screen_zoom 复核）'
  }
  if (deliveryUncertain(value)) {
    return '（⚠ 引擎报告 unverifiable：合成输入无回执，请用 screen_zoom 复查该处是否发生变化）'
  }
  return ''
}


/** 通用动作执行：调用引擎并返回统一结果。 */
async function runAction(label, tool, args, cfg, extra = {}) {
  const payload = targetArgs(args, cfg, extra)
  const value = normalizeMcp(await cuaCall(tool, payload))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `${label} 完成：${detail}` }
}

/**
 * 引擎侧拒绝检测：cua-driver 常以 200 + 结构化错误返回（如
 * {code:"off_space_or_ax_unresolved", effect:"refused"}）。这类结果不是"成功"。
 * @returns {string|null} 拒绝原因文本
 */
export function engineRefusal(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const effect = value.effect
    if (effect === 'refused' || effect === 'rejected') {
      const code = value.code ? ` (${value.code})` : ''
      const reason = value.escalation?.reason || value.reason || value.message || ''
      return `${effect}${code}${reason ? ' ' + reason : ''}`
    }
    // 第二种拒绝形状：{status:"refused", refusal:{code,message}}（典型的 element_token 失效）
    const status = value.status
    if (status === 'refused' || status === 'rejected') {
      const code = value.refusal?.code ? ` (${value.refusal.code})` : ''
      const reason = value.refusal?.message || value.reason || value.message || ''
      return `${status}${code}${reason ? ' ' + reason : ''}`
    }
    if (value.refusal && typeof value.refusal === 'object') {
      const code = value.refusal.code ? ` (${value.refusal.code})` : ''
      return `refused${code}${value.refusal.message ? ' ' + value.refusal.message : ''}`
    }
    if (typeof value.error === 'string') return value.error.slice(0, 200)
  }
  return null
}

/**
 * 真人点击：解析目标（编号或坐标）→ 光标滑行 → 像素级点击。
 * @returns {Promise<{ok:boolean, result:string}>}
 */
/** 依赖注入点（单测可替换）；生产环境等价于直接调用 humanClick。 */
export const deps = { humanClick }

/**
 * 可"按元素点"的角色：按钮、菜单项、链接、复选/单选、标签页、列表/树节点、组合框等。
 * Edit / Document / Pane / Canvas 这类区域不在此列 —— 点它们的意义就是"点那个像素"
 * （插入符位置、画板坐标），自动改成元素中心反而会点偏。
 */
const ACTIONABLE_ROLE = /button|menuitem|menu item|link|checkbox|check box|radiobutton|radio button|tabitem|tab item|combo|listitem|treeitem|按钮|菜单|链接|复选|单选|标签页|列表项|树项/i

/**
 * 像素坐标命中的「可调用元素」：用于让 computer_click(x,y) 在能点元素时自动改用
 * element_token（UIA 调用：不碰真实指针、不抢焦点、后台窗口也能点）。
 * 取面积最小的命中者（最具体的那个子元素），并排除过大的容器。
 * @param {object|null} snap - 当前观察快照
 * @param {number} x - PNG 像素 x
 * @param {number} y - PNG 像素 y
 * @returns {{index:number, token:string, role:string, label:string}|null}
 */
export function actionableElementAt(snap, x, y) {
  const entries = snap?.entries
  if (!entries || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const winArea = (Number(snap?.space?.pngW) || 0) * (Number(snap?.space?.pngH) || 0)
  let best = null
  for (const [index, e] of entries) {
    if (!e?.token || !e.rect) continue
    const r = e.rect
    if (!(x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h)) continue
    if (!ACTIONABLE_ROLE.test(String(e.role || ''))) continue
    const area = Math.max(1, r.w * r.h)
    if (winArea > 0 && area > winArea * 0.2) continue // 大块容器（整页/整窗）不自动晋升
    if (!best || area < best.area) best = { index, token: e.token, role: e.role || '', label: e.label || '', area }
  }
  if (!best) return null
  return { index: best.index, token: best.token, role: best.role, label: best.label }
}

/** 从 CDP 快照取出浏览器绑定。 */
function browserBindingOf(snap) {
  const b = snap?.browser
  if (!b?.targetId || !b?.tabId) return null
  return { targetId: b.targetId, tabId: b.tabId, pid: b.pid, windowId: b.windowId }
}

/** ref 失效时按 role+label 在新快照里找回同一元素。 */
function findSameElement(entries, role, label) {
  if (!entries) return null
  const wantRole = String(role || '').toLowerCase()
  const wantLabel = String(label || '')
  let loose = null
  for (const e of entries.values()) {
    if (!e?.ref) continue
    const sameRole = String(e.role || '').toLowerCase() === wantRole
    if (sameRole && e.label === wantLabel) return e
    if (!loose && sameRole) loose = e
  }
  return null
}

/** ref 失效判定（引擎 ref/快照相关错误）。 */
function refStale(refusal) {
  return /ref|snapshot|stale|superseded|invalidated/i.test(String(refusal || ''))
}

/** CDP 点击：页面元素按 ref 直接点，不经过系统鼠标。ref 失效时自动重取快照并重试一次。 */
async function browserClickAction(label, args, cfg, snap, entry) {
  const binding = browserBindingOf(snap)
  const where = ` [${args.element}] ${entry.role}"${entry.label}"（CDP 页面元素 · 不经过系统鼠标）`
  let value = await clickRef(binding, entry.ref)
  let refusal = engineRefusal(value)
  let retried = false
  if (refusal && refStale(refusal)) {
    const refreshed = await refreshBrowserSnapshot(cfg).catch(() => null)
    if (refreshed?.ok) {
      const again = findSameElement(refreshed.entries, entry.role, entry.label)
      if (again?.ref) {
        value = await clickRef(binding, again.ref)
        refusal = engineRefusal(value)
        retried = true
      }
    }
  }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  if (refusal) return { ok: false, result: `${label} 被 CDP 拒绝${where}：${refusal}` }
  const route = typeof value === 'object' ? value?.route : null
  const meta = [route ? `route=${route}` : '', retried ? 'ref 已自愈重试' : ''].filter(Boolean).join(' ')
  return { ok: true, result: `${label} 完成${where}${meta ? ` [${meta}]` : ''}：${detail}` }
}

/** CDP 输入：向页面元素按 ref 输入文本，不经过键盘/鼠标（Input 域）。 */
async function browserTypeAction(args, cfg, snap, entry) {
  const binding = browserBindingOf(snap)
  const where = ` [${args.element}] ${entry.role}"${entry.label}"（CDP 页面元素 · 不经过系统鼠标）`
  let value = await typeRef(binding, entry.ref, args.text, { replace: args.replace === true })
  let refusal = engineRefusal(value)
  let retried = false
  if (refusal && refStale(refusal)) {
    const refreshed = await refreshBrowserSnapshot(cfg).catch(() => null)
    if (refreshed?.ok) {
      const again = findSameElement(refreshed.entries, entry.role, entry.label)
      if (again?.ref) {
        value = await typeRef(binding, again.ref, args.text, { replace: args.replace === true })
        refusal = engineRefusal(value)
        retried = true
      }
    }
  }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  if (refusal) return { ok: false, result: `输入被 CDP 拒绝${where}：${refusal}` }
  return { ok: true, result: `输入完成${where}${retried ? ' [ref 已自愈重试]' : ''}：${detail}` }
}

async function humanAction(label, args, cfg, extra = {}) {
  // 清空上一次动作的指针守卫记录：否则一次前台点击之后，后续每个后台点击的
  // 结果文案都会误报"指针已放回原位"（守卫状态是模块级共享的）。
  resetPointerGuard()
  let target
  let autoElement = null
  const snap = getSnapshot()
  // CDP 页面元素优先：Chromium 页面快照里的元素带 ref，点击走浏览器调试协议，
  // 完全不产生系统鼠标事件（也不动真实指针、不抢焦点）。
  if (args.element !== undefined && args.element !== null && snap?.browser) {
    const entry = snap.entries?.get(Number(args.element))
    if (entry?.ref) return browserClickAction(label, args, cfg, snap, entry)
  }
  if (args.element !== undefined && args.element !== null) {
    target = resolveClickTarget(Number(args.element), cfg.ttlMs)
  } else if (args.x !== undefined && args.y !== undefined) {
    const { pid, windowId } = resolveWindow(cfg.ttlMs)
    const sx = Number(args.x)
    const sy = Number(args.y)
    const local = windowLocalOf(sx, sy, snap)
    // 元素优先（可用 preferElement=false 关掉）：坐标落在按钮/菜单项这类可调用元素上时，
    // 自动改用该元素的 element_token 走 UIA 通道 —— "能点元素就点元素"，不碰真实指针。
    // 编辑区/画布/文档等非可调用元素、以及 vision/native 快照（无元素表）仍走像素/视觉点击。
    if (cfg?.preferElement !== false && !args.zoom) {
      const hit = actionableElementAt(snap, sx, sy)
      if (hit) {
        autoElement = hit
        target = { pid, windowId, token: hit.token, x: local.x, y: local.y, sx, sy }
      }
    }
    if (!target) target = { pid, windowId, x: local.x, y: local.y, sx, sy }
  } else {
    throw new Error('必须提供 element（观察编号）或 x/y 坐标。')
  }
  if (args.zoom) extra = { ...extra, fromZoom: true }
  // zoom 坐标越界保护：最近一次 screen_zoom 的图片尺寸就是可用范围，
  // 超界说明又把"预览/窗口坐标"当成图内坐标了（实测因此偏过 106px）。
  if (args.zoom) {
    const z = getSnapshot()?.zoom
    const iw = z?.image?.width
    const ih = z?.image?.height
    if (iw && args.x != null && args.y != null
      && (Number(args.x) < 0 || Number(args.y) < 0 || Number(args.x) > iw || Number(args.y) > ih)) {
      return {
        ok: false,
        result: `坐标 (${args.x},${args.y}) 超出最近一次 screen_zoom 的图片范围 0..${iw} × 0..${ih}：`
          + '请重新 screen_zoom 量取图内坐标（不是窗口 PNG 坐标），或改用 element 编号点击。',
      }
    }
  }

  const mode = deliveryMode(args)
  // restorePointer：前台投递会由引擎用 SendInput 把真实指针搬到落点且不还原，
  // 这个开关（默认开）让 humanClick 在动作后把指针放回原位。
  const restorePointer = cfg?.restoreRealPointer !== false
  let value = await deps.humanClick({ ...target, ...extra, deliveryMode: mode, restorePointer })
  let escalated = false
  // 仅在引擎明确报告"后台未送达"时改前台重投；unverifiable 已可能送达，重投会双触发。
  if (!mode && backgroundUnavailable(value)) {
    const retry = await deps.humanClick({ ...target, ...extra, deliveryMode: 'foreground', restorePointer })
    escalated = true
    value = retry
  }
  // 元素 token 自愈：screen_zoom / 补抓都会作废引擎侧 index→token 映射。
  // 这里重取一次窗口树、按编号重映射 token 后重试一次，不必让模型重新观察。
  // 坐标自动晋升成元素的场景同样适用（autoElement.index）。
  const elementIndex = args.element !== undefined && args.element !== null
    ? Number(args.element)
    : (autoElement ? autoElement.index : null)
  if (elementIndex !== null && /stale_element_token/.test(String(engineRefusal(value) || ''))) {
    const refreshed = await refreshSnapshot(target.pid, target.windowId, cfg).catch(() => null)
    if (refreshed) {
      const t = resolveClickTarget(elementIndex, cfg.ttlMs)
      value = await deps.humanClick({
        pid: t.pid,
        windowId: t.windowId,
        token: t.token,
        x: t.x,
        y: t.y,
        sx: t.sx,
        sy: t.sy,
        ...extra,
        deliveryMode: mode,
        restorePointer,
      })
    }
  }
  // 落点自证：把"实际点的是哪个像素"写进结果，避免模型只能靠猜。
  // PNG = 截图坐标（= 点击坐标空间），屏幕 = 加上窗口左上角后的物理位置。
  const snapNow = getSnapshot()
  const elInfo = elementIndex !== null ? snapNow?.entries?.get(elementIndex) : null
  const bx = snapNow?.space?.bounds?.x
  const by = snapNow?.space?.bounds?.y
  const hasPoint = target.sx != null && target.sy != null
  const elTag = elInfo ? ` [${elementIndex}] ${elInfo.role || ''}"${elInfo.label || ''}"` : ''
  // 自动晋升说明：模型给的是像素坐标，但那个点其实是个可调用元素，已改走 UIA 通道。
  const autoNote = autoElement
    ? `（坐标命中可调用元素 [${autoElement.index}] ${autoElement.role}"${autoElement.label}"，已自动改用元素点击：不碰真实指针）`
    : ''
  const where = hasPoint
    ? (args.zoom
      // zoom 图内坐标：还没换算，交给引擎，别冒充窗口 PNG 坐标
      ? ` 目标${elTag} zoom图(${target.sx},${target.sy})（引擎换算回窗口坐标）`
      : ` 目标${elTag} PNG(${target.sx},${target.sy})${bx != null ? ` 屏幕(${bx + target.sx},${by + target.sy})` : ''}`)
    : elTag
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `${label} 被引擎拒绝${where}${autoNote}：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  const effect = typeof value === 'object' ? value?.effect : null
  const via = typeof value === 'object' ? value?.delivery?.mode : null
  let note = ''
  if (escalated) {
    note = '（后台投递对 Chromium/Electron 内容无效，已自动改前台投递；引擎对合成输入不回执，需要确认时用 screen_zoom 复核）'
  } else if (deliveryUncertain(value)) {
    note = '（⚠ 引擎报告 unverifiable：合成输入无回执，请用 screen_zoom 复查该处是否发生变化）'
  }
  const meta = [via ? `投递=${via}` : '', effect ? `effect=${effect}` : ''].filter(Boolean).join(' ')
  // 指针隔离回报：前台投递把真实指针搬到落点后已还原（用户要的"两个各干各的"）。
  // 不做"是否真的回到原位"的事后判断（用户要求），只按还原调用是否成功如实报告。
  const pg = getLastPointerGuard()
  const foregroundAction = mode === 'foreground' || escalated
  let pointerNote = ''
  if (pg?.restored) {
    pointerNote = `；真实鼠标指针被前台投递搬动过，已放回原位（${pg.before.x},${pg.before.y}）`
  } else if (pg && foregroundAction) {
    pointerNote = `；⚠ 前台投递搬动了真实鼠标指针，但还原调用失败（动作前位置 ${pg.before.x},${pg.before.y}），请检查鼠标位置`
  }
  return { ok: true, result: `${label} 完成${where}${autoNote}${note}${meta ? ` [${meta}]` : ''}${pointerNote}：${detail}` }
}

/** computer_click —— 真人操作：光标滑行 + 像素点击 */
export async function click(args, cfg) {
  const extra = {}
  if (args.count) extra.count = Number(args.count)
  return humanAction('点击', args, cfg, extra)
}

/** computer_double_click */
export async function doubleClick(args, cfg) {
  return humanAction('双击', args, cfg, { count: 2 })
}

/** computer_right_click */
export async function rightClick(args, cfg) {
  return humanAction('右键点击', args, cfg, { button: 'right' })
}

/** computer_type —— 文本输入（可指定元素，否则输入到前台应用当前焦点） */
export async function typeText(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  if (!args.text) throw new Error('computer_type: 缺少 text 参数。')
  // CDP 页面元素优先：带 ref 的元素直接用浏览器调试协议输入，不用键盘/鼠标。
  const snap0 = getSnapshot()
  if (args.element !== undefined && args.element !== null && snap0?.browser) {
    const entry = snap0.entries?.get(Number(args.element))
    if (entry?.ref) return browserTypeAction(args, cfg, snap0, entry)
  }
  const buildPayload = () => {
    const p = withSession({ text: String(args.text) })
    if (args.element !== undefined && args.element !== null) {
      const { pid, token } = resolveToken(Number(args.element), cfg.ttlMs)
      p.pid = pid
      p.element_token = token
    } else {
      // 即使输入当前焦点，也必须绑定到新鲜观察快照的窗口，禁止盲发到 desktop scope。
      const { pid, windowId } = resolve(cfg.ttlMs)
      p.pid = pid
      p.window_id = windowId
    }
    return p
  }
  let esc = await callWithEscalation(call, 'type_text', buildPayload(), args)
  if (args.element !== undefined && args.element !== null
    && /stale_element_token/.test(String(engineRefusal(normalizeMcp(esc.value)) || ''))) {
    const snap = getSnapshot()
    if (snap) {
      await refreshSnapshot(snap.pid, snap.windowId, cfg).catch(() => null)
      esc = await callWithEscalation(call, 'type_text', buildPayload(), args)
    }
  }
  const value = normalizeMcp(esc.value)
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `输入被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `输入完成${deliveryNote(value, esc.escalated)}：${detail}` }
}

/** computer_key —— 按键 / 快捷键（如 return、cmd+c） */
export async function key(args, cfg) {
  return dispatchKey(args, cfg)
}

/**
 * computer_key dispatch with optional dependencies for deterministic tests.
 * Bare keys stay on press_key for classic Win32; modifier combinations use
 * hotkey so UIA/XAML accelerators receive the event.
 */
export async function dispatchKey(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  if (!args.key) throw new Error('computer_key: 缺少 key 参数。')
  const parts = String(args.key).toLowerCase().split('+').map((s) => s.trim())
  const MODS = new Set(['cmd', 'command', 'ctrl', 'control', 'option', 'alt', 'shift', 'fn'])
  const modifiers = parts.filter((p) => MODS.has(p)).map((p) => {
    if (p === 'command') return 'cmd'
    if (p === 'control') return 'ctrl'
    if (p === 'option') return 'alt'
    return p
  })
  const keyName = parts.filter((p) => !MODS.has(p))[0]
  if (!keyName) throw new Error('computer_key: 无法解析按键（示例: return / cmd+c / shift+tab）。')
  const isCombo = modifiers.length > 0
  // Both routes require a fresh snapshot and retain pid + window_id targeting.
  // 注：只传 pid 在多窗口应用（QQ 等）会歧义，必须带 window_id
  const { pid, windowId } = resolve(cfg.ttlMs)
  const target = { pid, window_id: windowId }
  const payload = withSession(isCombo
    ? { keys: [...modifiers, keyName], ...target }
    : { key: keyName, ...target })
  const tool = isCombo ? 'hotkey' : 'press_key'
  const esc = await callWithEscalation(call, tool, payload, args)
  const value = normalizeMcp(esc.value)
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `按键被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `按键完成 (${String(args.key)})${deliveryNote(value, esc.escalated)}：${detail}` }
}

/** computer_scroll */
export async function scroll(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  const dir = args.direction || 'down'
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error('computer_scroll: direction 必须是 up/down/left/right。')
  }
  // CDP 页面滚动优先（不经过系统鼠标）
  const snap0 = getSnapshot()
  if (snap0?.browser && args.element === undefined) {
    const binding = browserBindingOf(snap0)
    const value = await scrollPage(binding, { direction: dir, amount: args.amount })
    const refusal = engineRefusal(value)
    if (refusal) return { ok: false, result: `滚动被 CDP 拒绝（页面元素 · 不经过系统鼠标）：${refusal}` }
    const detail = typeof value === 'string' ? value : JSON.stringify(value)
    return { ok: true, result: `滚动完成 (${dir})（CDP 页面 · 不经过系统鼠标）：${detail}` }
  }
  const payload = withSession({ direction: dir })
  if (args.amount) payload.amount = Number(args.amount)
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(Number(args.element), cfg.ttlMs)
    payload.pid = pid
    payload.element_token = token
  } else {
    const { pid, windowId } = resolve(cfg.ttlMs)
    payload.pid = pid
    payload.window_id = windowId
  }
  const esc = await callWithEscalation(call, 'scroll', payload, args)
  const value = normalizeMcp(esc.value)
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `滚动被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `滚动完成 (${dir})${deliveryNote(value, esc.escalated)}：${detail}` }
}

/** computer_drag —— 拖拽（坐标 = 窗口本地截图像素，与观察输出同空间） */
export async function drag(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  const { pid, windowId } = resolve(cfg.ttlMs)
  if ([args.from_x, args.from_y, args.to_x, args.to_y].some((v) => v === undefined)) {
    throw new Error('computer_drag: 需要 from_x/from_y/to_x/to_y。')
  }
  const payload = withSession({
    pid,
    window_id: windowId,
    from_x: Number(args.from_x),
    from_y: Number(args.from_y),
    to_x: Number(args.to_x),
    to_y: Number(args.to_y),
  })
  if (args.duration_ms) payload.duration_ms = Number(args.duration_ms)
  // 落点自证：拖拽起止点同样写进结果
  const where = ` 目标 PNG(${payload.from_x},${payload.from_y})→(${payload.to_x},${payload.to_y})`
  const value = normalizeMcp(await call('drag', payload))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `拖拽被引擎拒绝${where}：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `拖拽完成${where}：${detail}` }
}

/** computer_wait —— 本地等待（不调引擎） */
export async function wait(args) {
  const ms = Math.max(0, Math.min(Number(args.ms) || 1000, 60000))
  await new Promise((r) => setTimeout(r, ms))
  return { ok: true, result: `已等待 ${ms}ms。` }
}

/** app_list —— 列出应用 */
export async function listApps() {
  const value = await cuaCall('list_apps')
  const apps = (value.apps || []).filter((a) => a.running)
  const lines = apps.map((a) => {
    const win = a.windows && a.windows.length > 0 ? ` (${a.windows.length} 窗口)` : ''
    return `- ${a.name}${win} [pid=${a.pid}]${a.active ? ' ★活动' : ''}`
  })
  const result = `正在运行的应用（${apps.length} 个）：\n${lines.join('\n')}`
  return { ok: true, result, apps: apps.map((a) => ({ name: a.name, pid: a.pid, active: a.active })) }
}

/** app_launch —— 启动应用（后台），可选前置 */
export async function launchApp(args) {
  if (!args.name && !args.bundle_id) {
    throw new Error('app_launch: 需要 name（应用名）或 bundle_id。')
  }
  const payload = {}
  if (args.bundle_id) payload.bundle_id = String(args.bundle_id)
  else payload.name = String(args.name)
  if (args.creates_new_instance) payload.creates_new_instance = true
  const launched = await cuaCall('launch_app', payload)

  // 若请求前置，找 pid 并 bring_to_front
  let pid = launched?.pid ?? null
  let frontNote = ''
  if (args.bring_to_front && pid) {
    // bring_to_front 在部分窗口上会顺带搬动真实指针（实测有过），且引擎返回值里
    // 没有 route 字段，所以用 force 守卫：指针动了就放回原位。
    const before = await readRealPointer()
    await withPointerGuard({ before, expectedPoint: null, pid, force: true }, () => cuaCall('bring_to_front', { pid }))
    frontNote = ' 已前置'
  }

  const detail = typeof launched === 'string' ? launched : JSON.stringify(launched)
  return {
    ok: true,
    result: `应用已启动${frontNote}：${detail}`,
    pid,
  }
}
