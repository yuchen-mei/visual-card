#!/usr/bin/env node
"use strict";

// Synthetic fixtures only; never reads or decrypts portfolio data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const names = [
  "normalizeData", "isCashHolding", "normalizeCashHoldings", "isCashInterestItem",
  "normalizeCashInterestItems", "normalizePerformanceData", "normalizePerformanceItem",
  "isStockEtfPerformanceItem", "summarizeTradableHoldingPerformance", "calculateReturnPct",
  "isTradableHolding", "normalizeTradingData", "numericOrNull", "holdingGain",
  "holdingReturnPct", "dayTime", "closeOnOrBefore", "sharesAt", "markPrice", "annualPositions",
  "normalizePublicPriceRows", "priceRowsFromMarketData", "applyPublicMarketPrices", "applyMarketData",
  "currentTradingItem", "tradeTimeSpan", "priceSourceLabel", "setTradeReadout", "renderTradeSummary",
  "computeAnnualSummary", "renderAnnualSummary", "renderSummary", "renderHero"
];
const elements = new Map();
let deliverMarket = null;
let tradingRenders = 0;
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    innerHTML: "", textContent: "", hidden: false, rows: [], classList: { toggle() {} },
    appendChild(row) { this.rows.push(row); }
  });
  return elements.get(id);
}
const context = vm.createContext({
  state: { raw: null, data: null, marketPrices: null }, DAY_MS: 86400000,
  requestMarketPrices: () => ({ then(resolve) { deliverMarket = resolve; } }),
  renderTrading: () => { tradingRenders++; },
  window: { cancelAnimationFrame() {} },
  $: element, document: { createElement: () => ({ className: "", innerHTML: "" }) },
  setText: (id, text) => { element(id).textContent = text; },
  setTextNow: (el, value, format) => { el.textContent = format(value); },
  tweenText: (el, value, format) => { el.textContent = format(value); },
  finiteOrNull: value => Number.isFinite(Number(value)) ? Number(value) : null,
  formatCurrency: value => `$${Number(value).toFixed(2)}`,
  formatCurrencyFull: value => `$${Number(value).toFixed(2)}`,
  formatSignedCurrency: value => `$${Number(value).toFixed(2)}`,
  formatPct: value => `${Number(value).toFixed(1)}%`,
  formatSignedPct: value => `${Number(value).toFixed(1)}%`,
  formatChartTime: value => new Date(value).toISOString().slice(0, 10),
  formatChartDate: value => value || "",
  escapeHtml: value => String(value || "").replace(/[<>&"']/g, ""), console
});
vm.runInContext(names.map(name => {
  const match = html.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}).join("\n"), context, { filename: "index.html:snapshot-display" });
const plain = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixture() {
  const history = {
    asOf: "2024-06-30", currency: "USD",
    holdings: [
      { ticker: "EXAMPLE", nameZh: "历史名称", type: "stock", value: 120, costBasis: 100 },
      { ticker: "CASH", nameZh: "现金", type: "cash", value: 20 }
    ],
    performance: {
      totalCurrentValue: 140, totalPrincipal: 100, totalGain: 40, totalReturnPct: 40,
      items: [
        { label: "股票 / ETF 浮盈", principal: 100, currentValue: 120, gain: 20, returnPct: 20 },
        { label: "示例 CD 利息", gain: 20 }
      ]
    },
    trading: { EXAMPLE: {
      nameZh: "历史名称",
      orders: [{ date: "2024-01-10", side: "buy", shares: 1, price: 100 }],
      prices: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-28", close: 120 }]
    } }
  };
  return {
    ...plain(history), asOf: "2025-02-10",
    holdings: [
      { ticker: "EXAMPLE", nameZh: "当前名称", type: "stock", value: 280, costBasis: 100 },
      { ticker: "CASH", nameZh: "现金", type: "cash", value: 320 }
    ],
    historyStatus: { state: "preserved", asOf: "2024-06-30", reason: "incomplete_history" },
    assetSnapshot: { retrievedAt: "2025-02-10T12:30:00Z", sourceAsOf: null, sourceDateStatus: "unknown" },
    historySnapshot: history
  };
}
function activate(raw) {
  elements.clear();
  context.state.raw = raw;
  context.state.data = context.normalizeData(raw);
  context.state.marketPrices = null;
  context.state.selectedTradingTicker = context.state.data.trading[0]?.ticker || "";
  context.state.dataVersion = (context.state.dataVersion || 0) + 1;
  deliverMarket = null;
  tradingRenders = 0;
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("missing production orders and prices never invoke preview generators", () => {
  // Preview functions are deliberately absent from this VM.
  const holdings = fixture().holdings;
  assert.deepEqual(plain(context.normalizeTradingData(undefined, holdings, "2025-02-10")), []);
  assert.deepEqual(plain(context.normalizeTradingData({ EXAMPLE: { orders: [], prices: [] } }, holdings)), []);
  const prices = fixture().historySnapshot.trading.EXAMPLE.prices;
  for (const input of [{ prices }, { prices, orders: [] }]) {
    const result = context.normalizeTradingData({ EXAMPLE: input }, holdings);
    assert.equal(result.length, 1);
    assert.deepEqual(plain(result[0].orders), []);
    assert.equal(result[0].priceSource, "encrypted");
    assert.equal(result[0].prices.length, 2);
  }
  assert.deepEqual(plain(context.normalizeTradingData({EXAMPLE:{prices,orders:[{date:"2024-01-10",side:"buy",shares:1,price:100}],priceSource:"preview"}},holdings)),[]);
});

test("saved orders survive absent or single prices without a fabricated zero return", () => {
  const saved = { ticker: "EXAMPLE", nameZh: "历史名称", orders: fixture().historySnapshot.trading.EXAMPLE.orders };
  for (const prices of [undefined, [], [{ date: "2024-01-10", close: 100 }]]) {
    const raw = fixture();
    raw.historySnapshot.trading.EXAMPLE = prices === undefined ? plain(saved) : { ...plain(saved), prices };
    const before = JSON.stringify(raw);
    activate(freeze(raw));
    assert.equal(context.state.data.trading.length, 1);
    const item = context.state.data.trading[0];
    assert.deepEqual(plain(item.orders).map(({ time, ...order }) => order), saved.orders);
    assert.equal(item.prices.length, prices?.length || 0);
    assert.equal(item.returnPct, null);
    context.renderTradeSummary();
    assert.equal(element("tradeReturn").textContent, "–");
    assert.doesNotMatch(element("tradeReadoutChange").textContent, /0\.0%/);
    assert.equal(element("tradeBuyCount").textContent, "1 次");
    assert.equal(element("tradeSellCount").textContent, "0 次");
    assert.equal(JSON.stringify(raw), before);
  }
});

test("immediate and late public prices fill saved orders without changing them", () => {
  for (const late of [false, true]) {
    const raw = fixture();
    delete raw.historySnapshot.trading.EXAMPLE.prices;
    const before = JSON.stringify(raw);
    activate(freeze(raw));
    const orders = JSON.stringify(context.state.data.trading[0].orders);
    const market = freeze({ prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-28", close: 125 }] } });
    if (late) {
      context.applyMarketData(undefined);
      assert.equal(typeof deliverMarket, "function");
      assert.equal(context.state.data.trading[0].prices.length, 0);
      assert.equal(JSON.stringify(context.state.data.trading[0].orders), orders);
      deliverMarket(market);
      assert.equal(tradingRenders, 1);
    } else context.applyMarketData(market);
    assert.equal(context.state.data.trading.length, 1);
    assert.equal(context.state.data.trading[0].prices.length, 2);
    assert.equal(context.state.data.trading[0].returnPct, 25);
    assert.equal(JSON.stringify(context.state.data.trading[0].orders), orders);
    assert.equal(context.state.marketPrices, market);
    assert.equal(JSON.stringify(raw), before);
  }
});

test("preserved performance never reconciles against updated holdings", () => {
  const raw = freeze(fixture());
  const before = JSON.stringify(raw);
  activate(raw);
  const normalized = context.state.data;
  assert.equal(normalized.totalAssetValue, 600);
  assert.equal(normalized.equityValue, 280);
  assert.equal(normalized.cashValue, 320);
  for (const key of ["totalCurrentValue", "totalPrincipal", "totalGain", "totalReturnPct"]) {
    assert.equal(normalized.performance[key], raw.historySnapshot.performance[key]);
  }
  assert.equal(normalized.performance.items[0].gain, 20);
  assert.equal(normalized.performance.items.find(i => i.kind === "cash_interest").gain, 20);
  assert.equal(normalized.performance.items.find(i => i.kind === "cash_interest").label, "现金利息/已止盈收益");
  assert.equal(normalized.performance.items.some(i => i.kind === "other_income"), false);
  assert.equal(JSON.stringify(raw), before);
});

test("annual returns retain the stable algorithm over actual raw trades and public prices", () => {
  const raw = fixture();
  raw.trading.EXAMPLE.orders.push({ date: "2025-02-10", side: "buy", shares: 2, price: 500 });
  raw.income = [{ date: "2025-02-10", amount: 75 }];
  activate(freeze(raw));
  const market = { prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-30", close: 130 }, { date: "2025-02-10", close: 800 }] } };
  const tradingBefore = JSON.stringify(context.state.data.trading);
  assert.equal(context.applyPublicMarketPrices(market), 1);
  assert.notEqual(JSON.stringify(context.state.data.trading), tradingBefore);
  assert.equal(context.state.data.trading[0].prices.at(-1).close,800);
  context.state.marketPrices = market;
  const result = context.computeAnnualSummary();
  assert.deepEqual(plain(result.years.map(row => row.year)), [2024, 2025]);
  assert.equal(result.years[0].buys, 100);
  assert.equal(result.years[0].endValue, 130);
  assert.equal(result.years[0].stockPnl, 30);
  assert.equal(result.years[0].income, 0);
  assert.equal(result.years[0].pnl, 30);
  assert.ok(Math.abs(result.years[0].returnPct - 30 * 366 / 356) < 1e-9);
  assert.equal(result.years[1].startValue, 130);
  assert.equal(result.years[1].buys, 1000);
  assert.equal(result.years[1].endValue, 2400);
  assert.equal(result.years[1].stockPnl, 1270);
  assert.equal(result.years[1].income, 75);
  assert.equal(result.years[1].pnl, 1345);
  assert.ok(Math.abs(result.years[1].returnPct - 1270 / 130 * 100) < 1e-9);
  assert.equal(result.tickers.length, 1);
  assert.equal(result.latestPriceTime, context.dayTime("2025-02-10"));
  assert.equal(result.incomeCount, 1);
});

test("legacy preserved history works without an additional historySnapshot", () => {
  const raw = fixture();
  delete raw.historySnapshot;
  activate(raw);
  assert.equal(context.state.data.performance.items[0].gain, 20);
  const result = context.computeAnnualSummary();
  assert.deepEqual(plain(result.years.map(row => [row.year, row.stockPnl])), [[2024, 20], [2025, 0]]);
});

test("history status does not block public prices or add annual explanations",()=>{
  const raw=fixture();raw.historyStatus.reason="history_not_revalidated";
  activate(raw);context.state.marketPrices={prices:{EXAMPLE:[{date:"2024-01-10",close:100},{date:"2024-06-28",close:140},{date:"2025-02-10",close:900}]}};
  context.renderSummary();context.renderAnnualSummary();
  assert.doesNotMatch(element("annualNotes").innerHTML,/历史资料不完整|年度收益暂缺|未重新核验|日期未知/);
  const summary=context.computeAnnualSummary();
  assert.deepEqual(plain(summary.years.map(row=>[row.year,row.stockPnl])),[[2024,40],[2025,760]]);
  assert.equal(summary.latestPriceTime,context.dayTime("2025-02-10"));
});

test("missing historical metadata does not suppress dated trades and public prices", () => {
  const raw = fixture();
  raw.historyStatus.asOf = null;
  raw.asOf = null;
  activate(raw);
  context.state.marketPrices = { prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-28", close: 150 }] } };
  const result = context.computeAnnualSummary();
  assert.deepEqual(plain(result.years.map(row => [row.year, row.stockPnl])), [[2024, 50]]);
  assert.equal(result.latestPriceTime, context.dayTime("2024-06-28"));
  context.renderSummary();
  context.renderAnnualSummary();
  assert.equal(element("perfDate").textContent, "latest");
  assert.equal(element("meta").textContent, "latest · USD · 现金 + 股票 / ETF");
  assert.doesNotMatch(element("annualNotes").innerHTML, /日期未知|核验|年度收益暂缺/);
});

test("hero excludes cash while summary retains the stable wording", () => {
  activate(fixture());
  context.renderSummary();
  assert.equal(element("heroValue").textContent, "$280.00");
  assert.equal(element("totalCurrent").textContent, "$280.00");
  assert.equal(element("totalGain").textContent, "$40.00");
  assert.equal(element("meta").textContent, "2025-02-10 · USD · 现金 + 股票 / ETF");
  assert.equal(element("perfDate").textContent, "2025-02-10");
  assert.equal(element("totalGainSub").textContent, "本金 $100.00，当前 $280.00");
  assert.equal(element("heroDeltaValue").textContent, "$40.00 (40.0%)");
});

test("summary uses the investment principal while retaining confirmed gross capital", () => {
  const raw = fixture();
  raw.userConfirmedCapital = { principalCents: 25000, source: "user-confirmed", updatePolicy: "explicit-user-only" };
  activate(raw);
  const before = JSON.stringify(context.state.data.performance);
  const annualBefore = JSON.stringify(plain(context.computeAnnualSummary()));
  context.renderSummary();
  assert.equal(element("totalPrincipal").textContent, "$100.00");
  assert.equal(element("totalGainSub").textContent, "本金 $100.00，当前 $280.00");
  assert.equal(element("totalReturn").textContent, "40.0%");
  assert.equal(context.state.data.performance.totalPrincipal, 100);
  assert.equal(JSON.stringify(context.state.data.performance), before);
  assert.equal(JSON.stringify(plain(context.computeAnnualSummary())), annualBefore);
});

test("empty annual data retains the stable empty-state explanation", () => {
  const raw = fixture();
  raw.trading = {};
  activate(raw);
  context.renderAnnualSummary();
  assert.deepEqual(plain(context.computeAnnualSummary().years), []);
  assert.equal(element("annualNotes").innerHTML, "<div>暂无股票 / ETF 交易记录，无法计算年度收益。</div>");
  assert.doesNotMatch(element("annualTable").innerHTML, /现金利息 \/ 股息<\/td>/);
  assert.equal(element("annualYears").rows.length,0);
});

test("stable annual accounting excludes undated income without new explanations", () => {
  const raw = fixture();
  raw.income = [
    { date: "2024-06-30", amount: 20, kind: "cash_interest" },
    { date: null, amount: 7, kind: "cash_interest" },
    { amount: 11, kind: "cash_interest" }
  ];
  const before = JSON.stringify(raw);
  activate(freeze(raw));
  const result = context.computeAnnualSummary();
  assert.equal(result.years.length,2);
  assert.equal(result.years[0].stockPnl,20);
  assert.equal(result.years[0].income,20);
  assert.equal(result.years[0].pnl,40);
  assert.equal(result.years[1].income,0);
  assert.equal(context.state.raw.income.length,3);
  assert.equal(context.state.raw.income[0].amount,20);
  assert.equal(result.incomeCount, 1);
  context.renderAnnualSummary();
  assert.match(element("annualNotes").innerHTML, /已计入 1 条现金利息 \/ 股息记录。/);
  assert.doesNotMatch(element("annualNotes").innerHTML, /未含缺少入账日期|日期未知|年度收益暂缺/);
  assert.equal(JSON.stringify(raw), before);
});
test("review and correction metadata do not add non-stable annual copy",()=>{
 for (const revision of [undefined,{cumulativeGainCorrected:true,incomeDate:"2024-02-14"},{cumulativeGainCorrected:true,incomeDate:null}]) {
  const raw=fixture();raw.historyReview={state:"awaiting_dated_evidence"};
  if(revision)raw.basisRevision=revision;
  activate(raw);context.renderSummary();context.renderAnnualSummary();
  assert.equal(context.state.raw.historyReview.state,"awaiting_dated_evidence");
  assert.equal(context.computeAnnualSummary().years[0].income,0);
  assert.equal(context.computeAnnualSummary().years[0].stockPnl,20);
  assert.match(element("annualNotes").innerHTML,/现金利息和股息按实际入账日期计入年度收益。/);
  assert.doesNotMatch(element("annualNotes").innerHTML,/未含缺少入账日期|日期未知|核验/);
 }
});

test("complete legacy view and all static explanation text match the stable page", () => {
  const raw = fixture().historySnapshot;
  activate(raw);
  context.state.marketPrices = { prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-28", close: 150 }] } };
  const result = context.computeAnnualSummary();
  assert.equal(result.years[0].stockPnl, 50);
  context.renderSummary();
  assert.equal(element("meta").textContent, "2024-06-30 · USD · 现金 + 股票 / ETF");
  // Pinned from public 95f17ac:index.html; no git dependency or private fixture.
  const hash = value => createHash("sha256").update(value).digest("hex");
  const annualRenderer = html.match(/^    function renderAnnualSummary\([^]*?^    }/m)[0];
  assert.equal(hash(annualRenderer), "6a5c4ed42bef53793d1e1cb8f4ac21f66dca1e41fd812fc0a3fd855c7caa8422");
  const scriptStart = html.indexOf("  <script>");
  assert.ok(scriptStart > 0);
  assert.equal(hash(html.slice(0, scriptStart)), "a08db094245212b3be31d45a52a41cdaf29b67235cf0c640c25a7cba8ecf40c7");
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`${tests.length - failures}/${tests.length} synthetic snapshot display tests passed.`);
process.exitCode = failures ? 1 : 0;
