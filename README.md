# dsh-goal-loop

**把「做完了」变成一件能验的事。**

一个双层闸门：**能用命令验的判据由机器 0 容忍把关，判不了好坏的质量由盲标准 + 外部判分把关**，两层都过才叫交付。**标准自己准不准，由盲预测与对账守住。**

这是 `dsh-goal-engineering`（机器层）与 `dsh-judge-loop`（评审层）合体后的下一代。前两个各自解决一半问题，也各自留了一个洞——这份插件把两个洞互相堵上。

---

## 一、为什么需要它：判断权归谁

| 时代 | 你做的事 | 判断权在谁手里 | 留下来的问题 |
|---|---|---|---|
| Prompt Engineering | 把话说漂亮 | **模型** | 说得像做完了就行 |
| Context Engineering | 把资料给全 | **模型** | 料再全，也没人验结果 |
| **Goal Engineering** | **把「要什么结果」说到可验** | **判据 + 独立判分人** | 写判据的人和干活的人还是同一个 |

第三行末尾那个洞，是 `judge-loop` 补的：**写标准的人不能是写稿的人**。所以这份插件把「验」拆成两层，并且明确规定每层由谁来做。

---

## 二、两层闸门，一张对照表

|  | 机器层（`done_when`） | 评审层（`rubric`） |
|---|---|---|
| 判什么 | 能不能跑出一条命令、命令退出码/返回值对不对 | 好不好、真不真、读的人会不会被坑 |
| 判据长什么样 | `check`：一条命令 + `expect` | 4–6 个维度、权重合计 100、`criterion` 能被外部抽查 |
| 谁判 | 机器，0 容忍 | 独立判分人（**不能是干活的人**） |
| 过线标准 | 全部 pass，**没有 unknown** | 加权总分 ≥ `bar`（默认 95）且红线一条不犯 |
| 判不了怎么办 | 报 `unknown`，**不算绿** | 报「这维判不了」，不许凑分 |
| 结果落哪 | `.goal/<id>/proof-N.json` | `.goal/<id>/review-N.json` |

**一条分歧线决定某条判据进哪层：换个人、只看这一条，能不能判真假？**
能 → 机器层。不能 → 评审层，并且写成 rubric 的一个维度。

例：
- 「`npm test` 退出码是 0」→ 机器层。
- 「README 里有一个能粘进终端跑通的安装命令」→ 半机器层：机器能验「有没有那段命令」，验不了「跑不跑得通」，所以拆成两条：机器验存在性，评审人验跑通。
- 「结论比素材硬」→ 评审层。这种只能人来判。

---

## 三、这份插件的真增量：机器去验「判分本身」

`judge-loop` 时代，判分文件（谁给了几分、引了哪句原文）是**手写的自由文本**，没人核。它可以被编：引一句不存在的原文、总分填个 100、自己给自己当 reviewer。

**`goal_review` 会在落盘前机械核五件事，任何一条不过就整份拒收：**

1. **引文逐字存在**——`quote.text` 在指定文件里必须能一字不差地找到（去空白比对，≥12 字）。转述、改标点、编一句，全部拒收。
2. **行号不漂**——引文所在行与申报的 `line` 对不上就告警（防止事后改稿还挂着旧引文）。
3. **分数算术由机器重算**——`Σ(score/10 × weight)` 与申报的 `total` 差超过 0.01 直接判 error。**手报的分不采信。**
4. **不满分必须写扣分项**——某维给 0/4/7，必须有 `deduction` 且写成「把 X 改成 Y」，否则拒收。给分不给理由等于没判。
5. **自己不能给自己盖章**——`reviewer` 为空或是 `self`/`me`/`我自己`，直接拒收。

这五条以前全靠自觉，现在全是代码。**人能编的部分变小了，人的判断才值钱。**

---

## 四、第三层：校准——尺子自己准不准

前两层验的是「东西对不对」。这一层验的是**标准对不对**。

一个偏松的 rubric 会让你连续十次报满分，而每次都很自信——分数是真的，标准是错的。这一层把「标准会不会偏」也变成可查的账。

| 步骤 | 工具 | 硬规则 |
|---|---|---|
| 判分前押注 | `goal_predict` | 每维押 0/4/7/10 + 总分区间 + 依据（≥12 字）；**落盘即封**，带 digest，改不了 |
| 判分 | `goal_review` | 押注人与判分人同名 → 当场拒收（自己押自己判等于没有校准） |
| 判完对账 | `goal_retro` | 逐维 `delta = 实际 − 押注`；`delta < 0` 是高估，`> 0` 是低估 |
| 连续 3 轮同向 | `goal_define` | 该改的是 `criterion`，不是继续改稿；改尺子必须给 `rubric_change_reason`（≥12 字） |

三条不许绕的规矩：

1. **预测 immutable**——判过分再补预测，等于照着答案押注。轮次时间戳由机器比，补的会被拒（`PREDICT_AFTER_REVIEW`）。
2. **换尺子要留理由**——改 rubric 不给理由，`goal_define` 直接拒收；删维必须解释为什么删。理由写进 `rubric-history.jsonl`，只增不改。
3. **旧分标 stale 不删**——判据改了，旧判分被标记 `stale` 并写明原因，但记录留着。删掉就等于这次偏差没发生过。

