import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeRubric,
  validateRubric,
  scoreTotal,
  checkQuote,
  validateReview,
  decide,
  decideLine,
  DEFAULT_BAR,
} from '../lib/rubric-core.mjs';

/** 一份合法的 4 维 rubric：权重 30/25/25/20 = 100。 */
function goodRubric() {
  return {
    topic: '测试用标准',
    dims: [
      { id: 'M1', name: '事实', weight: 30, criterion: '每个数字都能在 evidence.md 第 3 行找到对应原始数据', pass_example: '数字后标注了来源文件与行号', fail_example: '数字没有来源，或来源对不上', intent: '防的是编造数字让人据此做错决定', vision: '每个数字都能点回原始记录那一行' },
      { id: 'M2', name: '可执行', weight: 25, criterion: 'README 第 1 节的命令能在空目录里直接跑通并输出 ok', pass_example: '命令可粘贴且退出码为 0', fail_example: '命令缺参数或需要手工改路径', intent: '防的是读者照着命令跑不通', vision: '照抄就能跑通并看到 ok 输出' },
      { id: 'M3', name: '边界', weight: 25, criterion: '文档写明不支持的三类场景，每类至少一句理由', pass_example: '列出不支持项并给了理由', fail_example: '只说不支持但不说为什么', intent: '防的是过度承诺让对方误判范围', vision: '边界写清且每条都给了理由' },
      { id: 'M4', name: '语气', weight: 20, criterion: '全文没有空转式肯定句，每段首句直接给结论', pass_example: '首句即结论，无铺垫', fail_example: '开头三段都在说背景', intent: '防的是 AI 腔铺垫把结论埋掉', vision: '读三行就知道结论是什么' },
    ],
    vetoes: [
      { id: 'V1', name: '编造数据', why: '编一个数字会让对方据此做出错误决定' },
    ],
    bar: 95,
  };
}

test('normalizeRubric：没有维度 → null（纯工程任务没有评审层）', () => {
  assert.equal(normalizeRubric(undefined), null);
  assert.equal(normalizeRubric({ dims: [] }), null);
});

test('normalizeRubric：补齐 id 与默认合格线', () => {
  const r = normalizeRubric({ dims: goodRubric().dims, vetoes: goodRubric().vetoes });
  assert.equal(r.dims[0].id, 'M1');
  assert.equal(r.bar, DEFAULT_BAR);
  assert.equal(r.professor.blind, true);
});

test('validateRubric：合法的 4 维 100 权重通过', () => {
  const v = validateRubric(normalizeRubric(goodRubric()));
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test('validateRubric：3 维被拒收（分不出好坏）', () => {
  const r = goodRubric();
  r.dims.pop();
  r.dims[0].weight = 40;
  r.dims[1].weight = 30;
  r.dims[2].weight = 30;
  const v = validateRubric(normalizeRubric(r));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('4–6')));
});

test('validateRubric：权重合计不是 100 被拒收', () => {
  const r = goodRubric();
  r.dims[0].weight = 40; // 30→40，合计 110
  const v = validateRubric(normalizeRubric(r));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('合计')));
});

test('validateRubric：正反例完全相同被拒收', () => {
  const r = goodRubric();
  r.dims[1].fail_example = r.dims[1].pass_example;
  const v = validateRubric(normalizeRubric(r));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('正反例')));
});

test('validateRubric：缺红线被拒收（没有硬否决就没有底线）', () => {
  const r = goodRubric();
  r.vetoes = [];
  const v = validateRubric(normalizeRubric(r));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('vetoes')));
});

test('validateRubric：判据没有可抽查对象 → warning 而不是拦下', () => {
  const r = goodRubric();
  r.dims[3].criterion = '全文语气要让人觉得舒服自然不别扭';
  const v = validateRubric(normalizeRubric(r));
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes('抽不到')));
});

test('scoreTotal：权重 20 的维度从 10 掉到 7，总分 94', () => {
  const r = normalizeRubric(goodRubric());
  const t = scoreTotal(r, { M1: 10, M2: 10, M3: 10, M4: 7 });
  assert.equal(t.total, 94);
});

test('scoreTotal：缺一维 → NaN 且指出缺谁', () => {
  const r = normalizeRubric(goodRubric());
  const t = scoreTotal(r, { M1: 10, M2: 10, M3: 10 });
  assert.ok(Number.isNaN(t.total));
  assert.equal(t.missing, 'M4');
});

