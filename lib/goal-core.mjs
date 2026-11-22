/**
 * goal-core.mjs — 目标工程（Goal Engineering）的内核。
 *
 * 设计原则只有一条：**"做完了"必须由命令判定，不能由我判定。**
 * 因此这里没有任何"我检查过了"的表达能力：
 *  - 每条完成条件（done_when）必须携带一条可执行 check；
 *  - check 的结果只有三态：pass / fail / unknown；
 *  - manual 条目一律计入 unknown，unknown 不计入绿灯。
 *
 * 纯函数在前（可单测、无 IO），执行器在后。
 */

import { exec } from 'node:child_process';
import path from 'node:path';

/** 目标台账目录名（相对工作区根）。 */
export const GOAL_DIR = '.goal';

/** expect.kind 合法集合。 */
export const EXPECT_KINDS = ['exit', 'equals', 'contains', 'not_contains', 'matches', 'manual'];

/** claim 里出现这些词，才说明"怎么算做到了"是可疑可观测的。 */
const OBSERVABLE = /\d|返回|等于|包含|存在|不为空|通过|退出码|状态码|status|pass|ok|success|>=|<=|===|!==|http/i;

/** 合约自称「抄了别人的」——这时必须交代对方付过什么代价。 */
const BORROW = /借鉴|参考|照抄|复刻|移植|对标|对齐|fork|clone|port(ed)?\b|抄/i;

/** 代价线索：能被第三方翻回去查的东西（issue / PR / commit / 回退 / 事故 / 版本 / 阈值）。 */
const PAID = /issue|PR\b|commit|回退|回滚|事故|坑|报错|版本|v\d|被拒|拒绝|降级|超时|阈值|bug|失败|撤销|删掉|砍掉|循环|误判/i;

/**
 * 生成稳定 id：日期 + 需求前若干字。
 * @param {string} objective
 * @param {Date} [now]
 * @returns {string}
 */
