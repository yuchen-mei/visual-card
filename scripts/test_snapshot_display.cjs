#!/usr/bin/env node
"use strict";

// Synthetic fixtures only; never reads or decrypts portfolio data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const names = [
  "normalizeData", "isCashHolding", "normalizeCashHoldings", "isCashInterestItem",
  "normalizeCashInterestItems", "normalizePerformanceData", "normalizePerformanceItem",
  "isStockEtfPerformanceItem", "summarizeTradableHoldingPerformance", "calculateReturnPct",
  "isTradableHolding", "normalizeTradingData", "numericOrNull", "holdingGain",
  "holdingReturnPct", "dayTime", "closeOnOrBefore", "sharesAt", "markPrice", "annualPositions",
  "normalizePublicPriceRows", "priceRowsFromMarketData", "applyPublicMarketPrices",
  "computeAnnualSummary", "renderAnnualSummary", "renderSummary", "renderHero"
];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    innerHTML: "", textContent: "", hidden: false, rows: [], classList: { toggle() {} },
    appendChild(row) { this.rows.push(row); }
  });
  return elements.get(id);
}
const context = vm.createContext({
  state: { raw: null, data: null, marketPrices: null }, DAY_MS: 86400000,
  $: element, document: { createElement: () => ({ className: "", innerHTML: "" }) },
  setText: (id, text) => { element(id).textContent = text; },
  finiteOrNull: value => Number.isFinite(Number(value)) ? Number(value) : null,
  formatCurrency: value => `$${Number(value).toFixed(2)}`,
  formatSignedCurrency: value => `$${Number(value).toFixed(2)}`,
  formatPct: value => `${Number(value).toFixed(1)}%`,
  formatSignedPct: value => `${Number(value).toFixed(1)}%`,
  formatChartTime: value => new Date(value).toISOString().slice(0, 10),
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
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("missing production orders and prices never invoke preview generators", () => {
  // Preview functions are deliberately absent from this VM.
  const holdings = fixture().holdings;
  assert.deepEqual(plain(context.normalizeTradingData(undefined, holdings, "2025-02-10")), []);
  assert.deepEqual(plain(context.normalizeTradingData({ EXAMPLE: { orders: [], prices: [] } }, holdings)), []);
  assert.deepEqual(plain(context.normalizeTradingData({ EXAMPLE: { orders: [{ date: "2024-01-10", side: "buy", shares: 1, price: 100 }], prices: [] } }, holdings)), []);
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

test("incomplete annual history stays unavailable despite current public quotes", () => {
  const raw = fixture();
  raw.historySnapshot.trading.EXAMPLE.prices.push({ date: "2025-02-10", close: 900 });
  raw.historySnapshot.trading.EXAMPLE.orders.push({ date: "2025-02-10", side: "buy", shares: 99, price: 900 });
  raw.historySnapshot.income = [{ date: "2025-02-10", amount: 75 }];
  activate(freeze(raw));
  const market = { prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2025-02-10", close: 800 }] } };
  const tradingBefore = JSON.stringify(context.state.data.trading);
  assert.equal(context.applyPublicMarketPrices(market), 0);
  assert.equal(JSON.stringify(context.state.data.trading), tradingBefore);
  context.state.marketPrices = market;
  const result = context.computeAnnualSummary();
  assert.deepEqual(plain(result.years), []);
  assert.deepEqual(plain(result.tickers), []);
  assert.equal(result.annualUnavailable,true);
  assert.equal(result.historyAsOf, "2024-06-30");
  assert.equal(result.incomeMissing, false);
});

test("legacy preserved history works without an additional historySnapshot", () => {
  const raw = fixture();
  delete raw.historySnapshot;
  activate(raw);
  assert.equal(context.state.data.performance.items[0].gain, 20);
  assert.deepEqual(plain(context.computeAnnualSummary().years), []);
  assert.equal(context.computeAnnualSummary().annualUnavailable,true);
});

test("unknown historical cutoff does not invent an annual date", () => {
  const raw = fixture();
  raw.historyStatus.asOf = null;
  activate(raw);
  assert.deepEqual(plain(context.computeAnnualSummary().years), []);
  assert.equal(context.computeAnnualSummary().historyAsOf, null);
});

test("current asset and historical performance dates remain visibly separate", () => {
  activate(fixture());
  context.renderSummary();
  assert.equal(element("heroValue").textContent, "$600.00");
  assert.equal(element("totalCurrent").textContent, "$140.00");
  assert.equal(element("totalGain").textContent, "$40.00");
  assert.match(element("meta").textContent, /余额来源日期未知/);
  assert.match(element("meta").textContent, /获取于 2025-02-10T12:30:00Z/);
  assert.doesNotMatch(element("meta").textContent, /余额截至 2025/);
  assert.equal(element("perfDate").textContent, "2024-06-30");
  assert.equal(element("performanceValueLabel").textContent, "历史展示资产");
  assert.equal(element("historyNotice").hidden, false);
  assert.match(element("historyNotice").textContent, /2024-06-30/);
  assert.match(element("heroDeltaLabel").textContent, /历史累计收益.*2024-06-30/);
});

test("known source date uses the actual source date, not retrieval time", () => {
  const raw = fixture();
  raw.assetSnapshot = { sourceDateStatus: "known", sourceAsOf: "2025-02-07", retrievedAt: "2025-02-10T12:30:00Z" };
  activate(raw);
  context.renderSummary();
  assert.match(element("meta").textContent, /余额截至 2025-02-07/);
});

test("missing dated income is explicitly missing rather than zero", () => {
  activate(fixture());
  context.renderAnnualSummary();
  assert.match(element("annualNotes").innerHTML, /入账日期.*记录缺失/);
  assert.match(element("annualNotes").innerHTML, /不代表收入为零/);
  assert.match(element("annualNotes").innerHTML, /保留截至 2024-06-30/);
  assert.doesNotMatch(element("annualTable").innerHTML, /现金利息 \/ 股息<\/td>/);
  assert.equal(element("annualYears").rows.length,0);
  assert.match(element("annualNotes").innerHTML,/年度收益暂缺/);
  assert.doesNotMatch(element("annualNotes").innerHTML,/暂无股票/);
});

test("present dated historical income is retained without calculating incomplete annual returns", () => {
  const raw = fixture();
  raw.historySnapshot.income = [{ date: "2024-02-14", amount: 20, kind: "cash_interest" }];
  activate(raw);
  const result = context.computeAnnualSummary();
  assert.deepEqual(plain(result.years),[]);
  assert.equal(context.state.raw.historySnapshot.income.length,1);
  assert.equal(context.state.raw.historySnapshot.income[0].amount,20);
  assert.equal(result.incomeCount, 1);
  assert.equal(result.incomeMissing, false);
});
test("undated cash interest adjustment is visibly excluded without revealing source",()=>{
 const raw=fixture();raw.historyReview={state:"awaiting_dated_evidence"};activate(raw);context.renderSummary();
 assert.match(element("historyNotice").textContent,/待确认日期的现金利息调整，尚未计入收益/);
 assert.doesNotMatch(element("historyNotice").textContent,/CD|银行|broker/);
});

test("complete legacy view retains its public-price behavior", () => {
  const raw = fixture().historySnapshot;
  activate(raw);
  context.state.marketPrices = { prices: { EXAMPLE: [{ date: "2024-01-10", close: 100 }, { date: "2024-06-28", close: 150 }] } };
  const result = context.computeAnnualSummary();
  assert.equal(result.years[0].stockPnl, 50);
  assert.equal(result.historyPreserved, false);
  context.renderSummary();
  assert.equal(element("historyNotice").hidden, true);
  assert.equal(element("heroDeltaLabel").textContent, "累计收益");
});

let failures = 0;
for (const { name, run } of tests) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`${tests.length - failures}/${tests.length} synthetic snapshot display tests passed.`);
process.exitCode = failures ? 1 : 0;
