/**
 * dsh-computer-use —— Computer Use 插件：给 harness-desktop 增加"虚拟鼠标真人操作"。
 *
 * 工具集（Hermes 风格，模型友好）：
 *   screen_observe          看屏幕：AX 编号树 + 坐标 / 原生直读 / 视觉观察者
 *   screen_zoom             区域截图直读（≤500px JPEG，细节放大看）
 *   computer_click          点击（element 编号 或 x/y 坐标）
 *   computer_double_click   双击
 *   computer_right_click    右键
 *   computer_type           文本输入
 *   computer_key            按键 / 快捷键
 *   computer_scroll         滚动
 *   computer_drag           拖拽
 *   computer_wait           等待 / 轮询间隔
 *   app_list                列出应用
 *   app_launch              启动应用
 *
 * 视觉能力（原生接入）：
 *   - mode="native"：截图经 attachments 持久化后以图片块返回，主对话模型
 *     （如 deepseek-v4-flash-vision-exp）直接看图 —— 零外部 API、零额外 key。
 *   - mode="vision"：DeepSeek 视觉观察者（ctx.llm）结构化描述截图（免 ZHIPU key），
 *     不可用时回退 GLM 免费模型。
 *   - ax：零成本 AX 树；AX 树为空时自动降级 native → vision → ax。
 *
 * 安全设计（P1 已内建，P3 深化）：
 *   - 观察快照 TTL：过期后拒绝动作，必须重新观察（element_token 引擎侧双重校验）
 *   - 动作一律要求先 screen_observe（无快照直接拒绝，杜绝盲操作）
 */
import z from '@deepseek-ai/schemastery'

import { screenObserve, screenZoom, screenDesktop } from './lib/observe.js'
import {
  click, doubleClick, rightClick, typeText, key, scroll, drag, wait, listApps, launchApp,
} from './lib/actions.js'
import { guard } from './lib/guard.js'
import { cuaCall, CUA_SESSION } from './lib/cua.js'
import { setEngineMode, warmEngineChannel, disposeEngine } from './lib/engine.js'
import { loadHostModule } from './lib/host-deps.js'

/**
 * 宿主内部包 `@deepseek-ai/dsh-tools` 动态加载（见 `lib/host-deps.js`）。
 * 不作为 npm 依赖声明：否则 pnpm 会把它装进 profile，而它缺 peer（`@deepseek-ai/cordis`），
 * 宿主 tools 服务加载失败会导致整个 DSH 启动退出。
 */
const { defineTool } = await loadHostModule(
  '@deepseek-ai/dsh-tools',
  (m) => typeof m.defineTool === 'function',
)

export const name = 'dsh-computer-use-fixes'

export const inject = ['tools', 'approval']

/** 插件配置。 */
export const Config = z.object({
  /** 观察快照的有效期（毫秒）。 */
  ttlMs: z.number().default(30000),
  /** screen_observe 最多返回多少编号元素。 */
  maxElements: z.number().default(500),
  /** 区域限制：允许操作的应用名白名单（空 = 不限制）。 */
  allowedApps: z.array(z.string()).default([]),
  /** 虚拟光标主题 id（空 = 不设置，用引擎默认）。 */
  cursorTheme: z.string().default('com.dsh.computeruse.rainbow'),
  /**
   * 元素优先（默认开）：`computer_click` 传 x/y 时，若坐标落在按钮/菜单项/链接等
   * 可调用元素上，插件自动改用该元素的 element_token 走 UIA 通道（不碰真实指针、
   * 不抢焦点、后台窗口也能点）；只有编辑区/画布/文档或 vision 快照（无元素表）才走
   * 像素/视觉点击。关掉后恢复"给了坐标就一定按像素点"的旧行为。
   */
  preferElement: z.boolean().default(true),
  /**
   * 引擎通道（默认 auto）：
   *   auto —— 常驻 `cua-driver mcp` 通道优先（单次调用 4–10ms），通道故障自动回退 CLI；
   *   cli  —— 强制旧路径（每次 spawn 一个 CLI 进程，0.8–2.6s），仅排障用。
   * 常驻通道让「前台点击 → 立即还原指针」的间隔从 ~1s 压到几十毫秒。
   */
  engineChannel: z.union(['auto', 'cli']).default('auto'),
  /**
   * 浏览器 CDP 通道（默认开）：Chromium 窗口的网页内容优先走浏览器调试协议
   * （browser_prepare / get_browser_state / browser_click / browser_type），
   * 页面点击与输入完全不经系统鼠标。需要 cua-driver daemon 以
   * `--grant existing-profile` 启动；不可用时自动退回 UIA/视觉路径。
   */
  browserCdp: z.boolean().default(true),
  /**
   * 前台投递后的真实指针隔离（默认开）。
   * 平时滑行只动 agent overlay；只有显式 foreground 投递（或引擎报后台不可达后的
   * 前台重投）会让引擎用 SendInput 把真实指针搬到落点——本开关让插件在动作后
   * 把真实指针放回原位，保证"虚拟光标与真实鼠标各干各的"。
   */
  restoreRealPointer: z.boolean().default(true),
  /** 原生直读截图策略：auto（PNG 超限额时自动降级 zoom JPEG）/ full（始终原图 PNG）/ compact（始终 ≤500px JPEG）。 */
  nativeImage: z.union(['auto', 'full', 'compact']).default('auto'),
  /** Mode D 观察者 provider 路由。 */
  visionProvider: z.string().default('deepseek-official'),
  /** Mode D 观察者模型（需声明 image 输入）。 */
  visionModel: z.string().default('deepseek-v4-flash-vision-exp'),
})

