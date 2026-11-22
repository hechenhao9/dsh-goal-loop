import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePrediction,
  sealPrediction,
  validatePrediction,
  compare,
  biasStreak,
  rubricDiff,
  validateRubricChange,
  retroLine,
  digestOf,
  HIT_TOLERANCE,
  BIAS_STREAK_LIMIT,
} from '../lib/calibration-core.mjs';

/** 4 维、各 25 权重的标准，总分 100。 */
const RUBRIC = {
  version: 1,
  topic: '交付一份能被抽查的说明',
  dims: [
    { id: 'M1', name: '结论可核', weight: 25, criterion: '首段给出结论并指向 evidence.md 第 3 行', pass_example: '结论见第 3 行原始记录', fail_example: '大概可能也许是对的', intent: '防止只给感觉', vision: '读完第一段就知道要不要信' },
    { id: 'M2', name: '可执行', weight: 25, criterion: '安装步骤是一条能粘贴的命令，退出码 0', pass_example: '粘贴一条命令即可跑通', fail_example: '请自行配置环境后运行', intent: '防止把配置工作丢给读者', vision: '照抄就能跑' },
    { id: 'M3', name: '边界诚实', weight: 25, criterion: '写清不支持 Windows 7 及原因', pass_example: '不支持 Win7 因缺少 TLS 栈', fail_example: '所有系统都能用', intent: '防止过度承诺', vision: '读者知道什么时候不该用' },
    { id: 'M4', name: '不注水', weight: 25, criterion: '全文没有空转式肯定句，段数不超过 4', pass_example: '四段讲完，没有铺垫', fail_example: '这是一个非常好的问题，让我们深入探讨', intent: '防止用字数冒充内容', vision: '每一句都在推进' },
  ],
  vetoes: [{ id: 'V1', name: '编造数据', why: '编一个数字会让对方据此做错决定' }],
  bar: 95,
};

const okDims = [
  { id: 'M1', expected: 10, why: '首段就有结论' },
  { id: 'M2', expected: 10, why: '命令已验证' },
  { id: 'M3', expected: 10, why: '边界写了两条' },
  { id: 'M4', expected: 10, why: '四段收住' },
];

function base() {
  return {
    predictor: 'tutor',
    basis: '上次同类交付 M4 掉过 3 分，这次先删了两段铺垫',
    bet: { total_low: 92, total_high: 100, risk_dims: ['M4'] },
  };
}

/** 深拷贝 dims：共享数组会让改一项的用例污染后面的用例。 */
function okPrediction() {
  return { ...base(), dims: okDims.map((d) => ({ ...d })) };
}

test('normalizePrediction 缺字段不猜，一律留空', () => {
  const p = normalizePrediction({});
  assert.equal(p.predictor, '');
  assert.equal(p.basis, '');
  assert.deepEqual(p.dims, []);
  assert.equal(p.bet.total_low, null, '缺 bet 用 null 表示，不用 NaN');
  assert.deepEqual(p.bet.risk_dims, []);
});

test('sealPrediction 幂等：封过的再封还是原来那份', () => {
  const a = sealPrediction(okPrediction(), new Date('2026-01-01T00:00:00Z'));
  assert.ok(a.sealed_at.startsWith('2026-01-01'));
  assert.equal(a.digest.length, 16);
  const b = sealPrediction(a, new Date('2027-01-01T00:00:00Z'));
  assert.equal(b.sealed_at, a.sealed_at, '封条时间不许因为重封而变');
  assert.equal(b.digest, a.digest);
});

test('digestOf 对键序不敏感，对内容敏感', () => {
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
});

test('完整预测通过', () => {
  const v = validatePrediction(okPrediction(), RUBRIC);
  assert.equal(v.ok, true, v.errors.join(' / '));
});

test('缺一维就拒收——跳过的那维是对账时的黑洞', () => {
  const p = okPrediction();
  p.dims = p.dims.filter((d) => d.id !== 'M3');
  const v = validatePrediction(p, RUBRIC);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('M3')));
});

