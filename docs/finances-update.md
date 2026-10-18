# Finances 更新流程

本仓库提供兼容现有网页的资产更新、用户确认更正和受限发布流程。日常更新使用已连接的 Finances 与 GitHub 工具，并在用户自己的 Mac 上校验、解密和加密。Mac、应用运行环境及登录钥匙串必须可用；这不是能够脱离 Mac 独立运行的云端程序。

本文描述程序接口和部署条件，不保存实际余额、历史利息金额、账户标识或用户日期，也不作为任务已经启用、密码已经登记或发布已经成功的证明。部署方应以真实试跑回执、main 读回结果及调度状态分别确认这些动作。

当前专用钥匙串条目尚未登记，日常任务尚未启用；无人值守执行仍待部署方完成安全登记及实际接线。源码与已验证加密候选的首次发布不等同于完成这些部署步骤。

## 数据与展示规则

- 银行和券商现金余额合并展示为“现金”，不显示来源。已有现金余额已包含的利息不能再加到余额上。
- 现金利息与已止盈收益在展示层归为“现金利息/已止盈收益”。底层记录的 `kind` 和分组 `components` 保留各自类别；合并展示不能把证券已实现收益改记成利息，也不能把含义未明的其他收益断言为证券卖出。
- 本金单独保存在 `userConfirmedCapital`，来源为 `user-confirmed`，更新规则为 `explicit-user-only`。只有用户明确确认本金更正才能改变它。账户余额、内部转账、外部流量或日常快照不能自动改写这一本金。完整账本模式另保留流水核对本金及其收益率，作为独立账本指标，不覆盖用户确认值。
- 内部转账不算收益，也不自动改变用户确认本金。用户陈述的转账不能代替银行或券商余额到账证据；未确认结算时不新增现金。
- 未知的源日期、入账日期和本金生效日期保留 `null`。抓取时间不代替源日期，不把无日期金额分配到某一年度，也不以未知日期计算收益率。
- 输入缺失、覆盖不完整、账户范围变化、源数据回退、核对失败或解密失败时停止，保留现有密文。规范化业务数据（含来源依据）无变化时静默跳过，不重新加密、不 commit、不 push。

## 实际运行链

| 模块 | 职责 |
| --- | --- |
| `finances_tool_runtime.cjs` | 把已有授权工具、Mac 固定程序和私有日志 RPC 接入同一运行时；不自行创建凭据或启用任务。 |
| `finances_orchestrator.cjs` | 读取最新 main 密文基线，取得实时账户和完整持仓分页，校验独立批准的账户哈希集合，交接校验并处理发布状态。 |
| `finances_source.cjs` | 从真实工具响应生成资产快照，核实账户覆盖、分页链、现金/证券/持仓合计和源日期含义；缺失字段不猜测。 |
| `finances_transport.cjs`、`finances_daily.cjs` | 使用一次性会话的加密传输，把私有快照交给本机内存中的校验器；原始数据不进入命令参数、Git 或普通工具输出。 |
| `native/keychain_helper.m` | 受审查、签名的专用程序，从固定钥匙串条目读取密码，只运行嵌入的固定代码和已验证的固定 Node；输出仅为受约束的加密候选回执。 |
| `update_finances.cjs` | 校验模式、独立策略和密文基线，核对真实网页的展示计算，完成 Node 与网页 WebCrypto 解密回读，再产生加密候选。 |
| `finances_github.cjs` | 日常只发布变化的 `data.enc.json`；通过已有 GitHub 连接创建对象，以预期 head 的 CAS 更新 main，并读回核查。 |
| `finances_release.cjs` | 首次发布单独使用精确审阅的路径与 SHA256 清单，原子提交源码及加密候选；不能用它扩大日常数据发布范围。 |
| `finances_journal.cjs` | 仓库外的私有持久日志与全局互斥锁；只记录意图、路径、哈希、对象 ID 和阶段，不保存源码、财务数据或密码。 |
| `finances_schedule.cjs`、`finances_schedule_bridge.cjs` | 洛杉矶时间的到期计算、日幂等、离线重试及不确定结果保护，并桥接真实任务；由外部编排调用，不自行唤醒电脑。 |

日常运行从当前连接和私有配置开始，不需要历史聊天、旧工具会话或会话日志。独立批准的账户范围以哈希固定；新账户或缺失账户需要审查，不自动采用。实时原始账户 ID 仅在受控内存中用于查询与校验。

GitHub 工具连接与本地 Git 凭据是两条不同路径。实际工具运行时使用已连接的 GitHub，不向本机 Git 注入 token，也不修改 GitHub Secrets 或仓库权限。读取 main 时检查 head 前后一致，候选绑定基线原始字节的 SHA256；发布前 main 前进就停止，不自动 rebase 或强推。

## 专用钥匙串程序

在已获准的专用程序访问范围内，一次性登记由部署方完成；每日运行不再次接收或持久化密码。构建器把固定校验代码和网页校验代码嵌入原生 helper，绑定精确代码身份。条目的免提示解密 ACL 只允许该专用程序自身，不把 Node、Python、`security` 或任意应用加入受信任列表。固定 Node 只能通过 helper 验证后的匿名管道取得密码。