export function goalId(objective, now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  const t = now.toISOString().slice(11, 16).replace(':', '');
  const slug = String(objective || '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .toLowerCase() || 'goal';
  return `${d}-${t}-${slug}`;
}

/**
 * 把调用方给的松散输入规整成合约。不校验，只补形状。
 * @param {object} input
 * @param {Date} [now]
 * @returns {object}
 */
export function normalizeContract(input = {}, now = new Date()) {
  const objective = String(input.objective ?? '').trim();
  const items = Array.isArray(input.done_when) ? input.done_when : [];
  return {
    id: String(input.id ?? '').trim() || goalId(objective, now),
    objective,
    done_when: items.map((item, i) => {
      const it = item && typeof item === 'object' ? item : { claim: String(item ?? '') };
      const expect = it.expect && typeof it.expect === 'object' ? it.expect : { kind: 'exit', value: 0 };
      return {
        id: String(it.id ?? `D${i + 1}`),
        claim: String(it.claim ?? '').trim(),
        check: String(it.check ?? '').trim(),
        cwd: it.cwd === undefined || it.cwd === null || it.cwd === '' ? '' : String(it.cwd),
        timeout_ms: Number.isFinite(Number(it.timeout_ms)) && Number(it.timeout_ms) > 0
          ? Number(it.timeout_ms)
          : 120000,
        expect: {
          kind: String(expect.kind ?? 'exit').trim(),
          value: expect.value === undefined ? 0 : expect.value,
        },
      };
    }),
    constraints: toStrList(input.constraints),
    non_goals: toStrList(input.non_goals),
    // 代价台账：抄来的东西必须写清"对方付过什么学费"，否则抄到的是壳。
    provenance: normalizeProvenance(input.provenance),
    // 拒绝清单：被明确说"不"的要求，比功能清单更能说明边界。
    refusals: normalizeRefusals(input.refusals),
    provenance_waived: input.provenance_waived === true,
    provenance_waiver_reason: String(input.provenance_waiver_reason ?? '').trim(),
    budget: normalizeBudget(input.budget),
    created_at: String(input.created_at ?? now.toISOString()),
    status: String(input.status ?? 'open'),
    revision: Number.isFinite(Number(input.revision)) ? Number(input.revision) : 1,
  };
}

/** @param {unknown} v @returns {string[]} */
function toStrList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/**
 * 代价台账条目。
 * - source：从哪抄的（仓库/文件/版本/链接）
 * - paid_for：对方为这条设计付过什么代价（事故、回退、被拒的 PR、踩过的坑）
 * - kept：我们保留了什么，或改了什么、为什么改
 * @param {unknown} v
 */
export function normalizeProvenance(v) {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list.map((item, i) => {
    const it = item && typeof item === 'object' ? item : { source: String(item ?? '') };
    return {
      id: String(it.id ?? `P${i + 1}`).trim() || `P${i + 1}`,
      source: String(it.source ?? '').trim(),
      paid_for: String(it.paid_for ?? '').trim(),
      kept: String(it.kept ?? '').trim(),
    };
  });
}

/**
 * 拒绝清单条目：有人会提出的那种要求 + 为什么拒 + 怎么答。
 * @param {unknown} v
 */
export function normalizeRefusals(v) {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list.map((item, i) => {
    const it = item && typeof item === 'object' ? item : { ask: String(item ?? '') };
    return {
      id: String(it.id ?? `R${i + 1}`).trim() || `R${i + 1}`,
      ask: String(it.ask ?? '').trim(),
      why: String(it.why ?? '').trim(),
      reply: String(it.reply ?? '').trim(),
    };
  });
}

/** @param {unknown} v */
function normalizeBudget(v) {
  const b = v && typeof v === 'object' ? v : {};
  const maxRounds = Number(b.max_rounds);
  const maxMinutes = Number(b.max_minutes);
  return {
    max_rounds: Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 5,
    max_minutes: Number.isFinite(maxMinutes) && maxMinutes > 0 ? Math.floor(maxMinutes) : 90,
  };
}

/**
 * 合约门：不合格就不许开工。返回 errors 时调用方必须停下补全，而不是"先干着看"。
 * @param {object} contract
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateContract(contract) {
  const errors = [];
  const warnings = [];

  if (!contract || typeof contract !== 'object') {
    return { ok: false, errors: ['合约缺失'], warnings };
  }
  if (contract.objective.length < 12) {
    errors.push(`objective 太短（${contract.objective.length} 字）：要写清"交付什么、给谁用、规模/范围"，不接受"优化一下""做一下"。`);
  }
  if (!Array.isArray(contract.done_when) || contract.done_when.length === 0) {
    errors.push('done_when 为空：没有可执行验收条件的目标不是目标，只是愿望。');
  } else {
    const seen = new Set();
    for (const item of contract.done_when) {
      if (!item.claim) errors.push(`${item.id}：claim 为空（这一条到底要证明什么）。`);
      if (seen.has(item.id)) errors.push(`${item.id}：id 重复。`);
      seen.add(item.id);
      if (!EXPECT_KINDS.includes(item.expect.kind)) {
        errors.push(`${item.id}：expect.kind "${item.expect.kind}" 非法，只能是 ${EXPECT_KINDS.join('/')}。`);
      }
      if (item.expect.kind === 'manual') {
        warnings.push(`${item.id}：manual 条目不计入绿灯，proof 里会记为 unknown。`);
      } else if (!item.check) {
        errors.push(`${item.id}：check 为空。非 manual 条目必须给一条能真跑的命令。`);
      }
      if (item.claim && !OBSERVABLE.test(item.claim)) {
        warnings.push(`${item.id}：claim「${item.claim}」里没有可观测信号（数字/返回/包含/通过/退出码…），可能仍然不可判定。`);
      }
    }
    if (contract.done_when.every((i) => i.expect.kind === 'manual')) {
      errors.push('全部 done_when 都是 manual：这等于没有验收门，至少留一条机器可判的。');
    }
  }
  if (contract.non_goals.length === 0) {
    warnings.push('non_goals 为空：没写"不做什么"，范围会在执行中膨胀。');
  }

  // ── 代价台账：抄来的东西必须写清对方付过什么学费 ──
  const prov = Array.isArray(contract.provenance) ? contract.provenance : [];
  const seenP = new Set();
  for (const p of prov) {
    if (seenP.has(p.id)) errors.push(`${p.id}：provenance id 重复。`);
    seenP.add(p.id);
    if (!p.source) {
      errors.push(`${p.id}：source 为空——抄的是哪个仓库/文件/版本？写"某个开源项目"等于没写，别人没法回去查。`);
    }
    if (p.paid_for.length < 12) {
      errors.push(`${p.id}：paid_for 只有 ${p.paid_for.length} 字——要写清对方为什么这么设计（哪次事故、哪次回退、哪个被拒的 PR）。写得像"它做得挺好"就是抄壳。`);
    } else if (!PAID.test(p.paid_for)) {
      warnings.push(`${p.id}：paid_for 里没有可查的代价线索（issue/PR/commit/回退/事故/版本/阈值…），判分人无法抽查。`);
    }
    if (p.kept.length < 8) {
      errors.push(`${p.id}：kept 太短——我们保留了哪一条，或改了什么、为什么改？`);
    }
  }
  const borrowing = BORROW.test(contract.objective)
    || (Array.isArray(contract.constraints) && contract.constraints.some((c) => BORROW.test(String(c))));
  if (borrowing && prov.length === 0) {
    if (contract.provenance_waived && contract.provenance_waiver_reason.length >= 12) {
      warnings.push(`合约自称借鉴但没写台账（已声明豁免）：${contract.provenance_waiver_reason}`);
    } else {
      errors.push('合约里出现了「借鉴/参考/复刻/移植」这类词，却没有 provenance：抄想法只抄到壳，抄代价才抄到骨头。补 provenance（source + paid_for + kept），或用 provenance_waived + provenance_waiver_reason（≥12 字）说明这次为什么没有可抄的代价。');
    }
  }
  if (contract.provenance_waived && contract.provenance_waiver_reason.length < 12) {
    errors.push('provenance_waived 需要 provenance_waiver_reason（≥12 字）说明理由，否则等于用开关绕开台账。');
  }

  // ── 拒绝清单：被明确说"不"的要求，比功能清单更能说明边界 ──
  const refs = Array.isArray(contract.refusals) ? contract.refusals : [];
  const seenR = new Set();
  for (const r of refs) {
    if (seenR.has(r.id)) errors.push(`${r.id}：refusals id 重复。`);
    seenR.add(r.id);
    if (!r.ask) errors.push(`${r.id}：ask 为空——写成对方会说的那句话（"把阈值降一点让这次过"）。`);
    if (r.why.length < 10) {
      errors.push(`${r.id}：why 只写 ${r.why.length} 字——不给理由的拒绝，下一轮就有人重新提一遍。`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 判定单条结果。
 * @param {{code: number|null, stdout: string, stderr: string, timedOut: boolean, error: string}} run
 * @param {{kind: string, value: unknown}} expect
 * @returns {{state: 'pass'|'fail'|'unknown', detail: string}}
 */
export function judge(run, expect) {
  if (expect.kind === 'manual') {
    return { state: 'unknown', detail: 'manual：需要人确认，不计入绿灯' };
  }
  if (run.timedOut) return { state: 'fail', detail: `超时（${run.timeoutMs}ms）` };
  if (run.error && run.code === null) return { state: 'fail', detail: `命令未能执行：${run.error}` };

  const out = `${run.stdout || ''}\n${run.stderr || ''}`;
  const trimmed = (run.stdout || '').trim();

  switch (expect.kind) {
    case 'exit': {
      const want = Number(expect.value ?? 0);
      return run.code === want
        ? { state: 'pass', detail: `退出码 ${run.code}` }
        : { state: 'fail', detail: `退出码 ${run.code}，期望 ${want}` };
    }
    case 'equals': {
      const want = String(expect.value ?? '').trim();
      return trimmed === want
        ? { state: 'pass', detail: `stdout 等于「${want}」` }
        : { state: 'fail', detail: `stdout 为「${clip(trimmed)}」，期望「${want}」` };
    }
    case 'contains': {
      const want = String(expect.value ?? '');
      return out.includes(want)
        ? { state: 'pass', detail: `输出包含「${want}」` }
        : { state: 'fail', detail: `输出不含「${want}」：${clip(out)}` };
    }
    case 'not_contains': {
      const want = String(expect.value ?? '');
      return !out.includes(want)
        ? { state: 'pass', detail: `输出不含「${want}」` }
        : { state: 'fail', detail: `输出仍含「${want}」` };
    }
    case 'matches': {
      let re;
      try {
        re = new RegExp(String(expect.value ?? ''));
      } catch (err) {
        return { state: 'unknown', detail: `expect.value 不是合法正则：${String(err)}` };
      }
      const m = re.exec(out);
      return m
        ? { state: 'pass', detail: `匹配 ${clip(m[0], 60)}` }
        : { state: 'fail', detail: `未匹配 /${String(expect.value)}/：${clip(out)}` };
    }
    default:
      return { state: 'unknown', detail: `未知 expect.kind：${expect.kind}` };
  }
}

/** @param {string} s @param {number} [n] */
function clip(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 跑一条 check。
 * @param {object} item 规整后的 done_when 项
 * @param {{cwd: string, defaultTimeoutMs?: number}} opts
 * @returns {Promise<object>}
 */
export function runOne(item, opts) {
  const timeoutMs = item.timeout_ms || opts.defaultTimeoutMs || 120000;
  const cwd = item.cwd ? path.resolve(opts.cwd, item.cwd) : opts.cwd;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = exec(
      item.check,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error.killed || error.signal === 'SIGTERM'));
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        const run = {
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut,
          timeoutMs,
          error: error && typeof error.code !== 'number' ? String(error.message || error) : '',
        };
        const verdict = judge(run, item.expect);
        resolve({
          id: item.id,
          claim: item.claim,
          check: item.check,
          cwd,
          exit_code: code,
          ms: Date.now() - started,
          state: verdict.state,
          detail: verdict.detail,
          stdout_tail: clip(run.stdout, 800),
          stderr_tail: clip(run.stderr, 800),
        });
      },
    );
    // exec 的 timeout 已处理，这里只兜底避免回调丢失。
    child.on('error', () => {});
  });
}

