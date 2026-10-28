// 节点构造器：把踩过的坑固化成 API，调用方不可能写错
//
// 关键规则（来自实测）：
//   1. base64 input 的 value 是引用数组 [nodeId, outputId] 时，selectedType 必须是 'reference'
//   2. modelId 是 24 位 ObjectId，不是模型名
//   3. classifyQuestion 的分支桩由 inputs.agents 动态生成，不要手动塞进 outputs

export const REF = (nodeId, outputId) => [nodeId, outputId];

/**
 * 生成 HTTP body / URL 里的变量插值字符串。
 *
 * 坑：必须用节点的**实际 nodeId**，不能用 {{$pluginInput.xxx$}} 这种别名。
 * 例：pluginInput 节点 id 是 n_input → VARP('n_input','datasetName') → "{{$n_input.datasetName$}}"
 */
export const VARP = (nodeId, outputId) => `{{\$${nodeId}.${outputId}\$}}`;

function isRef(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';
}

/**
 * 构造输入项。自动推断 selectedType，杜绝"引用了但 UI 不渲染"的问题。
 */
export function input({ key, label = '', valueType = 'string', renderTypeList, value, required = false, ...rest }) {
  const rt = renderTypeList || ['textarea', 'reference'];
  let selectedType;
  if (isRef(value)) {
    if (!rt.includes('reference')) rt.push('reference');
    selectedType = 'reference';
  } else {
    selectedType = rest.selectedType || rt[0];
  }
  return { key, label, valueType, required, selectedType, renderTypeList: rt, value, ...rest };
}

const pos = (x, y = 0) => ({ x, y });

// ---------- 节点模板 ----------

