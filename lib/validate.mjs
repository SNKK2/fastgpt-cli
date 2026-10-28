// 连线构造器 + 校验器 + 规范化器
//
// handle 规则（源码 getHandleId(nodeId, type, key) => `${nodeId}-${type}-${key}`）：
//   普通输出： `${nodeId}-source-right`
//   分支输出： `${nodeId}-source-${branchKey}`   ← 顺序是 type 在前（ifElse 用 branchId，ELSE 是内建分支）
//   异常输出： `${nodeId}-source_catch-right`
//   普通输入： `${nodeId}-target-left`
//
// 校验分三层（对应线上实测过的三类坑）：
//   A. 图结构：节点 ID、连线、handle 形态、孤立节点
//   B. 输入语义：引用可解析（含全局变量）、selectedType、字段名、值类型
//   C. 前端渲染：裸变量占位、canEdit 常量、addInputParam null —— 这三类 JSON 看着对，
//      但前端会显示成「选择引用变量」空占位 / 报「存在未完成的输入变量配置」

/** 全局变量在引用里的伪节点 ID（FastGPT 官方机制，不是普通节点） */
export const VARIABLE_NODE_ID = 'VARIABLE_NODE_ID';

/** 拿不到已有节点时补的那条边（source/target 全连或者用于快速试跑） */
export function edge(source, target, fromKey = 'right') {
  if (!source || !target) throw new Error('edge 需要 source 和 target');
  if (typeof fromKey !== 'string' || !fromKey) throw new Error('fromKey 非法');
  return {
    source,
    sourceHandle: `${source}-source-${fromKey}`,
    target,
    targetHandle: `${target}-target-left`
  };
}

/** 从最左节点开始自动串成一条链 */
export function chain(nodeIds) {
  const out = [];
  for (let i = 0; i < nodeIds.length - 1; i++) out.push(edge(nodeIds[i], nodeIds[i + 1]));
  return out;
}

const isRef = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

/** 分支节点的可选分支 key（ifElse 的 ELSE 是内建兜底分支，不在 ifElseList 里） */
export function branchKeys(node) {
  if (!node) return new Set();
  if (node.flowNodeType === 'ifElseNode') {
    const list = (node.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
    const keys = new Set(list.map(b => b.branchId).filter(Boolean));
    keys.add('ELSE');
    return keys;
  }
  if (node.flowNodeType === 'classifyQuestion') {
    const agents = (node.inputs || []).find(i => i.key === 'agents')?.value || [];
    return new Set(agents.map(a => a.key));
  }
  return new Set();
}

const BRANCH_NODE_TYPES = new Set(['ifElseNode', 'classifyQuestion']);

/**
 * 规范化：把「能跑但前端不认」的写法修成官方形态。
 * 返回 { nodes, edges, fixes }，不改入参，供 `wf lint --fix` 与 `wf build` 前置使用。
 */
export function normalizeWorkflow({ nodes = [], edges = [], chatConfig = {} }) {
  const fixes = [];
  const outNodes = structuredClone(nodes);
  const outEdges = structuredClone(edges);
  const byId = new Map(outNodes.map(n => [n.nodeId, n]));
  const varKeys = new Set((chatConfig.variables || []).map(v => v.key));

  // 1) handle 形态
  for (const e of outEdges) {
    const src = byId.get(e.source);
    const m = /-source(?:_catch)?-(.+)$/.exec(e.sourceHandle || '');
    const key = m?.[1];
    const isCatch = /-source_catch-/.test(e.sourceHandle || '');
    let want;
    if (isCatch) want = `${e.source}-source_catch-right`;
    else if (src && BRANCH_NODE_TYPES.has(src.flowNodeType)) {
      want = key ? `${e.source}-source-${key}` : `${e.source}-source-right`;
    } else want = `${e.source}-source-right`;
    if (e.sourceHandle !== want) {
      fixes.push({ where: `edge ${e.source}->${e.target}`, from: e.sourceHandle, to: want, reason: 'handle 形态过旧（本实例普通输出固定 -source-right）' });
      e.sourceHandle = want;
    }
    const wantT = `${e.target}-target-left`;
    if (e.targetHandle !== wantT) {
      fixes.push({ where: `edge ${e.source}->${e.target}`, from: e.targetHandle, to: wantT, reason: 'targetHandle 固定 -target-left' });
      e.targetHandle = wantT;
    }
  }

  // 2) 输入层
  for (const n of outNodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'system_addInputParam' && inp.value == null) {
        inp.value = [];
        fixes.push({ where: `${n.nodeId}.system_addInputParam`, from: 'null', to: '[]', reason: '动态输入表格按数组处理' });
      }
      // 裸变量占位 -> 官方引用语法
      const fixStr = s =>
        s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, key) => {
          if (!varKeys.has(key)) return m;
          fixes.push({ where: `${n.nodeId}.${inp.key}`, from: m, to: `{{$VARIABLE_NODE_ID.${key}$}}`, reason: '裸变量前端不渲染成引用' });
          return `{{$VARIABLE_NODE_ID.${key}$}}`;
        });
      if (typeof inp.value === 'string') inp.value = fixStr(inp.value);
      else if (inp.value && typeof inp.value === 'object') {
        const walk = obj => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') obj[k] = fixStr(v);
            else if (v && typeof v === 'object') walk(v);
          }
        };
        walk(inp.value);
      }
    }
    // ifElse 条件值必须是 string 或引用
    if (n.flowNodeType === 'ifElseNode') {
      const list = (n.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
      for (const branch of list) {
        for (const item of branch.list || []) {
          if (typeof item.value === 'number' || typeof item.value === 'boolean') {
            fixes.push({ where: `${n.nodeId}.ifElseList`, from: JSON.stringify(item.value), to: `"${item.value}"`, reason: 'schema 只收 string | [nodeId, outputKey]' });
            item.value = String(item.value);
          }
          if (item.valueType && !['input', 'reference'].includes(item.valueType)) {
            fixes.push({ where: `${n.nodeId}.ifElseList`, from: item.valueType, to: 'input', reason: 'valueType 只能是 input | reference' });
            item.valueType = 'input';
          }
        }
      }
    }
  }

  return { nodes: outNodes, edges: outEdges, fixes };
}

