# CLAUDE.md

You are the owner and long-term maintainer of this codebase, and its design is up to you.

## 先读 README

- [README.md](README.md) 是项目约定的权威来源：核心数据文件冻结、网页契约、给接手 UI 的 agent 的红线。本文件只补充 README 没写的工作细节；两者冲突时以 README 为准，并顺手修正本文件。
- 每日更新契约以 [docs/finances-update.md](docs/finances-update.md) 为准；钥匙串 helper 的边界见 [docs/keychain-design.md](docs/keychain-design.md)。
- 不要尝试取得网页密码、读取钥匙串或解密真实数据。需要看真实页面时，请用户在浏览器里自己输入密码解锁。

## 测试

全套测试只用合成数据，不读真实账户或密码：

```sh
node --test scripts/test_*.cjs
python3 -m unittest discover -s scripts -p 'test_fetch_market_prices.py'
```

- 当前为 JS 589 项 + Python 11 项。数量变化时同步更新 README 里的测试数。
- `scripts/native/` 的钥匙串测试会编译原生程序，只在改动 native 代码时运行。

## 改网页时的隐藏约束

- **管线会执行 `index.html` 里的 JS。** `scripts/update_finances.cjs` 的 `browserContract` 按函数名用正则（从 `^    function 名字(` 到第一个 `^    }`）抽出一组函数（`decryptPayload`、`normalizeData`、`normalizeTradingData`、`computeAnnualSummary` 等，完整名单见该函数），放进只含这些函数的 vm 里运行。这些函数必须保持 4 空格缩进的顶层声明，且不能引用名单之外的顶层常量或函数，否则每日更新会以 `BROWSER_CONTRACT_CHANGED` 或 ReferenceError 停机。纯展示逻辑放在 `normalizeData` 之后执行（参考 `labelSecurities`）。
- **测试 harness 同样按函数名抽取**（`test_security_holdings.cjs`、`test_snapshot_display.cjs`、`test_opening_positions.cjs`）。被 `activateData`、`refreshData` 等调用的新辅助函数要自包含（常量写在函数内部），并加入对应 harness 的名单。
- **部分测试钉住了页面字节哈希**：`<script>` 之前的全部标记与样式（`test_opening_positions.cjs`、`test_snapshot_display.cjs`），以及 `normalizeTradingData`、`renderTradeList`、`renderTradeChart`、`renderAnnualSummary` 等函数。有意改动时更新哈希，并在提交说明里写明改了什么。
- `index.preview.html` 目前与 `index.html` 逐字节相同，测试会对两页分别运行。改完 `index.html` 后执行 `cp index.html index.preview.html`。
- 钥匙串 helper 构建时会把 `index.html` 的字节编入二进制。若改动了 `browserContract` 抽取的函数，要提醒部署侧（Ruby）重新构建 helper；只改展示层不影响它。

## 网站文案

- 页面面向中文读者：所有可见文字以及 `aria-label`、`title` 都用中文；ETF、ADR 等通用缩写保留英文。
- 证券中文名：管线给新开仓位的 `nameZh` 预置为代码本身（例如 `DRAM`），之后只沿用已保存的名称，不在管线里翻译。新增持仓时，在 `index.html` 的 `labelSecurities` 表里补中文名（数据里已有的中文名优先）；名称过长时，在 `holdingCenterLabel` 的 `explicit` 表里补环形图中心的短名。

## 本地预览

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

打开 <http://localhost:8765>。验证展示效果时，可以在页面控制台用合成数据调用 `activateData(data, null)`，不必解锁。

## 提交与工作区

- 开工前先 `git pull --ff-only`：管线与 GitHub Actions 会频繁往 `main` 推送 `Update encrypted portfolio data` / `Update market prices` 提交。结束时保持工作区干净。
- 提交信息用英文。
- 不要把 Claude 写成作者或共同作者：不加 `Co-Authored-By: Claude …` 之类的 trailer，也不加 “Generated with Claude Code” 署名；使用仓库现有的 git 用户。
- 数据文件只由管线发布，不要手工提交 `data.enc.json`、`market.prices.json`、`scripts/market_price_ranges.json`。

## 维护本文件

发现新的隐藏约束或约定时更新这里；README 有改动时，核对本文件是否仍与之一致。
