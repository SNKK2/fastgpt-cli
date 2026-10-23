// 错误契约：所有错误都带 type/subtype/hint/action_required
//
// 设计目标（借鉴 lark-cli）：
//   agent 只会看错误信息，不会回头翻文档。
//   所以每一条错误都必须自带「下一步怎么做」和「不许怎么做」。
//
// 核心字段：
//   action_required: 'self'   agent 自己能解决，照 next_command 执行
//                    'user'   必须让用户操作（agent 无法代劳）
//                    'none'   无法解决，只能上报
//   forbidden:       明确禁止的错误做法，比文档红线更靠近执行点

/**
 * 预设部署地址。放在错误返回里直接给出，不要求 agent 去读文档。
 * lark-cli 的设计思路：错误信息本身就是操作手册。
 */
export const BASE_PRESETS = {
  cn:     { label: '中国 SaaS 版',   base: 'https://cloud.fastgpt.cn' },
  global: { label: '海外 SaaS 版',   base: 'https://cloud.fastgpt.io' },
  local:  { label: '本地开发',       base: 'http://localhost:3000' },
  private:{ label: '商业私有化',     base: null, hint: '需要你提供部署地址，如 http://192.168.1.10:3000 或 https://fastgpt.yourcompany.com' }
};

export const Category = {
  config: 'config',        // 配置缺失
  auth: 'auth',            // 认证问题
  permission: 'permission',// 权限不足
  validation: 'validation',// 参数/结构校验失败
  resource: 'resource',    // 资源不存在
  platform: 'platform',    // FastGPT 平台限制（不是使用者的错）
  network: 'network',      // 网络异常
  usage: 'usage'           // 命令用法错误
};

export class CliError extends Error {
  constructor({ category, subtype, message, hint, nextCommand, actionRequired = 'self', forbidden, details, options, deadEnd, mustEndTurn, resolvedBy, cause }) {
    super(message);
    this.name = 'CliError';
    this.category = category;
    this.subtype = subtype;
    this.hint = hint;
    this.nextCommand = nextCommand;
    this.actionRequired = actionRequired;
    this.forbidden = forbidden;
    this.details = details;
    this.options = options;
    this.deadEnd = deadEnd;
    this.mustEndTurn = mustEndTurn;
    this.resolvedBy = resolvedBy;
    this.cause = cause;
  }

  toEnvelope() {
    const error = {
      type: this.category,
      subtype: this.subtype,
      message: this.message
    };
    if (this.hint) error.hint = this.hint;
    if (this.nextCommand) error.next_command = this.nextCommand;
    error.action_required = this.actionRequired;
    if (this.forbidden) error.forbidden = this.forbidden;
    if (this.options) error.options = this.options;
    if (this.deadEnd) error.dead_end = true;
    if (this.mustEndTurn) error.must_end_turn = true;
    if (this.resolvedBy) error.resolved_by = this.resolvedBy;
    if (this.details !== undefined) error.details = this.details;
    return { ok: false, error };
  }
}

// 退出码按 category 映射，便于脚本分支
export const EXIT_CODES = {
  [Category.config]: 10,
  [Category.auth]: 11,
  [Category.permission]: 12,
  [Category.validation]: 2,
  [Category.resource]: 13,
  [Category.platform]: 14,
  [Category.network]: 15,
  [Category.usage]: 1
};

export const exitCodeFor = err => EXIT_CODES[err?.category] ?? 1;

/**
 * 错误注册表：subtype -> 默认字段。
 * 调用处只需给 subtype 和必要的动态信息。
 */