test('多出一维也拒收', () => {
  const p = okPrediction();
  p.dims.push({ id: 'M9', expected: 10 });
  const v = validatePrediction(p, RUBRIC);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('M9')));
});

test('押 8 分不行——只有 0/4/7/10 四档', () => {
  const p = okPrediction();
  p.dims[0].expected = 8;
  const v = validatePrediction(p, RUBRIC);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('四档')));
});

test('basis 太短拒收：讲不清依据等于没依据', () => {
  const p = okPrediction();
  p.basis = '感觉不错';
  const v = validatePrediction(p, RUBRIC);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('basis')));
});

test('bet 区间与自己的维分矛盾 → 拒收', () => {
  const p = okPrediction();
  p.dims[3].expected = 4; // 按维分算出 85
  p.bet = { total_low: 95, total_high: 100, risk_dims: [] };
  const v = validatePrediction(p, RUBRIC);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('自相矛盾')));
});

test('compare：全押中 → bias none、hit_rate 1', () => {
  const r = compare(okPrediction(), reviewOf({ M1: 10, M2: 10, M3: 10, M4: 10 }), RUBRIC);
  assert.equal(r.bias, 'none');
  assert.equal(r.hit_rate, 1);
  assert.equal(r.total.delta, 0);
  assert.equal(r.total.in_bet, true);
});

test('compare：押 100 实际 92.5 → over（尺子把稿子想得比实际好）', () => {
  const r = compare(okPrediction(), reviewOf({ M1: 10, M2: 10, M3: 10, M4: 7 }), RUBRIC);
  assert.equal(r.bias, 'over');
  assert.equal(r.total.delta, -7.5);
  assert.equal(r.dims.find((d) => d.id === 'M4').dir, 'over');
  assert.equal(r.hit_rate, 0.75);
});

test('compare：低估 → under', () => {
  const p = okPrediction();
  p.dims = okDims.map((d) => ({ ...d, expected: 7 }));
  p.bet = { total_low: 60, total_high: 80, risk_dims: [] };
  const r = compare(p, reviewOf({ M1: 10, M2: 10, M3: 10, M4: 10 }), RUBRIC);
  assert.equal(r.bias, 'under');
});

test('compare：有高有低 → mixed（该改措辞不是统一调权重）', () => {
  const p = okPrediction();
  // 押 M1 掉档、M2 满分；实际反过来 → 一维低估、一维高估。
  p.dims = [
    { id: 'M1', expected: 4 }, { id: 'M2', expected: 10 },
    { id: 'M3', expected: 10 }, { id: 'M4', expected: 10 },
  ];
  p.bet = { total_low: 70, total_high: 90, risk_dims: ['M1'] };
  const r = compare(p, reviewOf({ M1: 10, M2: 4, M3: 10, M4: 10 }), RUBRIC);
  assert.equal(r.bias, 'mixed');
  assert.equal(r.over, 1);
  assert.equal(r.under, 1);
});

test('compare：差一档只算略有偏差，仍计入 hit', () => {
  assert.equal(HIT_TOLERANCE, 2);
  const r = compare(okPrediction(), reviewOf({ M1: 7, M2: 10, M3: 10, M4: 10 }), RUBRIC);
  const m1 = r.dims.find((d) => d.id === 'M1');
  assert.equal(m1.delta, -3);
  assert.equal(m1.dir, 'over');
  assert.equal(r.judged, 4);
});

test('compare：判分缺维时不硬凑，标 unknown', () => {
  const r = compare(okPrediction(), reviewOf({ M1: 10, M2: 10 }), RUBRIC);
  assert.equal(r.dims.find((d) => d.id === 'M3').dir, 'unknown');
  assert.equal(r.dims.find((d) => d.id === 'M3').delta, null);
});

test('biasStreak：连续三轮高估才提醒改标准', () => {
  const s = biasStreak([{ bias: 'over' }, { bias: 'over' }, { bias: 'over' }]);
  assert.equal(s.streak, 3);
  assert.equal(s.dir, 'over');
  assert.equal(s.warn, true);
  assert.equal(BIAS_STREAK_LIMIT, 3);
});

