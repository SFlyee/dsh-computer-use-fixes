# 安全说明 / Security

## 这个插件能做什么

`dsh-computer-use-fixes` 通过 `cua-driver` 驱动本机桌面：观察窗口（AX/UIA/截图）、
移动独立虚拟光标、点击、输入、滚动、拖拽，以及通过 Chromium DevTools 协议操作网页元素。

它**不是沙箱**。启用后，模型可以按你的授权操作当前登录会话里的桌面应用。

## 风险与边界

1. **原生驱动权限**：`cua-driver` 以你的用户身份运行，能力等价于你在键盘鼠标前的操作。
   只在你信任的机器和会话里启用，不要把本插件接到不可信的 Agent 上。
2. **前台投递会短暂搬动真实指针**：只有显式 `delivery=foreground`（或引擎报后台不可达后
   自动重投）时，引擎才会用 SendInput 把真实指针移到落点；插件在动作返回后**立即**把它
   放回动作前位置（实测还原本身 3–4ms）。后台投递不移动真实指针。
3. **CDP 需要显式授权**：Chromium 网页通道要求 daemon 以 `--grant existing-profile` 启动，
   由用户明确授权后才会 attach 已登录的浏览器 profile 调试端点。未授权时插件自动退回
   UIA/视觉路径，不会静默 attach。授权可随时撤销（重启不带 `--grant` 的 daemon 即可）。
4. **密码框保护**：检测到安全文本字段时拒绝自动输入；密码/密钥请由用户本人输入。
5. **危险操作审批**：元素标签命中删除、支付、购买、转账、退出登录等词时请求用户确认。
6. **数据边界**：核心桌面路径不读取业务文件或额外凭据。可选 vision fallback 只在用户
   配置了 GLM key 时读取该 key 并向 Z.AI API 发起 HTTPS 请求；key 不会被写入或打印。
   本插件没有 npm lifecycle 安装脚本。
7. **快照与白名单**：动作必须基于新鲜观察快照；配置 `allowedApps` 后只允许指定应用。

## 报告漏洞

请通过 GitHub Security Advisories（仓库 → Security → Report a vulnerability）私下报告。
请附上版本号、平台、`cua-driver` 版本与最小复现步骤；不要贴真实凭据或敏感截图。

## Provenance

本仓库是社区 fork，基于 MIT 许可的
[dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use)；原版权归其作者。