const REGISTRY = {
  // ---- 配置 ----
  not_configured: {
    category: Category.config,
    message: '尚未配置 FastGPT 服务地址',
    hint: '请选择部署版本后运行 init。常见选择见 options，'
        + '中国/海外 SaaS 和本地开发可直接用 --preset，'
        + '商业私有化需要你提供实际部署地址',
    nextCommand: 'fastgpt init --preset cn',
    actionRequired: 'user',
    forbidden: '不要猜测地址；不确定是哪个版本时问用户'
  },
  base_unknown_preset: {
    category: Category.config,
    message: '未知的预设名称',
    hint: '可用预设：cn（中国 SaaS）/ global（海外 SaaS）/ local（本地开发）',
    nextCommand: 'fastgpt init --preset cn',
    actionRequired: 'self'
  },

  // ---- 认证 ----
  not_logged_in: {
    category: Category.auth,
    message: '未登录或登录已失效',
    hint: '运行 fastgpt init（首次使用），或 fastgpt auth login --user <账号> --pass <密码>，扫码账号用 fastgpt auth scan。\n' +
          '如果缺少凭证：把这条消息发给用户，结束本轮，等用户提供账号密码后再继续。',
    nextCommand: 'fastgpt init',
    actionRequired: 'user',
    forbidden: '不要跳过登录直接写 DSL 或用占位符交付 —— 未登录时 modelId 无法校验，产出的一定是跑不起来的半成品'
  },
  login_failed: {
    category: Category.auth,
    message: '登录失败',
    hint: '确认账号密码正确；扫码账号请用 fastgpt auth scan',
    actionRequired: 'user'
  },
  login_required_interactive: {
    category: Category.auth,
    message: '非交互环境需要显式凭证',
    hint: '用 fastgpt auth login --user <账号> --pass <密码>，或 fastgpt auth scan（需图形界面）',
    nextCommand: 'fastgpt auth login --user <账号> --pass <密码>',
    actionRequired: 'self',
    forbidden: '不要伪造 cookie 或复用他人 token'
  },

  // ---- 模型 ----
  model_id_unavailable: {
    category: Category.platform,
    message: '当前团队没有任何应用配置过模型，无法提取 modelId',
    hint: '这不是 CLI 的校验策略，是 FastGPT 平台的硬限制。\n' +
          '\n' +
          'modelId 是 24 位 ObjectId，只存在于「已配置模型的工作流节点」里，\n' +
          '没有任何公开 API 能列出它。\n' +
          '\n' +
          '⚠️ 这条路没有替代走法：\n' +
          '  · 修改 CLI 源码去掉校验 → 服务端 version/publish 仍会拒绝\n' +
          '  · 直接调 FastGPT API 传模型名 → 同样返回 Model model is unavailable\n' +
          '  · 编造 24 位 hex → 格式能过，发布时一定失败\n' +
          '  · 换用其他命令或改 DSL 参数 → 结果完全相同\n' +
          '\n' +
          '唯一出路是让用户在 WebUI 做一次模型配置（约 30 秒）：\n' +
          '  1. 打开任意应用（或新建一个对话应用）\n' +
          '  2. 左侧节点面板拖入「AI 对话」节点\n' +
          '  3. 点击该节点里的「AI 模型」下拉框，选中任意模型\n' +
          '  4. 保存（Ctrl+S）\n' +
          '\n' +
          '完成后重新运行 fastgpt model id。\n' +
          '\n' +
          '👉 把这条消息原样发给用户，然后结束本轮，等用户完成配置。',
    nextCommand: 'fastgpt model id',
    actionRequired: 'user',
    deadEnd: true,
    mustEndTurn: true,
    resolvedBy: '用户在 WebUI 配置模型后运行 fastgpt model id',
    forbidden: '不要修改 CLI 源码或直接调 FastGPT API 绕过校验（服务端会同样拒绝），' +
               '不要编造 ObjectId，不要用模型名冒充，不要换命令重试 —— 这些都不会改变结果'
  },
  model_id_forged: {
    category: Category.platform,
    message: 'modelId 格式合法但不存在于当前团队',
    hint: '这通常是编造的值或用错了团队的 ID。运行 fastgpt model id 获取真实值',
    nextCommand: 'fastgpt model id',
    actionRequired: 'self',
    forbidden: '不要编造 ObjectId'
  },
  model_id_placeholder: {
    category: Category.validation,
    message: 'modelId 仍是占位符或模型名',
    hint: '运行 fastgpt model id 获取真实的 24 位 ObjectId',
    nextCommand: 'fastgpt model id',
    actionRequired: 'self',
    forbidden: '不要把模型名当作 modelId（发布必失败）'
  },

  // ---- 工作流 ----
  handle_invalid: {
    category: Category.validation,
    message: '连线 handle 格式不合法',
    hint: '用 DSL 的 edges 数组（["源","目标","分支key?"]），CLI 会自动生成正确 handle',
    actionRequired: 'self',
    forbidden: '不要手写 sourceHandle / targetHandle'
  },
  branch_key_unknown: {
    category: Category.validation,
    message: '分支 key 不在上游 classify 节点的 branches 里',
    hint: '检查 DSL 中 edges 的第三个元素是否与 classify 节点的 branches[].key 一致',
    actionRequired: 'self'
  },
  reference_missing: {
    category: Category.validation,
    message: '引用指向不存在的节点或输出',
    hint: '检查 "节点id:输出id" 的写法；用 fastgpt wf get <appId> 查看已有节点的输出 id',
    actionRequired: 'self'
  },
  workflow_validate_failed: {
    category: Category.validation,
    message: '工作流校验未通过',
    hint: '根据 errors 字段逐项修正 DSL 后重试；不要绕过校验直接写库',
    actionRequired: 'self',
    forbidden: '不要用 --no-model-hook 等方式绕过校验来「让命令通过」'
  },

  // ---- 资源 ----
  app_not_published: {
    category: Category.platform,
    message: '应用还没有发布版本，对话接口无法调用',
    hint: '工作流部署后必须先发布一次，否则 /api/v1/chat/completions 会一直等到超时。\n' +
          '\n' +
          '运行：fastgpt wf publish <appId>\n' +
          '\n' +
          '或者在 DSL 里去掉 "publish": false 重新 wf build（默认就是发布）。',
    nextCommand: 'fastgpt wf publish <appId>',
    actionRequired: 'self'
  },
  app_not_found: {
    category: Category.resource,
    message: '应用不存在',
    hint: '运行 fastgpt app list 确认 appId',
    nextCommand: 'fastgpt app list',
    actionRequired: 'self'
  },
  dataset_not_found: {
    category: Category.resource,
    message: '知识库不存在',
    hint: '运行 fastgpt ds list 确认 datasetId',
    nextCommand: 'fastgpt ds list',
    actionRequired: 'self'
  },
  collection_not_found: {
    category: Category.resource,
    message: '文档不存在',
    hint: '运行 fastgpt ds collections <datasetId> 确认 collectionId',
    actionRequired: 'self'
  },

  // ---- 平台限制 ----
  collection_permission_disabled: {
    category: Category.platform,
    message: '该实例未开启文档级权限',
    hint: '运行 fastgpt ds perm <datasetId> on 开启后再试',
    nextCommand: 'fastgpt ds perm <datasetId> on',
    actionRequired: 'self'
  },
  training_incomplete: {
    category: Category.platform,
    message: '知识库训练未完成，检索会返回空',
    hint: '轮询 fastgpt ds training <collectionId> 直到 done=true；注意 index 队列可能比 chunk 更晚归零',
    nextCommand: 'fastgpt ds training <collectionId>',
    actionRequired: 'self',
    forbidden: '不要在训练未完成时下结论说「检索功能坏了」'
  },

  // ---- 扫码会话 ----
  scan_session_expired: {
    category: Category.auth,
    message: '扫码会话已失效（浏览器已关闭）',
    hint: '重新运行 fastgpt auth scan --no-wait 打开新的扫码窗口，把 URL 交给用户后结束本轮',
    nextCommand: 'fastgpt auth scan --no-wait',
    actionRequired: 'self',
    forbidden: '不要复用旧的 session-id'
  },
  scan_timeout: {
    category: Category.auth,
    message: '扫码等待超时',
    hint: '浏览器仍开着，可再次运行 fastgpt auth scan --wait --session-id <id>；或让用户重新扫码',
    actionRequired: 'user'
  },
  scan_session_missing: {
    category: Category.auth,
    message: '未找到该扫码会话',
    hint: 'session-id 可能写错或已过期。运行 fastgpt auth scan --no-wait 重新开始',
    nextCommand: 'fastgpt auth scan --no-wait',
    actionRequired: 'self'
  },

  // ---- 网络 ----
  network_error: {
    category: Category.network,
    message: '请求失败',
    hint: '检查服务地址是否可达、网络是否正常；私有部署确认防火墙放行',
    actionRequired: 'self'
  },
  base_looks_like_website: {
    category: Category.config,
    message: '这个地址看起来是 FastGPT 官网，不是 SaaS 服务端',
    hint: '常见混淆：\n' +
          '  · fastgpt.cn        → 官网/文档，不是服务端\n' +
          '  · fastgpt.io        → 官网，不是服务端\n' +
          '\n' +
          'SaaS 服务端地址是：\n' +
          '  · 国内  https://cloud.fastgpt.cn   (preset: cn)\n' +
          '  · 海外  https://cloud.fastgpt.io   (preset: global)\n' +
          '  · 自建  http://localhost:3000      (preset: local)\n' +
          '\n' +
          '用预设更省事：fastgpt init --preset cn',
    nextCommand: 'fastgpt init --preset cn',
    actionRequired: 'self'
  },
  base_unreachable: {
    category: Category.network,
    message: '服务地址不可达',
    hint: '确认 FASTGPT_BASE 正确且服务在运行',
    nextCommand: 'fastgpt doctor',
    actionRequired: 'self'
  },

  // ---- 用法 ----
  bad_usage: {
    category: Category.usage,
    message: '命令用法错误',
    hint: '运行 fastgpt help 查看用法',
    nextCommand: 'fastgpt help',
    actionRequired: 'self'
  },
  unknown_node_type: {
    category: Category.usage,
    message: 'DSL 中出现未知节点类型',
    hint: '用内置类型（start/chat/classify/datasetSearch/answer/readFiles/contentExtract/ifElse/textConcat/http/code），或用 "type":"raw" 传完整节点 JSON',
    actionRequired: 'self'
  },
  file_not_found: {
    category: Category.usage,
    message: '文件不存在',
    hint: '检查路径是否正确',
    actionRequired: 'self'
  }
};

