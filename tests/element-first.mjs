/**
 * element-first.mjs —— 「能点元素就点元素，不能才用视觉/像素」的离线回归。
 *
 * 覆盖：
 *   A. space.js frameRectToPng：png / screen / page 三种坐标空间
 *   B. actions.actionableElementAt：按钮/菜单项/中文角色命中；编辑区/画布/大容器/空快照不命中；
 *      重叠时取面积最小者
 *   C. computer_click 传 x/y 时自动晋升为 element_token（UIA 通道，不碰真实指针）
 *   D. preferElement=false 关闭晋升；编辑区/画布、vision 快照(无元素)仍走像素点击
 *   E. element=编号 模式不受影响；zoom 图内坐标不参与晋升
 *
 * 全部桩化引擎，不连 cua-driver、不移动真实鼠标。
 */
import * as human from '../lib/human.js'
import * as actions from '../lib/actions.js'
import { setSnapshot, getSnapshot } from '../lib/snapshot.js'
import { frameRectToPng, computeSpace } from '../lib/space.js'
import { CUA_SESSION } from '../lib/cua.js'

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? ' :: ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`) }
}

// ── 桩化引擎调用 ─────────────────────────────────────────────────────
let calls = []
human.deps.cuaCall = async (tool, args = {}) => {
  calls.push({ tool, args: { ...args } })
  if (tool === 'get_cursor_position') return { x: 10, y: 20 }
  return { effect: 'ok', route: 'uia' }
}
const resetCalls = () => { calls = [] }
const clicks = () => calls.filter((c) => c.tool === 'click')

const BOUNDS = { x: 100, y: 50, width: 1000, height: 800 }
function makeSnapshot({ entries = [], zoom = null } = {}) {
  setSnapshot({
    at: Date.now(),
    ttlMs: 60000,
    pid: 4242,
    windowId: 777,
    appName: 'element-first-test',
    snapshotId: 'snap-ef',
    entries: new Map(entries),
    elementCount: entries.length,
    totalElementCount: entries.length,
    mode: entries.length ? 'ax' : 'vision',
    space: {
      pngW: 1000, pngH: 800,
      bounds: { ...BOUNDS }, scaleX: 1, scaleY: 1, downscaled: false,
    },
    frameSpace: 'png',
    zoom,
  })
}
const cfg = {
  ttlMs: 60000, maxElements: 500, allowedApps: [], cursorTheme: '',
  nativeImage: 'auto', visionProvider: 'x', visionModel: 'y',
  preferElement: true, restoreRealPointer: true,
}
const entry = (token, role, label, rect) => ({
  token, role, label, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, rect,
})

const ENTRIES = [
  [1, entry('tok-btn', 'Button', '安装', { x: 120, y: 60, w: 120, h: 40 })],
  [2, entry('tok-edit', 'Edit', '文本编辑器', { x: 0, y: 100, w: 1000, h: 600 })],
  [3, entry('tok-menu', 'MenuItem', '文件(F)', { x: 10, y: 10, w: 60, h: 30 })],
  [4, entry('tok-pane', 'Pane', '容器', { x: 0, y: 0, w: 1000, h: 800 })],
  [5, entry('tok-zh', '按钮', '确定', { x: 500, y: 60, w: 100, h: 30 })],
  [6, entry('tok-big', 'Button', '整页按钮', { x: 0, y: 0, w: 900, h: 700 })],
  [7, entry('tok-link', 'Link', '帮助', { x: 700, y: 60, w: 80, h: 24 })],
]

// ── A. frameRectToPng ────────────────────────────────────────────────
console.log('\n── A. frameRectToPng 坐标空间 ──')
const space = computeSpace({ screenshot_width: 1000, screenshot_height: 800, window_bounds: BOUNDS }, null)
const pngRect = frameRectToPng({ x: 10, y: 20, w: 100, h: 40 }, 'png', space)
check('A1 png 空间：原样（整数化）',
  pngRect && pngRect.x === 10 && pngRect.y === 20 && pngRect.w === 100 && pngRect.h === 40 && pngRect.estimated === false,
  JSON.stringify(pngRect))
const screenSpace = computeSpace({
  screenshot_width: 500, screenshot_height: 400,
  window_bounds: { x: 100, y: 50, width: 1000, height: 800 },
}, null)
const scrRect = frameRectToPng({ x: 200, y: 150, w: 200, h: 100 }, 'screen', screenSpace)
check('A2 screen 空间：换算成 PNG（含缩放 0.5）',
  scrRect && scrRect.x === 50 && scrRect.y === 50 && scrRect.w === 100 && scrRect.h === 50 && scrRect.estimated === true,
  JSON.stringify(scrRect))
check('A3 page 空间：拒绝换算', frameRectToPng({ x: 1, y: 2, w: 3, h: 4 }, 'page', space) === null)
check('A4 缺字段：返回 null', frameRectToPng({ x: 1 }, 'png', space) === null)

