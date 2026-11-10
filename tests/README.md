# 离线回归测试

三套脚本都用**桩化引擎**（替换 `human.deps.cuaCall`）运行，不需要真实桌面、
不启动 cua-driver、不移动真实鼠标，可在 CI 或任意机器上跑。

| 脚本 | 覆盖点 | 检查数 |
|---|---|---|
| `cursor-isolation.mjs` | 虚拟光标滑行载荷、真实指针守卫（读指针/立即还原/复停）、`restorePointer:false`、token 路径、actions.js 集成、全局载荷审计 | 125 |
| `element-first.mjs` | 元素矩形换算、按钮/菜单/链接/中文角色命中、编辑区不晋升、`preferElement:false`、vision 快照 | 21 |
| `browser-cdp.mjs` | CDP 识别/拒绝形状、绑定缓存、页面快照、click/type/scroll 载荷、ref 失效自愈、降级 | 31 |

```bash
npm test
# 或单独跑
node tests/cursor-isolation.mjs
```

退出码 0 = 全过，1 = 有失败。需要真实引擎的验证脚本（`verify-runtime.mjs`、真机
CDP/指针测试）不在本目录，避免 CI 误触真实鼠标。
