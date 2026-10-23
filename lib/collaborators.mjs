// 协作者权限的读写封装
//
// FastGPT 的 collaborators 参数是【更新后的完整列表】，不是增量。
// 只传新成员等于「把现有的 admin/owner 删掉」，后端会拒绝并返回
// can_not_edit_admin_permission（文案有误导性，实际含义是"不能删管理员"）。
//
// 所以所有写操作都必须：先查现状 → 合并 → 全量提交。

import { client } from './client.mjs';

/** 把一个 collaborator 记录规整成 { tmbId, permission } */
function normalize(c) {
  const permission = c?.permission?.permission ?? c?.permission;
  if (!c?.tmbId || typeof permission !== 'number') return null;
  return { tmbId: c.tmbId, permission };
}

/**
 * 合并现有协作者与本次变更，返回可直接提交的完整列表。
 *
 * @param existing 现有列表（API 返回的 clbs 数组）
 * @param tmbId    要变更的成员
 * @param permission 新权限值；0 表示移除
 */
export function mergeCollaboratorList(existing, tmbId, permission) {
  const map = new Map();
  for (const raw of existing || []) {
    const n = normalize(raw);
    if (n) map.set(n.tmbId, n.permission);
  }
  if (permission === 0) map.delete(tmbId);
  else map.set(tmbId, permission);
  return [...map].map(([t, p]) => ({ tmbId: t, permission: p }));
}

/**
 * 带合并的资源协作者更新。
 *
 * @param listPath 协作者列表接口，如 /api/proApi/core/dataset/collaborator/list
 * @param idKey    资源 ID 的参数名，如 datasetId
 * @param id       资源 ID
 * @param tmbId    目标成员
 * @param permission 权限值，0 表示移除
 * @param method   update 接口的 HTTP 方法（前端定义都是 POST）
 */
export async function updateCollaborators({ listPath, idKey, id, tmbId, permission, method = 'post' }) {
  let existing = [];
  try {
    const cur = await client.get(`${listPath}?${idKey}=${id}`);
    existing = cur.clbs || [];
  } catch {
    // 查不到就当空列表；至少能让第一次授权成功
  }
  const collaborators = mergeCollaboratorList(existing, tmbId, permission);
  const fn = client[method] || client.post;
  await fn(listPath.replace('/list', '/update'), { [idKey]: id, collaborators });
  return { collaborators, count: collaborators.length };
}

/** 资源的协作者接口描述表，避免各处手写路径和方法 */
export const RESOURCES = {
  dataset: {
    listPath: '/api/proApi/core/dataset/collaborator/list',
    idKey: 'datasetId',
    method: 'post',
    label: '知识库'
  },
  collection: {
    listPath: '/api/proApi/core/dataset/collection/collaborator/list',
    idKey: 'collectionId',
    method: 'post',
    label: '集合'
  },
  app: {
    listPath: '/api/proApi/core/app/collaborator/list',
    idKey: 'appId',
    method: 'post',
    label: '应用'
  }
};
