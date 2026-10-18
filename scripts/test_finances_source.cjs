#!/usr/bin/env node
"use strict";

// Synthetic source-contract tests. No connector, private data, secrets, network,
// repository writes, or encryption keys are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { FinancesSourceError, normalizeAssetSnapshot } = require("./finances_source.cjs");
const copy = value => JSON.parse(JSON.stringify(value));
const coverage = () => ({ dataset: "accounts", availability: "ready", state: "complete", freshness: "unknown", is_complete_for_query: true });
function account(id, type, subtype, current) {
  return { account_id: id, type, subtype, balances: { current, iso_currency_code: "USD", balance_date: null, last_updated_datetime: "2025-03-12T10:00:00Z", last_updated_datetime_source: null }, last_successful_update: "2025-03-12T10:00:00Z" };
}
function holding(id, ticker, type, quantity, price, extra = {}) {
  return { account_id: "synthetic-broker", security_id: id, ticker_symbol: ticker, type, is_cash_equivalent: type === "cash", quantity, institution_price: price, institution_value: quantity * price, institution_price_as_of: "2025-03-11", cost_basis: null, iso_currency_code: "USD", ...extra };
}
function fixture() {
  return {
    linkedAccounts: { institutions: [
      { account_coverage: coverage(), accounts: [account("synthetic-broker", "investment", "brokerage", 100.25)] },
      { account_coverage: coverage(), accounts: [
        account("synthetic-checking", "depository", "checking", 10.13),
        account("synthetic-savings", "depository", "savings", 20),
        account("synthetic-cd", "depository", "cd", 30),
        account("synthetic-credit", "credit", "credit card", 50)
      ] }
    ] },
    holdingsResponses: [{
      queries: [{ query_type: "investment_holdings", account_id: "synthetic-broker", limit: 400 }],
      response: { results: [{ index: 0, query_type: "investment_holdings", is_error: false, result: {
        has_more: false, next_cursor: null, items: [
          holding("synthetic-cash", null, "cash", 20.25, 1),
          holding("synthetic-stock", "SYNTH", "equity", 3, 20, { cost_basis: 45 }),
          holding("synthetic-etf", "DEMO", "etf", 2, 10)
        ]
      } }] }
    }],
    fetchedAt: "2025-03-12T12:00:00Z", baselineSha256: "a".repeat(64),
    policy: { accountIds: ["synthetic-broker", "synthetic-checking", "synthetic-savings", "synthetic-cd"] }
  };
}
const resultOf = input => input.holdingsResponses[0].response.results[0].result;
const brokerOf = input => input.linkedAccounts.institutions[0].accounts[0];
function failure(code, change) {
  const input = fixture(); change(input);
  assert.throws(() => normalizeAssetSnapshot(input), error => error instanceof FinancesSourceError && error.code === code && error.message === code);
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("normalizes current assets with independent balances and excludes unapproved credit", () => {
  const input = fixture(), before = JSON.stringify(input);
  const result = normalizeAssetSnapshot(freeze(input));
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.schemaVersion, 2); assert.equal(result.mode, "assets");
  assert.equal(result.accounts.length, 4); assert.equal(result.positions.length, 2);
  assert.deepEqual(result.reconciliation, { independentSourceTotals: true, totalValueCents: 16038, cashCents: 8038 });
  assert.equal(result.accounts.find(a => a.id === "synthetic-cd").type, "cash");
  assert.equal(Object.hasOwn(result, "transactions"), false);
  assert.equal(Object.hasOwn(result.coverage, "historyFromInception"), false);
  assert.equal(result.previousCiphertextSha256, input.baselineSha256);
  assert.equal(result.positions.find(p => p.ticker === "SYNTH").costBasisCents, 4500);
  assert.equal(result.positions.find(p => p.ticker === "SYNTH").securityId, "synthetic-stock");
  assert.equal(result.positions.find(p => p.ticker === "DEMO").securityId, "synthetic-etf");
  assert.equal(Object.hasOwn(result.positions.find(p => p.ticker === "DEMO"), "costBasisCents"), false);
});

