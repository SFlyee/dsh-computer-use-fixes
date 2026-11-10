/**
 * host-deps.js —— 宿主内部包的动态加载器。
 *
 * ## 为什么需要
 * 插件用到 `@deepseek-ai/dsh-tools`（`defineTool` 等）。这个包是 **DeepSeek Harness 宿主自带**
 * 的内部包，如果把它写进插件的 `dependencies`：
 *   1. pnpm 会把它装进 profile 的 `node_modules` 顶层（hoisted）；
 *   2. 它自己的 9 个 peerDependencies（首个是 `@deepseek-ai/cordis`）在
 *      `autoInstallPeers: false` 的配置下一个都不会装；
 *   3. 宿主加载 `ToolRuntime` 时直接 `ERR_MODULE_NOT_FOUND`，tools 服务起不来，
 *      连带整个 DSH 启动失败退出。
 *
 * 以前的绕法是往 profile 里手工塞一个同名的 shim 包（re-export 宿主 app.asar 里的实现），
 * 但每次 pnpm 重装 profile 依赖都会把 shim 覆盖回坏包，得再修一次。
 *
 * ## 现在的做法
 * 插件**不再声明**这个依赖，运行时按顺序加载：
 *   1. 常规 `import('@deepseek-ai/dsh-tools')`（开发环境 / profile 里恰好有可用副本时）；
 *   2. 宿主 `app.asar` 内自带的那一份（`process.resourcesPath`，或从可执行文件位置推导）。
 *
 * 两者在 Electron 里指向同一份实现，拿到的 `defineTool` 与宿主一致；且第 2 步不经过
 * `node_modules`，pnpm 怎么重装 profile 都不会把它弄坏。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** app.asar 内宿主依赖的固定相对路径（实测 0.28/DSh 桌面端布局）。 */
const ASAR_TAIL = ['dsh', 'node_modules']

/** 可选的 app.asar 根目录候选（按可靠性排序）。 */
function asarRoots() {
  const roots = []
  if (process.env.DSH_ASAR_ROOT) roots.push(process.env.DSH_ASAR_ROOT)
  if (process.resourcesPath) roots.push(join(process.resourcesPath, 'app.asar'))
  // ELECTRON_RUN_AS_NODE / 直接从安装目录启动时 resourcesPath 可能为空，从 exe 位置推导
  if (process.execPath) {
    roots.push(join(dirname(process.execPath), 'resources', 'app.asar'))
  }
  return [...new Set(roots)]
}

/** 一个包可能的入口文件（宿主内实际入口以 lib/index.* 为主）。 */
const ENTRY_FILES = ['lib/index.js', 'lib/index.mjs', 'lib/index.cjs', 'index.js', 'index.mjs', 'index.cjs']

/**
 * 在 app.asar 里查找某个包的可读入口。
 * @param {string} specifier 包名（可带 scope），如 '@deepseek-ai/dsh-tools'
 * @returns {string[]} 候选绝对路径（存在且可读的）
 */
function asarCandidates(specifier) {
  const [scope, name] = specifier.startsWith('@')
    ? specifier.split('/')
    : [null, specifier]
  const pkgSegments = scope ? [scope, name] : [name]
  const found = []
  for (const root of asarRoots()) {
    for (const entry of ENTRY_FILES) {
      const p = join(root, ...ASAR_TAIL, ...pkgSegments, ...entry.split('/'))
      if (existsSync(p)) found.push(p)
    }
  }
  return found
}

/**
 * 加载宿主内部包。
 * @param {string} specifier 包名，如 '@deepseek-ai/dsh-tools'
 * @param {(mod: any) => boolean} [accept] 形状校验，用来确认拿到的是同一份可用实现
 * @returns {Promise<any>} 模块命名空间
 */
export async function loadHostModule(specifier, accept) {
  const ok = (m) => !accept || accept(m)

  // 1) 常规解析：开发环境或 profile 里有可用副本时走这里
  try {
    const mod = await import(specifier)
    if (ok(mod)) return mod
  } catch { /* 继续尝试宿主 app.asar */ }

  // 2) 宿主 app.asar 内自带实现
  const candidates = asarCandidates(specifier)
  for (const file of candidates) {
    try {
      const mod = await import(pathToFileURL(file).href)
      if (ok(mod)) return mod
    } catch { /* 试下一个候选 */ }
  }

  throw new Error(
    `无法加载宿主依赖 ${specifier}：常规模块解析失败，app.asar 内也没找到可用实现。` +
    `（候选 ${candidates.length} 个；可用 DSH_ASAR_ROOT 指定 app.asar 目录）`,
  )
}
