// 评审层内核：judge-loop 的「标准 + 判分」变成可被机器抽查的数据结构。
//
// 目标工程的两层闸门：
//   机器层（goal-core.mjs）：check 是一条命令，0/1 判定，0 容忍。
//   评审层（本文件）      ：criterion 是一句人话判据，机器验不了「写得好不好」，
//                          但它验得了判分过程里那些可以被抽查的部分——
//                          引文是否逐字存在、分数是否合法、算术是否自洽、扣分是否可落地。
//
// 一句话：人做判断，机器做审计。

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const RUBRIC_VERSION = 1;
/** 判分档位：只给四档，禁止 8.5 这种「看起来很精确」的分数。 */
export const DIM_SCORES = [0, 4, 7, 10];
/** 合格线默认 95：95 = 发出去不会被问倒，再往上 5 分花在没人看的地方。 */
export const DEFAULT_BAR = 95;
/** quote 的最短长度：太短的一句话到处都有，抽查不出「这一条是不是真的引自稿子」。 */
export const MIN_QUOTE_CHARS = 12;
/** 红线：命中任何一条，分数再高也不许交。 */
export const VETO_MIN_WHY = 10;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const chars = (s) => [...str(s)].length;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

/** 判据里必须能被外部抽查的东西：路径、文件名、行号、数字、命令、原文片段。 */
const TRACEABLE = /(\d|\.md|\.mjs|\.js|\.json|\.ts|\.py|\.sh|\.ps1|\/|\\|行|第\s*\d|命令|`[^`]+`|「[^」]+」)/;

function normalizeDim(dim = {}, i = 0) {
  return {
    id: str(dim.id) || `M${i + 1}`,
    name: str(dim.name) || `维度${i + 1}`,
    weight: Number.isFinite(num(dim.weight)) ? num(dim.weight) : Number.NaN,
    criterion: str(dim.criterion),
    pass_example: str(dim.pass_example),
    fail_example: str(dim.fail_example),
    intent: str(dim.intent),
    vision: str(dim.vision),
    evidence: str(dim.evidence) || null,
    machine: Array.isArray(dim.machine) ? dim.machine.filter((m) => str(m)) : [],
  };
}

function normalizeVeto(v = {}, i = 0) {
  return {
    id: str(v.id) || `V${i + 1}`,
    name: str(v.name) || `红线${i + 1}`,
    why: str(v.why),
  };
}

/**
 * 规整一份 rubric。没有维度就返回 null——「没有标准」是合法状态，
 * 意味着这个目标只有机器层闸门（纯工程任务常见）。
 */
export function normalizeRubric(input) {
  if (!input || typeof input !== 'object') return null;
  const rawDims = Array.isArray(input.dims) ? input.dims : [];
  if (!rawDims.length) return null;
  const bar = Number.isFinite(num(input.bar)) ? num(input.bar) : DEFAULT_BAR;
  return {
    version: RUBRIC_VERSION,
    topic: str(input.topic) || null,
    source: str(input.source) || 'inline', // inline | rubric.json
    professor: input.professor && typeof input.professor === 'object'
      ? { blind: input.professor.blind !== false, basis: str(input.professor.basis) || null }
      : { blind: true, basis: null },
    dims: rawDims.map(normalizeDim),
    vetoes: (Array.isArray(input.vetoes) ? input.vetoes : []).map(normalizeVeto),
    bar: Math.min(100, Math.max(80, bar)),
  };
}

/**
 * 校验 rubric 自身是否立得住。这里拦掉的是「出题人耍赖」那一类：
 * 平均分配权重、判据没有可抽查对象、正反例是同一句、维度太少没法区分好坏。
 */
export function validateRubric(rubric) {
  const errors = [];
  const warnings = [];
  if (!rubric) return { ok: true, errors, warnings, scoreable: false };

  const dims = rubric.dims ?? [];
  if (dims.length < 4 || dims.length > 6) {
    errors.push(`维度必须 4–6 个（当前 ${dims.length} 个）：少了分不出好坏，多了没人算得清`);
  }

  const seen = new Set();
  let sum = 0;
  for (const d of dims) {
    if (seen.has(d.id)) errors.push(`维度 id 重复：${d.id}`);
    seen.add(d.id);

    if (!Number.isFinite(d.weight)) {
      errors.push(`${d.id} 缺 weight`);
    } else {
      sum += d.weight;
      if (d.weight < 10 || d.weight > 30) {
        errors.push(`${d.id} 的 weight=${d.weight} 越界：必须在 10–30 之间（会直接害人的给 25–30，只是不漂亮的给 10–15）`);
      }
    }

    if (chars(d.criterion) < 12) {
      errors.push(`${d.id} 的 criterion 太短（${chars(d.criterion)} 字）：至少要 12 字，且必须写清『查哪里、看到什么算过』`);
    } else if (!TRACEABLE.test(d.criterion)) {
      warnings.push(`${d.id} 的 criterion 里没有路径/行号/数字/命令这类东西，外部抽不到，判分会流于印象`);
    }

    if (chars(d.pass_example) < 8) errors.push(`${d.id} 缺 pass_example（≥8 字）`);
    if (chars(d.fail_example) < 8) errors.push(`${d.id} 缺 fail_example（≥8 字）`);
    if (d.pass_example && d.pass_example === d.fail_example) {
      errors.push(`${d.id} 的 pass_example 与 fail_example 完全相同：正反例一样，等于没说清什么算过`);
    }
    if (chars(d.intent) < 8) errors.push(`${d.id} 缺 intent：这条防的是哪种稿子`);
    if (chars(d.vision) < 8) errors.push(`${d.id} 缺 vision：满分长什么样`);
  }

  if (dims.length) {
    if (Math.abs(sum - 100) > 0.01) errors.push(`权重合计 ${sum}，必须正好 100`);
    const uniq = new Set(dims.map((d) => d.weight));
    if (dims.length >= 4 && uniq.size === 1) {
      warnings.push(`四个维度权重全等于 ${dims[0].weight}：平均分配通常意味着还没想清楚哪条更要命`);
    }
  }

  const vetoes = rubric.vetoes ?? [];
  if (!vetoes.length) {
    errors.push('缺 vetoes：至少要有一条『命中就不许交』的红线（编数据、拿立场当事实、自相矛盾、答应做不到的事）');
  }
  const vseen = new Set();
  for (const v of vetoes) {
    if (vseen.has(v.id)) errors.push(`红线 id 重复：${v.id}`);
    vseen.add(v.id);
    if (chars(v.why) < VETO_MIN_WHY) errors.push(`${v.id} 的 why 太短：要写清为什么这条命中就不能交`);
  }

  return { ok: errors.length === 0, errors, warnings, scoreable: true };
}

/** 总分 = Σ(score/10 × weight)。权重合计 100 时，满分即 100。 */
export function scoreTotal(rubric, scores) {
  const dims = rubric?.dims ?? [];
  let total = 0;
  for (const d of dims) {
    const s = scores instanceof Map ? scores.get(d.id) : scores?.[d.id];
    if (!Number.isFinite(num(s))) return { total: Number.NaN, missing: d.id };
    total += (num(s) / 10) * (Number.isFinite(d.weight) ? d.weight : 0);
  }
  return { total: Math.round(total * 100) / 100, missing: null };
}

/**
 * 逐字校验引文。这是评审层里唯一真正「机器说了算」的地方：
 * 判分人说「稿里第 12 行写着 X」，那就必须能在文件里原样找到 X。
 */
export function checkQuote(quote, baseDir) {
  const out = { ok: false, error: null, warning: null, line: null, file: null };
  if (!quote || typeof quote !== 'object') {
    out.error = '缺 quote：每一档打分都要附一句稿子里逐字存在的原文';
    return out;
  }
  const rel = str(quote.file);
  const text = typeof quote.text === 'string' ? quote.text : '';
  if (!rel) { out.error = 'quote 缺 file'; return out; }
  if (chars(text) < MIN_QUOTE_CHARS) {
    out.error = `quote 只有 ${chars(text)} 字（少于 ${MIN_QUOTE_CHARS}）：太短的句子到处都有，抽查不出它是不是真引自这一份`;
    return out;
  }

  const abs = path.resolve(baseDir, rel);
  out.file = abs;
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    out.error = `quote.file 不存在：${rel}`;
    return out;
  }

  let body;
  try {
    body = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    out.error = `quote.file 读不了：${rel}（${e.message}）`;
    return out;
  }

  const needle = text.trim();
  const idx = body.indexOf(needle);
  if (idx < 0) {
    out.error = `quote 在 ${rel} 里逐字找不到：「${needle.slice(0, 40)}${needle.length > 40 ? '…' : ''}」——引文必须是原文，转述不算`;
    return out;
  }

  out.line = body.slice(0, idx).split('\n').length;
  if (Number.isFinite(num(quote.line)) && num(quote.line) !== out.line) {
    out.warning = `申报行号 ${num(quote.line)}，实际在 ${out.line} 行（行号漂移，quote 本身是真的）`;
  }
  out.ok = true;
  return out;
}

/**
 * 校验一次判分。返回的东西足以直接决定「能不能交」。
 *
 * review 结构：
 * {
 *   reviewer: "独立判分人标识", round: 1,
 *   dims: [{ id, score, quote:{file,text,line}, deduction, beyond_spec }],
 *   vetoes_hit: [id...], total: 92.5, blocked: false, notes: ""
 * }
 */
export function validateReview(review, rubric, baseDir = process.cwd()) {
  const errors = [];
  const warnings = [];
  const result = {
    ok: false, errors, warnings,
    total: Number.NaN, declared: Number.NaN,
    vetoes_hit: [], scoreable: Boolean(rubric?.dims?.length),
    deliverable: false,
  };
  if (!review || typeof review !== 'object') {
    errors.push('缺 review：有 rubric 就必须有一份独立判分');
    return result;
  }

  const reviewer = str(review.reviewer);
  if (!reviewer) errors.push('review 缺 reviewer：判分人必须是可指认的一方');
  if (/^(self|me|自己|我自己)$/i.test(reviewer)) {
    errors.push(`reviewer="${reviewer}"：自己写的稿子自己判分不算数（出题人和考生不能是同一个人）`);
  }

  if (!result.scoreable) {
    // 没有 rubric 时，判分文件是无意义的：允许存在，但不能作为放行依据。
    warnings.push('这次目标没有 rubric，review 不参与放行判定');
    result.ok = errors.length === 0;
    return result;
  }

  const byId = new Map();
  for (const d of Array.isArray(review.dims) ? review.dims : []) {
    const id = str(d?.id);
    if (!id) { errors.push('有维度缺 id'); continue; }
    if (byId.has(id)) errors.push(`维度 ${id} 判了两次`);
    byId.set(id, d);
  }

  const scores = new Map();
  for (const dim of rubric.dims) {
    const d = byId.get(dim.id);
    if (!d) { errors.push(`维度 ${dim.id}（${dim.name}）没判分`); continue; }

    const score = num(d.score);
    if (!DIM_SCORES.includes(score)) {
      errors.push(`${dim.id} 的分数 ${d.score} 不合法：只允许 ${DIM_SCORES.join(' / ')} 四档`);
      continue;
    }
    scores.set(dim.id, score);

    const q = checkQuote(d.quote, baseDir);
    if (!q.ok) errors.push(`${dim.id} 的引文不合格：${q.error}`);
    if (q.warning) warnings.push(`${dim.id}：${q.warning}`);

    if (score < 10) {
      const fix = str(d.deduction);
      if (!fix) {
        errors.push(`${dim.id} 给了 ${score} 分却没写 deduction：扣分必须落成一句可执行的话（把 X 改成 Y）`);
      } else if (!/把|改|删|补|换|加/.test(fix)) {
        warnings.push(`${dim.id} 的 deduction 不像一个可执行动作：「${fix.slice(0, 30)}」`);
      }
    }

    if (score === 10 && !str(d.beyond_spec)) {
      // 只在该维满分时要求：满分必须能说出「原需求没要求、但下一步真会用上」的那一点。
      warnings.push(`${dim.id} 拿了 10 分但没写 beyond_spec：满分维度要说清比要求多做了什么`);
    }
  }

  for (const id of byId.keys()) {
    if (!rubric.dims.some((d) => d.id === id)) errors.push(`判分里出现了 rubric 没有的维度：${id}`);
  }

  const recomputed = scoreTotal(rubric, scores);
  result.total = recomputed.total;
  result.declared = num(review.total);
  if (Number.isFinite(result.declared) && Number.isFinite(recomputed.total)
      && Math.abs(result.declared - recomputed.total) > 0.01) {
    errors.push(`申报总分 ${result.declared} 与按权重算出的 ${recomputed.total} 不一致：分数由机器重算，不采信手报的数`);
  }

  const hit = (Array.isArray(review.vetoes_hit) ? review.vetoes_hit : []).map(str).filter(Boolean);
  for (const id of hit) {
    if (!rubric.vetoes.some((v) => v.id === id)) warnings.push(`vetoes_hit 里的 ${id} 不在 rubric 红线清单内`);
  }
  result.vetoes_hit = hit;

  const allDimsScored = Number.isFinite(recomputed.total);
  const passed = allDimsScored && recomputed.total >= rubric.bar && hit.length === 0;
  result.deliverable = passed && errors.length === 0;
  result.ok = errors.length === 0;
  if (hit.length) errors.push(`命中红线 ${hit.join('、')}：分数再高也不许交`);
  if (allDimsScored && recomputed.total < rubric.bar) {
    warnings.push(`总分 ${recomputed.total} 未达合格线 ${rubric.bar}`);
  }
  return result;
}

/**
 * 最终裁决：这一份东西现在能不能交出去。
 * 机器层不通 → 一定不能交（哪怕 rubric 满分）。
 * 有 rubric → 评审层也必须过线且无红线。
 */
export function decide({ machineGreen, rubric, review }) {
  const reasons = [];
  const gated = Boolean(rubric?.dims?.length);
  let deliverable = Boolean(machineGreen);
  if (!machineGreen) reasons.push('机器层未全绿');

  if (gated) {
    if (!review) {
      deliverable = false;
      reasons.push('有 rubric 但没有独立判分');
    } else {
      if (!review.ok) {
        deliverable = false;
        reasons.push('判分本身不合格（引文/分数/算术有问题）');
      }
      if ((review.vetoes_hit ?? []).length) {
        deliverable = false;
        reasons.push(`命中红线：${review.vetoes_hit.join('、')}`);
      }
      if (Number.isFinite(review.total) && review.total < rubric.bar) {
        deliverable = false;
        reasons.push(`总分 ${review.total} < 合格线 ${rubric.bar}`);
      }
    }
  }

  return {
    deliverable,
    gated,
    machineGreen: Boolean(machineGreen),
    total: review && Number.isFinite(review.total) ? review.total : null,
    bar: gated ? rubric.bar : null,
    reasons,
  };
}

/** 一句话结论，给汇报用。 */
export function decideLine(verdict) {
  if (verdict.deliverable) {
    return verdict.gated
      ? `可以交：机器层全绿，评审 ${verdict.total} ≥ ${verdict.bar}，无红线。`
      : '可以交：机器层全绿（这个目标没有评审层）。';
  }
  return `不许交：${verdict.reasons.join('；')}。`;
}
