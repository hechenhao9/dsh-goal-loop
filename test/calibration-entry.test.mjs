/**
 * 校准层入口契约：盲预测 → 判分 → 对账 必须真跑通，
 * 且三条刹车（判分后补预测、押注人=判分人、换尺子不给理由）都要真的拦下来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

function fakeCtx() {
  const tools = [];
  const services = {
    skills: { register: () => {} },
    commands: { register: () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
  };
  return {
    ctx: {
      tools: { register: (t) => tools.push(t) },
      inject: (_n, cb) => cb({ get: (k) => services[k] }),
      get: (k) => services[k],
      logger: { warn: () => {} },
    },
    tool: (n) => tools.find((t) => t.name === n),
  };
}

const RUBRIC = {
  topic: '校准层契约',
  dims: [
    { id: 'M1', name: '事实', weight: 30, criterion: '每个数字都能在 draft.md 第 2 行找到对应原始记录', pass_example: '数字后标注了来源与行号', fail_example: '数字没有来源或对不上', intent: '防的是编造数字让人做错决定', vision: '每个数字都能点回原始记录' },
    { id: 'M2', name: '可执行', weight: 25, criterion: 'README 第 1 节命令能在空目录直接跑通并输出 ok', pass_example: '命令可粘贴且退出码为零', fail_example: '命令缺参数或要手改路径', intent: '防的是读者照着跑不通', vision: '照抄就能跑通看到输出' },
    { id: 'M3', name: '边界', weight: 25, criterion: '写明不支持的三类场景且每类给一句理由', pass_example: '列出不支持项并给了理由', fail_example: '只说不支持但不说为什么', intent: '防的是过度承诺误判范围', vision: '边界写清且每条有理由' },
    { id: 'M4', name: '语气', weight: 20, criterion: '全文没有空转式肯定句且每段首句给结论', pass_example: '首句即结论，无铺垫', fail_example: '开头三段都在说背景', intent: '防的是 AI 腔把结论埋掉', vision: '读三行就知道结论' },
  ],
  vetoes: [{ id: 'V1', name: '编造数据', why: '编一个数字会让对方据此做错决定' }],
  bar: 95,
};

const DRAFT = [
  '# 交付物',
  '这个数字 128 来自 evidence.md 第 3 行的原始记录。',
  '安装只需粘贴一条命令即可跑通并输出 ok。',
  '不支持 Windows 7 因为它没有可用的 TLS 栈。',
  '读三行就知道结论，没有铺垫。',
].join('\n');

const CONTRACT = {
  objective: '让校准层在本机真跑通一次完整的预测与对账',
  done_when: [{ id: 'D1', claim: 'node 退出码为 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } }],
  rubric: RUBRIC,
  non_goals: ['不发 npm 包'],
};

function reviewOf(reviewer = 'reviewer-a', scores = { M1: 10, M2: 10, M3: 10, M4: 10 }) {
  const quotes = {
    M1: '这个数字 128 来自 evidence.md 第 3 行的原始记录。',
    M2: '安装只需粘贴一条命令即可跑通并输出 ok。',
    M3: '不支持 Windows 7 因为它没有可用的 TLS 栈。',
    M4: '读三行就知道结论，没有铺垫。',
  };
  const total = RUBRIC.dims.reduce((sum, d) => sum + (scores[d.id] / 10) * d.weight, 0);
  return {
    reviewer,
    dims: RUBRIC.dims.map((d) => ({
      id: d.id,
      score: scores[d.id],
      quote: { file: 'draft.md', text: quotes[d.id], line: 1 },
      deduction: scores[d.id] < 10 ? `把 ${d.id} 那一段的结论提到首句` : '',
    })),
    vetoes_hit: [],
    total: Math.round(total * 100) / 100,
  };
}

function predictionOf(predictor = 'tutor') {
  return {
    predictor,
    basis: '上一轮同类交付 M4 掉过 3 分，这次先删掉两段铺垫再交',
    dims: [
      { id: 'M1', expected: 10 }, { id: 'M2', expected: 10 },
      { id: 'M3', expected: 10 }, { id: 'M4', expected: 10 },
    ],
    bet: { total_low: 96, total_high: 100, risk_dims: ['M4'] },
  };
}

/** 起一个隔离工作区，并返回「自动带上 cwd 的调用器」——漏传 cwd 会写到进程目录，是踩过的坑。 */
async function workspace(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const { ctx, tool } = fakeCtx();
  apply(ctx);
  const run = (name, args = {}) => tool(name).execute({ ...args, cwd: dir }, {});
  return { dir, run, close: () => rm(dir, { recursive: true, force: true }) };
}

