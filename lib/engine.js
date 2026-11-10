/**
 * engine.js —— cua-driver 常驻通道（MCP over stdio）+ 引擎二进制定位。
 *
 * 为什么需要它：
 *   旧实现每次工具调用都 `spawn cua-driver call <tool> <json>`，本机实测单次往返
 *   0.8–2.6 秒（进程启动 + daemon 往返）。这带来两个后果：
 *     1) 虚拟光标滑行 6 次 = 十几秒；
 *     2) 前台点击后「把真实指针放回原位」也要再付一次 ~1s，指针就在落点停这么久。
 *   cua-driver 自带 `mcp` 子命令（MCP over stdio JSON-RPC），实测 tools/call 延迟
 *   4–10ms，同一份引擎能力、同一 daemon、同样的权限模型。
 *
 * 设计：
 *   - 懒启动：第一次调用时 spawn `cua-driver mcp` 并握手；
 *   - `callTool(tool,args)` 返回 structuredContent（与 CLI 输出同形状），
 *     没有 structuredContent 时退回拼接 content[].text；
 *   - **只在通道故障时**回退到 spawn CLI（连接层失败）；调用超时不回退，
 *     避免「其实已经点下去了又点一次」；
 *   - 通道故障后 60 秒内不再尝试，直接走 CLI（`auto` 模式）；
 *   - `cli` 模式强制走旧路径（排障用）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

/**
 * 解析引擎二进制路径（优先级）：
 *   1. 环境变量 CUA_DRIVER_BIN
 *   2. PATH 目录扫描（cua-driver / cua-driver.exe）
 *   3. 官方安装器路径：~/.cua-driver/packages/current/<exe>
 *   4. 常见安装路径（~/.local/bin、/usr/local/bin、/opt/homebrew/bin、%LOCALAPPDATA%）
 *   5. 兜底 'cua-driver'（交给 spawn 报 ENOENT）
 */
