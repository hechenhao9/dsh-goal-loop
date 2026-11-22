/**
 * 校准层：让「标准本身」也进验收。
 *
 * 前两层（机器层 / 评审层）判的是「这一次做到没做到标准」。但它们有个共同的洞：
 * 标准可能是歪的——某个维度永远给满分，或者永远高估，而没人记账。于是每次
 * 「过了 95」都只是同一把歪尺子量出来的同一个错觉。
 *
 * 这一层借的是「打分 → 盲预测 → 对账 → 改标准」的循环：
 *   1. 判分之前先押注（predict）——把「我以为会得几分」写下来，落盘即封，不可改；
 *   2. 判分出来对账（retro）——逐维算偏差，看是尺子高了还是低了；
 *   3. 连续三次同向偏差 → 该改的是 criterion，不是继续改稿；
 *   4. 改 rubric 必须给理由、必须留 diff、旧判分全部作废（stale）——
 *      不许静默换尺子，然后拿新尺子的分数去比旧样本。
 *
 * 三条不可让步（借自 cheat-on-content 的三条原则）：
 *   A. 预测必须在看到实际分数之前写完，写完不可改；
 *   B. 改标准 = 旧分作废，不许新旧混算；
 *   C. 标准是工作台不是博物馆：被推翻的维度删掉，不留「我曾经以为…」的考古层。
 */

import { createHash } from 'node:crypto';
import { DIM_SCORES, scoreTotal, DEFAULT_BAR } from './rubric-core.mjs';

/** 预测封条版本：改结构就 +1，旧封条失效。 */
export const PREDICT_VERSION = 1;
/** 连续几轮同向偏差就催改标准。 */
export const BIAS_STREAK_LIMIT = 3;
/** 判「命中」的容差：总分差在 2 分以内算押中（0/4/7/10 只有四档，2 分已是半档）。 */
export const HIT_TOLERANCE = 2;

