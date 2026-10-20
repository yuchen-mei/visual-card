"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const O = require("./finances_opening.cjs");
const copy = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const order = (date, side, shares, extra = {}) => ({date, side, shares, price: 10, ...extra});
function fixture(changeAnchor = () => {}) {
  const anchor = {asOf: "2024-06-30", holdings: [{ticker: "CASH", type: "cash", value: 20}, {ticker: "DEMO", type: "stock", shares: 10}],
    performance: {totalPrincipal: 80, totalGain: 5}, income: [{date: "2024-05-01", amount: 2}],
    trading: {
      DEMO: {nameZh: "合成证券", prices: [{date: "2024-06-28", close: 10}], orders: [order("2024-01-15", "buy", 3, {id: "legacy-buy", note: "synthetic"}), order("2024-05-10", "sell", 1)]},
      CLOSED: {orders: [order("2024-02-01", "buy", 2), order("2024-03-01", "sell", 2)]}
    }};
  changeAnchor(anchor);
  const previous = {historySnapshot: copy(anchor), trading: copy(anchor.trading), tradeSync: {version: 1, baselineCutoff: anchor.asOf},
    holdings: copy(anchor.holdings), performance: copy(anchor.performance), income: copy(anchor.income),
    manualCapital: {amountCents: 8000, updatePolicy: "explicit-user-only"}};
  previous.trading.DEMO.orders.push(order("2024-07-20", "buy", 1, {id: "observed-after-anchor"}));
  const shares = anchor.holdings.find(row => row.ticker === "DEMO").shares + 1;
  const snapshot = {positions: [{accountId: "synthetic-a", ticker: "DEMO", shares: shares / 2}, {accountId: "synthetic-b", ticker: "DEMO", shares: shares / 2}]};
  const policy = {openingPositionAuthorization: {version: 1, authorizationRef: "synthetic-user-message", historySha256: hash(anchor)}};
  return {previous, next: copy(previous), snapshot, policy};
}
function apply(f) { return O.applyOpeningPositions(f.next, f.previous, f.snapshot, f.policy); }
function rejects(f, code) {
  const before = canonical(f.next);
  assert.throws(() => apply(f), error => error instanceof O.OpeningError && error.code === code && error.message === code);
  assert.equal(canonical(f.next), before);
}
function initialized() { const f = fixture(); return {data: apply(f), snapshot: f.snapshot, policy: f.policy}; }
test("default without approval or audit is an exact no-op", () => {
  const previous = {opaque: "synthetic"}, next = copy(previous), before = canonical(next);
  assert.equal(O.applyOpeningPositions(next, previous, {}, {}), next);
  assert.equal(O.validateOpeningQuantities(next, {}), next);
  assert.equal(canonical(next), before);
});
test("authorized opening uses only the pinned anchor and leaves old fields and orders untouched", () => {
  const f = fixture(), previousBytes = canonical(f.previous), before = copy(f.next), next = apply(f);
  assert.equal(next, f.next);
  assert.deepEqual(next.trading.DEMO.openingPosition, {version: 1, asOf: "2023-12-31", shares: 8});
  assert.equal(next.trading.CLOSED.openingPosition, undefined);
  assert.deepEqual(next.openingPositionAudit, {version: 1, method: "user-authorized-opening-estimate", authorizationRef: "synthetic-user-message",
    anchorAsOf: "2024-06-30", dateBasis: "saved-snapshot-date-source-time-unknown", historySha256: hash(f.previous.historySnapshot),
    legacyOrdersDigest: hash(["CLOSED", "DEMO"].map(ticker => ({ticker, orders: f.previous.historySnapshot.trading[ticker].orders}))),
    positions: [{ticker: "CLOSED", openingDate: "2023-12-31", shares: 0, anchorShares: 0, legacyNetShares: 0},
      {ticker: "DEMO", openingDate: "2023-12-31", shares: 8, anchorShares: 10, legacyNetShares: 2}]});
  for (const symbol of Object.keys(before.trading)) {
    assert.deepEqual(next.trading[symbol].orders, before.trading[symbol].orders);
    const withoutOpening = copy(next.trading[symbol]); delete withoutOpening.openingPosition;
    assert.deepEqual(withoutOpening, before.trading[symbol]);
  }
  for (const key of ["historySnapshot", "holdings", "performance", "income", "manualCapital", "tradeSync"]) assert.deepEqual(next[key], before[key]);
  assert.equal(canonical(f.previous), previousBytes);
});
test("repeat updates preserve exact opening and audit bytes with or without the same authorization", () => {
  const {data, snapshot, policy} = initialized(), before = canonical(data);
  for (const consent of [{}, policy]) {
    const next = copy(data);
    assert.equal(O.applyOpeningPositions(next, data, snapshot, consent), next);
    assert.equal(canonical(next), before);
    assert.equal(canonical(data), before);
  }
});
test("an older post-cutoff source order does not change the opening estimate", () => {
  const {data, snapshot} = initialized(), next = copy(data), originalOpening = copy(data.trading.DEMO.openingPosition);
  next.trading.DEMO.orders.push(order("2024-07-10", "buy", 1, {id: "synthetic-late-source-row"}));
  const current = copy(snapshot); current.positions[0].shares += 1;
  O.applyOpeningPositions(next, data, current, {});
  assert.deepEqual(next.trading.DEMO.openingPosition, originalOpening);
  assert.deepEqual(next.openingPositionAudit, data.openingPositionAudit);
  assert.deepEqual(next.trading.DEMO.orders.slice(0, -1), data.trading.DEMO.orders);
});
test("late pre-cutoff rows and current quantity gaps cannot be hidden in opening shares", () => {
  const {data, snapshot} = initialized();
  const late = {previous: data, next: copy(data), snapshot: copy(snapshot), policy: {}};
  late.next.trading.DEMO.orders.push(order("2024-06-20", "buy", 1)); late.snapshot.positions[0].shares += 1;
  rejects(late, "OPENING_LATE_LEGACY_ORDER_REQUIRES_REVIEW");
  const gap = {previous: data, next: copy(data), snapshot: copy(snapshot), policy: {}};
  gap.snapshot.positions[0].shares += 2;
  rejects(gap, "OPENING_CURRENT_QUANTITY_MISMATCH");
  const first = fixture(); first.snapshot.positions[0].shares += 2;
  rejects(first, "OPENING_CURRENT_QUANTITY_MISMATCH");
});
test("negative initial residual rejects while floating point tolerance is not a new opening", () => {
  rejects(fixture(anchor => {anchor.holdings[1].shares = 1;}), "OPENING_NEGATIVE_INITIAL_POSITION");
  const f = fixture(anchor => {anchor.holdings[1].shares = 0.3; anchor.trading.DEMO.orders = [order("2024-01-15", "buy", 0.1), order("2024-05-10", "buy", 0.2)];});
  const next = apply(f);
  assert.equal(next.trading.DEMO.openingPosition, undefined);
  assert.equal(next.openingPositionAudit.positions.find(position => position.ticker === "DEMO").shares, 0);
});
test("daily negatives reject but same-day netting never invents intraday order", () => {
  const negative = fixture(anchor => {anchor.holdings[1].shares = 2; anchor.trading.DEMO.orders = [order("2024-02-01", "sell", 3), order("2024-03-01", "buy", 3)];});
  rejects(negative, "OPENING_NEGATIVE_DAILY_POSITION");
  const sameDay = fixture(anchor => {anchor.holdings[1].shares = 2; anchor.trading.DEMO.orders = [order("2024-02-01", "sell", 3), order("2024-02-01", "buy", 3)];});
  assert.doesNotThrow(() => apply(sameDay));
});
test("complete closure retains all closed tickers and their real orders", () => {
  const {data} = initialized(), next = copy(data);
  next.trading.DEMO.orders.push(order("2024-08-01", "sell", 11, {id: "synthetic-close"}));
  O.applyOpeningPositions(next, data, {positions: []}, {});
  assert.deepEqual(Object.keys(next.trading).sort(), ["CLOSED", "DEMO"]);
  assert.deepEqual(next.openingPositionAudit, data.openingPositionAudit);
  assert.equal(next.trading.DEMO.openingPosition.shares, 8);
  const removed = {previous: next, next: copy(next), snapshot: {positions: []}, policy: {}};
  delete removed.next.trading.CLOSED;
  rejects(removed, "OPENING_LEGACY_ORDERS_CHANGED");
});
test("opening-only holdings use the year before the anchor without generating an order or price", () => {
  const anchor = {asOf: "2024-06-30", holdings: [{ticker: "ONLY", type: "etf", shares: 7}], trading: {}};
  const previous = {historySnapshot: anchor, tradeSync: {baselineCutoff: anchor.asOf}, trading: {}};
  const next = copy(previous), snapshot = {positions: [{ticker: "ONLY", shares: 3}, {ticker: "ONLY", shares: 4}]};
  O.applyOpeningPositions(next, previous, snapshot, {openingPositionAuthorization: {version: 1, authorizationRef: "synthetic-opening-only", historySha256: hash(anchor)}});
  assert.deepEqual(next.trading.ONLY, {orders: [], openingPosition: {version: 1, asOf: "2023-12-31", shares: 7}});
  assert.deepEqual(previous.trading, {}); assert.deepEqual(next.historySnapshot, anchor);
});
test("both immutable legacy prefixes and all order fields are audited", () => {
  const current = fixture(); current.next.trading.DEMO.orders[0].price += 1;
  rejects(current, "OPENING_LEGACY_ORDERS_CHANGED");
  const anchorMismatch = fixture(); anchorMismatch.previous.trading.DEMO.orders[0].note = "different"; anchorMismatch.next = copy(anchorMismatch.previous);
  rejects(anchorMismatch, "OPENING_LEGACY_ORDERS_CHANGED");
  const swapped = fixture(); swapped.next.trading.DEMO.orders.reverse();
  rejects(swapped, "OPENING_LEGACY_ORDERS_CHANGED");
});
test("authorization, immutable history, audit and opening changes are rejected", () => {
  const {data, snapshot, policy} = initialized();
  const cases = [
    [f => {f.policy.openingPositionAuthorization.authorizationRef = "different-user-message";}, "OPENING_AUTHORIZATION_CHANGED"],
    [f => {f.policy.openingPositionAuthorization.historySha256 = "0".repeat(64);}, "OPENING_HISTORY_HASH_MISMATCH"],
    [f => {f.next.openingPositionAudit.positions[1].shares += 1;}, "OPENING_AUDIT_CHANGED"],
    [f => {f.next.trading.DEMO.openingPosition.shares += 1;}, "OPENING_POSITION_CHANGED"],
    [f => {f.next.historySnapshot.income[0].amount += 1;}, "OPENING_HISTORY_CHANGED"],
    [f => {f.previous.historySnapshot.income[0].amount += 1; f.next.historySnapshot = copy(f.previous.historySnapshot);}, "OPENING_AUDIT_INVALID"],
    [f => {delete f.next.openingPositionAudit;}, "OPENING_AUDIT_CHANGED"]
  ];
  for (const [change, code] of cases) {
    const f = {previous: copy(data), next: copy(data), snapshot: copy(snapshot), policy: copy(policy)};
    change(f); rejects(f, code);
  }
});
test("first application rejects a missing old cutoff, invalid orders, bad approval or preexisting opening", () => {
  for (const [change, code] of [
    [f => {delete f.previous.tradeSync;}, "OPENING_ANCHOR_CUTOFF_MISMATCH"],
    [f => {f.previous.tradeSync.baselineCutoff = "2024-06-29";}, "OPENING_ANCHOR_CUTOFF_MISMATCH"],
    [f => {f.policy.openingPositionAuthorization.authorizationRef = "  ";}, "OPENING_AUTHORIZATION_INVALID"],
    [f => {f.next.trading.DEMO.openingPosition = {version: 1, asOf: "2023-12-31", shares: 8};}, "OPENING_EXISTING_POSITION"]
  ]) {const f = fixture(); change(f); rejects(f, code);}
  for (const change of [order => {order.side = "transfer";}, order => {order.shares = 0;}, order => {order.shares = Infinity;}, order => {order.date = "2024-02-30";}, order => {order.date = "2024-07-01";}]) {
    const f = fixture(anchor => {change(anchor.trading.DEMO.orders[0]);});
    assert.throws(() => apply(f), O.OpeningError);
  }
});
test("new securities require real post-cutoff orders and cannot receive an unapproved opening", () => {
  const {data, snapshot} = initialized(), next = copy(data), current = copy(snapshot);
  next.trading.NEW = {orders: [order("2024-08-01", "buy", 2, {id: "synthetic-new"})]};
  current.positions.push({ticker: "NEW", shares: 2});
  O.applyOpeningPositions(next, data, current, {});
  assert.equal(next.trading.NEW.openingPosition, undefined);
  const bad = {previous: next, next: copy(next), snapshot: current, policy: {}};
  bad.next.trading.NEW.openingPosition = {version: 1, asOf: "2023-12-31", shares: 1};
  rejects(bad, "OPENING_POSITION_CHANGED");
  const missing = {previous: data, next: copy(data), snapshot: current, policy: {}};
  rejects(missing, "OPENING_CURRENT_QUANTITY_MISMATCH");
});
test("standalone quantity validation verifies the audit instead of trusting its presence", () => {
  const {data, snapshot} = initialized();
  const tampered = copy(data); tampered.openingPositionAudit.legacyOrdersDigest = "0".repeat(64);
  assert.throws(() => O.validateOpeningQuantities(tampered, snapshot), {code: "OPENING_AUDIT_INVALID"});
  const deleted = copy(data); delete deleted.trading.DEMO.openingPosition;
  assert.throws(() => O.validateOpeningQuantities(deleted, snapshot), {code: "OPENING_POSITION_CHANGED"});
  const wrong = copy(snapshot); wrong.positions[0].shares = Infinity;
  assert.throws(() => O.validateOpeningQuantities(data, wrong), {code: "OPENING_INVALID_POSITION"});
});

