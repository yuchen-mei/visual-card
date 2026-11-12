#!/usr/bin/env node
"use strict";

// Synthetic fixtures only; never reads or decrypts portfolio data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

const pages = [["production", "index.html"], ["standalone preview", "index.preview.html"]]
  .map(([page, file]) => [page, fs.readFileSync(path.join(__dirname, "..", file), "utf8")]);
const names = ["isCashHolding", "isTradableHolding", "dayTime", "closeOnOrBefore", "sharesAt", "openingMarkPrice",
  "validateOpeningPosition", "markPrice", "normalizePublicPriceRows", "priceRowsFromMarketData", "annualPositions",
  "computeAnnualSummary", "computeGainCurve"];

function harness(html, raw, market = null) {
  const state = {raw, data: {holdings: raw.holdings, trading: []}, marketPrices: market};
  const context = vm.createContext({state, DAY_MS: 86400000});
  vm.runInContext(names.map(name => {
    const match = html.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
    assert.ok(match, name); return match[0];
  }).join("\n"), context);
  return context;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const day = date => new Date(`${date}T00:00:00`).getTime();
const dateOf = time => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// The curve value in effect at a calendar day: the last point on or before it.
const gainOn = (points, date) => points.filter(point => point.time <= day(date)).at(-1)?.gain ?? 0;

function mixed() {
  return {asOf: "2025-03-14", holdings: [{ticker: "AAA", type: "stock", value: 88}, {ticker: "CASH", type: "cash", value: 50}],
    income: [{date: "2024-06-30", amount: 3}, {date: "2025-02-28", amount: 2}],
    trading: {
      AAA: {orders: [{date: "2024-02-01", side: "buy", shares: 10, price: 10}, {date: "2024-09-03", side: "sell", shares: 4, price: 14},
        {date: "2025-01-15", side: "buy", shares: 2, price: 13}],
      prices: [{date: "2024-02-01", close: 10}, {date: "2024-06-28", close: 12}, {date: "2024-12-31", close: 15}, {date: "2025-03-14", close: 11}]},
      BBB: {orders: [{date: "2024-11-04", side: "buy", shares: 5, price: 20}, {date: "2025-02-03", side: "sell", shares: 5, price: 22}],
        prices: [{date: "2024-11-04", close: 20}, {date: "2024-12-27", close: 21}, {date: "2025-02-03", close: 22}, {date: "2025-03-14", close: 23}]}
    }};
}

function opening() {
  return {asOf: "2025-12-31", holdings: [{ticker: "DEMO", type: "stock", shares: 10, value: 150}], income: [],
    trading: {DEMO: {openingPosition: {version: 1, asOf: "2023-12-31", shares: 10}, orders: [],
      prices: [{date: "2023-12-29", close: 10}, {date: "2024-12-31", close: 12}, {date: "2025-12-31", close: 15}]}}};
}

for (const [page, html] of pages) {
  test(`${page} gain curve marks to market daily and ends at the annual total`, () => {
    const raw = freeze(mixed()), before = JSON.stringify(raw);
    const ui = harness(html, raw);
    const curve = ui.computeGainCurve();
    const points = curve.points;
    assert.equal(dateOf(points[0].time), "2024-02-01");
    assert.equal(dateOf(points.at(-1).time), "2025-03-14");
    assert.ok(points.every((point, i) => i === 0 || point.time > points[i - 1].time));
    close(points[0].gain, 0);
    close(gainOn(points, "2024-06-28"), 20);
    close(gainOn(points, "2024-06-30"), 23);
    close(points.at(-1).gain, 33);
    const annual = ui.computeAnnualSummary();
    close(annual.years.reduce((sum, year) => sum + year.pnl, 0), points.at(-1).gain);
    assert.equal(JSON.stringify(raw), before);
  });

  test(`${page} gain curve differences between year ends equal annual returns`, () => {
    const ui = harness(html, freeze(mixed()));
    const points = ui.computeGainCurve().points;
    const years = ui.computeAnnualSummary().years;
    assert.deepEqual(Array.from(years, year => year.year), [2024, 2025]);
    for (const year of years) {
      const end = year.current ? points.at(-1).gain : gainOn(points, `${year.year}-12-31`);
      close(end - gainOn(points, `${year.year - 1}-12-31`), year.pnl);
    }
    close(gainOn(points, "2024-12-31"), 54);
  });

  test(`${page} gain curve starts opening positions at their opening value`, () => {
    const ui = harness(html, freeze(opening()));
    const points = ui.computeGainCurve().points;
    assert.equal(dateOf(points[0].time), "2023-12-31");
    close(points[0].gain, 0);
    close(gainOn(points, "2024-12-31"), 20);
    close(points.at(-1).gain, 50);
    close(ui.computeAnnualSummary().years.reduce((sum, year) => sum + year.pnl, 0), 50);
  });

  test(`${page} gain curve prefers public prices and is absent without trades or income`, () => {
    const raw = freeze(mixed());
    const market = freeze({prices: {AAA: [{date: "2024-02-01", close: 10}, {date: "2025-03-14", close: 12}],
      BBB: [{date: "2024-11-04", close: 20}, {date: "2025-03-14", close: 23}]}});
    const ui = harness(html, raw, market);
    close(ui.computeGainCurve().points.at(-1).gain, 41);
    close(ui.computeAnnualSummary().years.reduce((sum, year) => sum + year.pnl, 0), 41);
    const empty = freeze({asOf: "2025-03-14", holdings: [{ticker: "CASH", type: "cash", value: 50}], income: [], trading: {}});
    assert.equal(harness(html, empty).computeGainCurve(), null);
  });
}
