#!/usr/bin/env node
"use strict";
// Synthetic source-contract checks only; no connector, secrets or private files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { normalizeTradeUpdates, FinancesSourceError } = require("./finances_source.cjs");
const copy = value => JSON.parse(JSON.stringify(value));
function trade(id, side = "buy", extra = {}) {
  return { account_id: "synthetic-broker", investment_transaction_id: id, security_id: "synthetic-security", date: "2025-03-11", transaction_datetime: "2025-03-07T12:00:00Z", ticker_symbol: "SYNTH", is_cash_equivalent: false, quantity: side === "buy" ? 2 : -2, price: 10.125, amount: side === "buy" ? 20.25 : -20.25, fees: 0, type: side, subtype: side, iso_currency_code: "USD", ...extra };
}
function batch(items, extra = {}, paging = {}) {
  return { queries: [{ query_type: "investment_transactions", account_id: "synthetic-broker", limit: 20, order_by_field: "date", order_by_direction: "asc", ...extra }], response: { results: [{ index: 0, query_type: "investment_transactions", is_error: false, result: { items, has_more: false, next_cursor: null, ...paging } }] } };
}
function fixture() { return { transactionResponses: [batch([trade("synthetic-buy"), trade("synthetic-sell", "sell", { ticker_symbol: "SOLD" })])], policy: { accountIds: ["synthetic-broker"] }, fetchedAt: "2025-03-12T12:00:00Z" }; }
const page = input => input.transactionResponses[0].response.results[0].result;
function fails(change, code) {
  const input = fixture(); change(input);
  assert.throws(() => normalizeTradeUpdates(input), error => error instanceof FinancesSourceError && error.code === code && error.message === code);
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("preserves provider signs, settlement dates and sold tickers without holdings", () => {
  const result = normalizeTradeUpdates(fixture());
  assert.deepEqual(result, { version: 1, source: "Finances", fetchedAt: "2025-03-12T12:00:00.000Z", sourceAsOf: null, dateBasis: "provider-settlement-date", allPagesFetched: true, queriedFrom: null, historyFromInception: false, accountIds: ["synthetic-broker"], rows: [
    { accountId: "synthetic-broker", sourceId: "synthetic-buy", date: "2025-03-11", ticker: "SYNTH", side: "buy", shares: 2, price: 10.125, amountCents: 2025, feesCents: 0 },
    { accountId: "synthetic-broker", sourceId: "synthetic-sell", date: "2025-03-11", ticker: "SOLD", side: "sell", shares: 2, price: 10.125, amountCents: -2025, feesCents: 0 }
  ] });
  assert.equal(Object.hasOwn(result, "income"), false);
});

test("follows all cursor pages regardless of batch order and accepts raw MCP wrappers", () => {
  const input = fixture(), original = page(input).items;
  input.transactionResponses = [batch([original[0]], {}, { has_more: true, next_cursor: "synthetic-next" }), batch([original[1]], { cursor: "synthetic-next" })];
  input.transactionResponses.reverse();
  input.transactionResponses[0].response = { content: [{ type: "text", text: JSON.stringify(input.transactionResponses[0].response) }] };
  assert.deepEqual(normalizeTradeUpdates(input), normalizeTradeUpdates(fixture()));
});

test("every approved investment account requires a complete query including empty accounts", () => {
  const input = fixture(); input.policy.accountIds.push("synthetic-empty");
  assert.throws(() => normalizeTradeUpdates(input), { code: "SOURCE_TRANSACTIONS_FIRST_PAGE_MISSING" });
  input.transactionResponses.push(batch([], { account_id: "synthetic-empty" }));
  const result = normalizeTradeUpdates(input);
  assert.deepEqual(result.accountIds, ["synthetic-broker", "synthetic-empty"]);
  assert.equal(result.rows.length, 2);
});

test("missing, duplicate, orphan, cyclic and changed query pages fail closed", () => {
  fails(i => { page(i).has_more = true; page(i).next_cursor = "missing"; }, "SOURCE_PAGE_MISSING_OR_QUERY_CHANGED");
  fails(i => { i.transactionResponses.push(copy(i.transactionResponses[0])); }, "SOURCE_DUPLICATE_PAGE");
  fails(i => { i.transactionResponses.push(batch([], { cursor: "orphan" })); }, "SOURCE_ORPHAN_TRANSACTIONS_PAGE");
  fails(i => { page(i).has_more = true; page(i).next_cursor = "cycle"; i.transactionResponses.push(batch([], { cursor: "cycle" }, { has_more: true, next_cursor: "cycle" })); }, "SOURCE_CURSOR_CYCLE");
  fails(i => { page(i).has_more = true; page(i).next_cursor = "next"; i.transactionResponses.push(batch([], { cursor: "next", limit: 10 })); }, "SOURCE_PAGE_MISSING_OR_QUERY_CHANGED");
});

test("cash, interest, dividends, fees and transfers need no trade-only fields", () => {
  const input = fixture();
  page(input).items.push(...[["cash", "dividend"], ["cash", "interest"], ["fee", "miscellaneous fee"], ["transfer", "transfer"]].map(([type, subtype], index) => ({ account_id: "synthetic-broker", investment_transaction_id: `synthetic-ignored-${index}`, type, subtype, ticker_symbol: null, security_id: null, date: null, amount: null, price: null, quantity: null })));
  assert.equal(normalizeTradeUpdates(input).rows.length, 2);
});

test("noncash security transfers cannot disappear as ignored internal cash transfers", () => {
  fails(i => { page(i).items.push({ account_id: "synthetic-broker", investment_transaction_id: "synthetic-security-transfer", type: "transfer", subtype: "transfer", quantity: 2, security_id: "synthetic-transferred-security", ticker_symbol: "OTHER", is_cash_equivalent: false }); }, "SOURCE_SECURITY_TRANSFER_UNSUPPORTED");
});

test("documented cash and fee subtype spellings pass without accepting reinvestments", () => {
  const pairs = [["cash", "qualified dividend"], ["cash", "non-qualified dividend"], ...["account fee", "fund fee", "management fee", "legal fee", "margin expense", "transfer fee", "trust fee"].map(subtype => ["fee", subtype])];
  for (const [type, subtype] of pairs) {
    const input = fixture(); page(input).items.push({ account_id: "synthetic-broker", investment_transaction_id: "synthetic-documented-cash", type, subtype });
    assert.equal(normalizeTradeUpdates(input).rows.length, 2);
  }
  for (const subtype of ["spin off", "stock distribution", "dividend reinvestment", "interest reinvestment", "qualified_dividend"]) fails(i => { page(i).items[0].type = "cash"; page(i).items[0].subtype = subtype; }, "SOURCE_UNSUPPORTED_TRANSACTION_KIND");
  fails(i => { page(i).items[0].cancel_transaction_id = "synthetic-canceled-order"; }, "SOURCE_CANCEL_OR_CORPORATE_ACTION_UNSUPPORTED");
});

test("cancellations and corporate actions cannot disappear in ignored cash rows", () => {
  for (const kind of ["cancel", "stock_split", "merger", "spinoff"]) fails(i => { page(i).items.push({ account_id: "synthetic-broker", investment_transaction_id: "synthetic-action", type: "cash", subtype: kind }); }, "SOURCE_CANCEL_OR_CORPORATE_ACTION_UNSUPPORTED");
  fails(i => { page(i).items[0].type = "cash"; page(i).items[0].subtype = "unknown-action"; }, "SOURCE_UNSUPPORTED_TRANSACTION_KIND");
});

test("query scope, inline page size, ordering and result mapping remain explicit", () => {
  fails(i => { i.transactionResponses[0].queries[0].where = { date: { gte: "2025-01-01" } }; }, "SOURCE_FILTERED_OR_UNSUPPORTED_QUERY");
  fails(i => { i.transactionResponses[0].queries[0].account_id = "not-approved"; }, "SOURCE_QUERY_ACCOUNT_MISMATCH");
  fails(i => { i.transactionResponses[0].queries[0].limit = 500; }, "SOURCE_INVALID_QUERY_LIMIT");
  fails(i => { i.transactionResponses[0].queries[0].order_by_direction = "desc"; }, "SOURCE_INVALID_QUERY_ORDER");
  fails(i => { i.transactionResponses[0].response.results[0].index = 1; }, "SOURCE_QUERY_INDEX_INVALID");
  fails(i => { i.transactionResponses[0].queries[0].select_fields = ["date"]; }, "SOURCE_INCOMPLETE_PROJECTION");
});

test("duplicate transaction IDs including ignored records and account mismatches fail", () => {
  fails(i => { page(i).items.push({ ...page(i).items[0], type: "fee", subtype: "fee" }); }, "SOURCE_DUPLICATE_TRANSACTION");
  fails(i => { page(i).items[0].account_id = "other"; }, "SOURCE_TRANSACTION_ACCOUNT_MISMATCH");
});

test("required trade nulls and inconsistent provider signs are rejected", () => {
  for (const [field, code] of [["date", "SOURCE_INVALID_DATE"], ["security_id", "SOURCE_INVALID_ID"], ["ticker_symbol", "SOURCE_INVALID_TICKER"], ["quantity", "SOURCE_TRADE_QUANTITY_SIGN_INVALID"], ["price", "SOURCE_INVALID_PRICE"], ["amount", "SOURCE_TRADE_AMOUNT_SIGN_INVALID"], ["fees", "SOURCE_INVALID_MONEY"], ["is_cash_equivalent", "SOURCE_TRADE_CASH_CLASSIFICATION_INVALID"]]) fails(i => { page(i).items[0][field] = null; }, code);
  fails(i => { page(i).items[1].quantity = 2; }, "SOURCE_TRADE_QUANTITY_SIGN_INVALID");
  fails(i => { page(i).items[1].amount = 20.25; }, "SOURCE_TRADE_AMOUNT_SIGN_INVALID");
  fails(i => { page(i).items[0].amount = Number.MAX_SAFE_INTEGER; }, "SOURCE_MONEY_OVERFLOW");
  fails(i => { page(i).items[0].date = null; page(i).items[0].transaction_datetime = "2025-03-11T00:00:00Z"; }, "SOURCE_INVALID_DATE");
});

test("normalization is immutable and runs without Node or connector facilities", () => {
  const input = freeze(fixture()), before = JSON.stringify(input), expected = normalizeTradeUpdates(input);
  assert.equal(JSON.stringify(input), before);
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "finances_source.cjs"), "utf8"), context);
  assert.deepEqual(copy(context.normalizeTradeUpdates(input)), expected);
});
