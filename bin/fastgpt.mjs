#!/usr/bin/env node
// FastGPT CLI — agent 友好的管理工具
// 通用约定：所有命令输出 JSON，错误以非零退出码返回
import fs from 'node:fs';
import path from 'node:path';
import { client, loginRaw, whoami, FastGPTError, isConfigured, saveConfig, getBase, CONFIG_PATH, HOME } from '../lib/client.mjs';
import { cliError, exitCodeFor, isCliError, BASE_PRESETS, WEBSITE_TO_PRESET, Notice, withNotice } from '../lib/errors.mjs';
import { setBlock, getBlock, clearBlock, blockEnvelope } from '../lib/blocker.mjs';
import { mergeCollaboratorList, updateCollaborators, RESOURCES } from '../lib/collaborators.mjs';
import { ensureAuth, scanLogin, resumeScan, passwordLogin, checkAuth, isAuthError } from '../lib/auth.mjs';
import { node } from '../lib/nodes.mjs';
import { edge, validateWorkflow, normalizeWorkflow } from '../lib/validate.mjs';
import { diffWorkflow } from '../lib/diff.mjs';
import { compareRuleset, calibrateRuleset, DIAGNOSTIC_CODES } from '../lib/ruleset.mjs';

const out = o => console.log(JSON.stringify(o, null, 2));

/** 结构化失败：subtype 必须在 errors.mjs 注册表中 */
const failCli = (subtype, overrides = {}) => {
  const err = cliError(subtype, overrides);
  out(err.toEnvelope());
  process.exit(exitCodeFor(err));
};

/** 兼容旧调用：普通的用法错误 */
const fail = (msg, extra = {}) => {
  const err = cliError(extra.subtype || 'bad_usage', { message: msg, ...extra });
  out(err.toEnvelope());
  process.exit(exitCodeFor(err));
};

// ---------- 简易参数解析 ----------
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1) {
      const k = a.replace(/^-+/, '');
      const nxt = argv[i + 1];
      if (nxt === undefined || (nxt.startsWith('-') && nxt.length > 1 && !/^-?\d/.test(nxt))) { flags[k] = true; }
      else { flags[k] = nxt; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));


// ---------- modelId 预检 hook ----------
const MODEL_ID_RE = /^[0-9a-f]{24}$/i;

/** 扫描团队应用，收集可用 modelId */
async function scanModelIds() {
  const apps = await client.post('/api/core/app/listV2', { parentId: null, searchKey: '' });
  const list = apps.list || apps || [];
  const found = [];
  const seen = new Set();
  for (const a of list) {
    if (!['advanced', 'simple', 'chatAgent'].includes(a.type)) continue;
    try {
      const d = await client.get(`/api/core/app/detail?appId=${a._id}`);
      for (const n of d.nodes || []) {
        for (const inp of n.inputs || []) {
          if (inp.key !== 'modelId') continue;
          const v = inp.value;
          if (typeof v !== 'string' || !MODEL_ID_RE.test(v) || seen.has(v)) continue;
          seen.add(v);
          found.push({ modelId: v, fromApp: a.name, node: n.nodeId });
        }
      }
    } catch {}
  }
  return found;
}

/** 纯静态检查：不触网，只列出问题，不阻断 */
/**
 * 真实部署前的 modelId 检查（会触网）。
 *   有候选 → 自动填充或校验
 *   无候选 → 打印引导并中断
 *   假值(全零/未见过) → 拒绝
 */
async function ensureModelIdHook(nodes, { autoFill = true } = {}) {
  const isPlaceholder = v => typeof v === 'string' && (/^\s*$/.test(v) || /^<.*>$/.test(v));
  const bad = [];
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key !== 'modelId') continue;
      const v = inp.value;
      if (typeof v === 'string' && MODEL_ID_RE.test(v)) {
        if (/^0+$/.test(v)) { bad.push({ node: n.nodeId, value: v, fake: true }); }
        continue;  // 其它格式合法的先放行，稍后与真实候选比对
      }
      if (Array.isArray(v)) continue;                              // 引用型
      bad.push({ node: n.nodeId, value: v });
    }
  }
  if (!bad.length) return nodes;

  const unique = [...new Set(bad.map(b => String(b.value)))];
  console.error('');
  console.error('⚠️  检测到 modelId 无效');
  console.error(`   节点: ${bad.map(b => b.node).join(', ')}`);
  console.error(`   当前值: ${unique.map(v => v || '(空)').join(', ')}`);
  console.error('');
  console.error('   FastGPT 的 modelId 必须是 24 位 ObjectId，且只能从已配置模型的应用中获取。');
  console.error('');

  let candidates = [];
  try { candidates = await scanModelIds(); } catch {}

  if (!candidates.length) {
    const err = cliError('model_id_unavailable');
    // 写入强制停止层：后续相关命令都会直接返回同一提示
    setBlock({
      code: 'model_id_unavailable',
      message: err.message,
      hint: err.hint,
      forbidden: err.forbidden,
      mustEndTurn: true,
      resolvedBy: err.resolvedBy
    });
    console.error('');
    console.error('❌ ' + err.message);
    console.error('');
    console.error(err.hint);
    console.error('');
    console.error('⛔ ' + err.forbidden);
    console.error('');
    out(err.toEnvelope());
    process.exit(exitCodeFor(err));
  }

  if (!autoFill) {
    console.error('可用 modelId：');
    candidates.forEach(c => console.error(`  ${c.modelId}  (来自应用「${c.fromApp}」)`));
    console.error('');
    console.error('请填入 DSL 的 modelId 字段后重试。');
    process.exit(3);
  }

  // 识别 DSL 里的格式合法但团队中不存在的 modelId（伪造值）
  const known = new Set(candidates.map(c => c.modelId));
  const forged = [];
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key !== 'modelId') continue;
      const v = inp.value;
      if (typeof v === 'string' && MODEL_ID_RE.test(v) && !known.has(v)) {
        forged.push({ node: n.nodeId, value: v });
      }
    }
  }
  if (forged.length) {
    const err = cliError('model_id_forged', {
      details: { forged, available: candidates.map(c => ({ modelId: c.modelId, fromApp: c.fromApp })) }
    });
    console.error('');
    console.error('❌ ' + err.message);
    forged.forEach(x => console.error(`   ${x.node}: ${x.value}`));
    console.error('');
    console.error('   可用值：');
    candidates.forEach(c => console.error(`   ${c.modelId}  (来自应用「${c.fromApp}」)`));
    console.error('');
    console.error('⛔ ' + err.forbidden);
    console.error('');
    out(err.toEnvelope());
    process.exit(exitCodeFor(err));
  }

  const pick = candidates[0].modelId;
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'modelId' && !(typeof inp.value === 'string' && MODEL_ID_RE.test(inp.value)) && !Array.isArray(inp.value)) {
        inp.value = pick;
      }
    }
  }
  console.error(`✓ 已自动填充 modelId: ${pick}  (来自应用「${candidates[0].fromApp}」)`);
  console.error('');
  return nodes;
}


// ---------- 内在参数自动调整 ----------
/**
 * 根据节点依赖关系修正那些「不写就出错」的参数。
 *
 * 典型冲突：chatNode 的 isResponseAnswerText=true 会让它自己输出回答，
 * 如果它后面又接了 answerNode 消费同一个 answerText，用户就会看到两条回复。
 */
function autoTuneNodeParams(nodes) {
  // 收集所有被引用的 [nodeId, outputId]
  const consumed = new Set();
  for (const n of nodes) {
    if (n.flowNodeType !== 'answerNode') continue;
    for (const inp of n.inputs || []) {
      if (Array.isArray(inp.value) && inp.value.length === 2 && typeof inp.value[0] === 'string') {
        consumed.add(`${inp.value[0]}:${inp.value[1]}`);
      }
    }
  }

  const changes = [];

  for (const n of nodes) {
    // 1. chatNode：answerText 被 answerNode 消费时，关闭自动输出
    if (n.flowNodeType === 'chatNode') {
      const isConsumed = consumed.has(`${n.nodeId}:answerText`);
      let inp = (n.inputs || []).find(i => i.key === 'isResponseAnswerText');
      if (!inp) {
        inp = { key: 'isResponseAnswerText', label: '', valueType: 'boolean', renderTypeList: ['hidden'], selectedType: 'hidden', value: undefined };
        n.inputs.push(inp);
      }
      const want = !isConsumed;
      if (inp.value !== want) {
        changes.push({
          node: n.nodeId,
          param: 'isResponseAnswerText',
          from: inp.value,
          to: want,
          reason: isConsumed
            ? 'answerText 已被 answerNode 消费，关闭节点自身输出以避免重复回复'
            : '没有 answerNode 消费，开启节点自身输出'
        });
        inp.value = want;
      }
    }

    // 2. contentExtract：输出是 fields，不参与对话输出，无需处理
    // 3. datasetSearch：只产出引用数据，无需处理
  }

  return changes;
}

// ---------- 共用管道：读文件 → 构建 → 规范化 → 校验 ----------
// 之前 wf lint / wf validate / wf build / wf diff 各自抄了一遍这三段式，语义容易漂。
// 现在统一走 loadWorkflow + lintWorkflow，命令只负责输出与退出码。

/** 读文件 → DSL/原生构建 → 规范化。返回可直接提交的结构 + 自动修复清单。 */
function loadWorkflow(file, flags = {}) {
  const d = readJson(file);
  let built;
  try { built = buildFromDsl(d); } catch (e) { fail(e.message); }
  const normalized = normalizeWorkflow({
    nodes: built.nodes, edges: built.edges, chatConfig: built.chatConfig,
    inlineConstInputs: !!flags['inline-consts']
  });
  return {
    raw: d,
    nodes: normalized.nodes,
    edges: normalized.edges,
    chatConfig: built.chatConfig,
    fixes: normalized.fixes,
    native: !!built.native
  };
}

/** 规范化后校验，附带 modelId 占位符检查。离线可用（不触网）。 */
function lintWorkflow(file, flags = {}) {
  const wf = loadWorkflow(file, flags);
  const v = validateWorkflow({ nodes: wf.nodes, edges: wf.edges, chatConfig: wf.chatConfig });
  const unresolvedModelIds = [];
  for (const n of wf.nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'modelId' && typeof inp.value === 'string' && !/^[0-9a-f]{24}$/i.test(inp.value)) {
        unresolvedModelIds.push({ node: n.nodeId, value: inp.value });
      }
    }
  }
  return {
    ...wf,
    ok: v.ok,
    errors: v.errors,
    warnings: v.warnings,
    issues: v.issues,
    next: v.next,
    unresolvedModelIds,
    autoFixable: v.issues.filter(i => i.fix === 'auto').length,
    manualFixRequired: v.issues.filter(i => i.fix !== 'auto').length
  };
}

/** 提交（草稿或发布）。返回服务端结果，不做 out。 */
async function deployWorkflow({ appId, nodes, edges, chatConfig, versionName, publish = true }) {
  await client.post(`/api/core/app/version/publish?appId=${appId}`, {
    nodes, edges, chatConfig,
    isPublish: publish, autoSave: !publish,
    versionName: versionName || 'v1'
  });
  return { appId };
}

/** dry-run 的 ID 真实性检查：datasetId 必须存在于当前团队 */
async function verifyResourceIds(nodes) {
  const dsIds = new Set();
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key !== 'datasets' || !Array.isArray(inp.value)) continue;
      for (const d of inp.value) {
        if (d && typeof d === 'object' && d.datasetId) dsIds.add(d.datasetId);
      }
    }
  }
  if (!dsIds.size) return { checked: 0, invalid: [] };
  let realDs = [];
  try {
    const d = await client.post('/api/core/dataset/list', { parentId: null, searchKey: '' });
    realDs = (d || []).map(x => x._id);
  } catch {}
  return { checked: dsIds.size, invalid: [...dsIds].filter(id => !realDs.includes(id)) };
}

