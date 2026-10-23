#!/usr/bin/env node
// FastGPT CLI — agent 友好的管理工具
// 通用约定：所有命令输出 JSON，错误以非零退出码返回
import fs from 'node:fs';
import path from 'node:path';
import { client, loginRaw, whoami, FastGPTError, isConfigured, saveConfig, getBase, CONFIG_PATH, HOME } from '../lib/client.mjs';
import { cliError, exitCodeFor, isCliError, BASE_PRESETS, WEBSITE_TO_PRESET, Notice, withNotice } from '../lib/errors.mjs';
import { setBlock, getBlock, clearBlock, blockEnvelope } from '../lib/blocker.mjs';
import { ensureAuth, scanLogin, resumeScan, passwordLogin, checkAuth, isAuthError } from '../lib/auth.mjs';
import { node, input, REF } from '../lib/nodes.mjs';
import { edge, chain, validateWorkflow } from '../lib/validate.mjs';

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
function staticModelIdCheck(nodes) {
  const isPlaceholder = v => typeof v === 'string' && (/^\s*$/.test(v) || /^<.*>$/.test(v));
  const issues = [];
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key !== 'modelId') continue;
      const v = inp.value;
      if (Array.isArray(v)) continue;
      if (typeof v === 'string' && MODEL_ID_RE.test(v)) {
        if (/^0+$/.test(v)) issues.push({ node: n.nodeId, value: v, kind: 'suspicious-zero' });
        continue;
      }
      if (isPlaceholder(v)) issues.push({ node: n.nodeId, value: v, kind: 'placeholder' });
      else issues.push({ node: n.nodeId, value: v, kind: 'model-name' });
    }
  }
  if (!issues.length) return true;
  const ph = issues.filter(i => i.kind === 'placeholder');
  const nm = issues.filter(i => i.kind === 'model-name');
  const zr = issues.filter(i => i.kind === 'suspicious-zero');
  console.error('');
  if (ph.length) {
    console.error(`⚠️  ${ph.length} 处 modelId 仍是占位符：${[...new Set(ph.map(i => i.value))].join(', ')}`);
  }
  if (nm.length) {
    console.error(`⚠️  ${nm.length} 处 modelId 填的是模型名：${[...new Set(nm.map(i => i.value))].join(', ')}`);
  }
  if (zr.length) {
    console.error(`❌ ${zr.length} 处 modelId 是全零假值（${zr[0].value}），这不是真实模型，部署后必然失败`);
  }
  console.error('   dry-run 只校验结构，不做网络检查。真实部署前请运行：fastgpt model id');
  console.error('');
  return !zr.length;
}

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