// ── B. actionableElementAt ──────────────────────────────────────────
console.log('\n── B. 像素坐标命中可调用元素 ──')
makeSnapshot({ entries: ENTRIES })
const snap = getSnapshot()
const hit1 = actions.actionableElementAt(snap, 130, 70)
check('B1 点在 Button 上 → 命中', hit1 && hit1.index === 1 && hit1.token === 'tok-btn', JSON.stringify(hit1))
const hitZh = actions.actionableElementAt(snap, 520, 70)
check('B2 中文角色「按钮」也能识别', hitZh && hitZh.index === 5 && hitZh.token === 'tok-zh', JSON.stringify(hitZh))
const hitMenu = actions.actionableElementAt(snap, 20, 20)
check('B3 菜单项命中', hitMenu && hitMenu.index === 3 && hitMenu.token === 'tok-menu', JSON.stringify(hitMenu))
const hitLink = actions.actionableElementAt(snap, 710, 70)
check('B4 链接命中', hitLink && hitLink.index === 7 && hitLink.token === 'tok-link', JSON.stringify(hitLink))
check('B5 编辑区（Edit）不晋升', actions.actionableElementAt(snap, 300, 300) === null, JSON.stringify(actions.actionableElementAt(snap, 300, 300)))
check('B6 容器（Pane）不晋升', actions.actionableElementAt(snap, 990, 790) === null)
check('B7 超过窗口 20% 的大按钮不晋升', actions.actionableElementAt(snap, 800, 500) === null)
check('B8 重叠时取面积最小的命中者', (() => {
  const h = actions.actionableElementAt(snap, 130, 70)
  return h && h.index === 1 // 大按钮(6) 覆盖该点但面积过大被排除，Button(1) 胜出
})())
makeSnapshot({ entries: [] })
check('B9 空元素表（vision 快照）→ 不命中', actions.actionableElementAt(getSnapshot(), 130, 70) === null)

// ── C. 自动晋升 ──────────────────────────────────────────────────────
console.log('\n── C. computer_click(x,y) 自动晋升为元素点击 ──')
makeSnapshot({ entries: ENTRIES })
resetCalls()
const r1 = await actions.click({ x: 130, y: 70 }, cfg)
const c1 = clicks()[0]?.args || {}
check('C1 click 载荷改用 element_token（不再带 x/y/window_id）',
  c1.element_token === 'tok-btn' && !('x' in c1) && !('y' in c1) && !('window_id' in c1), JSON.stringify(c1))
check('C2 结果文案说明已自动改用元素', /已自动改用元素点击/.test(r1.result), String(r1.result).slice(0, 160))
check('C3 滑行仍发生（虚拟光标可见）', calls.filter((c) => c.tool === 'move_cursor').length >= 1,
  `move_cursor=${calls.filter((c) => c.tool === 'move_cursor').length}`)

// ── D. 不晋升的场景 ──────────────────────────────────────────────────
console.log('\n── D. 不能点元素时仍走像素/视觉 ──')
makeSnapshot({ entries: ENTRIES })
resetCalls()
await actions.click({ x: 300, y: 300 }, cfg)
const c2 = clicks()[0]?.args || {}
check('D1 编辑区坐标仍走像素点击（带 x/y + window_id，无 token）',
  Number.isFinite(c2.x) && Number.isFinite(c2.y) && c2.window_id === 777 && !c2.element_token, JSON.stringify(c2))

makeSnapshot({ entries: ENTRIES })
resetCalls()
await actions.click({ x: 130, y: 70 }, { ...cfg, preferElement: false })
const c3 = clicks()[0]?.args || {}
check('D2 preferElement=false → 恢复像素点击', Number.isFinite(c3.x) && !c3.element_token, JSON.stringify(c3))

makeSnapshot({ entries: [] }) // vision 快照：没有元素表
resetCalls()
await actions.click({ x: 130, y: 70 }, cfg)
const c4 = clicks()[0]?.args || {}
check('D3 vision 快照（无元素）→ 像素点击', Number.isFinite(c4.x) && !c4.element_token, JSON.stringify(c4))

// ── E. 旧路径不受影响 ────────────────────────────────────────────────
console.log('\n── E. element 编号 / zoom 路径不变 ──')
makeSnapshot({ entries: ENTRIES })
resetCalls()
await actions.click({ element: 3 }, cfg)
const c5 = clicks()[0]?.args || {}
check('E1 element=编号 仍走 token 路径', c5.element_token === 'tok-menu' && !('x' in c5), JSON.stringify(c5))

makeSnapshot({ entries: ENTRIES, zoom: { image: { width: 500, height: 400 } } })
resetCalls()
await actions.click({ x: 130, y: 70, zoom: true }, cfg)
const c6 = clicks()[0]?.args || {}
check('E2 zoom 图内坐标不参与自动晋升（仍 from_zoom 像素点击）',
  c6.from_zoom === true && !c6.element_token && Number.isFinite(c6.x), JSON.stringify(c6))

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
