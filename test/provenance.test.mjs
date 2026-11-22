/**
 * 1.2.0 契约测试：代价台账 / 拒绝清单 / 下一步。
 *
 * 这一层要防的不是"忘了写文档"，是「说了借鉴却只抄了功能清单」。
 * 所以判据不是"有没有 provenance 字段"，而是"抄来的东西能不能指回对方付过的代价"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeContract,
  normalizeProvenance,
  normalizeRefusals,
  validateContract,
  nextStep,
} from '../lib/goal-core.mjs';

const BASE = {
  objective: '把询价页做到能提交一次完整 RFQ 并拿到落库结果',
  done_when: [
    { claim: '进程退出码为 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
  ],
  non_goals: ['不做多语言'],
};

const GOOD_PROV = {
  source: 'hechenhao9/dsh-judge-loop v2.0.0 README',
  paid_for: '把机械闸门砍掉，因为门槛设 100 分导致八版稿无限循环',
  kept: '保留 95 分合格线，改成机器可判的分数重算',
};

const GOOD_REFUSAL = {
  ask: '把合格线从 95 降到 90，让这版过',
  why: '降阈值会改掉整把尺子，历史分数立刻失去可比性',
};

/** rubric 由入口挂到合约上（normalizeContract 不管评审层），测试里手动补。 */
function contractWithRubric(patch = {}) {
  const c = normalizeContract(BASE);
  c.rubric = { dims: [{ id: 'M1' }], bar: 95, vetoes: [{ id: 'V1' }], ...patch };
  return c;
}

test('normalizeProvenance：单对象也接受，id 自动 P1', () => {
  const list = normalizeProvenance(GOOD_PROV);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'P1');
  assert.equal(list[0].source, GOOD_PROV.source);
});

test('normalizeProvenance：空输入给空数组，不塞假条目', () => {
  assert.deepEqual(normalizeProvenance(undefined), []);
  assert.deepEqual(normalizeProvenance([]), []);
});

test('normalizeRefusals：id 自动 R1，缺字段给空串', () => {
  const list = normalizeRefusals({ ask: '只写测试不写文档' });
  assert.equal(list[0].id, 'R1');
  assert.equal(list[0].why, '');
});

test('合约里没有借鉴词：不写台账也能过', () => {
  const c = normalizeContract(BASE);
  const v = validateContract(c);
  assert.equal(v.ok, true, v.errors.join(' / '));
});

test('合约自称「借鉴」却没台账：拒收，且说清抄壳与抄骨头的差别', () => {
  const c = normalizeContract({ ...BASE, objective: '借鉴 judge-loop 的做法重做询价页验收' });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /抄到壳|抄壳/.test(e)), v.errors.join(' / '));
});

test('有完整台账：借鉴词放行', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '借鉴 judge-loop 的做法重做询价页验收',
    provenance: [GOOD_PROV],
  });
  const v = validateContract(c);
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.deepEqual(v.warnings, []);
});

test('paid_for 太短：拒收——「它做得挺好」等于没抄到骨头', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance: [{ ...GOOD_PROV, paid_for: '它做得挺好' }],
  });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('paid_for')), v.errors.join(' / '));
});

test('paid_for 里没有可查线索：只 warning，不拦下（措辞自由）', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance: [{ ...GOOD_PROV, paid_for: '他们考虑得非常周到所以这么设计' }],
  });
  const v = validateContract(c);
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.ok(v.warnings.some((w) => w.includes('代价线索')), v.warnings.join(' / '));
});

test('kept 太短：拒收——必须说清保留或改了什么', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance: [{ ...GOOD_PROV, kept: '照搬' }],
  });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('kept')), v.errors.join(' / '));
});

test('source 为空：拒收——必须能回去查', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance: [{ ...GOOD_PROV, source: '' }],
  });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('source')), v.errors.join(' / '));
});

test('豁免要有理由：声明 waived 但理由太短 → 拒收', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance_waived: true,
    provenance_waiver_reason: '没抄',
  });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('provenance_waived')), v.errors.join(' / '));
});

test('豁免有正当理由：降为 warning，允许继续', () => {
  const c = normalizeContract({
    ...BASE,
    objective: '参考 judge-loop 重做验收',
    provenance_waived: true,
    provenance_waiver_reason: '这次是全新设计，judge-loop 里没有对应的代价记录可引用',
  });
  const v = validateContract(c);
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.ok(v.warnings.some((w) => w.includes('已声明豁免')), v.warnings.join(' / '));
});