// ---------- DSL 构建（wf build / wf validate 共用） ----------
function buildFromDsl(dsl) {
  const nodes = [];
  for (const spec of dsl.nodes || []) {
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
    add('登录状态', !!me, me ? `${me.username} / ${me.team?.teamName}` : '未登录', 'fastgpt init');

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
    const dsl = readJson(file);
    const appId = dsl.appId || f.appId;
    if (!appId) fail('DSL 需要 appId');

    let built;
    try { built = buildFromDsl(dsl); } catch (e) { fail(e.message); }
    let { nodes, edges, chatConfig } = built;

    // 内在参数自动调整（在 modelId 预检之前，避免给出基于错误参数的结论）
    const tuned = autoTuneNodeParams(nodes);
    if (tuned.length) {
      console.error('');
      console.error('⚙️  已自动调整节点参数：');
      tuned.forEach(c => {
        const from = c.from === undefined ? '(未设置)' : c.from;
        console.error(`   ${c.node}.${c.param}: ${from} → ${c.to}`);
        console.error(`     ${c.reason}`);
      });
      console.error('');
    }

    // 预检：dry-run 和真实部署走同一套校验（都要验证 modelId 真实性）
    if (!f['no-model-hook']) {
      nodes = await ensureModelIdHook(nodes, { autoFill: !f['no-auto-model'] });
    }

    const v = validateWorkflow({ nodes, edges, chatConfig });
    if (!v.ok) {
      failCli('workflow_validate_failed', { details: { errors: v.errors, warnings: v.warnings } });
    }

    if (f['dry-run']) {
      // 验证 datasetId 真实性
      const dsIds = new Set();
      for (const n of nodes) {
        for (const inp of n.inputs || []) {
          if (inp.key !== 'datasets' || !Array.isArray(inp.value)) continue;
          for (const d of inp.value) {
            if (d && typeof d === 'object' && d.datasetId) dsIds.add(d.datasetId);
          }
        }
      }
      const badDs = [];
      if (dsIds.size) {
        let realDs = [];
        try {
          const d = await client.post('/api/core/dataset/list', { parentId: null, searchKey: '' });
          realDs = (d || []).map(x => x._id);
        } catch {}
        for (const id of dsIds) {
          if (!realDs.includes(id)) badDs.push(id);
        }
      }
      if (badDs.length) {
        failCli('dataset_not_found', {
          message: `DSL 引用了当前团队不存在的知识库：${badDs.join(', ')}`,
          hint: '运行 fastgpt ds list 查看可用知识库 ID',
          details: { invalidDatasetIds: badDs }
        });
      }

      out(withNotice(
        { ok: true, dryRun: true, nodes: nodes.length, edges: edges.length, warnings: v.warnings,
          verified: { modelId: true, datasetIds: dsIds.size } },
        Notice.dryRunOnly()
      ));
      return;
    }

    // publish 默认 true：用户说「要能直接拿来用」就是发布状态
    const published = dsl.publish !== false;
    await client.post(`/api/core/app/version/publish?appId=${appId}`, {
      nodes, edges, chatConfig,
      isPublish: published, autoSave: !published,
      versionName: dsl.versionName || 'v1'
    });
    const payload = { ok: true, appId, nodes: nodes.length, edges: edges.length,
                      publish: published, warnings: v.warnings };
    out(published ? payload : withNotice(payload, Notice.notPublished()));
  },

  /** 纯语法检查：离线，不验证 ID 真实性，不代表可部署 */
  async 'wf lint'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 JSON 文件路径');
    const d = readJson(file);
    let nodes, edges, chatConfig;
    if ((d.nodes || []).some(n => n.type)) {
      try { ({ nodes, edges, chatConfig } = buildFromDsl(d)); }
      catch (e) { fail(e.message); }
    } else {
      nodes = d.nodes || d; edges = d.edges || []; chatConfig = d.chatConfig || {};
    }
    const v = validateWorkflow({ nodes, edges, chatConfig });
    const placeholder = [];
    for (const n of nodes) {
      for (const inp of n.inputs || []) {
        if (inp.key === 'modelId' && typeof inp.value === 'string' && !/^[0-9a-f]{24}$/i.test(inp.value)) {
          placeholder.push({ node: n.nodeId, value: inp.value });
        }
      }
    }
    out({
      ok: v.ok,
      lintOnly: true,
      note: '仅语法检查，未验证 modelId / datasetId 真实性，不代表可部署',
      nodes: nodes.length,
      edges: edges.length,
      errors: v.errors,
      warnings: v.warnings,
      ...(placeholder.length ? { unresolvedModelIds: placeholder } : {}),
      next: v.ok
        ? '语法没问题。真实部署用 fastgpt wf build <file>（需要登录）'
        : '先修正 errors，再运行 fastgpt wf build'
    });
    if (!v.ok) process.exit(2);
  },

  async 'wf validate'(args, f) {
    const file = f.file || args[0];
    if (!file) fail('需要 JSON 文件路径');
    const d = readJson(file);
    // 兼容两种输入：DSL（节点带 type）或已构建的完整结构
    let nodes, edges, chatConfig;
    if ((d.nodes || []).some(n => n.type)) {
      try { ({ nodes, edges, chatConfig } = buildFromDsl(d)); }
      catch (e) { fail(e.message); }
    } else {
      nodes = d.nodes || d; edges = d.edges || []; chatConfig = d.chatConfig || {};
    }
    const v = validateWorkflow({ nodes, edges, chatConfig });
    v.nodeCount = nodes.length; v.edgeCount = edges.length;
    out(v); if (!v.ok) process.exit(2);
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
      await client.put('/api/proApi/core/dataset/collaborator/update', {
        datasetId: id, collaborators: [{ tmbId, permission: Number(perm) }]
      });
      out({ ok: true });
    } else {
      const d = await client.get(`/api/proApi/core/dataset/collaborator/list?datasetId=${id}`);
      out((d.clbs || []).map(c => ({ tmbId: c.tmbId, permission: c.permission?.permission,
        read: c.permission?.hasReadPer, write: c.permission?.hasWritePer, manage: c.permission?.hasManagePer })));
    }
  },

  async 'perm collection'(args, f) {
    const id = f.id || args[0];
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      await client.put('/api/proApi/core/dataset/collection/collaborator/update', {
        collectionId: id, collaborators: [{ tmbId, permission: Number(perm) }]
      });
      out({ ok: true });
    } else {
      const d = await client.get(`/api/proApi/core/dataset/collection/collaborator/list?collectionId=${id}`);
      out(d.clbs || []);
    }
  },

  async 'perm app'(args, f) {
    const id = f.id || args[0];
    if (!id) fail('用法: perm app <appId> [--set tmbId:权限]');
    if (f.set) {
      const [tmbId, perm] = String(f.set).split(':');
      if (!tmbId || perm === undefined) fail('--set 格式: tmbId:权限（权限 1管理 2写 4读，相加）');
      await client.put('/api/proApi/core/app/collaborator/update', {
        appId: id, collaborators: [{ tmbId, permission: Number(perm) }]
      });
      out({ ok: true, appId: id, tmbId, permission: Number(perm) });
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
          'build <dsl.json> [--dry-run]   需要登录，dry-run 也验证真实 ID',
          'lint <dsl.json>                纯语法检查（离线，不代表可部署）',
          'validate <json>                同 lint',
          'get <appId> [--out f]',
          'publish <appId>'
        ],
        ds: ['list', 'create --name', 'detail <datasetId>', 'add-file <id> <file>', 'add-text <id> --name --text', 'add-link <id> <url>', 'add-batch <id> <路径...> [--ext pdf]', 'add-qa <id> --file qa.json', 'collections <id>', 'search <id> "查询词"', 'training <collectionId>', 'retrain <collectionId>', 'data <collectionId>', 'del <collectionId>', 'delete <datasetId>', 'perm <id> on|off'],
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
