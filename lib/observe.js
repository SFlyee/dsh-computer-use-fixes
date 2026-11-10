/**
 * observe.js —— screen_observe 工具实现（含原生视觉 Mode C / 观察者 Mode D）。
 *
 * 流程：list_windows 取窗口 → 选目标 → get_window_state 取 AX 树
 * → 精简为"编号 + 角色 + 标签 + 中心坐标"行 → 缓存快照。
 *
 * 坐标语义（cua-driver 0.21+ 实测）：所有动作坐标 = "窗口本地截图像素"，
 * 与 get_window_state 返回的截图 PNG 同一空间（左上原点）。因此：
 *   - 元素编号模式 → element_token（AX 路径，无需坐标）
 *   - x/y 坐标模式 → 直接透传截图像素，不做 ×2 / 窗口偏移换算
 *
 * 三种观察模式：
 *   - ax（默认）：只取 AX 树，零视觉 token 成本。
 *   - vision：DeepSeek 视觉观察者（ctx.llm → deepseek-v4-flash-vision-exp，
 *     可配置 visionProvider/visionModel）结构化描述截图；模型不可用时回退 GLM。
 *   - native：截图经 attachments 持久化后以图片块("原生直读")返回 ——
 *     主对话模型（需支持 image 输入）直接看图，零外部 API。
 *   自动降级：AX 树为空（游戏/Canvas/Electron 不可解析）时，
 *   优先 native（route 支持 image）→ vision（有观察模型/GLM key）→ ax。
 */
import { withSession } from './cua.js'
import { cuaCall } from './cua.js'
import { computeSpace, detectFrameSpace, frameCenterToPng, frameRectToPng, describeSpace } from './space.js'
import { bindBrowser, pageSnapshot, isChromiumWindow } from './browser.js'
import { setSnapshot, getSnapshot } from './snapshot.js'
import {
  deepseekVisionDescribe,
  glmVisionDescribe,
  glmVisionConfigured,
  routeImageCapable,
} from './vision.js'

/** AX role 中值得展示的精简角色名（太长会刷爆上下文）。 */
const ROLE_SHORT = {
  AXWindow: '窗口',
  AXButton: '按钮',
  AXTextField: '输入框',
  AXTextArea: '文本框',
  AXCheckBox: '复选框',
  AXRadioButton: '单选',
  AXComboBox: '下拉框',
  AXMenuButton: '菜单按钮',
  AXMenuItem: '菜单项',
  AXLink: '链接',
  AXTab: '标签页',
  AXSlider: '滑块',
  AXScrollBar: '滚动条',
  AXTable: '表格',
  AXCell: '单元格',
  AXRow: '行',
  AXOutline: '大纲',
  AXList: '列表',
  AXStaticText: '文本',
  AXImage: '图片',
  AXPopUpButton: '弹出按钮',
  AXGroup: '分组',
  AXToolbar: '工具栏',
  AXSheet: '面板',
  AXDialog: '对话框',
}

function shortRole(role) {
  return ROLE_SHORT[role] || (role ? role.replace(/^AX/, '') : '元素')
}

/** 清洗为安全字符串：保证可无损 JSON 序列化（去孤立代理项）+ 截断。 */
function safeStr(v, max = 120) {
  let s = String(v ?? '')
  // 孤立代理项（Safari/网页 AX 值常见）会导致 JSON 序列化失败
  s = s.replace(/[\uD800-\uDFFF]/g, '\uFFFD')
  return s.slice(0, max)
}

/** 是否值得给编号（可交互或有关键文本）。 */
function isActionable(e) {
  const r = e.role || ''
  if (['AXButton', 'AXTextField', 'AXTextArea', 'AXCheckBox', 'AXRadioButton',
    'AXComboBox', 'AXMenuButton', 'AXMenuItem', 'AXLink', 'AXTab', 'AXSlider',
    'AXPopUpButton', 'AXCell', 'AXRow', 'AXScrollBar'].includes(r)) return true
  if (e.label || e.value) return true
  return false
}

/**
 * 元素中心坐标（PNG 像素空间 = 点击坐标空间）。
 * frameSpace 判定见 space.js：只有 png/screen 两种空间能换算成可点击坐标，
 * page 空间（网页文档坐标）直接返回 null，绝不输出会被误点的假坐标。
 */
function centerOf(e, spaceCtx) {
  if (!e.frame) return null
  const p = frameCenterToPng(e.frame, spaceCtx?.frameSpace, spaceCtx?.space)
  if (!p) return null
  return { x: p.x, y: p.y, estimated: p.estimated }
}