/**
 * 保存前硬校验。返回 {ok, errors, warnings}
 * 目标：把 UI 上才会暴露的问题提前到 CLI 阶段
 */
export function validateWorkflow({ nodes = [], edges = [], chatConfig = {} }) {
  const errors = [];
  const warnings = [];
  // 结构化诊断：errors 是给人/测试看的字符串，issues 是给 agent 看的可执行条目。
  // fix: 'auto' = wf lint --fix 能修掉；'manual' = 必须人/agent 改内容。
  const issues = [];
  const err = (code, message, extra = {}) => {
    errors.push(message);
    issues.push({ code, message, fix: extra.fix || 'manual', ...extra });
  };
  const byId = new Map();
  const varKeys = new Set((chatConfig.variables || []).map(v => v.key));

  // 1. 节点 ID 唯一
  for (const n of nodes) {
    if (!n.nodeId) { errors.push('存在缺少 nodeId 的节点'); continue; }
    if (byId.has(n.nodeId)) errors.push(`nodeId 重复: ${n.nodeId}`);
    byId.set(n.nodeId, n);
  }

  // 2. 必须有开始节点
  const starts = nodes.filter(n => n.flowNodeType === 'workflowStart');
  if (starts.length === 0) errors.push('缺少 workflowStart 节点');
  if (starts.length > 1) errors.push('workflowStart 只能有一个');

  // 3. 边完整性 + handle 格式
  const outputIds = new Map();
  for (const n of nodes) {
    outputIds.set(n.nodeId, new Set((n.outputs || []).map(o => o.id)));
  }
  for (const [i, e] of edges.entries()) {
    if (!byId.has(e.source)) errors.push(`edge[${i}] source 不存在: ${e.source}`);
    if (!byId.has(e.target)) errors.push(`edge[${i}] target 不存在: ${e.target}`);

    // 工具挂载专用连线：tools --[selectedTools]--> pluginModule/toolSet
    if (e.sourceHandle === 'selectedTools' && e.targetHandle === 'selectedTools') {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      if (src && src.flowNodeType !== 'tools' && src.flowNodeType !== 'agent') {
        errors.push(`edge[${i}] 用 selectedTools 连线，但 source(${e.source}) 不是 tools/agent 节点`);
      }
      if (tgt && !['pluginModule', 'toolSet', 'tool', 'plugin'].includes(tgt.flowNodeType)) {
        errors.push(`edge[${i}] 用 selectedTools 连线，但 target(${e.target}) 不是工具节点`);
      }
      continue;  // 跳过普通 handle 格式校验
    }

    const src = byId.get(e.source);
    if (src) {
      if (BRANCH_NODE_TYPES.has(src.flowNodeType)) {
        const keys = branchKeys(src);
        const m = /-source-(.+)$/.exec(e.sourceHandle || '');
        const key = m?.[1];
        if (!key) err('handle_format', `edge[${i}] sourceHandle 格式错误: ${e.sourceHandle}（应为 ${e.source}-source-<branchKey>）`, { fix: 'auto' });
        else if (key !== 'right' && !keys.has(key)) err('handle_branch', `edge[${i}] 分支 key "${key}" 不在分支列表，可用: ${[...keys].join(', ')}`, { fix: 'manual' });
      } else {
        const expect = `${e.source}-source-right`;
        const isCatchHandle = e.sourceHandle === `${e.source}-source_catch-right`;
        if (e.sourceHandle !== expect && !isCatchHandle) {
          err('handle_legacy_port', `edge[${i}] sourceHandle 应为 "${expect}"，实际 "${e.sourceHandle}"（旧版按输出 key 命名；wf lint --fix 可自动修）`, { fix: 'auto', where: `${e.source}->${e.target}` });
        }
      }
    }
    const expectT = `${e.target}-target-left`;
    if (e.targetHandle !== expectT) err('handle_target', `edge[${i}] targetHandle 应为 "${expectT}"，实际 "${e.targetHandle}"`, { fix: 'auto', where: `${e.source}->${e.target}` });
  }

  // 4. 引用必须可解析 + selectedType 必须为 reference
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      const v = inp.value;
      if (isRef(v)) {
        const [nid, oid] = v;
        if (nid === VARIABLE_NODE_ID) {
          // 全局变量是官方机制，不是节点引用；只校验 key 是否定义过
          if (!varKeys.has(oid)) {
            err('var_undefined', `${n.nodeId}.${inp.key} 引用了未定义的全局变量 ${oid}（chatConfig.variables 里没有这个 key）`, { where: `${n.nodeId}.${inp.key}`, variable: oid });
          }
        } else if (!byId.has(nid)) {
          err('ref_node', `${n.nodeId}.${inp.key} 引用了不存在的节点 ${nid}`, { where: `${n.nodeId}.${inp.key}`, nodeId: nid });
        } else if (!outputIds.get(nid).has(oid)) {
          err('ref_output', `${n.nodeId}.${inp.key} 引用了 ${nid} 上不存在的输出 ${oid}，可用: ${[...outputIds.get(nid)].join(', ')}`, { where: `${n.nodeId}.${inp.key}` });
        }
        if (inp.selectedType !== 'reference') {
          err('ref_selected_type', `${n.nodeId}.${inp.key} 是引用但 selectedType="${inp.selectedType}"，UI 不会渲染成变量（必须为 reference）`, { fix: 'auto', where: `${n.nodeId}.${inp.key}` });
        }
      }
    }
  }

  // 5. modelId 格式
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'modelId' && typeof inp.value === 'string' && inp.value && !/^[0-9a-f]{24}$/i.test(inp.value)) {
        warnings.push(`${n.nodeId}.modelId="${inp.value}" 不是 24 位 ObjectId，发布可能报 "Model model is unavailable"`);
      }
    }
  }

  // 6. 多个 answerNode 引用同一输出（可能导致重复回复）
  const refMap = new Map();
  for (const n of nodes) {
    if (n.flowNodeType !== 'answerNode') continue;
    for (const inp of n.inputs || []) {
      if (Array.isArray(inp.value) && inp.value.length === 2 && typeof inp.value[0] === 'string') {
        const k = `${inp.value[0]}:${inp.value[1]}`;
        if (!refMap.has(k)) refMap.set(k, []);
        refMap.get(k).push(n.nodeId);
      }
    }
  }
  for (const [k, answerIds] of refMap) {
    if (answerIds.length <= 1) continue;
    const reach = checkMutuallyExclusive(answerIds, nodes, edges);
    if (reach.exclusive) {
      warnings.push(`多个 answerNode 引用同一输出 ${k}（${answerIds.join(', ')}），但它们分属互斥分支，可忽略`);
    } else {
      errors.push(
        `多个 answerNode 引用同一输出 ${k}（${answerIds.join(', ')}），这些节点可能同时执行，导致同一条回复输出多次。` +
        `请只保留一个，或让它们挂到互斥的分支上`
      );
    }
  }

  // 7. HTTP 节点字段名（坑：system_httpHeaders 会被静默丢弃）
  for (const n of nodes) {
    if (n.flowNodeType !== 'httpRequest468') continue;
    const keys = (n.inputs || []).map(i => i.key);
    if (keys.includes('system_httpHeaders')) {
      errors.push(`${n.nodeId} 用了 system_httpHeaders，正确字段名是 system_httpHeader（单数），否则请求头会被静默丢弃`);
    }
    for (const need of ['system_httpReqUrl', 'system_httpMethod']) {
      if (!keys.includes(need)) errors.push(`${n.nodeId} 缺少 ${need}`);
    }
  }

  // 8. 变量引用格式（坑：{{$pluginInput.xxx$}} 不生效，必须用实际 nodeId）
  const raw = JSON.stringify(nodes);
  const badRefs = [...raw.matchAll(/\{\{\$(pluginInput|pluginOutput)\.([^$]+)\$\}\}/g)];
  for (const m of badRefs) {
    const io = [...byId.values()].find(x => x.flowNodeType === m[1]);
    const hint = io ? `（该节点的实际 nodeId 是 ${io.nodeId}）` : '';
    warnings.push(
      `变量引用 {{$${m[1]}.${m[2]}$}} 可能不生效${hint}。` +
      `应该写 {{$<实际nodeId>.${m[2]}$}}`
    );
  }

  // 9. 裸变量占位（服务端兼容，前端不认：不会渲染成变量芯片，依赖/校验都不统计）
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      const scan = s => {
        for (const m of s.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
          const defined = varKeys.has(m[1]);
          err(
            defined ? 'bare_variable_ref' : 'bare_variable_undefined',
            `${n.nodeId}.${inp.key} 用了裸变量占位 ${m[0]}` +
              (defined
                ? `，应写 {{$${VARIABLE_NODE_ID}.${m[1]}$}}（服务端能替换但前端不渲染成引用）`
                : `，且 chatConfig.variables 里没有 ${m[1]} 这个变量`),
            { fix: defined ? 'auto' : 'manual', where: `${n.nodeId}.${inp.key}`, variable: m[1] }
          );
        }
      };
      const walk = v => {
        if (typeof v === 'string') scan(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(inp.value);
    }
  }

  // 10. canEdit 动态输入不能用常量（前端只给引用选择器 -> 空占位 + 「存在未完成的输入变量配置」）
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.canEdit !== true) continue;
      if (isRef(inp.value)) continue;
      err(
        'canedit_const_value',
        `${n.nodeId}.${inp.key} 是 canEdit 动态输入，但值是常量 ${JSON.stringify(inp.value)}。` +
        `前端只会渲染引用选择器，会显示空的「选择引用变量」并报「存在未完成的输入变量配置」。` +
        `把常量内联进代码/节点参数后删掉这个输入项`,
        { where: `${n.nodeId}.${inp.key}`, nodeId: n.nodeId, inputKey: inp.key }
      );
    }
  }

  // 11. 动态输入容器不能是 null
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'system_addInputParam' && inp.value == null) {
        err('addinputparam_null', `${n.nodeId}.system_addInputParam 的 value 是 null，前端动态输入表格按数组处理，应为 []`, { fix: 'auto', where: `${n.nodeId}.system_addInputParam` });
      }
    }
  }

  // 12. ifElse 条件值类型（schema：string | [nodeId, outputId]）
  for (const n of nodes) {
    if (n.flowNodeType !== 'ifElseNode') continue;
    const list = (n.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
    for (const branch of list) {
      for (const item of branch.list || []) {
        if (item.value !== undefined && typeof item.value !== 'string' && !Array.isArray(item.value)) {
          err(
            'ifelse_value_type',
            `${n.nodeId}.ifElseList 分支 ${branch.branchId || '(无 branchId)'} 的 value 是 ${typeof item.value}` +
              `（${JSON.stringify(item.value)}），schema 只收 string 或 [nodeId, outputId]，布尔请写 "true"/"false"`,
            { fix: 'auto', where: `${n.nodeId}.ifElseList` }
          );
        }
        if (item.valueType && !['input', 'reference'].includes(item.valueType)) {
          err('ifelse_valuetype_enum', `${n.nodeId}.ifElseList valueType=${item.valueType}，只能是 input | reference`, { fix: 'auto', where: `${n.nodeId}.ifElseList` });
        }
      }
    }
  }

  // 13. pluginModule：参数必须 agentGenerated，且必须用 selectedTools 连到 tools
  const selectedToolEdges = new Set(edges.filter(e => e.sourceHandle === 'selectedTools').map(e => e.target));
  for (const n of nodes) {
    if (n.flowNodeType !== 'pluginModule' && n.flowNodeType !== 'toolSet') continue;
    if (!selectedToolEdges.has(n.nodeId)) {
      errors.push(
        `${n.nodeId}(${n.name}) 是工具节点但没连到 tools 节点。` +
        `需要用 edges 添加 {source:"<tools节点>", sourceHandle:"selectedTools", target:"${n.nodeId}", targetHandle:"selectedTools"}`
      );
    }
    if (n.flowNodeType === 'pluginModule') {
      for (const inp of n.inputs || []) {
        if (inp.key === 'system_forbid_stream') continue;
        if (inp.selectedType !== 'agentGenerated') {
          warnings.push(
            `${n.nodeId}.${inp.key} 的 selectedType 是 "${inp.selectedType}"，` +
            `agent 传参会是空的；应设为 agentGenerated 并加 defaultToAgentGenerated: true`
          );
        }
      }
    }
  }

  // 14. 有 tools/pluginModule 但缺 answer 输出引用
  const toolsNodes = nodes.filter(n => n.flowNodeType === 'tools');
  for (const t of toolsNodes) {
    const used = nodes.some(n => n.flowNodeType === 'answerNode' &&
      (n.inputs || []).some(i => Array.isArray(i.value) && i.value[0] === t.nodeId));
    if (!used) warnings.push(`${t.nodeId} 的输出没有被 answerNode 引用，对话可能没有回复`);
  }

  // 15. 孤立节点
  const linked = new Set();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }
  for (const n of nodes) {
    if (!linked.has(n.nodeId)) warnings.push(`节点 ${n.nodeId}(${n.name}) 没有任何连线`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
    // 给调用方一句话动作：能自动修的走 lint --fix，不能修的要改内容
    next: errors.length === 0
      ? null
      : issues.some(i => i.fix === 'auto')
        ? `先跑 fastgpt wf lint <file> --fix fixed.json 自动修 ${issues.filter(i => i.fix === 'auto').length} 项，再改掉剩下的 ${issues.filter(i => i.fix !== 'auto').length} 项`
        : `${issues.length} 项都需要改内容（wf lint --fix 修不掉）：${[...new Set(issues.map(i => i.code))].join(', ')}`
  };
}

/**
 * 判断一组节点是否分属互斥分支。
 * 做法：从每个节点向上游回溯，收集途经的分支选择（sourceHandle 非 -source-right 的边）。
 * 如果两个节点经过同一个 classify 节点下的不同 key，则互斥。
 */
function checkMutuallyExclusive(nodeIds, nodes, edges) {
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push({ source: e.source, handle: e.sourceHandle || '' });
  }

  const collectBranches = startId => {
    const found = new Set();
    const seen = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const { source, handle } of incoming.get(cur) || []) {
        const m = /-source-(.+)$/.exec(handle);
        if (m && m[1] !== 'right') found.add(`${source}:${m[1]}`);
        stack.push(source);
      }
    }
    return found;
  };

  const sets = nodeIds.map(id => collectBranches(id));

  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const item of sets[i]) {
        const [src, key] = item.split(':');
        for (const other of sets[j]) {
          const [src2, key2] = other.split(':');
          if (src === src2 && key !== key2) return { exclusive: true };
        }
      }
    }
  }
  return { exclusive: false };
}
