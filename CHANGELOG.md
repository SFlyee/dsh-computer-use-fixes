# Changelog

本仓库是 [dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use)（MIT）的社区修复分支。
下面的 0.4.0 记录相对上游 0.3.2 的全部本地修复。

## [0.4.0] - 2026-11-10

### 新增能力

- **Chromium CDP 浏览器通道**：网页内容（按钮/输入框/链接）走 DevTools 协议，
  `screen_observe` 返回页面元素编号，`computer_click(element=)` / `computer_type(element=)` /
  `computer_scroll` 在渲染进程内执行，**不产生任何系统鼠标/键盘事件**；绑定失败或无授权
  自动退回 UIA/视觉路径，并在结果里注明原因（配置 `browserCdp`，默认开）。
- **常驻 MCP 引擎通道**：引擎改为常驻 `cua-driver mcp`（MCP over stdio），
  单次 `tools/call` 4–10ms（旧 CLI spawn 0.8–2.6s）；通道故障自动回退 CLI，
  **调用超时不回退**（避免重复点击/输入）；插件加载时预热、卸载时 dispose
  （配置 `engineChannel: auto|cli`）。
- **元素优先**：`computer_click` 传坐标时，若该点落在按钮/菜单项/链接/复选/单选/
  标签页/列表项等可调用元素上，自动改用该元素的 UIA 调用（`element_token`）——
  不碰真实指针、不抢焦点、后台窗口也能点；编辑区/画布/文档等仍走像素/视觉
  （配置 `preferElement`，默认开）。
- **第 13 个工具 `screen_desktop`**：整屏截图（含虚拟光标位置），便于跨窗口/多屏任务。
- **单段缓动滑行**：滑行改为「每次先设置 `set_agent_cursor_motion`（`glide_duration_ms: 240`、
  `arc_size: 0.05`），再发一次 `move_cursor`」——引擎实测 `move_cursor` 阻塞到动画结束，
  返回即精确到位。删除了插件侧 5 段弧线插值（两层动画叠加造成的「光标绕圈」不再出现）；
  默认 spring 物理远距离 2461ms 收敛，现在固定 240ms。

### 修复

- **真实鼠标指针隔离**：定位到「点击时用户鼠标被拽走」的根因是前台投递（SendInput
  会把真实指针搬到落点且不还原）。现在只有显式 `delivery=foreground`（或引擎报后台不可达
  后的重投）才启用指针守卫：动作前记下真实指针，动作返回后**立即**用
  `move_cursor scope:'desktop'` 放回原位（实测 3–4ms），再把虚拟光标复停到落点；
  **不做事后复核**（用户要求「不用判断是否还原」），`after` 恒为 null，
  只有还原调用本身失败时才在结果里写明「还原调用失败」。
- **滑行载荷 overlay-only**：`move_cursor` 维持 `{session,x,y,target:{kind:'window',...}}`；
  不能再加 `scope:'window'`（引擎会 `invalid_action_target` 拒绝）；调用方没给 target 时
  补 `scope:'window'` 兜底，避免落进 desktop 作用域搬动真实指针。
- **失败也还原**：动作本身抛错时同样尝试把指针放回原位，避免「点击失败但指针留在落点」。
- **修正虚拟光标坐标**：`move_cursor` 使用屏幕坐标（窗口 bounds 左上角 + PNG 像素），
  修掉窗口不在 (0,0) 时视觉光标与实际落点错开的问题。
- **改善观察/动作链路**：观察崩溃修复、核对模式贴边自适应、元素矩形换算
  （`frameRectToPng`）、token 失效自愈（`stale_element_token` 重新观察并按 role/name 找回）、
  快照过期拒绝、引擎拒绝形状识别（`engineRefusal`）。
- **稳健性**：`@deepseek-ai/dsh-tools` 宿主依赖问题的本地规避经验见
  [docs/windows.md](docs/windows.md)；插件无 npm lifecycle 安装脚本。

### 验证

- `tests/cursor-isolation.mjs` **120/120**
- `tests/element-first.mjs` **21/21**
- `tests/browser-cdp.mjs` **31/31**
- 真机探针（见 `docs/engine-notes` 摘要）：单段滑行远 700px 总 232ms / 近 80px 总 249ms；
  `move_cursor scope:'desktop'` 还原恒 3–4ms；CDP 页面点击/输入全程零系统鼠标接口。

---

更细的历史（含 2026-10 之前的逐项表格）保留在上游项目与 fork 的维护者本地记录中。