/**
 * 构造错误。subtype 必须在注册表中，否则退化为 bad_usage。
 * @param {string} subtype
 * @param {object} overrides 覆盖默认字段，或附加 details
 */
export function cliError(subtype, overrides = {}) {
  const base = REGISTRY[subtype];
  if (!base) {
    return new CliError({
      category: Category.usage,
      subtype: 'unregistered_error',
      message: overrides.message || `未注册的错误类型: ${subtype}`,
      hint: overrides.hint || '这可能是 CLI 的 bug，请上报',
      actionRequired: 'none',
      ...overrides
    });
  }
  return new CliError({ ...base, subtype, ...overrides });
}

export const isCliError = e => e instanceof CliError;


/**
 * 成功响应的附加提示（对应 lark-cli 的 _notice）。
 * 用于「操作成功了，但下一步容易踩坑」的场景。
 */
export const Notice = {
  /** dry-run 已校验真实性，但还没写库 */
  dryRunOnly: () => ({
    type: 'dry_run_verified',
    message: '结构合法且 modelId / datasetId 已对当前团队验证通过，但尚未写入',
    hint: '下一步：去掉 --dry-run 真实部署，然后 fastgpt chat run 验证能跑通',
    forbidden: '不要把 dry-run 通过当作已完成交付 —— 应用还没创建'
  }),
  /** 训练是异步的 */
  trainingAsync: (collectionId) => ({
    type: 'training_async',
    message: '文档已提交，训练在后台异步执行，此时检索会返回空',
    hint: `轮询 fastgpt ds training ${collectionId} 直到 done=true（注意 index 队列可能比 chunk 晚归零）`
  }),
  /** 检索为空 */
  emptySearch: (datasetId) => ({
    type: 'empty_result',
    message: '检索结果为空，可能是训练未完成，不一定是配置错误',
    hint: `先运行 fastgpt ds collections ${datasetId} 拿到 collectionId，再 fastgpt ds training <collectionId> 看是否 done`
  }),
  /** 应用刚创建，还没有节点 */
  appCreated: (appId) => ({
    type: 'app_created',
    message: '应用已创建，但节点为空，此时无法对话',
    hint: '下一步：写 DSL 后运行 fastgpt wf build <file>，会校验并部署',
    nextCommand: `fastgpt wf get ${appId}`
  }),
  /** 回答为空 */
  emptyAnswer: (appId) => ({
    type: 'empty_answer',
    message: '本次对话没有产生回答，常见原因：应用未发布 / 节点未配置模型',
    hint: `先运行 fastgpt wf publish ${appId} 发布，再用 fastgpt doctor 检查模型是否就绪`
  }),
  /** 知识库级权限被禁用 */
  collectionPermOff: (datasetId) => ({
    type: 'collection_permission_disabled',
    message: '该实例没有开启文档级权限',
    hint: `运行 fastgpt ds perm ${datasetId} on 开启后重试`
  }),
  /** plugin 应用刚发布，提示变量引用格式 */
  pluginPublished: (appId) => ({
    type: 'plugin_published',
    message: '工作流工具已发布',
    hint: `变量引用必须用 {{$<实际nodeId>.<outputId>$}}，不是 {{$pluginInput.xxx$}}。` +
          `可以用 nodes.mjs 的 VARP(nodeId, outputId) 生成。` +
          `挂到 AI 应用时用 pluginModule 节点 + selectedTools 连线`,
    nextCommand: `fastgpt wf get ${appId}`
  }),
  /** 存成草稿了，对话接口用不了 */
  notPublished: (appId) => ({
    type: 'not_published',
    message: '工作流已存为草稿，未发布 —— 此时 chat run 会一直等到超时',
    hint: `运行 fastgpt wf publish ${appId} 发布，或去掉 DSL 里的 "publish": false 重新 wf build（默认就是发布）`,
    nextCommand: `fastgpt wf publish ${appId}`
  }),
  /** 配额偏低 */
  lowQuota: (surplus) => ({
    type: 'low_quota',
    message: `剩余积分偏低：${surplus}`,
    hint: '工作流跑一轮会消耗积分，建议确认团队配额或改用更便宜的模型'
  })
};

/** 把 notice 附到成功响应上 */
export function withNotice(payload, notices) {
  const list = (Array.isArray(notices) ? notices : [notices]).filter(Boolean);
  if (!list.length) return payload;
  return { ...payload, _notice: list.length === 1 ? list[0] : list };
}
