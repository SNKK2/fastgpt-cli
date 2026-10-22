// 认证引导：密码登录 / 扫码登录 / 手动 token，含失效自动检测
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { client, sha256, FastGPTError, getBase, HOME } from './client.mjs';
import { cliError } from './errors.mjs';

const requireBase = () => {
  const b = getBase();
  if (!b) throw new FastGPTError('尚未配置服务地址，请先运行：fastgpt init');
  return b;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const isAuthError = e => e?.code === 401 || e?.statusText === 'unAuthorization';

// ---------- 登录方式 ----------

export async function passwordLogin(user, pass) {
  const pre = await client.get(`/api/support/user/account/preLogin?username=${encodeURIComponent(user)}`, { auth: false });
  if (!pre?.code) throw new FastGPTError('preLogin 未返回验证码字段');

  const res = await fetch(requireBase() + '/api/support/user/account/loginByPassword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'fastgpt-web-request': 'fastgpt' },
    body: JSON.stringify({ username: user, password: sha256(pass), language: 'zh-CN', code: pre.code })
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  let token = null;
  for (const line of setCookies) {
    const m = /fastgpt_token=([^;]+)/.exec(line);
    if (m) token = m[1];
  }
  const json = await res.json();
  if (json.code !== 200) {
    const MAP = {
      'common:code_error.account_error': '账号或密码错误',
      'common:code_error.code_error': '验证码错误或已过期',
      'common:code_error.account_not_exist': '账号不存在'
    };
    const msg = MAP[json.message] || json.message || '登录失败';
    throw new FastGPTError(msg, { code: json.code });
  }
  if (!token) throw new FastGPTError('登录成功但未拿到 fastgpt_token');
  client.setCookie('fastgpt_token', token);
  return json.data.user;
}

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

/** 极简 CDP 客户端，零依赖（Node 22+ 全局 WebSocket） */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = e => rej(new Error('CDP 连接失败'));
    });
    this.ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * 打开浏览器让用户扫码，自动抓取 httpOnly cookie。
 *
 * 两种模式：
 *   阻塞模式（默认）：一直等到扫码完成或超时
 *   --no-wait：启动浏览器后立即返回 URL + sessionId，交给用户操作，
 *              下一轮用 resumeScan(sessionId) 完成
 *
 * 为什么要 split：agent 在同一轮里阻塞时，它输出给用户的提示用户看不到。
 */
export async function scanLogin({ timeoutSec = 240, noWait = false } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new FastGPTError('未找到 Chrome/Chromium，请设置 CHROME_PATH 或改用密码登录');

  const port = 9400 + Math.floor(Math.random() * 200);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-scan-'));

  console.error(`\n[扫码登录] 正在打开浏览器…`);
  console.error(`  地址: ${requireBase()}/login`);
  console.error(`  请在浏览器中完成扫码，脚本会自动捕获登录态\n`);

  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    `${requireBase()}/login`
  ], { stdio: 'ignore', detached: true });
  // split-flow 模式下进程要立刻退出，浏览器必须脱离父进程继续跑
  if (noWait) proc.unref();

  let ws = null;
  let keepAlive = false;   // split-flow 下浏览器要继续活着
  try {
    // 等调试端口就绪
    let ok = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) { ok = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!ok) throw new FastGPTError('浏览器调试端口未就绪');

    // 找 fastgpt 页面
    let target = null;
    for (let i = 0; i < 30; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('fastgpt'));
      if (target) break;
      await sleep(500);
    }
    if (!target) throw new FastGPTError('未找到登录页面');

    const cdp = new CDP(target.webSocketDebuggerUrl);
    ws = cdp;
    await cdp.send('Network.enable');

    // split-flow：立即返回，不阻塞
    if (noWait) {
      const sessionId = `${port}`;
      const sessionFile = path.join(HOME, `scan-${sessionId}.json`);
      fs.writeFileSync(sessionFile, JSON.stringify({
        sessionId, port, profile, pid: proc.pid,
        wsUrl: target.webSocketDebuggerUrl,
        createdAt: Date.now()
      }, null, 2), { mode: 0o600 });
      keepAlive = true;   // 关键：不要把浏览器关掉
      return {
        noWait: true,
        sessionId,
        url: `${requireBase()}/login`,
        message: '浏览器已打开，请让用户在浏览器中完成扫码登录',
        hint: '把这条消息发给用户并结束本轮；用户回复完成后，运行 fastgpt auth scan --wait --session-id ' + sessionId,
        nextCommand: `fastgpt auth scan --wait --session-id ${sessionId}`
      };
    }

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const { cookies } = await cdp.send('Network.getAllCookies');
      const tok = cookies.find(c => c.name === 'fastgpt_token' && c.domain.includes('fastgpt'));
      if (tok?.value) {
        client.setCookie('fastgpt_token', tok.value);
        cdp.close();
        const me = await client.get('/api/support/user/account/tokenLogin');
        return me;
      }
    }
    throw cliError('scan_timeout', { details: { timeoutSec } });
  } finally {
    try { ws?.close(); } catch {}
    if (!keepAlive) {
      try { proc.kill(); } catch {}
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  }
}

