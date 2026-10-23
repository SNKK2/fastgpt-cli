// 离线回归测试：不触网，验证构造器、校验规则、错误契约
// 运行: node tests/smoke.mjs
import { node, VARP, REF } from '../lib/nodes.mjs';
import { validateWorkflow, edge, chain } from '../lib/validate.mjs';
import { cliError, BASE_PRESETS, Notice, withNotice, exitCodeFor } from '../lib/errors.mjs';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function section(title) {
  results.push(`\n${title}`);
}

// ---------- 1. 节点构造器 ----------
section('节点构造器');

const requiredTypes = ['start','chat','classify','datasetSearch','answer','readFiles',
  'contentExtract','ifElse','textConcat','http','code','pluginInput','pluginOutput',
  'pluginModule','toolCall'];

for (const t of requiredTypes) {
  ok(`node.${t} 存在`, typeof node[t] === 'function');
}

// start
{
  const n = node.start('n_start');
  ok('start 有 userChatInput 输出', n.outputs.some(o => o.id === 'userChatInput'));
  ok('start 无 targetHandle', n.showTargetHandle === false);
  const wf = node.start('n_start', { withFiles: true });
  ok('start withFiles 加 userFiles 输出', wf.outputs.some(o => o.id === 'userFiles'));
}

// chat：temperature/maxToken 不能有值（否则后端夹到 1）
{
  const n = node.chat('n_chat', { modelId: 'a'.repeat(24), question: REF('n_start','userChatInput') });
  const mt = n.inputs.find(i => i.key === 'maxToken');
  const tp = n.inputs.find(i => i.key === 'temperature');
  ok('chat 不含 maxToken', !mt);
  ok('chat 不含 temperature', !tp);
  const q = n.inputs.find(i => i.key === 'userChatInput');
  ok('chat 引用 selectedType=reference', q?.selectedType === 'reference');
}

// http：字段名必须是 system_httpHeader
{
  const n = node.http('n_http', {
    url: 'https://x/y', method: 'POST',
    headers: [{ key: 'Authorization', value: 'Bearer x', type: 'string' }],
    jsonBody: '{}'
  });
  const keys = n.inputs.map(i => i.key);
  ok('http 用 system_httpHeader（单数）', keys.includes('system_httpHeader'));
  ok('http 不含 system_httpHeaders', !keys.includes('system_httpHeaders'));
  ok('http 有 system_httpJsonBody', keys.includes('system_httpJsonBody'));
  const body = n.inputs.find(i => i.key === 'system_httpJsonBody');
  ok('http body 用 hidden 模式', body?.selectedType === 'hidden');
  const hdr = n.inputs.find(i => i.key === 'system_httpHeader');
  ok('http headers 用 custom 模式', hdr?.selectedType === 'custom');
}

// pluginModule：参数必须 agentGenerated
{
  const n = node.pluginModule('pm1', {
    appId: 'b'.repeat(24), name: '查询',
    params: [{ key: 'searchKey', label: '搜索词' }]
  });
  const p = n.inputs.find(i => i.key === 'searchKey');
  ok('pluginModule 用 pluginModule 类型', n.flowNodeType === 'pluginModule');
  ok('pluginModule 参数 agentGenerated', p?.selectedType === 'agentGenerated');
  ok('pluginModule 有 defaultToAgentGenerated', p?.defaultToAgentGenerated === true);
  ok('pluginModule 有 customJsonSchema', !!p?.customJsonSchema?.isToolParam);
}

// toolCall
{
  const n = node.toolCall('n_tools', {
    modelId: 'c'.repeat(24), question: REF('n_start','userChatInput'), prompt: 'p'
  });
  ok('toolCall 用 tools 类型', n.flowNodeType === 'tools');
  ok('toolCall 有 answerText 输出', n.outputs.some(o => o.id === 'answerText'));
  const rt = n.inputs.find(i => i.key === 'isResponseAnswerText');
  ok('toolCall 默认不自动输出', rt?.value === false);
}

// pluginInput / pluginOutput
{
  const pin = node.pluginInput('n_input', { params: [{ key: 'a', label: 'A', required: true }] });
  ok('pluginInput 输出 id = 参数 key', pin.outputs[0].id === 'a');
  let threw = false;
  try { node.pluginOutput('n_output', {}); } catch { threw = true; }
  ok('pluginOutput 缺 from 会抛错', threw);
}

// ---------- 2. VARP ----------
section('VARP 变量引用');

ok('VARP 生成正确格式', VARP('n_input','datasetName') === '{{$n_input.datasetName$}}');
ok('VARP 不生成 pluginInput 别名', !VARP('n_input','x').includes('pluginInput'));

// ---------- 3. 校验规则 ----------
section('校验规则');

// 3.1 正确的工具结构应通过
{
  const nodes = [
    node.start('n_start'),
    node.toolCall('n_tools', { modelId: 'c'.repeat(24), question: REF('n_start','userChatInput') }),
    node.pluginModule('pm1', { appId: 'b'.repeat(24), name: '查询', params: [{ key:'k', label:'K' }] }),
    node.answer('n_answer', { content: REF('n_tools','answerText') })
  ];
  const edges = [
    edge('n_start','n_tools'),
    { source:'n_tools', sourceHandle:'selectedTools', target:'pm1', targetHandle:'selectedTools' },
    edge('n_tools','n_answer')
  ];
  const v = validateWorkflow({ nodes, edges });
  ok('正确工具结构通过校验', v.ok, v.errors.join('; '));
}