/** 渲染一行编号元素。 */
function renderLine(e, spaceCtx) {
  const role = shortRole(e.role)
  const label = safeStr(e.label || e.value || '')
  const parts = [`[${e.element_index}] ${role}`]
  if (label) parts.push(`"${label}"`)
  const c = centerOf(e, spaceCtx)
  if (c) parts.push(`${c.estimated ? '≈' : ''}@(${c.x},${c.y})`)
  return parts.join(' ')
}

/** 构造视觉提问（坐标系 = 截图像素 = 动作坐标）。 */
function visionQuestion(w, h) {
  return `这是一张电脑应用窗口的截图，宽 ${w}px，高 ${h}px（坐标原点左上角，坐标为窗口本地截图像素）。
请用中文描述界面内容，并列出所有可交互元素（按钮、输入框、菜单、链接、图标等），每项格式：
[序号] 类型 "文字" @(x,y)
坐标 x,y 为该元素中心在截图中的像素位置。只输出列表，最多 30 项，不要多余解释。`
}

/** base64 → Buffer。 */
function buf(b64) {
  return Buffer.from(String(b64 || ''), 'base64')
}

/**
 * 把 get_window_state 的截图提交到 attachments（原生直读 / 观察者都需要）。
 * PNG 超过单图字节限额时自动降级为引擎 zoom（整窗 JPEG，≤500px 宽）。
 * @returns {Promise<{ref:object, width:number, height:number, compact:boolean}>}
 */
async function commitScreenshot(ctx, target, state, cfg) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments) {
    throw new Error('当前环境未挂载 attachments 服务，无法持久化截图（原生视觉不可用）。')
  }
  const pngBuf = buf(state.screenshot_png_b64)
  const maxBytes = attachments.imageLimits?.maxImageBytes ?? 5 * 1024 * 1024
  const compact = cfg.nativeImage === 'compact'
    || (cfg.nativeImage !== 'full' && pngBuf.byteLength > maxBytes)

  let data = pngBuf
  let mediaType = state.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  let width = state.screenshot_width
  let height = state.screenshot_height
  let name = `screen-${target.pid}.png`

  if (compact) {
    // 缩略图：让引擎把长边直接缩到 ≤500px。
    // 注意 zoom 有"单次区域任一边 ≤500px"的硬限制，整窗 zoom 必然报
    // "Zoom region too wide"，所以这里不能再用 zoom 做整窗降级。
    let shot = null
    try {
      shot = await cuaCall('get_window_state', {
        pid: target.pid,
        window_id: target.window_id,
        include_accessibility_tree: false,
        include_screenshot: true,
        max_dimension: 500,
      })
    } catch { shot = null }
    let jpeg = buf(shot?.screenshot_png_b64)
    if (jpeg.byteLength === 0) {
      // 兜底：引擎不支持 max_dimension 时只截左上角 500×500（绝不整窗请求）
      const zv = await cuaCall('zoom', withSession({
        pid: target.pid,
        window_id: target.window_id,
        x1: 0,
        y1: 0,
        x2: Math.min(state.screenshot_width || 500, 500),
        y2: Math.min(state.screenshot_height || 500, 500),
      }))
      jpeg = buf(zv?.screenshot_png_b64)
    }
    if (jpeg.byteLength === 0) throw new Error('紧凑截图失败：引擎返回空图片。')
    data = jpeg
    mediaType = shot?.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    width = shot?.screenshot_width || width
    height = shot?.screenshot_height || height
    name = `screen-${target.pid}-compact.${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`
  }

  const ref = await attachments.saveImage({ data, mediaType, name })
  return { ref, width, height, compact }
}

/** 观察者（Mode D）：DeepSeek 视觉模型描述，失败回退 GLM。 */
async function describeVision(ctx, cfg, state, target, exec, question) {
  const w = state.screenshot_width || 0
  const h = state.screenshot_height || 0
  const q = question || visionQuestion(w, h)
  // 1. 优先 DeepSeek 观察者（需 attachments 持久化 + llm 服务）
  const attachments = ctx?.get?.('attachments')
  const llm = ctx?.get?.('llm')
  if (llm && attachments) {
    try {
      const { ref, compact } = await commitScreenshot(ctx, target, state, cfg)
      const text = await deepseekVisionDescribe(ctx, cfg, {
        imageRef: ref,
        question: q,
      })
      return `（观察者 ${cfg.visionProvider}/${cfg.visionModel}${compact ? ' · 紧凑图' : ''}）\n${text}`
    } catch (err) {
      // 观察者不可用 → 记录后走 GLM
      return `（DeepSeek 观察者不可用：${err.message}）\n${await glmVisionDescribe({
        imageBase64: state.screenshot_png_b64,
        mimeType: state.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        question: q,
      }).catch((e2) => `（视觉理解失败：${e2.message}）`)}`
    }
  }
  // 2. 无 llm/attachments：GLM 直传
  return glmVisionDescribe({
    imageBase64: state.screenshot_png_b64,
    mimeType: state.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    question: q,
  }).catch((err) => `（视觉理解失败：${err.message}）`)
}