/**
 * 串行跑完整套（串行是刻意的：检查之间常有依赖，并发会给出误绿）。
 * @param {object} contract
 * @param {{cwd: string, only?: string[], defaultTimeoutMs?: number}} opts
 * @returns {Promise<object[]>}
 */
export async function runContract(contract, opts) {
  const only = Array.isArray(opts.only) && opts.only.length > 0 ? new Set(opts.only) : null;
  const items = contract.done_when.filter((i) => (only ? only.has(i.id) : true));
  const out = [];
  for (const item of items) {
    out.push(await runOne(item, { cwd: opts.cwd, defaultTimeoutMs: opts.defaultTimeoutMs }));
  }
  return out;
}

/**
 * 汇总。
 * @param {object[]} results
 * @returns {{total:number, pass:number, fail:number, unknown:number, green:boolean, failing:string[]}}
 */
export function summarize(results) {
  const pass = results.filter((r) => r.state === 'pass').length;
  const fail = results.filter((r) => r.state === 'fail').length;
  const unknown = results.filter((r) => r.state === 'unknown').length;
  return {
    total: results.length,
    pass,
    fail,
    unknown,
    // 绿灯的唯一定义：跑到过的条目全 pass，且没有任何 fail / unknown。
    green: results.length > 0 && fail === 0 && unknown === 0,
    failing: results.filter((r) => r.state !== 'pass').map((r) => `${r.id} ${r.claim} → ${r.detail}`),
  };
}