密码不得进入 Git、聊天、argv、普通环境变量、日志或报告。helper 不提供导出密码、任意脚本或任意命令入口；它禁用交互式取密，钥匙串锁定、身份变化或权限不足时停止。源码或固定 Node 改变后，必须重新构建、测试和审查身份，不能静默扩大旧条目的访问权限。

helper 的日常服务只接受资产模式，不能借此修改用户确认本金或执行历史更正。`basis-revision` 需通过另行明确授权的受控校验入口处理。构建与预检不登记密码；登记入口只创建，不覆盖既有条目。

“仅此程序可免提示读取”不代表钥匙串主人失去另行授权其他程序的能力。完整实现边界、构建及受控登记说明见 [专用程序设计](keychain-design.md)。原生合成测试使用禁用真实登记入口的测试构建，不接触真实钥匙串密码。

## 校验模式

所有金额输入使用安全整数美分。独立私有策略必须由已确认的范围或事实产生，不能把待校验快照的计算结果复制成“独立核对”依据。完整字段约束由 [固定校验器](../scripts/update_finances.cjs) 和各模式合成测试定义。

### 日常资产模式

`schemaVersion: 2`、`mode: "assets"`、`source: "Finances"` 更新当前全部目标账户的现金与持仓。账户覆盖和全部分页必须完整；逐账户现金、证券、总额以及持仓市值必须一致，并与独立来源的总资产和总现金核对。

`fetchedAt` 必须在允许的新鲜度范围内。真实源日期已知时保留并检查其新鲜度和防倒退基线；明确未知时同时记录 `updatedAt: null` 与 `sourceDateStatus: "unknown"`。查询、记录修改或同步时间不能替代余额源日期。`assetSnapshot` 分别保存抓取时间与源日期，审计字段保留逐账户和逐持仓的时间依据。

资产模式保留原 `performance`、`trading`、`income`、用户确认本金和历史上下文，不把当前资产变化转成历史收益。成本缺失时不推测成本或浮盈。历史交易不足时年度收益显示暂缺；公开行情刷新也不能补造年度结果。

### 用户确认的本金与累计利息更正

`schemaVersion: 2`、`mode: "basis-revision"`、`source: "user-confirmed"` 接受与独立策略完全相同的更正：

```ts
type BasisRevision = {
  capital: {
    principalCents: number;
    principalIncreaseCents?: number;
    scope: "brokerage";
    effectiveDate: null;
  };
  cashInterestReplacement?: {
    itemIndex: number;
    expectedPreviousCents: number;
    replacementCents: number;
    incomeDate: null;
  };
};
```

本金存为独立用户确认值。可选利息更正先核实指定旧项目确为现金利息及旧金额相符，再以新金额**替换**该项目；累计收益仅按“新金额减旧金额”调整，因此旧利息不会再加一次。未知入账日期保持 `null`，不新增有日期的 `income`、交易或余额；累计收益率设为不可用，不使用不同日期的资产或本金充当分母。

更正保留原始历史快照，记录请求摘要，并让相同请求重复运行保持不变。已有本金时，若提供增加额，必须与新旧本金之差一致。更正可取代较早的待核验利息说明，旧说明进入加密审计；之后不能重新把被取代的说明作为额外收入附加。

### 独立历史核验

`mode: "history-review"` 只记录已确认的旧计入金额、到期总额及尚未分配的差额。它保留资产和收益，未知日期继续为 `null`，差额不自动计入收入或年度。该模式与明确授权的 `basis-revision` 是不同操作；不能把“仅记录待核验差额”误写成禁止用户更正累计利息。

### 完整历史重建

`schemaVersion: 1` 另需成立以来完整交易、逐笔利息、持仓成本、可信源时间、真实价格及独立累计和年度核对。内部转账必须跨账户成对、金额相反；现金账本、股数及成本都需复原。未支持的公司行动或缺失记录会停止重建。

历史利息通过独立私有策略和既有项目映射核对，在带日期的账本中只计一次，不能把历史总额作为额外加项。未知日期会阻止需要该日期的年度重建，但不阻止已具备证据的资产更新或明确用户更正。账本净入出金用于完整账本的恒等式检查；它不覆盖 `userConfirmedCapital`，后者仍只接受用户明确更新。

年度股票收益使用网页既有的市值变化与净买卖计算，带真实日期的利息及股息才进入对应年度。校验器执行真实 `index.html` 计算，并检查公开行情优先加载后的结果；缺少依据或出现无法解释的差额就停止。

## 加密与发布

保留现有 version 1 envelope：PBKDF2-SHA256、AES-256-GCM、随机 salt/IV 及认证标签；沿用既有迭代次数。只有规范化业务数据（含来源依据）真实变化且余额、累计/年度规则及加密往返全部通过时才生成新密文。仅抓取时间或无关顺序变化不触发重新加密；真实源日期或审计依据变化可以触发更新，即使金额不变。

