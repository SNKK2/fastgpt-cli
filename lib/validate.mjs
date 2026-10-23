// 连线构造器 + 校验器
//
// handle 规则（源码 getHandleId(nodeId, type, key) => `${nodeId}-${type}-${key}`）：
//   普通输出： `${nodeId}-source-right`
//   分支输出： `${nodeId}-source-${branchKey}`   ← 顺序是 type 在前
//   普通输入： `${nodeId}-target-left`

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

/**
 * 保存前硬校验。返回 {ok, errors, warnings}
 * 目标：把 UI 上才会暴露的问题提前到 CLI 阶段
 */
export function validateWorkflow({ nodes = [], edges = [], chatConfig = {} }) {
  const errors = [];
  const warnings = [];
  const byId = new Map();

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
  const outputIds = new Map(); // nodeId -> Set(output id)
  for (const n of nodes) {
    outputIds.set(n.nodeId, new Set((n.outputs || []).map(o => o.id)));
  }
  for (const [i, e] of edges.entries()) {
    if (!byId.has(e.source)) errors.push(`edge[${i}] source 不存在: ${e.source}`);
    if (!byId.has(e.target)) errors.push(`edge[${i}] target 不存在: ${e.target}`);

    const src = byId.get(e.source);
    if (src) {
      // 分支节点：handle 里的 key 必须来自 agents
      if (src.flowNodeType === 'classifyQuestion') {
        const agents = (src.inputs || []).find(x => x.key === 'agents')?.value || [];
        const keys = new Set(agents.map(a => a.key));
        const m = /-source-(.+)$/.exec(e.sourceHandle || '');
        const key = m?.[1];
        if (!key) errors.push(`edge[${i}] sourceHandle 格式错误: ${e.sourceHandle}（应为 ${e.source}-source-<branchKey>）`);
        else if (key !== 'right' && !keys.has(key)) errors.push(`edge[${i}] 分支 key "${key}" 不在 agents 中，可用: ${[...keys].join(', ')}`);
      } else {
        const expect = `${e.source}-source-right`;
        if (e.sourceHandle !== expect) errors.push(`edge[${i}] sourceHandle 应为 "${expect}"，实际 "${e.sourceHandle}"`);
      }
    }
    const expectT = `${e.target}-target-left`;
    if (e.targetHandle !== expectT) errors.push(`edge[${i}] targetHandle 应为 "${expectT}"，实际 "${e.targetHandle}"`);
  }

  // 4. 引用必须可解析 + selectedType 必须为 reference
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      const v = inp.value;
      if (isRef(v)) {
        const [nid, oid] = v;
        if (!byId.has(nid)) errors.push(`${n.nodeId}.${inp.key} 引用了不存在的节点 ${nid}`);
        else if (!outputIds.get(nid).has(oid)) {
          errors.push(`${n.nodeId}.${inp.key} 引用了 ${nid} 上不存在的输出 ${oid}，可用: ${[...outputIds.get(nid)].join(', ')}`);
        }
        if (inp.selectedType !== 'reference') {
          errors.push(`${n.nodeId}.${inp.key} 是引用但 selectedType="${inp.selectedType}"，UI 不会渲染成变量（必须为 reference）`);
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
  const refMap = new Map(); // "nodeId:outputId" -> [answerNodeId]
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
    // 判断这些 answerNode 是否可能同时执行：看它们能否从同一个上游到达
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

  // 7. 孤立节点
  const linked = new Set();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }
  for (const n of nodes) {
    if (!linked.has(n.nodeId)) warnings.push(`节点 ${n.nodeId}(${n.name}) 没有任何连线`);
  }

  return { ok: errors.length === 0, errors, warnings };
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
