#!/usr/bin/env node
/**
 * goal.mjs — 目标工程双层闸门的命令行入口（不需要 DSH 也能用；也是插件坏掉时的兜底）。
 *
 *   node bin/goal.mjs status                # 台账总览（机器层 + 评审层）
 *   node bin/goal.mjs check [id]            # 真跑机器层，落 proof-N.json
 *   node bin/goal.mjs define <file.json>    # 从 JSON 建/更新合约（含 rubric）
 *   node bin/goal.mjs review <file.json> [id]  # 提交判分，机器审计后落 review-N.json
 *   node bin/goal.mjs verdict [id]          # 读盘上最近 proof 与 review，给最终裁决
 *   node bin/goal.mjs demo                  # 造一个玩具目标，跑完整链路给你看
 *
 * 退出码：check 0=全绿 1=有失败 2=有无法判定；verdict 0=可以交 1=不许交；3=用法/合约错误。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { normalizeContract, validateContract, runContract, summarize, renderReport, verdictLine } from '../lib/goal-core.mjs';
import { saveContract, resolveContract, listGoals, saveProof, setStatus, loadContract } from '../lib/goal-store.mjs';
import { normalizeRubric, validateRubric, validateReview, decide, decideLine } from '../lib/rubric-core.mjs';
import {
  saveReview,
  loadLatestReview,
  loadLatestProof,
  saveGate,
  savePrediction,
  loadLatestPrediction,
  listPredictions,
  saveRetro,
  listRetros,
} from '../lib/review-store.mjs';
import {
  normalizePrediction,
  sealPrediction,
  validatePrediction,
  compare,
  biasStreak,
  retroLine,
} from '../lib/calibration-core.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd();

function die(msg, code = 3) {
  console.error(msg);
  process.exit(code);
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(cwd, file), 'utf8').replace(/^\uFEFF/, ''));
}

async function main() {
  switch (cmd) {
    case 'status':
    case 'list': {
      const goals = await listGoals(cwd);
      if (goals.length === 0) {
        console.log('台账为空：还没有目标合约。用 `node bin/goal.mjs define goal.json` 建一份。');
        return 0;
      }
      for (const g of goals) {
        const s = g.last_summary;
        const tail = s ? `${s.pass}/${s.total} pass · fail ${s.fail} · unknown ${s.unknown}` : '未检查';
        const review = await loadLatestReview(cwd, g.id).catch(() => null);
        const gated = Boolean(g.rubric?.dims);
        const reviewTail = gated
          ? `评审 ${g.rubric.dims} 维 ${review?.audited?.total ?? '未判'}/${g.rubric.bar}`
          : '无评审层';
        console.log(`- ${g.id} [${g.status}] ${g.objective}`);
        console.log(`    机器层 ${g.done_when} 条 · ${tail}｜${reviewTail}`);
      }
      return 0;
    }

    case 'check': {
      const contract = await resolveContract(cwd, rest[0]);
      const results = await runContract(contract, { cwd });
      const { file, round } = await saveProof(cwd, contract, results, { actor: 'cli' });
      const s = summarize(results);
      if (s.green && contract.status !== 'green') await setStatus(cwd, contract.id, 'green', path.basename(file));
      console.log(renderReport(contract, results, round));
      console.log(`\nproof: ${file}`);
      console.log(verdictLine(results));
      if (s.green && contract.rubric?.dims?.length) {
        console.log('（机器层全绿；还有评审层没过——用 review 提交判分，再 verdict 看终局）');
      }
      return s.green ? 0 : s.fail > 0 ? 1 : 2;
    }

    case 'define':
    case 'init': {
      const src = rest[0] && rest[0] !== '-' ? readFileSync(path.resolve(cwd, rest[0]), 'utf8') : readFileSync(0, 'utf8');
      let input;
      try {
        input = JSON.parse(src.replace(/^\uFEFF/, ''));
      } catch (err) {
        die(`合约 JSON 解析失败：${String(err)}`);
      }
      let prev = null;
      if (input.id) {
        try {
          prev = await loadContract(cwd, input.id);
        } catch {
          prev = null;
        }
      }
      const contract = normalizeContract({
        ...input,
        created_at: prev?.created_at ?? input.created_at,
        status: prev?.status ?? 'open',
        revision: prev ? Number(prev.revision || 1) + 1 : 1,
      });
      const rubric = normalizeRubric(input.rubric ?? (prev?.rubric ? prev.rubric : null));
      contract.rubric = rubric;
      const v = validateContract(contract);
      const rv = validateRubric(rubric);
      const errors = [...v.errors, ...rv.errors];
      const warnings = [...v.warnings, ...rv.warnings];
      if (errors.length) {
        console.error('合约被拒收：');
        for (const e of errors) console.error(`  ✗ ${e}`);
        for (const w of warnings) console.error(`  ! ${w}`);
        return 3;
      }
      const { file } = await saveContract(cwd, contract, { actor: 'cli', note: prev ? 'update' : 'create' });
      for (const w of warnings) console.log(`! ${w}`);
      const gate = rubric ? ` + ${rubric.dims.length} 维评审（合格线 ${rubric.bar}）` : '';
      console.log(`目标已落盘：${contract.id}（${contract.done_when.length} 条机器验收${gate}）\n${file}`);
      console.log(`下一步：node bin/goal.mjs check ${contract.id}`);
      return 0;
    }

    case 'predict': {
      if (!rest[0]) die('用法：node bin/goal.mjs predict <predict.json> [id]');

      const contract = await resolveContract(cwd, rest[1]);
      const rubric = normalizeRubric(contract.rubric);

      if (!rubric?.dims?.length) die('这个目标没有 rubric：没有维度就没法押注。');
      const raw = rest[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(path.resolve(cwd, rest[0]), 'utf8');
      let input;
      try {
        input = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch (err) {
        die(`预测 JSON 解析失败：${String(err)}`);
      }

      const pred = normalizePrediction(input);
      const v = validatePrediction(pred, rubric);

      if (!v.ok) {
        console.error('预测被拒收（押注前先想清楚，不是写完再改）：');
        for (const e of v.errors) console.error(`  ✗ ${e}`);
        for (const w of v.warnings) console.error(`  ! ${w}`);
        return 3;
      }

      const sealed = sealPrediction(pred);
      let saved;
      try {
        saved = await savePrediction(cwd, contract, sealed);
      } catch (err) {
        console.error(err?.code === 'PREDICT_AFTER_REVIEW' ? err.message : String(err));
        return 1;
      }
      for (const w of v.warnings) console.log(`! ${w}`);
      console.log(`押注已封（第 ${saved.round} 轮）：${sealed.digest}`);
      console.log(`  总分区间 ${sealed.bet.total_low}–${sealed.bet.total_high}｜依据 ${sealed.basis}`);
      console.log('  封条一落就不可改——判完回来对账，改预测等于照着答案押注。');
      console.log(`predict: ${saved.file}`);
      return 0;
    }

    case 'retro': {
      const contract = await resolveContract(cwd, rest[0]);
      const rubric = normalizeRubric(contract.rubric);
      if (!rubric?.dims?.length) die('这个目标没有 rubric：没有标准就没有偏差可言。');
      const preds = await listPredictions(cwd, contract.id);

      if (preds.length === 0) die('还没有押注，先 predict 再判分，否则对账无意义。', 1);
      const targetRound = rest[1] ? Number(rest[1]) : null;
      const predRec = targetRound
        ? preds.find((p) => Number(p.round) === targetRound)
        : preds[preds.length - 1];

      if (!predRec) die(`没有第 ${targetRound} 轮的预测。`, 1);
      const reviewRec = await loadLatestReview(cwd, contract.id).catch(() => null);

      if (!reviewRec) die('还没有判分，无从对账：先 review。', 1);
      const result = compare(predRec.prediction, reviewRec, rubric);
      const saved = await saveRetro(cwd, contract, result, { round: predRec.round });
      const retros = await listRetros(cwd, contract.id);
      const streak = biasStreak(retros);
      console.log(retroLine({ ...result, round: predRec.round }));
      if (streak.warn) {
        console.log(`\n注意：连续 ${streak.count} 轮同向偏差（${streak.direction}）。`);
        console.log('  这说明标准本身有偏，不是稿子每次都错——改 criterion，并给 rubric_change_reason。');
      }
      console.log(`retro: ${saved.file}`);
      return 0;
    }

    case 'review': {
      if (!rest[0]) die('用法：node bin/goal.mjs review <review.json> [id]');
      const contract = await resolveContract(cwd, rest[1]);
      const rubric = normalizeRubric(contract.rubric);
      if (!rubric?.dims?.length) die('这个目标没有 rubric：没有标准就没法判分。先用 define 补 rubric。');
      const review = readJson(rest[0]);
      const audited = validateReview(review, rubric, cwd);
      const { file } = await saveReview(cwd, contract, { ...review, audited }, { actor: 'cli' });
      console.log(`判分审计：${audited.ok ? '结构合格' : '被拒收'}`);
      for (const e of audited.errors) console.log(`  ✗ ${e}`);
      for (const w of audited.warnings) console.log(`  ! ${w}`);
      console.log(`重算总分：${audited.total}（合格线 ${rubric.bar}）｜红线：${audited.vetoes_hit.join('、') || '无'}`);
      console.log(`review: ${file}`);
      return audited.ok ? 0 : 1;
    }

    case 'verdict': {
      const contract = await resolveContract(cwd, rest[0]);
      const rubric = normalizeRubric(contract.rubric);
      const proof = await loadLatestProof(cwd, contract.id).catch(() => null);
      const reviewRec = await loadLatestReview(cwd, contract.id).catch(() => null);
      const audited = reviewRec?.audited ?? null;
      const machineGreen = Boolean(proof?.summary?.green);
      const verdict = decide({ machineGreen, rubric, review: audited });
      if (!proof) verdict.reasons.unshift('还没有跑过 check');
      const { file } = await saveGate(cwd, contract, {
        ...verdict,
        id: contract.id,
        machine_green: machineGreen,
        proof: proof?.file ?? null,
        review: reviewRec?.file ?? null,
        at: new Date().toISOString(),
      });
      if (verdict.deliverable && contract.status !== 'green') {
        await setStatus(cwd, contract.id, 'green', 'gate 放行');
      }
      console.log(decideLine(verdict));
      if (verdict.reasons.length) for (const r of verdict.reasons) console.log(`  · ${r}`);
      console.log(`gate: ${file}`);
      return verdict.deliverable ? 0 : 1;
    }

    case 'demo': {
      return await demo();
    }

    default:
      console.log(`用法：
  node bin/goal.mjs status                 台账总览（机器层 + 评审层 + 校准）
  node bin/goal.mjs check [id]             真跑机器层，落 proof
  node bin/goal.mjs define <file.json>     从 JSON 建/更新合约（- 或省略则读 stdin）
  node bin/goal.mjs predict <file.json> [id]  判分前押注（落盘即封，不可改）
  node bin/goal.mjs review <file.json> [id]   提交判分，机器审计
  node bin/goal.mjs retro [id] [round]     判完后对账：尺子偏高还是偏低
  node bin/goal.mjs verdict [id]           最终裁决（0 可交 / 1 不许交）
  node bin/goal.mjs demo                   跑一遍完整链路给你看

台账目录：${path.join(cwd, '.goal')}`);
      return cmd === undefined || cmd === 'help' ? 0 : 3;
  }
}

/**
 * 玩具目标，跑完整链路：机器层故意先红一次，修绿；判分先被拒一次（引文编的），
 * 改成逐字引文后过线；最后 verdict 放行。这不是演示动画，是真跑。
 */
