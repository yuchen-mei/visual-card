# visual-card

Rendered Website: https://yuchen-mei.github.io/visual-card/

个人持仓可视化网站。投资数据以与网页兼容的密文保存，每日由管线用真实账户数据校验后更新。

## 每日更新（当前运行方式）

- 由 Ruby 每日 20:00（America/Los_Angeles）运行：从 Plaid（只读）读取 **Robinhood 券商账户（尾号 5353）+ Robinhood 储蓄账户（尾号 6507）** 的持仓、现金与交易，经仓库管线全套校验后发布。统计范围**不含任何支票账户**（含 BofA 与 Robinhood 的 checking）。
- 发布是绑定基线提交的单次提交，通常只改 `data.enc.json`，提交信息固定为 `Update encrypted portfolio data`；行情文件确有变化时才按 release 流程同批提交。
- 适配层、部署配置与调度状态不在本仓库内，由 Ruby 侧单独保管。更新契约的权威说明见 [运行说明](docs/finances-update.md)。

## 核心数据文件（backbone，格式冻结）

以下文件是每日更新长期维护的核心数据与逻辑。**任何 agent（包括做 UI 改版的）都不得改动它们的格式、字段语义或校验规则**；确需改动时，必须先跑通全套测试（JS 588 项 + Python 11 项），并保证每日管线对现有 `data.enc.json` 能做无变化重放。

| 文件 | 作用与冻结要点 |
| --- | --- |
| `data.enc.json` | 加密账本，网站的唯一数据源。信封格式 `{version, kdf: "PBKDF2-SHA256", iterations: 250000, cipher: "AES-GCM", salt, iv, ciphertext}`（base64）；明文顶层结构（`holdings`、`trading`、`tradeSync`、`positionLifecycle`、`performance`、`assetAudit`、`historySnapshot`、`assetSnapshot`、`quantityReconciliation`、`userConfirmedReturnMethod` 等）由管线整体维护。**只能由管线重写，禁止手工编辑或用其他工具重新生成**——`tradeSync` 的 id/digest 审计链绑定账户身份，断裂后每日更新会停机审查。 |
| `market.prices.json` | 行情价格数据，由 `.github/workflows/update-market-prices.yml` 与管线行情环节维护；结构由 `scripts/fetch_market_prices.py` 与 `scripts/finances_market*.cjs` 定义，不要手工改。 |
| `scripts/market_price_ranges.json` | 期初行情区间基线，是管线的哈希绑定校验对象，不要改动。 |
| `scripts/finances_*.cjs` | 管线本体：来源规范化、交易合并与审计（结算日口径）、持仓事件、收益计算（`userConfirmedReturnMethod` 的口径）、发布与日志。数据格式与不变量以这套模块为准。 |
| `docs/finances-update.md` | 更新契约的权威文档，与管线实现必须保持一致；改实现先改文档并说明理由。 |

## 网页文件（UI 可以改，但必须遵守契约）

- `index.html`、`index.preview.html` 是渲染层：版式、样式、图表都可以改版，但必须保留两条契约：
  1. 浏览器端用同一口令与信封参数（PBKDF2-SHA256、250,000 次、AES-256-GCM）解密 `data.enc.json` 的逻辑；
  2. 对明文字段的读取口径：`holdings` / `performance` / `trading` 等字段的含义与收益展示公式由管线定义，UI 只读展示，不得反过来要求管线改字段迁就页面。
- `.nojekyll` 与 `.github/workflows/update-market-prices.yml` 保持原样：GitHub Pages 发布与行情自动更新依赖它们。

## 给接手 UI 的 agent 的红线

- 不要直接编辑或重新生成 `data.enc.json`、`market.prices.json`、`scripts/market_price_ranges.json`。
- 不要为了页面效果修改 `scripts/finances_*.cjs` 的数据格式、校验规则或收益公式。
- 不要改变发布约定：每日发布是绑定基线提交的单提交；不要往 `main` 直接推送数据文件。
