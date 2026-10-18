#!/usr/bin/env node
"use strict";

// Synthetic fixtures only. This test never reads or decrypts portfolio data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).join("\n");
const functionNames = [
  "normalizeData", "isCashHolding", "normalizeCashHoldings", "isCashInterestItem",
  "normalizeCashInterestItems", "normalizePerformanceData", "normalizePerformanceItem",
  "isStockEtfPerformanceItem", "summarizeTradableHoldingPerformance", "calculateReturnPct",
  "isTradableHolding", "stableHash", "previewTradingDates", "generatePreviewTradingForHolding",
  "normalizeTradingData", "numericOrNull", "holdingGain", "holdingReturnPct",
  "dayTime", "closeOnOrBefore", "sharesAt", "markPrice", "annualPositions",
  "normalizePublicPriceRows", "computeAnnualSummary", "renderRanking"
];

function extractFunction(name) {
  const pattern = new RegExp(`^    function ${name}\\([^]*?^    }`, "m");
  const match = script.match(pattern);
  assert.ok(match, `Missing function ${name} in index.html`);
  return match[0];
}

const rankList = {
  rows: [],
  set innerHTML(value) { this.rows = []; },
  appendChild(row) { this.rows.push(row); }
};
const context = vm.createContext({
  state: { raw: null, data: null, marketPrices: null },
  DAY_MS: 86400000,
  $: (id) => { assert.equal(id, "rankList"); return rankList; },
  document: { createElement: () => ({ className: "", innerHTML: "" }) },
  escapeHtml: (value) => String(value || ""),
  formatCurrency: (value) => `$${Number(value).toFixed(2)}`,
  formatSignedCurrency: (value) => `$${Number(value).toFixed(2)}`,
  formatSignedPct: (value) => `${Number(value).toFixed(2)}%`
});
vm.runInContext(functionNames.map(extractFunction).join("\n\n"), context, {
  filename: "index.html:cash-normalization"
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const sum = (items, field) => items.reduce((total, item) => total + Number(item[field]), 0);
function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function holdingsFixture() {
  return [
    { ticker: "CD", nameZh: "示例银行定期存款", type: "cd", value: 1050, costBasis: 1000 },
    { ticker: "SWEEP", nameZh: "示例券商现金", type: "cash sweep", value: "2010", costBasis: 2000 },
    { ticker: "CHECK", nameZh: "示例活期账户", type: "checking", value: 3030 },
    { ticker: "SAVE", nameZh: "示例储蓄账户", type: "savings", value: 4040 },
    { ticker: "EXAMPLE", nameZh: "示例股票", type: "equity", value: 1200, costBasis: 1000 }
  ];
}

function performanceFixture() {
  return {
    totalGain: 362,
    totalPrincipal: 10968,
    totalCurrentValue: 11330,
    totalReturnPct: 3.3,
    items: [
      { label: "股票 / ETF", principal: 1000, currentValue: 1227, gain: 227 },
      { label: "示例银行 CD", principal: 1000, currentValue: 1050, gain: 50 },
      { label: "cash sweep interest", gain: 10 },
      { label: "Checking 利息", gain: 30 },
      { label: "Savings interest", gain: 40 },
      { label: "股票已实现收益", gain: 20 },
      { label: "股息", gain: 5 }
    ]
  };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test("cash balances merge without adding interest or changing assets", () => {
  const source = holdingsFixture();
  const normalized = context.normalizeCashHoldings(source);
  assert.equal(normalized.length, 2);
  assert.deepEqual(plain(normalized[0]), { ticker: "CASH", nameZh: "现金", type: "cash", value: 10130 });
  assert.equal(sum(normalized, "value"), sum(source, "value"));
  assert.deepEqual(plain(normalized[1]), source[4]);
  assert.equal(Object.hasOwn(normalized[0], "costBasis"), false);
});

test("explicit deposit and sweep interest becomes one cash-interest item", () => {
  const normalized = context.normalizeCashInterestItems(performanceFixture().items);
  const cash = normalized.filter((item) => item.kind === "cash_interest");
  assert.equal(cash.length, 1);
  assert.equal(cash[0].label, "现金利息");
  assert.equal(cash[0].gain, 130);
  assert.equal(cash[0].gainOnly, true);
  assert.equal(cash[0].returnPct, null);
  assert.equal(sum(normalized, "gain"), sum(performanceFixture().items, "gain"));
  assert.equal(normalized.some((item) => /CD|Checking|Savings|sweep/.test(item.label)), false);
});

test("realized stock gains and dividends are not classified as cash interest", () => {
  for (const label of ["股票已实现收益", "ETF realized gains", "股息", "dividend income", "利息及已止盈收益", "债券利息", "margin interest", "贷款利息"]) {
    assert.equal(context.isCashInterestItem({ label }), false, label);
  }
  const normalized = context.normalizeCashInterestItems(performanceFixture().items);
  assert.equal(normalized.find((item) => item.label === "股票已实现收益").gain, 20);
  assert.equal(normalized.find((item) => item.label === "股息").gain, 5);
});

test("explicit income kinds take precedence over legacy label guesses", () => {
  assert.equal(context.isCashInterestItem({ kind: "cash_interest", label: "账户收入" }), true);
  for (const kind of ["realized_gain", "dividend", "other_income", "bond_interest"]) {
    assert.equal(context.isCashInterestItem({ kind, label: "利息" }), false, kind);
  }
});

test("unattributed residual stays separate from cash interest", () => {
  const perf = context.normalizePerformanceData(performanceFixture(), holdingsFixture());
  assert.equal(perf.items.find((item) => item.label === "股票 / ETF 浮盈").gain, 200);
  assert.equal(perf.items.find((item) => item.kind === "cash_interest").gain, 130);
  const residual = perf.items.find((item) => item.kind === "other_income");
  assert.equal(residual.label, "其他收益");
  assert.equal(residual.gain, 7);
  assert.equal(residual.gainOnly, true);
  assert.equal(residual.returnPct, null);
  assert.equal(sum(perf.items, "gain"), perf.totalGain);
});

test("stock summary selection does not overwrite an earlier realized-gain item", () => {
  const fixture = performanceFixture();
  const realized = fixture.items.splice(5, 1)[0];
  fixture.items.unshift(realized);
  const perf = context.normalizePerformanceData(fixture, holdingsFixture());
  assert.equal(perf.items.find((item) => item.label === "股票已实现收益")?.gain, 20);
  assert.equal(perf.items.find((item) => item.label === "股票 / ETF 浮盈")?.gain, 200);
  assert.equal(perf.items.find((item) => item.kind === "other_income")?.gain, 7);
});

test("legacy mixed income is preserved as other income without invented allocation", () => {
  const source = {
    totalGain: 280,
    items: [
      { label: "股票 / ETF 浮盈", gain: 200 },
      { label: "CD 利息", gain: 50 },
      { label: "利息及已止盈收益", gain: 30, principal: 1000, returnPct: 3 }
    ]
  };
  const perf = context.normalizePerformanceData(source, holdingsFixture());
  assert.equal(perf.items.length, 3);
  assert.equal(perf.items.find((item) => item.kind === "cash_interest").gain, 50);
  assert.equal(perf.items.find((item) => item.kind === "other_income").gain, 30);
  assert.equal(sum(perf.items, "gain"), source.totalGain);
});

test("negative residual is retained and is not reclassified as negative cash interest", () => {
  const source = performanceFixture();
  source.totalGain = 345;
  const perf = context.normalizePerformanceData(source, holdingsFixture());
  assert.equal(perf.items.find((item) => item.kind === "other_income").gain, -10);
  assert.equal(perf.items.find((item) => item.kind === "cash_interest").gain, 130);
  assert.equal(sum(perf.items, "gain"), source.totalGain);
});

test("normalization is idempotent and does not mutate frozen source data", () => {
  const source = freezeDeep({
    asOf: "2026-06-30", holdings: holdingsFixture(), performance: performanceFixture(),
    income: [{ date: "2025-01-15", amount: 10 }]
  });
  const before = JSON.stringify(source);
  const once = context.normalizeData(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(plain(context.normalizeCashHoldings(once.holdings)).map(({ weight, ...item }) => item),
    plain(once.holdings).map(({ weight, ...item }) => item));
  assert.deepEqual(plain(context.normalizePerformanceData(once.performance, once.holdings)), plain(once.performance));
  assert.equal(once.equityValue, 11330);
  assert.ok(Math.abs(sum(once.holdings, "weight") - 100) < 1e-10);
  assert.equal(once.holdings.some((item) => item === source.holdings[4]), false);
});

test("dated income does not increase already recorded balance or cumulative gain", () => {
  const source = {
    asOf: "2026-06-30", holdings: holdingsFixture(), performance: performanceFixture(),
    income: [{ date: "2025-05-10", amount: 50 }, { date: "2026-03-10", amount: 80 }]
  };
  const withIncome = context.normalizeData(source);
  const withoutIncome = context.normalizeData({ ...source, income: [] });
  assert.deepEqual(plain(withIncome.performance), plain(withoutIncome.performance));
  assert.deepEqual(plain(withIncome.holdings), plain(withoutIncome.holdings));
  assert.equal(withIncome.equityValue, 11330);
  assert.equal(withIncome.performance.totalGain, 362);
  context.state.raw = source;
  context.state.data = withIncome;
  const annual = context.computeAnnualSummary();
  assert.deepEqual(plain(annual.years.map(({ year, income, stockPnl }) => ({ year, income, stockPnl }))), [
    { year: 2025, income: 50, stockPnl: 0 },
    { year: 2026, income: 80, stockPnl: 0 }
  ]);
  assert.equal(annual.incomeCount, 2);
});

test("cash never participates in tradable stock performance or floating-gain rankings", () => {
  const source = holdingsFixture();
  source[0].unrealizedGain = null;
  source[1].unrealizedGain = 10;
  for (const item of source.slice(0, 4)) assert.equal(context.isTradableHolding(item), false, item.ticker);
  assert.equal(context.isTradableHolding(source[4]), true);
  assert.deepEqual(plain(context.summarizeTradableHoldingPerformance(source)), {
    complete: true, currentValue: 1200, principal: 1000, gain: 200
  });
  context.state.data = { holdings: source };
  context.renderRanking();
  assert.equal(rankList.rows.length, 1);
  assert.match(rankList.rows[0].innerHTML, /EXAMPLE/);
  assert.doesNotMatch(rankList.rows[0].innerHTML, /CD|SWEEP|CHECK|SAVE/);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(`${tests.length - failures}/${tests.length} cash normalization tests passed.`);
process.exitCode = failures ? 1 : 0;