test("holding security identity is preserved exactly and invalid identities fail", () => {
  const input = fixture(), id = "x".repeat(200);
  resultOf(input).items[1].security_id = id;
  assert.equal(normalizeAssetSnapshot(input).positions.find(p => p.ticker === "SYNTH").securityId, id);
  for (const invalid of [undefined, null, "", " ", 12, "x".repeat(201), "bad\nidentity"])
    failure("SOURCE_INVALID_ID", value => { resultOf(value).items[1].security_id = invalid; });
});

test("USD cash is aggregated once while a genuine USD ETF remains a security", () => {
  const input = fixture();
  resultOf(input).items = [
    holding("synthetic-usd-cash", "USD", "cash", 20.25, 1),
    holding("synthetic-usd-etf", "USD", "etf", 4, 20)
  ];
  const before = JSON.stringify(input);
  const result = normalizeAssetSnapshot(freeze(input));
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].ticker, "USD");
  assert.equal(result.positions[0].type, "etf");
  assert.equal(result.positions[0].valueCents, 8000);
  const broker = result.accounts.find(a => a.id === "synthetic-broker");
  assert.equal(broker.cashCents, 2025);
  assert.equal(broker.securitiesCents, 8000);
  assert.equal(broker.totalCents, 10025);
  assert.equal(broker.totalCents, broker.cashCents + broker.securitiesCents);
  assert.deepEqual(result.reconciliation, {
    independentSourceTotals: true, totalValueCents: 16038, cashCents: 8038
  });
  assert.equal(result.reconciliation.totalValueCents,
    result.reconciliation.cashCents + result.positions.reduce((sum, p) => sum + p.valueCents, 0));
});

test("retrieval, record updates, sync dates and price dates never become balance dates", () => {
  const input = fixture();
  brokerOf(input).balances.last_updated_datetime_source = "record_update";
  const result = normalizeAssetSnapshot(input);
  for (const a of result.accounts) {
    assert.equal(a.coverage.balances.updatedAt, null);
    assert.equal(a.coverage.balances.sourceDateStatus, "unknown");
    assert.equal(a.coverage.holdings.updatedAt, null);
  }
  assert.ok(result.positions.every(p => p.priceAsOf === "2025-03-11"));
});

test("only observed balance dates or source-reported timestamps become dated proof", () => {
  const input = fixture();
  brokerOf(input).balances.balance_date = "2025-03-11";
  const dateProof = normalizeAssetSnapshot(input).accounts.find(a => a.type === "brokerage").coverage.balances;
  assert.equal(dateProof.updatedAt, "2025-03-11T00:00:00.000Z");
  assert.equal(dateProof.dateBasis, "balance_date");
  brokerOf(input).balances.last_updated_datetime_source = "source_reported";
  brokerOf(input).balances.last_updated_datetime = "2025-03-12T02:00:00-07:00";
  const timestampProof = normalizeAssetSnapshot(input).accounts.find(a => a.type === "brokerage").coverage.balances;
  assert.equal(timestampProof.updatedAt, "2025-03-12T09:00:00.000Z");
  assert.equal(timestampProof.dateBasis, "source_reported");
});

test("raw MCP wrappers are unwrapped without printing or retaining wrapper metadata", () => {
  const input = fixture();
  input.linkedAccounts = { content: [{ type: "text", text: JSON.stringify(input.linkedAccounts) }] };
  input.holdingsResponses[0].response = { structuredContent: { content: [{ type: "text", text: JSON.stringify(input.holdingsResponses[0].response) }] } };
  assert.equal(normalizeAssetSnapshot(input).positions.length, 2);
});