每日 `publishData` 默认 dry-run，显式发布时也只允许 `data.enc.json`。首次 `publishRelease` 同样默认 dry-run，必须另外提交精确审阅的候选路径与 SHA256 清单。允许的源码范围为指定根文件、`docs/*.md`、`scripts/*.{cjs,py}`、`scripts/native/*.{swift,py,c,m,cjs}`；不允许二进制、明文数据、凭据文件或任意新路径。路径限制不能代替源码隐私审查。

所有 GitHub 写入前先持久保存意图，取得对象 ID 后保存回执；核实新树仅包含获准变化、提交只有预期父提交，才以 CAS 更新 main。对象创建或 ref 更新结果不明时停止并按日志读回核查，不盲目重放。回读确认已发布的操作保持幂等，即使 main 后来继续前进。私有日志目录在仓库外，权限 `0700`；状态文件为 `0600`，与日常和首次发布共用全局锁。

## 本地手动入口与验证清单

工具运行时是日常接线入口；以下保留为受控本地校验与恢复接口。需要 Node.js，Git 包装入口另需 Git；隐藏输入助手需 Python。脚本不安装依赖。文件模式要求私有快照和独立策略均位于仓库及 Git 目录之外，属于当前用户、限制为当前用户读写，且各不超过 16 MiB。以下只使用占位路径。

```sh
python3 scripts/with_finances_password.py validate --input /private/snapshot.json --policy /private/policy.json
node scripts/update_finances.cjs --input /private/snapshot.json --policy /private/policy.json
node scripts/run_finances_update.cjs --input /private/snapshot.json --policy /private/policy.json
```

直接 Node 入口需要调用者安全打开已有密码描述符，由 `VISUAL_CARD_PASSWORD_FD` 仅传编号；密码本身不能放入环境变量。`update_finances.cjs` 默认只验证，`--write` 只在通过后原子替换本地密文，不发布。

`run_finances_update.cjs` 要求干净 main、准确的本仓库 HTTPS origin、无本地未推送提交，先 fetch/fast-forward，再执行固定的全部独立 Node 合成测试和校验。只有显式 `--publish` 才能提交并 push 已验证、确实变化的单个密文文件。它不会提交源码、安装依赖、配置凭据或创建任务；它使用的本地 Git 认证必须另行具备，不从 GitHub connector 借取凭据。

固定测试清单在 `run_finances_update.cjs` 中维护，覆盖展示归类、资产与历史、用户更正、来源分页、传输与工具接线、日志、每日/首次发布、调度及本地 Git 保护。其中 `test_security_holdings.cjs` 核对证券列表、权重和选择状态仅使用证券，现金单独汇总且只计入总资产一次。可逐项用 `node scripts/test_*.cjs` 中的具体文件名运行；不要把 shell 通配符展开成同一个 Node 命令的参数列表。测试使用合成数据或模拟连接，不把成功解释为真实发布或任务启用。

原生部署测试单独执行：`python3 scripts/native/test_keychain_preflight.py` 构建无密码预检程序；`node scripts/native/test_keychain_helper.cjs <TEST_ONLY_HELPER_PATH>` 只接受独立的测试构建。它们需要 Mac 编译/签名环境，helper 测试需要先按设计说明构建测试专用程序，因此不在每次日常更新中重新编译运行。

## 调度接线与恢复

目标时刻是每天 `America/Los_Angeles` 的 20:00，遵循夏令时。外部部署方负责接线并确认启用；仓库中的状态机、桥接与 runtime API 本身不创建任务。只读推演入口为：

```sh
node scripts/finances_schedule.cjs --plan --not-before '<APPROVED_START_ISO>'
node scripts/finances_schedule.cjs --check --not-before '<APPROVED_START_ISO>' --state /private/visual-card/schedule.json
```

首次批准的 `notBefore` 必须带时区并持久固定，不补跑启用前的任务。`tick` 在调用真实任务前保存 `pending` 并持有互斥锁，使用洛杉矶日期幂等键；离线多天只合并到最新到期日，不逐日重放。调度桥接自身不发布；实际 runtime 的 `runScheduled` 按部署方批准的配置调用日常数据发布，只有 `published` 或 `unchanged` 才结束当天，dry-run 不能充当完成回执。桥接协议与独立测试见 [调度接线说明](finances-schedule-bridge.md)。

离线或已确认无不确定写入的安全失败计划五分钟后重试，但状态机不会自己唤醒。Mac 关机时本地代码无法运行；持续探测需已部署的外部编排，或等待电脑恢复运行后检查。不能把计算出的下次检查时间说成已经安装了五分钟定时器。

异常、未知结果或提交/推送状态不明保留 `pending` 并要求恢复，旧锁不自动抢占。只有相同幂等键、明确 `retryable` 且 `safeToRetry: true` 的结果才可普通重试。部署方负责故障通知，通知只包含阶段、固定错误码和必要的公开提交状态，不包含金额、账户、密码或私有原始响应。
