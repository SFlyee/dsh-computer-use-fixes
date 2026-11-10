/**
 * browser-cdp.mjs —— 浏览器 CDP 通道离线回归（桩化引擎，零真实浏览器/零鼠标）。
 *
 * 覆盖：
 *   A. isChromiumWindow 识别（app_name / 标题）
 *   B. refusalOf 拒绝形状
 *   C. bindBrowser：prepare+bind、缓存、拒绝缓存、缺 tab
 *   D. cdpObserve：页面 refs → [编号] 元素 + 快照 browser 字段
 *   E. computer_click(element) → browser_click（不经系统鼠标）
 *   F. computer_type(element) → browser_type
 *   G. computer_scroll → browser_pointer(scroll)
 *   H. ref 失效自愈：重新快照 + 按 role/name 找回 + 重试
 *   I. CDP 不可用/空页面 → 优雅返回 {ok:false}（调用方退回 UIA/视觉）
 */
import * as browser from '../lib/browser.js'
import * as actions from '../lib/actions.js'
import { cdpObserve } from '../lib/observe.js'
import { setSnapshot, getSnapshot } from '../lib/snapshot.js'

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? ' :: ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

/** 脚本化引擎桩：每个工具给一串按顺序消费的返回值。 */
function scripted(map) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]))
  const calls = []
  browser.deps.cuaCall = async (tool, args = {}) => {
    calls.push({ tool, args: { ...args } })
    const q = queues[tool]
    if (!q || q.length === 0) throw new Error('unexpected engine call: ' + tool)
    const r = q.length > 1 ? q.shift() : q[0]
    return typeof r === 'function' ? r(args) : r
  }
  return { calls, queues }
}
const callsOf = (calls, tool) => calls.filter((c) => c.tool === tool)

const CFG = {
  ttlMs: 60000, maxElements: 100, allowedApps: [], cursorTheme: '',
  nativeImage: 'auto', visionProvider: 'x', visionModel: 'y',
  preferElement: true, restoreRealPointer: true, browserCdp: true,
}
const REFS = [
  { ref: 'p1:0', role: 'button', name: '提交', actions: ['click', 'pointer'], frame: 'main' },
  { ref: 'p1:1', role: 'textbox', name: '邮箱', actions: ['type', 'pointer'], frame: 'main' },
  { ref: 'p1:2', role: 'link', name: '帮助', actions: ['click', 'pointer'], frame: 'main' },
]
const PAGE_SNAP = {
  status: 'ok', mode: 'snapshot', target_id: 'bt-1', tab_id: 'tab-1',
  refs: REFS, outline: '- button "提交"\n- textbox "邮箱"', page: { title: '登录页', url: 'https://example.test/login' },
  snapshot: { id: 'p1', complete: true },
}
const BIND_OK = { status: 'ok', target_id: 'bt-1', tabs: [{ tab_id: 'tab-1', active: true, title: '登录页', url: 'https://example.test/login' }], native_title: '登录页 - Microsoft Edge' }
const PREP_OK = { status: 'ok', action: 'attached_existing_profile', attachment: { kind: 'existing_profile', next_action: 'get_browser_state' } }

// ── A. 识别 ─────────────────────────────────────────────────────────
console.log('\n── A. Chromium 窗口识别 ──')
check('A1 app_name=msedge.exe', browser.isChromiumWindow({ app_name: 'msedge.exe', title: '' }) === true)
check('A2 app_name=chrome.exe', browser.isChromiumWindow({ app_name: 'chrome.exe' }) === true)
check('A3 标题兜底 - Microsoft Edge', browser.isChromiumWindow({ app_name: '', title: '登录页 - Microsoft Edge' }) === true)
check('A4 记事本不是浏览器', browser.isChromiumWindow({ app_name: 'notepad.exe', title: '无标题 - 记事本' }) === false)
check('A5 空窗口', browser.isChromiumWindow(null) === false)

// ── B. 拒绝形状 ─────────────────────────────────────────────────────
console.log('\n── B. 拒绝形状解析 ──')
check('B1 status=refused + refusal.code',
  /browser_consent_required/.test(browser.refusalOf({ status: 'refused', refusal: { code: 'browser_consent_required', message: 'm' } }) || ''))
