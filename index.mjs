/**
 * dsh-goal-loop — 目标工程 × 双团队评审 × 盲预测校准，三层闸门。
 *
 * 上一代 dsh-goal-engineering 解决「机器能验的部分」：一条命令，0/1，全绿才算完成。
 * dsh-judge-loop 解决「机器验不了的部分」：标准由不看稿的人写，判分由不是作者的人给。
 * 两者各自都缺一半：
 *   - 只有机器层：文件在不在能验，"这份东西配不配发出去"验不了；
 *   - 只有评审层：分数是人报的，报多少是多少，没人查引文真假、没人算权重对不对。
 *
 * 这一代把两半焊在一起：
 *   一份合约（.goal/<id>/goal.json）同时装 done_when（机器层）与 rubric（评审层）。
 *   放行判据 deliverable = 机器全绿 &&（无 rubric ? true : 评审过线且无红线）。
 *
 * 真正的增量是「机器替人审计判分过程」——人只做那个判断：这句话好不好。
 *   引文是否逐字存在于被评审的文件里（找不到即判分作废）；
 *   分数是否只落在 0/4/7/10 四档；
 *   总分是否等于按权重重算的结果（手报的数不采信）；
 *   扣分是否落成了「把 X 改成 Y」（说不清怎么改的扣分不算数）；
 *   红线是否命中（命中则分数再高也不许交）。
 *
 * 八个工具：
 *   goal_define   编译合约（含 rubric / 代价台账 / 拒绝清单），不合格直接拒收，不落盘；dry_run 只验不落。
 *   goal_check    真跑机器层，落 proof-<n>.json；only 参数用于调试单条。
 *   goal_review   提交判分，机器审计后落 review-<n>.json，同时写 review-brief.json（判分任务书）。
 *   goal_predict  判分前押注，封条不可改。
 *   goal_retro    判完对账，记偏差方向与命中率。
 *   goal_verdict  读盘上最近的 proof / review / retro，给唯一裁决，落 gate.json。
 *   goal_doctor   一次体检全部目标：卡在哪、下一步敲哪个工具。
 *   goal_status   台账总览。
 *
 * 一个技能（skill/goal-loop.md）+ 三个角色稿（agents/{professor,tutor,reviewer}.md）+ 两个命令。
 * 只消费公开服务（tools / skills / commands / systemPrompt / workingDirectory），随 Fiber 拆除。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  normalizeContract,
  validateContract,
  runContract,
  summarize,
  renderReport,
  verdictLine,
  nextStep,
} from './lib/goal-core.mjs';
import {
  saveContract,
  loadContract,
  resolveContract,
  listGoals,
  saveProof,
  setStatus,
  goalDir,
} from './lib/goal-store.mjs';
import {
  normalizeRubric,
  validateRubric,
  validateReview,
  decide,
  decideLine,
  scoreTotal,
  DEFAULT_BAR,
} from './lib/rubric-core.mjs';
import {
  saveReview,
  loadLatestReview,
  loadLatestProof,
  saveGate,
  reviewDir,
  savePrediction,
  loadLatestPrediction,
  listPredictions,
  saveRetro,
  listRetros,
  appendRubricHistory,
  markReviewsStale,
  saveReviewBrief,
} from './lib/review-store.mjs';
import {
  normalizePrediction,
  sealPrediction,
  validatePrediction,
  compare,
  biasStreak,
  validateRubricChange,
  retroLine,
} from './lib/calibration-core.mjs';

/** Cordis 插件名。 */
export const name = 'dsh-goal-loop';

/** 工具注册所需服务。 */
export const inject = ['tools'];

const SKILL_NAME = 'goal-loop';
const SKILL_FILE = fileURLToPath(new URL('./skill/goal-loop.md', import.meta.url));
const AGENT_DIR = fileURLToPath(new URL('./agents/', import.meta.url));

/**
 * 常驻行为层：写进系统提示，不赌"模型会记得去加载技能"。
 * 刻意压短——它每一轮都要付费，只留判断权归属与最硬的四条。
 */
const POLICY_SECTION = [
  '【目标工程 · 三层闸门】判断权不归我：能不能交，不由我说；标准准不准，也不由我说。',
  '1) 交付类任务动手之前先 goal_define：objective（交付什么、给谁、什么规模）+ done_when（每条一个能真跑的命令）+ non_goals。',
  '   判不了好坏的质量维度另写 rubric（4–6 维、权重合计 100、每维有正反例、至少一条红线）。合约被拒收＝目标还不可验收，补全再落，不许"先干着看"。',
  '2) 动手，然后 goal_check 真跑；红灯只修红灯列出的那几条，修完必须重跑，不许换题。',
  '3) 有 rubric 的任务，判分必须由独立一方给（自己写的稿子自己打分不算），交 goal_review 让机器审计：引文逐字对、分数重算、扣分要能落成改法、命中红线即废。',
  '4) 说"完成／做好了／可以了"之前必须 goal_verdict 的 deliverable=true。没过就如实说差哪条、卡在哪。',
  '5) 有 rubric 的任务，判分之前先 goal_predict 押注（每维押 0/4/7/10 + 总分区间 + 依据），封了不可改；判完 goal_retro 对账。连续三轮同向偏差＝错的是标准不是稿子，改 criterion 并给 rubric_change_reason，旧分作废重判。',
  '6) 说「借鉴／参考／复刻／移植」就必须给 provenance：source（抄的是哪个仓库哪个版本）+ paid_for（对方为这设计付过什么代价：哪次事故、哪次回退、哪个被拒的 PR）+ kept（我们保留或改了什么）。抄想法只抄到壳，抄代价才抄到骨头——没有代价记录的借鉴一律按抄壳处理。确实无代价可抄时用 provenance_waived + 理由，别静默跳过。',
  '   同时写 refusals：哪些要求会被提出来、为什么拒、怎么答。写下来的拒绝，下一轮才不会被重新提一遍。',
  '不知道卡在哪就 goal_doctor：它把每个目标的问题与下一步该敲的工具一起列出来。',
  '不建合约：纯问答、单点排错、闲聊——直接答，别为建合约而建合约。',
].join('\n');

/** 读技能文件，拆 frontmatter。 */
function readSkill(file, fallbackDescription) {
  const raw = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const front = match === null ? '' : match[1];
  const content = (match === null ? raw : raw.slice(match[0].length)).trim();
  const line = front
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('description:'));
  const description = line === undefined
    ? fallbackDescription
    : line.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
  return { description, content };
}

/** @param {object} ctx @param {string} key */
function serviceOf(ctx, key) {
  if (typeof ctx.get === 'function') return ctx.get(key);
  return ctx[key];
}

/**
 * 解析工作目录：显式参数 → 会话工作区 → 进程 cwd。
 * @param {object} ctx @param {string} requested @param {object} [exec]
 */