async function demo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-loop-demo-'));
  const rel = (p) => path.relative(dir, p) || '.';
  console.log(`演示目录：${dir}\n`);

  const draft = path.join(dir, 'draft.md');
  await writeFile(draft, '# 交付物\n用来演示的样本文件，还没写那句话。\n', 'utf8');

  const contract = normalizeContract({
    id: 'demo-loop',
    objective: '演示双层闸门：机器层先红后绿，评审层先被拒后过线',
    done_when: [
      {
        id: 'D1',
        claim: `draft.md 里出现「双层闸门」四个字`,
        check: `node -e "const s=require('fs').readFileSync('draft.md','utf8');process.exit(s.includes('双层闸门')?0:1)"`,
        expect: { kind: 'exit', value: 0 },
      },
    ],
    non_goals: ['不联网'],
  }, new Date());
  contract.rubric = normalizeRubric({
    topic: '演示',
    dims: [
      { id: 'M1', name: '事实', weight: 30, criterion: 'draft.md 第 2 行的句子能被逐字引用而不改动', pass_example: '引文与原文一字不差', fail_example: '引文是转述或改过标点', intent: '防的是转述冒充原文', vision: '引文能逐字比对' },
      { id: 'M2', name: '可执行', weight: 25, criterion: 'draft.md 里给出一条能在空目录跑通的命令', pass_example: '命令可粘贴且退出码为零', fail_example: '命令缺参数要手改', intent: '防的是读者跑不通', vision: '照抄就能跑' },
      { id: 'M3', name: '边界', weight: 25, criterion: 'draft.md 写明不支持的两类场景并给理由', pass_example: '列出不支持项并给理由', fail_example: '只说不支持不说为什么', intent: '防的是过度承诺', vision: '边界写清有理由' },
      { id: 'M4', name: '语气', weight: 20, criterion: 'draft.md 每段首句给结论，没有铺垫', pass_example: '首句即结论', fail_example: '开头两段都在说背景', intent: '防的是 AI 腔铺垫', vision: '读两行就知道结论' },
    ],
    vetoes: [{ id: 'V1', name: '编造引文', why: '编一句原文会让判分整份作废' }],
    bar: 95,
  });
  await saveContract(dir, contract, { actor: 'demo' });

  console.log('① 机器层第一次跑（预期红）');
  let results = await runContract(contract, { cwd: dir });
  let proof = await saveProof(dir, contract, results, { actor: 'demo' });
  console.log(`   ${verdictLine(results)}`);

  console.log('\n② 动手补上那句话，重跑（预期绿）');
  await writeFile(draft, '# 交付物\n双层闸门的演示：这句话现在逐字存在，可以被引用。\n结论先行：这份样本只演示机制，不承载真实结论。\n安装只需 npm i 即可跑通。\n不支持 Windows 7 因为它没有可用 TLS 栈。\n', 'utf8');
  results = await runContract(contract, { cwd: dir });
  proof = await saveProof(dir, contract, results, { actor: 'demo' });
  console.log(`   ${verdictLine(results)}`);

  console.log('\n③ 判分之前先押注（盲预测，封了不可改）');
  const prediction = sealPrediction(normalizePrediction({
    predictor: 'demo-tutor',
    basis: '引文是逐字抄的、M3 给了理由，按标准应当满分；风险在 M4 太短，可能被判没展开',
    dims: [
      { id: 'M1', expected: 10, why: '引文与原文一字不差' },
      { id: 'M2', expected: 10, why: '命令可直接粘贴' },
      { id: 'M3', expected: 10, why: '不支持项有理由' },
      { id: 'M4', expected: 10, why: '每段首句即结论' },
    ],
    bet: { total_low: 95, total_high: 100, risk_dims: ['M4'] },
  }));
  const predSaved = await savePrediction(dir, contract, prediction);
  console.log(`   封条 ${prediction.digest}｜押 ${prediction.bet.total_low}–${prediction.bet.total_high}`);
  console.log(`   predict: ${rel(predSaved.file)}`);

  console.log('\n④ 交一份转述的判分（预期被机器拒收）');
  const badReview = {
    reviewer: 'demo-reviewer',
    dims: [
      { id: 'M1', score: 10, quote: { file: 'draft.md', text: '双层闸门的演示这句话现在逐字存在', line: 2 }, beyond_spec: '多标了行号' },
      { id: 'M2', score: 10, quote: { file: 'draft.md', text: '安装只需 npm i 即可跑通。', line: 3 }, beyond_spec: '给了命令' },
      { id: 'M3', score: 10, quote: { file: 'draft.md', text: '不支持 Windows 7 因为它没有可用 TLS 栈。', line: 4 }, beyond_spec: '给了理由' },
      { id: 'M4', score: 10, quote: { file: 'draft.md', text: '# 交付物', line: 1 }, beyond_spec: '标题即结论' },
    ],
    vetoes_hit: [],
    total: 100,
  };
  let audited = validateReview(badReview, contract.rubric, dir);
  console.log(`   审计：${audited.ok ? '过' : '拒收'}`);
  for (const e of audited.errors) console.log(`   ✗ ${e}`);

  console.log('\n⑤ 改成逐字引文再交（预期过线）');
  const goodReview = JSON.parse(JSON.stringify(badReview));
  goodReview.dims[0].quote.text = '双层闸门的演示：这句话现在逐字存在，可以被引用。';
  goodReview.dims[3].quote.text = '结论先行：这份样本只演示机制，不承载真实结论。';
  goodReview.dims[3].quote.line = 3;
  audited = validateReview(goodReview, contract.rubric, dir);
  const saved = await saveReview(dir, contract, { ...goodReview, audited }, { actor: 'demo' });
  console.log(`   审计：${audited.ok ? '过' : '拒收'}｜重算总分 ${audited.total}（合格线 ${contract.rubric.bar}）`);
  for (const e of audited.errors) console.log(`   ✗ ${e}`);
  console.log(`   review: ${rel(saved.file)}`);

  console.log('\n⑥ 判完对账：尺子准不准，这一层才算学到东西');
  const retro = compare(prediction, { ...goodReview, audited }, contract.rubric);
  const retroSaved = await saveRetro(dir, contract, retro, { round: predSaved.round });
  console.log(`   ${retroLine({ ...retro, round: predSaved.round })}`);
  const retros = await listRetros(dir, contract.id);
  const streak = biasStreak(retros);
  console.log(`   连续同向偏差：${streak.warn ? `${streak.count} 轮 ${streak.direction}（该改标准了）` : '无'}`);
  console.log(`   retro: ${rel(retroSaved.file)}`);

  console.log('\n⑦ 终局裁决');
  const machineGreen = Boolean((await loadLatestProof(dir, contract.id))?.summary?.green);
  const reviewRec = await loadLatestReview(dir, contract.id);
  const verdict = decide({ machineGreen, rubric: contract.rubric, review: reviewRec?.audited ?? null });
  const gated = await saveGate(dir, contract, {
    ...verdict, id: contract.id, machine_green: machineGreen,
    proof: proof.file, review: saved.file, at: new Date().toISOString(),
  });
  console.log(`   ${decideLine(verdict)}`);
  console.log(`   gate: ${rel(gated.file)}`);
  console.log(`\n演示目录保留：${dir}\n想看结构：ls -R ${dir}${path.sep}.goal`);
  return verdict.deliverable ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ?? String(err));
    process.exit(3);
  },
);