/** 统一输出 schema：ok + result 文本。 */
const OUT = (extra = {}) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
      ...extra,
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
})

/** 图片块输出 schema 段（native 直读工具共用）。 */
const IMAGE_FIELD = {
  image: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
      bytes: { type: 'integer', required: true },
      width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      name: { type: 'string' },
    },
  },
}

/** render：值含 image 时追加图片块（主模型原生直读）。 */
export function renderWithImage(_args, value) {
  if (!value.image) return [{ type: 'text', text: value.result }]
  return [
    { type: 'text', text: value.result },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...value.image.name === undefined ? {} : { name: value.image.name },
      },
    },
  ]
}

/** 统一的坐标/编号参数块（坐标 = get_window_state 的 PNG 像素）。 */
const TARGET_PARAMS = {
  element: {
    type: 'integer',
    description: 'screen_observe 输出的元素编号（如 5）。与 x/y 二选一，优先。',
  },
  x: {
    type: 'integer',
    description: 'PNG 截图像素 x（与 screen_observe 返回的截图同一空间，模型所见即所点）。与 element 二选一。',
  },
  y: {
    type: 'integer',
    description: 'PNG 截图像素 y。',
  },
  zoom: {
    type: 'boolean',
    description: '可选：x/y 是最近一次 screen_zoom 返回图片内的像素时传 true，引擎会换算回窗口坐标（会自动扣除 zoom 的 20% 内边距）。图内坐标不要自己换算成窗口坐标。',
  },
  delivery: {
    type: 'string',
    enum: ['auto', 'background', 'foreground'],
    description: '可选：投递方式。auto（默认）= 先后台，引擎报 unverifiable 时自动改前台重试；foreground = 直接前台（会短暂抢焦点，Chromium/Electron 内容通常需要）。',
  },
}

