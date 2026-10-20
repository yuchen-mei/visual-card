"use strict";
// Synthetic identities and quantities only; no portfolio files or credentials.
const {test} = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const {applyPositionLifecycle, positionEffects} = require("./finances_positions.cjs");
const {applyOpeningPositions} = require("./finances_opening.cjs");
const copy = v => JSON.parse(JSON.stringify(v));
const hash = v => crypto.createHash("sha256").update(v).digest("hex");
const account = "synthetic-lifecycle-broker", policy = {positionAccountIds: [account]};
function order(extra = {}) {return {accountId: account, securityId: "synthetic-security-a", sourceId: "synthetic-buy-a",
  ticker: "DEMO", date: "2025-01-11", side: "buy", shares: 2, price: 11, amountCents: 2200, feesCents: 0, ...extra};}
function fixture() {
  const previous = {holdings: [{ticker: "CASH", type: "cash", value: 20}, {ticker: "DEMO", type: "stock", shares: 5}],
    trading: {DEMO: {nameZh: "合成名称", prices: [{date: "2025-01-10", close: 10}], orders: [{date: "2024-12-01", side: "buy", shares: 5, price: 9}]}},
    historySnapshot: {asOf: "2025-01-10"}, income: [{date: "2024-12-31", amount: 1}]};
  const snapshot = {fetchedAt: "2025-01-15T12:00:00Z", coverage: {accountsComplete: true, allPagesFetched: true, accountIds: [account]},
    accounts: [{id: account, type: "brokerage", coverage: {holdings: {complete: true, allPagesFetched: true}}}],
    positions: [{accountId: account, securityId: "synthetic-security-a", ticker: "DEMO", shares: 5}],
    tradeUpdates: {version: 1, accountIds: [account], allPagesFetched: true, dateBasis: "provider-settlement-date", rows: []}};
  return {previous, snapshot};
}
function sync(snapshot) {return {version: 1, baselineCutoff: "2025-01-10", accountHashes: [hash(account)],
  allPagesFetched: true, dateBasis: "provider-settlement-date", historyFromInception: false,
  transactions: snapshot.tradeUpdates.rows.filter(row => row.date > "2025-01-10").map(row => ({
    id: hash(JSON.stringify([row.accountId, row.sourceId])), digest: hash(JSON.stringify({date:row.date,ticker:row.ticker,
      side:row.side,shares:row.shares,price:row.price,amountCents:row.amountCents,feesCents:row.feesCents}))})).sort((a,b)=>a.id.localeCompare(b.id))};}
function apply(previous, snapshot, p = policy) {
  const next = copy(previous); next.tradeSync = sync(snapshot);
  next.holdings = [{ticker: "CASH", type: "cash", value: 20}, ...snapshot.positions.map(row => ({ticker: row.ticker, type: "stock", shares: row.shares}))];
  applyPositionLifecycle(next, previous, snapshot, p); return next;
}
function baseline() {const {previous,snapshot}=fixture();return {previous:apply(previous,snapshot),snapshot};}
function failure(code, mutate) {
  const {previous,snapshot}=baseline();mutate(previous,snapshot);
  const next=copy(previous);next.tradeSync=sync(snapshot);const before=copy(next);
  assert.throws(()=>applyPositionLifecycle(next,previous,snapshot,policy),{code});assert.deepEqual(next,before);
}