/**
 * 执行 screen_observe。
 * @param {object} ctx - Cordis 上下文（llm / attachments 服务）
 * @param {object} args - { window?, mode?, query?, maxElements? }
 * @param {object} cfg - 插件配置（ttlMs / maxElements / nativeImage / visionProvider / visionModel）
 * @param {object} exec - 工具执行上下文（取当前 route）
 */
export async function screenObserve(ctx, args, cfg, exec) {
  const wantMode = args.mode
  const maxElements = args.maxElements || cfg.maxElements || 500

  // 1. 窗口列表
  const winList = await cuaCall('list_windows', { on_screen_only: true })
  const windows = (winList.windows || []).filter((w) => w.window_id && (w.title || w.app_name))

  if (windows.length === 0) {
    return { ok: false, result: '当前没有可见窗口。' }
  }

  // 2. 选目标窗口：参数 window（pid / 标题子串）→ 否则 z 序最前
  let target = null
  const want = args.window
  if (want !== undefined && want !== null && want !== '') {
    const wantStr = String(want)
    target = windows.find((w) => String(w.pid) === wantStr)
      || windows.find((w) => (w.title || '').toLowerCase().includes(wantStr.toLowerCase()))
      || windows.find((w) => (w.app_name || '').toLowerCase().includes(wantStr.toLowerCase()))
  }
  if (!target && want !== undefined && want !== null && want !== '') {
    const candidates = windows
      .map((w) => `${w.app_name || ''} · ${w.title || ''} · pid=${w.pid}`)
      .join('\n')
    return {
      ok: false,
      result:
        `未找到指定窗口「${String(want)}」，已拒绝继续操作。\n` +
        `当前可见窗口：\n${candidates || '无'}`,
    }
  }
  if (!target) {
    const sorted = [...windows].sort((a, b) => (b.z_index || 0) - (a.z_index || 0))
    target = sorted[0]
  }

  // 2.5 浏览器 CDP 页面通道（Chromium 窗口）：网页元素直接来自浏览器调试协议，
  //     之后的点击/输入走 CDP，不产生任何系统鼠标事件。失败则退回原 UIA/视觉路径，
  //     并把原因附在结果里（这样模型知道"网页内容在这里看不到"该换策略）。
  let cdpFallbackNote = ''
  if (cfg.browserCdp !== false && (!wantMode || wantMode === 'ax') && isChromiumWindow(target)) {
    const cdp = await cdpObserve(target, cfg, maxElements)
    if (cdp?.ok) return cdp
    cdpFallbackNote = `\n（CDP 页面通道不可用：${cdp?.reason || '未知原因'}；网页内容不在 UIA 元素树里，坐标点击会退回系统鼠标路径）`
  }

  // 3. AX 树（vision / native 模式同时抓截图）
  const needShot = wantMode === 'vision' || wantMode === 'native'
  const gwArgs = {
    pid: target.pid,
    window_id: target.window_id,
    include_screenshot: needShot,
    max_elements: maxElements,
  }
  if (args.query) gwArgs.query = String(args.query)
  let state = await cuaCall('get_window_state', gwArgs)
  const rawElements = Array.isArray(state.elements) ? state.elements : []
  const elements = rawElements.filter(isActionable)
  // 截图缺失（首次 ax 调用后才降级）→ 补抓
  const needShotNow = needShot || (wantMode !== 'vision' && wantMode !== 'native'
    && (Boolean(state.degraded_reason) || rawElements.length === 0) && (await routeImageCapable(ctx, exec) || glmVisionConfigured()))
  if (needShotNow && !state.screenshot_png_b64) {
    const v = await cuaCall('get_window_state', {
      pid: target.pid,
      window_id: target.window_id,
      include_screenshot: true,
      max_elements: maxElements,
    })
    state = { ...state, ...v }
  }

  // 4. 坐标空间判定（PNG 尺寸 vs 窗口 bounds vs AX frame 空间）
  const space = computeSpace(state, target)
  const frameSpace = detectFrameSpace(rawElements, space)
  const spaceCtx = { space, frameSpace }

  // 5. 模式决策
  const degraded = Boolean(state.degraded_reason) || rawElements.length === 0
  let effectiveMode = 'ax'
  let visionText = ''
  let image = null

  if (wantMode === 'native') {
    const capable = await routeImageCapable(ctx, exec)
    if (!capable) {
      const { provider, model } = { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model }
      return {
        ok: false,
        result: `原生视觉模式（mode="native"）需要当前对话模型支持图片输入，但当前 route ${provider}/${model} 未声明 image 能力。`
          + '请切换到视觉模型（如 deepseek-v4-flash-vision-exp），或使用 mode="vision"（观察者）/ mode="ax"。',
      }
    }
    try {
      const { ref, width, height, compact } = await commitScreenshot(ctx, target, state, cfg)
      image = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width ?? width,
        height: ref.height ?? height,
        name: ref.name,
      }
      effectiveMode = 'native'
      visionText = compact
        ? '（紧凑图：原始截图超附件限额，已用引擎 zoom 降采样为 ≤500px JPEG）'
        : ''
    } catch (err) {
      return { ok: false, result: `原生截图失败：${err.message}` }
    }
  } else if (wantMode === 'vision') {
    visionText = await describeVision(ctx, cfg, state, target, exec)
    effectiveMode = 'vision'
  } else { // ax 默认
    if (degraded) {
      if (await routeImageCapable(ctx, exec)) {
        try {
          const { ref, width, height } = await commitScreenshot(ctx, target, state, cfg)
          image = { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width ?? width, height: ref.height ?? height, name: ref.name }
          effectiveMode = 'native'
        } catch {
          effectiveMode = 'ax'
        }
      } else if (glmVisionConfigured()) {
        visionText = await describeVision(ctx, cfg, state, target, exec)
        effectiveMode = 'vision'
      }
    }
  }

  // 6. 渲染（先渲染再落快照：渲染失败时不应留下可被"盲操作"的快照）
  //    spaceCtx 是坐标空间上下文；传 ctx 会触发 Cordis "cannot get property ... without inject"。
  const lines = elements.map((e) => renderLine(e, spaceCtx))

  // 7. 快照缓存（element_token 自带的 snapshot_id 由引擎校验）
  const entries = new Map()
  for (const e of elements) {
    const c = centerOf(e, spaceCtx)
    entries.set(e.element_index, {
      token: e.element_token,
      role: safeStr(e.role, 40),
      label: safeStr(e.label || e.value || '', 100),
      x: c ? c.x : null,
      y: c ? c.y : null,
      // 元素矩形（PNG 像素）：computer_click 传 x/y 时用它判断"这个点其实是个按钮"，
      // 命中就走 element_token（UIA 调用，不碰真实指针），否则才用像素/视觉点击。
      rect: frameRectToPng(e.frame, frameSpace, space),
    })
  }
  setSnapshot({
    at: Date.now(),
    ttlMs: cfg.ttlMs,
    pid: target.pid,
    windowId: target.window_id,
    appName: target.app_name || '',
    snapshotId: state.snapshot_id,
    entries,
    elementCount: state.element_count,
    totalElementCount: state.total_element_count,
    mode: effectiveMode,
    screenshotWidth: state.screenshot_width || null,
    screenshotHeight: state.screenshot_height || null,
    space,
    frameSpace,
    zoom: null,
  })

  let modeNote = `模式=${effectiveMode}`
  if (effectiveMode === 'vision') {
    modeNote += degraded && wantMode !== 'vision' ? '（AX 树为空自动降级）' : ''
  } else if (effectiveMode === 'native') {
    modeNote += degraded && wantMode !== 'native' ? '（AX 树为空自动降级）' : ''
  }
  const spaceNote = describeSpace(space, frameSpace)
  const header = [
    `窗口: ${safeStr(target.app_name)} · ${safeStr(target.title)}`,
    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=PNG 像素${spaceNote ? ' · ' + spaceNote : ''}`,
    effectiveMode === 'ax'
      ? `可见元素 ${lines.length} 个（树共 ${state.element_count}/${state.total_element_count}，快照 ${state.snapshot_id}）`
      : effectiveMode === 'native'
        ? `AX 元素 ${lines.length} 个，原生直读截图如下 ${visionText}`
        : `AX 元素 ${lines.length} 个，视觉描述如下`,
  ].join('\n')

  const body = lines.length > 0
    ? lines.join('\n')
    : effectiveMode === 'native'
      ? '(AX 树无可用元素 —— 请直接看图，用截图坐标点击；坐标空间 = 这张 PNG 的像素)'
      : '(AX 树无可用元素)'

  const visionBlock = visionText && effectiveMode === 'vision' ? `\n── 视觉理解 ──\n${visionText}` : ''
  const clickHint = frameSpace === 'page'
    ? '提示: 该窗口元素坐标不可直接点击 —— 请用 computer_click(element=[编号])，或先 screen_zoom 再把图内坐标加 zoom=true 点击。'
    : '提示: 用 computer_click(element=[编号]) 或 computer_click(x=, y=) 操作（坐标为 PNG 像素，与截图同一空间）；screen_zoom 图内坐标需加 zoom=true。'

  return buildObserveOutput({
    ok: true,
    result: `${header}\n${body}${visionBlock}\n\n${clickHint}${cdpFallbackNote}`,
    window: { pid: target.pid, windowId: target.window_id, app: safeStr(target.app_name, 60), title: safeStr(target.title, 80) },
    elementCount: elements.length,
    mode: effectiveMode,
    elements: elements.map((e) => {
      const c = centerOf(e, spaceCtx)
      return {
        index: e.element_index,
        role: safeStr(shortRole(e.role), 40),
        label: safeStr(e.label || e.value || '', 100),
        x: c ? c.x : null,
        y: c ? c.y : null,
      }
    }),
    screenshotFile: state.screenshot_out_file || null,
    image,
  })
}

/**
 * 把 CDP 页面 refs 转成「编号元素 + 行为提示」。（编号沿用 screen_observe 的 [n] 约定）
 * @param {Array} refs - semantic_v2 的 refs（{ref, role, name, actions, value}）
 * @param {number} maxElements
 */
function cdpRefsToEntries(refs, maxElements = 500) {
  const entries = new Map()
  const lines = []
  let index = 0
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || !r.ref) continue
    const actions = Array.isArray(r.actions) ? r.actions.map(String) : []
    const label = r.name != null ? String(r.name) : (r.value != null ? String(r.value) : '')
    entries.set(index, {
      ref: String(r.ref),
      role: safeStr(r.role || '', 40),
      label: safeStr(label, 100),
      actions,
      x: null,
      y: null,
    })
    const act = actions.length ? ` [${actions.join(',')}]` : ''
    lines.push(`[${index}] ${safeStr(shortRole(r.role), 40)} "${safeStr(label, 100)}"${act}`)
    index++
    if (entries.size >= maxElements) break
  }
  return { entries, lines }
}

/**
 * 用 CDP 观察 Chromium 页面：返回带 [编号] 的页面元素（之后 click/type 直接按 ref 走 CDP）。
 * 失败返回 {ok:false, reason}，由调用方退回 UIA/视觉路径。
 */
export async function cdpObserve(target, cfg, maxElements) {
  const binding = await bindBrowser(target.pid, target.window_id)
  if (!binding.ok) return { ok: false, reason: binding.reason }
  const snap = await pageSnapshot(binding)
  if (!snap.ok) return { ok: false, reason: snap.reason }
  const { entries, lines } = cdpRefsToEntries(snap.refs, maxElements)
  if (entries.size === 0) return { ok: false, reason: '页面没有可操作元素（空白页 / 纯 canvas）' }

  const b = target.bounds || null
  setSnapshot({
    at: Date.now(),
    ttlMs: cfg.ttlMs || 30000,
    pid: target.pid,
    windowId: target.window_id,
    appName: target.app_name || '',
    snapshotId: snap.snapshotId,
    entries,
    elementCount: entries.size,
    totalElementCount: snap.refs.length,
    mode: 'cdp',
    space: b ? { pngW: b.width, pngH: b.height, bounds: { ...b }, scaleX: 1, scaleY: 1, downscaled: false } : null,
    frameSpace: 'none',
    zoom: null,
    // actions.js 看到 browser 字段就把 element 点击/输入路由到 CDP。
    browser: { targetId: binding.targetId, tabId: binding.tabId, pid: target.pid, windowId: target.window_id },
    page: snap.page || null,
  })

  const pageLine = [snap.page?.title, snap.page?.url].filter(Boolean).join(' · ')
  const outline = snap.outline ? `\n── 页面结构 ──\n${snap.outline}` : ''
  return buildObserveOutput({
    ok: true,
    result:
      `窗口: ${safeStr(target.app_name)} · ${safeStr(target.title)}\n` +
      `pid=${target.pid} window_id=${target.window_id} 模式=cdp（浏览器调试协议 · 不经过系统鼠标）` +
      `${pageLine ? ' · 页面: ' + pageLine : ''}\n` +
      `可操作元素 ${entries.size} 个（ref 快照 ${snap.snapshotId || '?'}）${outline}\n\n` +
      lines.join('\n') +
      '\n\n提示: 这些是网页 DOM 元素。用 computer_click(element=[编号]) / computer_type(element=[编号], text=...) 操作，' +
      '走 CDP、完全不动真实鼠标；x/y 坐标点击仍走系统鼠标路径，网页内容优先用 element 编号。',
    window: { pid: target.pid, windowId: target.window_id, app: safeStr(target.app_name, 60), title: safeStr(target.title, 80) },
    elementCount: entries.size,
    mode: 'cdp',
    elements: [...entries].map(([index, e]) => ({ index, role: e.role, label: e.label, x: null, y: null })),
  })
}

/**
 * CDP 快照自愈：页面导航/新快照会让 ref 全部换号，这里重取一次页面快照并重建编号表。
 * 供 actions.js 在 ref 失效时重试（等价于 UIA 的 refreshSnapshot / stale_element_token 自愈）。
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, entries?:Map}|null>}
 */
export async function refreshBrowserSnapshot(cfg = {}) {
  const snap = getSnapshot()
  if (!snap?.browser) return null
  const binding = {
    targetId: snap.browser.targetId,
    tabId: snap.browser.tabId,
    pid: snap.browser.pid,
    windowId: snap.browser.windowId,
  }
  const page = await pageSnapshot(binding)
  if (!page.ok) return null
  const { entries } = cdpRefsToEntries(page.refs, cfg.maxElements || 500)
  setSnapshot({
    ...snap,
    at: Date.now(),
    entries,
    elementCount: entries.size,
    totalElementCount: page.refs.length,
    snapshotId: page.snapshotId,
    page: page.page || snap.page,
  })
  return { ok: true, entries }
}

/** Assemble the schema-facing output without serializing an absent image as null. */
export function buildObserveOutput({ image, ...value }) {
  return image ? { ...value, image } : value
}

/**
 * 重新抓取窗口树并把快照换成最新。
 * 引擎契约：同一 (pid, window_id) 的每一次 get_window_state 都会替换 index→token 映射，
 * 所以 screen_zoom、mode=native/vision 的补抓都会让旧 element_token 失效。
 * 动作工具遇到 stale_element_token 时用它自愈，不必让模型重新观察一遍。
 * @param {number} pid
 * @param {number} windowId
 * @param {object} cfg - 插件配置（maxElements / ttlMs）
 * @returns {Promise<{elementCount:number}>}
 */
export async function refreshSnapshot(pid, windowId, cfg = {}) {
  const state = await cuaCall('get_window_state', {
    pid,
    window_id: windowId,
    max_elements: cfg.maxElements || 500,
  })
  const rawElements = Array.isArray(state.elements) ? state.elements : []
  const elements = rawElements.filter(isActionable)
  const prev = getSnapshot()
  const space = computeSpace(state, null)
  const frameSpace = detectFrameSpace(rawElements, space)
  const spaceCtx = { space, frameSpace }
  const entries = new Map()
  for (const e of elements) {
    const c = centerOf(e, spaceCtx)
    entries.set(e.element_index, {
      token: e.element_token,
      role: safeStr(e.role, 40),
      label: safeStr(e.label || e.value || '', 100),
      x: c ? c.x : null,
      y: c ? c.y : null,
      rect: frameRectToPng(e.frame, frameSpace, space),
    })
  }
  setSnapshot({
    at: Date.now(),
    ttlMs: cfg.ttlMs ?? prev?.ttlMs ?? 30000,
    pid,
    windowId,
    appName: prev?.appName || '',
    snapshotId: state.snapshot_id,
    entries,
    elementCount: state.element_count,
    totalElementCount: state.total_element_count,
    mode: 'ax',
    screenshotWidth: state.screenshot_width || null,
    screenshotHeight: state.screenshot_height || null,
    space,
    frameSpace,
    zoom: null,
  })
  return { elementCount: elements.length }
}

/**
 * screen_zoom —— 区域截图工具：裁剪窗口某区域（截图像素）为 ≤500px JPEG 直读。
 * 用于"放大某块区域细看"：图片 token 远小于整窗截图。
 * @param {object} ctx
 * @param {object} args - { window?, x1, y1, x2, y2, question? }
 */
export async function screenZoom(ctx, args, cfg, exec) {
  const capable = await routeImageCapable(ctx, exec)
  if (!capable) {
    return { ok: false, result: 'screen_zoom 需要当前对话模型支持图片输入（原生直读），请使用视觉模型（如 deepseek-v4-flash-vision-exp）。' }
  }
  // pid 缺省时按 window_id 从窗口表解析（引擎 zoom 需要 pid）
  let pid = args.pid
  if (!pid) {
    const winList = await cuaCall('list_windows', { on_screen_only: true })
    const hit = (winList.windows || []).find((w) => Number(w.window_id) === Number(args.window_id))
    if (!hit) return { ok: false, result: `window_id ${args.window_id} 不在当前可见窗口列表中。` }
    pid = hit.pid
  }
  const size = await cuaCall('get_window_state', {
    pid,
    window_id: args.window_id,
    include_screenshot: true,
    max_elements: 1,
  })
  const w = size?.screenshot_width || 1
  const h = size?.screenshot_height || 1
  // 引擎限制：单次 zoom 区域任一边 ≤ 500 PNG 像素（否则报 "Zoom region too wide"）。
  // 默认的"整窗"区域在宽窗口上必然超限，这里统一收敛到上限内。
  const MAX_ZOOM = 500
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  // 「先核对再点」模式：给一个目标坐标 (at_x, at_y)，自动裁一块以它为中心的图。
  // 图心 = 该坐标 —— 目标不在图心就说明 AX/坐标偏了，先别点。
  const centered = Number.isFinite(Number(args.at_x)) && Number.isFinite(Number(args.at_y))
    ? { x: Number(args.at_x), y: Number(args.at_y), span: Math.max(24, Math.min(MAX_ZOOM, pick(args.span, 140))) }
    : null
  if (centered) {
    // 贴边自适应：跨度先按"到最近窗口边界的距离×2"收窄，保证裁切窗口不越界，
    // 这样图心仍然严格等于目标点（只给 dx/dy 提示让人自己纠，实测还是会点歪）。
    const room = Math.min(centered.x, centered.y, w - centered.x, h - centered.y)
    const fit = Math.max(24, Math.floor(room * 2))
    if (fit < centered.span) {
      centered.shrunkFrom = centered.span
      centered.span = fit
    }
    args = {
      ...args,
      x1: centered.x - centered.span / 2,
      y1: centered.y - centered.span / 2,
      x2: centered.x + centered.span / 2,
      y2: centered.y + centered.span / 2,
    }
  }
  const rx1 = Math.max(0, Math.min(w - 1, pick(args.x1, 0)))
  const ry1 = Math.max(0, Math.min(h - 1, pick(args.y1, 0)))
  let rx2 = Math.max(rx1 + 1, Math.min(w, pick(args.x2, w)))
  let ry2 = Math.max(ry1 + 1, Math.min(h, pick(args.y2, h)))
  const clamped = rx2 - rx1 > MAX_ZOOM || ry2 - ry1 > MAX_ZOOM
  if (rx2 - rx1 > MAX_ZOOM) rx2 = rx1 + MAX_ZOOM
  if (ry2 - ry1 > MAX_ZOOM) ry2 = ry1 + MAX_ZOOM
  // 贴边时居中会被窗口边界压缩，图心不再等于目标点，必须如实告知偏移。
  const centerShift = centered
    ? { dx: Math.round((rx1 + rx2) / 2 - centered.x), dy: Math.round((ry1 + ry2) / 2 - centered.y) }
    : null
  const attachments = ctx?.get?.('attachments')
  if (!attachments) return { ok: false, result: '当前环境未挂载 attachments 服务。' }
  const zv = await cuaCall('zoom', withSession({
    pid,
    window_id: args.window_id,
    x1: rx1,
    y1: ry1,
    x2: rx2,
    y2: ry2,
  }))
  const jpeg = buf(zv?.screenshot_png_b64)
  if (jpeg.byteLength === 0) return { ok: false, result: 'zoom 返回空图片。' }
  const ref = await attachments.saveImage({
    data: jpeg,
    mediaType: 'image/jpeg',
    name: `screen-zoom-${args.window_id}.jpg`,
  })
  const image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width ?? zv?.width,
    height: ref.height ?? zv?.height,
    name: ref.name,
  }
  // 记录 zoom 上下文：之后 computer_click(zoom=true) 会被引擎换算回窗口坐标。
  // 引擎 zoom 会自动外扩 20% 内边距，因此真实裁剪范围比请求范围大，不能自己算，
  // 只能让引擎用 from_zoom 反向换算（这是唯一不依赖猜测的做法）。
  const req = { x1: Math.round(rx1), y1: Math.round(ry1), x2: Math.round(rx2), y2: Math.round(ry2) }
  const prev = getSnapshot()
  if (prev) {
    setSnapshot({
      ...prev,
      at: prev.at,
      zoom: {
        at: Date.now(),
        pid,
        windowId: args.window_id,
        request: req,
        image: { width: image.width, height: image.height },
      },
    })
  }
  // 图内坐标 ↔ 窗口 PNG 的换算规则必须显式返回：
  // 模型常把"预览图/缩放图"的读数当成窗口像素，实测因此偏了 106px。
  // 注意：不给固定比例——实测引擎放大倍数随区域大小变化（80px 宽→112px，160px 宽→500px），
  // 任何写死的换算比例都会算错，换算只能由引擎（from_zoom）做。
  return {
    ok: true,
    result: [
      centered
        ? `核对模式：本图以 (${centered.x},${centered.y}) 为中心、跨度 ${centered.span}px 裁切 —— 图心就是该坐标。目标没落在图心 = 坐标偏了，先别点。`
          + (centered.shrunkFrom ? `\n（为避免贴边偏移，跨度已从 ${centered.shrunkFrom}px 自动收到 ${centered.span}px，图心仍等于目标）` : '')
          + (centerShift && (Math.abs(centerShift.dx) > 2 || Math.abs(centerShift.dy) > 2)
            ? `\n（注：该点离窗口边界不足 12px，图心仍有 dx=${centerShift.dx}, dy=${centerShift.dy} 的偏移，目标在图上相对图心的位置）`
            : '')
        : '',
      `区域截图完成：本图 ${image.width}×${image.height}px JPEG，对应窗口 PNG (${req.x1},${req.y1})→(${req.x2},${req.y2})（引擎已自动外扩 20% 内边距）。`,
      clamped ? `注意：请求区域超过引擎单边 ${MAX_ZOOM}px 上限，已截取 ${req.x2 - req.x1}×${req.y2 - req.y1}；要看其它区域请用 x1/y1 平移。` : '',
      `量坐标规则：本图只能量 0..${image.width} × 0..${image.height}；图内像素 ≠ 窗口 PNG 像素，且没有固定换算比例（引擎放大倍数随区域大小变化），不要自己换算、也不要按预览尺寸估读。`,
      '点击：把图内量到的 (x,y) 原样传给 computer_click(x=, y=, zoom=true)，由引擎换算回窗口坐标；越界会被直接拒绝。',
      '逼近法：先用大区域定位，再把区域缩到目标准确位置的 1/3 重截，直到目标占满画面；若 AX 树里有该控件，最后一步用 element 编号点击最稳。',
    ].filter(Boolean).join('\n'),
    image,
  }
}

/**
 * screen_desktop —— 整屏截图（含虚拟光标）。
 * 用途：确认"我的光标现在停在哪、刚才点在了哪"。
 * 关键事实：窗口截图（get_window_state / zoom）**不含**虚拟光标——它是独立的置顶
 * overlay 窗口（Cua.AgentCursorOverlay.default），只有整屏合成截图才画得进去。
 */
export async function screenDesktop(ctx, cfg, exec) {
  const capable = await routeImageCapable(ctx, exec)
  if (!capable) {
    return { ok: false, result: 'screen_desktop 需要当前对话模型支持图片输入（原生直读），请使用视觉模型（如 deepseek-v4-flash-vision-exp）。' }
  }
  const attachments = ctx?.get?.('attachments')
  if (!attachments) return { ok: false, result: '当前环境未挂载 attachments 服务。' }
  const d = await cuaCall('get_desktop_state', {})
  const png = buf(d?.screenshot_png_b64)
  if (png.byteLength === 0) return { ok: false, result: '整屏截图失败：引擎返回空图片。' }
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'screen-desktop.png' })
  const image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width ?? d.screenshot_width,
    height: ref.height ?? d.screenshot_height,
    name: ref.name,
  }
  return {
    ok: true,
    result: `整屏截图完成（${image.width}×${image.height}px PNG）。图中青色三角箭头 = 虚拟光标当前位置；`
      + '窗口截图（screen_observe/screen_zoom）里没有它，要核对"点在哪"就用这张。',
    image,
  }
}