check('B2 仅 refusal 对象', /browser_requires_setup/.test(browser.refusalOf({ refusal: { code: 'browser_requires_setup' } }) || ''))
check('B3 正常返回不是拒绝', browser.refusalOf({ status: 'ok', target_id: 'bt-1' }) === null)

// ── C. bindBrowser ──────────────────────────────────────────────────
console.log('\n── C. 绑定 / 缓存 / 拒绝缓存 ──')
browser.resetBrowserCache()
{
  const { calls } = scripted({ browser_prepare: [PREP_OK], get_browser_state: [BIND_OK] })
  const b = await browser.bindBrowser(1001, 2002)
  check('C1 绑定成功拿到 target/tab', b.ok && b.targetId === 'bt-1' && b.tabId === 'tab-1', JSON.stringify(b))
  check('C2 prepare 带 strategy=existing_profile + window_id',
    calls[0]?.args.strategy?.kind === 'existing_profile' && calls[0]?.args.window_id === 2002, JSON.stringify(calls[0]?.args))
  const callsBefore = calls.length
  const b2 = await browser.bindBrowser(1001, 2002)
  check('C3 60s 内复用缓存（不再打引擎）', b2.ok && calls.length === callsBefore, `calls=${calls.length}`)
}
browser.resetBrowserCache()
{
  const refusal = { status: 'refused', refusal: { code: 'browser_consent_required', message: 'needs grant' } }
  const { calls } = scripted({ browser_prepare: [refusal] })
  const b = await browser.bindBrowser(3003, 4004)
  check('C4 授权门拒绝 → ok:false 且带原因', !b.ok && /browser_consent_required/.test(b.reason), String(b.reason))
  const n = calls.length
  const b2 = await browser.bindBrowser(3003, 4004)
  check('C5 失败结果缓存（避免反复付代价）', !b2.ok && calls.length === n, `calls=${calls.length}`)
}
browser.resetBrowserCache()
{
  scripted({ browser_prepare: [PREP_OK], get_browser_state: [{ status: 'ok', target_id: 'bt-1', tabs: [] }] })
  const b = await browser.bindBrowser(5005, 6006)
  check('C6 没有 tab → ok:false', !b.ok && /target_id|tab_id/.test(b.reason), String(b.reason))
}

// ── D. cdpObserve ───────────────────────────────────────────────────
console.log('\n── D. 页面观察 → [编号] 元素 ──')
browser.resetBrowserCache()
scripted({ browser_prepare: [PREP_OK], get_browser_state: [BIND_OK, PAGE_SNAP] })
const target = { pid: 1001, window_id: 2002, app_name: 'msedge.exe', title: '登录页 - Microsoft Edge', bounds: { x: 0, y: 0, width: 1000, height: 700 } }
const obs = await cdpObserve(target, CFG, 100)
check('D1 返回 ok 且标明 CDP', obs?.ok === true && /模式=cdp/.test(obs.result), String(obs?.result || '').slice(0, 120))
check('D2 元素带编号与 role/name', /\[0\] button "提交"/.test(obs.result) && /\[1\] textbox "邮箱"/.test(obs.result))
const snap = getSnapshot()
check('D3 快照写入 browser 绑定', snap?.browser?.targetId === 'bt-1' && snap?.browser?.tabId === 'tab-1', JSON.stringify(snap?.browser))
check('D4 快照元素带 ref', snap?.entries?.get(0)?.ref === 'p1:0' && snap?.entries?.get(1)?.ref === 'p1:1', JSON.stringify(snap?.entries?.get(0)))
check('D5 提示优先用 element 编号', /优先用 element 编号/.test(obs.result))

