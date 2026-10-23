// 强制停止层：记录「死路」状态，阻止 agent 用换命令/改参数的方式绕圈
//
// 场景：团队没有可用 modelId 时，任何建工作流的尝试都必然失败。
// 如果只报一次错，agent 可能会：
//   - 换一条命令再试
//   - 改 DSL 里的值再试
//   - 读源码想办法改校验
//
// 所以撞上这类死路时，写一个 block 状态到本地。
// 后续任何相关命令都直接返回同一条提示，直到条件满足才清除。
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './client.mjs';

const BLOCK_FILE = path.join(HOME, 'blocked.json');

export function setBlock({ code, message, hint, forbidden, mustEndTurn = true, resolvedBy }) {
  try {
    fs.writeFileSync(BLOCK_FILE, JSON.stringify({
      code, message, hint, forbidden, mustEndTurn, resolvedBy,
      blockedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
  } catch {}
}

export function getBlock() {
  try {
    const raw = fs.readFileSync(BLOCK_FILE, 'utf8');
    const b = JSON.parse(raw);
    // 超过 24 小时自动失效，避免陈旧状态永久卡死
    if (Date.now() - new Date(b.blockedAt).getTime() > 24 * 3600 * 1000) {
      clearBlock();
      return null;
    }
    return b;
  } catch { return null; }
}

export function clearBlock() {
  try { fs.unlinkSync(BLOCK_FILE); } catch {}
}

/** 把 block 包装成标准错误信封 */
export function blockEnvelope(block) {
  return {
    ok: false,
    blocked: true,
    error: {
      type: 'platform',
      subtype: block.code,
      message: block.message,
      hint: block.hint,
      action_required: 'user',
      dead_end: true,
      must_end_turn: block.mustEndTurn,
      forbidden: block.forbidden,
      resolved_by: block.resolvedBy,
      blocked_at: block.blockedAt,
      note: '当前环境已进入阻断状态，换命令或改参数都不会有不同结果'
    }
  };
}