export const node = {
  /** 流程开始。withFiles=true 时额外输出 userFiles（需配合 chatConfig.fileSelectConfig） */
  start(id, { x = 0, y = 0, name = '流程开始', withFiles = false } = {}) {
    const outputs = [
      { id: 'userChatInput', key: 'userChatInput', label: '用户问题', type: 'static', valueType: 'string' }
    ];
    if (withFiles) {
      outputs.push({ id: 'userFiles', key: 'userFiles', label: '用户上传文件', type: 'static', valueType: 'arrayString' });
    }
    return {
      nodeId: id, flowNodeType: 'workflowStart', name,
      avatar: 'core/workflow/template/workflowStart', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: false,
      forbidDelete: true, unique: true,
      templateType: 'systemInput', colorSchema: 'blue',
      inputs: [input({ key: 'userChatInput', label: '用户问题', renderTypeList: ['reference', 'textarea'], value: '', required: true })],
      outputs
    };
  },

  /** 文件解析：把上传的文件读成文本 */
  readFiles(id, { files, name = '文件解析', x = 0, y = 0 }) {
    if (!files) throw new Error('readFiles 需要 files 引用，如 "n_start:userFiles"');
    return {
      nodeId: id, flowNodeType: 'readFiles', name,
      avatar: 'core/workflow/template/readFiles', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'tools', colorSchema: 'green',
      inputs: [
        input({
          key: 'fileUrlList', label: '文件链接', valueType: 'arrayString',
          renderTypeList: ['reference'], value: files, required: true
        })
      ],
      outputs: [
        { id: 'system_text', key: 'system_text', label: '文件内容', type: 'static', valueType: 'string' },
        { id: 'system_rawResponse', key: 'system_rawResponse', label: '原始返回', type: 'static', valueType: 'arrayObject' },
        { id: 'system_error', key: 'system_error', label: '错误信息', type: 'static', valueType: 'string' }
      ]
    };
  },

  /**
   * Agent 节点：自主决策调用挂载的工具。
   * tools 直接传 agent_selectedTools 数组（从已有应用抄或按格式构造）。
   */
  agent(id, { modelId, prompt = '', question, tools = [], history = 6, name = 'Agent', x = 0, y = 0 }) {
    const inputs = [
      input({ key: 'modelId', label: 'AI 模型', valueType: 'string', renderTypeList: ['selectLLMModel', 'reference'], value: modelId, required: true }),
      input({ key: 'systemPrompt', label: '提示词', renderTypeList: ['textarea', 'reference'], value: prompt }),
      input({ key: 'userChatInput', label: '用户问题', renderTypeList: ['reference', 'textarea'], value: question, required: true }),
      input({ key: 'history', label: '聊天记录', valueType: 'chatHistory', renderTypeList: ['numberInput', 'reference'], value: history }),
      {
        key: 'agent_selectedTools', label: '工具', valueType: 'arrayObject',
        renderTypeList: ['hidden'], selectedType: 'hidden',
        value: tools
      },
      {
        key: 'agent_datasetParams', label: '', valueType: 'object',
        renderTypeList: ['hidden'], selectedType: 'hidden',
        value: {
          searchMode: 'embedding', limit: 3000, similarity: 0.4,
          usingReRank: false, rerankModel: '', rerankWeight: 0.5,
          datasetSearchUsingExtensionQuery: false, datasetSearchExtensionBg: '',
          autoSendDatasetQuote: false
        }
      },
      input({ key: 'aiChatVision', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: true }),
      input({ key: 'aiChatExtractFiles', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: true }),
      input({ key: 'useAgentSandbox', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: false })
    ];
    return {
      nodeId: id, flowNodeType: 'agent', name,
      avatar: 'core/workflow/template/agent', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'ai', colorSchema: 'blueDark',
      inputs,
      outputs: [
        { id: 'answerText', key: 'answerText', label: 'AI 回复内容', type: 'static', valueType: 'string' },
        { id: 'system_error_text', key: 'system_error_text', label: '错误信息', type: 'error', valueType: 'string' }
      ]
    };
  },

  /** 内容提取：按字段定义从文本中抽取结构化数据 */
  contentExtract(id, { modelId, description = '', text, keys = [], name = '内容提取', x = 0, y = 0 }) {
    if (!text) throw new Error('contentExtract 需要 text 引用');
    if (!keys.length) throw new Error('contentExtract 至少需要一个提取字段');
    return {
      nodeId: id, flowNodeType: 'contentExtract', name,
      avatar: 'core/workflow/template/extractJson', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'ai', colorSchema: 'teal',
      inputs: [
        input({ key: 'modelId', label: 'AI 模型', valueType: 'string', renderTypeList: ['selectLLMModel', 'reference'], value: modelId, required: true }),
        input({ key: 'description', label: '提取要求', renderTypeList: ['textarea', 'reference'], value: description }),
        input({ key: 'history', label: '聊天记录', valueType: 'chatHistory', renderTypeList: ['numberInput', 'reference'], value: 6 }),
        input({ key: 'content', label: '待提取文本', valueType: 'string', renderTypeList: ['reference', 'textarea'], value: text, required: true }),
        {
          key: 'extractKeys', label: '', valueType: 'any', selectedType: 'custom',
          renderTypeList: ['custom'],
          value: keys.map(k => {
            const item = {
              key: k.key,
              desc: k.desc || k.key,
              required: k.required !== false,
              valueType: k.valueType || 'string'
            };
            // enum 必须是逗号分隔字符串，传数组会报 e.enum.split is not a function
            if (k.enum) item.enum = Array.isArray(k.enum) ? k.enum.join(',') : String(k.enum);
            return item;
          })
        }
      ],
      outputs: [
        { id: 'success', key: 'success', label: '是否提取完整', type: 'static', valueType: 'boolean', required: true },
        { id: 'fields', key: 'fields', label: '提取结果', type: 'static', valueType: 'string', required: true }
      ]
    };
  },

  /** AI 对话。quoteQA 不传即为普通对话 */
  chat(id, { modelId, prompt = '', question, quoteQA, history = 6, name = 'AI 回复', x = 0, y = 0, responseText }) {
    const inputs = [
      input({ key: 'modelId', label: 'AI 模型', valueType: 'string', renderTypeList: ['selectLLMModel', 'reference'], value: modelId, required: true }),
      input({ key: 'systemPrompt', label: '提示词', renderTypeList: ['textarea', 'reference'], value: prompt }),
      input({ key: 'history', label: '聊天记录', valueType: 'chatHistory', renderTypeList: ['numberInput', 'reference'], value: history })
    ];
    if (question) inputs.push(input({ key: 'userChatInput', label: '用户问题', renderTypeList: ['reference', 'textarea'], value: question, required: true }));
    if (quoteQA !== undefined) inputs.push(input({ key: 'quoteQA', label: '知识库引用', valueType: 'datasetQuote', renderTypeList: ['reference'], value: quoteQA }));
    // 注意：不要给 temperature / maxToken 传空字符串。
    // 后端会把 '' 转成 1，导致输出被截断（finishReason: "length"）。
    inputs.push(
      // 由 wf build 的 autoTuneNodeParams 按链路决定：
      //   输出被 answerNode 消费 → false（否则重复回复）
      //   无 answerNode 消费 → true
      input({ key: 'isResponseAnswerText', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: responseText })
    );
    return {
      nodeId: id, flowNodeType: 'chatNode', name,
      avatar: 'core/workflow/template/aiChat', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'ai', colorSchema: 'blueDark',
      inputs,
      outputs: [{ id: 'answerText', key: 'answerText', label: 'AI 回复内容', type: 'static', valueType: 'string', required: true }]
    };
  },

  /**
   * 意图识别。branches: [{key, label}]，key 会直接用于连线的 sourceHandle
   * 分支桩由 agents 动态渲染，outputs 只保留 cqResult
   */
  classify(id, { modelId, prompt = '', question, branches = [], name = '意图识别', x = 0, y = 0 }) {
    if (!branches.length) throw new Error('classify 至少需要一个分支');
    const keys = branches.map(b => b.key);
    if (new Set(keys).size !== keys.length) throw new Error('分支 key 不能重复');
    return {
      nodeId: id, flowNodeType: 'classifyQuestion', name,
      avatar: 'core/workflow/template/questionClassify', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'ai', colorSchema: 'purple',
      inputs: [
        input({ key: 'modelId', label: 'AI 模型', valueType: 'string', renderTypeList: ['selectLLMModel', 'reference'], value: modelId, required: true }),
        input({ key: 'systemPrompt', label: '背景知识', renderTypeList: ['textarea', 'reference'], value: prompt }),
        input({ key: 'history', label: '聊天记录', valueType: 'chatHistory', renderTypeList: ['numberInput', 'reference'], value: 6 }),
        input({ key: 'userChatInput', label: '用户问题', renderTypeList: ['reference', 'textarea'], value: question, required: true }),
        {
          key: 'agents', label: '', valueType: 'any', selectedType: 'custom',
          renderTypeList: ['custom'],
          value: branches.map(b => ({ value: b.label, key: b.key }))
        }
      ],
      outputs: [{ id: 'cqResult', key: 'cqResult', label: '分类结果', type: 'static', valueType: 'string', required: true }]
    };
  },

  /** 知识库搜索。datasets: [{datasetId, name, avatar?}] */
  datasetSearch(id, { datasets = [], question, similarity = 0.4, limit = 3000, name = '知识库搜索', x = 0, y = 0 }) {
    if (!datasets.length) throw new Error('datasetSearch 需要至少一个知识库');
    return {
      nodeId: id, flowNodeType: 'datasetSearchNode', name,
      avatar: 'core/workflow/template/datasetSearch', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'ai', colorSchema: 'blueLight',
      inputs: [
        input({
          key: 'datasets', label: '选择知识库', valueType: 'selectDataset',
          renderTypeList: ['selectDataset', 'reference'],
          value: datasets.map(d => ({ datasetId: d.datasetId, name: d.name, avatar: d.avatar || 'core/dataset/commonDatasetColor' })),
          required: true
        }),
        input({ key: 'similarity', label: '', valueType: 'number', renderTypeList: ['selectDatasetParamsModal'], value: similarity }),
        input({ key: 'limit', label: '', valueType: 'number', renderTypeList: ['hidden'], value: limit }),
        input({ key: 'searchMode', label: '', valueType: 'string', renderTypeList: ['hidden'], value: 'embedding' }),
        input({ key: 'embeddingWeight', label: '', valueType: 'number', renderTypeList: ['hidden'], value: 0.5 }),
        input({ key: 'usingReRank', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: false }),
        input({ key: 'userChatInput', label: '用户问题', renderTypeList: ['reference', 'textarea'], value: question, required: true })
      ],
      outputs: [{ id: 'quoteQA', key: 'quoteQA', label: '知识库引用', type: 'static', valueType: 'datasetQuote' }]
    };
  },

  /** 指定回复。content 支持引用数组或纯文本 */
  answer(id, { content, name = '指定回复', x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'answerNode', name,
      avatar: 'core/workflow/template/reply', position: pos(x, y),
      showSourceHandle: false, showTargetHandle: true,
      templateType: 'tools', colorSchema: 'blue',
      inputs: [input({ key: 'text', label: '回复内容', valueType: 'any', renderTypeList: ['textarea', 'reference'], value: content, required: true })],
      outputs: []
    };
  },

  /** 条件判断 */
  ifElse(id, { conditions = [], name = '条件判断', x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'ifElseNode', name,
      avatar: 'core/workflow/template/ifElse', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true,
      templateType: 'tools', colorSchema: 'blue',
      inputs: [
        input({ key: 'ifElseList', label: '', valueType: 'any', renderTypeList: ['custom'], value: conditions })
      ],
      outputs: [{ id: 'ifElseResult', key: 'ifElseResult', label: '判断结果', type: 'static', valueType: 'boolean' }]
    };
  },

  /** 文本拼接 */
  textConcat(id, { texts = [], name = '文本拼接', x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'textEditor', name,
      avatar: 'core/workflow/template/textConcat', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true,
      templateType: 'tools', colorSchema: 'blue',
      inputs: [input({ key: 'text', label: '文本', valueType: 'any', renderTypeList: ['textarea', 'reference'], value: texts })],
      outputs: [{ id: 'system_text', key: 'system_text', label: '拼接结果', type: 'static', valueType: 'string' }]
    };
  },

  /**
   * HTTP 请求节点。
   *
   * 坑1：请求头字段名是 system_httpHeader（单数），写成 system_httpHeaders 会被静默丢弃。
   * 坑2：除 headers 外，其余参数用 hidden + hidden 模式，否则运行时解析异常。
   * 坑3：body 里的变量引用必须写 {{$<实际nodeId>.<outputId>$}}，不能用 {{$pluginInput.xxx$}}。
   */
  http(id, {
    url = '', method = 'GET', headers = [], params = [], jsonBody, formBody = [],
    contentType = 'json', timeout = 30000, name = 'HTTP 请求', x = 0, y = 0
  }) {
    return {
      nodeId: id, flowNodeType: 'httpRequest468', name,
      avatar: 'core/workflow/template/httpRequest', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'tools', colorSchema: 'green',
      inputs: [
        { key:'system_addInputParam', label:'', valueType:'any', renderTypeList:['addInputParam'], selectedType:'addInputParam', value:[] },
        { key:'system_httpMethod', label:'请求方法', valueType:'string', renderTypeList:['hidden'], selectedType:'hidden', value:method },
        { key:'system_httpTimeout', label:'超时', valueType:'number', renderTypeList:['hidden'], selectedType:'hidden', value:timeout },
        { key:'system_httpReqUrl', label:'请求地址', valueType:'string', renderTypeList:['hidden'], selectedType:'hidden', value:url },
        { key:'system_header_secret', label:'鉴权', valueType:'object', renderTypeList:['hidden'], selectedType:'hidden', value:{} },
        { key:'system_httpHeader', label:'请求头', valueType:'any', renderTypeList:['custom'], selectedType:'custom', value:headers },
        { key:'system_httpParams', label:'查询参数', valueType:'any', renderTypeList:['hidden'], selectedType:'hidden', value:params },
        { key:'system_httpJsonBody', label:'JSON 请求体', valueType:'any', renderTypeList:['hidden'], selectedType:'hidden', value:jsonBody },
        { key:'system_httpFormBody', label:'表单', valueType:'any', renderTypeList:['hidden'], selectedType:'hidden', value:formBody },
        { key:'system_httpContentType', label:'内容类型', valueType:'string', renderTypeList:['hidden'], selectedType:'hidden', value:contentType }
      ],
      outputs: [
        { id: 'httpRawResponse', key: 'httpRawResponse', label: 'HTTP 返回', type: 'static', valueType: 'object' },
        { id: 'system_error_text', key: 'system_error_text', label: '错误', type: 'error', valueType: 'string' }
      ]
    };
  },

  /**
   * 工作流工具（plugin）的内部节点：pluginInput → ... → pluginOutput。
   * 返回 { input, output } 两个节点，中间流程自己拼。
   */
  pluginInput(id, { params = [], name = '输入', x = 0, y = 0 } = {}) {
    return {
      nodeId: id, flowNodeType: 'pluginInput', name,
      avatar: 'core/workflow/template/pluginInput', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: false, isTool: true,
      inputs: params.map(p => ({
        key: p.key, label: p.label || p.key,
        valueType: p.valueType || 'string',
        required: !!p.required,
        renderTypeList: ['input'], selectedType: 'input',
        ...(p.value !== undefined ? { value: p.value } : {})
      })),
      outputs: params.map(p => ({
        id: p.key, key: p.key, label: p.label || p.key,
        type: 'static', valueType: p.valueType || 'string'
      }))
    };
  },

  pluginOutput(id, { from, name = '输出', x = 0, y = 0 } = {}) {
    if (!from) throw new Error('pluginOutput 需要 from 引用，如 ["n_http","httpRawResponse"]');
    return {
      nodeId: id, flowNodeType: 'pluginOutput', name,
      avatar: 'core/workflow/template/pluginOutput', position: pos(x, y),
      showSourceHandle: false, showTargetHandle: true, isTool: true,
      inputs: [{ key: 'result', label: '结果', valueType: 'object',
                 renderTypeList: ['reference'], selectedType: 'reference',
                 value: from, required: true }],
      outputs: []
    };
  },

  /**
   * pluginModule 节点：把已有 plugin 应用挂成工具。
   *
   * 坑：必须用 pluginModule（不是 tool），且参数要 agentGenerated 模式，
   *     否则 agent 传参永远是空字符串。
   * 用 edges 从 tools 节点的 selectedTools handle 连过来。
   */
  pluginModule(id, { appId, params = [], version = '', name, intro = '', avatar = 'core/app/type/pluginFill', x = 0, y = 0 }) {
    if (!appId) throw new Error('pluginModule 需要 appId（plugin 应用 ID）');
    return {
      nodeId: id, flowNodeType: 'pluginModule',
      name: name || '工具', intro,
      avatar, showStatus: true,
      version, isLatestVersion: true, catchError: false,
      pluginId: appId,
      currentCost: 0, hasTokenFee: false,
      inputs: [
        { key:'system_forbid_stream', label:'', valueType:'boolean', renderTypeList:['hidden'], selectedType:'hidden', value:true },
        ...params.map(p => ({
          key: p.key, label: p.label || p.key,
          valueType: p.valueType || 'string',
          value: p.value !== undefined ? p.value : '',
          renderTypeList: ['agentGenerated', 'input', 'reference'],
          selectedType: 'agentGenerated',
          defaultToAgentGenerated: true,
          toolDescription: p.label || p.key,
          customJsonSchema: {
            type: 'string',
            title: p.label || p.key,
            description: p.label || p.key,
            toolDescription: p.label || p.key,
            isToolParam: true
          }
        }))
      ],
      outputs: (params.length ? params.map(p => ({
        id: p.key, key: p.key, label: p.label || p.key, type: 'static', valueType: p.valueType || 'string'
      })) : [{ id: 'result', key: 'result', label: '结果', type: 'static', valueType: 'object' }]),
      pluginData: { name: name || '工具', avatar },
      position: pos(x, y)
    };
  },

  /**
   * 工具调用节点（agent v2 的 tools 节点）。
   * tools 通过 edges 用 selectedTools handle 连到 pluginModule / toolSet 节点。
   */
  toolCall(id, { modelId, prompt = '', question, history = 6, name = '工具调用', x = 0, y = 0, responseText = false }) {
    return {
      nodeId: id, flowNodeType: 'tools', name,
      avatar: 'core/workflow/template/toolCall', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      version: '4.9.2', catchError: false,
      inputs: [
        { key:'modelId', label:'AI 模型', valueType:'string', renderTypeList:['selectLLMModel','reference'], selectedType:'selectLLMModel', value:modelId, required:true },
        { key:'temperature', label:'', valueType:'number', renderTypeList:['hidden'], selectedType:'hidden' },
        { key:'maxToken', label:'', valueType:'number', renderTypeList:['hidden'], selectedType:'hidden' },
        { key:'isResponseAnswerText', label:'', valueType:'boolean', renderTypeList:['hidden'], selectedType:'hidden', value:responseText },
        { key:'systemPrompt', label:'提示词', valueType:'string', renderTypeList:['textarea','reference'], selectedType:'textarea', value:prompt },
        { key:'history', label:'聊天记录', valueType:'chatHistory', renderTypeList:['numberInput','reference'], selectedType:'numberInput', value:history },
        { key:'userChatInput', label:'用户问题', valueType:'string', renderTypeList:['reference','textarea'], selectedType:'reference', value:question, required:true }
      ],
      outputs: [
        { id:'answerText', key:'answerText', label:'AI 回复内容', type:'static', valueType:'string' },
        { id:'system_error_text', key:'system_error_text', label:'错误', type:'error', valueType:'string' }
      ]
    };
  },


  /**
   * 兜底：DSL 未覆盖的节点类型，直接传完整节点 JSON。
   * 仍然会走 CLI 的校验和保存，不会绕过安全网。
   * 用法: { "type": "raw", "id": "n_x", "node": { ...完整节点... } }
   */
  raw(id, { node: rawNode } = {}) {
    if (!rawNode || typeof rawNode !== 'object') throw new Error('raw 节点需要 node 字段（完整节点 JSON）');
    const n = { ...rawNode, nodeId: id || rawNode.nodeId };
    if (!n.nodeId) throw new Error('raw 节点缺少 nodeId');
    if (!n.flowNodeType) throw new Error('raw 节点缺少 flowNodeType');
    if (!Array.isArray(n.inputs)) n.inputs = [];
    if (!Array.isArray(n.outputs)) n.outputs = [];
    if (!n.position) n.position = { x: 0, y: 0 };
    // 补齐常见的引用输入陷阱
    for (const inp of n.inputs) {
      const isRef = Array.isArray(inp.value) && inp.value.length === 2 && typeof inp.value[0] === 'string';
      if (isRef && inp.selectedType !== 'reference') inp.selectedType = 'reference';
    }
    return n;
  },

  /**
   * 代码执行（sandbox）
   *
   * inputs  : 动态输入（只支持引用），元素形如 { key, label, value: ['nodeId','outputId'], valueType? }
   *           工具（plugin）里几乎必用：code 节点靠这些引用拿到上游 http 的返回
   * outputs : 默认声明 system_rawResponse / system_error_text。
   *           必需——否则 pluginOutput 没法引用 code 的结果（ref_output 报错）
   */
  code(id, { code = '', language = 'js', name = '代码运行', inputs: dynInputs = [], outputs, x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'code', name,
      avatar: 'core/workflow/template/codeRun', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'tools', colorSchema: 'blue',
      inputs: [
        { key: 'system_addInputParam', label: '', valueType: 'any', renderTypeList: ['addInputParam'], selectedType: 'addInputParam', value: [] },
        input({ key: 'codeType', label: '语言', valueType: 'string', renderTypeList: ['select'], value: language }),
        input({ key: 'code', label: '代码', valueType: 'string', renderTypeList: ['custom'], value: code }),
        ...dynInputs.map(d => ({
          key: d.key,
          label: d.label || d.key,
          valueType: d.valueType || 'string',
          required: d.required !== false,
          canEdit: true,
          renderTypeList: ['reference'],
          selectedType: 'reference',
          value: d.value
        }))
      ],
      outputs: outputs || [
        { id: 'system_rawResponse', key: 'system_rawResponse', label: '完整响应', type: 'static', valueType: 'object' },
        { id: 'system_error_text', key: 'system_error_text', label: '错误', type: 'error', valueType: 'string' }
      ]
    };
  }
};
