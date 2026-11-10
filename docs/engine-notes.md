# 引擎行为探针（cua-driver 0.28.2）

本分支的关键设计都基于对 `cua-driver` 的实测。以下是可复现的结论摘要
（完整脚本在维护者的本地证据库中，未随仓库发布）。

## 1. `move_cursor` 的作用域

| 载荷 | 效果 |
|---|---|
| `move_cursor` + `target:{kind:'window',pid,window_id}` | 只移动 agent overlay，真实指针不动（**滑行使用这种载荷**） |
| `move_cursor` + `scope:'window'` + `target` | 引擎 `invalid_action_target` 拒绝，**不能加** |
| `move_cursor` + `scope:'desktop'` | 把真实 OS 指针精确搬到 (x,y)，**只用于还原真实指针** |
| 不传 target 也不传 scope | 行为不稳定（有时会搬真实指针），所以缺 target 时补 `scope:'window'` |

## 2. 单次 `move_cursor` 的耗时（窗口 target，只动 overlay）

| 运动配置 | 远 700px | 近 80px |
|---|---|---|
| `glide_duration_ms: 240` | 251 ms | 247 ms |
| `glide_duration_ms: 100` | 110 ms | — |
| `glide_duration_ms: 600` | 610 ms | — |
| 默认 spring 物理（`glide_duration_ms: 0`） | **2461 ms** | 17 ms |

结论：`glide_duration_ms` 精确决定动画时长，且 `move_cursor` **阻塞到动画结束**，
返回时 overlay 已到位——所以「一次调用 = 一段平滑运动」，插件侧不需要自己插值。

## 3. 真实指针还原不受运动参数影响

把真实指针「还原」到它当前所在位置（视觉不动）时，`move_cursor scope:'desktop'`
在 `glide=0` / `glide=240` / 默认 spring 三种配置下都是 **3–4 ms**。
所以第 0.4.0 的单段缓动不会拖慢「点击后立刻把指针放回原位」。

## 4. 前台投递会搬动真实指针

`click` 带 `delivery_mode:'foreground'` 时走 `SendInput`（route = `global_input`），
真实指针会被搬到落点且**不会自动还原**——这就是「点击时用户鼠标被拽走」的根因。
后台投递（`window_input`，UIA/PostMessage）不移动真实指针。

## 5. Chromium 网页内容不在 UIA 树里

Windows UIA 只覆盖浏览器自身界面（地址栏/标签/工具栏），网页 DOM 一个元素都没有；
所以网页内容走 CDP（`browser_prepare` → `get_browser_state` → `semantic_v2` 快照 →
`browser_click` / `browser_type` / `browser_pointer`），全程零系统鼠标键盘事件。
CDP 绑定需要 daemon 以 `--grant existing-profile` 启动并由用户授权。
