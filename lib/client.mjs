// FastGPT 客户端：认证、CSRF、错误归一化
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CliError, cliError, Category } from './errors.mjs';

// 配置目录：默认 ~/.fastgpt，可用 FASTGPT_HOME 覆盖（便于多实例隔离）
export const HOME = process.env.FASTGPT_HOME || path.join(os.homedir(), '.fastgpt');
export const CONFIG_PATH = path.join(HOME, 'config.json');
const JAR = path.join(HOME, 'cookies.json');

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
export function saveConfig(patch) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2), { mode: 0o600 });
}

// 服务地址优先级：环境变量 > 配置文件。
// 每次调用实时读取，保证 init 保存后当前进程立即生效。
export function getBase() {
  if (process.env.FASTGPT_BASE) return process.env.FASTGPT_BASE.replace(/\/$/, '');
  const cfg = loadConfig();
  return (cfg.base || '').replace(/\/$/, '');
}
export function isConfigured() { return !!getBase(); }

function requireBase() {
  const b = getBase();
  if (!b) throw cliError('not_configured');
  return b;
}

fs.mkdirSync(HOME, { recursive: true });

// 常见 i18n 错误码 -> 中文提示
const ERR_I18N_MAP = {
  'common:code_error.account_error': '账号或密码错误',
  'common:code_error.account_not_exist': '账号不存在',
  'common:code_error.code_error': '验证码错误或已过期',
  'common:code_error.error_message.401': '未登录或登录已失效',
  'common:error.code_error': '验证码错误或已过期'
};

// 向后兼容别名：旧代码里的 FastGPTError
export class FastGPTError extends CliError {
  constructor(message, { code, statusText, zod, raw, subtype } = {}) {
    // 按业务码推断 subtype
    let st = subtype;
    if (!st) {
      if (code === 401 || statusText === 'unAuthorization') st = 'not_logged_in';
      else if (statusText === 'appUnExist') st = 'app_not_found';
      else if (statusText === 'unExistDataset') st = 'dataset_not_found';
      else if (statusText === 'unExistCollection') st = 'collection_not_found';
      else if (statusText === 'collectionPermissionDisabled') st = 'collection_permission_disabled';
      else if (statusText === 'invalidVerificationCode' || statusText === 'account_psw_error') st = 'login_failed';
      else st = null;
    }
    if (st) {
      const base = cliError(st, { message });
      super({ category: base.category, subtype: st, message: base.message, hint: base.hint,
            nextCommand: base.nextCommand, actionRequired: base.actionRequired, forbidden: base.forbidden });
    } else {
      super({ category: Category.platform, subtype: 'api_error', message, actionRequired: 'self',
              hint: '这是 FastGPT 返回的错误，检查参数后重试' });
    }
    this.code = code;
    this.statusText = statusText;
    this.zod = zod;
    this.raw = raw;
  }
}

function loadCookies() {
  try { return JSON.parse(fs.readFileSync(JAR, 'utf8')); } catch { return {}; }
}
function saveCookies(c) { fs.writeFileSync(JAR, JSON.stringify(c, null, 2), { mode: 0o600 }); }

export function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

