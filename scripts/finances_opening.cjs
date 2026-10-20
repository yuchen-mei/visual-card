"use strict";

// Pure in-memory accounting. Opening estimates and their audit belong only in
// the encrypted payload. No orders, source IDs, prices or cash flows are made.
const {createHash} = require("node:crypto");
class OpeningError extends Error {
  constructor(code) { super(code); this.name = "OpeningError"; this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new OpeningError(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const EPSILON = 1e-7;
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  check(value === null || ["boolean", "string"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value)), "OPENING_INVALID_JSON");
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right, code) => check(left === undefined || right === undefined ? left === right : canonical(left) === canonical(right), code);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
function day(value) {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "OPENING_INVALID_DATE");
  const time = Date.parse(value + "T00:00:00Z");
  check(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "OPENING_INVALID_DATE");
  return value;
}
function ticker(value) {
  check(typeof value === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value) && !["CASH", "CD"].includes(value), "OPENING_INVALID_TICKER");
  return value;
}
function reference(value) {
  check(typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value), "OPENING_AUTHORIZATION_INVALID");
  return value;
}
function add(a, b) {
  const result = a + b;
  check(Number.isFinite(result), "OPENING_INVALID_QUANTITY");
  return result;
}
function cash(value) {
  return value.is_cash_equivalent === true || value.isCashEquivalent === true
    || /现金|存款|储蓄|cash|checking|saving|sweep/.test(String(value.type || "").toLowerCase())
    || String(value.type || "").toLowerCase() === "cd" || ["CASH", "CD"].includes(String(value.ticker || "").toUpperCase());
}
function tradingOf(value) {
  if (value === undefined) return {};
  check(object(value), "OPENING_INVALID_TRADING");
  for (const [symbol, item] of Object.entries(value)) {
    ticker(symbol);
    check(object(item) && (item.orders === undefined || Array.isArray(item.orders)), "OPENING_INVALID_TRADING");
    for (const order of item.orders || []) {
      check(object(order) && ["buy", "sell"].includes(order.side) && Number.isFinite(order.shares) && order.shares > 0, "OPENING_INVALID_ORDER");
      day(order.date);
    }
  }
  return value;
}
function precedingYearEnd(date) {
  const year = Number(day(date).slice(0, 4));
  check(year > 0, "OPENING_INVALID_DATE");
  return day(`${String(year - 1).padStart(4, "0")}-12-31`);
}
function anchorOf(data) {
  const anchor = data.historySnapshot;
  check(object(anchor) && Array.isArray(anchor.holdings), "OPENING_HISTORY_REQUIRED");
  const asOf = day(anchor.asOf);
  check(object(data.tradeSync) && data.tradeSync.baselineCutoff === asOf, "OPENING_ANCHOR_CUTOFF_MISMATCH");
  const trading = tradingOf(anchor.trading), holdings = new Map();
  for (const row of anchor.holdings) {
    check(object(row), "OPENING_INVALID_POSITION");
    if (cash(row)) continue;
    ticker(row.ticker);
    check(Number.isFinite(row.shares) && row.shares >= 0, "OPENING_INVALID_POSITION");
    holdings.set(row.ticker, add(holdings.get(row.ticker) || 0, row.shares));
  }
  const legacy = [], positions = [];
  for (const symbol of [...new Set([...holdings.keys(), ...Object.keys(trading)])].sort()) {
    const item = trading[symbol] || {}, orders = item.orders || [];
    check(!own(item, "openingPosition"), "OPENING_EXISTING_POSITION");
    let net = 0;
    for (const order of orders) {
      check(order.date <= asOf, "OPENING_ORDER_AFTER_ANCHOR");
      net = add(net, order.side === "buy" ? order.shares : -order.shares);
    }
    const anchorShares = holdings.get(symbol) || 0, residual = add(anchorShares, -net);
    check(residual >= -EPSILON, "OPENING_NEGATIVE_INITIAL_POSITION");
    const shares = Math.abs(residual) <= EPSILON ? 0 : residual;
    const first = orders.length ? orders.map(order => order.date).sort()[0] : asOf;
    positions.push({ticker: symbol, openingDate: precedingYearEnd(first), shares, anchorShares, legacyNetShares: net});
    legacy.push({ticker: symbol, orders});
  }
  return {anchor, asOf, trading, positions, historySha256: hash(anchor), legacyOrdersDigest: hash(legacy)};
}
function preservesOrders(next, previous) {
  for (const [symbol, item] of Object.entries(previous)) {
    check(own(next, symbol), "OPENING_LEGACY_ORDERS_CHANGED");
    const before = item.orders || [], after = next[symbol].orders || [];
    check(after.length >= before.length, "OPENING_LEGACY_ORDERS_CHANGED");
    same(after.slice(0, before.length), before, "OPENING_LEGACY_ORDERS_CHANGED");
  }
}
function anchorOrders(trading, anchor) {
  preservesOrders(trading, anchor.trading);
  for (const [symbol, item] of Object.entries(trading)) {
    const legacyCount = anchor.trading[symbol]?.orders?.length || 0;
    for (const order of (item.orders || []).slice(legacyCount)) check(order.date > anchor.asOf, "OPENING_LATE_LEGACY_ORDER_REQUIRES_REVIEW");
  }
}
function authorized(value, historySha256) {
  check(exact(value, ["version", "authorizationRef", "historySha256"]) && value.version === 1, "OPENING_AUTHORIZATION_INVALID");
  reference(value.authorizationRef);
  check(typeof value.historySha256 === "string" && /^[a-f0-9]{64}$/.test(value.historySha256), "OPENING_AUTHORIZATION_INVALID");
  check(value.historySha256 === historySha256, "OPENING_HISTORY_HASH_MISMATCH");
}
function auditFor(anchor, authorizationRef) {
  return {version: 1, method: "user-authorized-opening-estimate", authorizationRef,
    anchorAsOf: anchor.asOf, dateBasis: "saved-snapshot-date-source-time-unknown",
    historySha256: anchor.historySha256, legacyOrdersDigest: anchor.legacyOrdersDigest, positions: anchor.positions};
}
function checkedAudit(data) {
  const audit = data.openingPositionAudit;
  check(exact(audit, ["version", "method", "authorizationRef", "anchorAsOf", "dateBasis", "historySha256", "legacyOrdersDigest", "positions"]), "OPENING_AUDIT_INVALID");
  reference(audit.authorizationRef);
  const anchor = anchorOf(data);
  same(audit, auditFor(anchor, audit.authorizationRef), "OPENING_AUDIT_INVALID");
  const trading = tradingOf(data.trading);
  anchorOrders(trading, anchor);
  const expected = new Map(anchor.positions.filter(position => position.shares > 0).map(position => [position.ticker, position]));
  for (const [symbol, item] of Object.entries(trading)) {
    const position = expected.get(symbol);
    if (position) {
      check(exact(item.openingPosition, ["version", "asOf", "shares"]), "OPENING_POSITION_CHANGED");
      same(item.openingPosition, {version: 1, asOf: position.openingDate, shares: position.shares}, "OPENING_POSITION_CHANGED");
      for (const order of item.orders || []) check(order.date > position.openingDate, "OPENING_ORDER_BOUNDARY_CONFLICT");
      expected.delete(symbol);
    } else check(!own(item, "openingPosition"), "OPENING_POSITION_CHANGED");
  }
  check(expected.size === 0, "OPENING_POSITION_CHANGED");
  return {anchor, trading};
}
function validateOpeningQuantities(next, snapshot) {
  check(object(next), "OPENING_INVALID_INPUT");
  if (next.openingPositionAudit === undefined) return next;
  check(object(snapshot) && Array.isArray(snapshot.positions), "OPENING_CURRENT_POSITIONS_REQUIRED");
  const {anchor, trading} = checkedAudit(next), current = new Map();
  for (const row of snapshot.positions) {
    check(object(row), "OPENING_INVALID_POSITION");
    ticker(row.ticker);
    check(Number.isFinite(row.shares) && row.shares >= 0, "OPENING_INVALID_POSITION");
    current.set(row.ticker, add(current.get(row.ticker) || 0, row.shares));
  }
  for (const symbol of new Set([...anchor.positions.map(position => position.ticker), ...Object.keys(trading), ...current.keys()])) {
    const item = trading[symbol] || {}, daily = new Map();
    let shares = item.openingPosition?.shares || 0;
    for (const order of item.orders || []) daily.set(order.date, add(daily.get(order.date) || 0, order.side === "buy" ? order.shares : -order.shares));
    for (const date of [...daily.keys()].sort()) {
      shares = add(shares, daily.get(date));
      check(shares >= -EPSILON, "OPENING_NEGATIVE_DAILY_POSITION");
    }
    check(Math.abs(add(shares, -(current.get(symbol) || 0))) <= EPSILON, "OPENING_CURRENT_QUANTITY_MISMATCH");
  }
  return next;
}
function applyOpeningPositions(next, previous, snapshot, policy = {}) {
  check(object(next) && object(previous) && object(snapshot) && object(policy), "OPENING_INVALID_INPUT");
  const approval = policy.openingPositionAuthorization, prior = previous.openingPositionAudit;
  if (approval === undefined && prior === undefined) {
    check(next.openingPositionAudit === undefined, "OPENING_UNAUTHORIZED_STATE");
    return next;
  }
  const anchor = anchorOf(previous);
  same(next.historySnapshot, previous.historySnapshot, "OPENING_HISTORY_CHANGED");
  check(next.tradeSync?.baselineCutoff === anchor.asOf, "OPENING_ANCHOR_CUTOFF_MISMATCH");
  const before = tradingOf(previous.trading), after = tradingOf(next.trading);
  anchorOrders(before, anchor); anchorOrders(after, anchor); preservesOrders(after, before);
  if (prior !== undefined) {
    checkedAudit(previous);
    same(next.openingPositionAudit, prior, "OPENING_AUDIT_CHANGED");
    if (approval !== undefined) {
      authorized(approval, anchor.historySha256);
      check(approval.authorizationRef === prior.authorizationRef, "OPENING_AUTHORIZATION_CHANGED");
    }
    return validateOpeningQuantities(next, snapshot);
  }
  authorized(approval, anchor.historySha256);
  check(next.openingPositionAudit === undefined, "OPENING_UNAUTHORIZED_STATE");
  for (const trading of [before, after]) for (const item of Object.values(trading)) check(!own(item, "openingPosition"), "OPENING_EXISTING_POSITION");
  const trading = clone(after);
  for (const position of anchor.positions) if (position.shares > 0) {
    if (!own(trading, position.ticker)) trading[position.ticker] = {orders: []};
    trading[position.ticker].openingPosition = {version: 1, asOf: position.openingDate, shares: position.shares};
  }
  const candidate = {...next, trading, openingPositionAudit: auditFor(anchor, approval.authorizationRef)};
  validateOpeningQuantities(candidate, snapshot);
  next.trading = candidate.trading; next.openingPositionAudit = candidate.openingPositionAudit;
  return next;
}

module.exports = {applyOpeningPositions, validateOpeningQuantities, OpeningError};
