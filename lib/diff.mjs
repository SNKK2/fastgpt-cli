// 提交 vs 落库 的分类 diff
//
// 为什么需要它：服务端保存时会跑 migration / 补默认结构 / 补异常边，这些「规范化」
// 不会在响应里告诉你。结果是「我提交的」和「库里存的」不是同一份东西，
// 而后面所有判断（前端渲染、运行时行为、二次编辑）都以落库为准。
//
// 设计原则：
//   1. 不输出无意义的长文本 diff，按语义分五类：added / removed / injected / stripped / changed
//   2. 已知无害的变化进 whitelisted，否则噪音会淹没信号
//   3. 只报「路径」，不报大段内容，方便 agent 直接定位

const CATCH_HANDLE = /-source_catch-/;
const AUTO_OUTPUT_IDS = new Set(['system_addOutputParam', 'system_rawResponse', 'system_error_text']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};

/**
 * 对比两个 workflow 结构。
 * @param {{nodes:any[], edges:any[], chatConfig?:any}} submitted 本次提交（已规范化）
 * @param {{nodes:any[], edges:any[], chatConfig?:any}} stored     落库读回
 * @returns {{added:string[], removed:string[], injected:string[], stripped:string[], changed:string[], whitelisted:string[], verdict:string}}
 */
