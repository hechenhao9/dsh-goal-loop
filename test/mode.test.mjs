/**
 * 1.3.0：目标工程模式开关。
 * 三件事要锁住：① 关掉之后政策段渲染成空串（下一轮就不再进提示）；② 工具仍然全在；③ 落盘留痕。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.mjs';

function fakeCtx() {
  const tools = [];
  const sections = [];
  const services = {
    tools: { register: (x) => tools.push(x) },
    skills: { register: () => {} },
    commands: { register: () => {} },
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
    sections,
    ctx: {
      tools: { register: (t) => tools.push(t) },
      inject: (_names, cb) => cb({ get: (k) => services[k] }),
      get: (k) => services[k],
      logger: { warn: () => {} },
    },
  };
}

const byName = (tools, name) => tools.find((t) => t.name === name);

test('goal_mode：不带参数只查，不改状态', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goal-mode-'));
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx);
    const mode = byName(tools, 'goal_mode');
    const r = await mode.execute({ cwd: tmp }, {});
    assert.equal(r.ok, true);
    assert.equal(r.enabled, true, '缺省是开');
    assert.match(r.message, /未改动/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('goal_mode：关掉 → 政策段渲染成空串，工具数量不变', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goal-mode-'));
  try {
    const { ctx, tools, sections } = fakeCtx();
    apply(ctx);
    assert.ok(sections[0].text.includes('三层闸门'), '开的时候有内容');

    const mode = byName(tools, 'goal_mode');
    const off = await mode.execute({ cwd: tmp, enabled: false }, {});
    assert.equal(off.enabled, false);
    assert.equal(sections[0].text, '', '关掉之后这一段必须为空，不能再进提示');
    assert.equal(tools.length, 9, '工具一个都不能少');

    const on = await mode.execute({ cwd: tmp, enabled: true }, {});
    assert.equal(on.enabled, true);
    assert.ok(sections[0].text.includes('goal_verdict'), '打开后恢复原文');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('goal_mode：状态落盘到 .goal/mode.json，带来源与时间', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goal-mode-'));
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx);
    await byName(tools, 'goal_mode').execute({ cwd: tmp, enabled: false }, {});
    const raw = JSON.parse(await readFile(path.join(tmp, '.goal', 'mode.json'), 'utf8'));
    assert.equal(raw.enabled, false);
    assert.equal(raw.by, 'tool:goal_mode');
    assert.ok(typeof raw.updated_at === 'string' && raw.updated_at.length > 10);
    await byName(tools, 'goal_mode').execute({ cwd: tmp, enabled: true }, {});
    const again = JSON.parse(await readFile(path.join(tmp, '.goal', 'mode.json'), 'utf8'));
    assert.equal(again.enabled, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('goal_mode：磁盘写不进去也不影响内存里的开关', async () => {
  // 用一个不可能的路径当 cwd：mkdir 会失败，开关仍要生效
  const bogus = path.join(os.tmpdir(), 'goal-mode-no-such-dir-\u0000x');
  const { ctx, tools, sections } = fakeCtx();
  apply(ctx);
  const r = await byName(tools, 'goal_mode').execute({ cwd: bogus, enabled: false }, {});
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.equal(sections[0].text, '');
  await byName(tools, 'goal_mode').execute({ cwd: bogus, enabled: true }, {});
});

test('/goal-mode 命令：toggle / on / off / status 都能读回状态', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goal-mode-'));
  try {
    const commands = [];
    const { ctx } = fakeCtx();
    ctx.inject = (_names, cb) => cb({
      get: (k) => (k === 'commands'
        ? { register: (c) => commands.push(c) }
        : {
          register: () => {},
          section: () => () => {},
          getSectionOrder: () => 10,
        }),
    });
    apply(ctx);
    const cmd = commands.find((c) => c.name === 'goal-mode');
    assert.ok(cmd, '命令已注册');
    const agent = { session: { header: { cwd: tmp } } };

    const off = await cmd.handler({ agent, rawInput: 'off' });
    assert.equal(off.kind, 'success');
    assert.match(off.text, /：关/);

    const status = await cmd.handler({ agent, rawInput: 'status' });
    assert.match(status.text, /：关/);

    const toggle = await cmd.handler({ agent, rawInput: '' });
    assert.match(toggle.text, /：开/);

    await mkdir(tmp, { recursive: true });
    const raw = JSON.parse(await readFile(path.join(tmp, '.goal', 'mode.json'), 'utf8'));
    assert.equal(raw.enabled, true);
    assert.equal(raw.by, 'slash:/goal-mode');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
