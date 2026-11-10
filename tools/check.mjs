// 全量语法检查（node --check），跨平台可跑。
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = ['index.js', 'verify-runtime.mjs']
try {
  for (const f of readdirSync('lib')) if (f.endsWith('.js')) files.push('lib/' + f)
} catch { /* 不在仓库根目录运行时忽略 */ }

let bad = 0
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' })
  if (r.status !== 0) bad++
}
if (bad) {
  console.error(`${bad} 个文件语法检查失败`)
  process.exit(1)
}
console.log(`syntax OK: ${files.length} files`)
