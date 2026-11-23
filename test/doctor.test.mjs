/**
 * 1.2.0 体验层的端到端：dry_run 不落盘、代价台账拒收、goal_doctor 指出下一步。
 * 这里断言的是"用户会看到什么"，不是内部函数——所以全部经真实工具 execute 走。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

function fakeCtx() {
  const tools = [];
  const services = {
    tools: { register: (x) => tools.push(x) },
    skills: { register: () => {} },
    commands: { register: () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
  };
  return {
    tools,
    ctx: {
      tools: { register: (t) => tools.push(t) },
      inject: (_n, cb) => cb({ get: (k) => services[k] }),
      get: (k) => services[k],
      logger: { warn: () => {} },
    },
  };
}

function workspace() {
  const { ctx, tools } = fakeCtx();
  apply(ctx);
  const byName = (n) => tools.find((t) => t.name === n);
  return { tools, byName };
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-loop-12-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE = {
  objective: '把询价页做到能提交一次完整 RFQ 并拿到落库结果',
  done_when: [
    { id: 'D1', claim: '进程退出码 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
  ],
  non_goals: ['不做多语言'],
};

const PROV = {
  source: 'hechenhao9/dsh-judge-loop v2.0.0',
  paid_for: '机械闸门把门槛设成 100 分，导致八版稿无限循环后被砍掉',
  kept: '保留 95 分合格线，但把分数重算交给机器',
};

test('dry_run：只校验不落盘，且明确说没落盘', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const r = await byName('goal_define').execute({ ...BASE, cwd: dir, dry_run: true }, {});
    assert.equal(r.ok, true, r.errors.join(' / '));
    assert.equal(r.dry_run, true);
    assert.match(r.message, /未落盘|没落盘/);
    assert.equal(r.counts.done_when, 1);
    // 台账目录不该出现
    const entries = await readdir(dir).catch(() => []);
    assert.ok(!entries.includes('.goal'), 'dry_run 不许产生 .goal 目录');
  });
});

test('dry_run：不合格时照样报错，但也不落盘', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const r = await byName('goal_define').execute(
      { objective: '借鉴 judge-loop 重做验', done_when: BASE.done_when, cwd: dir, dry_run: true },
      {},
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.equal(r.dry_run, true);
    const entries = await readdir(dir).catch(() => []);
    assert.ok(!entries.includes('.goal'));
  });
});

test('说「借鉴」却不写代价台账：真落盘路径也拒收', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const r = await byName('goal_define').execute(
      { ...BASE, objective: '借鉴 judge-loop 的做法重做询价页验收', cwd: dir },
      {},
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /抄到壳|provenance/.test(e)), r.errors.join(' / '));
  });
});

test('写了代价台账与拒绝清单：落盘且计数正确', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const r = await byName('goal_define').execute(
      {
        ...BASE,
        objective: '借鉴 judge-loop 的做法重做询价页验收',
        provenance: [PROV],
        refusals: [{ ask: '这次先把合格线降到 90', why: '降阈值会改掉整把尺子，历史分数失去可比性' }],
        cwd: dir,
      },
      {},
    );
    assert.equal(r.ok, true, r.errors.join(' / '));
    assert.equal(r.counts.provenance, 1);
    assert.equal(r.counts.refusals, 1);
    assert.match(r.message, /代价台账/);
    assert.match(r.message, /拒绝清单/);
  });
});

test('goal_doctor：空台账时直接说去建合约', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const r = await byName('goal_doctor').execute({ cwd: dir }, {});
    assert.equal(r.ok, true);
    assert.equal(r.checked, 0);
    assert.match(r.message, /goal_define/);
  });
});

test('goal_doctor：新目标会指出「从未跑过检查」与「没有代价台账」，并给下一步工具', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    await byName('goal_define').execute({ ...BASE, cwd: dir }, {});
    const r = await byName('goal_doctor').execute({ cwd: dir }, {});
    assert.equal(r.ok, true);
    assert.equal(r.checked, 1);
    assert.equal(r.healthy, 0);
    const p = r.problems[0];
    assert.ok(p.flags.some((f) => f.includes('从未跑过')), p.flags.join(' / '));
    assert.ok(p.flags.some((f) => f.includes('代价台账')), p.flags.join(' / '));
    assert.equal(p.next.tool, 'goal_check');
    assert.match(r.message, /→ goal_check/);
  });
});

test('goal_doctor：机器层绿之后把下一步推到 goal_predict（有 rubric 时）', async () => {
  await withDir(async (dir) => {
    const { byName } = workspace();
    const def = await byName('goal_define').execute(
      {
        ...BASE,
        provenance: [PROV],
        refusals: [{ ask: '跳过押注直接判分', why: '押注是对账的前提，跳过就学不到标准准不准' }],
        rubric: {
          topic: '体检测试',
          dims: [
            { id: 'M1', name: '事实', weight: 30, criterion: '每个数字都能在 draft.md 第 2 行找到来源', pass_example: '数字后标注了来源与行号', fail_example: '数字没有来源或者对不上行号', intent: '防的是编造数字让人做错决定', vision: '每个数字都能点回原始记录' },
            { id: 'M2', name: '可执行', weight: 25, criterion: 'draft.md 里有 1 条能直接跑的命令', pass_example: '命令可以直接粘贴运行', fail_example: '只写了「执行脚本」没有命令', intent: '防的是看着像可执行其实跑不起来', vision: '对方照抄就能跑通' },
            { id: 'M3', name: '边界', weight: 25, criterion: 'refusals 里每条拒绝都写了 why 与回法', pass_example: '每条拒绝都带了理由', fail_example: '只写拒绝不写理由', intent: '防的是同一件事被反复提一遍', vision: '拒绝一次就永久生效' },
            { id: 'M4', name: '语气', weight: 20, criterion: 'draft.md 里没有「如上所述」这类空转句', pass_example: '每一句都在给新信息', fail_example: '用套话把篇幅撑起来', intent: '防的是把篇幅当成果', vision: '删掉一半仍然站得住' },
          ],
          vetoes: [{ id: 'V1', name: '编造数据', why: '编数字会让对方据此做错决定' }],
        },
        cwd: dir,
      },
      {},
    );
    assert.equal(def.ok, true, def.errors.join(' / '));
    const check = await byName('goal_check').execute({ cwd: dir }, {});
    assert.equal(check.ok, true, check.message);
    const r = await byName('goal_doctor').execute({ cwd: dir }, {});
    const p = r.problems[0];
    assert.equal(p.next.tool, 'goal_predict', JSON.stringify(p.flags));
    assert.ok(p.flags.some((f) => f.includes('还没押注')), p.flags.join(' / '));
  });
});