const separation = {version: 1, authorizationRef: "synthetic-separate-source-and-ledger"};
function separatedFixture() {
  const f = fixture(); f.policy.currentSnapshotLedgerSeparation = copy(separation);
  f.snapshot.positions[0].shares += 2;
  return f;
}
test("explicit separation keeps the fixed opening and real ledger while auditing only current quantity differences", () => {
  const f = separatedFixture(), before = copy(f.previous), next = apply(f);
  assert.deepEqual(next.quantityReconciliation, {version: 1, authorization: separation,
    method: "source-holdings-independent-of-ledger", sourceAsOf: null, sourceDateStatus: "unknown", matched: false,
    differences: [{ticker: "DEMO", ledgerShares: 11, holdingShares: 13}]});
  assert.equal(next.trading.DEMO.openingPosition.shares, 8);
  assert.deepEqual(next.trading.DEMO.orders, before.trading.DEMO.orders);
  assert.deepEqual(next.historySnapshot, before.historySnapshot); assert.deepEqual(f.previous, before);
  assert.doesNotMatch(JSON.stringify(next.quantityReconciliation), /fetchedAt|checkedAt|retrievedAt/);
});
test("unauthorized current gaps, invalid policies and changed approval still fail closed", () => {
  const missing = separatedFixture(); delete missing.policy.currentSnapshotLedgerSeparation;
  rejects(missing, "OPENING_CURRENT_QUANTITY_MISMATCH");
  for (const bad of [true, null, {version: 2, authorizationRef: "synthetic"}, {version: 1, authorizationRef: ""}, {...separation, source: "user-confirmed"}]) {
    const f = separatedFixture(); f.policy.currentSnapshotLedgerSeparation = bad;
    rejects(f, bad?.authorizationRef === "" ? "OPENING_AUTHORIZATION_INVALID" : "OPENING_SEPARATION_AUTHORIZATION_INVALID");
  }
  const f = separatedFixture(), data = apply(f);
  const changed = {previous: data, next: copy(data), snapshot: f.snapshot, policy: {currentSnapshotLedgerSeparation: {...separation, authorizationRef: "synthetic-other"}}};
  rejects(changed, "OPENING_SEPARATION_AUTHORIZATION_CHANGED");
});
test("saved encrypted separation authority is reusable and audit changes only with actual quantities", () => {
  const f = separatedFixture(), data = apply(f), before = canonical(data);
  const next = copy(data); O.applyOpeningPositions(next, data, copy(f.snapshot), {});
  assert.equal(canonical(next), before);
  assert.deepEqual(O.resolveQuantitySeparation(data, {}), separation);
  const changedSnapshot = copy(f.snapshot); changedSnapshot.positions[0].shares += 1;
  const changed = copy(data); O.applyOpeningPositions(changed, data, changedSnapshot, {});
  assert.equal(changed.quantityReconciliation.differences[0].holdingShares, 14);
  assert.deepEqual(changed.openingPositionAudit, data.openingPositionAudit);
  assert.deepEqual(changed.trading, data.trading); assert.equal(canonical(data), before);
});
test("real source alignment clears the difference without rolling the opening or inventing orders", () => {
  const f = separatedFixture(), data = apply(f), matched = copy(data), current = copy(f.snapshot);
  current.positions[0].shares -= 2;
  O.applyOpeningPositions(matched, data, current, {});
  assert.equal(matched.quantityReconciliation.matched, true); assert.deepEqual(matched.quantityReconciliation.differences, []);
  assert.deepEqual(matched.trading, data.trading); assert.deepEqual(matched.historySnapshot, data.historySnapshot);
  const ledgerCaughtUp = copy(data);
  ledgerCaughtUp.trading.DEMO.orders.push(order("2024-08-01", "buy", 2, {id: "synthetic-later-real-order"}));
  O.applyOpeningPositions(ledgerCaughtUp, data, f.snapshot, {});
  assert.equal(ledgerCaughtUp.quantityReconciliation.matched, true);
  assert.deepEqual(ledgerCaughtUp.trading.DEMO.openingPosition, data.trading.DEMO.openingPosition);
});
test("separation validation is immutable and recomputes the audit instead of trusting its matched flag", () => {
  const f = separatedFixture(), data = apply(f), before = canonical(data);
  const options = {currentSnapshotLedgerSeparation: O.resolveQuantitySeparation(data, {})};
  assert.equal(O.validateOpeningQuantities(data, f.snapshot, options), data); assert.equal(canonical(data), before);
  assert.throws(() => O.validateOpeningQuantities(data, f.snapshot), {code: "OPENING_CURRENT_QUANTITY_MISMATCH"});
  const forged = copy(data); forged.quantityReconciliation.differences[0].holdingShares += 1;
  assert.throws(() => O.validateOpeningQuantities(forged, f.snapshot, options), {code: "OPENING_RECONCILIATION_CHANGED"});
  const invalid = copy(data); invalid.quantityReconciliation.matched = true;
  assert.throws(() => O.resolveQuantitySeparation(invalid, {}), {code: "OPENING_RECONCILIATION_INVALID"});
});
test("authorization cannot waive fixed-history, old-order, negative-daily or malformed-position guards", () => {
  const history = separatedFixture(); history.next.historySnapshot.income[0].amount += 1;
  rejects(history, "OPENING_HISTORY_CHANGED");
  const edited = separatedFixture(); edited.next.trading.DEMO.orders[0].price += 1;
  rejects(edited, "OPENING_LEGACY_ORDERS_CHANGED");
  const negative = separatedFixture(); negative.next.trading.DEMO.orders.push(order("2024-08-01", "sell", 20));
  rejects(negative, "OPENING_NEGATIVE_DAILY_POSITION");
  const invalid = separatedFixture(); invalid.snapshot.positions[0].shares = -1;
  rejects(invalid, "OPENING_INVALID_POSITION");
  const missingOpening = {previous: {trading: {}}, next: {trading: {}}, snapshot: {positions: []}, policy: {currentSnapshotLedgerSeparation: separation}};
  rejects(missingOpening, "OPENING_RECONCILIATION_REQUIRES_OPENING");
});