**本插件不替你重判历史样本。** 标了 stale 之后要不要重打分、能不能和新分比，由你决定；机器只保证新分不会被当成和旧分可比。

> 这套来自 `cheat-on-content` 的三条原则：盲预测不可改、升级要全量重判、尺子是工作台不是博物馆。本插件只搬了**能够机器强制的那部分**（封条、时间戳、stale 标记、换尺子理由），重打分与跨模型复核没有代做。

---

## 五、装上就能用

### 在 DSH 里（推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

装完重启 DSH 客户端，会多出：

- 常驻行为协议 `goal-loop`（不用点名，模型自己在该建合约时会建）
- 三个角色稿：`goal-professor`（只定标准，不看稿）/ `goal-tutor`（按标准做到位）/ `goal-reviewer`（独立判分）
- 7 个工具：`goal_define`、`goal_check`、`goal_predict`、`goal_review`、`goal_retro`、`goal_verdict`、`goal_status`
- 2 个命令：`/goal`、`/review`

### 不开 DSH 也能用（CLI 兜底）

```powershell
node bin/goal.mjs demo                              # 看它怎么工作（真跑，不是动画）
node bin/goal.mjs define goal.json                  # 建合约（默认读 stdin）
node bin/goal.mjs check                             # 跑机器层，落 proof
node bin/goal.mjs predict predict.json              # 判分前押注（封了不可改）
node bin/goal.mjs review review-1.json              # 提交判分，机器审计
node bin/goal.mjs retro                             # 判完对账：尺子偏高还是偏低
node bin/goal.mjs verdict                           # 终局：0=可以交 1=不许交
node bin/goal.mjs status                            # 台账总览
```

---

## 六、一份合约长什么样

纯工程任务（没有质量判断，只有能跑通/跑不通）：

```json
{
  "objective": "给 CLI 加上 --json 输出，且不破坏现有文本输出",
  "done_when": [
    { "claim": "npm test 全绿", "check": "npm test", "expect": { "kind": "exit", "value": 0 } },
    { "claim": "--json 输出能被 JSON.parse", "check": "node cli.js --json", "expect": { "kind": "matches", "value": "^\\{" } },
    { "claim": "不加 --json 时仍打印人读文本", "check": "node cli.js", "expect": { "kind": "not_contains", "value": "{" } }
  ],
  "non_goals": ["不改退出码语义"]
}
```

交付物任务（还要过评审层）——多一个 `rubric`：

```json
{
  "objective": "写一份给非技术老板看的季度复盘",
  "done_when": [
    { "claim": "文件存在且超 800 字", "check": "node -e \"const s=require('fs').readFileSync('report.md','utf8').length;process.exit(s>800?0:1)\"", "expect": { "kind": "exit", "value": 0 } }
  ],
  "rubric": {
    "topic": "季度复盘",
    "bar": 95,
    "dims": [
      {
        "id": "M1", "name": "数字可追溯", "weight": 30,
        "criterion": "report.md 里每个百分比都能指到附录第几行原始数据",
        "pass_example": "每个数字后标了（附录 A:12）",
        "fail_example": "只写「增长约三成」没有出处",
        "intent": "防的是把估数写成实测", "vision": "老板随手一抽能对上线"
      },
      { "id": "M2", "name": "可执行", "weight": 25, "criterion": "report.md 第 3 节给出下季度三条动作，每条有负责人和首周动作", "pass_example": "三条都带人名和日期", "fail_example": "只有方向没有人和时间", "intent": "防的是读完不知道明天干什么", "vision": "照着就能排下周会" },
      { "id": "M3", "name": "边界", "weight": 25, "criterion": "report.md 写明本季度没做到的两件事及原因", "pass_example": "两件失败项各带一句原因", "fail_example": "只报喜", "intent": "防的是选择性汇报", "vision": "坏消息也在里面" },
      { "id": "M4", "name": "语气", "weight": 20, "criterion": "report.md 每节首句是结论，没有铺垫段", "pass_example": "首句即结论", "fail_example": "开头两段讲背景", "intent": "防的是 AI 腔", "vision": "读两行知道结论" }
    ],
    "vetoes": [{ "id": "V1", "name": "数字编造", "why": "一个编的数字会让整份复盘不可信" }]
  },
  "non_goals": ["不做竞品分析"]
}
```

`rubric` 的硬规则（写在 `lib/rubric-core.mjs` 里，不是文档约定）：维度 4–6 个、权重 10–30 且合计正好 100、`criterion` ≥12 字且含可抽查对象（路径/行号/数字/原文片段/命令）、正反例各 ≥8 字且不能相同、至少 1 条红线且 `why` ≥10 字、合格线默认 95。

