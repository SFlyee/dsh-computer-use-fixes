# Windows 安装与已知问题

## 前置条件

1. 已安装 [cua-driver](https://github.com/trycua/cua)（本分支实测 0.28.2），
   默认安装器路径：`%USERPROFILE%\.cua-driver\packages\current\cua-driver.exe`；
   也可以设置环境变量 `CUA_DRIVER_BIN` 指向 exe。
2. 已安装 DeepSeek Harness 桌面端，并能正常打开 profile。

## 安装插件

把本仓库的插件内容放进 DSH profile 的 `node_modules`：

```powershell
$src = "<本仓库路径>"
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-computer-use-fixes"
Copy-Item $src $dst -Recurse -Force
```

然后在 profile 的 `package.json` 里把 `dsh-computer-use-fixes` 加进依赖（或按你所用 DSH 版本的
插件管理方式安装），重启 DeepSeek Harness 后工具才会出现。

> 本分支的插件 id 是 `dsh-computer-use-fixes`，**不要和上游 `dsh-computer-use` 同时安装**
> （两者注册同名工具，会冲突）。切换前先卸载/禁用另一个。

## 宿主依赖（0.4.2 起无需额外修复）

**背景**：早期版本（含上游 0.3.x）把宿主内部包 `@deepseek-ai/dsh-tools` 声明为普通
`dependencies`。pnpm 把它提升到 profile 的 `node_modules` 顶层后，它的 9 个 peer 依赖
（首个是 `@deepseek-ai/cordis`）因 `autoInstallPeers: false` 一个都不会装，宿主加载
`ToolRuntime` 时 `ERR_MODULE_NOT_FOUND`，整个 DSH 启动失败退出。

**0.4.2 起**：插件不再声明这个依赖，改用 `lib/host-deps.js` 动态加载 ——
先尝试常规模块解析，失败则直接从宿主 `app.asar` 里加载同一份实现
（与宿主同一模块实例）。因此：

- 用插件管理器装/升本插件，**不会再**把 `@deepseek-ai/dsh-tools` 装进 profile；
- 不再需要手工放 shim；
- 如果你用的是 0.4.1 或更早版本并遇到上述报错，升级到 0.4.2 即可；临时救急仍可手工
  把 profile 里的 `node_modules/@deepseek-ai/dsh-tools` 换成 re-export 宿主副本的 shim。

## CDP（Chromium 网页通道）授权

CDP 通道要求 daemon 带授权启动：

```powershell
cua-driver stop
cua-driver serve --grant existing-profile
```

需要每次登录都生效时，用你自己的登录自启方式（任务计划 / HKCU Run）重启 daemon。
授权后 agent 在工具调用时可以 attach 本机已登录的 Chromium profile 的调试端点——
只在信任的机器上开启；撤销方式是重启一个不带 `--grant` 的 daemon。

## 验证

```powershell
# 语法 + 三套离线回归（不需要桌面）
npm run check
npm test

# 真实引擎冒烟（只移动虚拟光标，不点击真实鼠标）
node verify-runtime.mjs
```
