#!/usr/bin/env node
"use strict";

// Invented accounts, balances and credentials only. No portfolio file is read.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");
const U = require("./update_finances.cjs");
// Reuse the independently reconciled full-ledger fixture and its existing tests.
const full = require("./test_finances_update.cjs");
const {html, now} = full;
const copy = value => JSON.parse(JSON.stringify(value));
const policy = {accountIds: ["synthetic-return-broker", "synthetic-return-bank"]};
const password = "synthetic-return-method-test-only";

function previous() {
  return {
    asOf: "2026-10-18", currency: "USD",
    holdings: [
      {ticker: "CASH", type: "cash", value: 800},
      {ticker: "DEMO", nameZh: "合成证券", type: "stock", shares: 10, value: 880, costBasis: 800}
    ],
    performance: {
      totalCurrentValue: 880, totalPrincipal: 750, totalGain: 130, totalReturnPct: 130 / 750 * 100,
      items: [
        {label: "股票 / ETF 浮盈", principal: 800, currentValue: 880, gain: 80, returnPct: 10},
        {label: "现金利息/已止盈收益", kind: "cash_income_group", gainOnly: true, gain: 50}
      ]
    },
    trading: {DEMO: {
      nameZh: "合成证券",
      orders: [{date: "2025-01-02", side: "buy", shares: 10, price: 80}],
      prices: [{date: "2025-01-02", close: 80}, {date: "2025-12-31", close: 85}, {date: "2026-10-16", close: 88}]
    }},
    income: [{date: "2025-06-30", amount: 3, kind: "cash_interest"}, {date: null, amount: 20, kind: "cash_interest"}],
    userConfirmedCapital: {
      principalCents: 100000, scope: "brokerage", effectiveDate: null,
      source: "user-confirmed", updatePolicy: "explicit-user-only"
    },
    userConfirmedReturnMethod: {
      version: 1, method: "principal-minus-buying-power", source: "user-confirmed",
      sourceMessageId: "synthetic-return-confirmation", totalPrincipalCents: 100000,
      providerCashCents: 20000, buyingPowerSupplementCents: 5000,
      supplementState: "not-reflected-in-provider-snapshot", effectiveBuyingPowerCents: 25000,
      investedPrincipalCents: 75000, holdingCostBasisCents: 80000, unrealizedGainCents: 8000,
      nonHoldingIncomeCents: 5000, confirmedCdInterestIncludedCents: 2000,
      classification: "user-approved-approximation", incomeDatesInvented: false
    }
  };
}
function snapshot() {
  const proof = {complete: true, allPagesFetched: true, sourceDateStatus: "unknown", updatedAt: null};
  return {
    schemaVersion: 2, mode: "assets", source: "Finances", currency: "USD", fetchedAt: "2026-10-18T02:00:00Z",
    coverage: {accountsComplete: true, allPagesFetched: true, accountIds: copy(policy.accountIds)},
    accounts: [
      {id: policy.accountIds[0], type: "brokerage", currency: "USD", cashCents: 20000, securitiesCents: 90000, totalCents: 110000, coverage: {balances: copy(proof), holdings: copy(proof)}},
      {id: policy.accountIds[1], type: "checking", currency: "USD", cashCents: 60000, securitiesCents: 0, totalCents: 60000, coverage: {balances: copy(proof), holdings: copy(proof)}}
    ],
    positions: [{accountId: policy.accountIds[0], ticker: "DEMO", type: "stock", shares: 10, valueCents: 90000, costBasisCents: 80000, priceAsOf: "2026-10-17"}],
    reconciliation: {independentSourceTotals: true, totalValueCents: 170000, cashCents: 80000}
  };
}
const build = (s = snapshot(), old = previous()) => U.buildAssetPayload(s, old, {html, now, policy});
function changeCash(s, index, delta) {
  s.accounts[index].cashCents += delta;
  s.accounts[index].totalCents += delta;
  s.reconciliation.cashCents += delta;
  s.reconciliation.totalValueCents += delta;
}
function changeValue(s, delta) {
  s.positions[0].valueCents += delta;
  s.accounts[0].securitiesCents += delta;
  s.accounts[0].totalCents += delta;
  s.reconciliation.totalValueCents += delta;
}
function annual(data) {
  const ui = U.browserContract(html);
  ui.state.raw = copy(data); ui.state.data = ui.normalizeData(copy(data));
  return copy(ui.computeAnnualSummary());
}