**为什么是 95 不是 100**：95 = 发出去不会被问倒；上面那 5 分花在没人看的地方。某维权重 15 从 10 掉到 7，总分 = 100 − 3×15/10 = 95.5，过线；权重 20 同样掉档 = 94，差一点。**低权重维度可以掉档，高权重不行。**

---

## 七、三个角色，三条禁令

| 角色 | 只做这件事 | 绝对不许 |
|---|---|---|
| `goal-professor` | 只看题目与素材，产出 `rubric` | 不看任何稿；不在标准里写「参考稿是这样」；不示范写法 |
| `goal-tutor` | 按标准把成品做到 95+ | 不改 rubric；不自加判据；不问「怎么写才能过」（可以问「这条防哪种稿」） |
| `goal-reviewer` | 逐维打分、逐字引文、独立判断 | 不算总分（机器算）；不与 tutor 同一人；不因「看着还行」给 10 |

一个人干三份活的时候，那份标准里会印着稿子的特征（词数区间、停顿符号、卖点后跟路径），出题人和考生是同一个人，那个 100 分是自盖章。拆开只解决这一件事。

---

## 八、红灯驱动，不是绿灯驱动

```
goal_define（不合格直接拒收，不落盘）
   ↓
goal_check（机器层：绿了才往下走；红了几条就只修这几条）
   ↓
goal_review（判分文件：机器核引文/算术/扣分项/盖章人，拒收就重判）
   ↓
goal_verdict（两层合判：机器全绿 && 评审过线 && 无红线 → 可以交）
```

规矩三条：

1. **只修红灯项。** 绿的东西别动，动了要重跑。
2. **每轮必须重跑。** 改完不跑等于没改。
3. **三轮改不动，问题在标准不在稿**——改 `criterion`，不是继续改稿。超预算写 `BLOCKED.md` 说清卡在哪维、当前几分、缺什么。

---

## 九、和前两代的关系

**从 `goal-engineering` 继承**：`done_when` 的六种 `expect`、串行执行、`unknown` 不算绿、`green = 全 pass 且无 unknown` 的唯一定义、红灯驱动循环。

**从 `judge-loop` 继承**：盲标准（写标准的人不看稿）、4–6 维权重 rubric、95 合格线、四条红线、导师自评必须带逐字引文、每轮至少删一处（只加不减会长成 AI 腔）。

**改掉的一件事**：judge-loop 早期有一道 `gate.cjs` 机械闸门，门槛设成 100 分，结果稿子永远在 96–99 打转，八版之后叫停——**完美是不可达的目标，把 100 设成闸门等于给自己造无限循环**。所以这里的机器层只验「能验的事」（引文真假、算术、扣分项存在性、盖章人是谁），**不验「够不够好」**；好由人判，线是 95。这条写在这里，是因为旧插件里 `README` 说砍了、`agents/*.md` 却还在教人跑 `gate.cjs`，四层文档自己打起来了。**这份插件的 README / SKILL / agents / CLI 四层说的是同一件事，CLI 真的存在，可以当场敲。**

---

## 十、它不管什么（诚实边界）

- **判据本身可以写歪。** 机器只保证「写下的判据被严格执行」，保证不了判据值得写。标准写得差，执行得再严也白费。校准层能告诉你「偏了」，但改不改由你决定。
- **教授和导师可能是同一个模型。** 靠「不许看稿」这一道 prompt 隔开，不是真的组织隔离。
- **`rubric` 是磁盘上的 JSON，人能改。** 改过要重判；`goal_define` 会要求给理由并留下 `rubric-history.jsonl`，但拦不住有人直接改文件。
- **过了 95 不等于真的好评。** 它只说明「按这份标准做到了 95」。
- **红线靠人识别。** 机器只能核你写进 `vetoes_hit` 的东西，不会自己发现「这句是编的」。
- **校准层不重判历史样本。** 换尺子之后旧分标 `stale`，要不要重打分是本插件刻意不做的事——它只保证新分不会被误当成与旧分可比。
- **预测可以押得敷衍。** 机器能核「有没有押、押得全不全、和实际差多少」，核不了「押的时候是不是真在想」。连续偏差会暴露敷衍，但那已经晚了三轮。

---

## 十一、目录

```
index.mjs                入口：注册 4 技能 / 7 工具 / 2 命令 / 常驻协议
skill/goal-loop.md       主协议（行为准则，模型自动遵守）
agents/professor.md      定标准的人（不看稿）
agents/tutor.md          干活的人（不改标准，判分前先押注）
agents/reviewer.md       判分的人（不算总分）
lib/goal-core.mjs        机器层纯逻辑：合约规整/校验/执行/判定
lib/rubric-core.mjs      评审层纯逻辑：rubric 校验/引文核对/分数重算/终局
lib/calibration-core.mjs 校准层纯逻辑：封预测/对账/偏差连续/换尺子刹车
lib/goal-store.mjs       机器层台账 IO
lib/review-store.mjs     评审层与校准层台账 IO
bin/goal.mjs             CLI：define/check/predict/review/retro/verdict/status/demo
test/                    74 条单测（node --test）
```

跑测试：

```powershell
node --test
```

---

## LICENSE

MIT
