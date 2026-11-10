/**
 * space.js —— 坐标系换算与空间判定（纯函数，无副作用，可单测）。
 *
 * 背景（cua-driver 0.28 契约）：
 *   - `get_window_state` 返回的 PNG 可能被 `max_image_dimension` 缩放，
 *     此时 `screenshot_width/height` 是**缩放后**的 PNG 尺寸；
 *   - 元素 `frame` 是 **窗口/屏幕原生像素**（Windows 上通常等同屏幕物理像素）；
 *   - `click` 的 x/y 是 **PNG 像素**（左上原点）；
 *   - `zoom` 的 x1..y2 也是 PNG 像素，且引擎会自动外扩 20% 内边距，
 *     返回图片是放大后的裁剪图；
 *   - `zoom` 之后可用 `from_zoom: true` 让引擎把"裁剪图内坐标"换回窗口坐标。
 *
 * 因此本模块只做三件事：
 *   1. 由 `window_bounds` + PNG 尺寸算出 PNG↔屏幕的比例；
 *   2. 判断 AX frame 究竟是"PNG 空间"还是"屏幕空间/页面空间"，避免把
 *      页面坐标当成可点击坐标输出；
 *   3. 提供 PNG→屏幕 的换算（用于校验/调试输出）。
 */

/** 取浮点，非法值回退 null。 */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 组装空间信息。
 * @param {object} state - get_window_state 的返回（含 screenshot_width/height、window_bounds）
 * @param {object} win - list_windows 里的窗口记录（含 bounds）
 * @returns {object} space
 */
export function computeSpace(state = {}, win = null) {
  const pngW = num(state.screenshot_width) ?? num(win?.bounds?.width) ?? 0
  const pngH = num(state.screenshot_height) ?? num(win?.bounds?.height) ?? 0
  const b = state.window_bounds || win?.bounds || null
  const bx = num(b?.x)
  const by = num(b?.y)
  const bw = num(b?.width)
  const bh = num(b?.height)
  const valid = Boolean(pngW > 0 && pngH > 0 && bw > 0 && bh > 0)
  return {
    pngW,
    pngH,
    bounds: valid ? { x: bx, y: by, width: bw, height: bh } : null,
    scaleX: valid ? pngW / bw : null,
    scaleY: valid ? pngH / bh : null,
    /** PNG 是否被缩放（缩略图） */
    downscaled: valid ? Math.abs(pngW / bw - 1) > 0.02 : false,
  }
}

/** 屏幕坐标 → PNG 坐标。 */
export function screenToPng(x, y, space) {
  if (!space?.bounds) return null
  const px = (x - space.bounds.x) * space.scaleX
  const py = (y - space.bounds.y) * space.scaleY
  return { x: Math.round(px), y: Math.round(py) }
}

/** PNG 坐标 → 屏幕坐标（引擎内部就是这么换算的，供调试/校验）。 */
export function pngToScreen(x, y, space) {
  if (!space?.bounds) return null
  return {
    x: Math.round(space.bounds.x + x / space.scaleX),
    y: Math.round(space.bounds.y + y / space.scaleY),
  }
}

/**
 * 判定元素 frame 属于哪个坐标空间。
 * - 'png'    ：frame 已经落在 PNG 尺寸内 → 可直接当点击坐标用；
 * - 'screen' ：frame 落在窗口 bounds 内但超出 PNG → 可用 bounds+scale 换算；
 * - 'page'   ：frame 远超窗口范围（典型：网页文档坐标）→ 不可直接点击；
 * - 'none'   ：无 frame。
 * @param {Array} elements - [{frame:{x,y,w,h}}]
 * @param {object} space
 */
export function detectFrameSpace(elements, space) {
  const frames = (elements || []).map((e) => e?.frame).filter(Boolean)
  if (frames.length === 0 || !space?.pngW) return 'none'
  let maxX = 0
  let maxY = 0
  for (const f of frames) {
    const x = num(f.x)
    const y = num(f.y)
    const w = num(f.w) ?? 0
    const h = num(f.h) ?? 0
    if (x == null || y == null) continue
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  // 1) 全部落在 PNG 内 → PNG 空间
  if (maxX <= space.pngW * 1.001 && maxY <= space.pngH * 1.001) return 'png'
  // 2) 落在窗口 bounds 内 → 屏幕空间
  if (space.bounds) {
    const b = space.bounds
    if (maxX <= b.x + b.width * 1.02 && maxY <= b.y + b.height * 1.02 && maxX >= b.x * 0.98) return 'screen'
  }
  // 3) 其它（含网页文档坐标、坐标轴原点不在窗口左上角的情形）
  return 'page'
}

/**
 * 元素 frame → PNG 坐标（仅在空间已知且可换算时返回）。
 * @returns {{x:number,y:number,estimated:boolean}|null}
 */
export function frameCenterToPng(frame, frameSpace, space) {
  if (!frame || !space) return null
  const fx = num(frame.x)
  const fy = num(frame.y)
  const fw = num(frame.w) ?? 0
  const fh = num(frame.h) ?? 0
  if (fx == null || fy == null) return null
  const cx = fx + fw / 2
  const cy = fy + fh / 2
  if (frameSpace === 'png') return { x: Math.round(cx), y: Math.round(cy), estimated: false }
  if (frameSpace === 'screen') {
    const p = screenToPng(cx, cy, space)
    return p ? { ...p, estimated: true } : null
  }
  return null
}

/**
 * 元素 frame（矩形的左上角+宽高）→ PNG 坐标矩形。
 * 用于「像素坐标命中元素」的判定（能点元素就别用像素/视觉点击）。
 * @returns {{x:number,y:number,w:number,h:number,estimated:boolean}|null}
 */
export function frameRectToPng(frame, frameSpace, space) {
  if (!frame || !space) return null
  const fx = num(frame.x)
  const fy = num(frame.y)
  const fw = num(frame.w)
  const fh = num(frame.h)
  if (fx == null || fy == null || fw == null || fh == null) return null
  if (frameSpace === 'png') {
    return { x: Math.round(fx), y: Math.round(fy), w: Math.round(fw), h: Math.round(fh), estimated: false }
  }
  if (frameSpace === 'screen') {
    const p = screenToPng(fx, fy, space)
    if (!p) return null
    return {
      x: p.x,
      y: p.y,
      w: Math.round(fw * (space.scaleX ?? 1)),
      h: Math.round(fh * (space.scaleY ?? 1)),
      estimated: true,
    }
  }
  return null
}

/** 人读的空间描述，放在 observe 头部。 */
export function describeSpace(space, frameSpace) {
  if (!space) return ''
  const parts = [`PNG=${space.pngW}x${space.pngH}`]
  if (space.bounds) parts.push(`窗口=${space.bounds.width}x${space.bounds.height}`)
  if (space.downscaled && space.scaleX) parts.push(`缩放=${space.scaleX.toFixed(3)}（点击坐标=PNG 像素）`)
  const fs = {
    png: '元素坐标=PNG 像素',
    screen: '元素坐标=屏幕像素（已换算为 PNG）',
    page: '元素坐标为页面坐标，不可直接点击',
    none: '无元素坐标',
  }[frameSpace]
  if (fs) parts.push(fs)
  return parts.join(' ')
}