test('biasStreak：mixed 打断连续', () => {
  const s = biasStreak([{ bias: 'over' }, { bias: 'over' }, { bias: 'mixed' }, { bias: 'over' }, { bias: 'over' }]);
  assert.equal(s.streak, 2);
  assert.equal(s.warn, false);
});

test('biasStreak：之后换向也要重新数', () => {
  const s = biasStreak([{ bias: 'over' }, { bias: 'over' }, { bias: 'over' }, { bias: 'under' }]);
  assert.equal(s.streak, 1);
  assert.equal(s.dir, 'under');
  assert.equal(s.warn, false);
});

test('biasStreak：空历史不炸', () => {
  const s = biasStreak([]);
  assert.equal(s.streak, 0);
  assert.equal(s.dir, null);
  assert.equal(s.warn, false);
});

test('rubricDiff：认得出加维、删维、改权重、换线', () => {
  const next = JSON.parse(JSON.stringify(RUBRIC));
  next.dims[0].weight = 30;
  next.dims[1].weight = 20;
  next.dims.push({ ...RUBRIC.dims[0], id: 'M5', name: '新维' });
  next.dims = next.dims.filter((d) => d.id !== 'M3');
  next.bar = 90;
  const diff = rubricDiff(RUBRIC, next);
  assert.deepEqual(diff.added, ['M5']);
  assert.deepEqual(diff.removed, ['M3']);
  assert.ok(diff.changed.some((c) => c.id === 'M1' && c.fields.includes('weight 25→30')));
  assert.deepEqual(diff.bar, { from: 95, to: 90 });
  assert.equal(diff.empty, false);
});

test('rubricDiff：一样就 empty', () => {
  const diff = rubricDiff(RUBRIC, JSON.parse(JSON.stringify(RUBRIC)));
  assert.equal(diff.empty, true);
});

test('换标准没理由 → 拒收', () => {
  const next = JSON.parse(JSON.stringify(RUBRIC));
  next.dims[0].criterion = '首段给出结论并指向 evidence.md 第 3 行（含数字）';
  const v = validateRubricChange(RUBRIC, next, '');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('rubric_change_reason')));
});

test('换标准有理由 → 过，但提醒旧分作废', () => {
  const next = JSON.parse(JSON.stringify(RUBRIC));
  next.dims[0].criterion = '首段给出结论并指向 evidence.md 第 3 行（含数字）';
  const v = validateRubricChange(RUBRIC, next, 'M1 的判据原来允许只写「见附件」，被两次误判满分推翻');
  assert.equal(v.ok, true, v.errors.join(' / '));
  assert.ok(v.warnings.some((w) => w.includes('stale')));
  assert.equal(v.changed, true);
});

test('标准没变就不需要理由', () => {
  const v = validateRubricChange(RUBRIC, JSON.parse(JSON.stringify(RUBRIC)), '');
  assert.equal(v.ok, true);
  assert.equal(v.changed, false);
});

test('retroLine：高估要直说，不软化', () => {
  const r = compare(okPrediction(), reviewOf({ M1: 10, M2: 10, M3: 10, M4: 7 }), RUBRIC);
  const line = retroLine(r);
  assert.ok(line.includes('尺子偏高'), line);
  assert.ok(!line.includes('或许'), '不要「这或许可能暗示」式软化');
});

/** 用 {M1:10,...} 造一份能被 compare 消费的判分记录。 */
function reviewOf(scores) {
  const dims = Object.entries(scores).map(([id, score]) => ({
    id,
    score,
    quote: { file: 'draft.md', text: '占位引文足够长到十二个字以上', line: 1 },
    deduction: score < 10 ? '把第 1 段删掉一半' : '',
  }));
  const total = RUBRIC.dims.reduce((sum, d) => {
    const s = scores[d.id];
    return sum + (Number.isFinite(s) ? (s / 10) * d.weight : 0);
  }, 0);
  const rounded = Math.round(total * 100) / 100;
  return { reviewer: 'reviewer-a', dims, vetoes_hit: [], total: rounded, audited: { total: rounded } };
}