test("all observed pages are required and checked against the exact request chain", () => {
  const input = fixture();
  const first = input.holdingsResponses[0];
  const original = copy(resultOf(input));
  const next = copy(first); next.queries[0].cursor = "synthetic-next";
  resultOf(input).items = original.items.slice(0, 2);
  resultOf(input).has_more = true; resultOf(input).next_cursor = "synthetic-next";
  next.response.results[0].result.items = original.items.slice(2);
  input.holdingsResponses.push(next);
  assert.equal(normalizeAssetSnapshot(input).positions.length, 2);
  input.holdingsResponses.reverse();
  assert.equal(normalizeAssetSnapshot(input).positions.length, 2);
  input.holdingsResponses.shift();
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_PAGE_MISSING_OR_QUERY_CHANGED" });
});

test("ordering of independent institutions, accounts, rows and batch results is immaterial", () => {
  const input = fixture(), expected = normalizeAssetSnapshot(input);
  input.linkedAccounts.institutions.reverse();
  input.linkedAccounts.institutions.forEach(i => i.accounts.reverse());
  resultOf(input).items.reverse();
  input.policy.accountIds.reverse();
  assert.deepEqual(normalizeAssetSnapshot(input), expected);
});

test("minor floating representation noise rounds to cents and reconciles", () => {
  const input = fixture();
  brokerOf(input).balances.current = 100.2500000001;
  resultOf(input).items[1].institution_value = 59.9999999999;
  assert.equal(normalizeAssetSnapshot(input).reconciliation.totalValueCents, 16038);
});

test("complete explicit field projection is safe and optional price dates stay unknown", () => {
  const input = fixture();
  input.holdingsResponses[0].queries[0].select_fields = ["account_id", "security_id", "ticker_symbol", "is_cash_equivalent", "type", "subtype", "quantity", "institution_price", "institution_value", "cost_basis", "iso_currency_code"];
  for (const row of resultOf(input).items) delete row.institution_price_as_of;
  const normalized = normalizeAssetSnapshot(input);
  assert.equal(normalized.positions.length, 2);
  assert.ok(normalized.positions.every(position => !Object.hasOwn(position, "priceAsOf")));
  input.holdingsResponses[0].queries[0].select_fields = input.holdingsResponses[0].queries[0].select_fields.filter(field => field !== "institution_value");
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_INCOMPLETE_PROJECTION" });
});

test("empty brokerage response requires its explicit account query and cash evidence", () => {
  const input = fixture(); resultOf(input).items = []; brokerOf(input).balances.current = 0;
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_EXPLICIT_CASH_HOLDING_REQUIRED" });
});

test("orphan pages, cursor cycles and changed request shape fail closed", () => {
  const input = fixture();
  const second = copy(input.holdingsResponses[0]); second.queries[0].cursor = "unreachable";
  input.holdingsResponses.push(second);
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_ORPHAN_HOLDINGS_PAGE" });
  resultOf(input).has_more = true; resultOf(input).next_cursor = "unreachable";
  second.response.results[0].result.items = [];
  second.queries[0].limit = 100;
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_PAGE_MISSING_OR_QUERY_CHANGED" });
  second.queries[0].limit = 400;
  second.response.results[0].result.has_more = true; second.response.results[0].result.next_cursor = "unreachable";
  assert.throws(() => normalizeAssetSnapshot(input), { message: "SOURCE_CURSOR_CYCLE" });
});

test("batched result indices retain exact account scope despite reordered results", () => {
  const input = fixture();
  input.policy.accountIds.push("synthetic-other");
  input.linkedAccounts.institutions[0].accounts.push(account("synthetic-other", "investment", "brokerage", 5));
  input.holdingsResponses[0].queries.push({ query_type: "investment_holdings", account_id: { op: "eq", val: "synthetic-other" }, limit: 400 });
  input.holdingsResponses[0].response.results.push({ index: 1, query_type: "investment_holdings", is_error: false, result: { has_more: false, next_cursor: null, items: [holding("other-cash", null, "cash", 5, 1, { account_id: "synthetic-other" })] } });
  input.holdingsResponses[0].response.results.reverse();
  const normalized = normalizeAssetSnapshot(input);
  assert.equal(normalized.accounts.length, 5);
  assert.equal(normalized.reconciliation.totalValueCents, 16538);
});

