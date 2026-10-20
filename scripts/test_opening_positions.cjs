"use strict";

// Synthetic browser-contract tests only; no portfolio, credentials or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const {test} = require("node:test");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const functionText = name => {
  const match = html.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
  assert.ok(match, name); return match[0];
};
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return {asOf: "2025-12-31", holdings: [{ticker: "DEMO", type: "stock", nameZh: "合成证券", shares: 10, value: 150}],
    performance: {totalGain: 17}, income: [], historySnapshot: {synthetic: "unchanged"},
    trading: {DEMO: {nameZh: "合成证券", openingPosition: {version: 1, asOf: "2023-12-31", shares: 10}, orders: [],
      prices: [{date: "2023-12-29", close: 10}, {date: "2024-12-31", close: 12}, {date: "2025-12-31", close: 15}]}}};
}
function harness(raw = fixture(), market = null) {
  const state = {raw, data: {holdings: raw.holdings, trading: []}, marketPrices: market};
  const ctx = vm.createContext({state, DAY_MS: 86400000});
  const names = ["isCashHolding", "isTradableHolding", "dayTime", "closeOnOrBefore", "sharesAt", "openingMarkPrice", "validateOpeningPosition", "markPrice", "normalizePublicPriceRows", "priceRowsFromMarketData", "annualPositions", "computeAnnualSummary", "normalizeTradingData", "tradeTimeSpan"];
  vm.runInContext(names.map(functionText).join("\n"), ctx);
  state.data.trading = ctx.normalizeTradingData(raw.trading, raw.holdings, raw.asOf);
  return ctx;
}
const summaryOf = ctx => {
  const value = ctx.computeAnnualSummary();
  return clone({...value, years: value.years.map(year => ({...year, byTicker: [...year.byTicker]}))});
};
const order = (date, side, shares, price) => ({date, side, shares, price});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("opening-only securities use the following year and real prior closes without cash flows", () => {
  const raw = fixture(), before = JSON.stringify(raw), ctx = harness(raw), result = summaryOf(ctx);
  assert.deepEqual(result.years.map(year => year.year), [2024, 2025]);
  assert.deepEqual(result.years.map(year => [year.startValue, year.endValue, year.stockPnl, year.buys, year.sells, year.income, year.basis]), [[100, 120, 20, 0, 0, 0, 100], [120, 150, 30, 0, 0, 0, 120]]);
  assert.deepEqual(result.years.map(year => year.returnPct), [20, 25]);
  assert.equal(result.tickers[0].total, 50); assert.equal(JSON.stringify(raw), before);
  assert.equal(ctx.state.data.trading[0].orders.length, 0);
});
test("shares before, at and after the boundary distinguish opening from an order", () => {
  const raw = fixture(), ctx = harness(raw), item = raw.trading.DEMO;
  const opening = ctx.validateOpeningPosition(item.openingPosition, [], ctx.normalizePublicPriceRows(item.prices));
  assert.equal(ctx.sharesAt([], ctx.dayTime("2023-12-30"), opening), 0);
  assert.equal(ctx.sharesAt([], ctx.dayTime("2023-12-31"), opening), 10);
  assert.equal(ctx.sharesAt([], Infinity, opening), 10);
  assert.equal(ctx.sharesAt([], Infinity), 0);
});
test("cross-year buys and partial sells retain the existing Modified Dietz formula", () => {
  const raw = fixture(); raw.trading.DEMO.orders = [order("2024-07-01", "buy", 2, 11), order("2025-07-01", "sell", 5, 14)];
  const before = JSON.stringify(raw), ctx = harness(raw), result = summaryOf(ctx), [first, second] = result.years;
  assert.deepEqual([first.startValue, first.endValue, first.buys, first.sells, first.stockPnl], [100, 144, 22, 0, 22]);
  assert.deepEqual([second.startValue, second.endValue, second.buys, second.sells, second.stockPnl], [144, 105, 0, 70, 31]);
  close(first.basis, 111); close(first.returnPct, 22 / 111 * 100);
  close(second.basis, 144 - 70 * 183 / 365); close(second.returnPct, 31 / second.basis * 100);
  assert.equal(first.endValue, second.startValue); assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(clone(ctx.state.data.trading[0].orders).map(({time, ...rest}) => rest), raw.trading.DEMO.orders);
});
test("complete sale followed by reopening uses only real buy and sell flows", () => {
  const raw = fixture(); raw.trading.DEMO.orders = [order("2024-07-01", "sell", 10, 12), order("2025-07-01", "buy", 2, 13)];
  const result = summaryOf(harness(raw));
  assert.deepEqual(result.years.map(year => [year.startValue, year.endValue, year.buys, year.sells, year.stockPnl]), [[100, 0, 0, 120, 20], [0, 30, 26, 0, 4]]);
});
test("absent opening preserves the original annual values and zero opening is identical", () => {
  const raw = fixture(); delete raw.trading.DEMO.openingPosition;
  raw.trading.DEMO.orders = [order("2024-01-10", "buy", 1, 10)];
  const original = summaryOf(harness(raw));
  assert.deepEqual(original.years.map(year => [year.startValue, year.endValue, year.buys, year.sells, year.stockPnl]), [[0, 12, 10, 0, 2], [12, 15, 0, 0, 3]]);
  raw.trading.DEMO.openingPosition = {version: 1, asOf: "2023-12-31", shares: 0};
  assert.deepEqual(summaryOf(harness(raw)), original);
});
test("opening never changes real order count, order bytes, price chart span or price return", () => {
  const raw = fixture(); raw.trading.DEMO.orders = [order("2024-04-02", "buy", 1, 11), order("2025-04-02", "sell", 1, 14)];
  const withOpening = harness(raw), without = clone(raw); delete without.trading.DEMO.openingPosition;
  const withoutOpening = harness(without);
  assert.deepEqual(clone(withOpening.state.data.trading), clone(withoutOpening.state.data.trading));
  assert.deepEqual(clone(withOpening.tradeTimeSpan(withOpening.state.data.trading[0])), clone(withoutOpening.tradeTimeSpan(withoutOpening.state.data.trading[0])));
});
test("opening does not reclassify or duplicate dated income", () => {
  const raw = fixture(); raw.income = [{date: "2024-03-01", amount: 3, kind: "cash_interest"}];
  const before = JSON.stringify(raw), result = summaryOf(harness(raw));
  assert.deepEqual(result.years.map(year => [year.stockPnl, year.income, year.pnl]), [[20, 3, 23], [30, 0, 30]]);
  assert.equal(result.incomeCount, 1); assert.equal(JSON.stringify(raw), before);
});
test("every original order must be strictly after opening, including same-day orders", () => {
  for (const date of ["2023-12-30", "2023-12-31"]) {
    const raw = fixture(); raw.trading.DEMO.orders = [order(date, "buy", 1, 10)];
    assert.throws(() => harness(raw).computeAnnualSummary(), /OPENING_ORDER_BOUNDARY_CONFLICT/);
  }
});
test("invalid opening shape, version, boundary and shares fail rather than infer a balance", () => {
  for (const value of [null, [], {version: 2, asOf: "2023-12-31", shares: 1}, {version: 1, asOf: "2023-12-30", shares: 1}, {version: 1, asOf: "2023-13-31", shares: 1}, {version: 1, asOf: "2023-12-31", shares: -1}, {version: 1, asOf: "2023-12-31", shares: Infinity}, {version: 1, asOf: "2023-12-31", shares: "1"}, {version: 1, asOf: "2023-12-31", shares: 1, price: 10}]) {
    const raw = fixture(); raw.trading.DEMO.openingPosition = value;
    assert.throws(() => harness(raw).computeAnnualSummary(), /INVALID_OPENING_POSITION/);
  }
});
test("negative end-of-date shares fail but settlement dates do not invent intraday sequence", () => {
  const raw = fixture(); raw.trading.DEMO.orders = [order("2024-02-01", "sell", 12, 10)];
  assert.throws(() => harness(raw).computeAnnualSummary(), /NEGATIVE_OPENING_POSITION_HISTORY/);
  raw.trading.DEMO.orders.push(order("2024-02-01", "buy", 3, 10));
  assert.doesNotThrow(() => harness(raw).computeAnnualSummary());
});
test("missing or stale opening close cannot fall back to a later order price", () => {
  for (const firstDate of ["2024-01-02", "2023-12-20"]) {
    const raw = fixture(); raw.trading.DEMO.prices[0].date = firstDate; raw.trading.DEMO.orders = [order("2024-02-01", "buy", 1, 10)];
    assert.throws(() => harness(raw).computeAnnualSummary(), /OPENING_PRICE_COVERAGE_REQUIRED/);
  }
  const raw = fixture(); raw.trading.DEMO.prices[0].date = "2023-12-24";
  assert.doesNotThrow(() => harness(raw).computeAnnualSummary());
});
test("missing held year-end or latest close is rejected", () => {
  for (const index of [1, 2]) {
    const raw = fixture(); raw.trading.DEMO.prices[index].date = index === 1 ? "2024-12-20" : "2025-12-20";
    assert.throws(() => harness(raw).computeAnnualSummary(), /OPENING_PRICE_COVERAGE_REQUIRED/);
  }
});
test("public prices must themselves cover opening; a short public series cannot hide the gap", () => {
  const raw = fixture(), market = {prices: {DEMO: raw.trading.DEMO.prices.slice(1)}};
  assert.throws(() => harness(raw, market).computeAnnualSummary(), /OPENING_PRICE_COVERAGE_REQUIRED/);
  market.prices.DEMO = clone(raw.trading.DEMO.prices);
  assert.deepEqual(summaryOf(harness(raw, market)), summaryOf(harness(raw)));
});
test("an opening at the latest calculation boundary cannot invent a future annual period", () => {
  const raw = fixture(); raw.asOf = "2023-12-31"; raw.trading.DEMO.prices = [{date: "2023-12-31", close: 10}];
  assert.throws(() => harness(raw).computeAnnualSummary(), /OPENING_CALCULATION_BOUNDARY_CONFLICT/);
});
test("page markup, trading behavior and annual presentation remain byte-for-byte unchanged", () => {
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  assert.equal(hash(html.slice(0, html.indexOf("<script>"))), "ee3dee5bf9dcb54095337f7f53e218a89f1f6f4e7f9a8887c31eac71ef532f26");
  const expected = {
    normalizeTradingData: "821010fa56aacdce53e96a9a3c9411ea7b022aa4cf4b7a0a229bb64b0b1d5a5f",
    tradeTimeSpan: "6b0ecb703997d3887eaa381bcfad5d021b6264a5b72c1cff2e621c40e8d0fcb9",
    renderTradeList: "bb6519dbed01451eb74b45e47a16edc2c9b4dfb2da0a3d0fa55aaca0af7d1478",
    renderTradeChart: "4a07993aa12a1026523fadd91537d5d65790eb254e8db7dbc73dc68c5bcd0f72",
    renderTradeSummary: "0f5ef7676ce145c6f2248fffa315c0324bcd7fb36c5d7bed74305af1a51b1470",
    renderAnnualSummary: "6a5c4ed42bef53793d1e1cb8f4ac21f66dca1e41fd812fc0a3fd855c7caa8422"
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(hash(functionText(name)), value, name);
});