// ── E. click(element) → browser_click ───────────────────────────────
console.log('\n── E. 页面元素点击走 CDP ──')
{
  const { calls } = scripted({ browser_click: [{ delivery: { mode: 'background' }, effect: 'unverifiable', route: 'trusted_input' }] })
  const r = await actions.click({ element: 0 }, CFG)
  const c = callsOf(calls, 'browser_click')[0]?.args
  check('E1 调用 browser_click 且带 ref/target/tab',
    c?.ref === 'p1:0' && c?.target_id === 'bt-1' && c?.tab_id === 'tab-1', JSON.stringify(c))
  check('E2 结果标明 CDP + 不经系统鼠标', r.ok && /CDP 页面元素/.test(r.result) && /不经过系统鼠标/.test(r.result), String(r.result).slice(0, 140))
  check('E3 完全不发系统鼠标事件（无 click/move_cursor）',
    !calls.some((x) => x.tool === 'click' || x.tool === 'move_cursor'))
}

// ── F. type(element) → browser_type ─────────────────────────────────
console.log('\n── F. 页面输入走 CDP ──')
{
  const { calls } = scripted({ browser_type: [{ ok: true }] })
  const r = await actions.typeText({ element: 1, text: 'hi@example.test' }, CFG)
  const c = callsOf(calls, 'browser_type')[0]?.args
  check('F1 调用 browser_type 且带 ref/text', c?.ref === 'p1:1' && c?.text === 'hi@example.test', JSON.stringify(c))
  check('F2 结果标明 CDP', r.ok && /CDP 页面元素/.test(r.result), String(r.result).slice(0, 120))
}

// ── G. scroll → browser_pointer ─────────────────────────────────────
console.log('\n── G. 页面滚动走 CDP ──')
{
  const { calls } = scripted({ browser_pointer: [{ ok: true }] })
  const r = await actions.scroll({ direction: 'down', amount: 2 }, CFG)
  const c = callsOf(calls, 'browser_pointer')[0]?.args
  check('G1 browser_pointer action=scroll 且向下 delta_y>0',
    c?.action === 'scroll' && Number(c?.delta_y) > 0 && c?.target_id === 'bt-1', JSON.stringify(c))
  check('G2 结果标明 CDP', r.ok && /CDP 页面/.test(r.result), String(r.result).slice(0, 120))
}

// ── H. ref 失效自愈 ─────────────────────────────────────────────────
console.log('\n── H. ref 失效自愈（重新快照 + 重试）──')
browser.resetBrowserCache()
{
  const stale = { status: 'refused', refusal: { code: 'stale_ref', message: 'ref superseded' } }
  const page2 = { ...PAGE_SNAP, refs: [{ ref: 'p2:3', role: 'button', name: '提交', actions: ['click'] }], snapshot: { id: 'p2', complete: true } }
  const { calls } = scripted({
    browser_prepare: [PREP_OK],
    get_browser_state: [BIND_OK, PAGE_SNAP, page2],
    browser_click: [stale, { delivery: { mode: 'background' }, route: 'trusted_input' }],
  })
  const obs2 = await cdpObserve(target, CFG, 100)
  check('H1 前置快照 ok', obs2?.ok === true)
  const r = await actions.click({ element: 0 }, CFG)
  const clickCalls = callsOf(calls, 'browser_click')
  check('H2 失效后按 role/name 找回新 ref 重试', clickCalls.length === 2 && clickCalls[1]?.args.ref === 'p2:3',
    JSON.stringify(clickCalls.map((c) => c.args.ref)))
  check('H3 重试成功且结果标注自愈', r.ok && /ref 已自愈重试/.test(r.result), String(r.result).slice(0, 140))
}

// ── I. CDP 不可用 / 空页面 → 优雅失败 ───────────────────────────────
console.log('\n── I. CDP 不可用时的优雅失败 ──')
browser.resetBrowserCache()
{
  scripted({ browser_prepare: [{ status: 'refused', refusal: { code: 'browser_route_unavailable', message: 'no endpoint' } }] })
  const r = await cdpObserve(target, CFG, 100)
  check('I1 绑定失败 → {ok:false, reason}', r?.ok === false && /browser_route_unavailable/.test(r.reason), String(r.reason))
}
browser.resetBrowserCache()
{
  scripted({ browser_prepare: [PREP_OK], get_browser_state: [BIND_OK, { ...PAGE_SNAP, refs: [] }] })
  const r = await cdpObserve(target, CFG, 100)
  check('I2 页面无可操作元素 → {ok:false, reason}', r?.ok === false && /没有可操作元素/.test(r.reason), String(r.reason))
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