/** 运行时体检：真跑一次 OpenAPI，返回结构化轨迹（不做 out） */
async function runWorkflowOnce({ appId, key, variables, question = 'hello', chatId }) {
  const res = await fetch(`${client.base}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      appId, chatId: chatId || `cli-${Date.now()}`, stream: false, detail: true,
      variables, messages: [{ role: 'user', content: question }]
    })
  });
  const raw = await res.text();
  if (!res.ok) return { ok: false, httpStatus: res.status, error: raw.slice(0, 200) };
  const json = JSON.parse(raw);
  const content = json.choices?.[0]?.message?.content ?? '';
  let contract;
  try { contract = JSON.parse(content); } catch { /* 非 JSON 输出 */ }
  const trace = (json.responseData || []).map(n => {
    const flat = JSON.stringify({ body: n.body, headers: n.headers });
    return {
      node: n.nodeId || n.moduleName,
      type: n.moduleType,
      httpCode: n.httpResult?.code,
      total: n.httpResult?.data?.total,
      body: n.body,
      headers: n.headers,
      unresolved: [...new Set([...flat.matchAll(/\{\{[^}]{0,60}\}\}/g)].map(m => m[0]))]
    };
  });
  const unresolved = trace.filter(t => t.unresolved.length);
  return {
    ok: unresolved.length === 0,
    httpStatus: res.status,
    contentLength: content.length,
    outputIsJson: !!contract,
    Status: contract?.Status,
    DataSetDate: contract?.DataSetDate,
    domains: contract?.DomainList?.map(d => ({ name: d.name, terms: d.termlist?.length ?? 0 })),
    Error: contract?.Error?.length ? contract.Error : undefined,
    unresolvedVariables: unresolved,
    trace: trace.filter(t => t.type === 'httpRequest468' || t.body || t.headers)
  };
}

// ---------- DSL 构建（wf build / wf validate 共用） ----------
function buildFromDsl(dsl) {
  // 原生导出格式（FastGPT 工作流 JSON 直接导出）：节点本身就有 nodeId/flowNodeType，没有 type。
  // 以前只有 wf lint / wf validate 兼容，wf build 会抛「未知节点类型: undefined」，导致只能手改 JSON。
  const rawNodes = dsl.nodes || [];
  if (!rawNodes.some(n => n.type) && rawNodes.length) {
    const nodes = structuredClone(rawNodes);
    const edges = (dsl.edges || []).map(e => Array.isArray(e) ? edge(e[0], e[1], e[2]) : e);
    const chatConfig = dsl.chatConfig || { variables: [], entryPoints: [] };
    return { nodes, edges, chatConfig, native: true };
  }

  const nodes = [];
  for (const spec of rawNodes) {
    const fn = node[spec.type];
    if (!fn) throw new Error(`未知节点类型: ${spec.type}，可用: ${Object.keys(node).join(', ')}`);
    const { type, ...opts } = spec;
    // 引用简写 "n_start:userChatInput" -> ["n_start","userChatInput"]
    for (const k of Object.keys(opts)) {
      const v = opts[k];
      if (typeof v === 'string' && /^[\w-]+:[\w-]+$/.test(v)) opts[k] = v.split(':');
    }
    if (Array.isArray(opts.datasets)) {
      opts.datasets = opts.datasets.map(x => {
        if (typeof x !== 'string') return x;
        const [id, nm] = x.split(':');
        return { datasetId: id, name: nm || id };
      });
    }
    nodes.push(fn(spec.id, opts));
  }
  const edges = (dsl.edges || []).map(e => Array.isArray(e) ? edge(e[0], e[1], e[2]) : e);
  const chatConfig = dsl.chatConfig || { variables: [], entryPoints: [] };
  return { nodes, edges, chatConfig };
}


// ---------- 命令实现 ----------

const commands = {
  // ===== 初始化 =====
  /**
   * 首次使用引导：配置服务地址 + 登录，一次完成。
   * 交互式（TTY）会逐步询问；非 TTY 用 --base/--user/--pass 参数。
   */
  async 'init'(args, f) {
    const rl = process.stdin.isTTY
      ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout })
      : null;
    const ask = async (q, def) => {
      if (!rl) return def;
      const a = (await rl.question(q)).trim();
      return a || def;
    };

    try {
      // 1. 服务地址：--preset > --base > 环境变量 > 已有配置 > 交互选择
      let base = null;

      const presetKey = f.preset ? String(f.preset).toLowerCase() : null;
      if (presetKey) {
        const p = BASE_PRESETS[presetKey];
        if (!p) {
          failCli('base_unknown_preset', {
            options: Object.entries(BASE_PRESETS).map(([k, v]) => ({ preset: k, label: v.label, base: v.base }))
          });
        }
        if (p.base) {
          base = p.base;
          console.error(`✓ 使用预设：${p.label} → ${base}`);
        } else {
          // private 等需要手动输入
          if (f.base) base = String(f.base);
          else if (rl) {
            console.error(`\n${p.label} ${p.hint}`);
            base = await ask('部署地址: ');
          } else {
            failCli('not_configured', {
              message: '商业私有化版本需要显式提供地址',
              hint: '运行 fastgpt init --preset private --base <你的地址> --user <账号> --pass <密码>',
              nextCommand: 'fastgpt init --preset private --base https://your-fastgpt-host',
              options: Object.entries(BASE_PRESETS).map(([k, v]) => ({ preset: k, label: v.label, base: v.base, ...(v.hint ? { hint: v.hint } : {}) }))
            });
          }
        }
      }

      if (!base) base = f.base || process.env.FASTGPT_BASE || getBase();

      // 校验 base 是否真的是 FastGPT 服务端（不是官网/文档站）
      if (base) {
        const norm = String(base).replace(/\/+$/, '');
        const host = (() => { try { return new URL(norm).host.toLowerCase(); } catch { return ''; } })();
        const suggestPreset = WEBSITE_TO_PRESET[host];
        const probeUrl = `${norm}/api/common/system/getInitData`;
        let alive = false;
        let status = 0;
        try {
          const r = await fetch(probeUrl, { signal: AbortSignal.timeout(6000) });
          status = r.status;
          if (r.ok) {
            const t = await r.text();
            try { alive = JSON.parse(t)?.code === 200; } catch {}
          }
        } catch {}

        if (!alive) {
          const e = cliError(suggestPreset ? 'base_looks_like_website' : 'base_unreachable', {
            message: suggestPreset
              ? `${norm} 是 FastGPT 官网/文档站，不是服务端`
              : undefined,
            hint: suggestPreset
              ? undefined
              : `${norm} 上没有 FastGPT API（探测 ${probeUrl} 返回 ${status || '无响应'}）。\n` +
                '\n' +
                '可能的正确地址：\n' +
                '  · 国内 SaaS   https://cloud.fastgpt.cn   (--preset cn)\n' +
                '  · 海外 SaaS   https://cloud.fastgpt.io   (--preset global)\n' +
                '  · 本地部署    http://localhost:3000      (--preset local)\n' +
                '  · 私有化      https://your-host           (--preset private --base <地址>)',
            nextCommand: suggestPreset ? `fastgpt init --preset ${suggestPreset}` : 'fastgpt init --preset cn',
            details: { base: norm, probed: probeUrl, status, suggestedPreset: suggestPreset || null }
          });
          console.error('');
          console.error('❌ ' + e.message);
          console.error('');
          console.error(e.hint);
          console.error('');
          out(e.toEnvelope());
          process.exit(exitCodeFor(e));
        }
      }

      if (!base) {
        if (!rl) {
          failCli('not_configured', {
            options: Object.entries(BASE_PRESETS).map(([k, v]) => ({
              preset: k, label: v.label, base: v.base, ...(v.hint ? { hint: v.hint } : {})
            }))
          });
        }
        // 交互选择部署版本
        console.error('\n未配置 FastGPT 服务地址，请选择部署版本：');
        const keys = Object.keys(BASE_PRESETS);
        keys.forEach((k, i) => {
          const p = BASE_PRESETS[k];
          console.error(`  ${i + 1}) ${p.label.padEnd(14)}${p.base || '（需手动输入地址）'}`);
        });
        console.error('');
        const pick = (await ask(`选择 [1-${keys.length}，默认 1]: `, '1')).trim();
        const idx = parseInt(pick, 10) || 1;
        const chosen = BASE_PRESETS[keys[idx - 1]] || BASE_PRESETS.cn;
        base = chosen.base || await ask('部署地址: ');
      }
      if (!base) fail('服务地址不能为空');
      if (!/^https?:\/\//.test(base)) base = 'https://' + base;
      base = base.replace(/\/$/, '');

      saveConfig({ base });
      console.error(`✓ 已保存服务地址到 ${CONFIG_PATH}`);

      // 2. 登录
      const me = await ensureAuth({ interactive: !!rl, user: f.user, pass: f.pass });

      if (f['no-info']) {
        out({ ok: true, base, config: CONFIG_PATH, user: me.username, team: me.team?.teamName });
        return;
      }

      // 3. 登录成功后自动展示环境快照（默认人类可读）
      console.error(`\n✓ 已连接 ${base}（${me.username} / ${me.team?.teamName}）`);
      console.error('  正在读取环境信息…\n');
      await commands['info']([], {});
    } finally {
      rl?.close();
    }
  },

  /**
   * 环境快照：账号连上后一次性摸清家底。
   * 默认快速版（只拉列表做统计），--deep 才逐个拉应用/知识库详情。
   */
  async 'info'(args, f) {
    const deep = !!f.deep;
    const t0 = Date.now();
    const R = {};   // 各项结果
    const errs = [];

    const safe = async (name, fn) => {
      try { return await fn(); } catch (e) { errs.push({ part: name, error: e.message }); return null; }
    };

    // 并发拉取基础数据
    const [me, plan, members, modelsData, appsData, dsData, keysData] = await Promise.all([
      safe('identity', () => client.get('/api/support/user/account/tokenLogin')),
      safe('plan', () => client.get('/api/support/user/team/plan/getTeamPlanStatus')),
      safe('members', async () => {
        const first = await client.post('/api/proApi/support/user/team/member/list', { teamId: null, searchKey: '', pageNum: 1, pageSize: 100 });
        return first;
      }),
      safe('models', () => client.get('/api/core/ai/model/list')),
      safe('apps', () => client.post('/api/core/app/listV2', { parentId: null, searchKey: '' })),
      safe('datasets', () => client.post('/api/core/dataset/list', { parentId: null, searchKey: '' })),
      safe('apiKeys', () => client.post('/api/support/openapi/list', { appId: null }))
    ]);

    // ---- 身份与权限 ----
    let identity = null, team = null, permissions = null, can = null;
    if (me) {
      const t = me.team || {};
      identity = {
        username: me.username, userId: me._id,
        timezone: me.timezone, language: me.language,
        hasPassword: !!me.hasPassword
      };
      team = { name: t.teamName, teamId: t.teamId, tmbId: t.tmbId, balance: t.balance, status: t.status };
      const p = t.permission || {};
      permissions = Object.fromEntries(
        Object.entries(p).filter(([, v]) => typeof v === 'boolean')
      );
      // 派生：语义化能力判断，agent 直接读 can.xxx，不用记原始字段名
      const b = k => p[k] === true;
      can = {
        read: b('hasReadPer') || b('isOwner'),
        write: b('hasWritePer') || b('isOwner'),
        createApp: b('hasAppCreatePer') || b('hasAppCreateRole') || b('isOwner'),
        createDataset: b('hasDatasetCreatePer') || b('hasDatasetCreateRole') || b('isOwner'),
        createApiKey: b('hasApikeyCreatePer') || b('hasApikeyCreateRole') || b('isOwner'),
        createSkill: b('hasSkillCreatePer') || b('hasSkillCreateRole') || b('isOwner'),
        manageModels: b('hasModelCreatePer') || b('hasModelCreateRole') || b('isOwner'),
        manageMembers: b('hasManagePer') || b('isOwner'),
        isOwner: b('isOwner')
      };
      can.readOnly = !can.write;
    }

    // ---- 套餐 ----
    let planInfo = null;
    if (plan?.standard) {
      const s = plan.standard;
      planInfo = {
        type: s.type, expiredTime: s.expiredTime,
        maxTeamMember: s.maxTeamMember,
        totalPoints: s.totalPoints,
        surplusPoints: s.surplusPoints != null ? Math.round(s.surplusPoints) : null
      };
    }

    // ---- 成员 ----
    let memberInfo = null;
    if (members) {
      const list = members.list || [];
      const byRole = {};
      for (const m of list) { const r = m.role || 'member'; byRole[r] = (byRole[r] || 0) + 1; }
      memberInfo = { total: members.total ?? list.length, byRole };
    }

    // ---- 模型 ----
    let modelInfo = null;
    if (modelsData) {
      const ms = modelsData.models || [];
      const byType = {};
      for (const m of ms) byType[m.type] = (byType[m.type] || 0) + 1;
      modelInfo = { total: ms.length, byType, llmNames: ms.filter(m => m.type === 'llm').map(m => m.name).slice(0, 5) };
    }

    // ---- 应用 ----
    let appInfo = null;
    const appList = appsData?.list || appsData || [];
    if (appsData) {
      const byType = {};
      for (const a of appList) byType[a.type] = (byType[a.type] || 0) + 1;
      appInfo = { total: appList.length, byType };
    }

    // ---- 知识库 ----
    let dsInfo = null;
    const dsList = dsData || [];
    if (dsData) {
      const byType = {}, byVector = {};
      for (const d of dsList) {
        byType[d.type] = (byType[d.type] || 0) + 1;
        const vm = typeof d.vectorModel === 'string' ? d.vectorModel : d.vectorModel?.name;
        if (vm) byVector[vm] = (byVector[vm] || 0) + 1;
      }
      dsInfo = { total: dsList.length, byType, byVectorModel: byVector };
    }

    // ---- API Key ----
    let keyInfo = null;
    if (keysData) keyInfo = { total: (keysData || []).length };

    // ---- 深度扫描 ----
    let deepInfo = null;
    if (deep) {
      const wfApps = appList.filter(a => ['advanced', 'simple', 'chatAgent'].includes(a.type));
      const modelIds = new Set();
      const topologies = [];
      for (const a of wfApps) {
        try {
          const d = await client.get(`/api/core/app/detail?appId=${a._id}`);
          for (const n of d.nodes || []) {
            for (const inp of n.inputs || []) {
              if (inp.key === 'modelId' && typeof inp.value === 'string' && /^[0-9a-f]{24}$/i.test(inp.value)) {
                modelIds.add(inp.value);
              }
            }
          }
          topologies.push({
            appId: a._id, name: a.name, type: a.type,
            nodes: (d.nodes || []).length, edges: (d.edges || []).length,
            published: !!d.publishedVersionId,
            nodeTypes: [...new Set((d.nodes || []).map(n => n.flowNodeType))]
          });
        } catch {}
      }
      const dsDetails = [];
      for (const d of dsList.filter(x => x.type === 'dataset')) {
        try {
          const cols = await client.post('/api/core/dataset/collection/listV2', {
            datasetId: d._id, parentId: null, pageNum: 1, pageSize: 1
          });
          dsDetails.push({ datasetId: d._id, name: d.name, documents: cols.total ?? 0 });
        } catch {}
      }
      deepInfo = { modelIds: [...modelIds], workflows: topologies, datasets: dsDetails };
    }

    const modelIdCount = deepInfo ? deepInfo.modelIds.length : (modelInfo ? '未知（加 --deep 统计）' : 0);
    const ready = !!me && (deep ? deepInfo.modelIds.length > 0 : true);

    const payload = {
      ok: !errs.length,
      base: getBase(),
      elapsed: `${Date.now() - t0}ms`,
      identity, team, permissions, can, plan: planInfo,
      members: memberInfo, models: modelInfo,
      apps: appInfo, datasets: dsInfo, apiKeys: keyInfo,
      ...(deepInfo ? { deep: deepInfo } : {}),
      ready,
      summary: !me
        ? '未登录，无法获取信息'
        : `${memberInfo?.total ?? '?'} 名成员 / ${modelInfo?.total ?? '?'} 个模型 / ${appInfo?.total ?? '?'} 个应用 / ${dsInfo?.total ?? '?'} 个知识库`
            + (planInfo?.surplusPoints != null ? ` / 剩余积分 ${planInfo.surplusPoints}` : '')
            + (deep ? ` / ${deepInfo.modelIds.length} 个可用 modelId` : '')
            + (can?.readOnly ? ' / ⚠ 只读账号' : ''),
      ...(errs.length ? { errors: errs } : {})
    };

    if (f.json) { out(payload); return; }
    if (!me) { out(payload); return; }

    // ---- 人类可读呈现 ----
    const num = n => n == null ? '-' : n.toLocaleString('en-US');
    const pad = (s, w) => {
      // 中文字符占 2 列，做个简单对齐
      const width = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
      return String(s) + ' '.repeat(Math.max(0, w - width));
    };
    const L = [];
    const line = '─'.repeat(46);

    L.push('');
    L.push('  FastGPT 环境');
    L.push('  ' + line);

    L.push(`  ${pad('用户', 10)}${identity.username}`);
    L.push(`  ${pad('团队', 10)}${team.name}`);
    const roleText = can?.isOwner ? '管理员（owner）'
      : can?.manageMembers ? '管理员'
      : can?.write ? '可写成员'
      : '只读成员';
    L.push(`  ${pad('身份', 10)}${roleText}`);

    if (planInfo) {
      const exp = planInfo.expiredTime ? new Date(planInfo.expiredTime).toISOString().slice(0, 10) : '-';
      L.push(`  ${pad('套餐', 10)}${planInfo.type}（到期 ${exp}）`);
      if (planInfo.surplusPoints != null) {
        L.push(`  ${pad('积分', 10)}剩余 ${num(planInfo.surplusPoints)} / 共 ${num(planInfo.totalPoints)}`);
      }
    }
    L.push('');

    L.push('  资源');
    L.push('  ' + line);
    const appTypes = appInfo?.byType || {};
    const wfCount = (appTypes.advanced || 0) + (appTypes.simple || 0) + (appTypes.chatAgent || 0);
    L.push(`  ${pad('工作流', 10)}${wfCount} 个${appTypes.advanced ? `（其中高级编排 ${appTypes.advanced}）` : ''}`);
    const dsTypes = dsInfo?.byType || {};
    L.push(`  ${pad('知识库', 10)}${dsTypes.dataset || 0} 个${dsTypes.folder ? `（另有 ${dsTypes.folder} 个文件夹）` : ''}`);
    if (deepInfo?.datasets?.length) {
      const withDocs = deepInfo.datasets.filter(d => d.documents > 0).length;
      const totalDocs = deepInfo.datasets.reduce((a, d) => a + d.documents, 0);
      L.push(`  ${pad('文档', 10)}${totalDocs} 篇（${withDocs} 个知识库有内容）`);
    }
    L.push(`  ${pad('应用总数', 10)}${appInfo?.total ?? 0} 个（含插件 ${appTypes.plugin || 0}、工具集 ${(appTypes.toolSet || 0) + (appTypes.toolFolder || 0)}）`);
    L.push(`  ${pad('成员', 10)}${memberInfo?.total ?? 0} 人`);
    const llmCount = modelInfo?.byType?.llm || 0;
    L.push(`  ${pad('模型', 10)}${llmCount} 个 LLM${modelInfo?.byType?.embedding ? `，${modelInfo.byType.embedding} 个向量模型` : ''}`);
    if (deepInfo) {
      L.push(`  ${pad('可用模型', 10)}${deepInfo.modelIds.length} 个 modelId 可提取`);
    }
    L.push('');

    L.push('  能力');
    L.push('  ' + line);
    const cap = (ok, text) => L.push(`  ${ok ? '✓' : '✗'} ${text}`);
    cap(can?.write, '创建 / 编辑工作流');
    cap(can?.createDataset, '创建知识库');
    cap(can?.createApiKey, '创建 API Key');
    cap(can?.manageMembers, '管理成员与权限');
    cap(can?.manageModels, '新增模型');
    L.push('');

    if (deepInfo?.workflows?.length) {
      L.push('  工作流明细');
      L.push('  ' + line);
      for (const w of deepInfo.workflows.slice(0, 12)) {
        L.push(`  ${pad(w.name.slice(0, 16), 20)}${w.nodes} 节点 / ${w.edges} 连线 ${w.published ? '已发布' : '草稿'}`);
      }
      if (deepInfo.workflows.length > 12) L.push(`  … 另有 ${deepInfo.workflows.length - 12} 个`);
      L.push('');
    }

    if (deepInfo?.datasets?.length) {
      L.push('  知识库明细');
      L.push('  ' + line);
      for (const d of deepInfo.datasets) {
        L.push(`  ${pad(d.name.slice(0, 16), 20)}${d.documents} 篇文档`);
      }
      L.push('');
    }

    if (!ready) {
      L.push('  ⚠ 环境未就绪，运行 fastgpt doctor 查看原因');
      L.push('');
    }

    console.log(L.join('\n'));
  },

  /**
   * 环境自检：一次性告诉用户/agent 现在能不能干活，缺什么。
   * 目的是把「跑到第三步才发现缺模型」提前到「一进来就知道」。
   */
  async 'doctor'(args, f) {
    const checks = [];
    const add = (name, ok, detail, fix) => checks.push({ check: name, ok, detail, ...(fix ? { fix } : {}) });

    // 1. 配置
    const base = getBase();
    add('服务地址', !!base, base || '未配置',
      base ? null : 'fastgpt init --preset cn|global|local，或 --preset private --base <地址>');

    // 2. 可达性 —— 必须是真的 FastGPT 服务端，不是官网页面
    if (base) {
      const t0 = Date.now();
      const norm = String(base).replace(/\/+$/, '');
      const host = (() => { try { return new URL(norm).host.toLowerCase(); } catch { return ''; } })();
      const isWebsite = !!WEBSITE_TO_PRESET[host];
      try {
        const r = await fetch(norm + '/api/common/system/getInitData', { signal: AbortSignal.timeout(8000) });
        const ms = Date.now() - t0;
        if (!r.ok) {
          add('服务可达', false, `HTTP ${r.status}（${base} 不是 FastGPT 服务端）`,
            isWebsite
              ? `${host} 是官网/文档站。用 fastgpt init --preset ${WEBSITE_TO_PRESET[host]}（${BASE_PRESETS[WEBSITE_TO_PRESET[host]].base}）`
              : `确认地址是否正确，或服务是否启动。SaaS 用 --preset cn / global，自建用 --preset local`);
        } else {
          const text = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          if (parsed?.code === 200) {
            add('服务可达', true, `${ms}ms`, null);
          } else {
            add('服务可达', false, '返回的不是 FastGPT API 响应（可能撞上了前端页面）',
              '检查 base 是否正确：国内 cloud.fastgpt.cn / 海外 cloud.fastgpt.io');
          }
        }
      } catch (e) {
        add('服务可达', false, e.message, '检查 FASTGPT_BASE 与网络');
      }
    } else {
      add('服务可达', false, '跳过（未配置地址）', 'fastgpt init');
    }

    // 3. 登录
    const me = base ? await checkAuth().catch(() => null) : null;
    add('登录状态', !!me, me ? `${me.username} / ${me.team?.teamName}` : '未登录', me ? null : 'fastgpt init');

    // 3.5 商业版 API（proApi）—— 权限相关命令全依赖它
    if (me) {
      let proOk = false, proDetail = '', proFix = null;
      try {
        const r = await fetch(getBase() + '/api/proApi/support/user/team/member/count', {
          headers: { Cookie: client.cookieHeader, 'fastgpt-web-request': 'fastgpt' },
          signal: AbortSignal.timeout(8000)
        });
        const text = await r.text();
        let j = null; try { j = JSON.parse(text); } catch {}
        if (j?.code === 200) {
          proOk = true; proDetail = '可用';
        } else if (/未配置商业版链接|FastGPTProUrl|pro.*url/i.test(text)) {
          proDetail = '未配置商业版（FastGPTProUrl 为空）';
          proFix = '当前是社区版。权限命令不可用：perm dataset/collection/app/member/team/invite ' +
                   '全部走 proApi，只有创建/上传/训练/检索这些 /api/core/* 能用。' +
                   '需要权限功能请升级到商业版并配置 FASTGPT_PRO_URL';
        } else if (r.status === 404) {
          proDetail = 'proApi 路由不存在（HTTP 404）';
          proFix = '当前版本没有商业版接口。权限命令不可用，其余命令正常';
        } else if (j?.code === 401 || j?.code === 403) {
          proDetail = `商业版 API 拒绝（${j?.message || r.status}）`;
          proFix = '检查登录状态；部分商业版功能需要对应套餐';
        } else {
          proDetail = `HTTP ${r.status} ${String(j?.message || '').slice(0, 60)}`;
          proFix = '权限命令可能不可用，其余命令不受影响';
        }
      } catch (e) {
        proDetail = e.message;
        proFix = '网络异常或 proApi 不可达';
      }
      add('商业版 API', proOk, proDetail, proFix);
    } else {
      add('商业版 API', false, '跳过（未登录）', 'fastgpt init');
    }

    // 4. 模型可用性（能否拿到 modelId）
    let modelIds = [];
    if (me) {
      try { modelIds = await scanModelIds(); } catch {}
      add('可用模型', modelIds.length > 0,
        modelIds.length ? `${modelIds.length} 个可提取的 modelId` : '没有任何应用配置过模型',
        modelIds.length ? null : '在 WebUI 任意应用中拖入「AI 对话」节点并选模型后保存，再运行 fastgpt model id');
    } else {
      add('可用模型', false, '跳过（未登录）', 'fastgpt init');
    }

    // 5. 知识库
    let dsCount = 0;
    if (me) {
      try {
        const d = await client.post('/api/core/dataset/list', { parentId: null, searchKey: '' });
        dsCount = (d || []).length;
      } catch {}
      add('知识库', true, `${dsCount} 个（知识库问答可选，非必需）`);
    }

    // 6. 应用
    let appCount = 0;
    if (me) {
      try {
        const d = await client.post('/api/core/app/listV2', { parentId: null, searchKey: '' });
        appCount = (d.list || d || []).length;
      } catch {}
      add('应用', true, `${appCount} 个`);
    }

    const blockers = checks.filter(c => !c.ok && c.fix);
    const canWork = !!me && modelIds.length > 0;

    out({
      ok: blockers.length === 0,
      ready: canWork,
      summary: canWork
        ? '环境就绪，可以建工作流（fastgpt wf build）'
        : '还不能建工作流，先解决下面标 ✗ 的项',
      checks,
      ...(blockers.length ? { next: blockers[0].fix } : {}),
      ...(!base ? { presets: Object.entries(BASE_PRESETS).map(([k, v]) => ({ preset: k, label: v.label, base: v.base })) } : {}),
      version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    });
  },

  // ===== 认证 =====
  async 'auth login'(args, f) {
    const user = f.user || process.env.FASTGPT_USER;
    const pass = f.pass || process.env.FASTGPT_PASS;
    // 无参数时走交互引导（密码 / 扫码）
    if (!user || !pass) {
      if (!process.stdin.isTTY) {
        fail(
          '在非交互环境下需要显式提供凭证。二选一：\n' +
          '  fastgpt auth login --user <账号> --pass <密码>\n' +
          '  fastgpt auth scan        # 打开浏览器扫码（需有图形界面）\n\n' +
          '如果是首次使用，建议先运行：fastgpt init'
        );
      }
      const me = await ensureAuth({ interactive: true });
      out({ ok: true, user: me.username, userId: me._id, team: me.team?.teamName, tmbId: me.team?.tmbId });
      return;
    }
    const u = await passwordLogin(user, pass);
    out({ ok: true, user: u.username, userId: u._id, team: u.team?.teamName, tmbId: u.team?.tmbId });
  },

  async 'auth scan'(args, f) {
    // 第二轮：继续未完成的会话
    if (f.wait && f['session-id']) {
      const me = await resumeScan(String(f['session-id']), { timeoutSec: Number(f.timeout) || 240 });
      out({ ok: true, user: me.username, userId: me._id, team: me.team?.teamName, tmbId: me.team?.tmbId });
      return;
    }
    // 第一轮：--no-wait 立即返回，交给用户操作
    const r = await scanLogin({ timeoutSec: Number(f.timeout) || 240, noWait: !!f['no-wait'] });
    if (r?.noWait) { out({ ok: true, ...r, action_required: 'user' }); return; }
    out({ ok: true, user: r.username, userId: r._id, team: r.team?.teamName, tmbId: r.team?.tmbId });
  },

  async 'auth whoami'() {
    const me = await checkAuth();
    if (!me) { out({ ok: false, error: '未登录或登录已失效', hint: '执行 fastgpt auth login 或 fastgpt auth scan' }); process.exit(1); }
    out(me);
  },

  async 'auth logout'() { client.clearCookie(); out({ ok: true }); },

  // ===== 模型 =====
  async 'model list'(args, f) {
    const d = await client.get('/api/core/ai/model/list');
    let ms = d.models;
    if (f.type) ms = ms.filter(m => m.type === f.type);
    out(ms.map(m => ({ name: m.name, provider: m.provider, type: m.type, testMode: m.testMode })));
  },

  /**
   * 从团队已有应用里提取可用的 modelId（ObjectId）。
   * 这是新账号获取 modelId 的唯一自动途径。
   */
  async 'model id'(args, f) {
    const want = f.name;   // 可选：按模型名筛选
    const apps = await client.post('/api/core/app/listV2', { parentId: null, searchKey: '' });
    const list = apps.list || apps || [];
    const found = [];
    const seen = new Set();

    for (const a of list) {
      if (!['advanced', 'simple', 'chatAgent'].includes(a.type)) continue;
      try {
        const d = await client.get(`/api/core/app/detail?appId=${a._id}`);
        for (const n of d.nodes || []) {
          for (const inp of n.inputs || []) {
            if (inp.key !== 'modelId') continue;
            const v = inp.value;
            if (typeof v !== 'string' || !/^[0-9a-f]{24}$/i.test(v)) continue;
            if (seen.has(v)) continue;
            seen.add(v);
            found.push({ modelId: v, fromApp: a.name, appId: a._id, node: n.nodeId });
          }
        }
      } catch { /* 单个应用读取失败不影响整体 */ }
    }

    if (!found.length) {
      out({
        ok: false,
        error: '当前团队没有任何应用配置过模型，无法自动获取 modelId',
        howToFix: [
          '方式 A（推荐）：在 FastGPT WebUI 里任选一个应用，左侧拖入「AI 对话」节点，',
          '           点击节点里的模型下拉框选中任意模型，保存（Ctrl+S），然后重新运行本命令。',
          '',
          '方式 B：如果团队里已有配置过模型的应用，确认它出现在 fastgpt app list 里。',
          '',
          '完成后运行：fastgpt model id'
        ]
      });
      process.exit(1);
    }

    // 成功拿到 modelId → 解除阻断
    clearBlock();
    out(want ? found.filter(x => x.modelId === want) : found);
  },

  // ===== 应用 =====
  async 'app list'(args, f) {
    const d = await client.post('/api/core/app/listV2', { parentId: null, searchKey: f.search || '', type: f.type || undefined });
    out((d.list || d).map?.(x => ({ _id: x._id, name: x.name, type: x.type })) || d);
  },

  async 'app create'(args, f) {
    const { name, type = 'advanced' } = f;
    if (!name) fail('需要 --name');
    const appId = await client.post('/api/core/app/create', {
      name, type, avatar: f.avatar || 'core/app/type/workflowFill', intro: f.intro || ''
    });
    out(withNotice(
      { ok: true, appId },
      type === 'plugin' ? Notice.pluginPublished(appId) : Notice.appCreated(appId)
    ));
  },

  async 'app delete'(args, f) {
    const appId = f.appId || args[0];
    if (!appId) fail('用法: app delete <appId>');
    const ids = String(appId).split(',');
    const deleted = await client.del(`/api/core/app/del?appId=${ids.join(',')}`);
    out({ ok: true, deleted: Array.isArray(deleted) ? deleted : ids });
  },

  async 'app detail'(args, f) {
    const appId = f.appId || args[0];
    if (!appId) fail('需要 appId');
    const d = await client.get(`/api/core/app/detail?appId=${appId}`);
    out({ appId: d._id, name: d.name, type: d.type, publishedVersionId: d.publishedVersionId,
          nodeCount: (d.nodes || []).length, edgeCount: (d.edges || []).length, nodes: d.nodes, edges: d.edges, chatConfig: d.chatConfig });
  },

  // ===== 分享渠道 =====

  /**
   * 创建分享。type: share(链接) | iframe(嵌入) | apikey(API)
   * 用法: app share create --appId X --name "..." --type share [--qpm 1000] [--anonymous]
   */
  async 'app share create'(args, f) {
    const appId = f.appId || args[0];
    const type = f.type || 'share';
    if (!appId) fail('需要 --appId');
    if (!['share', 'iframe', 'apikey'].includes(type)) fail('--type 只能是 share / iframe / apikey');

    const body = {
      appId, type,
      name: f.name || `${type}-${Date.now()}`,
      showCite: !!f['show-cite'],
      showRunningStatus: !!f['show-status'],
      showFullText: !!f['show-fulltext'],
      canDownloadSource: !!f['can-download'],
      showWholeResponse: true,
      allowAnonymous: f.anonymous !== false && f.anonymous !== 'false',
      limit: {
        QPM: Number(f.qpm) || 1000,
        maxUsagePoints: f.maxUsagePoints !== undefined ? Number(f.maxUsagePoints) : -1
      }
    };
    const shareId = await client.post('/api/support/outLink/create', body);
    const base = client.base;
    const url = type === 'share'
      ? `${base}/chat/share?shareId=${shareId}`
      : type === 'iframe'
        ? `${base}/chat/share?shareId=${shareId}&iframe=true`
        : null;
    out({ ok: true, shareId, type, url, appId, name: body.name });
  },

  async 'app share list'(args, f) {
    const appId = f.appId || args[0];
    if (!appId) fail('需要 --appId');
    const types = f.type ? [f.type] : ['share', 'iframe', 'apikey'];
    const all = [];
    for (const t of types) {
      const d = await client.get(`/api/support/outLink/list?appId=${appId}&type=${t}`);
      for (const x of d || []) {
        all.push({
          _id: x._id, shareId: x.shareId, type: x.type, name: x.name,
          appId: x.appId, allowAnonymous: x.allowAnonymous,
          qpm: x.limit?.QPM, usagePoints: x.usagePoints,
          url: x.type === 'share' ? `${client.base}/chat/share?shareId=${x.shareId}`
             : x.type === 'iframe' ? `${client.base}/chat/share?shareId=${x.shareId}&iframe=true`
             : null
        });
      }
    }
    out(all);
  },

  async 'app share delete'(args, f) {
    const id = f.id || args[0];
    if (!id) fail('用法: app share delete <_id>');
    await client.del(`/api/support/outLink/delete?id=${id}`);
    out({ ok: true, deleted: id });
  },

  // ===== 工作流 =====
  /**
   * 从 DSL 构建并保存
   * DSL: { appId, versionName?, publish?, modelId, nodes:[{type,id,...}], edges:[[src,tgt,key?]] }
   */
  async 'wf build'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 DSL 文件路径');
    const wf = loadWorkflow(file, f);
    const appId = wf.raw.appId || f.appId;
    if (!appId) fail('DSL 需要 appId');

    let { nodes, edges, chatConfig } = wf;
    if (wf.fixes.length) {
      console.error('\n🔧 已自动规范化（这些写法服务端能跑，但前端/画布不认）：');
      wf.fixes.forEach(x => {
        console.error(`   ${x.where}: ${x.from} → ${x.to}`);
        console.error(`     ${x.reason}`);
      });
      console.error('');
    }

    // 内在参数自动调整（在 modelId 预检之前，避免给出基于错误参数的结论）
    const tuned = autoTuneNodeParams(nodes);
    if (tuned.length) {
      console.error('\n⚙️  已自动调整节点参数：');
      tuned.forEach(c => {
        const from = c.from === undefined ? '(未设置)' : c.from;
        console.error(`   ${c.node}.${c.param}: ${from} → ${c.to}`);
        console.error(`     ${c.reason}`);
      });
      console.error('');
    }

    // dry-run 和真实部署走同一套校验（都要验证 modelId 真实性）
    if (!f['no-model-hook']) {
      nodes = await ensureModelIdHook(nodes, { autoFill: !f['no-auto-model'] });
    }

    const v = validateWorkflow({ nodes, edges, chatConfig });
    if (!v.ok) {
      failCli('workflow_validate_failed', {
        hint: v.next,
        details: { errors: v.errors, warnings: v.warnings, issues: v.issues,
                   autoFixable: v.issues.filter(i => i.fix === 'auto').length,
                   manualFixRequired: v.issues.filter(i => i.fix !== 'auto').length }
      });
    }

    const ids = await verifyResourceIds(nodes);
    if (ids.invalid.length) {
      failCli('dataset_not_found', {
        message: `引用了当前团队不存在的知识库：${ids.invalid.join(', ')}`,
        hint: '运行 fastgpt ds list 查看可用知识库 ID',
        details: { invalidDatasetIds: ids.invalid }
      });
    }

    if (f['dry-run']) {
      out(withNotice(
        { ok: true, dryRun: true, nodes: nodes.length, edges: edges.length,
          warnings: v.warnings, verified: { modelId: true, datasetIds: ids.checked } },
        Notice.dryRunOnly()
      ));
      return;
    }

    const published = wf.raw.publish !== false;
    await deployWorkflow({ appId, nodes, edges, chatConfig, versionName: wf.raw.versionName, publish: published });
    const payload = { ok: true, appId, nodes: nodes.length, edges: edges.length, publish: published, warnings: v.warnings };
    out(published ? payload : withNotice(payload, Notice.notPublished()));
  },

  /** 纯语法检查：离线，不验证 ID 真实性，不代表可部署 */
  /**
   * 离线体检：规范化 → 校验。
   * --fix <out>      写出规范化结果（可直接喂 wf build）
   * --inline-consts  canEdit 常量内联进代码（内容级修改，默认关）
   */
  async 'wf lint'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 JSON 文件路径');
    const r = lintWorkflow(file, f);

    if (f.fix) {
      fs.writeFileSync(f.fix, JSON.stringify({ nodes: r.nodes, edges: r.edges, chatConfig: r.chatConfig }, null, 2));
    }
    out({
      ok: r.ok,
      lintOnly: true,
      note: '仅语法 + 渲染契约检查，未验证 modelId / datasetId 真实性，不代表可部署',
      nodes: r.nodes.length,
      edges: r.edges.length,
      autoFixed: r.fixes,
      errors: r.errors,
      warnings: r.warnings,
      issues: r.issues,
      autoFixable: r.autoFixable,
      manualFixRequired: r.manualFixRequired,
      ...(r.unresolvedModelIds.length ? { unresolvedModelIds: r.unresolvedModelIds } : {}),
      ...(f.fix ? { fixedFile: f.fix } : {}),
      next: r.ok
        ? (f.fix
            ? `已写出规范化结果 ${f.fix}，可直接 fastgpt wf build ${f.fix}`
            : '语法没问题。部署用 fastgpt wf build <file>；想一次跑完全链路用 fastgpt wf verify')
        : (r.next || '先修正 errors，再运行 fastgpt wf build')
    });
    if (!r.ok) process.exit(2);
  },

  /** wf validate 是 wf lint 的别名（历史命令，保留兼容） */
  async 'wf validate'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 JSON 文件路径');
    const r = lintWorkflow(file, f);
    out({ ok: r.ok, nodeCount: r.nodes.length, edgeCount: r.edges.length,
          errors: r.errors, warnings: r.warnings, issues: r.issues,
          autoFixed: r.fixes, next: r.next });
    if (!r.ok) process.exit(2);
  },

  async 'wf get'(args, f) {
    const appId = f.appId || args[0];
    const d = await client.get(`/api/core/app/detail?appId=${appId}`);
    const payload = { nodes: d.nodes, edges: d.edges, chatConfig: d.chatConfig };
    if (f.out) { fs.writeFileSync(f.out, JSON.stringify(payload, null, 2)); out({ ok: true, file: f.out }); }
    else out(payload);
  },

  async 'wf publish'(args, f) {
    const appId = f.appId || args[0];
    const d = await client.get(`/api/core/app/detail?appId=${appId}`);
    await client.post(`/api/core/app/version/publish?appId=${appId}`, {
      nodes: d.nodes, edges: d.edges, chatConfig: d.chatConfig,
      isPublish: true, autoSave: false, versionName: f.name || 'publish'
    });
    out(withNotice(
      { ok: true, appId },
      type === 'plugin' ? Notice.pluginPublished(appId) : Notice.appCreated(appId)
    ));
  },

  /**
   * 提交 vs 落库：服务端 migration 到底改了你什么。
   * 服务端保存时会迁移结构、补默认值、补异常边，这些都不在响应里 —— 只能读回比。
   * 用法：wf diff <appId> <file>
   */
  async 'wf diff'(args, f) {
    const appId = f.appId || args[0];
    const file = f.file || args[1];
    if (!appId) fail('需要 appId');
    if (!file) fail('需要 workflow 文件（DSL 或原生导出 JSON）');

    // 与 build 对齐：loadWorkflow 已做规范化，否则会把「我们会自动修的」误报成服务端改动
    const wf = loadWorkflow(file, f);

    const stored = await client.get(`/api/core/app/detail?appId=${appId}`);
    const diff = diffWorkflow({
      submitted: { nodes: wf.nodes, edges: wf.edges, chatConfig: wf.chatConfig },
      stored: { nodes: stored.nodes || [], edges: stored.edges || [], chatConfig: stored.chatConfig || {} }
    });

    const significant = diff.added.length + diff.removed.length + diff.injected.length + diff.stripped.length + diff.changed.length;
    out(withNotice(
      {
        ok: diff.stripped.length === 0 && diff.removed.length === 0,
        appId,
        file,
        comparedAgainst: 'app.nodes（草稿，UI 实际显示的）',
        verdict: diff.verdict,
        counts: {
          added: diff.added.length,
          removed: diff.removed.length,
          injected: diff.injected.length,
          stripped: diff.stripped.length,
          changed: diff.changed.length,
          whitelisted: diff.whitelistedCount
        },
        added: diff.added,
        removed: diff.removed,
        injected: diff.injected,
        stripped: diff.stripped,
        changed: diff.changed,
        whitelisted: diff.whitelisted,
        next: significant === 0
          ? '提交与落库一致，本地文件可以作为 source of truth'
          : diff.verdict === 'data_loss'
            ? '有字段/节点没落库（被 schema strip 或被 migration 丢弃），后续编辑会丢配置：先合并进本地文件再继续'
            : '服务端做了规范化（非破坏）。落库形态才是真的，二次编辑请基于 wf get 的结果'
      },
      diff.verdict === 'data_loss' ? {
        type: 'data_loss',
        message: '提交的内容有丢失（stripped/removed 非空）',
        hint: '把 stripped/removed 里的项合并回本地文件；落库形态才是 source of truth'
      } : null
    ));
    if (diff.verdict === 'data_loss') process.exit(2);
  },

  /**
   * 一条龙验证：lint → dry-run → 部署 → diff → 运行时 →（可选）UI。
   * 默认在「影子应用」上做，跑完自动删除；--appId 则直接对指定应用跑（会写入）。
   * 任一步失败即停，返回 failedAt + 该步 hint + 已跑完的步骤轨迹。
   */
  async 'wf verify'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 workflow 文件（DSL 或原生导出 JSON）');

    const steps = [];
    const t0 = Date.now();
    const push = (step, ok, detail = {}) => steps.push({ step, ok, ms: Date.now() - t0, ...detail });
    const stop = (step, hint, details) => {
      out({ ok: false, failedAt: step, file, steps, hint, ...(details ? { details } : {}),
            next: `修掉 ${step} 的问题后重跑 fastgpt wf verify ${file}` });
      process.exit(2);
    };

    // ① 离线体检 + 规范化
    const lint = lintWorkflow(file, f);
    push('lint', lint.ok, {
      nodes: lint.nodes.length, edges: lint.edges.length,
      autoFixed: lint.fixes.length, issues: lint.issues.length, manualFixRequired: lint.manualFixRequired
    });
    if (!lint.ok) stop('lint', lint.next || '先修 lint 的 manual 项', { issues: lint.issues });

    // ② 目标：默认影子应用（不碰生产）
    const mode = f.appId ? 'app' : 'shadow';
    let appId = f.appId;
    if (mode === 'shadow') {
      appId = await client.post('/api/core/app/create', {
        name: f.name || `cli-verify-${Date.now()}`, type: 'advanced',
        avatar: 'core/app/type/workflowFill', intro: ''
      });
    }
    push('target', true, { mode, appId });

    try {
      // ③ 校验 + ID 真实性
      let { nodes, edges, chatConfig } = lint;
      if (!f['no-model-hook']) nodes = await ensureModelIdHook(nodes, { autoFill: !f['no-auto-model'] });
      const v = validateWorkflow({ nodes, edges, chatConfig });
      if (!v.ok) { push('validate', false, { errors: v.errors }); stop('validate', v.next, { issues: v.issues }); }
      const ids = await verifyResourceIds(nodes);
      if (ids.invalid.length) {
        push('resource_ids', false, { invalid: ids.invalid });
        stop('resource_ids', 'datasetId 不在当前团队：先 fastgpt ds list 确认', { invalidDatasetIds: ids.invalid });
      }
      push('validate', true, { datasetIds: ids.checked, warnings: v.warnings.length });

      // ④ 部署
      await deployWorkflow({ appId, nodes, edges, chatConfig, versionName: f.versionName || 'cli-verify', publish: true });
      push('deploy', true, { nodes: nodes.length, edges: edges.length });

      // ⑤ 提交 vs 落库
      const stored = await client.get(`/api/core/app/detail?appId=${appId}`);
      const diff = diffWorkflow({
        submitted: { nodes, edges, chatConfig },
        stored: { nodes: stored.nodes || [], edges: stored.edges || [], chatConfig: stored.chatConfig || {} }
      });
      push('diff', diff.verdict !== 'data_loss', {
        verdict: diff.verdict,
        counts: { added: diff.added.length, removed: diff.removed.length, injected: diff.injected.length,
                  stripped: diff.stripped.length, changed: diff.changed.length, whitelisted: diff.whitelistedCount }
      });
      if (diff.verdict === 'data_loss') {
        stop('diff', '提交的内容有丢失（stripped/removed 非空），先合并回本地文件', { stripped: diff.stripped, removed: diff.removed });
      }

      // ⑥ 运行时（没有 apikey 就跳过，不算失败）
      const keyFile = f.keyFile || '.fastgpt/apikey';
      const key = f.key || process.env.FASTGPT_APP_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
      let variables;
      if (f.variables) { try { variables = JSON.parse(f.variables); } catch { fail('--variables 需要 JSON 字符串'); } }
      if (!key) {
        push('run', true, { skipped: `没有 API Key（${keyFile}），跳过运行时体检` });
      } else {
        const r = await runWorkflowOnce({ appId, key, variables, question: f.q, chatId: f.chatId });
        push('run', r.ok, {
          httpStatus: r.httpStatus, Status: r.Status, DataSetDate: r.DataSetDate,
          domains: r.domains, unresolved: r.unresolvedVariables, trace: r.trace
        });
        if (!r.ok) stop('run', '运行时不通过：变量没替换或契约异常', r);
      }

      // ⑦ 可选 UI 校验（外挂命令，保持 CLI 零依赖；{appId} 会被替换）
      if (f['ui-cmd']) {
        const { execSync } = await import('node:child_process');
        const cmd = String(f['ui-cmd']).replace(/\{appId\}/g, appId);
        try {
          const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          push('ui', true, { cmd, tail: String(stdout).trim().slice(-400) });
        } catch (e) {
          push('ui', false, { cmd, exit: e.status });
          stop('ui', 'UI 校验未通过（前端仍有报错/裸变量/缺芯片）', { tail: String(e.stdout || e.stderr || '').trim().slice(-1500) });
        }
      }
    } finally {
      if (mode === 'shadow' && f.keep !== true) {
        try { await client.del(`/api/core/app/del?appId=${appId}`); push('cleanup', true, { appId }); }
        catch (e) { push('cleanup', false, { appId, error: e.message }); }
      } else if (mode === 'shadow') {
        push('cleanup', true, { appId, kept: true });
      }
    }

    const total = Date.now() - t0;
    out(withNotice({
      ok: true,
      file,
      target: { mode, appId },
      verdict: 'all_passed',
      totalMs: total,
      steps,
      next: mode === 'shadow'
        ? `影子应用验证通过。对生产应用执行：fastgpt wf verify ${file} --appId <appId>`
        : '全链路通过，可以交付'
    }, {
      type: 'verify_passed',
      message: '全链路通过',
      hint: mode === 'shadow' ? '影子应用已删除（--keep 可保留）；生产应用尚未写入' : undefined
    }));
  },

  /**
   * 规则集对齐：本地校验规则是照某一版平台行为写死的，平台升级会漂。
   * 这个命令拉目标实例版本，与内置规则集校准版本比对，让漂移可见。
   * 只能比版本号 —— 要拿到目标实例真实码集必须抓它的前端 chunk（见 --calibrate）。
   */
  async 'wf ruleset'(args, f) {
    let systemVersion;
    let base = client.base;
    try {
      const d = await client.get('/api/common/system/getInitData');
      systemVersion = d?.systemVersion;
    } catch (e) {
      // 未登录也能报出版本（有些实例该接口公开）；真拿不到就标 unknown
    }
    const cmp = compareRuleset({ targetVersion: systemVersion });

    if (f.calibrate) {
      out({ ok: true, base, target: { systemVersion }, compare: cmp, calibrate: calibrateRuleset() });
      return;
    }

    out(withNotice({
      ok: true,
      base,
      target: { systemVersion: systemVersion || 'unknown' },
      compare: cmp,
      localIssueCodes: Object.keys(cmp).length ? undefined : undefined,
      officialCodeSample: DIAGNOSTIC_CODES.slice(0, 6),
      next: cmp.versionMatch
        ? '版本对齐。校验结论可直接参考；平台升级后再跑一次本命令'
        : '版本漂移：跑 fastgpt wf ruleset --calibrate 获取重新校准步骤'
    }, cmp.versionMatch ? null : {
      type: 'ruleset_drift',
      message: `内置规则集按 ${cmp.calibratedWith} 校准，目标实例是 ${cmp.targetVersion}`,
      hint: '版本不一致不代表一定错，但「平台新增的规则我不知道」这类风险会出现；按 --calibrate 的步骤重新校准'
    }));
  },

  /** 草稿 / 版本层一致性：判断「我改的东西到底写进哪一层了」 */
  async 'wf versions'(args, f) {
    const appId = f.appId || args[0];
    if (!appId) fail('需要 appId');
    const fp = nodes => {
      const sig = (nodes || []).map(n => `${n.nodeId}:${(n.inputs || []).map(i => i.key).join('|')}`).join('\n');
      let h = 0;
      for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
      return { nodes: (nodes || []).length, hash: (h >>> 0).toString(16) };
    };
    const draft = await client.get(`/api/core/app/detail?appId=${appId}`);
    const latest = await client.get(`/api/core/app/version/latest?appId=${appId}`);
    const list = await client.post('/api/core/app/version/list', { appId, offset: 0, pageSize: f.count || 5 });
    const rows = [
      { layer: 'draft(app.nodes)', id: draft._id, time: draft.updateTime, fp: fp(draft.nodes), publishedVersionId: draft.publishedVersionId },
      { layer: 'version/latest', id: latest._id, name: latest.versionName, fp: fp(latest.nodes) }
    ];
    for (const v of (list.list || list)) {
      const d = await client.get(`/api/core/app/version/detail?appId=${appId}&versionId=${v._id}`).catch(() => ({ nodes: [] }));
      rows.push({ layer: v.isPublish ? 'version(published)' : 'version(draft)', id: v._id, name: v.versionName, time: v.time, fp: fp(d.nodes) });
    }
    const published = rows.find(r => r.layer === 'version(published)');
    out({
      ok: true,
      appId,
      rows,
      consistent: published ? draft && fp(draft.nodes).hash === published.fp.hash : null,
      note: 'OpenAPI 跑发布版本，UI 看草稿。编辑器一打开前端会 autoSave 覆盖草稿，两者不一致时先 publish 再判断。'
    });
  },

  async 'wf check-run'(args, f) {
    const appId = f.appId || args[0];
    if (!appId) fail('需要 appId');
    const keyFile = f.keyFile || '.fastgpt/apikey';
    const key = f.key || process.env.FASTGPT_APP_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
    if (!key) fail('缺少 API Key：先 fastgpt apikey create --name cli，或传 --key');
    let variables;
    if (f.variables) {
      try { variables = JSON.parse(f.variables); } catch { fail('--variables 需要 JSON 字符串'); }
    }

    const r = await runWorkflowOnce({ appId, key, variables, question: f.q, chatId: f.chatId });
    if (r.httpStatus !== 200) fail(`对话接口返回 ${r.httpStatus}: ${r.error || ''}`);

    out(withNotice({ appId, ...r }, r.ok ? null : {
      type: 'unresolved_variable',
      message: '运行时有变量没被替换，值里残留 {{...}}',
      hint: '检查该节点输入是否引用了未定义/未传值的全局变量；wf lint 能提前发现裸占位'
    }));
    if (!r.ok) process.exit(2);
  },

  // ===== 知识库 =====
  async 'ds list'(args, f) {
    const d = await client.post('/api/core/dataset/list', { parentId: null, searchKey: f.search || '' });
    out((d || []).map(x => ({ _id: x._id, name: x.name, type: x.type, vectorModel: x.vectorModel?.name })));
  },

  async 'ds create'(args, f) {
    if (!f.name) fail('需要 --name');
    const id = await client.post('/api/core/dataset/create', {
      parentId: f.parentId || null, name: f.name, type: 'dataset', intro: f.intro || '',
      avatar: f.avatar || 'core/dataset/commonDatasetColor'
    });
    out({ ok: true, datasetId: id });
  },

  /** 查自己对某个资源有什么权限（只读/读写/管理） */
  async 'ds permission'(args, f) {
    const id = f.id || args[0];
    if (!id) fail('用法: ds permission <datasetId>');
    // getPermission 返回的字段不完整（只有 read/write），权限对象要从协作者列表拿
    const [detail, clbs] = await Promise.all([
      client.get(`/api/core/dataset/getPermission?id=${id}`).catch(() => null),
      client.get(`/api/proApi/core/dataset/collaborator/list?datasetId=${id}`).catch(() => null)
    ]);
    const me = (clbs?.clbs || []).find(c => c.permission?.isOwner) || (clbs?.clbs || [])[0];
    const p = me?.permission || {};
    out({
      datasetId: id,
      name: detail?.datasetName,
      read: !!p.hasReadPer,
      write: !!p.hasWritePer,
      manage: !!p.hasManagePer,
      isOwner: !!p.isOwner,
      permissionValue: p.permission,
      canSetCollaborator: !!p.hasManagePer,
      collaborators: (clbs?.clbs || []).map(c => ({
        tmbId: c.tmbId, name: c.name, permission: c.permission?.permission
      }))
    });
  },

  async 'ds detail'(args, f) {
    const id = f.id || args[0];
    const d = await client.get(`/api/core/dataset/detail?id=${id}`);
    out({ _id: d._id, name: d.name, type: d.type, vectorModel: d.vectorModel?.name, collectionCount: d.collectionCount });
  },

  /** 上传本地文件创建文档。默认分块训练 + 全增强 */
  async 'ds add-file'(args, f) {
    const datasetId = f.datasetId || args[0];
    const filePath = f.file || args[1];
    if (!datasetId || !filePath) fail('用法: ds add-file <datasetId> <文件路径>');
    if (!fs.existsSync(filePath)) fail(`文件不存在: ${filePath}`);

    const d = await client.upload('/api/core/dataset/collection/create/localFile', {
      fields: { data: JSON.stringify({
        datasetId, parentId: f.parentId || null,
        trainingType: 'chunk', chunkTriggerType: 'forceChunk',
        chunkSettingMode: 'custom', chunkSplitMode: 'size',
        chunkSize: Number(f.chunkSize) || 2000, indexSize: Number(f.chunkSize) || 2000,
        customPdfParse: true, autoIndexes: true, imageIndex: true,
        dataEnhanceCollectionName: true, indexPrefixTitle: true
      }) },
      file: { name: f.name || path.basename(filePath), buffer: fs.readFileSync(filePath) }
    });
    out(withNotice(
      { ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen },
      Notice.trainingAsync(d.collectionId)
    ));
  },

  /** 纯文本创建文档 */
  async 'ds add-text'(args, f) {
    const datasetId = f.datasetId || args[0];
    const text = f.text || (f.file ? fs.readFileSync(f.file, 'utf8') : null);
    if (!datasetId || !text) fail('用法: ds add-text <datasetId> --name "标题" --text "内容"');
    const d = await client.post('/api/core/dataset/collection/create/text', {
      datasetId, name: f.name || `text-${Date.now()}`, text,
      trainingType: 'chunk', chunkTriggerType: 'forceChunk',
      chunkSettingMode: 'custom', chunkSplitMode: 'size',
      chunkSize: Number(f.chunkSize) || 2000, indexSize: Number(f.chunkSize) || 2000,
      customPdfParse: true, autoIndexes: true, imageIndex: true,
      dataEnhanceCollectionName: true, indexPrefixTitle: true
    });
    out(withNotice(
      { ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen },
      Notice.trainingAsync(d.collectionId)
    ));
  },

  /** 网页链接创建文档 */
  async 'ds add-link'(args, f) {
    const datasetId = f.datasetId || args[0];
    const link = f.url || args[1];
    if (!datasetId || !link) fail('用法: ds add-link <datasetId> <url> [--selector "css"]');
    const d = await client.post('/api/core/dataset/collection/create/link', {
      datasetId, link,
      name: f.name || link,
      selector: f.selector || '',
      trainingType: 'chunk', chunkTriggerType: 'forceChunk',
      chunkSettingMode: 'custom', chunkSplitMode: 'size',
      chunkSize: Number(f.chunkSize) || 2000, indexSize: Number(f.chunkSize) || 2000,
      customPdfParse: true, autoIndexes: true, imageIndex: true,
      dataEnhanceCollectionName: true, indexPrefixTitle: true
    });
    out(withNotice(
      { ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen },
      Notice.trainingAsync(d.collectionId)
    ));
  },

  /** 文档列表 */
  async 'ds collections'(args, f) {
    const datasetId = f.datasetId || args[0];
    if (!datasetId) fail('用法: ds collections <datasetId>');
    const d = await client.post('/api/core/dataset/collection/listV2', {
      datasetId, parentId: f.parentId || null,
      pageNum: Number(f.page) || 1, pageSize: Number(f.size) || 20,
      searchText: f.search || ''
    });
    out({
      total: d.total,
      list: (d.list || []).map(c => ({
        _id: c._id, name: c.name, type: c.type,
        trainingType: c.trainingType, fileId: c.fileId,
        createTime: c.createTime
      }))
    });
  },

  /** 训练状态 */
  async 'ds training'(args, f) {
    const collectionId = f.id || args[0];
    if (!collectionId) fail('用法: ds training <collectionId>');
    const d = await client.get(`/api/core/dataset/collection/trainingDetail?collectionId=${collectionId}`);
    const pending = Object.fromEntries(Object.entries(d.queuedCounts || {}).filter(([, v]) => v > 0));
    const errored = Object.fromEntries(Object.entries(d.errorCounts || {}).filter(([, v]) => v > 0));
    out({
      collectionId,
      trainingType: d.trainingType,
      advancedTraining: d.advancedTraining,
      pending,
      errors: errored,
      done: Object.keys(pending).length === 0,
      hint: Object.keys(pending).length ? '还在训练，检索会返回空，请继续轮询' : '训练完成，可以检索'
    });
  },

  /** 重新训练 */
  async 'ds retrain'(args, f) {
    const collectionId = f.id || args[0];
    if (!collectionId) fail('用法: ds retrain <collectionId>');
    await client.post('/api/core/dataset/collection/create/reTrainingCollection', {
      collectionId,
      trainingType: f.mode || 'chunk',
      chunkTriggerType: 'forceChunk'
    });
    out({ ok: true, collectionId });
  },

  /** 查看文档切分后的数据块 */
  async 'ds data'(args, f) {
    const collectionId = f.id || args[0];
    if (!collectionId) fail('用法: ds data <collectionId>');
    const d = await client.post('/api/core/dataset/data/v2/list', {
      collectionId, pageNum: Number(f.page) || 1, pageSize: Number(f.size) || 20
    });
    out({ total: d.total, list: (d.list || []).map(x => ({ _id: x._id, q: x.q?.slice(0, 80), a: x.a?.slice(0, 80) })) });
  },

  /**
   * 批量上传：支持目录递归 / 多文件 / 扩展名过滤 / 并发
   * 用法: ds add-batch <datasetId> <路径...> [--ext pdf,docx] [--concurrency 3]
   */
  async 'ds add-batch'(args, f) {
    const datasetId = f.datasetId || args[0];
    const paths = args.slice(1);
    if (!datasetId || !paths.length) fail('用法: ds add-batch <datasetId> <文件或目录...> [--ext pdf,md]');

    const exts = f.ext ? String(f.ext).split(',').map(e => e.trim().replace(/^\./, '')).filter(Boolean) : null;
    const files = [];
    const walk = p => {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      } else {
        if (exts && !exts.some(e => p.toLowerCase().endsWith('.' + e.toLowerCase()))) return;
        if (path.basename(p).startsWith('.')) return;
        files.push(p);
      }
    };
    for (const p of paths) {
      if (!fs.existsSync(p)) fail(`路径不存在: ${p}`);
      walk(p);
    }
    if (!files.length) fail('没有匹配到文件');

    const trainingData = JSON.stringify({
      datasetId, parentId: f.parentId || null,
      trainingType: 'chunk', chunkTriggerType: 'forceChunk',
      chunkSettingMode: 'custom', chunkSplitMode: 'size',
      chunkSize: Number(f.chunkSize) || 2000, indexSize: Number(f.chunkSize) || 2000,
      customPdfParse: true, autoIndexes: true, imageIndex: true,
      dataEnhanceCollectionName: true, indexPrefixTitle: true
    });

    const results = [];
    let cursor = 0;
    const conc = Math.max(1, Number(f.concurrency) || 3);

    async function worker() {
      while (cursor < files.length) {
        const filePath = files[cursor++];
        try {
          const d = await client.upload('/api/core/dataset/collection/create/localFile', {
            fields: { data: trainingData },
            file: { name: path.basename(filePath), buffer: fs.readFileSync(filePath) }
          });
          results.push({ file: filePath, ok: true, collectionId: d.collectionId });
          console.error(`  ✓ ${path.basename(filePath)}`);
        } catch (e) {
          results.push({ file: filePath, ok: false, error: e.message });
          console.error(`  ✗ ${path.basename(filePath)}: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, files.length) }, worker));

    const okCount = results.filter(r => r.ok).length;
    out({ ok: okCount === files.length, total: files.length, success: okCount, failed: files.length - okCount, results });
  },

  /**
   * QA 模式：导入问答对
   * 用法: ds add-qa <datasetId> --file qa.json [--name FAQ]
   *       ds add-qa <datasetId> --q "问题" --a "答案"
   *       ds add-qa <datasetId> --file qa.json --collectionId <已有集合>
   */
  async 'ds add-qa'(args, f) {
    const datasetId = f.datasetId || args[0];
    if (!datasetId) fail('用法: ds add-qa <datasetId> --file qa.json | --q "问" --a "答"');

    // 构造问答对
    let pairs = [];
    if (f.file) {
      const raw = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      pairs = Array.isArray(raw) ? raw : (raw.data || raw.list || []);
    } else if (f.q && f.a !== undefined) {
      pairs = [{ q: f.q, a: f.a }];
    } else {
      fail('需要 --file qa.json 或 --q/--a');
    }
    if (!pairs.length) fail('问答对为空');
    for (const [i, p] of pairs.entries()) {
      if (typeof p.q !== 'string' || !p.q) fail(`第 ${i + 1} 条缺少 q`);
    }

    // 集合：指定或新建 QA 集合
    let collectionId = f.collectionId;
    if (!collectionId) {
      collectionId = await client.post('/api/core/dataset/collection/create', {
        datasetId, name: f.name || `FAQ-${Date.now()}`, type: 'virtual', trainingType: 'qa'
      });
      if (collectionId && typeof collectionId === 'object') collectionId = collectionId.collectionId;
    }

    // 逐条插入（接口不支持批量）
    const inserted = [];
    const failed = [];
    for (const [i, p] of pairs.entries()) {
      try {
        const d = await client.post('/api/core/dataset/data/insertData', {
          collectionId, q: p.q, a: p.a ?? ''
        });
        inserted.push({ q: p.q, dataIds: d?.dataIds });
      } catch (e) {
        failed.push({ q: p.q, error: e.message });
      }
      if ((i + 1) % 10 === 0) console.error(`  已插入 ${i + 1}/${pairs.length}`);
    }

    out({
      ok: failed.length === 0, collectionId,
      total: pairs.length, inserted: inserted.length, failed: failed.length,
      failures: failed.slice(0, 5)
    });
  },

  /** 检索测试：验证知识库能不能召回 */
  async 'ds search'(args, f) {
    const datasetId = f.datasetId || args[0];
    const text = f.text || args[1];
    if (!datasetId || !text) fail('用法: ds search <datasetId> "查询词" [--limit 3] [--similarity 0.2]');
    const d = await client.post('/api/core/dataset/searchTest', {
      datasetId, text,
      limit: Number(f.limit) || 3,
      similarity: Number(f.similarity) || 0.2,
      searchMode: f.mode || 'embedding'
    });
    const total = (d.list || []).length;
    out(withNotice({
      ok: true, duration: d.duration, total,
      list: (d.list || []).map(x => ({
        // score 是数组 [{type,value,index}]，取最高分
        score: Math.max(...(Array.isArray(x.score) ? x.score.map(v => v.value ?? v) : [x.score ?? 0])),
        source: x.sourceName, chunkIndex: x.chunkIndex,
        text: (x.q || '').slice(0, 120)
      }))
    }, total === 0 ? Notice.emptySearch(datasetId) : null));
  },

  /** 删除文档 */
  async 'ds del'(args, f) {
    const collectionId = f.id || args[0];
    if (!collectionId) fail('用法: ds del <collectionId>');
    const ids = String(collectionId).split(',');
    await client.post('/api/core/dataset/collection/delete', { collectionIds: ids });
    out({ ok: true, deleted: ids });
  },

  /** 删除知识库 */
  async 'ds delete'(args, f) {
    const datasetId = f.id || args[0];
    if (!datasetId) fail('用法: ds delete <datasetId>');
    await client.del(`/api/core/dataset/delete?id=${datasetId}`);
    out({ ok: true, deleted: datasetId });
  },

  /** 文档级权限开关（开启后才能用 perm collection） */
  async 'ds perm'(args, f) {
    const datasetId = f.datasetId || args[0];
    const action = f.action || args[1];
    if (!datasetId || !['on', 'off'].includes(action)) fail('用法: ds perm <datasetId> on|off');
    await client.post(`/api/core/dataset/${action === 'on' ? 'enableCollectionPermission' : 'disableCollectionPermission'}`, { datasetId });
    out({ ok: true, datasetId, collectionPermission: action });
  },

  // ===== 权限 =====
  async 'perm dataset'(args, f) {
    const id = f.id || args[0];
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      if (!tmbId || perm === undefined) fail('--set 格式: tmbId:权限（1管理 2写 4读，相加）');
      const r = await updateCollaborators({
        ...RESOURCES.dataset, id, tmbId, permission: Number(perm)
      });
      out({ ok: true, datasetId: id, tmbId, permission: Number(perm), total: r.count });
    } else {
      const d = await client.get(`/api/proApi/core/dataset/collaborator/list?datasetId=${id}`);
      out((d.clbs || []).map(c => ({ tmbId: c.tmbId, name: c.name, permission: c.permission?.permission,
        read: c.permission?.hasReadPer, write: c.permission?.hasWritePer, manage: c.permission?.hasManagePer,
        isOwner: c.permission?.isOwner })));
    }
  },

  async 'perm collection'(args, f) {
    const id = f.id || args[0];
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      const r = await updateCollaborators({
        ...RESOURCES.collection, id, tmbId, permission: Number(perm)
      });
      out({ ok: true, collectionId: id, tmbId, permission: Number(perm), total: r.count });
    } else {
      const d = await client.get(`/api/proApi/core/dataset/collection/collaborator/list?collectionId=${id}`);
      out((d.clbs || []).map(c => ({ tmbId: c.tmbId, name: c.name, permission: c.permission?.permission,
        read: c.permission?.hasReadPer, write: c.permission?.hasWritePer, manage: c.permission?.hasManagePer,
        isOwner: c.permission?.isOwner })));
    }
  },

  async 'perm app'(args, f) {
    const id = f.id || args[0];
    if (!id) fail('用法: perm app <appId> [--set tmbId:权限]');
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      if (!tmbId || perm === undefined) fail('--set 格式: tmbId:权限（权限 1管理 2写 4读，相加）');
      const r = await updateCollaborators({
        ...RESOURCES.app, id, tmbId, permission: Number(perm)
      });
      out({ ok: true, appId: id, tmbId, permission: Number(perm), total: r.count });
      return;
    }
    if (f.del) {
      await client.del(`/api/proApi/core/app/collaborator/delete?appId=${id}&tmbId=${f.del}`);
      out({ ok: true, appId: id, removed: f.del });
      return;
    }
    const d = await client.get(`/api/proApi/core/app/collaborator/list?appId=${id}`);
    out((d.clbs || []).map(c => ({
      tmbId: c.tmbId, name: c.name,
      permission: c.permission?.permission,
      read: c.permission?.hasReadPer, write: c.permission?.hasWritePer, manage: c.permission?.hasManagePer,
      isOwner: c.permission?.isOwner
    })));
  },

  async 'perm member'(args, f) {
    // 写操作
    if (f.del) {
      await client.del(`/api/proApi/support/user/team/member/delete?tmbId=${f.del}`);
      out({ ok: true, removed: f.del });
      return;
    }
    if (f.restore) {
      await client.post('/api/proApi/support/user/team/member/restore', { tmbId: f.restore });
      out({ ok: true, restored: f.restore });
      return;
    }
    if (f.rename) {
      const [tmbId, ...rest] = String(f.rename).split(':');
      await client.put('/api/proApi/support/user/team/member/updateNameByManager', {
        tmbId, name: rest.join(':')
      });
      out({ ok: true, tmbId, name: rest.join(':') });
      return;
    }
    if (f.count) {
      const d = await client.get('/api/proApi/support/user/team/member/count');
      out(d);
      return;
    }
    const d = await client.post('/api/proApi/support/user/team/member/list', {
      teamId: null, searchKey: f.search || '', pageNum: 1, pageSize: Number(f.limit) || 100
    });
    out({
      total: d.total,
      list: (d.list || []).map(m => ({
        tmbId: m.tmbId, userId: m.userId, name: m.memberName, role: m.role, status: m.status
      }))
    });
  },

  /** 团队级协作者权限（整个团队能做什么，不是某个资源的） */
  async 'perm team'(args, f) {
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      await client.put('/api/proApi/support/user/team/collaborator/updateOne', {
        tmbId, permission: Number(perm)
      });
      out({ ok: true, tmbId, permission: Number(perm) });
      return;
    }
    if (f.del) {
      await client.del(`/api/proApi/support/user/team/collaborator/delete?tmbId=${f.del}`);
      out({ ok: true, removed: f.del });
      return;
    }
    const d = await client.get('/api/proApi/support/user/team/collaborator/list');
    out((d.clbs || []).map(c => ({
      tmbId: c.tmbId, name: c.name, permission: c.permission?.permission,
      read: c.permission?.hasReadPer, write: c.permission?.hasWritePer, manage: c.permission?.hasManagePer,
      isOwner: c.permission?.isOwner
    })));
  },

  /** 邀请链接：团队成员只能通过邀请加入，没有直接 add 接口 */
  async 'perm invite'(args, f) {
    if (f.create) {
      const d = await client.post('/api/proApi/support/user/team/invitationLink/create', {
        description: f.desc || 'cli-created',
        expires: f.expires || '7d',       // 30m | 7d | 1y
        usedTimesLimit: Number(f.limit ?? -1)   // 1 = 一次, -1 = 无限
      });
      out({ ok: true, linkId: d, url: `${client.base}/account/invite?linkId=${d}` });
      return;
    }
    if (f.forbid) {
      await client.put('/api/proApi/support/user/team/invitationLink/forbid', { linkId: f.forbid });
      out({ ok: true, forbidden: f.forbid });
      return;
    }
    const list = await client.get('/api/proApi/support/user/team/invitationLink/list');
    out((list || []).map(x => ({
      linkId: x.linkId, description: x.description, expires: x.expires,
      usedTimesLimit: x.usedTimesLimit, forbidden: x.forbidden,
      used: (x.members || []).length, members: x.members
    })));
  },

  // ===== 运行调试 =====
  async 'chat run'(args, f) {
    const appId = f.appId || args[0];
    const q = f.q || f.question;
    if (!appId || !q) fail('需要 --appId 和 -q "问题"');
    const key = f.key || process.env.FASTGPT_APP_KEY || fs.readFileSync('.fastgpt/apikey', 'utf8').trim();
    const res = await fetch(`${client.base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        appId, chatId: f.chatId || `cli-${Date.now()}`, stream: true, detail: !!f.detail,
        messages: [{ role: 'user', content: q }]
      })
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      let detail = {};
      try { detail = JSON.parse(body); } catch {}
      const msg = detail?.message || body.slice(0, 200);
      if (/not.publish|未发布|no.*version|版本不存在/i.test(msg) || res.status === 404) {
        const e = cliError('app_not_published');
        out({ ...e.toEnvelope(), details: { appId, status: res.status, response: msg } });
        process.exit(exitCodeFor(e));
      }
      fail(`对话接口返回 ${res.status}: ${msg}`);
    }
    const text = await res.text();
    // 解析 SSE
    let answer = '', trace = [];
    for (const block of text.split('\n\n')) {
      const m = /^event: (\w+)\ndata: (.+)$/m.exec(block);
      if (!m) continue;
      const [, ev, data] = m;
      try {
        const j = JSON.parse(data);
        if (ev === 'flowNodeStatus') trace.push(`${j.status}:${j.name}`);
        // answer: chatNode 的流式增量；fastAnswer: answerNode 的一次性输出
        if (ev === 'answer' || ev === 'fastAnswer') {
          answer += j.choices?.[0]?.delta?.content || '';
        }
      } catch {}
    }
    out(withNotice(
      { ok: true, trace, answer },
      !answer ? Notice.emptyAnswer(appId) : null
    ));
  },

  async 'apikey create'(args, f) {
    const key = await client.post('/api/support/openapi/create', { name: f.name || `cli-${Date.now()}` });
    fs.mkdirSync('.fastgpt', { recursive: true });
    fs.writeFileSync('.fastgpt/apikey', key, { mode: 0o600 });
    out({ ok: true, apiKey: key });
  },

  async help() {
    out({
      usage: 'fastgpt <group> <cmd> [args] [flags]',
      groups: {
        init: ['首次使用运行：fastgpt init（配置地址 + 登录）'],
        doctor: ['环境自检：检查地址/登录/模型/知识库是否就绪'],
        info: ['环境快照（人类可读）：用户/团队/配额/资源/能力', 'info --deep  含工作流与知识库明细', 'info --json  输出结构化数据（给 agent）'],
        auth: ['login [--user --pass]（无参数进入交互引导）', 'scan [--no-wait]（打开浏览器扫码）', 'scan --wait --session-id <id>（第二轮确认）', 'whoami', 'logout'],
        model: ['list [--type llm]', 'id  （从已有应用提取 modelId）'],
        app: ['list', 'create --name --type', 'detail <appId>', 'share create --appId --name --type share|iframe|apikey', 'share list --appId', 'share delete <_id>'],
        wf: [
          'build <dsl.json|原生导出.json> [--dry-run]   需要登录；构建前自动规范化 handle/裸变量/null 动态输入',
          'lint <file> [--fix out.json]   离线：语法 + 渲染契约检查；--fix 写出规范化结果，可直接喂 build',
          'validate <json>                同 lint（含自动规范化报告 autoFixed）',
          "verify <file> [--appId] [--ui-cmd]      一条龙：lint→校验→部署→diff→运行时→(UI)，默认影子应用跑完即删",
          "check-run <appId> [-q] [--variables '{}'] 运行时体检：真跑一次，摊开每节点入参与未替换变量",
          'versions <appId>               草稿 / version/latest / 各版本指纹对比（判断改动写进哪一层）',
          'diff <appId> <file>            提交 vs 落库分类对比：服务端 migration 改了/丢了什么',
          'get <appId> [--out f]',
          'publish <appId>'
        ],
        ds: [
          'permission <datasetId>                      查自己的读写/管理权限','list', 'create --name', 'detail <datasetId>', 'add-file <id> <file>', 'add-text <id> --name --text', 'add-link <id> <url>', 'add-batch <id> <路径...> [--ext pdf]', 'add-qa <id> --file qa.json', 'collections <id>', 'search <id> "查询词"', 'training <collectionId>', 'retrain <collectionId>', 'data <collectionId>', 'del <collectionId>', 'delete <datasetId>', 'perm <id> on|off'],
        perm: [
          'dataset <id> [--set tmbId:6]              查/设知识库协作者',
          'collection <id> [--set tmbId:6]           查/设集合协作者',
          'app <id> [--set tmbId:6] [--del tmbId]    查/设/删应用协作者',
          'member [--count] [--search 词]            成员列表',
          'member --del <tmbId>                      移除成员',
          'member --restore <tmbId>                  恢复已移除成员',
          'member --rename tmbId:新名字               改成员名',
          'team [--set tmbId:4] [--del tmbId]        团队级权限',
          'invite                                    列出邀请链接',
          'invite --create [--desc 说明] [--expires 30m|7d|1y] [--limit 1|-1]',
          'invite --forbid <linkId>                  禁用链接',
          '权限值: 1管理 2写 4读，相加。读写=6 只读=4 全权=7'
        ],
        chat: ['run --appId -q "问题" [--detail]'],
        apikey: ['create --name']
      },
      notes: [
        'modelId 必须是 24 位 ObjectId，用 model list 只能看名字，真实 ID 从已有节点取',
        '保存走 POST /api/core/app/version/publish?appId=，isPublish/false 是草稿',
        'handle 由 edge() 自动生成，不要手写'
      ]
    });
  }
};

// ---------- 分发 ----------
const argv = process.argv.slice(2);
if (!argv.length) { await commands.help(); process.exit(0); }
const { pos, flags } = parseArgs(argv);
// 支持 1~3 级命令：app share create
const candidates = [
  pos.slice(0, 3).join(' '),
  pos.slice(0, 2).join(' '),
  pos[0]
];
const key = candidates.find(k => commands[k]);
const fn = key ? commands[key] : null;
if (!fn) { out({ ok: false, error: `未知命令: ${pos.slice(0, 3).join(' ')}` }); await commands.help(); process.exit(1); }
// 已消费的参数层级
const consumed = key.split(' ').length;
// 离线命令：不触网，不需要鉴权
const authGroup = pos[0] === 'auth' || pos[0] === 'help' || pos[0] === 'init' || pos[0] === 'doctor' || pos[0] === 'info' || !pos[0];
// 只有 lint 是离线的（纯语法检查）。dry-run 必须登录，因为它要验证真实 ID。
const offlineCmds = new Set(['wf lint', 'wf validate']);
const isOffline = offlineCmds.has(key);

// 会被 modelId 阻断影响的命令
const blockedByModelId = new Set(['wf build', 'wf publish', 'app create']);

async function run(handler, handlerArgs, handlerFlags) {
  // 强制停止层：撞过死路就不要再试了
  if (blockedByModelId.has(key)) {
    const block = getBlock();
    if (block?.code === 'model_id_unavailable') {
      out(blockEnvelope(block));
      process.exit(14);
    }
  }
  if (!authGroup && !isOffline) {
    if (!isConfigured()) {
      failCli('not_configured', {
        options: Object.entries(BASE_PRESETS).map(([key, v]) => ({
          preset: key, label: v.label, base: v.base, ...(v.hint ? { hint: v.hint } : {})
        }))
      });
    }
    await ensureAuth();
  }
  return handler(handlerArgs, handlerFlags);
}

try {
  try {
    await run(fn, pos.slice(consumed), flags);
  } catch (e) {
    // 执行中途 401（cookie 过期）→ 引导登录后重试一次
    if (e instanceof FastGPTError && (isAuthError(e) || e.code === 401)) {
      console.error('\n登录态已失效，重新认证…');
      await ensureAuth({ interactive: process.stdin.isTTY });
      await fn(pos.slice(consumed), flags);
    } else throw e;
  }
} catch (e) {
  if (e?.name === 'AbortError') fail('已取消（Ctrl+D）');
  if (isCliError(e)) {
    out(e.toEnvelope());
    process.exit(exitCodeFor(e));
  }
  if (e instanceof FastGPTError) {
    out(e.toEnvelope ? e.toEnvelope() : { ok: false, error: e.message });
    process.exit(exitCodeFor(e));
  }
  fail(e.message);
}
