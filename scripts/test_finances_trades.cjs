"use strict";

// Synthetic fixtures only. No connector, encrypted files, credentials or writes.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {applyTradeUpdates, FinancesTradesError} = require("./finances_trades.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const trading = {DEMO: {nameZh: "原有示例名称", prices: [{date: "2025-01-10", close: 9}],
    orders: [{date: "2024-12-15", side: "buy", shares: 5, price: 8}, {date: "2025-01-10", side: "sell", shares: 1, price: 9}]}};
  const previous = {asOf: "2025-01-10", trading, holdings: [{ticker: "DEMO", value: 40}],
    performance: {totalGain: 6}, income: [{date: "2024-12-31", amount: 2}],
    historyStatus: {state: "preserved", asOf: "2025-01-10"},
    historySnapshot: {asOf: "2025-01-10", trading: clone(trading)}};
  const row = {accountId: "synthetic-broker", sourceId: "synthetic-fill-a", date: "2025-01-11",
    ticker: "DEMO", side: "buy", shares: 2, price: 10, amountCents: 2000, feesCents: 0};
  const snapshot = {fetchedAt: "2025-01-13T12:00:00Z", accounts: [{id: "synthetic-broker", type: "brokerage"}],
    tradeUpdates: {version: 1, accountIds: ["synthetic-broker"], rows: [row], sourceAsOf: null,
      allPagesFetched: true, queriedFrom: null, dateBasis: "provider-settlement-date"}};
  return {previous, snapshot};
}
function apply(previous, snapshot) { return applyTradeUpdates(clone(previous), previous, snapshot); }
function rejects(code, alter) {
  const {previous, snapshot} = fixture(); const next = clone(previous);
  alter({previous, next, snapshot}); const before = clone(next);
  assert.throws(() => applyTradeUpdates(next, previous, snapshot), e => e instanceof FinancesTradesError && e.code === code && e.message === code);
  assert.deepEqual(next, before, "failed merge must not partially mutate the candidate");
}
test("appends source-dated orders without rewriting legacy, names, prices or financial data", () => {
  const {previous,snapshot}=fixture(), saved=clone(previous), source=clone(snapshot);
  const next=apply(previous,snapshot);
  assert.equal(next.trading.DEMO.orders.length,3);
  assert.deepEqual(next.trading.DEMO.orders.slice(0,2),previous.trading.DEMO.orders);
  assert.match(next.trading.DEMO.orders[2].id,/^[a-f0-9]{64}$/);
  assert.deepEqual(next.trading.DEMO.orders[2],{id:next.trading.DEMO.orders[2].id,date:"2025-01-11",side:"buy",shares:2,price:10});
  for(const key of ["asOf","holdings","performance","income","historySnapshot"])assert.deepEqual(next[key],previous[key]);
  assert.deepEqual(next.trading.DEMO.prices,previous.trading.DEMO.prices);assert.equal(next.trading.DEMO.nameZh,previous.trading.DEMO.nameZh);
  assert.equal(next.historyStatus.state,"current-trades");assert.equal(next.tradeSync.historyFromInception,false);
  assert.equal(next.tradeSync.baselineCutoff,"2025-01-10");assert.equal(next.tradeSync.dateBasis,"provider-settlement-date");
  assert.deepEqual(previous,saved);assert.deepEqual(snapshot,source);
  assert.equal(JSON.stringify(next.tradeSync).includes("synthetic"),false);
});
test("repeated same-ID economics are a no-op and cutoff never advances", () => {
  const {previous,snapshot}=fixture();const first=apply(previous,snapshot);
  assert.deepEqual(apply(first,snapshot),first);
  const more=clone(snapshot);more.tradeUpdates.rows.push({...more.tradeUpdates.rows[0],sourceId:"synthetic-fill-b",date:"2025-01-12"});
  const second=apply(first,more);assert.equal(second.trading.DEMO.orders.length,4);assert.equal(second.tradeSync.baselineCutoff,"2025-01-10");
});
test("bootstrap rejects matching legacy economics despite a later settlement date", () => {
  rejects("TRADES_LEGACY_DUPLICATE_REQUIRES_REVIEW", ({previous, snapshot}) => {
    const old = previous.trading.DEMO.orders[0];
    snapshot.tradeUpdates.rows[0] = {...snapshot.tradeUpdates.rows[0],
      side: old.side, shares: old.shares, price: old.price, amountCents: 4000};
    assert.notEqual(snapshot.tradeUpdates.rows[0].date, old.date);
    assert.equal(old.id, undefined);
  });
});
test("older mismatched source history and boundary-day rows do not rewrite legacy", () => {
  const {previous,snapshot}=fixture();snapshot.tradeUpdates.rows.push({...snapshot.tradeUpdates.rows[0],sourceId:"old",date:"2025-01-10",shares:999,side:"cancel"});
  const next=apply(previous,snapshot);assert.equal(next.trading.DEMO.orders.length,3);assert.equal(next.tradeSync.transactions.length,1);
});
test("distinct same-day same-economics executions remain two orders", () => {
  const {previous,snapshot}=fixture();snapshot.tradeUpdates.rows.push({...snapshot.tradeUpdates.rows[0],sourceId:"different-source-id"});
  const next=apply(previous,snapshot);assert.equal(next.trading.DEMO.orders.length,4);
  assert.notEqual(next.trading.DEMO.orders[2].id,next.trading.DEMO.orders[3].id);
});
test("source order does not affect the resulting orders or audit", () => {
  const {previous,snapshot}=fixture();snapshot.tradeUpdates.rows.push({...snapshot.tradeUpdates.rows[0],sourceId:"second",date:"2025-01-12"});
  const other=clone(snapshot);other.tradeUpdates.rows.reverse();assert.deepEqual(apply(previous,snapshot),apply(previous,other));
});
test("exited securities keep true sell orders without needing a current holding", () => {
  const {previous,snapshot}=fixture();snapshot.tradeUpdates.rows[0]={...snapshot.tradeUpdates.rows[0],ticker:"EXIT",side:"sell",amountCents:-2000};
  const next=apply(previous,snapshot);assert.equal(next.trading.EXIT.orders[0].side,"sell");assert.equal(Object.hasOwn(next.trading.EXIT,"prices"),false);
});
test("missing or changed previously synchronized source IDs fail", () => {
  for(const mutate of [s=>{s.tradeUpdates.rows=[];},s=>{s.tradeUpdates.rows[0].price=11;},s=>{s.tradeUpdates.rows[0].feesCents=1;}]){
    const {previous,snapshot}=fixture();const first=apply(previous,snapshot), changed=clone(snapshot);mutate(changed);
    const next=clone(first);assert.throws(()=>applyTradeUpdates(next,first,changed),{code:"TRADES_SYNCED_SOURCE_CHANGED"});assert.deepEqual(next,first);
  }
});
test("tampered synchronized stored order fails instead of repairing it", () => {
  const {previous,snapshot}=fixture();const first=apply(previous,snapshot);first.trading.DEMO.orders[2].shares=7;
  assert.throws(()=>apply(first,snapshot),{code:"TRADES_SYNCED_ORDER_CHANGED"});
});
test("bootstrap requires a matching independently preserved cutoff", () => {
  rejects("TRADES_BASELINE_CUTOFF_UNCONFIRMED",({previous,next})=>{previous.historySnapshot.asOf="2025-01-09";next.historySnapshot=clone(previous.historySnapshot);});
});
test("unconfirmed query coverage, changed scope and narrower windows fail", () => {
  rejects("TRADES_INCOMPLETE_SOURCE",({snapshot})=>{snapshot.tradeUpdates.allPagesFetched=false;});
  rejects("TRADES_ACCOUNT_SCOPE_MISMATCH",({snapshot})=>{snapshot.tradeUpdates.accountIds=["unknown"];});
  rejects("TRADES_QUERY_WINDOW_MISMATCH",({snapshot})=>{snapshot.tradeUpdates.queriedFrom="2025-01-11";});
});
test("window cancellation or unknown status fields fail closed", () => {
  rejects("TRADES_UNSUPPORTED_SIDE",({snapshot})=>{snapshot.tradeUpdates.rows[0].side="cancel";});
  rejects("TRADES_UNSUPPORTED_WINDOW_ROW",({snapshot})=>{snapshot.tradeUpdates.rows[0].cancelled=true;});
});
test("invalid or future dates, duplicate IDs and incomplete executions fail", () => {
  rejects("TRADES_INVALID_DATE",({snapshot})=>{snapshot.tradeUpdates.rows[0].date="2025-02-30";});
  rejects("TRADES_FUTURE_DATE",({snapshot})=>{snapshot.tradeUpdates.rows[0].date="2025-01-14";});
  rejects("TRADES_DUPLICATE_SOURCE_ID",({snapshot})=>{snapshot.tradeUpdates.rows.push(clone(snapshot.tradeUpdates.rows[0]));});
  rejects("TRADES_INVALID_EXECUTION",({snapshot})=>{snapshot.tradeUpdates.rows[0].price=0;});
  rejects("TRADES_UNSUPPORTED_WINDOW_ROW",({snapshot})=>{delete snapshot.tradeUpdates.rows[0].shares;});
});
test("cash and transfers never become security orders", () => {
  rejects("TRADES_INVALID_TICKER",({snapshot})=>{snapshot.tradeUpdates.rows[0].ticker="CASH";});
  rejects("TRADES_UNSUPPORTED_SIDE",({snapshot})=>{snapshot.tradeUpdates.rows[0].side="transfer_in";});
});
test("unexpected mutations to preserved legacy or history fail before writes", () => {
  rejects("TRADES_LEGACY_CHANGED",({next})=>{next.trading.DEMO.nameZh="changed";});
  rejects("TRADES_HISTORY_SNAPSHOT_CHANGED",({next})=>{next.historySnapshot.trading={};});
});
test("legacy asset snapshots remain compatible, but established sync cannot omit its source", () => {
  const {previous,snapshot}=fixture();const next=clone(previous), empty={...snapshot};delete empty.tradeUpdates;
  assert.equal(applyTradeUpdates(next,previous,empty),next);assert.deepEqual(next,previous);
  const first=apply(previous,snapshot);assert.throws(()=>apply(first,empty),{code:"TRADES_SOURCE_REQUIRED"});
});
