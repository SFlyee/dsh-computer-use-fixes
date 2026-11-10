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

## 已知问题：@deepseek-ai/dsh-tools 解析失败

**症状**：重启后 DSH 直接退出，日志里出现 `ERR_MODULE_NOT_FOUND`，且指向
`@deepseek-ai/cordis` 或 `@deepseek-ai/dsh-tools`。

**原因**：插件把 `@deepseek-ai/dsh-tools` 声明为 `dependencies`（与上游 npm 包一致）。
pnpm 会把它提升到 profile 的 `node_modules` 顶层，而它的 9 个 peer 依赖因为
`autoInstallPeers: false` 没有被安装，于是 `ToolRuntime` 加载失败，连带整个 tools
服务起不来，宿主启动审计失败。

**处理**：这是宿主依赖布局问题，不属于本插件的功能缺陷。可以：
- 用 DSH 插件管理器卸载本插件，恢复宿主依赖后再按官方方式安装；
- 或参考上游项目的讨论/文档，把 profile 里那份 `@deepseek-ai/dsh-tools` 替换成
  re-export 宿主自带副本的本地 shim（本分支不附带自动修复脚本，改动宿主依赖前请自行评估）。

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
