/**
 * 契约测试：目标工程内核。
 * 判据只有一条——"完成"能不能被命令判定。所以这里测的全是判定逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  goalId,
  normalizeContract,
  validateContract,
  judge,
  runContract,
  summarize,
  verdictLine,
  renderReport,
} from '../lib/goal-core.mjs';
import { saveContract, loadContract, saveProof, listGoals, setStatus, goalDir } from '../lib/goal-store.mjs';

const OK_CONTRACT = {
  objective: '把询价页做到能提交一次完整 RFQ 并拿到落库结果',
  done_when: [
    { claim: '进程退出码为 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
    { claim: '输出包含 OK', check: 'node -e "console.log(\'OK\')"', expect: { kind: 'contains', value: 'OK' } },
  ],
  constraints: ['不加新依赖'],
  non_goals: ['不做多语言'],
};

test('goalId：日期 + 可读 slug，且稳定', () => {
  const a = goalId('把询价页做到能提交', new Date('2026-11-22T09:05:00Z'));
  assert.match(a, /^20261122-0905-/);
  assert.ok(a.includes('把询价页做到能提交'));
});

test('normalizeContract：补默认值，不丢输入', () => {
  const c = normalizeContract(OK_CONTRACT);
  assert.equal(c.done_when[0].id, 'D1');
  assert.equal(c.done_when[0].timeout_ms, 120000);
  assert.equal(c.budget.max_rounds, 5);
  assert.equal(c.status, 'open');
  assert.deepEqual(c.non_goals, ['不做多语言']);
});

test('validateContract：合格合约放行', () => {
  const r = validateContract(normalizeContract(OK_CONTRACT));
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('validateContract：objective 太短拒收', () => {
  const c = normalizeContract({ ...OK_CONTRACT, objective: '优化一下' });
  const r = validateContract(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('objective')));
});

test('validateContract：done_when 为空拒收', () => {
  const r = validateContract(normalizeContract({ objective: OK_CONTRACT.objective, done_when: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('done_when 为空')));
});

test('validateContract：非 manual 缺 check 拒收', () => {
  const c = normalizeContract({
    objective: OK_CONTRACT.objective,
    done_when: [{ claim: '登录能用', check: '', expect: { kind: 'exit', value: 0 } }],
  });
  const r = validateContract(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('check 为空')));
});

test('validateContract：全 manual 拒收（等于没有验收门）', () => {
  const c = normalizeContract({
    objective: OK_CONTRACT.objective,
    done_when: [{ claim: '界面好看', check: '', expect: { kind: 'manual' } }],
  });
  const r = validateContract(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('全部 done_when 都是 manual')));
});

test('validateContract：manual 混入时是 warning，不是 error', () => {
  const c = normalizeContract({
    objective: OK_CONTRACT.objective,
    done_when: [
      { claim: '退出码 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
      { claim: '界面好看', check: '', expect: { kind: 'manual' } },
    ],
  });
  const r = validateContract(c);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('manual')));
});

test('judge：exit / contains / equals / matches / not_contains', () => {
  const run = (code, stdout, stderr = '') => ({ code, stdout, stderr, timedOut: false, timeoutMs: 1000, error: '' });
  assert.equal(judge(run(0, ''), { kind: 'exit', value: 0 }).state, 'pass');
  assert.equal(judge(run(3, ''), { kind: 'exit', value: 0 }).state, 'fail');
  assert.equal(judge(run(0, 'hello world'), { kind: 'contains', value: 'world' }).state, 'pass');
  assert.equal(judge(run(0, 'hello'), { kind: 'contains', value: 'world' }).state, 'fail');
  assert.equal(judge(run(0, ' 42 \n'), { kind: 'equals', value: '42' }).state, 'pass');
  assert.equal(judge(run(0, 'p95=1ms'), { kind: 'matches', value: 'p95=\\d+' }).state, 'pass');
  assert.equal(judge(run(0, 'clean output'), { kind: 'not_contains', value: 'error' }).state, 'pass');
  assert.equal(judge(run(0, 'error!'), { kind: 'not_contains', value: 'error' }).state, 'fail');
});

test('judge：manual 一律 unknown（不计绿），超时算 fail', () => {
  const ok = { code: 0, stdout: 'fine', stderr: '', timedOut: false, timeoutMs: 1000, error: '' };
  assert.equal(judge(ok, { kind: 'manual' }).state, 'unknown');
  assert.equal(judge({ ...ok, timedOut: true }, { kind: 'exit', value: 0 }).state, 'fail');
});

test('summarize：有 unknown 就不是绿', () => {
  const g = summarize([{ id: 'D1', claim: 'a', state: 'pass' }, { id: 'D2', claim: 'b', state: 'unknown' }]);
  assert.equal(g.green, false);
  assert.equal(g.unknown, 1);
  assert.ok(verdictLine([{ id: 'D1', claim: 'a', state: 'pass' }, { id: 'D2', claim: 'b', state: 'unknown' }]).includes('不许汇报完成'));
});

test('runContract：真跑命令并按 expect 判定', async () => {
  const c = normalizeContract({
    objective: OK_CONTRACT.objective,
    done_when: [
      { claim: '退出码 0', check: 'node -e "process.exit(0)"', expect: { kind: 'exit', value: 0 } },
      { claim: '退出码 7', check: 'node -e "process.exit(7)"', expect: { kind: 'exit', value: 7 } },
      { claim: '输出含 hi', check: 'node -e "console.log(\'hi\')"', expect: { kind: 'contains', value: 'hi' } },
    ],
  });
  const results = await runContract(c, { cwd: process.cwd() });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.state), ['pass', 'pass', 'pass']);
  const s = summarize(results);
  assert.equal(s.green, true);
  assert.ok(renderReport(c, results, 1).includes('GREEN'));
});

test('台账：合约与 proof 落盘，列表能读到最近一轮', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'goal-'));
  try {
    const c = normalizeContract({ ...OK_CONTRACT, id: 'g-test' });
    const { dir } = await saveContract(tmp, c);
    assert.equal(dir, goalDir(tmp, 'g-test'));
    const back = await loadContract(tmp, 'g-test');
    assert.equal(back.objective, c.objective);

    const results = await runContract(c, { cwd: tmp });
    const { file, round } = await saveProof(tmp, c, results);
    assert.equal(round, 1);
    assert.match(file, /proof-1\.json$/);

    const list = await listGoals(tmp);
    assert.equal(list.length, 1);
    assert.equal(list[0].last_summary.pass, 2);

    await setStatus(tmp, 'g-test', 'blocked', '等外部 key');
    const after = await loadContract(tmp, 'g-test');
    assert.equal(after.status, 'blocked');
    assert.equal(after.revision, 1, '状态变更不算合约版本变更');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