export const client = {
  get base() { return getBase(); },
  get cookieHeader() {
    return Object.entries(loadCookies()).map(([k, v]) => `${k}=${v}`).join('; ');
  },
  setCookie(name, value) {
    const c = loadCookies(); c[name] = value; saveCookies(c);
  },
  clearCookie() { try { fs.unlinkSync(JAR); } catch {} },

  async req(method, urlPath, { body, headers = {}, auth = true, raw = false } = {}) {
    const h = {
      'Content-Type': 'application/json',
      // CSRF：所有带 token 的请求必须带这个头
      'fastgpt-web-request': 'fastgpt',
      ...headers
    };
    if (auth) {
      const ck = this.cookieHeader;
      if (!ck) throw cliError('not_logged_in');
      h.Cookie = ck;
    }
    let res;
    try {
      res = await fetch(requireBase() + urlPath, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
      });
    } catch (e) {
      throw cliError('network_error', { details: { url: urlPath, reason: e.message } });
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      if (!res.ok) throw new FastGPTError(`HTTP ${res.status} 非 JSON 响应（路径可能不存在）`, { raw: text.slice(0, 200) });
      return raw ? text : text;
    }
    if (json.code !== undefined && json.code !== 200) {
      const rawMsg = json.message || '';
      const friendly = ERR_I18N_MAP[rawMsg] || rawMsg;
      throw new FastGPTError(
        `${json.statusText || ''} ${friendly || ''}`.trim() || `业务错误 ${json.code}`,
        { code: json.code, statusText: json.statusText, zod: json.zodError, raw: json }
      );
    }
    return json.data;
  },

  /**
   * multipart 上传。手动构造 body 以支持中文文件名（RFC 5987 filename*）。
   * Node 原生 FormData 发送的 filename 会被服务端按 latin1 解析导致乱码。
   * file: { name, buffer, contentType? }
   */
  async upload(urlPath, { fields = {}, file }) {
    const ck = this.cookieHeader;
    if (!ck) throw cliError('not_logged_in');
    const boundary = '----FastGPTBoundary' + crypto.randomBytes(8).toString('hex');
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
    }

    if (file) {
      const enc = encodeURIComponent(file.name);
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="${file.name}"; filename*=UTF-8''${enc}\r\n` +
        `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
      parts.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer));
      parts.push(Buffer.from('\r\n', 'utf8'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

    const res = await fetch(requireBase() + urlPath, {
      method: 'POST',
      headers: {
        Cookie: ck,
        'fastgpt-web-request': 'fastgpt',
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: Buffer.concat(parts)
    });
    const json = await res.json();
    if (json.code !== undefined && json.code !== 200) {
      throw new FastGPTError(json.message || `上传失败 ${json.code}`, { code: json.code, zod: json.zodError });
    }
    return json.data;
  },

  get: (p, o) => client.req('GET', p, o),
  post: (p, b, o) => client.req('POST', p, { ...o, body: b }),
  put: (p, b, o) => client.req('PUT', p, { ...o, body: b }),
  del: (p, b, o) => client.req('DELETE', p, { ...o, body: b })
};

// ---- 认证 ----

export async function loginByPassword(username, password) {
  // 1. 取一次性 nonce（不是图形验证码）
  const pre = await client.get(`/api/support/user/account/preLogin?username=${encodeURIComponent(username)}`, { auth: false });
  if (!pre?.code) throw new FastGPTError('preLogin 未返回 code');
  // 2. 无盐 SHA-256 密码登录
  const data = await client.post('/api/support/user/account/loginByPassword', {
    username, password: sha256(password), language: 'zh-CN', code: pre.code
  }, { auth: false });
  // 3. 从响应头拿不到 cookie（fetch 不暴露 Set-Cookie），需要单独用登录接口的 token
  // FastGPT 登录会把 fastgpt_token 种在 Set-Cookie，Node fetch 无法读取，故走回退方案
  return data;
}

export async function loginRaw(username, password) {
  const pre = await client.get(`/api/support/user/account/preLogin?username=${encodeURIComponent(username)}`, { auth: false });
  const res = await fetch(BASE + '/api/support/user/account/loginByPassword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'fastgpt-web-request': 'fastgpt' },
    body: JSON.stringify({ username, password: sha256(password), language: 'zh-CN', code: pre.code })
  });
  const rawSet = res.headers.getSetCookie?.() || [];
  let token = null;
  for (const line of rawSet) {
    const m = /fastgpt_token=([^;]+)/.exec(line);
    if (m) token = m[1];
  }
  const json = await res.json();
  if (json.code !== 200) throw new FastGPTError(json.message || '登录失败', { code: json.code });
  if (token) client.setCookie('fastgpt_token', token);
  return json.data;
}

export async function whoami() {
  return client.get('/api/support/user/account/tokenLogin');
}
