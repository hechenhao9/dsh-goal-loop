/**
 * 入口契约：apply(ctx) 必须注册 4 技能 + 5 工具 + 2 命令，且不依赖宿主私有服务。
 * 外加一条端到端：define(带 rubric) → check → review → verdict，整条链路真跑通。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { name, inject, apply } from '../index.mjs';

function fakeCtx() {
  const tools = [];
  const skills = [];
  const commands = [];
  const sections = [];
  const services = {
    tools: { register: (t) => tools.push(t) },
    skills: { register: (s) => skills.push(s) },
    commands: { register: (c) => commands.push(c) },
    systemPrompt: {
      section: (s) => {
        sections.push(s);
        return () => {};
      },
      getSectionOrder: () => 10,
    },
  };
  return {
    tools,
    skills,
    commands,
    sections,
    ctx: {
      tools: { register: (t) => tools.push(t) },
      inject: (_names, cb) => cb({ get: (k) => services[k] }),
      get: (k) => services[k],
      logger: { warn: () => {} },
    },
  };
}

const RUBRIC = {
  topic: '入口契约测试',
  dims: [
    { id: 'M1', name: '事实', weight: 30, criterion: '每个数字都能在 draft.md 第 2 行找到对应原始记录', pass_example: '数字后标注了来源与行号', fail_example: '数字没有来源或对不上', intent: '防的是编造数字让人做错决定', vision: '每个数字都能点回原始记录' },
    { id: 'M2', name: '可执行', weight: 25, criterion: 'README 第 1 节命令能在空目录直接跑通并输出 ok', pass_example: '命令可粘贴且退出码为零', fail_example: '命令缺参数或要手改路径', intent: '防的是读者照着跑不通', vision: '照抄就能跑通看到输出' },
    { id: 'M3', name: '边界', weight: 25, criterion: '写明不支持的三类场景且每类给一句理由', pass_example: '列出不支持项并给了理由', fail_example: '只说不支持但不说为什么', intent: '防的是过度承诺误判范围', vision: '边界写清且每条有理由' },
    { id: 'M4', name: '语气', weight: 20, criterion: '全文没有空转式肯定句且每段首句给结论', pass_example: '首句即结论，无铺垫', fail_example: '开头三段都在说背景', intent: '防的是 AI 腔把结论埋掉', vision: '读三行就知道结论' },
  ],
  vetoes: [{ id: 'V1', name: '编造数据', why: '编一个数字会让对方据此做错决定' }],
  bar: 95,
};

test('入口导出形态正确', () => {
  assert.equal(name, 'dsh-goal-loop');
  // 依赖声明必须留空：fiber 一上来就 active，任何服务缺席都不能拖死整个插件
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
});

test('apply 注册 9 个工具 + 4 技能 + 3 命令', () => {
  const { ctx, tools, skills, commands } = fakeCtx();
  apply(ctx);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['goal_check', 'goal_define', 'goal_doctor', 'goal_mode', 'goal_predict', 'goal_retro', 'goal_review', 'goal_status', 'goal_verdict'],
  );
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function');
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.output.schema, 'object');
    assert.equal(typeof t.output.render, 'function');
  }
  assert.deepEqual(
    skills.map((s) => s.name).sort(),
    ['goal-loop', 'goal-professor', 'goal-reviewer', 'goal-tutor'],
  );
  const main = skills.find((s) => s.name === 'goal-loop');
  assert.ok(main.description.length > 10);
  assert.ok(main.content.includes('三层闸门'));
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map((c) => c.name).sort(), ['goal', 'goal-mode', 'review']);
});

test('apply 注册常驻政策段到 systemPrompt', () => {
  const { ctx, sections } = fakeCtx();
  apply(ctx);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'goal:loop');
  assert.equal(sections[0].order, 10, '借用 TOOL_GOAL 的 order，不自己排序');
  assert.match(sections[0].text, /goal_check/);
  assert.match(sections[0].text, /goal_verdict/);
  assert.match(sections[0].text, /三层闸门/);
  assert.ok(sections[0].text.length < 1200, `政策段每轮付费，必须压短（当前 ${sections[0].text.length} 字）`);
});

test('config.policy=false 时不注册常驻政策段，工具照常注册', () => {
  const { ctx, sections, tools } = fakeCtx();
  apply(ctx, { policy: false });
  assert.equal(sections.length, 0, '关掉开关就不该每轮为提示付费');
  assert.equal(tools.length, 9, '关开关只影响提示，不卸载工具');
});

test('config.skills=false / commands=false 只影响对应层', () => {
  const { ctx, skills, commands, sections, tools } = fakeCtx();
  apply(ctx, { skills: false, commands: false });
  assert.equal(sections.length, 1, '政策段没关');
  assert.equal(skills.length, 0, '技能被关');
  assert.equal(commands.length, 0, '命令被关');
  assert.equal(tools.length, 9, '工具不受影响');
});

test('宿主没有 systemPrompt 服务时 apply 不抛，工具照常注册', () => {
  const tools = [];
  const ctx = {
    inject: (_names, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.push(t) } : undefined) }),
    logger: { warn: () => {} },
  };
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(tools.length, 9);
});

test('端到端：define(rubric) → check → review → verdict', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goalloop-e2e-'));
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx);
    const define = tools.find((t) => t.name === 'goal_define');
    const check = tools.find((t) => t.name === 'goal_check');
    const review = tools.find((t) => t.name === 'goal_review');
    const verdict = tools.find((t) => t.name === 'goal_verdict');

    // 1) 不合格合约：拒收且不留目录
    const bad = await define.execute({ objective: '优化一下', done_when: [], cwd: tmp }, {});
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 2);
    assert.deepEqual(await readdir(tmp), [], '不合格合约不许留下目录');

    // 2) 不合格 rubric：4 维但权重不是 100 → 拒收
    const badRubric = JSON.parse(JSON.stringify(RUBRIC));
    badRubric.dims[0].weight = 40;
    const badR = await define.execute({
      objective: '让双层闸门在本机装好并跑通端到端',
      done_when: [{ id: 'D1', claim: 'node 退出码为 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } }],
      rubric: badRubric,
      non_goals: ['不发 npm 包'],
      cwd: tmp,
    }, {});
    assert.equal(badR.ok, false);
    assert.ok(badR.errors.some((e) => e.includes('合计')));

    // 3) 合格合约（带 rubric）落盘
    const good = await define.execute({
      objective: '让双层闸门在本机装好并跑通端到端',
      done_when: [{ id: 'D1', claim: 'node 退出码为 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } }],
      rubric: RUBRIC,
      non_goals: ['不发 npm 包'],
      cwd: tmp,
    }, {});
    assert.equal(good.ok, true, JSON.stringify(good.errors));
    assert.equal(good.gated, true);

    // 4) 机器层
    const ran = await check.execute({ cwd: tmp }, {});
    assert.equal(ran.green, true);
    assert.ok(ran.proof.endsWith('proof-1.json'));
    assert.ok(ran.verdict.includes('评审层'), '机器层绿了要提醒还有评审层');

    // 5) 机器层绿但没判分 → 不能交
    const v1 = await verdict.execute({ cwd: tmp }, {});
    assert.equal(v1.deliverable, false);
    assert.ok(v1.reasons.some((r) => r.includes('没有独立判分')));

    // 6) 判分引文逐字对得上才算数
    await writeFile(
      path.join(tmp, 'draft.md'),
      [
        '# 交付物',
        '这个数字 128 来自 evidence.md 第 3 行的原始记录。',
        '安装只需粘贴一条命令即可跑通并输出 ok。',
        '不支持 Windows 7 因为它没有可用的 TLS 栈。',
        '读三行就知道结论，没有铺垫。',
      ].join('\n'),
      'utf8',
    );
    const reviewBody = {
      reviewer: 'reviewer-round1',
      dims: [
        { id: 'M1', score: 10, quote: { file: 'draft.md', text: '这个数字 128 来自 evidence.md 第 3 行的原始记录。', line: 2 }, beyond_spec: '顺手标了行号，下一步能点回去' },
        { id: 'M2', score: 10, quote: { file: 'draft.md', text: '安装只需粘贴一条命令即可跑通并输出 ok。', line: 3 }, beyond_spec: '说清了空目录前提' },
        { id: 'M3', score: 10, quote: { file: 'draft.md', text: '不支持 Windows 7 因为它没有可用的 TLS 栈。', line: 4 }, beyond_spec: '给了理由不只是列表' },
        { id: 'M4', score: 10, quote: { file: 'draft.md', text: '读三行就知道结论，没有铺垫。', line: 5 }, beyond_spec: '标题即结论' },
      ],
      vetoes_hit: [],
      total: 100,
    };
    const rv = await review.execute({ review: reviewBody, cwd: tmp }, {});
    assert.equal(rv.ok, true, JSON.stringify(rv.errors));
    assert.equal(rv.total, 100);
    assert.equal(rv.deliverable, true);
    assert.ok(rv.file.endsWith('review-1.json'));

    // 7) 终局裁决：两层都过 → 可以交
    const v2 = await verdict.execute({ cwd: tmp }, {});
    assert.equal(v2.deliverable, true, JSON.stringify(v2.reasons));
    assert.ok(v2.message.startsWith('可以交'));
    const gate = JSON.parse(await readFile(v2.file, 'utf8'));
    assert.equal(gate.deliverable, true);

    // 8) 自评（reviewer=self）被拒收
    const selfReview = await review.execute({ review: { ...reviewBody, reviewer: 'self' }, cwd: tmp }, {});
    assert.equal(selfReview.ok, false);
    assert.ok(selfReview.errors.some((e) => e.includes('自己写')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