/**
 * 渲染给人看的一份检查报告。
 * @param {object} contract
 * @param {object[]} results
 * @param {number} round
 * @returns {string}
 */
export function renderReport(contract, results, round) {
  const s = summarize(results);
  const lines = [];
  lines.push(`# 目标检查 · 第 ${round} 轮 · ${contract.id}`);
  lines.push('');
  lines.push(`目标：${contract.objective}`);
  lines.push(`结论：${s.green ? 'GREEN —— 全部验收条件通过' : s.fail > 0 ? `RED —— ${s.fail} 条未通过` : `INCOMPLETE —— ${s.unknown} 条无法判定`}`);
  lines.push('');
  lines.push(`| 条件 | 状态 | 证据 |`);
  lines.push(`|---|---|---|`);
  for (const r of results) {
    lines.push(`| ${r.id} ${r.claim.replace(/\|/g, '/')} | ${r.state.toUpperCase()} | ${r.detail.replace(/\|/g, '/')} |`);
  }
  if (!s.green) {
    lines.push('');
    lines.push('未通过项（下一轮只修这些）：');
    for (const f of s.failing) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

/**
 * 三态结论：用一句话说清"能不能汇报完成"。
 * @param {object[]} results
 * @returns {string}
 */
export function verdictLine(results) {
  const s = summarize(results);
  if (s.green) return `可以汇报完成：${s.pass}/${s.total} 条验收条件由命令判定通过。`;
  if (s.fail > 0) return `不许汇报完成：${s.fail} 条验收失败（${s.failing.join('；')}）。`;
  return `不许汇报完成：${s.unknown} 条无法判定（manual/异常），绿灯要求全部可判。`;
}

/**
 * 下一步该敲哪里：把「现在卡在哪」翻成一个具体的工具调用。
 * 纯判断，不读盘——调用方把 proof / review / pred / retros 递进来。
 * @param {{contract: object, proof?: object|null, review?: object|null, pred?: object|null, retros?: object[]}} input
 * @returns {{tool: string|null, why: string, blocked: boolean}}
 */
export function nextStep(input = {}) {
  const contract = input.contract ?? {};
  const proof = input.proof ?? null;
  const review = input.review ?? null;
  const pred = input.pred ?? null;
  const retros = Array.isArray(input.retros) ? input.retros : [];

  if (contract.status === 'abandoned') return { tool: null, why: '目标已放弃，不用再推', blocked: false };

  const s = proof?.summary ?? null;
  const roundsUsed = Number(proof?.round ?? 0);
  const maxRounds = Number(contract.budget?.max_rounds ?? 5);
  if (roundsUsed >= maxRounds) {
    return { tool: null, why: `已用满 ${maxRounds} 轮预算：该写 BLOCKED（卡哪一条、要什么、当前几分），而不是继续修`, blocked: true };
  }
  if (!s) return { tool: 'goal_check', why: '还没跑过机器层检查', blocked: false };
  if (s.fail > 0 || s.unknown > 0) {
    return { tool: 'goal_check', why: `还有 ${s.fail} 条失败、${s.unknown} 条无法判定，只修这几条`, blocked: false };
  }
  if (!contract.rubric?.dims?.length) {
    return { tool: 'goal_verdict', why: '机器层全绿，没有评审层，可以裁决', blocked: false };
  }
  if (!pred) return { tool: 'goal_predict', why: '机器层绿了，判分之前先押注（押完不可改）', blocked: false };
  const lastRetro = retros.length ? retros[retros.length - 1] : null;
  if (!lastRetro || Number(lastRetro.round ?? 0) < Number(pred.round ?? 0)) {
    return { tool: 'goal_retro', why: `第 ${pred.round} 轮押过了，还没对账`, blocked: false };
  }
  if (!review || review.stale === true) {
    return { tool: 'goal_review', why: review?.stale ? '判据换过，旧判分已作废，要重判' : '还没有判分', blocked: false };
  }
  const total = review.audited?.total;
  const bar = Number(contract.rubric.bar ?? 95);
  if (typeof total === 'number' && total < bar) {
    return { tool: 'goal_review', why: `最近 ${total} 分，差 ${Math.round((bar - total) * 100) / 100} 到合格线：只改扣分项，且每轮至少删一处`, blocked: false };
  }
  return { tool: 'goal_verdict', why: '机器层与评审层都过线，可以裁决', blocked: false };
}
