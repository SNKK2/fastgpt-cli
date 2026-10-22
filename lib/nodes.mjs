// 节点构造器：把踩过的坑固化成 API，调用方不可能写错
//
// 关键规则（来自实测）：
//   1. base64 input 的 value 是引用数组 [nodeId, outputId] 时，selectedType 必须是 'reference'
//   2. modelId 是 24 位 ObjectId，不是模型名
//   3. classifyQuestion 的分支桩由 inputs.agents 动态生成，不要手动塞进 outputs

export const REF = (nodeId, outputId) => [nodeId, outputId];

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
  chat(id, { modelId, prompt = '', question, quoteQA, history = 6, name = 'AI 回复', x = 0, y = 0 }) {
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
      input({ key: 'isResponseAnswerText', label: '', valueType: 'boolean', renderTypeList: ['hidden'], value: true })
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

  /** HTTP 请求 */
  http(id, { url = '', method = 'GET', headers = [], params = [], name = 'HTTP 请求', x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'httpRequest468', name,
      avatar: 'core/workflow/template/httpRequest', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'tools', colorSchema: 'green',
      inputs: [
        input({ key: 'system_httpReqUrl', label: '请求地址', valueType: 'string', renderTypeList: ['input', 'reference'], value: url, required: true }),
        input({ key: 'system_httpMethod', label: '请求方法', valueType: 'string', renderTypeList: ['select'], value: method }),
        input({ key: 'system_httpHeader', label: '请求头', valueType: 'any', renderTypeList: ['custom'], value: headers }),
        input({ key: 'system_httpParams', label: '查询参数', valueType: 'any', renderTypeList: ['custom'], value: params }),
        input({ key: 'system_httpContentType', label: '内容类型', valueType: 'string', renderTypeList: ['select'], value: 'json' }),
        input({ key: 'system_httpTimeout', label: '超时', valueType: 'number', renderTypeList: ['numberInput'], value: 30000 })
      ],
      outputs: [{ id: 'httpRawResponse', key: 'httpRawResponse', label: 'HTTP 返回', type: 'static', valueType: 'object' }]
    };
  },

  /** 代码执行（sandbox） */
  code(id, { code = '', language = 'js', name = '代码运行', x = 0, y = 0 }) {
    return {
      nodeId: id, flowNodeType: 'code', name,
      avatar: 'core/workflow/template/codeRun', position: pos(x, y),
      showSourceHandle: true, showTargetHandle: true, showStatus: true,
      templateType: 'tools', colorSchema: 'blue',
      inputs: [
        input({ key: 'codeType', label: '语言', valueType: 'string', renderTypeList: ['select'], value: language }),
        input({ key: 'code', label: '代码', valueType: 'string', renderTypeList: ['codeEditor'], value: code })
      ],
      outputs: []
    };
  }
};