test('checkQuote：逐字存在 → pass 并给出真实行号', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goalloop-'));
  try {
    await writeFile(path.join(dir, 'draft.md'), '# 标题\n\n这一整句话是逐字存在于文件里的原文。\n', 'utf8');
    const q = checkQuote({ file: 'draft.md', text: '这一整句话是逐字存在于文件里的原文。', line: 3 }, dir);
    assert.equal(q.ok, true);
    assert.equal(q.line, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkQuote：转述（不是原文）→ fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goalloop-'));
  try {
    await writeFile(path.join(dir, 'draft.md'), '原话是这个样子的句子。\n', 'utf8');
    const q = checkQuote({ file: 'draft.md', text: '原话大概是这个样子的句子', line: 1 }, dir);
    assert.equal(q.ok, false);
    assert.ok(q.error.includes('逐字找不到'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkQuote：少于 12 字 → fail（太短的句子到处都有）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goalloop-'));
  try {
    await writeFile(path.join(dir, 'draft.md'), '你好世界\n', 'utf8');
    const q = checkQuote({ file: 'draft.md', text: '你好世界' }, dir);
    assert.equal(q.ok, false);
    assert.ok(q.error.includes('12'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkQuote：文件不存在 → fail', () => {
  const q = checkQuote({ file: 'nope.md', text: '这一整句话是不可能存在的原文句子' }, process.cwd());
  assert.equal(q.ok, false);
  assert.ok(q.error.includes('不存在'));
});

test('checkQuote：行号漂移只 warning，quote 本身仍有效', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goalloop-'));
  try {
    await writeFile(path.join(dir, 'draft.md'), '第一行\n第二行是一句足够长的原文句子。\n', 'utf8');
    const q = checkQuote({ file: 'draft.md', text: '第二行是一句足够长的原文句子。', line: 99 }, dir);
    assert.equal(q.ok, true);
    assert.ok(q.warning.includes('行号'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 造一份能过审计的判分。 */
async function goodReviewFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'goalloop-'));
  await writeFile(
    path.join(dir, 'draft.md'),
    [
      '# 交付物',
      '这个数字 128 来自 evidence.md 第 3 行的原始记录。',
      '安装只需粘贴一条命令 npm i 即可跑通并输出 ok。',
      '不支持 Windows 7 因为它没有可用的 TLS 栈。',
      '读三行就知道结论，没有铺垫。',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

function goodReview() {
  return {
    reviewer: 'reviewer-round1',
    round: 1,
    dims: [
      { id: 'M1', score: 10, quote: { file: 'draft.md', text: '这个数字 128 来自 evidence.md 第 3 行的原始记录。', line: 2 }, beyond_spec: '顺手标了行号，下一步能直接点回去' },
      { id: 'M2', score: 7, quote: { file: 'draft.md', text: '安装只需粘贴一条命令 npm i 即可跑通并输出 ok。', line: 3 }, deduction: '把 draft.md:3 的「npm i」改成「npm i -g dsh」并补退出码' },
      { id: 'M3', score: 10, quote: { file: 'draft.md', text: '不支持 Windows 7 因为它没有可用的 TLS 栈。', line: 4 }, beyond_spec: '给了理由而不只是列表' },
      { id: 'M4', score: 10, quote: { file: 'draft.md', text: '读三行就知道结论，没有铺垫。', line: 5 }, beyond_spec: '标题即结论' },
    ],
    vetoes_hit: [],
    total: 92.5,
  };
}

test('validateReview：合法判分通过审计，总分按权重重算', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const v = validateReview(goodReview(), r, dir);
    assert.deepEqual(v.errors, []);
    assert.equal(v.ok, true);
    assert.equal(v.total, 92.5);
    assert.equal(v.deliverable, false, '92.5 < 95，不能交');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：reviewer=self 被拒收（自己不能给自己盖章）', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.reviewer = 'self';
    const v = validateReview(rev, r, dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('自己写')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：分数只能是 0/4/7/10，8 分被拒收', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.dims[1].score = 8;
    const v = validateReview(rev, r, dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('不合法')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：申报总分与重算不一致被拒收', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.total = 100; // 手报 100，实际 92.5
    const v = validateReview(rev, r, dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('重算')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：扣分维度没写 deduction 被拒收（扣分要能落成改法）', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    delete rev.dims[1].deduction;
    const v = validateReview(rev, r, dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('deduction')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：漏判一维被拒收', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.dims.pop();
    const v = validateReview(rev, r, dir);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('没判分')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：命中红线 → deliverable=false 且计入 errors', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.dims.forEach((d) => { d.score = 10; d.beyond_spec = d.beyond_spec ?? '多做了下一步会用到的一点'; });
    rev.total = 100;
    rev.vetoes_hit = ['V1'];
    const v = validateReview(rev, r, dir);
    assert.equal(v.deliverable, false);
    assert.ok(v.errors.some((e) => e.includes('红线')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReview：满分且过线 → deliverable=true', async () => {
  const dir = await goodReviewFixture();
  try {
    const r = normalizeRubric(goodRubric());
    const rev = goodReview();
    rev.dims.forEach((d) => { d.score = 10; d.beyond_spec = d.beyond_spec ?? '多做了下一步会用到的一点'; delete d.deduction; });
    rev.total = 100;
    const v = validateReview(rev, r, dir);
    assert.deepEqual(v.errors, []);
    assert.equal(v.total, 100);
    assert.equal(v.deliverable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decide：机器层红 → 一定不能交（哪怕评审满分）', () => {
  const r = normalizeRubric(goodRubric());
  const v = decide({ machineGreen: false, rubric: r, review: { ok: true, total: 100, vetoes_hit: [] } });
  assert.equal(v.deliverable, false);
  assert.ok(v.reasons.some((x) => x.includes('机器层')));
});

test('decide：无 rubric 时只看机器层', () => {
  const yes = decide({ machineGreen: true, rubric: null, review: null });
  assert.equal(yes.deliverable, true);
  assert.equal(yes.gated, false);
  const no = decide({ machineGreen: false, rubric: null, review: null });
  assert.equal(no.deliverable, false);
});

test('decide：有 rubric 但没判分 → 不能交', () => {
  const r = normalizeRubric(goodRubric());
  const v = decide({ machineGreen: true, rubric: r, review: null });
  assert.equal(v.deliverable, false);
  assert.ok(v.reasons.some((x) => x.includes('没有独立判分')));
});

test('decideLine：放行与拦截各说各的话', () => {
  const r = normalizeRubric(goodRubric());
  const ok = decide({ machineGreen: true, rubric: r, review: { ok: true, total: 96, vetoes_hit: [] } });
  assert.ok(decideLine(ok).startsWith('可以交'));
  const no = decide({ machineGreen: false, rubric: null, review: null });
  assert.ok(decideLine(no).startsWith('不许交'));
});
