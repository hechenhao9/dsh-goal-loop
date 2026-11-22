/**
 * 评审层台账：review-<n>.json / gate.json / journal。
 *
 * 为什么单独一个文件、不并进 goal-store：这一层的写入者不是"跑检查的我"，
 * 而是"另一个判分的人"。分开存，才不会在复盘时把"我跑出来的绿灯"和
 * "别人给我的分数"混成一份自证材料——那正是前两代插件各自翻车的地方。
 */

import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const GOAL_DIR = '.goal';

/** .goal/<id> 目录。 */
export function reviewDir(cwd, id) {
  return path.join(path.resolve(cwd), GOAL_DIR, id);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function listNumbers(dir, prefix) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d+)\\.json$`);
  return names
    .map((n) => re.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function appendJournal(dir, entry) {
  const file = path.join(dir, 'journal.jsonl');
  await writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

/** 落一份判分，返回 { file, round }。轮次按已有 review-N.json 递增。 */
export async function saveReview(cwd, contract, review, meta = {}) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const rounds = await listNumbers(dir, 'review');
  const round = (rounds.at(-1) ?? 0) + 1;
  const file = path.join(dir, `review-${round}.json`);
  const payload = {
    ...review,
    round,
    goal: contract.id,
    objective: contract.objective,
    rubric_bar: contract.rubric?.bar ?? null,
    recorded_at: new Date().toISOString(),
    recorded_by: meta.actor ?? 'goal_review',
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await appendJournal(dir, {
    at: payload.recorded_at,
    actor: payload.recorded_by,
    event: 'review',
    round,
    ok: review?.audited?.ok ?? null,
    total: review?.audited?.total ?? null,
    deliverable: review?.audited?.deliverable ?? null,
  });
  return { file, round };
}

/** 读最近一份判分（含机器审计结果），没有则 null。 */
export async function loadLatestReview(cwd, id) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'review');
  const round = rounds.at(-1);
  if (!round) return null;
  const file = path.join(dir, `review-${round}.json`);
  const rec = await readJson(file);
  return { ...rec, file, round };
}

/** 读最近一次机器层结果（proof-<n>.json 的 summary），没有则 null。 */
export async function loadLatestProof(cwd, id) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'proof');
  const round = rounds.at(-1);
  if (!round) return null;
  const file = path.join(dir, `proof-${round}.json`);
  const rec = await readJson(file);
  return {
    ...rec,
    file,
    round,
    summary: rec?.summary ?? { total: 0, pass: 0, fail: 0, unknown: 0, green: false },
  };
}

/** 落最终裁决（覆盖写，永远只有一份；历史在 journal 里）。 */
export async function saveGate(cwd, contract, verdict) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const file = path.join(dir, 'gate.json');
  await writeFile(file, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  await appendJournal(dir, {
    at: verdict.at ?? new Date().toISOString(),
    actor: 'goal_verdict',
    event: 'gate',
    deliverable: verdict.deliverable ?? null,
    total: verdict.total ?? null,
    reasons: verdict.reasons ?? [],
  });
  return { file };
}

/** 判分文件是否存在（给 CLI 用）。 */
export async function hasReview(cwd, id) {
  return (await listNumbers(reviewDir(cwd, id), 'review')).length > 0;
}

/* ------------------------------------------------------------------ *
 * 校准层：predict-<n>.json / retro-<n>.json / rubric-history.jsonl
 * ------------------------------------------------------------------ */

/**
 * 落一份盲预测。
 *
 * 两条硬约束写在这里，而不是写在文档里等人自觉：
 *   1. 同一轮不许覆盖——已经封过的预测只能读，不能改（要重押就是新一轮）；
 *   2. 已有判分却没预测 → 拒收。判完再押，押的是答案不是猜测。
 */
export async function savePrediction(cwd, contract, prediction) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const preds = await listNumbers(dir, 'predict');
  const reviews = await listNumbers(dir, 'review');
  const lastPred = preds.at(-1) ?? 0;
  const lastReview = reviews.at(-1) ?? 0;
  if (lastReview > lastPred) {
    const err = new Error(
      `第 ${lastReview} 轮已经判过分了，现在补预测等于照着答案押注。`
      + '下一轮要预测，请在判分之前调 goal_predict。',
    );
    err.code = 'PREDICT_AFTER_REVIEW';
    throw err;
  }
  const round = lastPred + 1;
  const file = path.join(dir, `predict-${round}.json`);
  const payload = { ...prediction, round, goal: contract.id, objective: contract.objective };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await appendJournal(dir, {
    at: payload.sealed_at ?? new Date().toISOString(),
    actor: payload.predictor || 'goal_predict',
    event: 'predict',
    round,
    digest: payload.digest ?? null,
  });
  return { file, round };
}

/** 读最近一份预测（已封），没有则 null。 */
export async function loadLatestPrediction(cwd, id) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'predict');
  const round = rounds.at(-1);
  if (!round) return null;
  const file = path.join(dir, `predict-${round}.json`);
  return { ...(await readJson(file)), file, round };
}

/** 读全部预测，按轮次升序。 */
export async function listPredictions(cwd, id) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'predict');
  const out = [];
  for (const round of rounds) {
    const file = path.join(dir, `predict-${round}.json`);
    out.push({ ...(await readJson(file)), file, round });
  }
  return out;
}

/** 落一份对账结果。同一轮重复对账会覆盖（对账是纯计算，不涉及押注）。 */
export async function saveRetro(cwd, contract, result, meta = {}) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const round = Number(meta.round) || 1;
  const file = path.join(dir, `retro-${round}.json`);
  const payload = {
    ...result,
    round,
    goal: contract.id,
    recorded_at: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await appendJournal(dir, {
    at: payload.recorded_at,
    actor: meta.actor ?? 'goal_retro',
    event: 'retro',
    round,
    bias: result?.bias ?? null,
    total_delta: result?.total?.delta ?? null,
  });
  return { file, round };
}

/** 读全部对账，按轮次升序（biasStreak 要用）。 */
export async function listRetros(cwd, id) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'retro');
  const out = [];
  for (const round of rounds) {
    const file = path.join(dir, `retro-${round}.json`);
    out.push({ ...(await readJson(file)), file, round });
  }
  return out;
}

/**
 * 记一次换尺子：rubric-history.jsonl 追加一行。
 * 追加不改写——历史只增，才查得出「这条标准被我改过几次、每次为什么」。
 */
export async function appendRubricHistory(cwd, contract, prev, next, reason, diff) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const file = path.join(dir, 'rubric-history.jsonl');
  const entry = {
    at: new Date().toISOString(),
    goal: contract.id,
    revision: contract.revision ?? null,
    reason: String(reason ?? '').trim(),
    diff,
    prev: prev ? { bar: prev.bar ?? null, dims: (prev.dims ?? []).map((d) => ({ id: d.id, weight: d.weight })) } : null,
    next: next ? { bar: next.bar ?? null, dims: (next.dims ?? []).map((d) => ({ id: d.id, weight: d.weight })) } : null,
  };
  await writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  await appendJournal(dir, { at: entry.at, actor: 'goal_define', event: 'rubric_change', reason: entry.reason, diff });
  return { file };
}

/**
 * 给已有判分打 stale 标：判据换了，旧分不可比。
 * 不删旧分（删了就没法复盘「当时按什么标准判的」），只加标记。
 */
export async function markReviewsStale(cwd, id, note) {
  const dir = reviewDir(cwd, id);
  const rounds = await listNumbers(dir, 'review');
  const marked = [];
  for (const round of rounds) {
    const file = path.join(dir, `review-${round}.json`);
    let rec;
    try {
      rec = await readJson(file);
    } catch {
      continue;
    }
    if (rec.stale === true) continue;
    rec.stale = true;
    rec.stale_reason = String(note ?? '').trim() || '判据已更新';
    rec.stale_at = new Date().toISOString();
    await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    marked.push(round);
  }
  if (marked.length) {
    await appendJournal(dir, {
      at: new Date().toISOString(),
      actor: 'goal_define',
      event: 'reviews_stale',
      rounds: marked,
    });
  }
  return marked;
}

/**
 * 落一份判分任务书（review-brief.json）。
 * 它的作用是划出「判分人不许看什么」——历史分数和预测一旦被看到，
 * 判分就从独立判断退化成对答案的拟合。
 */
export async function saveReviewBrief(cwd, contract, brief) {
  const dir = await ensureDir(reviewDir(cwd, contract.id));
  const file = path.join(dir, 'review-brief.json');
  await writeFile(file, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
  return { file };
}

/** 读已落盘的对账结论（给 CLI status 用），没有则 null。 */
export async function loadLatestRetro(cwd, id) {
  const retros = await listRetros(cwd, id);
  return retros.at(-1) ?? null;
}

/** 数据文件是否还在（给诊断用）。 */
export async function hasGoalFile(cwd, id) {
  return exists(path.join(reviewDir(cwd, id), 'goal.json'));
}