async function resolveCwd(ctx, requested, exec) {
  const explicit = String(requested ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const workingDirectory = serviceOf(ctx, 'workingDirectory');
  const agent = exec?.agent;
  if (agent !== undefined && typeof workingDirectory?.ensure === 'function') {
    try {
      const cwd = await workingDirectory.ensure(agent, exec?.signal);
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      /* 退到会话头 */
    }
  }
  const fromSession = agent?.session?.header?.cwd ?? agent?.cwd;
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession;
  return process.cwd();
}

/** 工具共用：done_when 的参数 schema。 */
const doneWhenSchema = {
  type: 'array',
  description: '机器层验收条件。每条必须能回答"怎么算做到了"，且答案是能真跑的命令。',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['claim', 'check'],
    properties: {
      id: { type: 'string', description: '短 id，如 D1；省略自动编号。' },
      claim: { type: 'string', description: '这一条要证明什么（一句话，尽量含可观测信号）。' },
      check: { type: 'string', description: '能真跑的命令（shell）。exit 类必填；manual 类填空字符串。' },
      cwd: { type: 'string', description: '可选：该命令的工作目录（相对工作区）。' },
      timeout_ms: { type: 'number', description: '可选：单条超时，默认 120000。' },
      expect: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: ['exit', 'equals', 'contains', 'not_contains', 'matches', 'manual'],
          },
          value: { description: '期望值：exit→退出码；equals→stdout 全文；contains/not_contains→子串；matches→正则；manual→忽略。' },
        },
      },
    },
  },
};

/** 评审层参数 schema。 */
const rubricSchema = {
  type: 'object',
  description: '评审层标准。判不了好坏、只能靠人看的质量维度写这里；纯工程任务可省略。',
  additionalProperties: true,
  properties: {
    topic: { type: 'string', description: '这份标准针对什么题目。' },
    bar: { type: 'number', description: `合格线，默认 ${DEFAULT_BAR}（发出去不会被问倒的水位）。` },
    dims: {
      type: 'array',
      description: '4–6 个维度，权重合计 100。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'weight', 'criterion', 'pass_example', 'fail_example', 'intent', 'vision'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          weight: { type: 'number', description: '10–30；会直接害人的给 25–30，只是不漂亮的给 10–15。' },
          criterion: { type: 'string', description: '≥12 字，且必须含可被外部抽查的东西（路径/行号/数字/命令/原文片段）。' },
          pass_example: { type: 'string', description: '≥8 字：什么样算过。' },
          fail_example: { type: 'string', description: '≥8 字：什么样算没过。' },
          intent: { type: 'string', description: '≥8 字：这条防的是哪种稿子。' },
          vision: { type: 'string', description: '≥8 字：满分长什么样。' },
          evidence: { type: 'string', description: '这条判据从题面/素材哪里来的。' },
          machine: { type: 'array', items: { type: 'string' }, description: '顺带能写成命令的子判据（可选，会并进机器层核对）。' },
        },
      },
    },
    vetoes: {
      type: 'array',
      description: '红线：命中就不许交，不看分数。至少一条。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'why'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          why: { type: 'string', description: '≥10 字：为什么命中就不能交。' },
        },
      },
    },
  },
};

/** goal_define 参数。 */
const defineParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'done_when'],
  properties: {
    objective: { type: 'string', description: '交付什么、给谁用、什么规模。低于 12 字会被拒收。' },
    done_when: doneWhenSchema,
    rubric: rubricSchema,
    rubric_file: { type: 'string', description: '也可以给一份 rubric.json 的路径（相对工作区），由教授角色产出。' },
    constraints: { type: 'array', items: { type: 'string' }, description: '硬约束（不许动的东西、必须用的技术、时间）。' },
    non_goals: { type: 'array', items: { type: 'string' }, description: '明确不做的事——挡住范围膨胀。' },
    provenance: {
      type: 'array',
      description: '代价台账：这份交付借鉴/复刻了谁，对方为这个设计付过什么代价。合约里只要出现「借鉴/参考/复刻/移植/抄」就必填（否则拒收）。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'paid_for', 'kept'],
        properties: {
          id: { type: 'string' },
          source: { type: 'string', description: '从哪抄的：仓库/文件/版本/链接。写「某个开源项目」等于没写。' },
          paid_for: { type: 'string', description: '≥12 字且含可查线索：对方踩过的坑、回退过的版本、被拒的 PR、为什么把阈值定在这里。' },
          kept: { type: 'string', description: '≥8 字：我们保留哪一条，或改了什么、为什么改。' },
        },
      },
    },
    refusals: {
      type: 'array',
      description: '拒绝清单：有人会提出的那种要求 + 为什么拒 + 怎么答。写下来的拒绝，下一轮才不会被重新提一遍。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ask', 'why'],
        properties: {
          id: { type: 'string' },
          ask: { type: 'string', description: '对方会说的那句话，如「把阈值降一点让这次过」。' },
          why: { type: 'string', description: '≥10 字：为什么不能答应。' },
          reply: { type: 'string', description: '直接怎么回他（可省，省了下次得重新想措辞）。' },
        },
      },
    },
    provenance_waived: { type: 'boolean', description: '确实没有可抄的代价时置 true，并给 provenance_waiver_reason。这是显式声明，不是静默跳过。' },
    provenance_waiver_reason: { type: 'string', description: '≥12 字：为什么这次不需要代价台账（全新设计、无先例、或借鉴对象没有公开的代价记录）。' },
    dry_run: { type: 'boolean', description: '只校验不落盘：拿来看「这份合约还差什么」，不会产生台账、不会递增 revision。' },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_rounds: { type: 'number', description: '最多检查几轮，默认 5。' },
        max_minutes: { type: 'number', description: '时间预算，默认 90。' },
      },
    },
    id: { type: 'string', description: '更新既有目标时传同一个 id（revision 会自动 +1）；新建留空。' },
    rubric_change_reason: {
      type: 'string',
      description: '更新已有目标且 rubric 变了时必填（≥12 字）：哪一维判错了、被什么证据推翻。不给就拒收——静默换尺子会让历史分数失去可比性。',
    },
    cwd: { type: 'string', description: '工作区目录，省略用当前会话工作区。' },
  },
};

/** goal_predict 参数。 */
const predictParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['dims', 'bet', 'basis'],
  properties: {
    id: { type: 'string', description: '目标 id，省略取最近一个未放弃的目标。' },
    dims: {
      type: 'array',
      description: '每一维押一个分（0/4/7/10）。必须有 rubric 的全部维度，缺一维会被拒收。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expected'],
        properties: {
          id: { type: 'string', description: '维度 id，如 M1。' },
          expected: { type: 'number', description: '押它得几分：0 / 4 / 7 / 10。' },
          why: { type: 'string', description: '为什么押这个分（可省，但省了对账时解释不了）。' },
        },
      },
    },
    bet: {
      type: 'object',
      additionalProperties: false,
      required: ['total_low', 'total_high'],
      properties: {
        total_low: { type: 'number', description: '押的总分下界。' },
        total_high: { type: 'number', description: '押的总分上界。按维分算出的值必须落在这个区间里。' },
        risk_dims: { type: 'array', items: { type: 'string' }, description: '你认为最可能掉分的维度 id。' },
      },
    },
    basis: { type: 'string', description: '≥12 字：凭什么这么押（上次同类交付哪一维掉过分、这次靠什么补的）。' },
    predictor: { type: 'string', description: '谁押的（如 tutor / 我）。不能与之后的判分人是同一个。' },
    cwd: { type: 'string', description: '工作区目录。' },
  },
};