// ---------- 失效检测与引导 ----------

export async function checkAuth() {
  try {
    return await client.get('/api/support/user/account/tokenLogin');
  } catch (e) {
    if (isAuthError(e)) return null;
    throw e;
  }
}

/**
 * 确保已登录。未登录时交互式引导。
 * 非 TTY 环境（agent 调用）直接抛错，给出可执行的下一步命令。
 */
export async function ensureAuth({ interactive = process.stdin.isTTY, user, pass } = {}) {
  // 1. 显式凭证优先
  if (user && pass) {
    await passwordLogin(user, pass);
    const me = await checkAuth();
    if (!me) throw new FastGPTError('登录失败：凭证无效');
    return me;
  }

  // 2. 已有 cookie 直接复用
  const me = await checkAuth();
  if (me) return me;

  if (!interactive) {
    throw new FastGPTError(
      '未登录或登录已失效。请先执行其中之一：\n' +
      '  fastgpt init                          # 首次使用推荐，配置地址并登录\n' +
      '  fastgpt auth login --user <账号> --pass <密码>\n' +
      '  fastgpt auth scan                     # 打开浏览器扫码\n' +
      '  fastgpt auth cookie --token <token>',
      { code: 401, statusText: 'unAuthorization' }
    );
  }

  console.error('\n未登录或登录已失效，请选择登录方式：');
  console.error('  1) 账号密码登录');
  console.error('  2) 打开浏览器扫码（微信/企业微信账号）');
  console.error('  3) 手动粘贴 fastgpt_token');
  console.error('');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const choice = (await rl.question('选择 [1/2/3，默认 1]: ')).trim() || '1';

    if (choice === '1') {
      const user = (await rl.question('账号（手机号/邮箱）: ')).trim();
      const pass = (await rl.question('密码: ')).trim();
      if (!user || !pass) throw new FastGPTError('账号或密码为空');
      const u = await passwordLogin(user, pass);
      console.error(`\n✓ 登录成功: ${u.username}`);
      return await client.get('/api/support/user/account/tokenLogin');
    }

    if (choice === '2') {
      const u = await scanLogin();
      console.error(`\n✓ 扫码登录成功: ${u.username}`);
      return u;
    }

    if (choice === '3') {
      const tok = (await rl.question('fastgpt_token 的值: ')).trim();
      if (!tok) throw new FastGPTError('token 为空');
      client.setCookie('fastgpt_token', tok);
      const me2 = await checkAuth();
      if (!me2) throw new FastGPTError('token 无效');
      console.error(`\n✓ 登录成功: ${me2.username}`);
      return me2;
    }

    throw new FastGPTError(`未知选项: ${choice}`);
  } finally {
    rl.close();
  }
}


/**
 * 继续一个未完成的扫码会话（split-flow 第二轮）。
 * 重新连 CDP 轮询 cookie，命中即落盘。
 */
export async function resumeScan(sessionId, { timeoutSec = 240 } = {}) {
  const sessionFile = path.join(HOME, `scan-${sessionId}.json`);
  if (!fs.existsSync(sessionFile)) {
    throw cliError('scan_session_missing', { details: { sessionId } });
  }
  const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

  // 确认浏览器还活着
  try {
    await fetch(`http://127.0.0.1:${sess.port}/json/version`);
  } catch {
    throw cliError('scan_session_expired');
  }

  // 重新拿 target（页面可能已跳转）
  const list = await (await fetch(`http://127.0.0.1:${sess.port}/json/list`)).json();
  const target = list.find(t => t.type === 'page' && t.url.includes('fastgpt')) || list.find(t => t.type === 'page');
  if (!target) throw new FastGPTError('未找到登录页面');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Network.enable');
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const { cookies } = await cdp.send('Network.getAllCookies');
      const tok = cookies.find(c => c.name === 'fastgpt_token' && c.domain.includes('fastgpt'));
      if (tok?.value) {
        client.setCookie('fastgpt_token', tok.value);
        cdp.close();
        try { fs.unlinkSync(sessionFile); } catch {}
        try { process.kill(sess.pid, 'SIGTERM'); } catch {}
        try { fs.rmSync(sess.profile, { recursive: true, force: true }); } catch {}
        return await client.get('/api/support/user/account/tokenLogin');
      }
    }
    throw cliError('scan_timeout', {
      hint: `浏览器仍开着。可再次运行 fastgpt auth scan --wait --session-id ${sessionId}，或让用户重新扫码`,
      details: { sessionId, timeoutSec }
    });
  } finally {
    try { cdp.close(); } catch {}
  }
}
