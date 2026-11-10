/**
 * browser.js —— 浏览器 CDP 通道（Chromium 页面内容，完全绕开系统鼠标）。
 *
 * 背景（真实实测，见 evidence/cdp-probe/）：
 *   - Windows UIA 元素树只覆盖浏览器**自身界面**（地址栏/菜单/标签页），
 *     网页里的按钮、输入框一个都不在里面 ⇒ 网页内容无法用 UIA 元素点击。
 *   - cua-driver 0.28.2 自带 CDP 工具（browser_prepare / get_browser_state /
 *     browser_click / browser_type / browser_pointer），直接在渲染进程内操作 DOM，
 *     不产生任何系统鼠标事件。
 *   - 前提：daemon 必须以 `--grant existing-profile` 启动（引擎的 existing_profile
 *     授权门），然后 browser_prepare(pid, window_id, strategy:existing_profile)
 *     才能真正 attach；否则回 refusal（browser_consent_required /
 *     browser_requires_setup），本模块必须优雅退回 UIA/视觉路径。
 *
 * 数据流：
 *   bindBrowser(pid, window) → browser_prepare + get_browser_state(bind)
 *     → { targetId, tabId, page }
 *   pageSnapshot(binding)    → get_browser_state(semantic_v2) → refs[]
 *   clickRef / typeRef / scrollPage → browser_click / browser_type / browser_pointer
 *
 * refs 形如 `p1:0`（p<快照号>:<序号>），每次新快照都会换号；ref 失效时重新快照再按
 * role+name 找回同一元素重试一次（见 actions.js）。
 */
import { cuaCall, withSession } from './cua.js'

/** 依赖注入点（单测可替换）：默认等价于直接调用 cua.js 的 cuaCall。 */
export const deps = { cuaCall }

/** 识别 Chromium 系浏览器窗口（app_name 优先，标题兜底）。 */
const CHROMIUM_APP = /^(msedge|chrome|chromium|brave|vivaldi|opera|360se|qqbrowser)(\.exe)?$/i
const CHROMIUM_TITLE = /(microsoft[\s\u200b]*edge|google chrome|brave browser|chromium|vivaldi)/i

/**
 * 目标窗口是否是 Chromium 浏览器。
 * @param {{app_name?:string, title?:string}} win
 * @returns {boolean}
 */
export function isChromiumWindow(win) {
  if (!win) return false
  const app = String(win.app_name || '').trim()
  if (app && CHROMIUM_APP.test(app)) return true
  return CHROMIUM_TITLE.test(String(win.title || ''))
}

/** 绑定缓存：`pid:windowId` → binding（避免每次观察都重做 prepare/bind）。 */
const bindings = new Map()
/** 失败缓存：避免对一个不支持的窗口反复付 prepare 的代价。 */
const failures = new Map()
const BIND_TTL_MS = 120000
const FAIL_TTL_MS = 60000

/** 清空缓存（单测用）。 */
export function resetBrowserCache() {
  bindings.clear()
  failures.clear()
}

/**
 * 从引擎返回值里提取拒绝原因。
 * 引擎拒绝形状：{status:'refused', refusal:{code,message}} 或 {refusal:{code,message}}。
 * @returns {string|null}
 */
export function refusalOf(value) {
  if (!value || typeof value !== 'object') return null
  const r = value.refusal
  if (value.status === 'refused' || value.status === 'rejected' || r) {
    const code = r?.code ? ` (${r.code})` : ''
    const msg = r?.message || value.message || ''
    return `${code}${msg ? ' ' + msg : ''}`.trim() || 'refused'
  }
  return null
}

/**
 * 绑定一个 Chromium 窗口到 CDP 会话。
 * 每次绑定前都要 browser_prepare + strategy existing_profile（引擎授权门），
 * 成功后 get_browser_state(bind) 拿 target_id / tab_id。
 * @param {number} pid
 * @param {number} windowId
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:true,pid:number,windowId:number,targetId:string,tabId:string,tabs:Array,page?:object}|{ok:false,reason:string}>}
 */