export function diffWorkflow({ submitted, stored }) {
  const added = [];
  const removed = [];
  const injected = [];
  const stripped = [];
  const changed = [];
  const white = new Map(); // code -> {count, samples[]}
  const whitelisted = [];
  const markWhite = (code, sample) => {
    const cur = white.get(code) || { code, count: 0, samples: [] };
    cur.count += 1;
    if (sample && cur.samples.length < 3) cur.samples.push(sample);
    white.set(code, cur);
  };

  // ---------- 节点：按 nodeId 对齐 ----------
  const sMap = new Map((submitted.nodes || []).map(n => [n.nodeId, n]));
  const tMap = new Map((stored.nodes || []).map(n => [n.nodeId, n]));

  for (const id of tMap.keys()) if (!sMap.has(id)) added.push(`node:${id}（服务端新增节点）`);
  for (const id of sMap.keys()) if (!tMap.has(id)) removed.push(`node:${id}（提交的节点没落库）`);

  for (const [id, sub] of sMap) {
    const sto = tMap.get(id);
    if (!sto) continue;

    // 顶层标量字段
    for (const key of new Set([...Object.keys(sub), ...Object.keys(sto)])) {
      if (['inputs', 'outputs', 'position'].includes(key)) continue;
      if (!(key in sub) && key in sto) {
        if (key === 'catchError' && typeof sto[key] === 'boolean') {
          markWhite('catchError_default_filled', `nodes[${id}].catchError=${sto[key]}`);
          continue;
        }
        injected.push(`nodes[${id}].${key} = ${short(sto[key])}`);
      }
      else if (key in sub && !(key in sto)) stripped.push(`nodes[${id}].${key}（提交有、落库无）`);
      else if (JSON.stringify(sub[key]) !== JSON.stringify(sto[key])) {
        changed.push(`nodes[${id}].${key}: ${short(sub[key])} → ${short(sto[key])}`);
      }
    }

    // inputs：按 key 对齐
    const subIn = new Map((sub.inputs || []).map(i => [i.key, i]));
    const stoIn = new Map((sto.inputs || []).map(i => [i.key, i]));
    for (const k of stoIn.keys()) if (!subIn.has(k)) injected.push(`nodes[${id}].inputs[${k}]（服务端注入的输入项）`);
    for (const k of subIn.keys()) if (!stoIn.has(k)) stripped.push(`nodes[${id}].inputs[${k}]（提交的输入项被丢弃）`);
    for (const [k, a] of subIn) {
      const b = stoIn.get(k);
      if (!b) continue;
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const av = a[field];
        const bv = b[field];
        if (JSON.stringify(av) === JSON.stringify(bv)) continue;
        // 已知无害：renderTypeList 里被塞进 agentGenerated
        if (field === 'renderTypeList' && Array.isArray(av) && Array.isArray(bv)) {
          const extra = bv.filter(x => !av.includes(x));
          const lost = av.filter(x => !bv.includes(x));
          if (extra.length === 1 && extra[0] === 'agentGenerated' && lost.length === 0) {
            markWhite('renderTypeList_agentGenerated_injected', `nodes[${id}].inputs[${k}]`);
            continue;
          }
        }
        if (!(field in a)) {
          // 服务端补默认选中类型：只要补的不是 agentGenerated（那会让前端渲染成「AI 生成」占位）就无害
          if (field === 'selectedType') {
            const rt = (b.renderTypeList || a.renderTypeList || []);
            const expected = rt.find(t => t !== 'agentGenerated');
            if (bv !== 'agentGenerated' && bv === expected) {
              markWhite('selectedType_default_filled', `nodes[${id}].inputs[${k}]`);
              continue;
            }
            injected.push(`nodes[${id}].inputs[${k}].selectedType = ${short(bv)}（⚠️ 被填成 agentGenerated 或非法值，前端会渲染成「AI 生成」占位）`);
            continue;
          }
          injected.push(`nodes[${id}].inputs[${k}].${field} = ${short(bv)}`);
        }
        else if (!(field in b)) stripped.push(`nodes[${id}].inputs[${k}].${field}（被 schema strip）`);
        else changed.push(`nodes[${id}].inputs[${k}].${field}: ${short(av)} → ${short(bv)}`);
      }
    }
    // inputs 仅是顺序不同 -> 无害
    const sk = [...subIn.keys()];
    const tk = [...stoIn.keys()];
    if (sk.length === tk.length && sk.join(',') !== tk.join(',') && [...sk].sort().join(',') === [...tk].sort().join(',')) {
      markWhite('inputs_order_reordered', `nodes[${id}]`);
    }

    // outputs：按 id 对齐
    const subOut = new Map((sub.outputs || []).map(o => [o.id, o]));
    const stoOut = new Map((sto.outputs || []).map(o => [o.id, o]));
    for (const k of stoOut.keys()) {
      if (subOut.has(k)) continue;
      if (AUTO_OUTPUT_IDS.has(k)) markWhite('auto_output_injected', `nodes[${id}].outputs[${k}]`);
      else injected.push(`nodes[${id}].outputs[${k}]（服务端注入的输出）`);
    }
    for (const k of subOut.keys()) if (!stoOut.has(k)) stripped.push(`nodes[${id}].outputs[${k}]（提交的输出被丢弃）`);
  }

  // ---------- 边：按四元组对齐 ----------
  const edgeKey = e => `${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`;
  const sEdges = new Set((submitted.edges || []).map(edgeKey));
  const tEdges = new Set((stored.edges || []).map(edgeKey));
  for (const e of stored.edges || []) {
    if (sEdges.has(edgeKey(e))) continue;
    if (CATCH_HANDLE.test(e.sourceHandle || '')) {
      markWhite('catch_edge_added', `edge ${e.source} -> ${e.target}`);
    } else {
      added.push(`edge ${e.source} → ${e.target}（服务端新增连线）`);
    }
  }
  for (const e of submitted.edges || []) {
    if (!tEdges.has(edgeKey(e))) removed.push(`edge ${e.source} → ${e.target}（提交的连线没落库）`);
  }

  // ---------- chatConfig.variables：按 key 对齐 ----------
  const sVars = new Map((submitted.chatConfig?.variables || []).map(v => [v.key, v]));
  const tVars = new Map((stored.chatConfig?.variables || []).map(v => [v.key, v]));
  for (const k of tVars.keys()) if (!sVars.has(k)) injected.push(`chatConfig.variables[${k}]（服务端注入）`);
  for (const k of sVars.keys()) if (!tVars.has(k)) removed.push(`chatConfig.variables[${k}]（提交的变量没落库）`);
  for (const [k, a] of sVars) {
    const b = tVars.get(k);
    if (!b) continue;
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field]) === JSON.stringify(b[field])) continue;
      if (!(field in a)) injected.push(`chatConfig.variables[${k}].${field} = ${short(b[field])}`);
      else if (!(field in b)) {
        // 变量 schema 不含 renderTypeList；前端按 type 自行推导渲染控件，实测 UI 正常
        if (field === 'renderTypeList') { markWhite('variable_renderTypeList_stripped', `chatConfig.variables[${k}]`); continue; }
        stripped.push(`chatConfig.variables[${k}].${field}（被 schema strip）`);
      }
      else changed.push(`chatConfig.variables[${k}].${field}: ${short(a[field])} → ${short(b[field])}`);
    }
  }

  // ---------- 结论 ----------
  const loss = stripped.length + removed.length;
  const verdict = loss > 0 ? 'data_loss' : added.length + injected.length + changed.length > 0 ? 'server_normalized' : 'clean';

  return {
    added, removed, injected, stripped, changed,
    whitelisted: [...white.values()],
    whitelistedCount: [...white.values()].reduce((n, x) => n + x.count, 0),
    verdict
  };
}
