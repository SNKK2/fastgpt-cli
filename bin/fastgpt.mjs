#!/usr/bin/env node
// FastGPT CLI — agent 友好的管理工具
// 通用约定：所有命令输出 JSON，错误以非零退出码返回
import fs from 'node:fs';
import path from 'node:path';
import { client, loginRaw, whoami, FastGPTError, isConfigured, saveConfig, getBase, CONFIG_PATH, HOME } from '../lib/client.mjs';
import { ensureAuth, scanLogin, passwordLogin, checkAuth, isAuthError } from '../lib/auth.mjs';
import { node, input, REF } from '../lib/nodes.mjs';
import { edge, chain, validateWorkflow } from '../lib/validate.mjs';

const out = o => console.log(JSON.stringify(o, null, 2));
const fail = (msg, extra = {}) => { out({ ok: false, error: msg, ...extra }); process.exit(1); };

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
      // 1. 服务地址
      let base = f.base || process.env.FASTGPT_BASE || getBase();
      if (!base) {
        if (!rl) {
          fail('需要 --base 参数（或设置 FASTGPT_BASE）\n  fastgpt init --base https://your-fastgpt-host --user <账号> --pass <密码>');
        }
        base = await ask('FastGPT 服务地址（如 https://your-host）: ');
      }
      if (!base) fail('服务地址不能为空');
      if (!/^https?:\/\//.test(base)) base = 'https://' + base;
      base = base.replace(/\/$/, '');

      saveConfig({ base });
      console.error(`✓ 已保存服务地址到 ${CONFIG_PATH}`);

      // 2. 登录
      const me = await ensureAuth({ interactive: !!rl, user: f.user, pass: f.pass });
      out({
        ok: true,
        base,
        config: CONFIG_PATH,
        home: HOME,
        user: me.username,
        userId: me._id,
        team: me.team?.teamName,
        tmbId: me.team?.tmbId
      });
    } finally {
      rl?.close();
    }
  },

  // ===== 认证 =====
  async 'auth login'(args, f) {
    const user = f.user || process.env.FASTGPT_USER;
    const pass = f.pass || process.env.FASTGPT_PASS;
    // 无参数时走交互引导（密码 / 扫码 / 粘贴）
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
    const me = await scanLogin({ timeoutSec: Number(f.timeout) || 240 });
    out({ ok: true, user: me.username, userId: me._id, team: me.team?.teamName, tmbId: me.team?.tmbId });
  },

  async 'auth cookie'(args, f) {
    // 注入扫码登录的 fastgpt_token
    const t = f.token || args[0];
    if (!t) fail('需要 --token "<fastgpt_token 的值>"');
    client.setCookie('fastgpt_token', t);
    const me = await whoami();
    out({ ok: true, user: me.username, userId: me._id });
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
    out({ ok: true, appId });
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
    const { nodes, edges, chatConfig } = built;

    const v = validateWorkflow({ nodes, edges, chatConfig });
    if (!v.ok) { out({ ok: false, stage: 'validate', errors: v.errors, warnings: v.warnings }); process.exit(2); }

    if (f['dry-run']) { out({ ok: true, dryRun: true, nodes: nodes.length, edges: edges.length, warnings: v.warnings }); return; }

    await client.post(`/api/core/app/version/publish?appId=${appId}`, {
      nodes, edges, chatConfig,
      isPublish: !!dsl.publish, autoSave: !dsl.publish,
      versionName: dsl.versionName || 'v1'
    });
    out({ ok: true, appId, nodes: nodes.length, edges: edges.length, publish: !!dsl.publish, warnings: v.warnings });
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
    out({ ok: true, appId });
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
    out({ ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen });
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
    out({ ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen });
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
    out({ ok: true, collectionId: d.collectionId, inserted: d.results?.insertLen });
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
    out({
      ok: true, duration: d.duration, total: (d.list || []).length,
      list: (d.list || []).map(x => ({
        // score 是数组 [{type,value,index}]，取最高分
        score: Math.max(...(Array.isArray(x.score) ? x.score.map(s => s.value ?? s) : [x.score ?? 0])),
        source: x.sourceName, chunkIndex: x.chunkIndex,
        text: (x.q || '').slice(0, 120)
      }))
    });
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
    const d = await client.get(`/api/proApi/core/app/collaborator/list?appId=${id}`);
    out(d.clbs || []);
  },

  async 'perm member'(args, f) {
    const d = await client.post('/api/proApi/support/user/team/member/list', { teamId: null, searchKey: '' });
    out((d.list || []).map(m => ({ tmbId: m.tmbId, userId: m.userId, name: m.memberName, role: m.role })));
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
        if (ev === 'answer') answer += j.choices?.[0]?.delta?.content || '';
      } catch {}
    }
    out({ ok: true, trace, answer });
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
        auth: ['login [--user --pass]（无参数进入交互引导）', 'scan [--timeout 240]（打开浏览器扫码）', 'cookie --token', 'whoami', 'logout'],
        model: ['list [--type llm]'],
        app: ['list', 'create --name --type', 'detail <appId>', 'share create --appId --name --type share|iframe|apikey', 'share list --appId', 'share delete <_id>'],
        wf: ['build <dsl.json> [--dry-run]', 'validate <json>', 'get <appId> [--out f]', 'publish <appId>'],
        ds: ['list', 'create --name', 'detail <datasetId>', 'add-file <id> <file>', 'add-text <id> --name --text', 'add-link <id> <url>', 'add-batch <id> <路径...> [--ext pdf]', 'add-qa <id> --file qa.json', 'collections <id>', 'search <id> "查询词"', 'training <collectionId>', 'retrain <collectionId>', 'data <collectionId>', 'del <collectionId>', 'delete <datasetId>', 'perm <id> on|off'],
        perm: ['dataset <id> [--set tmbId:6]', 'collection <id>', 'app <id>', 'member'],
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
const authGroup = pos[0] === 'auth' || pos[0] === 'help' || pos[0] === 'init' || !pos[0];
const offlineCmds = new Set(['wf validate']);
const isOffline = offlineCmds.has(key) || (key === 'wf build' && flags['dry-run']);

async function run(handler, handlerArgs, handlerFlags) {
  if (!authGroup && !isOffline) {
    if (!isConfigured()) {
      fail(
        '尚未配置 FastGPT 服务地址。\n\n' +
        '首次使用请运行：\n' +
        '  fastgpt init\n\n' +
        '或设置环境变量：\n' +
        '  export FASTGPT_BASE=https://your-fastgpt-host'
      );
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
  if (e instanceof FastGPTError) fail(e.message, { code: e.code, statusText: e.statusText, zod: e.zod });
  fail(e.message, { stack: e.stack?.split('\n').slice(0, 3) });
}