test('拒绝清单：写完整不拦', () => {
  const c = normalizeContract({ ...BASE, refusals: [GOOD_REFUSAL] });
  const v = validateContract(c);
  assert.equal(v.ok, true, v.errors.join(' / '));
});

test('拒绝清单：why 太短 → 拒收（下次还会被重新提一遍）', () => {
  const c = normalizeContract({ ...BASE, refusals: [{ ...GOOD_REFUSAL, why: '不行' }] });
  const v = validateContract(c);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('R1')), v.errors.join(' / '));
});

test('拒绝清单：ask 为空 → 拒收', () => {
  const c = normalizeContract({ ...BASE, refusals: [{ why: GOOD_REFUSAL.why }] });
  const v = validateContract(c);
  assert.equal(v.ok, false);
});

test('nextStep：没跑过检查 → 先 goal_check', () => {
  const n = nextStep({ contract: normalizeContract({ ...BASE, rubric: undefined }) });
  assert.equal(n.tool, 'goal_check');
});

test('nextStep：机器层红 → 回 goal_check，并报出几条', () => {
  const n = nextStep({
    contract: normalizeContract(BASE),
    proof: { round: 1, summary: { total: 2, pass: 1, fail: 1, unknown: 0 } },
  });
  assert.equal(n.tool, 'goal_check');
  assert.match(n.why, /1 条失败/);
});

test('nextStep：机器层绿且有 rubric 但没押注 → goal_predict', () => {
  const c = contractWithRubric();
  const n = nextStep({ contract: c, proof: { round: 1, summary: { total: 2, pass: 2, fail: 0, unknown: 0 } } });
  assert.equal(n.tool, 'goal_predict');
});

test('nextStep：押了没对账 → goal_retro', () => {
  const c = contractWithRubric();
  const n = nextStep({
    contract: c,
    proof: { round: 1, summary: { total: 2, pass: 2, fail: 0, unknown: 0 } },
    pred: { round: 1 },
    retros: [],
  });
  assert.equal(n.tool, 'goal_retro');
});

test('nextStep：判分 stale → 回去重判', () => {
  const c = contractWithRubric();
  const n = nextStep({
    contract: c,
    proof: { round: 1, summary: { total: 2, pass: 2, fail: 0, unknown: 0 } },
    pred: { round: 1 },
    retros: [{ round: 1 }],
    review: { stale: true, audited: { total: 100 } },
  });
  assert.equal(n.tool, 'goal_review');
  assert.match(n.why, /判据换过/);
});

test('nextStep：分数差一点 → goal_review，并报出差多少', () => {
  const c = contractWithRubric();
  const n = nextStep({
    contract: c,
    proof: { round: 1, summary: { total: 2, pass: 2, fail: 0, unknown: 0 } },
    pred: { round: 1 },
    retros: [{ round: 1 }],
    review: { stale: false, audited: { total: 94 } },
  });
  assert.equal(n.tool, 'goal_review');
  assert.match(n.why, /差 1 /);
});

test('nextStep：都过线 → goal_verdict', () => {
  const c = contractWithRubric();
  const n = nextStep({
    contract: c,
    proof: { round: 1, summary: { total: 2, pass: 2, fail: 0, unknown: 0 } },
    pred: { round: 1 },
    retros: [{ round: 1 }],
    review: { stale: false, audited: { total: 100 } },
  });
  assert.equal(n.tool, 'goal_verdict');
});

test('nextStep：预算用满 → 停手写 BLOCKED，而不是继续修', () => {
  const c = normalizeContract({ ...BASE, budget: { max_rounds: 2 } });
  const n = nextStep({ contract: c, proof: { round: 2, summary: { total: 1, pass: 0, fail: 1, unknown: 0 } } });
  assert.equal(n.tool, null);
  assert.equal(n.blocked, true);
  assert.match(n.why, /BLOCKED/);
});

test('nextStep：放弃的目标不再推', () => {
  const n = nextStep({ contract: { status: 'abandoned' } });
  assert.equal(n.tool, null);
  assert.equal(n.blocked, false);
});