test('端到端：define → predict → check → review → retro → verdict', async () => {
  const ws = await workspace('goalloop-cal-');
  try {
    const def = await ws.run('goal_define', CONTRACT);
    assert.equal(def.ok, true, JSON.stringify(def.errors));
    assert.ok(def.message.includes('goal_predict'), '落盘后要提示先押注');

    await writeFile(path.join(ws.dir, 'draft.md'), DRAFT, 'utf8');

    const pred = await ws.run('goal_predict', predictionOf());
    assert.equal(pred.ok, true, JSON.stringify(pred.errors));
    assert.equal(pred.round, 1);
    assert.equal(pred.digest.length, 16);
    assert.ok(pred.message.includes('押注已封'));

    const ran = await ws.run('goal_check');
    assert.equal(ran.green, true);

    const rev = await ws.run('goal_review', { review: reviewOf() });
    assert.equal(rev.ok, true, JSON.stringify(rev.errors));
    assert.equal(rev.deliverable, true);
    assert.ok(rev.message.includes('goal_retro'), '判分通过后要指向对账');

    // 判分任务书划出「不许看」的范围
    const briefFile = path.join(ws.dir, '.goal', def.id, 'review-brief.json');
    assert.equal(existsSync(briefFile), true);
    const brief = JSON.parse(await readFile(briefFile, 'utf8'));
    assert.ok(brief.must_not_read.some((p) => p.includes('predict-*.json')));
    assert.ok(brief.must_read.includes('draft.md'));

    const r = await ws.run('goal_retro');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bias, 'none');
    assert.equal(r.hit_rate, 1);
    assert.equal(r.total.delta, 0);
    assert.equal(r.streak.warn, false);

    const v = await ws.run('goal_verdict');
    assert.equal(v.deliverable, true);
    assert.ok(v.reasons.every((x) => !x.includes('连续')), '零偏差不该报「连续高估」');
  } finally {
    await ws.close();
  }
});

test('判分之后补预测 → 拒收（等于照着答案押注）', async () => {
  const ws = await workspace('goalloop-cal2-');
  try {
    const def = await ws.run('goal_define', CONTRACT);
    await writeFile(path.join(ws.dir, 'draft.md'), DRAFT, 'utf8');
    await ws.run('goal_check');
    await ws.run('goal_review', { review: reviewOf() });

    const late = await ws.run('goal_predict', predictionOf());
    assert.equal(late.ok, false);
    assert.ok(late.message.includes('判过分'), late.message);
    assert.equal(
      existsSync(path.join(ws.dir, '.goal', def.id, 'predict-1.json')),
      false,
      '被拒的预测不许落盘',
    );
  } finally {
    await ws.close();
  }
});

test('押注人和判分人同一个 → 判分被拒（自测自判）', async () => {
  const ws = await workspace('goalloop-cal3-');
  try {
    await ws.run('goal_define', CONTRACT);
    await writeFile(path.join(ws.dir, 'draft.md'), DRAFT, 'utf8');
    await ws.run('goal_predict', predictionOf('alice'));

    const rev = await ws.run('goal_review', { review: reviewOf('alice') });
    assert.equal(rev.ok, false);
    assert.ok(rev.errors.some((e) => e.includes('押注人')), JSON.stringify(rev.errors));

    const ok = await ws.run('goal_review', { review: reviewOf('bob') });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  } finally {
    await ws.close();
  }
});

test('换标准不给理由 → 拒收；给了理由 → 旧判分标 stale', async () => {
  const ws = await workspace('goalloop-cal4-');
  try {
    const def = await ws.run('goal_define', CONTRACT);
    await writeFile(path.join(ws.dir, 'draft.md'), DRAFT, 'utf8');
    await ws.run('goal_check');
    await ws.run('goal_review', { review: reviewOf() });

    const tighter = JSON.parse(JSON.stringify(RUBRIC));
    tighter.dims[0].criterion = '每个数字都能在 draft.md 第 2 行找到对应原始记录，且含行号数字';
    const noReason = await ws.run('goal_define', { ...CONTRACT, id: def.id, rubric: tighter });
    assert.equal(noReason.ok, false);
    assert.ok(noReason.errors.some((e) => e.includes('rubric_change_reason')), JSON.stringify(noReason.errors));

    const withReason = await ws.run('goal_define', {
      ...CONTRACT,
      id: def.id,
      rubric: tighter,
      rubric_change_reason: 'M1 原判据允许只写「见附件」，两次被误判满分，收紧成必须含行号',
    });
    assert.equal(withReason.ok, true, JSON.stringify(withReason.errors));
    assert.ok(withReason.message.includes('stale'), withReason.message);

    const rec = JSON.parse(await readFile(path.join(ws.dir, '.goal', def.id, 'review-1.json'), 'utf8'));
    assert.equal(rec.stale, true);
    assert.ok(rec.stale_reason.includes('rubric'));
  } finally {
    await ws.close();
  }
});