export function resolveBin({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const explicit = env.CUA_DRIVER_BIN
  if (explicit) return explicit
  const sep = platform === 'win32' ? ';' : ':'
  const exe = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const pathJoin = platform === 'win32' ? win32.join : join
  for (const dir of (env.PATH || '').split(sep)) {
    if (!dir) continue
    try { if (exists(pathJoin(dir, exe))) return pathJoin(dir, exe) } catch { /* 忽略 */ }
  }
  const common = [
    pathJoin(home, '.cua-driver', 'packages', 'current', exe),
    pathJoin(home, '.local', 'bin', exe),
    pathJoin('/usr/local/bin', exe),
    pathJoin('/opt/homebrew/bin', exe),
    pathJoin(home, 'AppData', 'Local', 'cua-driver', exe),
  ]
  for (const p of common) {
    try { if (exists(p)) return p } catch { /* 忽略 */ }
  }
  return 'cua-driver'
}

export const CUA_BIN = resolveBin()

/** 通道模式：auto（默认，MCP 优先、故障回退 CLI）/ cli（强制旧路径）。 */
let mode = 'auto'
export function setEngineMode(next) {
  mode = next === 'cli' ? 'cli' : 'auto'
}
export function getEngineMode() {
  return mode
}

/** 通道故障冷却期（ms）：这段时间内直接走 CLI。 */
const DOWN_COOL_MS = 60000
/** 单次 tools/call 超时。 */
const CALL_TIMEOUT_MS = 20000
/** 握手超时。 */
const HANDSHAKE_TIMEOUT_MS = 12000

const state = {
  child: null,
  buf: '',
  nextId: 1,
  pending: new Map(),
  ready: null,
  readyAt: 0,
  downUntil: 0,
  lastError: null,
  disposed: false,
}

/** 常驻通道是否工作正常（最近没有故障）。 */
export function engineChannelReady() {
  return Boolean(state.child && state.ready && Date.now() > state.downUntil)
}

/** 最近一次通道错误（诊断用）。 */
export function engineChannelLastError() {
  return state.lastError
}

function markDown(err) {
  state.lastError = err ? String(err.message || err) : 'unknown'
  state.downUntil = Date.now() + DOWN_COOL_MS
  try { state.child?.kill() } catch { /* 忽略 */ }
  state.child = null
  state.ready = null
  for (const [, p] of state.pending) p.reject(new Error(`engine channel closed: ${state.lastError}`))
  state.pending.clear()
  state.buf = ''
}

function handleLine(line) {
  const text = line.trim()
  if (!text) return
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (msg.id != null && state.pending.has(msg.id)) {
    const p = state.pending.get(msg.id)
    state.pending.delete(msg.id)
    p.resolve(msg)
    return
  }
  // 服务端发起的请求（如 roots/list）：回空结果，避免卡住
  if (msg.id != null && msg.method && state.child?.stdin?.writable) {
    try {
      state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
    } catch { /* 忽略 */ }
  }
}

function startChannel() {
  if (state.disposed) return Promise.reject(new Error('engine channel disposed'))
  if (state.ready) return state.ready
  if (Date.now() < state.downUntil) {
    return Promise.reject(Object.assign(new Error(`engine channel cooling down: ${state.lastError}`), { channelDown: true }))
  }
  state.ready = new Promise((resolve, reject) => {
    let settled = false
    let child
    try {
      child = spawn(CUA_BIN, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      settled = true
      state.ready = null
      markDown(err)
      reject(Object.assign(err, { channelDown: true }))
      return
    }
    state.child = child
    state.buf = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error('engine mcp handshake timeout')
      state.ready = null
      markDown(err)
      reject(Object.assign(err, { channelDown: true }))
    }, HANDSHAKE_TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      state.buf += d.toString('utf8')
      let idx
      while ((idx = state.buf.indexOf('\n')) >= 0) {
        const line = state.buf.slice(0, idx)
        state.buf = state.buf.slice(idx + 1)
        handleLine(line)
      }
    })
    child.stderr.on('data', () => { /* 版本提示等无关输出，忽略 */ })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        state.ready = null
        markDown(err)
        reject(Object.assign(err, { channelDown: true }))
      }
    })
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        state.ready = null
        const err = new Error(`engine mcp exited (code ${code})`)
        markDown(err)
        reject(Object.assign(err, { channelDown: true }))
        return
      }
      // 已就绪后退出：标记故障（下次调用会重连或走 CLI）
      if (state.child === child) markDown(new Error(`engine mcp exited (code ${code})`))
    })
    child.stdin.on('error', () => { /* 写入失败由 rpc 的超时/退出处理 */ })

    rpc(state.child, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-computer-use', version: '0.3.2' },
    }, HANDSHAKE_TIMEOUT_MS).then((msg) => {
      if (settled) return
      if (msg.error) {
        settled = true
        clearTimeout(timer)
        state.ready = null
        const err = new Error(`engine mcp initialize failed: ${JSON.stringify(msg.error).slice(0, 200)}`)
        markDown(err)
        reject(Object.assign(err, { channelDown: true }))
        return
      }
      try {
        state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
      } catch { /* 忽略 */ }
      settled = true
      clearTimeout(timer)
      state.readyAt = Date.now()
      resolve(true)
    }).catch((err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      state.ready = null
      markDown(err)
      reject(Object.assign(err, { channelDown: true }))
    })
  }).catch((err) => {
    state.ready = null
    throw err
  })
  return state.ready
}

function rpc(child, method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = state.nextId++
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error(`engine ${method} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    state.pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    } catch (err) {
      clearTimeout(timer)
      state.pending.delete(id)
      reject(Object.assign(err, { channelDown: true }))
    }
  })
}

/** 把 MCP tools/call 的返回归一化成「与 CLI JSON 同形状」。 */
function unwrapToolResult(msg) {
  if (msg.error) {
    const err = new Error(`engine tool error: ${JSON.stringify(msg.error).slice(0, 500)}`)
    err.rpcError = msg.error
    throw err
  }
  const result = msg.result || {}
  if (result.structuredContent !== undefined) return result.structuredContent
  const texts = (Array.isArray(result.content) ? result.content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
  if (texts.length) return texts.join('\n')
  return result
}

/**
 * 通过常驻 MCP 通道调用一个引擎工具。
 * 失败时抛错：`err.channelDown === true` 表示通道层故障（可以安全回退 CLI），
 * 否则表示调用本身失败（**不能**自动重试，避免重复点击/输入）。
 */
export async function mcpCallTool(tool, args = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  await startChannel()
  const msg = await rpc(state.child, 'tools/call', { name: tool, arguments: args }, timeoutMs)
  return unwrapToolResult(msg)
}

/** 预热通道（插件加载时调用，避免第一次点击付冷启动代价）。 */
export async function warmEngineChannel() {
  if (mode === 'cli') return false
  try {
    await startChannel()
    return true
  } catch {
    return false
  }
}

/** 关闭常驻通道（插件卸载/进程退出时）。 */
export function disposeEngine() {
  state.disposed = true
  try { state.child?.stdin?.end() } catch { /* 忽略 */ }
  try { state.child?.kill() } catch { /* 忽略 */ }
  state.child = null
  state.ready = null
}

let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    try { state.child?.kill() } catch { /* 忽略 */ }
  })
}
installExitHook()