test("bootstrap is silent and preserves all trading, prices, income and history",()=>{
  const {previous,snapshot}=fixture(), saved=copy(previous), next=apply(previous,snapshot);
  assert.deepEqual(positionEffects(previous,next),[]);assert.deepEqual(next.positionLifecycle.events,[]);
  assert.equal(next.positionLifecycle.positions[0].firstKnownBuyDate,null);
  assert.deepEqual(next.trading,previous.trading);assert.deepEqual(next.historySnapshot,previous.historySnapshot);assert.deepEqual(next.income,previous.income);
  assert.deepEqual(previous,saved);assert.doesNotMatch(JSON.stringify(next.positionLifecycle),/synthetic-/);
});
test("bootstrap must match existing holdings and requires approved full brokerage scope",()=>{
  const {previous,snapshot}=fixture();snapshot.positions[0].shares=6;
  assert.throws(()=>apply(previous,snapshot),{code:"POSITION_BASELINE_MISMATCH"});
  const f=fixture();assert.throws(()=>apply(f.previous,f.snapshot,{positionAccountIds:["other"]}),{code:"POSITION_ACCOUNT_SCOPE_MISMATCH"});
});
test("new position emits one opened event from its true source buy date",()=>{
  const {previous,snapshot}=baseline(), row=order({ticker:"NEW",securityId:"synthetic-security-new"});
  snapshot.tradeUpdates.rows=[row];snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:"NEW",shares:2});
  const next=apply(previous,snapshot), effects=positionEffects(previous,next);
  assert.equal(effects.length,1);assert.equal(effects[0].kind,"opened");assert.equal(effects[0].date,row.date);assert.equal(effects[0].firstKnownBuyDate,row.date);
  assert.deepEqual(Object.keys(effects[0]).sort(),["date","firstKnownBuyDate","id","kind","ticker"]);
  assert.deepEqual(next.trading,previous.trading);
});
test("full sale closes a position; partial sale produces no event",()=>{
  for(const shares of [2,5]){
    const {previous,snapshot}=baseline();snapshot.tradeUpdates.rows=[order({side:"sell",shares,amountCents:-shares*1100})];
    snapshot.positions=shares===5?[]:[{...snapshot.positions[0],shares:5-shares}];
    const next=apply(previous,snapshot),events=positionEffects(previous,next);
    assert.equal(events.length,shares===5?1:0);if(shares===5){assert.equal(events[0].kind,"closed");assert.equal(next.positionLifecycle.positions[0].status,"closed");}
    assert.deepEqual(next.trading,previous.trading);
  }
});
test("known closed identities reopen and retain earliest true buy date",()=>{
  const {previous,snapshot}=fixture();snapshot.tradeUpdates.rows=[order({securityId:"synthetic-exited",ticker:"OLD",date:"2024-11-01",sourceId:"historical-buy"})];
  const first=apply(previous,snapshot);assert.equal(first.positionLifecycle.positions.find(p=>p.ticker==="OLD").status,"closed");
  const row=order({securityId:"synthetic-exited",ticker:"OLD",sourceId:"reopen"});snapshot.tradeUpdates.rows.push(row);
  snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:row.ticker,shares:row.shares});
  const next=apply(first,snapshot),event=positionEffects(first,next)[0];
  assert.equal(event.kind,"reopened");assert.equal(event.firstKnownBuyDate,"2024-11-01");assert.equal(event.date,row.date);
});
test("legacy true orders mark a newly identified security as reopened without inventing a buy date",()=>{
  const {previous,snapshot}=baseline();previous.trading.OLD={orders:[{date:"2024-10-01",side:"sell",shares:1,price:8}]};
  const row=order({securityId:"synthetic-old-id",ticker:"OLD"});snapshot.tradeUpdates.rows=[row];
  snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:row.ticker,shares:2});
  const event=positionEffects(previous,apply(previous,snapshot))[0];
  assert.equal(event.kind,"reopened");assert.equal(event.firstKnownBuyDate,row.date);
});
test("missing holdings without exact sell evidence fail rather than announce a close",()=>{
  failure("POSITION_QUANTITY_UNEXPLAINED",(_,s)=>{s.positions=[];});
  failure("POSITION_QUANTITY_UNEXPLAINED",(_,s)=>{s.positions=[];s.tradeUpdates.rows=[order({side:"sell",shares:4,amountCents:-4400})];});
});
test("missing or incomplete account, holding and trade pages fail",()=>{
  failure("POSITION_INCOMPLETE_ACCOUNTS",(_,s)=>{s.coverage.allPagesFetched=false;});
  failure("POSITION_INCOMPLETE_HOLDINGS",(_,s)=>{s.accounts[0].coverage.holdings.complete=false;});
  failure("POSITION_INCOMPLETE_TRADES",(_,s)=>{s.tradeUpdates.allPagesFetched=false;});
  failure("POSITION_ACCOUNT_SCOPE_MISMATCH",(_,s)=>{s.accounts=[];});
});
test("security renames and same-ticker replacement identities require review",()=>{
  failure("POSITION_IDENTITY_CHANGED",(_,s)=>{s.positions[0].ticker="RENAMED";});
  failure("POSITION_SECURITY_CHANGED",(_,s)=>{s.positions[0].securityId="replacement-id";});
});
test("duplicate identities or source trades fail",()=>{
  failure("POSITION_DUPLICATE_OR_INVALID_HOLDING",(_,s)=>{s.positions.push(copy(s.positions[0]));});
  failure("POSITION_INVALID_TRADE_SYNC",(_,s)=>{s.tradeUpdates.rows=[order(),order()];});
});
test("repeat is stable and does not emit an event again",()=>{
  const {previous,snapshot}=baseline(),row=order({securityId:"new-id",ticker:"NEW"});
  snapshot.tradeUpdates.rows=[row];snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:row.ticker,shares:2});
  const first=apply(previous,snapshot),second=apply(first,snapshot);
  assert.deepEqual(second,first);assert.deepEqual(positionEffects(first,second),[]);
  assert.deepEqual(first.trading,previous.trading);
});
test("existing synchronized trades cannot disappear",()=>{
  const {previous,snapshot}=baseline();snapshot.tradeUpdates.rows=[order()];snapshot.positions[0].shares=7;
  const first=apply(previous,snapshot);snapshot.tradeUpdates.rows=[];
  assert.throws(()=>apply(first,snapshot),{code:"POSITION_TRADE_HISTORY_CHANGED"});
});
test("disabled fresh ledger is a no-op but an existing ledger cannot lose approval",()=>{
  const {previous,snapshot}=fixture(),next=copy(previous);
  assert.equal(applyPositionLifecycle(next,previous,snapshot,{}),next);assert.deepEqual(next,previous);
  const started=baseline();assert.throws(()=>apply(started.previous,started.snapshot,{}),{code:"POSITION_ACCOUNT_POLICY_REQUIRED"});
});
test("multiple brokerage accounts stop for explicit review before producing ambiguous events",()=>{
  const {previous,snapshot}=fixture();
  assert.throws(()=>apply(previous,snapshot,{positionAccountIds:[account,"synthetic-second-broker"]}),
    {code:"POSITION_MULTIPLE_BROKERAGE_REQUIRES_REVIEW"});
});
test("a newly observed source identity with an old real buy is reopened",()=>{
  const {previous,snapshot}=baseline(), row=order({securityId:"returning-id",ticker:"OLD",sourceId:"new-buy"});
  snapshot.tradeUpdates.rows=[order({...row,date:"2024-12-01",sourceId:"old-buy"}),row];
  snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:row.ticker,shares:2});
  const event=positionEffects(previous,apply(previous,snapshot))[0];
  assert.equal(event.kind,"reopened");assert.equal(event.firstKnownBuyDate,"2024-12-01");assert.equal(event.date,row.date);
});
test("source and position order do not change deterministic appended events",()=>{
  const {previous,snapshot}=baseline();
  for(const symbol of ["AAA","ZZZ"]){
    const row=order({sourceId:symbol,securityId:symbol,ticker:symbol});snapshot.tradeUpdates.rows.push(row);
    snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:symbol,shares:2});
  }
  const first=apply(previous,snapshot);snapshot.positions.reverse();snapshot.tradeUpdates.rows.reverse();
  const second=apply(previous,snapshot);
  assert.deepEqual(second.positionLifecycle,first.positionLifecycle);
  assert.deepEqual(positionEffects(previous,second),positionEffects(previous,first));
});
test("opened and reopened stored events require a real first buy date no later than the event",()=>{
  const {previous,snapshot}=baseline(),row=order({securityId:"event-id",ticker:"NEW"});
  snapshot.tradeUpdates.rows=[row];snapshot.positions.push({accountId:account,securityId:row.securityId,ticker:row.ticker,shares:2});
  const first=apply(previous,snapshot);
  for(const firstKnownBuyDate of [null,"2025-01-12","2025-02-30"]){
    const damaged=copy(first);damaged.positionLifecycle.events[0].firstKnownBuyDate=firstKnownBuyDate;
    assert.throws(()=>apply(damaged,snapshot),{code:firstKnownBuyDate==="2025-02-30"?"POSITION_INVALID_DATE":"POSITION_INVALID_EVENTS"});
  }
});
test("raw source economics must match the already merged tradeSync digest",()=>{
  const {previous,snapshot}=baseline();snapshot.tradeUpdates.rows=[order()];snapshot.positions[0].shares=7;
  const next=copy(previous);next.tradeSync=sync(snapshot);const saved=copy(next);snapshot.tradeUpdates.rows[0].price=12;
  assert.throws(()=>applyPositionLifecycle(next,previous,snapshot,policy),{code:"POSITION_TRADE_SOURCE_CHANGED"});
  assert.deepEqual(next,saved);
});
test("malformed baseline rows and missing stable security identities fail closed",()=>{
  const {previous,snapshot}=fixture();previous.holdings.push(null);
  assert.throws(()=>apply(previous,snapshot),{code:"POSITION_BASELINE_HOLDINGS_REQUIRED"});
  failure("POSITION_INVALID_ID",(_,s)=>{delete s.positions[0].securityId;});
  failure("POSITION_INVALID_ID",(_,s)=>{s.tradeUpdates.rows=[order()];delete s.tradeUpdates.rows[0].securityId;});
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sourceOrder(row) {
  return {id: hash(JSON.stringify([row.accountId, row.sourceId])), date: row.date, side: row.side, shares: row.shares, price: row.price};
}
function openingFixture() {
  const f = fixture(); f.previous.trading.DEMO.orders[0].shares = 2;
  f.previous.historySnapshot = {asOf: "2025-01-10", holdings: copy(f.previous.holdings), trading: copy(f.previous.trading), income: copy(f.previous.income)};
  return {previous: apply(f.previous, f.snapshot), snapshot: f.snapshot};
}
function openingPolicy(previous) {
  return previous.openingPositionAudit ? policy : {...policy, openingPositionAuthorization: {
    version: 1, authorizationRef: "synthetic-opening-consent", historySha256: hash(canonical(previous.historySnapshot))}};
}
function openingCandidate(previous, snapshot, appended = []) {
  const next = copy(previous); next.tradeSync = sync(snapshot);
  next.holdings = [{ticker: "CASH", type: "cash", value: 20}, ...snapshot.positions.map(row => ({ticker: row.ticker, type: "stock", shares: row.shares}))];
  for (const row of appended) {
    next.trading[row.ticker] ||= {orders: []};
    next.trading[row.ticker].orders.push(sourceOrder(row));
  }
  applyOpeningPositions(next, previous, snapshot, openingPolicy(previous));
  return next;
}
function openingApply(previous, snapshot, appended = []) {
  const next = openingCandidate(previous, snapshot, appended);
  applyPositionLifecycle(next, previous, snapshot, openingPolicy(previous)); return next;
}
function openingBaseline() {
  const f = openingFixture(); return {previous: openingApply(f.previous, f.snapshot), snapshot: f.snapshot};
}
function positionRejects(next, previous, snapshot, code, consent = openingPolicy(previous)) {
  const before = copy(next), old = copy(previous);
  assert.throws(() => applyPositionLifecycle(next, previous, snapshot, consent), {code});
  assert.deepEqual(next, before); assert.deepEqual(previous, old);
}

test("verified opening migration reconciles only positive quantities and is completely silent", () => {
  for (const importedAlready of [false, true]) {
    const {previous, snapshot} = openingFixture(), row = order();
    previous.trading.DEMO.orders.push(sourceOrder(row));
    snapshot.tradeUpdates.rows = [row]; snapshot.positions[0].shares = 7;
    if (importedAlready) previous.tradeSync = sync(snapshot);
    const old = copy(previous), next = openingApply(previous, snapshot);
    assert.equal(next.positionLifecycle.positions[0].shares, 7);
    assert.deepEqual(positionEffects(previous, next), []);
    assert.deepEqual(next.positionLifecycle.events, previous.positionLifecycle.events);
    assert.deepEqual(next.trading.DEMO.orders, previous.trading.DEMO.orders);
    assert.deepEqual(next.trading.DEMO.prices, previous.trading.DEMO.prices);
    assert.deepEqual(next.historySnapshot, previous.historySnapshot);
    assert.deepEqual(next.income, previous.income); assert.deepEqual(previous, old);
  }
});
test("opening is never a real buy date and a retry preserves the ledger exactly", () => {
  const {previous, snapshot} = openingBaseline();
  assert.equal(previous.trading.DEMO.openingPosition.shares, 3);
  assert.equal(previous.positionLifecycle.positions[0].firstKnownBuyDate, null);
  const next = openingApply(previous, snapshot);
  assert.deepEqual(next, previous); assert.deepEqual(positionEffects(previous, next), []);
});
test("standalone migration requires the exact authorization bound to the validated audit", () => {
  for (const mutate of [
    p => {delete p.openingPositionAuthorization;},
    p => {p.openingPositionAuthorization.version = 2;},
    p => {p.openingPositionAuthorization.authorizationRef = "synthetic-unrelated-consent";},
    p => {p.openingPositionAuthorization.historySha256 = "0".repeat(64);},
    p => {p.openingPositionAuthorization.extra = true;}
  ]) {
    const {previous, snapshot} = openingFixture(), next = openingCandidate(previous, snapshot), consent = openingPolicy(previous);
    mutate(consent); positionRejects(next, previous, snapshot, "POSITION_OPENING_AUTHORIZATION_REQUIRED", consent);
  }
});
test("migration rejects open and closed status changes even with fully proved new orders", () => {
  for (const close of [false, true]) {
    const {previous, snapshot} = openingFixture();
    const row = close ? order({side: "sell", shares: 5, amountCents: -5500}) : order({ticker: "NEW", securityId: "synthetic-new-position"});
    snapshot.tradeUpdates.rows = [row];
    snapshot.positions = close ? [] : [...snapshot.positions, {accountId: account, securityId: row.securityId, ticker: row.ticker, shares: row.shares}];
    const next = openingCandidate(previous, snapshot, [row]);
    positionRejects(next, previous, snapshot, "POSITION_OPENING_MIGRATION_STATE_CHANGED");
  }
});
test("migration validates full quantities itself and cannot absorb a post-anchor gap", () => {
  const {previous, snapshot} = openingFixture(), next = openingCandidate(previous, snapshot);
  snapshot.positions[0].shares += 1; next.holdings[1].shares += 1;
  positionRejects(next, previous, snapshot, "OPENING_CURRENT_QUANTITY_MISMATCH");
});
test("an audit flag alone cannot bypass opening, identity, scope or coverage checks", () => {
  for (const [mutate, code] of [
    [(n) => {n.openingPositionAudit = {version: 1};}, "OPENING_AUDIT_INVALID"],
    [(n) => {n.trading.DEMO.openingPosition.shares += 1;}, "OPENING_POSITION_CHANGED"],
    [(_, s) => {s.accounts[0].coverage.holdings.complete = false;}, "POSITION_INCOMPLETE_HOLDINGS"],
    [(_, s) => {s.tradeUpdates.allPagesFetched = false;}, "POSITION_INCOMPLETE_TRADES"],
    [(_, s) => {s.positions[0].securityId = "different-security";}, "POSITION_SECURITY_CHANGED"],
    [(_, s) => {s.positions[0].accountId = "different-account";}, "POSITION_ACCOUNT_SCOPE_MISMATCH"]
  ]) {
    const {previous, snapshot} = openingFixture(), next = openingCandidate(previous, snapshot);
    mutate(next, snapshot); positionRejects(next, previous, snapshot, code);
  }
});
test("after migration actual appended buys, partial sales and full sales drive quantities", () => {
  for (const [side, shares, after, count] of [["buy", 2, 7, 0], ["sell", 2, 3, 0], ["sell", 5, 0, 1]]) {
    const {previous, snapshot} = openingBaseline(), row = order({side, shares, amountCents: shares * 1100 * (side === "buy" ? 1 : -1)});
    snapshot.tradeUpdates.rows = [row]; snapshot.positions = after ? [{...snapshot.positions[0], shares: after}] : [];
    const next = openingApply(previous, snapshot, [row]), effects = positionEffects(previous, next);
    assert.equal(effects.length, count);
    if (count) {assert.equal(effects[0].kind, "closed"); assert.equal(effects[0].firstKnownBuyDate, null); assert.equal(effects[0].date, row.date);}
    assert.deepEqual(next.trading.DEMO.orders.slice(0, -1), previous.trading.DEMO.orders);
    assert.deepEqual(next.trading.DEMO.prices, previous.trading.DEMO.prices);
    assert.deepEqual(next.openingPositionAudit, previous.openingPositionAudit);
    assert.deepEqual(next.historySnapshot, previous.historySnapshot);
  }
});
test("after migration new and reopened positions require real source buys, never opening shares", () => {
  let {previous, snapshot} = openingBaseline();
  const buy = order({ticker: "NEW", securityId: "synthetic-new-position", sourceId: "synthetic-open"});
  snapshot.tradeUpdates.rows.push(buy); snapshot.positions.push({accountId: account, securityId: buy.securityId, ticker: buy.ticker, shares: buy.shares});
  const opened = openingApply(previous, snapshot, [buy]);
  assert.equal(positionEffects(previous, opened)[0].kind, "opened");
  assert.equal(opened.trading.NEW.openingPosition, undefined);
  const sell = order({...buy, sourceId: "synthetic-close", date: "2025-01-12", side: "sell", amountCents: -2200});
  snapshot.tradeUpdates.rows.push(sell); snapshot.positions = snapshot.positions.filter(p => p.ticker !== "NEW");
  const closed = openingApply(opened, snapshot, [sell]);
  assert.equal(positionEffects(opened, closed)[0].kind, "closed");
  const reopen = order({...buy, sourceId: "synthetic-reopen", date: "2025-01-13"});
  snapshot.tradeUpdates.rows.push(reopen); snapshot.positions.push({accountId: account, securityId: buy.securityId, ticker: buy.ticker, shares: buy.shares});
  const next = openingApply(closed, snapshot, [reopen]), effects = positionEffects(closed, next);
  assert.equal(effects[0].kind, "reopened"); assert.equal(effects[0].firstKnownBuyDate, buy.date); assert.equal(effects[0].date, reopen.date);
  assert.deepEqual(next.positionLifecycle.events.slice(0, -1), closed.positionLifecycle.events);
  assert.deepEqual(positionEffects(next, openingApply(next, snapshot)), []);
});
test("a newly imported ID without an appended real order does not imply a quantity change", () => {
  const {previous, snapshot} = openingBaseline(), row = order(); snapshot.tradeUpdates.rows = [row];
  const next = openingApply(previous, snapshot);
  assert.equal(next.tradeSync.transactions.length, 1);
  assert.deepEqual(next.trading, previous.trading); assert.deepEqual(positionEffects(previous, next), []);
  assert.equal(next.positionLifecycle.positions[0].shares, previous.positionLifecycle.positions[0].shares);
});
test("a previously imported ID counts when its real order is appended for the first time", () => {
  const {previous, snapshot} = openingBaseline(), row = order(); snapshot.tradeUpdates.rows = [row];
  previous.tradeSync = sync(snapshot); snapshot.positions[0].shares += row.shares;
  const next = openingApply(previous, snapshot, [row]);
  assert.deepEqual(next.tradeSync, previous.tradeSync); assert.equal(next.positionLifecycle.positions[0].shares, 7);
  assert.deepEqual(positionEffects(previous, next), []);
});
test("an observed but unapplied identity does not turn its first actual buy into a reopening", () => {
  const {previous, snapshot} = openingBaseline(), row = order({ticker: "NEW", securityId: "synthetic-observed-only"});
  snapshot.tradeUpdates.rows = [row];
  const observed = openingApply(previous, snapshot);
  assert.equal(observed.positionLifecycle.positions.find(p => p.ticker === "NEW").status, "closed");
  assert.equal(observed.trading.NEW, undefined); assert.deepEqual(positionEffects(previous, observed), []);
  snapshot.positions.push({accountId: account, securityId: row.securityId, ticker: row.ticker, shares: row.shares});
  const next = openingApply(observed, snapshot, [row]), event = positionEffects(observed, next)[0];
  assert.equal(event.kind, "opened"); assert.equal(event.firstKnownBuyDate, row.date); assert.equal(event.date, row.date);
  assert.deepEqual(next.tradeSync, observed.tradeSync);
});
test("a true pre-cutoff source buy remains evidence of an earlier position", () => {
  const {previous, snapshot} = openingBaseline(), row = order({ticker: "OLD", securityId: "synthetic-old-source"});
  snapshot.tradeUpdates.rows = [order({...row, sourceId: "synthetic-old-buy", date: "2024-11-01"}), row];
  snapshot.positions.push({accountId: account, securityId: row.securityId, ticker: row.ticker, shares: row.shares});
  const next = openingApply(previous, snapshot, [row]), event = positionEffects(previous, next)[0];
  assert.equal(event.kind, "reopened"); assert.equal(event.firstKnownBuyDate, "2024-11-01");
});
test("opening proof rejects unsupported quantity changes and still validates the previous full baseline", () => {
  const f = openingBaseline(), next = copy(f.previous); f.snapshot.positions[0].shares += 1;
  positionRejects(next, f.previous, f.snapshot, "OPENING_CURRENT_QUANTITY_MISMATCH");
  const g = openingBaseline(), candidate = copy(g.previous);
  g.previous.holdings[1].shares += 1; g.previous.positionLifecycle.positions[0].shares += 1;
  positionRejects(candidate, g.previous, g.snapshot, "OPENING_CURRENT_QUANTITY_MISMATCH");
});
test("opening audit, history and all existing order fields remain immutable", () => {
  for (const [mutate, code] of [
    [n => {delete n.openingPositionAudit;}, "POSITION_OPENING_AUDIT_CHANGED"],
    [n => {n.openingPositionAudit.authorizationRef = "synthetic-other-consent";}, "POSITION_OPENING_AUDIT_CHANGED"],
    [n => {n.historySnapshot.income[0].amount += 1;}, "POSITION_TRADING_HISTORY_CHANGED"],
    [n => {n.trading.DEMO.orders[0].price += 1;}, "OPENING_LEGACY_ORDERS_CHANGED"]
  ]) {
    const {previous, snapshot} = openingBaseline(), next = copy(previous); mutate(next);
    positionRejects(next, previous, snapshot, code);
  }
  const f = openingBaseline(), row = order(); f.snapshot.tradeUpdates.rows = [row]; f.snapshot.positions[0].shares += row.shares;
  const previous = openingApply(f.previous, f.snapshot, [row]), next = copy(previous);
  next.trading.DEMO.orders.at(-1).price += 1;
  positionRejects(next, previous, f.snapshot, "POSITION_TRADING_HISTORY_CHANGED");
});
test("appended raw orders must bind one-to-one to the complete stable-ID source", () => {
  for (const mutate of [
    n => {n.trading.DEMO.orders.at(-1).id = "0".repeat(64);},
    n => {n.trading.DEMO.orders.at(-1).price += 1;},
    n => {n.trading.DEMO.orders.at(-1).date = "2025-01-12";}
  ]) {
    const {previous, snapshot} = openingBaseline(), row = order(); snapshot.tradeUpdates.rows = [row]; snapshot.positions[0].shares += row.shares;
    const next = openingCandidate(previous, snapshot, [row]); mutate(next);
    positionRejects(next, previous, snapshot, "POSITION_ORDER_SOURCE_MISMATCH");
  }
  const {previous, snapshot} = openingBaseline(), row = order(); snapshot.tradeUpdates.rows = [row]; snapshot.positions[0].shares += row.shares * 2;
  const next = openingCandidate(previous, snapshot, [row, row]);
  positionRejects(next, previous, snapshot, "POSITION_ORDER_SOURCE_MISMATCH");
  const legacy = openingFixture(), duplicate = order();
  legacy.previous.trading.DEMO.orders[0].id = sourceOrder(duplicate).id;
  legacy.previous.historySnapshot.trading.DEMO.orders[0].id = sourceOrder(duplicate).id;
  legacy.snapshot.tradeUpdates.rows = [duplicate]; legacy.snapshot.positions[0].shares += duplicate.shares;
  positionRejects(openingCandidate(legacy.previous, legacy.snapshot, [duplicate]), legacy.previous, legacy.snapshot, "POSITION_ORDER_SOURCE_MISMATCH");
});
test("audited paths retain complete source digest and prior-ID protection", () => {
  const f = openingBaseline(), row = order(); f.snapshot.tradeUpdates.rows = [row]; f.snapshot.positions[0].shares += row.shares;
  const next = openingCandidate(f.previous, f.snapshot, [row]); f.snapshot.tradeUpdates.rows[0].amountCents += 1;
  positionRejects(next, f.previous, f.snapshot, "POSITION_TRADE_SOURCE_CHANGED");
  f.snapshot.tradeUpdates.rows[0].amountCents -= 1;
  const previous = openingApply(f.previous, f.snapshot, [row]); f.snapshot.tradeUpdates.rows = [];
  const missing = copy(previous); missing.tradeSync = sync(f.snapshot);
  positionRejects(missing, previous, f.snapshot, "POSITION_TRADE_HISTORY_CHANGED");
});