/** goal_retro 参数。 */
const retroParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '目标 id，省略取最近一个。' },
    round: { type: 'number', description: '对哪一轮对账，省略取最近一份预测与判分。' },
    cwd: { type: 'string', description: '工作区目录。' },
  },
};

/** goal_check 参数。 */
const checkParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '目标 id，省略取最近一个未放弃的目标。' },
    only: { type: 'array', items: { type: 'string' }, description: '只跑这些条件 id（调试用，正式验收不要用）。' },
    cwd: { type: 'string', description: '工作区目录。' },
  },
};

/** goal_review 参数。 */
const reviewParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '目标 id，省略取最近一个。' },
    review: {
      type: 'object',
      description: '判分内容：{reviewer, round, dims:[{id,score,quote:{file,text,line},deduction,beyond_spec}], vetoes_hit, total, blocked}。',
      additionalProperties: true,
    },
    review_file: { type: 'string', description: '也可以给判分文件路径（相对工作区或绝对），如 review-1.json（即 score-v1.json）。' },
    cwd: { type: 'string', description: '工作区目录。' },
  },
};

/** goal_verdict / goal_status 参数。 */
const verdictParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '目标 id，省略取最近一个未放弃的目标。' },
    cwd: { type: 'string', description: '工作区目录。' },
  },
};