test("confirmed return uses securities minus invested principal and excludes bank cash", () => {
  const s = snapshot(), old = previous(), sourceBefore = copy(s), oldBefore = copy(old), data = build(s, old);
  assert.equal(data.performance.totalPrincipal, 750);
  assert.equal(data.performance.totalCurrentValue, 900);
  assert.equal(data.performance.totalGain, 150);
  assert.equal(data.performance.totalReturnPct, 20);
  assert.deepEqual(data.userConfirmedReturnMethod, {...old.userConfirmedReturnMethod, unrealizedGainCents: 10000});
  assert.deepEqual(data.userConfirmedCapital, old.userConfirmedCapital);
  const ui = U.browserContract(html).normalizeData(data);
  assert.equal(ui.equityValue, 900); assert.equal(ui.cashValue, 800); assert.equal(ui.totalAssetValue, 1700);
  assert.deepEqual(s, sourceBefore);
  changeCash(s, 1, 7000);
  assert.deepEqual(build(s, old).performance, data.performance);
  assert.deepEqual(old, oldBefore);
  assert.throws(() => build(snapshot(), {...old, userConfirmedCapital: {...old.userConfirmedCapital, effectiveDate: "2026-10-17"}}), {message: "MANUAL_CAPITAL_DATE_NOT_CONFIRMED"});
});

test("identical return-method updates do not encrypt again, including retrieval-only changes", async () => {
  const data = build(), original = Buffer.from(JSON.stringify(U.encrypt(data, password)));
  const s = snapshot(); s.fetchedAt = "2026-10-18T02:30:00Z"; s.previousCiphertextSha256 = U.hash(original);
  const result = await U.prepareUpdate({snapshot: s, existingBytes: original, password, html, now, policy,
    encryptFn() { assert.fail("unchanged data must not be encrypted"); }});
  assert.equal(result.status, "unchanged");
  assert.equal(result.bytes, undefined);
  assert.deepEqual(build(snapshot(), data), data);
});

test("valuation gains and losses update once without accumulating the included interest", async () => {
  let data = build();
  for (const [delta, expectedGain, expectedStock] of [[10000, 250, 200], [-20000, -50, -100]]) {
    const s = snapshot(); changeValue(s, delta);
    const bytes = Buffer.from(JSON.stringify(U.encrypt(data, password))); s.previousCiphertextSha256 = U.hash(bytes);
    const result = await U.prepareUpdate({snapshot: s, existingBytes: bytes, password, html, now, policy});
    assert.equal(result.status, "changed");
    data = U.decrypt(JSON.parse(result.bytes), password);
    assert.equal(data.performance.totalGain, expectedGain);
    assert.equal(data.performance.totalPrincipal, 750);
    assert.equal(data.performance.items[0].gain, expectedStock);
    assert.equal(data.performance.items[1].gain, 50);
    assert.equal(data.performance.items[1].components[0].gain, 20);
    assert.equal(data.performance.items.reduce((n, item) => n + item.gain, 0), expectedGain);
    assert.equal(data.userConfirmedReturnMethod.confirmedCdInterestIncludedCents, 2000);
    assert.equal(data.userConfirmedReturnMethod.nonHoldingIncomeCents, 5000);
    assert.deepEqual(build(s, data), data);
  }
});