export function apply(ctx, config) {
  const cfg = {
    ttlMs: config.ttlMs,
    maxElements: config.maxElements,
    allowedApps: Array.isArray(config.allowedApps) ? config.allowedApps : [],
    cursorTheme: config.cursorTheme,
    // 默认开：坐标命中可调用元素时自动改走 UIA 元素点击（不碰真实指针）。
    preferElement: config.preferElement !== false,
    // 默认开：Chromium 网页内容走 CDP（页面元素点击/输入不经过系统鼠标）。
    browserCdp: config.browserCdp !== false,
    // 默认开：前台投递后把真实指针放回原位（见 human.js withPointerGuard）。
    restoreRealPointer: config.restoreRealPointer !== false,
    // 引擎通道：auto = 常驻 MCP 优先（4–10ms），cli = 强制 spawn（排障用）。
    engineChannel: config.engineChannel === 'cli' ? 'cli' : 'auto',
    nativeImage: config.nativeImage || 'auto',
    visionProvider: config.visionProvider || 'deepseek-official',
    visionModel: config.visionModel || 'deepseek-v4-flash-vision-exp',
  }

  // 引擎通道：设置模式并预热常驻连接（冷启动握手 ~1s，放在加载期做掉）。
  try { setEngineMode(cfg.engineChannel) } catch { /* 忽略 */ }
  warmEngineChannel().catch(() => undefined)
  // 插件卸载/宿主退出时关掉常驻 MCP 子进程（Cordis 生命周期事件）。
  try { ctx.on?.('dispose', () => disposeEngine()) } catch { /* 忽略 */ }
  // 初始化虚拟光标：声明统一会话 + 应用主题（异步，不阻塞插件加载）
  cuaCall('start_session', { session: CUA_SESSION }).catch(() => undefined)
  if (cfg.cursorTheme) {
    cuaCall('set_agent_cursor_theme', { session: CUA_SESSION, theme_id: cfg.cursorTheme })
      .catch(() => undefined)
  }

  /** 统一包装：先过安全护栏，再执行实现（exec 透传给需要 route 的实现）。 */
  const wrap = (toolName, impl) => async (args, exec) => {
    try {
      const g = await guard(ctx, cfg, toolName, args, exec)
      if (!g.ok) return { ok: false, result: `✗ ${g.reason}` }
      return await impl(args, cfg, exec)
    } catch (err) {
      return { ok: false, result: `✗ ${err.message}` }
    }
  }

  ctx.tools.register(defineTool({
    name: 'screen_observe',
    description:
      '观察屏幕：对目标窗口生成"编号 + 控件 + 坐标"的界面树（AX 语义，零视觉 token 成本）。' +
      '操作电脑前必须先调用本工具取得快照；之后用 computer_click(element=[编号]) 或 computer_click(x=,y=) 操作（坐标为窗口本地截图像素）。' +
      'mode 选择：ax（默认，零成本树）/ vision（DeepSeek 视觉观察者结构化描述，免 ZHIPU key）/ native（截图直读，当前对话模型直接看图，需模型支持图片输入）。' +
      'AX 树无法解析（游戏/Canvas/Electron）时自动降级：native（若当前模型支持图片）→ vision → ax。' +
      '浏览器窗口（Edge/Chrome 等 Chromium）会优先返回 CDP 页面元素：网页里的按钮/链接/输入框也有 [编号]，可直接 element 点击/输入（走浏览器调试协议，完全不经过系统鼠标）。' +
      '快照默认 30 秒过期，过期后需重新观察。' +
      '【用法】返回的元素坐标只是候选：先 screen_zoom(at_x=, at_y=) 截图核对，目标在图心再点；界面会变（标签重排、滚动），一次观察只做一次点击。',
    parameters: {
      window: {
        type: 'string',
        description: '可选：目标窗口，传 pid 数字或标题子串（如 "访达"）。缺省选最前窗口。',
      },
      mode: {
        type: 'string',
        enum: ['ax', 'vision', 'native'],
        description: 'ax（默认）= 零成本的界面树；vision = 视觉观察者描述；native = 截图直读（模型直接看图）。',
      },
      query: {
        type: 'string',
        description: '可选：按控件标签过滤界面树（如 "提交"）。',
      },
      maxElements: {
        type: 'integer',
        description: '可选：最多返回多少个编号元素（防上下文爆炸）。',
      },
    },
    output: { ...OUT({
      window: { type: 'object', additionalProperties: false, properties: {
        pid: { type: 'integer' }, windowId: { type: 'integer' },
        app: { type: 'string' }, title: { type: 'string' },
      } },
      elementCount: { type: 'integer' },
      mode: { type: 'string' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' }, role: { type: 'string' },
            label: { type: 'string' },
            x: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            y: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          },
        },
      },
      screenshotFile: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      ...IMAGE_FIELD,
    }), render: renderWithImage },
    execute: wrap('screen_observe', (args, cfg2, exec) => screenObserve(ctx, args, cfg2, exec)),
  }))

  ctx.tools.register(defineTool({
    name: 'screen_zoom',
    description:
      '区域截图直读：裁剪窗口某块区域（PNG 截图像素）为 ≤500px JPEG 并以图片返回，当前对话模型直接看图。' +
      '用于"放大某块区域细看"（小字、图标、图表），图片 token 远小于整窗截图。' +
      '【先核对再点】传 at_x/at_y 会以该坐标为中心裁切，图心就是这个坐标：目标不在图心 = 坐标偏了，先别点。' +
      '拿 AX 元素坐标时不要直接点，先 screen_zoom(at_x=元素坐标) 看一眼，确认目标在图心再点。' +
      '【坐标纪律】引擎会自动给请求区域外扩 20% 内边距并放大，图内像素 ≠ 整窗截图坐标，也不要用预览尺寸估读；' +
      '在图内量到的坐标一律原样传 computer_click(x=, y=, zoom=true) 由引擎换算，越界会被拒绝。' +
      '【逼近流程】大区域先定位 → 每次缩到目标准确位置的 1/3 重截 → 目标占满画面后用 element 编号点击。',
    parameters: {
      pid: { type: 'integer', description: '可选：目标窗口所属进程 pid（screen_observe 输出）；缺省按 window_id 解析。' },
      window_id: { type: 'integer', required: true, description: '目标窗口 id（screen_observe 或 app_list 输出）。' },
      at_x: { type: 'integer', description: '可选：核对模式——以该 PNG x 为中心裁切，图心即该坐标。与 x1/x2 二选一，优先。' },
      at_y: { type: 'integer', description: '可选：核对模式——以该 PNG y 为中心裁切。' },
      span: { type: 'integer', description: '可选：核对模式的裁切跨度（px，默认 140，上限 500）。' },
      x1: { type: 'integer', description: '可选：区域左边界（PNG 截图像素），默认 0。' },
      y1: { type: 'integer', description: '可选：区域上边界，默认 0。' },
      x2: { type: 'integer', description: '可选：区域右边界，默认 PNG 截图宽。' },
      y2: { type: 'integer', description: '可选：区域下边界，默认 PNG 截图高。' },
    },
    output: { ...OUT(IMAGE_FIELD), render: renderWithImage },
    execute: wrap('screen_zoom', (args, cfg2, exec) => screenZoom(ctx, args, cfg2, exec)),
  }))

  ctx.tools.register(defineTool({
    name: 'screen_desktop',
    description:
      '整屏截图（含虚拟光标）：返回整个桌面的截图，图中青色三角箭头就是 cua 虚拟光标当前的真实位置。' +
      '用于核对"我的光标停在哪、刚才点在了哪个像素"。注意：窗口截图（screen_observe / screen_zoom）不包含这个光标，只有整屏截图才有。',
    parameters: {},
    output: { ...OUT(IMAGE_FIELD), render: renderWithImage },
    execute: wrap('screen_desktop', (args, cfg2, exec) => screenDesktop(ctx, cfg2, exec)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description:
      '点击：传入 screen_observe 输出的元素编号（element，最准），或 PNG 截图像素坐标（x,y）。点击的是 cua-driver 的虚拟光标，不抢真实鼠标。' +
      '元素优先：即使传的是 x/y，只要该点落在按钮/菜单项/链接等可调用元素上，插件会自动改用该元素的 UIA 调用（不碰真实指针、不抢焦点、后台窗口也能点）；编辑区/画布/文档或 vision 快照才走像素/视觉点击。' +
      '光标隔离：滑行只移动 agent overlay（实测不碰真实指针）；只有显式 delivery=foreground（或引擎报后台不可达后的前台重投）才会让引擎用 SendInput 把真实指针搬到落点，插件随后会立刻把真实指针放回原位。' +
      '网页内容（Chromium 页面元素，来自 CDP 快照）按 element 编号点击时走 CDP，完全不经系统鼠标；网页的 x/y 坐标点击仍为系统鼠标路径，请优先用 element 编号。' +
      '【铁律】拿到 AX 坐标不要立刻点：先 screen_zoom(at_x=坐标, at_y=坐标) 看图心是否就是目标，确认后再点；' +
      '一次 screen_observe 只做一次点击（界面会动，快照会失真），点完必须复查（screen_zoom 看该处变化 / screen_observe 看状态）。' +
      'Chromium/Electron 内容会丢弃后台投递（引擎回 effect=unverifiable 且无回执），本工具只在引擎明确报后台不可用时才改前台重投，避免重复点击。',
    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' } },
    output: OUT(),
    execute: wrap('computer_click', (args, cfg2) => click(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_double_click',
    description: '双击：element 编号 或 x/y 坐标。',
    parameters: TARGET_PARAMS,
    output: OUT(),
    execute: wrap('computer_double_click', (args, cfg2) => doubleClick(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_right_click',
    description: '右键点击：element 编号 或 x/y 坐标。',
    parameters: TARGET_PARAMS,
    output: OUT(),
    execute: wrap('computer_right_click', (args, cfg2) => rightClick(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_type',
    description: '文本输入：向当前焦点（或指定元素）输入一段文本。Chromium 网页元素（CDP 快照里有 [编号]）走浏览器调试协议输入，不用键盘/鼠标。注意：不要在密码框使用——密码必须由用户本人输入（敏感输入保护）。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本。' },
      element: TARGET_PARAMS.element,
      delivery: TARGET_PARAMS.delivery,
    },
    output: OUT(),
    execute: wrap('computer_type', (args, cfg2) => typeText(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_key',
    description: '按键 / 快捷键：如 return、tab、escape、cmd+c、shift+tab。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名或组合（示例: return / cmd+c / shift+tab / cmd+shift+p）。' },
      delivery: TARGET_PARAMS.delivery,
    },
    output: OUT(),
    execute: wrap('computer_key', (args, cfg2) => key(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_scroll',
    description: '滚动：在目标窗口内向上/下/左/右滚动。Chromium 网页快照下走 CDP 页面滚动（不经过系统鼠标）。',
    parameters: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向，默认 down。' },
      amount: { type: 'integer', description: '可选：滚动格数，默认 3。' },
      element: TARGET_PARAMS.element,
      delivery: TARGET_PARAMS.delivery,
    },
    output: OUT(),
    execute: wrap('computer_scroll', (args, cfg2) => scroll(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_drag',
    description: '拖拽：在快照窗口内从 (from_x,from_y) 拖到 (to_x,to_y)，坐标为窗口本地截图像素。',
    parameters: {
      from_x: { type: 'integer', required: true, description: '起点 x（截图像素）。' },
      from_y: { type: 'integer', required: true, description: '起点 y。' },
      to_x: { type: 'integer', required: true, description: '终点 x。' },
      to_y: { type: 'integer', required: true, description: '终点 y。' },
      duration_ms: { type: 'integer', description: '可选：拖拽耗时毫秒，默认 500。' },
    },
    output: OUT(),
    execute: wrap('computer_drag', (args, cfg2) => drag(args, cfg2)),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_wait',
    description: '等待：暂停一段时间（如等待界面加载/动画完成），不调用引擎。',
    parameters: {
      ms: { type: 'integer', required: true, description: '等待毫秒数（1-60000）。' },
    },
    output: OUT(),
    execute: wrap('computer_wait', (args) => wait(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'app_list',
    description: '列出当前正在运行的应用（名称 + pid），用于选择要操作的目标。',
    parameters: {},
    output: OUT({ apps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' }, pid: { type: 'integer' }, active: { type: 'boolean' },
        },
      },
    } }),
    execute: wrap('app_list', () => listApps()),
  }))

  ctx.tools.register(defineTool({
    name: 'app_launch',
    description: '启动一个应用（后台启动，不抢焦点；可选 bring_to_front 前置到前台）。用于"打开应用"这一步。',
    parameters: {
      name: {
        type: 'string',
        description: '应用显示名（如 "备忘录"）。与 bundle_id 二选一。',
      },
      bundle_id: {
        type: 'string',
        description: '应用 bundle id（如 com.apple.Notes）。优先于 name。',
      },
      bring_to_front: {
        type: 'boolean',
        description: '可选：启动后是否前置到前台（默认 false，后台启动）。',
      },
      creates_new_instance: {
        type: 'boolean',
        description: '可选：强制启动新实例（open -n），用于并发多会话隔离。',
      },
    },
    output: OUT({ pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] } }),
    execute: wrap('app_launch', (args) => launchApp(args)),
  }))

  ctx.logger?.info('dsh-computer-use: 13 个工具已注册（screen_observe / screen_zoom / screen_desktop / computer_click / double / right / type / key / scroll / drag / wait / app_list / app_launch）')
}

export default { name, inject, Config, apply }