/** 读一份 JSON（容忍 BOM）。 */
function readJsonFile(file) {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** 按押的各维分算总分（只用于提示文案）。 */
function scoreTotalSafe(rubric, dims) {
  const scores = Object.fromEntries(dims.map((d) => [d.id, d.expected]));
  return scoreTotal(rubric, scores).total;
}

/** 解析 rubric：内联优先，其次文件。 */
function resolveRubric(args, cwd) {
  if (args.rubric && typeof args.rubric === 'object') {
    return normalizeRubric({ ...args.rubric, source: 'inline' });
  }
  const rel = String(args.rubric_file ?? '').trim();
  if (!rel) return null;
  const abs = path.resolve(cwd, rel);
  if (!existsSync(abs)) throw new Error(`rubric_file 不存在：${rel}`);
  return normalizeRubric({ ...readJsonFile(abs), source: path.basename(abs) });
}

/**
 * @param {object} ctx Cordis 上下文
 */
/**
 * 插件配置：这一版把「常驻提示」与「技能/命令」做成可关的。
 *
 * 为什么要开关：常驻政策段每轮都进系统提示，它换来的是「不用记得加载技能」；
 * 如果你只在偶尔做交付时才用这套东西，天天带着一段规则是浪费。
 * 关掉之后工具仍在、skill goal-loop 仍可手动加载，只是不再自动进提示。
 *
 * 在 profile 的 cordis.patch.yml 里改：
 *   - id: dsh-goal-loop
 *     config: { policy: false }
 * 三个键都可省略，缺省全开；写 false 才关。
 * 不声明 schemastery 的 Config：这个插件装在 profile 之外的工作树里，
 * 真实路径解析链上拿不到 @deepseek-ai/schemastery，声明了反而会让整插件加载失败。
 */
export const CONFIG_KEYS = ['policy', 'skills', 'commands'];

/**
 * 挂载入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} config 插件配置（缺省时三项全开）
 */
export function apply(ctx, config = {}) {
  const log = (msg) => ctx.logger?.warn?.(`dsh-goal-loop: ${msg}`);
  const on = (key) => config?.[key] !== false;

  // 0) 常驻政策段：三层闸门不靠"记得加载技能"，直接进系统提示。
  if (on('policy') && typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = serviceOf(promptCtx, 'systemPrompt');
      if (typeof systemPrompt?.section !== 'function') return;
      const register = () => systemPrompt.section({
        name: 'goal:loop',
        ...(typeof systemPrompt.getSectionOrder === 'function'
          ? { order: systemPrompt.getSectionOrder('TOOL_GOAL') }
          : {}),
        text: POLICY_SECTION,
      });
      try {
        if (typeof promptCtx.effect === 'function') promptCtx.effect(register, 'goal.loop.policy');
        else register();
      } catch (error) {
        log(`policy section failed: ${String(error)}`);
      }
    });
  }

  // 1) 行为协议：主技能 + 三个角色稿
  if (on('skills') && typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      const skills = serviceOf(skillCtx, 'skills');
      if (typeof skills?.register !== 'function') return;
      const register = (payload) => {
        try {
          skills.register(payload);
        } catch (error) {
          log(`skill ${payload.name} 未注册：${String(error)}`);
        }
      };
      try {
        const { description, content } = readSkill(
          SKILL_FILE,
          '目标工程三层闸门：机器层全绿 + 独立评审过线 + 盲预测校准无连续偏差，才叫能交。',
        );
        register({
          name: SKILL_NAME,
          description,
          content,
          source: SKILL_FILE,
          resourceBase: { kind: 'directory', path: AGENT_DIR },
          invocation: { modelInvocable: true, userInvocable: true },
        });
      } catch (error) {
        log(`主技能读取失败：${String(error)}`);
      }
      for (const role of ['professor', 'tutor', 'reviewer']) {
        const file = path.join(AGENT_DIR, `${role}.md`);
        try {
          const { description, content } = readSkill(file, `${role} 角色稿`);
          register({
            name: `goal-${role}`,
            description,
            content,
            source: file,
            invocation: { modelInvocable: true, userInvocable: true },
          });
        } catch (error) {
          log(`角色技能 ${role} 未注册：${String(error)}`);
        }
      }
    });
  }

  // 2) 斜杠命令
  if (on('commands') && typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      const commands = serviceOf(commandCtx, 'commands');
      if (typeof commands?.register !== 'function') return;
      const add = (payload) => {
        try {
          commands.register(payload);
        } catch (error) {
          log(`命令 ${payload.name} 注册失败：${String(error)}`);
        }
      };

      add({
        definitionId: 'dsh-goal-loop/goal',
        name: 'goal',
        description: '进入目标工程：先说清交付什么，编译成双层合约，再动手；两层都过才算完成',
        input: { hint: '<你要交付的东西>', attachments: false },
        handler: () => ({
          kind: 'prompt',
          text: [
            '按目标工程双层闸门处理下面这件事：先读 skill goal-loop。',
            '1) 用 goal_define 编译合约：objective / done_when / non_goals，判不了好坏的质量维度写进 rubric；',
            '2) 合约被拒收就补全，不许"先干着看"；',
            '3) 动手，然后 goal_check；只修红灯列出的项，修完重跑；',
            '4) 有 rubric 就派独立判分人（不是动手的那一个），把判分交 goal_review；',
            '5) 说完成之前调 goal_verdict，deliverable=true 才许汇报。',
          ].join('\n'),
        }),
      });

      add({
        definitionId: 'dsh-goal-loop/review',
        name: 'review',
        description: '对已完成的交付做独立评审：按 rubric 打分并交机器审计（引文逐字对、分数重算）',
        input: { hint: '<被评审的文件或目标 id>', attachments: false },
        handler: (input) => ({
          kind: 'prompt',
          text: [
            `对「${String(input?.text ?? '').trim() || '当前交付物'}」做一次独立评审。`,
            '先读 skill goal-loop 与 skill goal-reviewer。',
            '1) goal_status 拿到 rubric；',
            '2) 逐维给 0/4/7/10，每一档必须附一句在该文件里逐字存在的原文（≥12 字）与行号；',
            '3) 扣分的维度必须写成「把 <文件>:<行> 的「原文」改成「新句」」；',
            '4) 总分不自己算，交给 goal_review 重算；',
            '5) 命中红线直接列出 vetoes_hit，不要试图用高分盖过去。',
          ].join('\n'),
        }),
      });
    });
  }

  // 3) goal_define
  ctx.tools.register({
    name: 'goal_define',
    description:
      '把需求编译成「双层目标合约」并落盘到 .goal/<id>/goal.json。done_when 是机器层（每条一个能真跑的命令）；rubric 是评审层（4–6 维、权重合计 100、每维有正反例、至少一条红线）。合约不合格会被拒收且不落盘——按 errors 补全后重调。这是目标工程的第一步：动手之前先让目标可验收。',
    parameters: defineParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'dir', 'errors', 'warnings', 'gated', 'message'],
        properties: {
          ok: { type: 'boolean', description: '合约是否通过校验并落盘。' },
          id: { type: 'string' },
          dir: { type: 'string', description: '台账目录绝对路径。' },
          errors: { type: 'array', items: { type: 'string' }, description: '必须修掉的硬错误。' },
          warnings: { type: 'array', items: { type: 'string' }, description: '不会拦下但会削弱验收的提醒。' },
          gated: { type: 'boolean', description: '是否有评审层（rubric）。' },
          dry_run: { type: 'boolean', description: '本次只校验未落盘。' },
          counts: {
            type: 'object',
            description: '合约体量：机器验收条数、评审维数、代价台账条数、拒绝清单条数。',
            properties: {
              done_when: { type: 'number' },
              dims: { type: 'number' },
              provenance: { type: 'number' },
              refusals: { type: 'number' },
            },
          },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const existing = String(args.id ?? '').trim();
      let prev = null;
      if (existing) {
        try {
          prev = await loadContract(cwd, existing);
        } catch {
          prev = null;
        }
      }

      let rubric = null;
      let rubricErrors = [];
      let rubricWarnings = [];
      try {
        rubric = resolveRubric(args, cwd) ?? (prev?.rubric ? normalizeRubric(prev.rubric) : null);
        const rv = validateRubric(rubric);
        rubricErrors = rv.errors;
        rubricWarnings = rv.warnings;
      } catch (error) {
        rubricErrors = [`rubric 读不出来：${String(error.message ?? error)}`];
      }

      const contract = normalizeContract(
        {
          id: existing || undefined,
          objective: args.objective,
          done_when: args.done_when,
          constraints: args.constraints,
          non_goals: args.non_goals,
          provenance: args.provenance,
          refusals: args.refusals,
          provenance_waived: args.provenance_waived,
          provenance_waiver_reason: args.provenance_waiver_reason,
          budget: args.budget,
          created_at: prev?.created_at,
          status: prev?.status ?? 'open',
          revision: prev ? Number(prev.revision || 1) + 1 : 1,
        },
        new Date(),
      );
      contract.rubric = rubric;
      const verdict = validateContract(contract);
      const errors = [...verdict.errors, ...rubricErrors];
      const warnings = [...verdict.warnings, ...rubricWarnings];
      const gated = Boolean(rubric?.dims?.length);

      // 换尺子的刹车：判据变了必须给理由，且旧分要作废。
      const prevRubric = prev?.rubric?.dims?.length ? normalizeRubric(prev.rubric) : null;
      const change = prevRubric && rubric
        ? validateRubricChange(prevRubric, rubric, args.rubric_change_reason)
        : null;
      if (change?.changed) {
        errors.push(...change.errors);
        warnings.push(...change.warnings);
      }

      const counts = {
        done_when: contract.done_when.length,
        dims: rubric?.dims?.length ?? 0,
        provenance: contract.provenance.length,
        refusals: contract.refusals.length,
      };

      // dry run：只回答"还差什么"，不产生任何台账。
      if (args.dry_run === true) {
        return {
          ok: errors.length === 0,
          id: contract.id,
          dir: goalDir(cwd, contract.id),
          errors,
          warnings,
          gated,
          dry_run: true,
          counts,
          message: errors.length
            ? `dry run：还差 ${errors.length} 项——${errors[0]}`
            : `dry run 通过：${counts.done_when} 条机器验收 + ${counts.dims} 维评审 + ${counts.provenance} 条代价台账 + ${counts.refusals} 条拒绝清单。未落盘；确认没问题就去掉 dry_run 再调一次。`,
        };
      }

      if (errors.length) {
        return {
          ok: false,
          id: contract.id,
          dir: goalDir(cwd, contract.id),
          errors,
          warnings,
          gated,
          dry_run: false,
          counts,
          message: `合约被拒收（${errors.length} 项）：${errors[0]} 修完再调 goal_define。`,
        };
      }

      const { dir } = await saveContract(cwd, contract, { actor: 'goal_define', note: prev ? 'update' : 'create' });
      let staleRounds = [];
      if (change?.changed) {
        await appendRubricHistory(cwd, contract, prevRubric, rubric, args.rubric_change_reason, change.diff);
        staleRounds = await markReviewsStale(cwd, contract.id, 'rubric 已更新');
      }
      const changeNote = change?.changed
        ? ` 判据已换（${[
          change.diff.added.length ? `+${change.diff.added.join('/')}` : '',
          change.diff.removed.length ? `-${change.diff.removed.join('/')}` : '',
          change.diff.changed.length ? `~${change.diff.changed.map((c) => c.id).join('/')}` : '',
          change.diff.bar ? `bar ${change.diff.bar.from}→${change.diff.bar.to}` : '',
        ].filter(Boolean).join(' ') || '措辞微调'}）${staleRounds.length ? `，${staleRounds.length} 份旧判分已标 stale，不可与新旧混算` : ''}。`
        : '';
      return {
        ok: true,
        id: contract.id,
        dir,
        errors: [],
        warnings,
        gated,
        dry_run: false,
        counts,
        message: gated
          ? `目标已落盘：${contract.id}（${contract.done_when.length} 条机器验收 + ${rubric.dims.length} 维评审，合格线 ${rubric.bar}${counts.provenance ? `，${counts.provenance} 条代价台账` : ''}${counts.refusals ? `，${counts.refusals} 条拒绝清单` : ''}）。下一步：先 goal_predict 押注，再动手，然后 goal_check。${changeNote}`
          : `目标已落盘：${contract.id}（${contract.done_when.length} 条机器验收，无评审层${counts.provenance ? `，${counts.provenance} 条代价台账` : ''}${counts.refusals ? `，${counts.refusals} 条拒绝清单` : ''}）。下一步动手，然后 goal_check。${changeNote}`,
      };
    },
  });

  // 4) goal_check
  ctx.tools.register({
    name: 'goal_check',
    description:
      '真跑合约里的每条 check（机器层），落 .goal/<id>/proof-<n>.json，返回三态结论。green=true 只代表机器层全绿，不代表能交（有 rubric 时还要过评审层）。fail/unknown 时必须先修、再重跑。unknown 来自 manual 条目或执行异常，不计入绿灯。',
    parameters: checkParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'green', 'id', 'summary', 'verdict', 'report', 'proof'],
        properties: {
          ok: { type: 'boolean', description: '检查是否成功执行（不代表通过）。' },
          green: { type: 'boolean', description: '机器层是否全绿。' },
          id: { type: 'string' },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: ['total', 'pass', 'fail', 'unknown'],
            properties: {
              total: { type: 'number' },
              pass: { type: 'number' },
              fail: { type: 'number' },
              unknown: { type: 'number' },
            },
          },
          verdict: { type: 'string', description: '一句话判定。' },
          report: { type: 'string', description: 'Markdown 报告（含每条证据）。' },
          proof: { type: 'string', description: '本轮 proof 文件路径。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.verdict }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const contract = await resolveContract(cwd, String(args.id ?? '').trim() || undefined);
      const results = await runContract(contract, {
        cwd,
        only: Array.isArray(args.only) ? args.only.map(String) : undefined,
      });
      const { file, round } = await saveProof(cwd, contract, results, { actor: 'goal_check' });
      const s = summarize(results);
      if (s.green && contract.status !== 'green') {
        await setStatus(cwd, contract.id, 'green', `proof ${path.basename(file)}`);
      }
      const gated = Boolean(contract.rubric?.dims?.length);
      const tail = s.green && gated ? '（机器层全绿；还有评审层没过，别急着汇报）' : '';
      return {
        ok: true,
        green: s.green,
        id: contract.id,
        summary: { total: s.total, pass: s.pass, fail: s.fail, unknown: s.unknown },
        verdict: `${verdictLine(results)}${tail}`,
        report: renderReport(contract, results, round),
        proof: file,
      };
    },
  });

  // 5) goal_review
  ctx.tools.register({
    name: 'goal_review',
    description:
      '提交一次独立判分并落 .goal/<id>/review-<n>.json。机器会审计这份判分：reviewer 不能是 self；每维分数只能是 0/4/7/10；每档必须附一句在被评审文件里逐字存在的原文（≥12 字，找不到即作废）；扣分的维度必须写出「把 X 改成 Y」；总分由机器按权重重算，不采信手报的数；命中红线直接不许交。审计不通过时按 errors 修判分再提交。',
    parameters: reviewParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'total', 'bar', 'vetoes_hit', 'deliverable', 'errors', 'warnings', 'file', 'message'],
        properties: {
          ok: { type: 'boolean', description: '判分是否通过机器审计。' },
          id: { type: 'string' },
          total: { type: 'number', description: '机器重算的总分。' },
          bar: { type: 'number', description: '合格线。' },
          vetoes_hit: { type: 'array', items: { type: 'string' } },
          deliverable: { type: 'boolean', description: '这份判分是否足以放行（不含机器层结论）。' },
          errors: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const contract = await resolveContract(cwd, String(args.id ?? '').trim() || undefined);
      const rubric = normalizeRubric(contract.rubric) ?? null;
      if (!rubric?.dims?.length) {
        return {
          ok: false, id: contract.id, total: 0, bar: DEFAULT_BAR, vetoes_hit: [],
          deliverable: false, errors: ['这个目标没有 rubric：没有标准就没法判分。先用 goal_define 补 rubric。'],
          warnings: [], file: '', message: '拒收：目标没有评审层标准（rubric）。',
        };
      }

      let review = args.review;
      const rel = String(args.review_file ?? '').trim();
      if (!review && rel) {
        const abs = path.resolve(cwd, rel);
        if (!existsSync(abs)) {
          return {
            ok: false, id: contract.id, total: 0, bar: rubric.bar, vetoes_hit: [],
            deliverable: false, errors: [`review_file 不存在：${rel}`],
            warnings: [], file: '', message: `拒收：读不到判分文件 ${rel}。`,
          };
        }
        try {
          review = readJsonFile(abs);
        } catch (error) {
          return {
            ok: false, id: contract.id, total: 0, bar: rubric.bar, vetoes_hit: [],
            deliverable: false, errors: [`review_file 解析失败：${String(error.message ?? error)}`],
            warnings: [], file: '', message: '拒收：判分文件不是合法 JSON。',
          };
        }
      }
      if (!review || typeof review !== 'object') {
        return {
          ok: false, id: contract.id, total: 0, bar: rubric.bar, vetoes_hit: [],
          deliverable: false, errors: ['缺 review：要么传 review 对象，要么传 review_file。'],
          warnings: [], file: '', message: '拒收：没有判分内容。',
        };
      }

      const audited = validateReview(review, rubric, cwd);

      // 盲预测的完整性：押注人和判分人不能是同一个。
      // 同一个人的「我押 96」和「我给 97」不是两个信号，是一个信号说了两遍。
      const pred = await loadLatestPrediction(cwd, contract.id).catch(() => null);
      const roster = (v) => String(v ?? '').trim().toLowerCase();
      if (pred?.predictor && roster(pred.predictor) === roster(review.reviewer) && roster(pred.predictor) !== '') {
        audited.errors.push(
          `押注人（${pred.predictor}）和判分人（${review.reviewer}）是同一个：盲预测要用在「押的人不知道判的人会给几分」，`
          + '同一个人两边都是他，对账就成了自己核对自己的预期。换一个人押，或者换一个人判。',
        );
        audited.ok = false;
        audited.deliverable = false;
      } else if (!pred) {
        audited.warnings.push('这次判分没有对应的盲预测：能判，但对账时学不到「标准准不准」这一层。下次先 goal_predict。');
      }

      const brief = {
        goal: contract.id,
        objective: contract.objective,
        rubric,
        bar: rubric.bar,
        must_read: [...new Set((review.dims ?? [])
          .map((d) => String(d?.quote?.file ?? '').trim())
          .filter(Boolean))],
        must_not_read: [
          `.goal/${contract.id}/predict-*.json`,
          `.goal/${contract.id}/review-*.json`,
          `.goal/${contract.id}/retro-*.json`,
          `.goal/${contract.id}/gate.json`,
          `.goal/${contract.id}/journal.jsonl`,
          `.goal/${contract.id}/proof-*.json`,
        ],
        note: '判分人只读 must_read 里的作品与 rubric。看过历史分数或预测，判断就从独立评审退化成对答案的拟合。',
        // 边界也是判据的一部分：判分人要能看见「这份东西明确不做什么、哪些要求已经被拒过」。
        non_goals: contract.non_goals ?? [],
        refusals: contract.refusals ?? [],
        provenance: contract.provenance ?? [],
        generated_at: new Date().toISOString(),
      };
      const briefFile = await saveReviewBrief(cwd, contract, brief);

      const { file } = await saveReview(cwd, contract, { ...review, audited }, { actor: 'goal_review' });
      const pass = audited.ok && audited.deliverable;
      return {
        ok: audited.ok,
        id: contract.id,
        total: Number.isFinite(audited.total) ? audited.total : 0,
        bar: rubric.bar,
        vetoes_hit: audited.vetoes_hit,
        deliverable: audited.deliverable,
        errors: audited.errors,
        warnings: audited.warnings,
        file,
        message: audited.deliverable
          ? `判分通过：${audited.total} ≥ ${rubric.bar}，无红线。${audited.warnings.length ? `（${audited.warnings.length} 条提醒）` : ''} 还差机器层与对账：调 goal_verdict 看终局，调 goal_retro 看尺子准不准。任务书在 ${briefFile.file}。`
          : `判分未通过：${audited.errors[0] ?? `总分 ${audited.total} 未达 ${rubric.bar}`}${audited.errors.length > 1 ? `（共 ${audited.errors.length} 项）` : ''}`,
      };
    },
  });

  // 6) goal_predict —— 判分之前押注（盲预测）
  ctx.tools.register({
    name: 'goal_predict',
    description:
      '判分之前押注：给 rubric 的每一维押一个分（0/4/7/10）、押一个总分区间、写清依据。落盘即封（sealed_at + 摘要），同一轮不可覆盖，判过分之后补预测会被拒收。它的用途是给「标准本身准不准」留一份对账凭据——没有预测，评审层过了 95 也只是一个数字。',
    parameters: predictParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'round', 'sealed_at', 'digest', 'errors', 'warnings', 'file', 'message'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          round: { type: 'number' },
          sealed_at: { type: 'string' },
          digest: { type: 'string', description: '预测内容摘要，对账时用它确认押注没被改过。' },
          errors: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const contract = await resolveContract(cwd, String(args.id ?? '').trim() || undefined);
      const rubric = normalizeRubric(contract.rubric) ?? null;
      if (!rubric) {
        return {
          ok: false, id: contract.id, round: 0, sealed_at: '', digest: '', errors: ['这个目标没有 rubric，没有可押的标准。'],
          warnings: [], file: '', message: '拒收：无评审层的目标不需要预测。',
        };
      }
      const pred = normalizePrediction({
        predictor: args.predictor,
        basis: args.basis,
        dims: args.dims,
        bet: args.bet,
      });
      const v = validatePrediction(pred, rubric);
      if (!v.ok) {
        return {
          ok: false, id: contract.id, round: 0, sealed_at: '', digest: '', errors: v.errors,
          warnings: v.warnings, file: '', message: `预测被拒收（${v.errors.length} 项）：${v.errors[0]}`,
        };
      }
      const sealed = sealPrediction(pred, new Date());
      try {
        const { file, round } = await savePrediction(cwd, contract, sealed);
        const risk = sealed.bet.risk_dims.length ? `，最担心 ${sealed.bet.risk_dims.join('/')}` : '';
        return {
          ok: true, id: contract.id, round, sealed_at: sealed.sealed_at, digest: sealed.digest,
          errors: [], warnings: v.warnings, file,
          message: `押注已封（第 ${round} 轮，digest ${sealed.digest}）：${sealed.dims.length} 维共押 ${scoreTotalSafe(rubric, sealed.dims)}，区间 ${sealed.bet.total_low}–${sealed.bet.total_high}${risk}。去判分，判完调 goal_retro。`,
        };
      } catch (error) {
        if (error?.code === 'PREDICT_AFTER_REVIEW') {
          return {
            ok: false, id: contract.id, round: 0, sealed_at: '', digest: '', errors: [String(error.message)],
            warnings: [], file: '', message: `拒收：${String(error.message)}`,
          };
        }
        throw error;
      }
    },
  });

  // 7) goal_retro —— 判分之后对账
  ctx.tools.register({
    name: 'goal_retro',
    description:
      '把盲预测与实际判分逐维对账：押了多少、实际多少、差多少、尺子偏高还是偏低、连续几轮同向。bias=over 表示标准把稿子想得比实际好（该收紧 criterion）；连续三轮同向＝改标准，不许再改稿。它不改分数、不改合约，只记账。',
    parameters: retroParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'round', 'bias', 'hit_rate', 'streak', 'warn_standard', 'dims', 'total', 'line', 'file', 'message'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          round: { type: 'number' },
          bias: { type: 'string', description: 'over / under / mixed / none。' },
          hit_rate: { type: ['number', 'null'] },
          streak: {
            type: 'object',
            additionalProperties: false,
            required: ['streak', 'dir', 'limit', 'warn'],
            properties: {
              streak: { type: 'number' },
              dir: { type: ['string', 'null'] },
              limit: { type: 'number' },
              warn: { type: 'boolean' },
            },
          },
          warn_standard: { type: 'boolean', description: '是否到了「该改标准而不是改稿」的时候。' },
          dims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'predicted', 'actual', 'delta', 'dir'],
              properties: {
                id: { type: 'string' },
                predicted: { type: ['number', 'null'] },
                actual: { type: ['number', 'null'] },
                delta: { type: ['number', 'null'] },
                dir: { type: 'string' },
              },
            },
          },
          total: {
            type: 'object',
            additionalProperties: false,
            required: ['predicted', 'actual', 'delta', 'in_bet'],
            properties: {
              predicted: { type: ['number', 'null'] },
              actual: { type: ['number', 'null'] },
              delta: { type: ['number', 'null'] },
              in_bet: { type: 'boolean' },
            },
          },
          line: { type: 'string' },
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const contract = await resolveContract(cwd, String(args.id ?? '').trim() || undefined);
      const rubric = normalizeRubric(contract.rubric) ?? null;
      const fail = (message) => ({
        ok: false, id: contract.id, round: 0, bias: 'none', hit_rate: null,
        streak: { streak: 0, dir: null, limit: 3, warn: false }, warn_standard: false,
        dims: [], total: { predicted: null, actual: null, delta: null, in_bet: false },
        line: '', file: '', message,
      });
      if (!rubric) return fail('这个目标没有 rubric：没有标准就没有可对账的东西。');

      const wantRound = Number(args.round) || 0;
      const preds = await listPredictions(cwd, contract.id);
      const reviewRec = await loadLatestReview(cwd, contract.id).catch(() => null);
      const pred = wantRound ? preds.find((p) => p.round === wantRound) : preds.at(-1);
      if (!pred) return fail('还没有盲预测：先在判分之前 goal_predict。判完再补预测等于照着答案押注。');
      if (!reviewRec || !reviewRec.audited) return fail(`第 ${pred.round} 轮押了注但还没有判分：先 goal_review，再来对账。`);
      if (wantRound && reviewRec.round !== wantRound && pred.round !== reviewRec.round) {
        return fail(`第 ${wantRound} 轮的预测找不到对应的第 ${wantRound} 轮判分（现有判分第 ${reviewRec.round} 轮）。`);
      }

      const result = compare(pred, reviewRec, rubric);
      const retros = await listRetros(cwd, contract.id);
      const prior = retros.filter((r) => r.round !== pred.round);
      const streak = biasStreak([...prior, { bias: result.bias }]);
      const { file } = await saveRetro(cwd, contract, { ...result, streak }, { round: pred.round, actor: 'goal_retro' });
      const line = retroLine(result);

      return {
        ok: true,
        id: contract.id,
        round: pred.round,
        bias: result.bias,
        hit_rate: result.hit_rate,
        streak,
        warn_standard: streak.warn,
        dims: result.dims.map((d) => ({ id: d.id, predicted: d.predicted, actual: d.actual, delta: d.delta, dir: d.dir })),
        total: { predicted: result.total.predicted, actual: result.total.actual, delta: result.total.delta, in_bet: result.total.in_bet },
        line,
        file,
        message: streak.warn
          ? `${line} 连续 ${streak.streak} 轮${streak.dir === 'over' ? '高估' : '低估'}——该改的是 criterion，不是继续改稿：带 rubric_change_reason 调 goal_define，旧判分会自动标 stale。`
          : `${line} 还算稳（连续 ${streak.streak} 轮同向开始触发改标准提醒）。`,
      };
    },
  });

  // 8) goal_verdict
  ctx.tools.register({
    name: 'goal_verdict',
    description:
      '读盘上最近一次机器层结果（proof）与最近一次判分（review），给唯一裁决：deliverable=true 才允许汇报完成。机器层未全绿一定不能交；有 rubric 时评审层也必须过线且无红线。会落 .goal/<id>/gate.json 留痕。',
    parameters: verdictParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['deliverable', 'gated', 'id', 'machine_green', 'total', 'bar', 'reasons', 'message', 'file'],
        properties: {
          deliverable: { type: 'boolean' },
          gated: { type: 'boolean' },
          id: { type: 'string' },
          machine_green: { type: 'boolean' },
          total: { type: ['number', 'null'] },
          bar: { type: ['number', 'null'] },
          reasons: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          file: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const contract = await resolveContract(cwd, String(args.id ?? '').trim() || undefined);
      const rubric = normalizeRubric(contract.rubric) ?? null;

      const proof = await loadLatestProof(cwd, contract.id).catch(() => null);
      const machineGreen = Boolean(proof?.summary?.green);
      const reviewRec = await loadLatestReview(cwd, contract.id).catch(() => null);
      const audited = reviewRec?.audited ?? null;

      const verdict = decide({ machineGreen, rubric, review: audited });
      if (!proof) verdict.reasons.unshift('还没有跑过 goal_check');

      // 校准提醒：不改裁决，但要在同一句里说清「尺子可能歪了」。
      const retros = await listRetros(cwd, contract.id).catch(() => []);
      const streak = biasStreak(retros);
      if (streak.warn) {
        verdict.reasons.push(
          `连续 ${streak.streak} 轮${streak.dir === 'over' ? '高估' : '低估'}：这次的具体分数没问题，但标准本身可能有偏，改 criterion 而不是继续改稿。`,
        );
      }

      const { file } = await saveGate(cwd, contract, {
        ...verdict,
        id: contract.id,
        machine_green: machineGreen,
        proof: proof ? proof.file ?? null : null,
        review: reviewRec ? reviewRec.file ?? null : null,
        bias_streak: streak,
        at: new Date().toISOString(),
      });

      if (verdict.deliverable && contract.status !== 'green') {
        await setStatus(cwd, contract.id, 'green', 'gate 放行');
      }

      return {
        deliverable: verdict.deliverable,
        gated: verdict.gated,
        id: contract.id,
        machine_green: machineGreen,
        total: verdict.total,
        bar: verdict.bar,
        reasons: verdict.reasons,
        message: `${decideLine(verdict)}（${contract.id}）`,
        file,
      };
    },
  });

  // 9) goal_doctor：一次体检全部目标，直接给出下一步该敲哪个工具
  ctx.tools.register({
    name: 'goal_doctor',
    description:
      '一次体检台账里所有目标：机器层红不红、判分有没有、判据换过没有、押注对账了没有、偏差是否连续同向、预算是否用满、代价台账与拒绝清单写没写，并把「下一步该敲哪个工具」直接给出来。不知道卡在哪，或者收工前想确认一遍，先跑它。',
    parameters: verdictParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'healthy', 'checked', 'problems', 'message'],
        properties: {
          ok: { type: 'boolean' },
          healthy: { type: 'number', description: '没有任何待处理项的目标数。' },
          checked: { type: 'number', description: '本次体检的目标总数。' },
          problems: {
            type: 'array',
            description: '每个待处理目标：flags 是问题清单，next 是下一步该敲的工具。',
            items: { type: 'object', additionalProperties: true },
          },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const only = String(args.id ?? '').trim();
      let goals = await listGoals(cwd);
      if (only) goals = goals.filter((g) => g.id === only);
      if (goals.length === 0) {
        return {
          ok: true,
          healthy: 0,
          checked: 0,
          problems: [],
          message: only ? `没有这个目标：${only}` : '台账为空：还没有目标合约。用 goal_define 建一份再开工。',
        };
      }

      const problems = [];
      let healthy = 0;
      for (const g of goals) {
        const c = await loadContract(cwd, g.id).catch(() => null);
        if (!c) continue;
        const reviewRec = await loadLatestReview(cwd, g.id).catch(() => null);
        const pred = await loadLatestPrediction(cwd, g.id).catch(() => null);
        const retros = await listRetros(cwd, g.id).catch(() => []);
        const streak = biasStreak(retros);
        const next = nextStep({
          contract: c,
          proof: { round: g.last_round ?? 0, summary: g.last_summary ?? null },
          review: reviewRec,
          pred,
          retros,
        });
        const gated = Boolean(c.rubric?.dims?.length);
        const bar = Number(c.rubric?.bar ?? 95);
        const flags = [];
        if (!gated) flags.push('只有机器层：没有 rubric，交付质量没人判');
        if (!g.last_summary) flags.push('从未跑过 goal_check');
        else if (g.last_summary.fail > 0 || g.last_summary.unknown > 0) {
          flags.push(`机器层未绿：fail ${g.last_summary.fail} / unknown ${g.last_summary.unknown}`);
        }
        if (gated && !pred && g.last_summary?.fail === 0) flags.push('还没押注：判分前先 goal_predict');
        if (gated && pred && (!retros.length || Number(retros.at(-1)?.round ?? 0) < Number(pred.round ?? 0))) {
          flags.push('押了没对账：goal_retro');
        }
        if (reviewRec?.stale) flags.push('判分已 stale：判据换过，要重判');
        const total = reviewRec?.audited?.total;
        if (gated && reviewRec && !reviewRec.stale && typeof total === 'number' && total < bar) {
          flags.push(`差 ${Math.round((bar - total) * 100) / 100} 分到合格线`);
        }
        if (streak.warn) flags.push(`连续 ${streak.streak} 轮${streak.dir === 'over' ? '高估' : '低估'}：该改的是 criterion`);
        if ((c.provenance?.length ?? 0) === 0) flags.push('没有代价台账：借鉴了谁、对方付过什么代价没写');
        if ((c.refusals?.length ?? 0) === 0) flags.push('没有拒绝清单：边界没落成文字');
        if (next.blocked) flags.push('预算已用满：该写 BLOCKED');
        if (flags.length === 0) {
          healthy += 1;
          continue;
        }
        problems.push({ id: g.id, status: g.status, objective: g.objective, flags, next });
      }

      const lines = problems.length
        ? problems.map((p) => `- ${p.id} [${p.status}] ${p.objective}\n    ${p.flags.join('；')}\n    → ${p.next.tool ? `${p.next.tool}：${p.next.why}` : p.next.why}`)
        : ['（没有待处理项）'];
      return {
        ok: true,
        healthy,
        checked: goals.length,
        problems,
        message: [
          `体检 ${goals.length} 个目标：${healthy} 个无需处理，${problems.length} 个要动。`,
          ...lines,
        ].join('\n'),
      };
    },
  });

  // 10) goal_status
  ctx.tools.register({
    name: 'goal_status',
    description:
      '看目标台账：每个目标的 objective、状态、机器层最近一轮 pass/fail/unknown、评审层总分与合格线，以及目录路径。开工前用它确认"现在差哪几条"，汇报前用它确认"到底能不能交"。',
    parameters: verdictParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'goals', 'message'],
        properties: {
          ok: { type: 'boolean' },
          goals: { type: 'array', items: { type: 'object', additionalProperties: true } },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = await resolveCwd(ctx, args.cwd, exec);
      const id = String(args.id ?? '').trim();
      if (id) {
        const c = await loadContract(cwd, id);
        const goals = (await listGoals(cwd)).filter((g) => g.id === id);
        const reviewRec = await loadLatestReview(cwd, id).catch(() => null);
        const gated = Boolean(c.rubric?.dims?.length);
        const bar = gated ? c.rubric.bar : null;
        const total = reviewRec?.audited?.total ?? null;
        const retros = await listRetros(cwd, id).catch(() => []);
        const pred = await loadLatestPrediction(cwd, id).catch(() => null);
        const streak = biasStreak(retros);
        const calib = !gated
          ? '无评审层，无需校准'
          : pred
            ? `${retros.length ? retroLine(retros.at(-1)) : '已押注未对账'}${streak.warn ? `［连续 ${streak.streak} 轮同向，该改标准］` : ''}`
            : '未押注（下一轮判分前先 goal_predict）';
        const staleCount = reviewRec?.stale ? 1 : 0;
        const next = nextStep({
          contract: c,
          proof: { round: goals[0]?.last_round ?? 0, summary: goals[0]?.last_summary ?? null },
          review: reviewRec,
          pred,
          retros,
        });
        return {
          ok: true,
          goals: [{
            ...c,
            dir: goalDir(cwd, id),
            review_dir: reviewDir(cwd, id),
            rubric_bar: bar,
            review_total: total,
            calibration: { predicted: Boolean(pred), retro_rounds: retros.length, bias: retros.at(-1)?.bias ?? null, streak },
            review_stale: Boolean(reviewRec?.stale),
            next,
            ...(goals[0] ?? {}),
          }],
          message: `${c.id}：${c.objective}（机器层 ${c.done_when.length} 条，最近一轮 ${describeProof(goals[0])}${gated ? `；评审层 ${c.rubric.dims.length} 维，合格线 ${bar}，最近判分 ${total === null ? '未判' : total}${staleCount ? '（已标 stale，判据换过）' : ''}；校准 ${calib}` : '；无评审层'}）｜下一步：${next.tool ? `${next.tool}（${next.why}）` : next.why}`,
        };
      }
      const goals = await listGoals(cwd);
      if (goals.length === 0) {
        return { ok: true, goals: [], message: '台账为空：还没有目标合约。用 goal_define 建一份再开工。' };
      }
      const lines = [];
      for (const g of goals) {
        const reviewRec = await loadLatestReview(cwd, g.id).catch(() => null);
        const gated = Boolean(g.rubric?.dims?.length);
        const reviewPart = gated
          ? `｜评审 ${reviewRec?.audited?.total ?? '未判'}/${g.rubric.bar}${reviewRec?.stale ? '（stale）' : ''}`
          : '｜无评审层';
        let calibPart = '';
        if (gated) {
          const retros = await listRetros(cwd, g.id).catch(() => []);
          const pred = await loadLatestPrediction(cwd, g.id).catch(() => null);
          calibPart = pred
            ? `｜校准 ${retros.length ? `bias=${retros.at(-1)?.bias ?? 'none'}×${retros.length}` : '已押未对账'}`
            : '｜未押注';
          const next = nextStep({
            contract: await loadContract(cwd, g.id).catch(() => ({})),
            proof: { round: g.last_round ?? 0, summary: g.last_summary ?? null },
            review: reviewRec,
            pred,
            retros,
          });
          calibPart += next.tool ? `｜→ ${next.tool}` : '｜→ 停手';
        } else {
          const next = nextStep({
            contract: await loadContract(cwd, g.id).catch(() => ({})),
            proof: { round: g.last_round ?? 0, summary: g.last_summary ?? null },
          });
          calibPart = next.tool ? `｜→ ${next.tool}` : '｜→ 停手';
        }
        lines.push(`- ${g.id} [${g.status}] ${g.objective} → ${describeProof(g)}${reviewPart}${calibPart}${g.provenance ? '' : '｜无代价台账'}`);
      }
      return {
        ok: true,
        goals,
        message: [`目标台账（${goals.length} 个）：`, ...lines].join('\n'),
      };
    },
  });
}

/** @param {object|undefined} g */
function describeProof(g) {
  if (!g || !g.last_summary) return '未检查';
  const s = g.last_summary;
  return `${s.pass}/${s.total} pass，fail ${s.fail}，unknown ${s.unknown}`;
}