/** 稳定序列化：键排序，用于算摘要，保证同样的内容永远同一个 digest。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** 内容摘要（前 16 位够用，且短到能贴进报告）。 */
export function digestOf(value) {
  return createHash('sha256').update(stable(value)).digest('hex').slice(0, 16);
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 数字或 null（用 null 表示「没给」，不要用 NaN——它序列化成 JSON 会静默变成 null，查不出是缺失还是写错）。 */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 规整一份预测。缺的东西留空，交给 validatePrediction 报错——
 * 这里不做「帮你猜」的补全，补出来的预测等于没押注。
 */
export function normalizePrediction(input = {}) {
  const dims = Array.isArray(input.dims) ? input.dims : [];
  const bet = input.bet && typeof input.bet === 'object' ? input.bet : {};
  return {
    version: PREDICT_VERSION,
    predictor: text(input.predictor),
    basis: text(input.basis),
    dims: dims.map((d) => ({
      id: text(d?.id),
      expected: Number(d?.expected),
      why: text(d?.why),
    })),
    bet: {
      total_low: numOrNull(bet.total_low),
      total_high: numOrNull(bet.total_high),
      risk_dims: Array.isArray(bet.risk_dims) ? bet.risk_dims.map(text).filter(Boolean) : [],
    },
    sealed_at: text(input.sealed_at),
    digest: text(input.digest),
  };
}

/**
 * 封一份预测：盖时间戳与摘要。封过的不许再封（返回已封的那份），
 * 这条是「预测不可改」的机械保证，不是嘱咐。
 */
export function sealPrediction(prediction, now = new Date()) {
  const base = normalizePrediction(prediction);
  if (base.sealed_at && base.digest) return base;
  const body = { ...base, sealed_at: '', digest: '' };
  return { ...base, sealed_at: now.toISOString(), digest: digestOf(body) };
}

/** 校验预测：能不能拿去和判分对账。 */
export function validatePrediction(prediction, rubric) {
  const errors = [];
  const warnings = [];
  const pred = normalizePrediction(prediction);
  const dims = rubric?.dims ?? [];

  if (!dims.length) {
    errors.push('这个目标没有 rubric：没有标准就没有可预测的东西。');
    return { ok: false, errors, warnings };
  }
  if (!pred.basis) {
    errors.push('缺 basis：写清「凭什么这么押」（上次同类交付哪一维掉过分）。没有依据的预测是瞎猜，对账时学不到东西。');
  } else if (pred.basis.length < 12) {
    errors.push(`basis 只有 ${pred.basis.length} 字（至少要 12）：一句话讲不清依据，等于没依据。`);
  }

  const want = new Set(dims.map((d) => d.id));
  const got = new Set();
  for (const d of pred.dims) {
    if (!d.id) {
      errors.push('有一条预测没写维度 id。');
      continue;
    }
    if (!want.has(d.id)) {
      errors.push(`预测里多出维度 ${d.id}：rubric 里没有这一维，对不上账。`);
      continue;
    }
    if (got.has(d.id)) {
      errors.push(`维度 ${d.id} 预测了两次。`);
      continue;
    }
    got.add(d.id);
    if (!DIM_SCORES.includes(d.expected)) {
      errors.push(`维度 ${d.id} 的预测分是 ${d.expected}：只能押 ${DIM_SCORES.join(' / ')} 四档之一。`);
    }
  }
  for (const d of dims) {
    if (!got.has(d.id)) errors.push(`维度 ${d.id}（${d.name}）没有预测：每一维都要押，跳过的那维就是对账时的黑洞。`);
  }

  // 预测要和自己的分自洽：押的维分算出来必须落在你报的区间里。
  if (Number.isFinite(pred.bet.total_low) && Number.isFinite(pred.bet.total_high)) {
    if (pred.bet.total_low > pred.bet.total_high) {
      errors.push(`bet 区间反了：total_low ${pred.bet.total_low} > total_high ${pred.bet.total_high}。`);
    }
    const complete = pred.dims.filter((d) => DIM_SCORES.includes(d.expected));
    if (complete.length === dims.length) {
      const scores = Object.fromEntries(pred.dims.map((d) => [d.id, d.expected]));
      const computed = scoreTotal(rubric, scores).total;
      if (computed < pred.bet.total_low - 0.01 || computed > pred.bet.total_high + 0.01) {
        errors.push(
          `预测自相矛盾：按你押的维分算出来是 ${computed}，但报的区间是 ${pred.bet.total_low}–${pred.bet.total_high}。`
          + '（要么改维分，要么改区间，不许两头松）',
        );
      }
    }
  } else {
    errors.push('缺 bet.total_low / total_high：押一个总分区间，不然对账只剩逐维，看不出整体偏了多少。');
  }

  for (const id of pred.bet.risk_dims) {
    if (!want.has(id)) warnings.push(`risk_dims 里的 ${id} 不在 rubric 中，对账时会忽略。`);
  }
  for (const d of pred.dims) {
    if (!d.why) warnings.push(`维度 ${d.id} 只押了分没写 why：能对账，但没法解释为什么这么押。`);
  }
  if (!pred.predictor) warnings.push('没写 predictor：不知道是谁押的，也就没法查「押注人和判分人是不是同一个」。');

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 对账：把预测和实际判分逐维比。
 * delta = 实际 − 预测。delta < 0 表示**高估**（尺子把稿子想得比实际好）。
 */
export function compare(prediction, review, rubric) {
  const pred = normalizePrediction(prediction);
  const dims = rubric?.dims ?? [];
  const actualById = new Map();
  // audited 里只有重算总分、没有逐维分数；两种形状都接，免得调用方记错一层。
  const given = Array.isArray(review?.dims)
    ? review.dims
    : Array.isArray(review?.audited?.dims) ? review.audited.dims : [];
  for (const d of given) {
    const id = text(d?.id);
    if (id) actualById.set(id, Number(d?.score));
  }
  const predById = new Map(pred.dims.map((d) => [d.id, d]));

  const rows = [];
  let over = 0;
  let under = 0;
  let hit = 0;
  for (const dim of dims) {
    const p = predById.get(dim.id);
    const a = actualById.get(dim.id);
    const predicted = p && DIM_SCORES.includes(p.expected) ? p.expected : null;
    const actual = Number.isFinite(a) && DIM_SCORES.includes(a) ? a : null;
    const delta = predicted !== null && actual !== null ? actual - predicted : null;
    let dir = 'unknown';
    if (delta !== null) {
      if (delta === 0) { dir = 'exact'; hit += 1; }
      else if (Math.abs(delta) <= 1) { dir = delta < 0 ? 'slightly_over' : 'slightly_under'; hit += 1; }
      else if (delta < 0) dir = 'over';
      else dir = 'under';
      if (delta < 0) over += 1;
      else if (delta > 0) under += 1;
    }
    rows.push({
      id: dim.id,
      name: dim.name,
      weight: dim.weight,
      predicted,
      actual,
      delta,
      dir,
    });
  }

  const predScores = Object.fromEntries(pred.dims.filter((d) => DIM_SCORES.includes(d.expected)).map((d) => [d.id, d.expected]));
  const predictedTotal = dims.length && pred.dims.length === dims.length ? scoreTotal(rubric, predScores).total : null;
  const actualTotal = Number.isFinite(review?.audited?.total) ? review.audited.total : null;
  const totalDelta = predictedTotal !== null && actualTotal !== null
    ? Math.round((actualTotal - predictedTotal) * 100) / 100
    : null;

  let bias = 'none';
  if (over > 0 && under === 0) bias = 'over';
  else if (under > 0 && over === 0) bias = 'under';
  else if (over > 0 && under > 0) bias = 'mixed';

  const judged = rows.filter((r) => r.delta !== null).length;
  return {
    dims: rows,
    total: {
      predicted: predictedTotal,
      actual: actualTotal,
      delta: totalDelta,
      in_bet: predictedTotal !== null && Number.isFinite(pred.bet.total_low)
        && predictedTotal >= pred.bet.total_low - 0.01 && predictedTotal <= pred.bet.total_high + 0.01,
      bet: { low: pred.bet.total_low, high: pred.bet.total_high },
    },
    judged,
    hit_rate: judged ? Math.round((hit / judged) * 100) / 100 : null,
    over,
    under,
    bias,
    sealed_at: pred.sealed_at || null,
    digest: pred.digest || null,
  };
}

/**
 * 连续偏差计数：从最近一次复盘往回数，同向连续几轮。
 * mixed / none 打断连续（那是「尺子有时高有时低」，该改的是判据措辞，不是统一调权重）。
 */
export function biasStreak(retros, limit = BIAS_STREAK_LIMIT) {
  const seq = Array.isArray(retros) ? retros : [];
  let streak = 0;
  let dir = null;
  for (let i = seq.length - 1; i >= 0; i -= 1) {
    const b = seq[i]?.bias;
    // mixed / none 都直接断：那是「尺子有时高有时低」或「此刻准」，
    // 不能再算进同向连续——否则中间夹一轮 mixed 也会被判成三轮高估。
    if (b !== 'over' && b !== 'under') break;
    if (dir === null) dir = b;
    if (b !== dir) break;
    streak += 1;
  }
  return { streak, dir, limit, warn: streak >= limit };
}

/** rubric 的差异：改了什么，一眼能看出。 */
export function rubricDiff(prev, next) {
  const a = prev?.dims ?? [];
  const b = next?.dims ?? [];
  const aIds = new Set(a.map((d) => d.id));
  const bIds = new Set(b.map((d) => d.id));
  const added = b.filter((d) => !aIds.has(d.id)).map((d) => d.id);
  const removed = a.filter((d) => !bIds.has(d.id)).map((d) => d.id);
  const changed = [];
  for (const d of b) {
    const old = a.find((x) => x.id === d.id);
    if (!old) continue;
    const fields = [];
    if (old.weight !== d.weight) fields.push(`weight ${old.weight}→${d.weight}`);
    if (text(old.criterion) !== text(d.criterion)) fields.push('criterion');
    if (text(old.pass_example) !== text(d.pass_example)) fields.push('pass_example');
    if (text(old.fail_example) !== text(d.fail_example)) fields.push('fail_example');
    if (text(old.intent) !== text(d.intent)) fields.push('intent');
    if (text(old.vision) !== text(d.vision)) fields.push('vision');
    if (fields.length) changed.push({ id: d.id, fields });
  }
  const barChanged = (prev?.bar ?? DEFAULT_BAR) !== (next?.bar ?? DEFAULT_BAR);
  return {
    added,
    removed,
    changed,
    bar: barChanged ? { from: prev?.bar ?? DEFAULT_BAR, to: next?.bar ?? DEFAULT_BAR } : null,
    empty: added.length === 0 && removed.length === 0 && changed.length === 0 && !barChanged,
  };
}

/**
 * 换尺子的刹车：得给理由，且旧分必须作废。
 * 「重判历史样本」这条太重，这里只做提醒（warning）——不假装能做，写进 README。
 */
export function validateRubricChange(prev, next, reason) {
  const errors = [];
  const warnings = [];
  const diff = rubricDiff(prev, next);
  if (diff.empty) return { ok: true, errors, warnings, diff, changed: false };
  const why = text(reason);
  if (!why) {
    errors.push('换标准必须给 rubric_change_reason：写清「哪一维判错了、被什么证据推翻」。静默换尺子等于把历史分数变成无法比较的数字。');
  } else if (why.length < 12) {
    errors.push(`rubric_change_reason 只有 ${why.length} 字（至少 12）：一句话讲不清为什么换，三个月后你自己也不认。`);
  }
  if (diff.removed.length && !why) {
    errors.push(`删掉了维度 ${diff.removed.join('、')}：删维必须说明是「被推翻」还是「被吸收进别的维」。`);
  }
  warnings.push('换标准后，旧判分已标记 stale：新分与旧分不可直接比较，别拿来做趋势。');
  warnings.push('若校准池里已有实绩样本，严格做法是用新标准重判全部样本、更准才认这次升级（本插件不代做，只提醒）。');
  return { ok: errors.length === 0, errors, warnings, diff, changed: true };
}

/** 对账结论一句话。 */
export function retroLine(result) {
  if (!result || result.judged === 0) return '对账做不了：预测或判分里没有可比的维度分。';
  const t = result.total.delta;
  const head = t === null
    ? `逐维对账：押中 ${Math.round(result.hit_rate * 100)}%`
    : `押 ${result.total.predicted} 实际 ${result.total.actual}（差 ${t > 0 ? '+' : ''}${t}）`;
  const tail = result.bias === 'over'
    ? '，尺子偏高：标准把稿子想得比实际好'
    : result.bias === 'under'
      ? '，尺子偏低：实际比标准认的更好'
      : result.bias === 'mixed'
        ? '，有高有低：该改的是判据措辞，不是统一调权重'
        : '，偏差为零';
  return `${head}${tail}。`;
}
