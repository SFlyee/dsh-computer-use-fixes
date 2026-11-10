# dsh-computer-use-fixes

> **社区修复分支（fork）· Community fork**
>
> 本仓库基于 [988hj7tczd-oss/dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use)（MIT，0.3.2）修改而来。
> 上游的功能说明、配置项、安全模型和完整用法请看**上游 README**；本页只讲三件事：
> **我们改了什么、怎么安装、怎么验证**。
> 原项目版权归其作者；本分支同样以 MIT 发布，署名见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。

[![CI](https://github.com/SFlyee/dsh-computer-use-fixes/actions/workflows/ci.yml/badge.svg)](https://github.com/SFlyee/dsh-computer-use-fixes/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/SFlyee/dsh-computer-use-fixes)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)](https://nodejs.org/)

## 改了什么（相对上游 0.3.2）

| 主题 | 改动 | 效果 |
|---|---|---|
| **真实指针隔离** | 只有显式前台投递（或引擎报后台不可达后的重投）才启用指针守卫；动作返回后立即还原，不再读回复核 | 后台操作不碰用户鼠标；前台点击后指针在 3–4ms 内回到原位 |
| **Chromium CDP 通道** | 网页内容走 DevTools 协议：页面元素编号、点击/输入/滚动都在渲染进程内执行 | 网页操作不产生任何系统鼠标键盘事件；无授权时自动退回 UIA/视觉 |
| **常驻 MCP 引擎通道** | 引擎连接从「每次 spawn CLI」改为常驻 `cua-driver mcp` | 单次调用 4–10ms（旧 0.8–2.6s），指针还原 ~3ms |
| **元素优先** | 坐标点击命中按钮/菜单/链接等可调用元素时，自动改用 UIA 元素调用 | 不碰真实指针、不抢焦点，后台窗口也能点 |
| **单段缓动滑行** | 去掉插件侧 6 段弧线插值，改为一次 `move_cursor` = 引擎一段 240ms 定时缓动 | 光标不再绕圈；远距离滑行从 ~2.4s 降到 240ms |
| **第 13 个工具** | 新增 `screen_desktop`（整屏截图，含虚拟光标） | 跨窗口/多屏任务更方便 |
| **0.4.3 通道修复** | MCP 通道截图归一到 `screenshot_png_b64`（修 native/vision/zoom 空图）；像素点击默认前台可见投递（修 Electron 静默无效点击）；`computer_type` 支持 `replace`（点击聚焦 + ctrl+a 全选 + 前台替换，失败自动回退 Backspace 清空）与 `x/y` 像素定位 |
| **稳健性** | token 失效自愈、快照过期拒绝、会话自愈、观察链路修复、引擎拒绝形状识别 | 长时运行更稳，失败原因更明确 |

逐项细节见 [CHANGELOG.md](CHANGELOG.md)；引擎行为依据（探针数据）见 [docs/engine-notes.md](docs/engine-notes.md)。

## 安装

环境：DeepSeek Harness + [cua-driver](https://github.com/trycua/cua)（实测 0.28.2；`CUA_DRIVER_BIN` 或 PATH 均可）。

- **npm**（0.4.0 起已发布）：`npm install -g dsh-computer-use-fixes`，或按宿主版本用 `dsh plugin add dsh-computer-use-fixes`
- **Windows**：[docs/windows.md](docs/windows.md)（profile `node_modules` 方式）
- **macOS / Linux**：

  ```bash
  ./install.sh --dry-run   # 预演，不写文件
  ./install.sh             # 装到 home 级 patch 层
  ```

- 安装后重启宿主生效；验证工具是否出现：让它跑一次 `app_list` 或 `screen_observe`。

> ⚠️ 本分支插件 id 是 `dsh-computer-use-fixes`，**不要和上游 `dsh-computer-use` 同时安装**
> （两者注册同名工具会造成冲突）。切换前先卸载/禁用另一个。
>
> npm 包名是 `dsh-computer-use-fixes`，与上游 `dsh-computer-use` 不同名，不会互相覆盖。
>
> 0.4.2 起插件不再声明 `@deepseek-ai/dsh-tools` 依赖（改为动态加载宿主自带实现），
> 用插件管理器安装时不会再出现「缺 peer 的 dsh-tools 导致 DSH 启动失败」，也不需要手工 shim。

## 工具（13 个）

| 工具 | 说明 |
|---|---|
| `screen_observe` | 观察窗口：AX/UIA 元素、坐标或截图；Chromium 窗口自动走 CDP 返回页面元素 |
| `screen_zoom` | 截取并放大窗口局部区域 |
| `screen_desktop` | 整屏截图（含虚拟光标位置） |
| `computer_click` | 点击元素或坐标（元素优先，可后台） |
| `computer_double_click` | 双击 |
| `computer_right_click` | 右键 |
| `computer_type` | 输入文本 |
| `computer_key` | 按键 / 快捷键 |
| `computer_scroll` | 滚动 |
| `computer_drag` | 拖拽 |
| `computer_wait` | 等待界面加载/动画 |
| `app_list` | 列出运行中的应用 |
| `app_launch` | 启动应用 |

观察模式、配置项（`ttlMs` / `allowedApps` / `preferElement` / `browserCdp` / `engineChannel` / `restoreRealPointer` 等）、
安全模型与完整用法，请直接参考**上游 README**；本分支未改动这些接口的语义。

## 验证

```bash
npm run check   # 12 个文件的语法检查
npm test        # 177 项离线回归（引擎桩化，不碰真实鼠标）
```

- CI：每次 push / PR 自动跑上面两项 + 主题生成 sanity；
- 真机探针（滑行耗时、指针还原、CDP 调用序列）数据见 [docs/engine-notes.md](docs/engine-notes.md)；
- 其他材料：[VERIFICATION.md](VERIFICATION.md)、[PERMISSIONS.md](PERMISSIONS.md)、[SECURITY.md](SECURITY.md)。

## 与上游的关系

| 项 | 说明 |
|---|---|
| 起点 | 上游 0.3.2（MIT），保留原版权声明 |
| 版本线 | 本分支独立版本号（从 0.4.0 开始），不自动跟随上游 0.3.x |
| 同步 | 上游后续版本由维护者按需合并，并在 CHANGELOG 标注「基于 upstream x.y.z」 |
| 归属 | 上游问题请反馈给上游；本分支的问题/PR 在本仓库处理 |
| 分发 | GitHub Release + npm：`dsh-computer-use-fixes`（0.4.0 起） |

## License

MIT。本分支基于 [dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use)（MIT）修改；原版权归其作者，详见 [NOTICE](NOTICE)。

---

## English (short)

This repo is a community **fork** of [dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use) (MIT, v0.3.2).
It keeps upstream's license and copyright notice. This page only documents **what we changed**,
installation, and verification. For the full feature docs (observation modes, configuration,
security model), see the **upstream README**.

Changes: real-pointer isolation, Chromium CDP channel, persistent MCP engine channel,
element-first clicks, single-segment eased cursor glide, `screen_desktop` tool, and robustness fixes.
See [CHANGELOG.md](CHANGELOG.md) and [docs/engine-notes.md](docs/engine-notes.md).
