/**
 * goal-store.mjs — 目标台账的落盘层。
 *
 * 一个目标 = 一个目录：`.goal/<goal-id>/`
 *   goal.json      合约（可被 update 覆盖，revision+1）
 *   proof-<n>.json 每轮检查的完整证据（命令、退出码、输出尾部、时间）
 *   journal.jsonl  追加式流水（谁在什么时候改了什么）
 *
 * 落盘是目标工程能跨会话生效的唯一原因：目标在盘上，不在上下文里。
 */

import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { GOAL_DIR } from './goal-core.mjs';

/** @param {string} cwd */
export function goalRoot(cwd) {
  return path.join(cwd, GOAL_DIR);
}

/** @param {string} cwd @param {string} id */
export function goalDir(cwd, id) {
  return path.join(goalRoot(cwd), id);
}

/** @param {string} cwd @param {string} id */
async function ensureDir(cwd, id) {
  const dir = goalDir(cwd, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 写合约（首次或更新）。
 * @param {string} cwd
 * @param {object} contract
 * @param {{actor?: string, note?: string}} [meta]
 * @returns {Promise<{dir: string, file: string}>}
 */
export async function saveContract(cwd, contract, meta = {}) {
  const dir = await ensureDir(cwd, contract.id);
  const file = path.join(dir, 'goal.json');
  await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  await journal(cwd, contract.id, { event: 'contract_saved', revision: contract.revision, ...meta });
  return { dir, file };
}

/**
 * 读合约。
 * @param {string} cwd
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function loadContract(cwd, id) {
  const file = path.join(goalDir(cwd, id), 'goal.json');
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw);
}

/**
 * 找"当前目标"：显式 id 优先；否则取最近修改的开着的目标。
 * @param {string} cwd
 * @param {string} [id]
 * @returns {Promise<object>}
 */
export async function resolveContract(cwd, id) {
  if (id) return loadContract(cwd, id);
  const list = await listGoals(cwd);
  const open = list.filter((g) => g.status !== 'abandoned');
  if (open.length === 0) {
    throw new Error(`没有任何目标。先 goal_define 建一份合约（.goal/ 目录是空的）。`);
  }
  const pick = open[0];
  return loadContract(cwd, pick.id);
}

/**
 * 列出所有目标（按修改时间倒序）。
 * @param {string} cwd
 * @returns {Promise<object[]>}
 */
export async function listGoals(cwd) {
  const root = goalRoot(cwd);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const c = await loadContract(cwd, e.name);
      const proofs = (await readdir(path.join(root, e.name))).filter((f) => f.startsWith('proof-')).sort();
      const last = proofs.length > 0 ? proofs[proofs.length - 1] : '';
      let lastSummary = null;
      if (last) {
        try {
          const p = JSON.parse(await readFile(path.join(root, e.name, last), 'utf8'));
          lastSummary = p.summary;
        } catch {
          lastSummary = null;
        }
      }
      out.push({
        id: c.id,
        objective: c.objective,
        status: c.status,
        revision: c.revision,
        done_when: c.done_when?.length ?? 0,
        proofs: proofs.length,
        last_proof: last,
        last_summary: lastSummary,
        // 评审层摘要：CLI 与面板判断「有没有 rubric」全看这两个字段。
        rubric: c.rubric?.dims?.length
          ? { dims: c.rubric.dims.length, bar: c.rubric.bar ?? 95, vetoes: c.rubric.vetoes?.length ?? 0 }
          : null,
      });
    } catch {
      // 半成品目录跳过，不阻断列表。
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * 写一轮 proof。
 * @param {string} cwd
 * @param {object} contract
 * @param {object[]} results
 * @param {{round?: number, actor?: string}} [meta]
 * @returns {Promise<{file: string, round: number}>}
 */
export async function saveProof(cwd, contract, results, meta = {}) {
  const dir = await ensureDir(cwd, contract.id);
  const existing = (await readdir(dir)).filter((f) => /^proof-\d+\.json$/.test(f));
  const round = meta.round && meta.round > 0 ? meta.round : existing.length + 1;
  const file = path.join(dir, `proof-${round}.json`);
  const { summarize } = await import('./goal-core.mjs');
  const summary = summarize(results);
  const body = {
    goal_id: contract.id,
    round,
    checked_at: new Date().toISOString(),
    cwd,
    summary,
    green: summary.green,
    results,
  };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await journal(cwd, contract.id, { event: 'checked', round, green: summary.green, pass: summary.pass, fail: summary.fail, unknown: summary.unknown, ...meta });
  return { file, round };
}

/**
 * 追加流水。
 * @param {string} cwd @param {string} id @param {object} entry
 */
export async function journal(cwd, id, entry) {
  const dir = await ensureDir(cwd, id);
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  await appendFile(path.join(dir, 'journal.jsonl'), line, 'utf8');
}

/**
 * 改状态（open / green / blocked / abandoned）。
 * @param {string} cwd @param {string} id @param {string} status @param {string} [note]
 */
export async function setStatus(cwd, id, status, note = '') {
  const c = await loadContract(cwd, id);
  // revision 只表示"合约内容改过几次"；状态变了不算改合约，不递增。
  c.status = status;
  await saveContract(cwd, c, { event: 'status', status, note });
  return c;
}