// 3.2 system_httpHeaders 拼写错误
{
  const h = node.http('n_http', { url:'https://x', method:'POST', jsonBody:'{}' });
  for (const i of h.inputs) if (i.key === 'system_httpHeader') i.key = 'system_httpHeaders';
  const v = validateWorkflow({ nodes: [node.start('s'), h], edges: [edge('s','n_http')] });
  ok('捕获 system_httpHeaders 拼写错误', !v.ok && v.errors.some(e => e.includes('system_httpHeader（单数）')));
}

// 3.3 pluginModule 未连 selectedTools
{
  const nodes = [
    node.start('n_start'),
    node.toolCall('n_tools', { modelId: 'c'.repeat(24), question: REF('n_start','userChatInput') }),
    node.pluginModule('pm1', { appId: 'b'.repeat(24), name: 'X', params: [] }),
    node.answer('n_answer', { content: REF('n_tools','answerText') })
  ];
  const edges = [edge('n_start','n_tools'), edge('n_tools','n_answer')];
  const v = validateWorkflow({ nodes, edges });
  ok('捕获 pluginModule 未连接', !v.ok && v.errors.some(e => e.includes('没连到 tools')));
}

// 3.4 变量引用用错 nodeId
{
  const n = node.http('n_http', { url:'https://x', method:'POST',
    jsonBody: '{"q":"{{$pluginInput.searchKey$}}"}' });
  const v = validateWorkflow({ nodes: [node.start('s'), n], edges: [edge('s','n_http')] });
  ok('捕获 pluginInput 别名引用', v.warnings.some(w => w.includes('可能不生效')));
}

// 3.5 answerNode 重复引用
{
  const nodes = [
    node.start('s'),
    node.chat('c', { modelId:'a'.repeat(24), question: REF('s','userChatInput') }),
    node.answer('a1', { content: REF('c','answerText') }),
    node.answer('a2', { content: REF('c','answerText') })
  ];
  const edges = [edge('s','c'), edge('c','a1'), edge('c','a2')];
  const v = validateWorkflow({ nodes, edges });
  ok('捕获重复 answer 引用', !v.ok && v.errors.some(e => e.includes('多个 answerNode')));
}

// 3.6 chatNode 输出被 answer 消费时应关闭自动输出
{
  const nodes = [
    node.start('s'),
    node.chat('c', { modelId:'a'.repeat(24), question: REF('s','userChatInput') }),
    node.answer('a', { content: REF('c','answerText') })
  ];
  const v = validateWorkflow({ nodes, edges: [edge('s','c'), edge('c','a')] });
  ok('chat+answer 结构校验通过', v.ok);
}

// ---------- 4. 错误契约 ----------
section('错误契约');

{
  const e = cliError('not_configured');
  const env = e.toEnvelope();
  ok('错误有 type', env.error.type === 'config');
  ok('错误有 subtype', env.error.subtype === 'not_configured');
  ok('错误有 action_required', env.error.action_required === 'user');
  ok('错误有 forbidden', !!env.error.forbidden);
  ok('错误有 next_command', !!env.error.next_command);
  ok('config 退出码是 10', exitCodeFor(e) === 10);
}

{
  const e = cliError('model_id_unavailable');
  ok('model_id_unavailable 要求问用户', e.actionRequired === 'user');
  ok('model_id_unavailable 禁止编造', /不要用/.test(e.forbidden || ''));
}

{
  const e = cliError('not_logged_in');
  ok('not_logged_in 退出码 11', exitCodeFor(e) === 11);
  ok('not_logged_in 有 forbidden', !!e.forbidden);
}

ok('预设含 cn/global/local/private',
  ['cn','global','local','private'].every(k => BASE_PRESETS[k]));
ok('cn 预设地址正确', BASE_PRESETS.cn.base === 'https://cloud.fastgpt.cn');
ok('global 预设地址正确', BASE_PRESETS.global.base === 'https://cloud.fastgpt.io');
ok('private 无固定地址', BASE_PRESETS.private.base === null);

// ---------- 5. _notice ----------
section('成功提示 _notice');

{
  const p = withNotice({ ok: true, a: 1 }, Notice.dryRunOnly());
  ok('dry-run notice 挂载成功', p._notice?.type === 'dry_run_only');
  ok('dry-run notice 说明不是真部署', /只校验了结构/.test(p._notice?.message || ''));
}

{
  const p = withNotice({ ok: true }, null);
  ok('空 notice 不输出字段', !('_notice' in p));
}

{
  const p = withNotice({ ok: true }, [Notice.trainingAsync('c1'), Notice.emptySearch('d1')]);
  ok('多 notice 转数组', Array.isArray(p._notice) && p._notice.length === 2);
}

ok('pluginPublished notice 提示 VARP', /实际nodeId/.test(Notice.pluginPublished('x').hint || ''));

// ---------- 输出 ----------
console.log(results.join('\n'));
console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
