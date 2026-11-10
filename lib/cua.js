/**
 * cua.js —— cua-driver 引擎调用封装（统一入口）。
 *
 * 双通道：
 *   1) **常驻 MCP 通道**（默认）：`lib/engine.js` 维护一个 `cua-driver mcp` 子进程，
 *      tools/call 实测 4–10ms；
 *   2) **CLI 回退**：旧实现 `spawn cua-driver call <tool> <json>`，单次 0.8–2.6s，
 *      只在常驻通道故障（连接/握手/写入失败）时使用。
 *
 * 语义不变：返回「与 CLI JSON 同形状」的值（MCP 的 structuredContent）。
 * 注意：调用超时**不会**回退 CLI——避免已执行的动作被重放（重复点击/输入）。
 */
import { spawn } from 'node:child_process'
import { CUA_BIN, getEngineMode, mcpCallTool } from './engine.js'

export { CUA_BIN }
// resolveBin 保留在 engine.js；这里 re-export 兼容旧引用（测试/文档可能引用）。
export { resolveBin } from './engine.js'

/**
 * 插件统一的虚拟光标会话 id：所有动作绑定同一会话，
 * 光标主题/运动参数才能稳定生效（会话级）。
 */
export const CUA_SESSION = process.env.CUA_SESSION || 'dsh-computer-use'

/** 给动作类调用注入统一会话（观察类只读工具不需要）。 */
export function withSession(args = {}) {
  return { session: CUA_SESSION, ...args }
}

/**
 * 调用一个 cua-driver 工具（带会话自愈）。
 * 若会话已结束（daemon 空闲回收/重启导致），自动 start_session 恢复后重试一次，
 * 保证插件长时运行不因会话失效而中断。
 * @param {string} tool - 工具名，如 'get_window_state' / 'click'
 * @param {object} args - 参数对象
 * @returns {Promise<any>} 解析后的 JSON 值
 */
export async function cuaCall(tool, args = {}) {
  try {
    return await callOnce(tool, args)
  } catch (err) {
    if (tool !== 'start_session' && /session '.*' has ended|revive it/.test(err.message)) {
      await callOnce('start_session', { session: CUA_SESSION }).catch(() => undefined)
      return callOnce(tool, args)
    }
    throw err
  }
}

/** 单次调用：常驻通道优先，通道故障才回退 CLI。 */
async function callOnce(tool, args) {
  // browser_* 必须走 CLI：existing-profile 授权挂在 **daemon** 上（mcp 是独立进程，
  // 实测在 mcp 通道里 browser_prepare 会以 standard/无授权拒绝）。CDP 调用本来也不
  // 涉及指针延迟，走 CLI 没有性能损失。
  const cliOnly = /^(browser_|get_browser_state$)/.test(tool)
  if (getEngineMode() !== 'cli' && !cliOnly) {
    try {
      return await mcpCallTool(tool, args)
    } catch (err) {
      // channelDown = 连接层故障（本次调用尚未发出），安全回退；
      // 其它错误（超时/工具拒绝）必须原样抛出，绝不重放。
      if (!err?.channelDown) throw err
    }
  }
  return rawCall(tool, args)
}

/** 底层单次 CLI 调用（回退路径）。 */
function rawCall(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CUA_BIN, ['call', tool, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      const hint = e.code === 'ENOENT'
        ? `未找到 cua-driver：请确保它已安装并在 PATH 中，或确认官方安装器路径 ~/.cua-driver/packages/current/cua-driver.exe 可用，或设置环境变量 CUA_DRIVER_BIN 指向完整路径。`
        : ''
      reject(new Error(`cua-driver 无法启动 (${CUA_BIN}): ${e.message}${hint ? ' ' + hint : ''}`))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = (err || out).trim()
        reject(new Error(`cua-driver ${tool} 失败 (exit ${code}): ${msg.slice(0, 4000)}`))
        return
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(`cua-driver ${tool} 返回非 JSON: ${out.slice(0, 500)}`))
      }
    })
  })
}

/**
 * 归一化 MCP 形状的返回：若结果带 content 数组（[{type:'text',text}]），
 * 提取文本拼接；否则原样返回。（常驻通道已优先返回 structuredContent，
 * 这里保留给 CLI/旧调用与外部脚本使用。）
 */
export function normalizeMcp(value) {
  if (value && Array.isArray(value.content)) {
    const texts = value.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return value
}