const cases = [
  ["SOURCE_APPROVED_POLICY_REQUIRED", i => { delete i.policy; }],
  ["SOURCE_DUPLICATE_POLICY_ACCOUNT", i => { i.policy.accountIds.push(i.policy.accountIds[0]); }],
  ["SOURCE_APPROVED_ACCOUNT_MISSING", i => { i.policy.accountIds.push("synthetic-missing"); }],
  ["SOURCE_DUPLICATE_ACCOUNT", i => { i.linkedAccounts.institutions[1].accounts.push(copy(brokerOf(i))); }],
  ["SOURCE_UNSUPPORTED_ACCOUNT_TYPE", i => { i.policy.accountIds.push("synthetic-credit"); }],
  ["SOURCE_INCOMPLETE_ACCOUNT_COVERAGE", i => { delete i.linkedAccounts.institutions[0].account_coverage; }],
  ["SOURCE_INCOMPLETE_ACCOUNT_COVERAGE", i => { i.linkedAccounts.institutions[0].account_coverage.is_complete_for_query = false; }],
  ["SOURCE_INCOMPLETE_ACCOUNT_COVERAGE", i => { i.linkedAccounts.institutions[0].account_coverage.state = "partial"; }],
  ["SOURCE_DELETED_INSTITUTION", i => { i.linkedAccounts.institutions[0].is_reset_tombstone = true; }],
  ["SOURCE_UNSUPPORTED_CURRENCY", i => { brokerOf(i).balances.iso_currency_code = "EUR"; }],
  ["SOURCE_INVALID_MONEY", i => { brokerOf(i).balances.current = null; }],
  ["SOURCE_INVALID_MONEY", i => { brokerOf(i).balances.current = -1; }],
  ["SOURCE_INVALID_MONEY", i => { brokerOf(i).balances.current = "100.25"; }],
  ["SOURCE_INVALID_MONEY", i => { resultOf(i).items[1].institution_value = NaN; }],
  ["SOURCE_MONEY_OVERFLOW", i => { brokerOf(i).balances.current = Number.MAX_SAFE_INTEGER; }],
  ["SOURCE_INVALID_DATE", i => { brokerOf(i).balances.balance_date = "2025-02-30"; }],
  ["SOURCE_INVALID_TIMESTAMP", i => { i.fetchedAt = "2025-03-12"; }],
  ["SOURCE_INVALID_TIMESTAMP", i => { brokerOf(i).balances.last_updated_datetime_source = "source_reported"; brokerOf(i).balances.last_updated_datetime = null; }],
  ["SOURCE_FUTURE_BALANCE_DATE", i => { brokerOf(i).balances.balance_date = "2025-03-13"; }],
  ["SOURCE_INVALID_BASELINE_HASH", i => { i.baselineSha256 = "invalid"; }],
  ["SOURCE_TOOL_ERROR", i => { i.linkedAccounts.isError = true; }],
  ["SOURCE_HOLDINGS_RESPONSES_REQUIRED", i => { delete i.holdingsResponses; }],
  ["SOURCE_HOLDINGS_FIRST_PAGE_MISSING", i => { i.holdingsResponses = []; }],
  ["SOURCE_QUERY_CONTEXT_REQUIRED", i => { delete i.holdingsResponses[0].queries; }],
  ["SOURCE_QUERY_RESULTS_MISSING", i => { i.holdingsResponses[0].response.results = []; }],
  ["SOURCE_QUERY_INDEX_INVALID", i => { i.holdingsResponses[0].response.results[0].index = 99; }],
  ["SOURCE_HOLDINGS_QUERY_FAILED", i => { i.holdingsResponses[0].response.results[0].is_error = true; }],
  ["SOURCE_FILTERED_OR_UNSUPPORTED_QUERY", i => { i.holdingsResponses[0].queries[0].ticker_symbol = "SYNTH"; }],
  ["SOURCE_FILTERED_OR_UNSUPPORTED_QUERY", i => { i.holdingsResponses[0].queries[0].is_cash_equivalent = false; }],
  ["SOURCE_QUERY_ACCOUNT_MISMATCH", i => { i.holdingsResponses[0].queries[0].account_id = "synthetic-checking"; }],
  ["SOURCE_HOLDINGS_PAGE_SHAPE", i => { delete resultOf(i).has_more; }],
  ["SOURCE_CURSOR_STATE_INVALID", i => { resultOf(i).has_more = true; }],
  ["SOURCE_PAGE_MISSING_OR_QUERY_CHANGED", i => { resultOf(i).has_more = true; resultOf(i).next_cursor = "missing-next"; }],
  ["SOURCE_DUPLICATE_PAGE", i => { i.holdingsResponses.push(copy(i.holdingsResponses[0])); }],
  ["SOURCE_INCOMPLETE_HOLDINGS_COVERAGE", i => { resultOf(i).coverage = { availability: "ready", state: "partial", is_complete_for_query: false }; }],
  ["SOURCE_HOLDING_ACCOUNT_MISMATCH", i => { resultOf(i).items[1].account_id = "another-account"; }],
  ["SOURCE_DUPLICATE_SECURITY", i => { resultOf(i).items.push(copy(resultOf(i).items[1])); }],
  ["SOURCE_DUPLICATE_TICKER", i => { resultOf(i).items.push({ ...copy(resultOf(i).items[1]), security_id: "different-security" }); }],
  ["SOURCE_CASH_CLASSIFICATION_MISSING", i => { delete resultOf(i).items[0].is_cash_equivalent; }],
  ["SOURCE_CASH_CLASSIFICATION_CONFLICT", i => { resultOf(i).items[1].is_cash_equivalent = true; }],
  ["SOURCE_UNSUPPORTED_SECURITY_TYPE", i => { resultOf(i).items[1].type = "option"; }],
  ["SOURCE_INVALID_TICKER", i => { resultOf(i).items[1].ticker_symbol = null; }],
  ["SOURCE_INVALID_QUANTITY", i => { resultOf(i).items[1].quantity = -1; }],
  ["SOURCE_INVALID_QUANTITY", i => { resultOf(i).items[0].quantity = -1; }],
  ["SOURCE_INVALID_PRICE", i => { resultOf(i).items[1].institution_price = 0; }],
  ["SOURCE_POSITION_VALUE_MISMATCH", i => { resultOf(i).items[1].institution_price = 21; }],
  ["SOURCE_FUTURE_PRICE_DATE", i => { resultOf(i).items[1].institution_price_as_of = "2025-03-13"; }],
  ["SOURCE_EXPLICIT_CASH_HOLDING_REQUIRED", i => { resultOf(i).items.shift(); }],
  ["SOURCE_BROKER_BALANCE_MISMATCH", i => { brokerOf(i).balances.current += 1; }]
];
for (const [index, [code, change]] of cases.entries()) test(`fails closed: ${code} (${index + 1})`, () => failure(code, change));

test("pure core runs in a functions-style runtime without require, module, crypto or Node APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "finances_source.cjs"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const actual = context.normalizeAssetSnapshot(fixture());
  assert.deepEqual(copy(actual), normalizeAssetSnapshot(fixture()));
});

test("schema 2 integrates with updater while preserving synthetic historical data", () => {
  const { buildAssetPayload } = require("./update_finances.cjs");
  const input = fixture();
  const snapshot = normalizeAssetSnapshot(input);
  const previous = { asOf: "2025-03-01", holdings: [{ ticker: "CASH", type: "cash", value: 100 }], performance: { totalGain: 5, totalPrincipal: 95, totalCurrentValue: 100, totalReturnPct: 5 / 95 * 100, items: [{ label: "现金利息", kind: "cash_interest", gain: 5 }] } };
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const result = buildAssetPayload(snapshot, previous, { now: Date.parse(input.fetchedAt), html, policy: input.policy });
  assert.deepEqual(result.performance, previous.performance);
  assert.equal(result.assetSnapshot.sourceDateStatus, "unknown");
  assert.equal(result.holdings.reduce((sum, row) => sum + Math.round(row.value * 100), 0), 16038);
});
