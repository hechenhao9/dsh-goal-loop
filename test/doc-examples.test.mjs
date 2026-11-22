/**
 * 文档里的示例必须真能过校验——否则 README 就是在教人写一份会被拒收的合约。
 * 这个测试把 README 里所有 ```json 块抽出来，逐个喂给 normalizeContract / normalizeRubric。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeContract, validateContract } from '../lib/goal-core.mjs';
import { normalizeRubric, validateRubric } from '../lib/rubric-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsonBlocks(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  const re = /```json\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

test('README 里的合约示例都能通过 validateContract', () => {
  const blocks = jsonBlocks('README.md');
  assert.ok(blocks.length >= 2, `README 里应至少有两份 JSON 示例，实际 ${blocks.length}`);
  let contracts = 0;
  for (const block of blocks) {
    let raw;
    try {
      raw = JSON.parse(block);
    } catch (err) {
      assert.fail(`README 有一段 JSON 解析不了：${err.message}\n${block.slice(0, 200)}`);
    }
    if (!raw.objective) continue; // 不是合约示例（可能是 rubric 片段）
    contracts += 1;
    const contract = normalizeContract(raw, new Date('2026-01-01T00:00:00Z'));
    const v = validateContract(contract);
    assert.deepEqual(v.errors, [], `README 的合约示例被拒收：\n${v.errors.join('\n')}`);
  }
  assert.ok(contracts >= 2, `应当抽到至少两份合约示例，实际 ${contracts}`);
});

test('rubric.example.json 能通过 normalizeRubric + validateRubric', () => {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'rubric.example.json'), 'utf8'));
  const rubric = normalizeRubric(raw.rubric ?? raw);
  const v = validateRubric(rubric);
  assert.deepEqual(v.errors, [], `rubric.example.json 被拒收：\n${v.errors.join('\n')}`);
  assert.equal(v.scoreable, true, '示例 rubric 应当可判分（权重合计 100）');
});

test('rubric.example.json 整份合约也能通过 validateContract', () => {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'rubric.example.json'), 'utf8'));
  const contract = normalizeContract(raw, new Date('2026-01-01T00:00:00Z'));
  const v = validateContract(contract);
  assert.deepEqual(v.errors, [], `rubric.example.json 作为合约被拒收：\n${v.errors.join('\n')}`);
});

test('README 的 rubric 片段（如果单独出现）也能过', () => {
  for (const block of jsonBlocks('README.md')) {
    let raw;
    try {
      raw = JSON.parse(block);
    } catch {
      continue;
    }
    const candidate = raw.rubric ?? (raw.dims ? raw : null);
    if (!candidate) continue;
    const rubric = normalizeRubric(candidate);
    const v = validateRubric(rubric);
    assert.deepEqual(v.errors, [], `README 里的 rubric 被拒收：\n${v.errors.join('\n')}`);
  }
});