export async function bindBrowser(pid, windowId, { force = false } = {}) {
  const key = `${pid}:${windowId}`
  const now = Date.now()
  if (!force) {
    const cached = bindings.get(key)
    if (cached && now - cached.at < BIND_TTL_MS) return cached
    const failed = failures.get(key)
    if (failed && now - failed.at < FAIL_TTL_MS) return { ok: false, reason: failed.reason }
  }

  try {
    // 1) 显式声明 existing-profile 策略（引擎要求 window_id 作 approval anchor）。
    //    already_prepared / attached_existing_profile 都算通过，继续 bind。
    const prep = await deps.cuaCall('browser_prepare', withSession({
      pid,
      window_id: windowId,
      strategy: { kind: 'existing_profile' },
    }))
    const prepRefusal = refusalOf(prep)
    // browser_requires_setup / browser_consent_required 等：直接记原因并退回。
    if (prepRefusal && prep?.status !== 'ok') {
      failures.set(key, { at: now, reason: `browser_prepare${prepRefusal.startsWith(' (') ? '' : ' '}${prepRefusal}` })
      return { ok: false, reason: prepRefusal }
    }

    // 2) 绑定原生窗口 → CDP target / tab
    const st = await deps.cuaCall('get_browser_state', withSession({ pid, window_id: windowId }))
    const stRefusal = refusalOf(st)
    if (stRefusal) {
      failures.set(key, { at: now, reason: `get_browser_state${stRefusal}` })
      return { ok: false, reason: stRefusal }
    }
    const tabs = Array.isArray(st.tabs) ? st.tabs : []
    const tab = tabs.find((t) => t.active) || tabs[0]
    if (!st.target_id || !tab?.tab_id) {
      const reason = '引擎没有返回 target_id/tab_id（可能该窗口没有可绑定的页面）'
      failures.set(key, { at: now, reason })
      return { ok: false, reason }
    }
    const binding = {
      ok: true,
      pid,
      windowId,
      targetId: String(st.target_id),
      tabId: String(tab.tab_id),
      tabs,
      page: { title: st.native_title || tab.title || '', url: tab.url || '' },
      at: now,
    }
    bindings.set(key, binding)
    failures.delete(key)
    return binding
  } catch (err) {
    const reason = `CDP 绑定失败：${err.message}`
    failures.set(key, { at: now, reason })
    return { ok: false, reason }
  }
}

/** 让缓存的绑定失效（导航/新快照后 ref 全换时用）。 */
export function invalidateBrowserBinding(pid, windowId) {
  const key = `${pid}:${windowId}`
  bindings.delete(key)
  failures.delete(key)
}

/**
 * 取页面语义快照（semantic_v2）：返回可点击/可输入的元素 refs。
 * @param {{targetId:string,tabId:string,pid?:number,windowId?:number}} binding
 * @returns {Promise<{ok:true,refs:Array,outline:string,page:object,snapshotId:string|null}|{ok:false,reason:string}>}
 */
export async function pageSnapshot(binding) {
  try {
    const v = await deps.cuaCall('get_browser_state', withSession({
      target_id: binding.targetId,
      tab_id: binding.tabId,
      snapshot_format: 'semantic_v2',
    }))
    const refusal = refusalOf(v)
    if (refusal) {
      // 绑定过期（target/tab 失效）：丢缓存，下次重新 bind。
      if (binding.pid != null && binding.windowId != null) invalidateBrowserBinding(binding.pid, binding.windowId)
      return { ok: false, reason: refusal }
    }
    const refs = Array.isArray(v.refs) ? v.refs : []
    return {
      ok: true,
      refs,
      outline: typeof v.outline === 'string' ? v.outline : '',
      page: v.page || binding.page || {},
      snapshotId: v.snapshot?.id || null,
      complete: v.snapshot?.complete !== false,
    }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

/** 按 ref 点击页面元素（CDP，不经过系统鼠标）。 */
export async function clickRef(binding, ref) {
  return deps.cuaCall('browser_click', withSession({
    target_id: binding.targetId,
    tab_id: binding.tabId,
    ref,
  }))
}

/** 按 ref 向页面元素输入文本（CDP Input 域）。 */
export async function typeRef(binding, ref, text, { replace = false, mode } = {}) {
  const payload = withSession({
    target_id: binding.targetId,
    tab_id: binding.tabId,
    ref,
    text: String(text),
  })
  if (replace) payload.replace = true
  if (mode === 'keystrokes' || mode === 'insert_text') payload.mode = mode
  return deps.cuaCall('browser_type', payload)
}

/** 页面滚动（CDP 指针事件，不经过系统鼠标）。 */
export async function scrollPage(binding, { direction = 'down', amount = 3 } = {}) {
  const step = 120 * Math.max(1, Math.min(Number(amount) || 3, 20))
  const payload = withSession({
    target_id: binding.targetId,
    tab_id: binding.tabId,
    action: 'scroll',
  })
  if (direction === 'down') payload.delta_y = step
  else if (direction === 'up') payload.delta_y = -step
  else if (direction === 'right') payload.delta_x = step
  else payload.delta_x = -step
  return deps.cuaCall('browser_pointer', payload)
}

/** ref 里的快照号（`p1:0` → `p1`），用于判断 ref 是否属于旧快照。 */
export function refSnapshotId(ref) {
  const m = String(ref || '').match(/^(p\d+):/)
  return m ? m[1] : null
}