test("changed brokerage cash with a pending supplement rejects before encryption or file replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-return-method-"));
  try {
    const target = path.join(dir, "data.enc.json"), bytes = Buffer.from(JSON.stringify(U.encrypt(build(), password)));
    fs.writeFileSync(target, bytes, {mode: 0o600});
    const s = snapshot(); changeCash(s, 0, 5000); s.previousCiphertextSha256 = U.hash(bytes);
    await assert.rejects(async () => {
      const result = await U.prepareUpdate({snapshot: s, existingBytes: fs.readFileSync(target), password, html, now, policy,
        encryptFn() { assert.fail("unreviewed cash must not reach encryption"); }});
      if (result.status === "changed") U.writeAtomically(target, bytes, result.bytes);
    }, {message: "BUYING_POWER_SUPPLEMENT_REQUIRES_REVIEW"});
    assert.ok(fs.readFileSync(target).equals(bytes));
    assert.deepEqual(fs.readdirSync(dir), ["data.enc.json"]);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test("a pending transfer followed by a purchase cannot hide behind unchanged cash", () => {
  const s = snapshot();
  changeValue(s, 5000);
  s.positions[0].costBasisCents += 5000;
  s.positions[0].shares += 1;
  assert.throws(() => build(s), {message: "BUYING_POWER_SUPPLEMENT_REQUIRES_REVIEW"});
  s.positions[0].costBasisCents -= 5000;
  assert.throws(() => build(s), {message: "BUYING_POWER_SUPPLEMENT_REQUIRES_REVIEW"});
});

test("confirmed return requires current position cost rather than inferring missing cost", () => {
  for (const missing of [undefined, null]) {
    const s = snapshot(); s.positions[0].costBasisCents = missing;
    assert.throws(() => build(s), {message: "RETURN_METHOD_COST_BASIS_REQUIRED"});
  }
});

test("explicit settled supplement state keeps the denominator continuous", () => {
  const before = build(), approved = copy(before), s = snapshot(); changeCash(s, 0, 5000);
  approved.userConfirmedReturnMethod = {...approved.userConfirmedReturnMethod,
    sourceMessageId: "synthetic-settlement-confirmation", providerCashCents: 25000,
    buyingPowerSupplementCents: 0, supplementState: "reflected-in-provider-snapshot"};
  const after = build(s, approved);
  assert.deepEqual(after.performance, before.performance);
  assert.equal(after.userConfirmedReturnMethod.effectiveBuyingPowerCents, 25000);
  assert.equal(after.userConfirmedReturnMethod.investedPrincipalCents, 75000);
  assert.equal(after.userConfirmedReturnMethod.buyingPowerSupplementCents, 0);
  assert.equal(after.userConfirmedReturnMethod.supplementState, "reflected-in-provider-snapshot");
  assert.deepEqual(after.userConfirmedCapital, before.userConfirmedCapital);
  changeCash(s, 0, 1000);
  assert.equal(build(s, after).performance.totalPrincipal, 740);
});

test("asset returns preserve trading, income and original history without inventing annual income", () => {
  const old = previous(), first = build(snapshot(), old), s = snapshot(); changeValue(s, 10000);
  const second = build(s, first);
  for (const data of [first, second]) {
    assert.deepEqual(data.trading, old.trading); assert.deepEqual(data.income, old.income);
    assert.deepEqual(data.historySnapshot.trading, old.trading); assert.deepEqual(data.historySnapshot.income, old.income);
    assert.deepEqual(data.historySnapshot.performance, old.performance);
    assert.deepEqual(annual(data), annual(old));
    assert.equal(data.userConfirmedReturnMethod.incomeDatesInvented, false);
  }
  assert.deepEqual(second.historySnapshot, first.historySnapshot);
  assert.equal(annual(second).incomeCount, 1);
  assert.equal(annual(second).years.reduce((n, row) => n + row.income, 0), 3);
  const nextDay = copy(s); nextDay.fetchedAt = "2026-10-19T02:00:00Z";
  const refreshed = U.buildAssetPayload(nextDay, second, {html, now: now + 86400000, policy});
  assert.equal(refreshed.asOf, second.asOf);
  assert.deepEqual(refreshed.performance, second.performance);
  assert.deepEqual(refreshed.historySnapshot, second.historySnapshot);
  assert.deepEqual(annual(refreshed), annual(second));
});

test("full validated ledger applies and retains the confirmed return metadata on repeated updates", () => {
  const s = full.fixture(), base = U.buildPayload(s, full.legacy(), {html, now, policy: full.policy});
  const old = copy(base);
  old.userConfirmedCapital = {...previous().userConfirmedCapital, principalCents: 200000};
  old.userConfirmedReturnMethod = {...previous().userConfirmedReturnMethod,
    totalPrincipalCents: 200000, providerCashCents: 167000,
    effectiveBuyingPowerCents: 172000, investedPrincipalCents: 28000,
    holdingCostBasisCents: 30000, unrealizedGainCents: 42000,
    nonHoldingIncomeCents: 2000, confirmedCdInterestIncludedCents: full.policy.historicalCashInterestCents};
  old.historySnapshot = {asOf: "2025-06-30", trading: {}, income: []};
  const before = copy(old);
  const first = U.buildPayload(s, old, {html, now, policy: full.policy});
  const second = U.buildPayload(s, first, {html, now, policy: full.policy});
  assert.deepEqual(first.userConfirmedCapital, old.userConfirmedCapital);
  assert.deepEqual(first.userConfirmedReturnMethod, old.userConfirmedReturnMethod);
  assert.deepEqual(first.historySnapshot, old.historySnapshot);
  assert.deepEqual(first.trading, base.trading); assert.deepEqual(first.income, base.income);
  assert.deepEqual(first.updateAudit, {...base.updateAudit, ledgerPrincipalCents: s.reconciliation.principalCents});
  assert.equal(first.performance.totalPrincipal, 280);
  assert.equal(first.performance.totalCurrentValue, 720);
  assert.equal(first.performance.totalGain, 440);
  assert.deepEqual(second, first); assert.deepEqual(old, before);
  assert.deepEqual(annual(first), annual(base));
});

test("HTML displays the performance denominator and securities value while retaining manual capital metadata", () => {
  const data = U.browserContract(html).normalizeData(build());
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: "", classList: {toggle() {}}});
    return elements.get(id);
  };
  const context = vm.createContext({state: {data}, $: element,
    setText: (id, text) => { element(id).textContent = text; },
    finiteOrNull: x => Number.isFinite(Number(x)) ? Number(x) : null,
    formatCurrency: x => `$${Number(x).toFixed(2)}`, formatSignedCurrency: x => `$${Number(x).toFixed(2)}`,
    formatPct: x => `${Number(x).toFixed(1)}%`, formatSignedPct: x => `${Number(x).toFixed(1)}%`});
  vm.runInContext(["renderSummary", "renderHero"].map(name => {
    const fn = html.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
    assert.ok(fn, `Missing browser function ${name}`); return fn[0];
  }).join("\n"), context);
  context.renderSummary();
  assert.equal(element("totalPrincipal").textContent, "$750.00");
  assert.equal(element("totalGainSub").textContent, "本金 $750.00，当前 $900.00");
  assert.equal(element("totalReturn").textContent, "20.0%");
  assert.equal(element("totalCurrent").textContent, "$900.00");
  assert.equal(element("heroValue").textContent, "$900.00");
  assert.equal(data.userConfirmedCapital.principalCents, 100000);
});
