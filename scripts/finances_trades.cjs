"use strict";

// Merge only verified source orders after a fixed legacy boundary. This module
// does not rebuild historical positions, returns, income, or market-price data.
const crypto = require("node:crypto");
class FinancesTradesError extends Error {
  constructor(code) { super(code); this.name = "FinancesTradesError"; this.code = code; }
}
function check(ok, code) { if (!ok) throw new FinancesTradesError(code); }
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const encoded = value => JSON.stringify(value);
const hashPattern = /^[a-f0-9]{64}$/;
function date(value) {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "TRADES_INVALID_DATE");
  const time = Date.parse(value + "T00:00:00Z");
  check(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "TRADES_INVALID_DATE");
  return value;
}
function identifier(value) {
  check(typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value), "TRADES_INVALID_ID");
  return value;
}
function existingOrders(trading) {
  check(record(trading), "TRADES_LEGACY_TRADING_REQUIRED");
  const orders = [];
  for (const [ticker, item] of Object.entries(trading)) {
    check(record(item) && (item.orders === undefined || Array.isArray(item.orders)), "TRADES_INVALID_LEGACY_ORDERS");
    for (const order of item.orders || []) {
      check(record(order), "TRADES_INVALID_LEGACY_ORDERS");
      orders.push({ticker, order});
    }
  }
  return orders;
}
function rowEconomics(row) {
  return {date: row.date, ticker: row.ticker, side: row.side, shares: row.shares,
    price: row.price, amountCents: row.amountCents, feesCents: row.feesCents};
}
function orderOf(id, row) {
  return {id, date: row.date, side: row.side, shares: row.shares, price: row.price};
}
function orderMatches(item, id, row) {
  return item.ticker === row.ticker && Object.entries(orderOf(id, row)).every(([key, value]) => item.order[key] === value);
}

function applyTradeUpdates(next, previous, snapshot) {
  check(record(next) && record(previous) && record(snapshot), "TRADES_INVALID_INPUT");
  const updates = snapshot.tradeUpdates;
  if (updates === undefined) {
    check(previous.tradeSync === undefined, "TRADES_SOURCE_REQUIRED");
    return next;
  }
  check(record(updates) && updates.version === 1 && updates.allPagesFetched === true
    && Array.isArray(updates.rows) && Array.isArray(updates.accountIds), "TRADES_INCOMPLETE_SOURCE");
  check(updates.dateBasis === undefined || updates.dateBasis === "provider-settlement-date", "TRADES_UNSUPPORTED_DATE_BASIS");
  check(updates.sourceAsOf === null || typeof updates.sourceAsOf === "string", "TRADES_INVALID_SOURCE_DATE");
  if (updates.sourceAsOf !== null) date(updates.sourceAsOf);
  check(Array.isArray(snapshot.accounts), "TRADES_ACCOUNT_SCOPE_REQUIRED");
  const accounts = updates.accountIds.map(identifier).sort();
  const brokerage = snapshot.accounts.filter(a => a?.type === "brokerage").map(a => identifier(a.id)).sort();
  check(accounts.length > 0 && new Set(accounts).size === accounts.length && encoded(accounts) === encoded(brokerage), "TRADES_ACCOUNT_SCOPE_MISMATCH");
  const accountHashes = accounts.map(hash).sort();
  const oldOrders = existingOrders(previous.trading);
  check(encoded(next.trading) === encoded(previous.trading), "TRADES_LEGACY_CHANGED");
  if (previous.historySnapshot !== undefined) {
    check(encoded(next.historySnapshot) === encoded(previous.historySnapshot), "TRADES_HISTORY_SNAPSHOT_CHANGED");
  }
  const prior = previous.tradeSync;
  let cutoff;
  if (prior === undefined) {
    check(oldOrders.length > 0, "TRADES_BASELINE_CUTOFF_REQUIRED");
    cutoff = oldOrders.map(item => date(item.order.date)).sort().at(-1);
    check(record(previous.historySnapshot) && previous.historySnapshot.asOf === cutoff, "TRADES_BASELINE_CUTOFF_UNCONFIRMED");
  } else {
    check(record(prior) && prior.version === 1 && prior.historyFromInception === false
      && prior.dateBasis === "provider-settlement-date" && Array.isArray(prior.transactions)
      && encoded(prior.accountHashes) === encoded(accountHashes), "TRADES_SYNC_AUDIT_INVALID");
    cutoff = date(prior.baselineCutoff);
    check(previous.historySnapshot?.asOf === cutoff, "TRADES_BASELINE_CUTOFF_UNCONFIRMED");
  }
  check(updates.queriedFrom === null || updates.queriedFrom === cutoff, "TRADES_QUERY_WINDOW_MISMATCH");
  const sourceDay = date(String(snapshot.fetchedAt || "").slice(0, 10));
  const window = new Map();
  const required = ["accountId", "sourceId", "date", "ticker", "side", "shares", "price", "amountCents", "feesCents"].sort();
  for (const row of updates.rows) {
    check(record(row) && accounts.includes(identifier(row.accountId)), "TRADES_ACCOUNT_SCOPE_MISMATCH");
    date(row.date); identifier(row.sourceId);
    if (row.date <= cutoff) continue; // No inference or correction of older gaps.
    check(encoded(Object.keys(row).sort()) === encoded(required), "TRADES_UNSUPPORTED_WINDOW_ROW");
    check(row.date <= sourceDay && (updates.sourceAsOf === null || row.date <= updates.sourceAsOf), "TRADES_FUTURE_DATE");
    check(typeof row.ticker === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.ticker)
      && !["CASH", "CD"].includes(row.ticker), "TRADES_INVALID_TICKER");
    check(["buy", "sell"].includes(row.side), "TRADES_UNSUPPORTED_SIDE");
    check(Number.isFinite(row.shares) && row.shares > 0 && Number.isFinite(row.price) && row.price > 0,
      "TRADES_INVALID_EXECUTION");
    check(Number.isSafeInteger(row.amountCents) && Number.isSafeInteger(row.feesCents) && row.feesCents >= 0,
      "TRADES_INVALID_MONEY");
    const id = hash(encoded([row.accountId, row.sourceId]));
    check(!window.has(id), "TRADES_DUPLICATE_SOURCE_ID");
    window.set(id, {row, digest: hash(encoded(rowEconomics(row)))});
  }
  const synced = new Map();
  for (const entry of prior?.transactions || []) {
    check(record(entry) && hashPattern.test(entry.id) && hashPattern.test(entry.digest) && !synced.has(entry.id), "TRADES_SYNC_AUDIT_INVALID");
    const observed = window.get(entry.id);
    check(observed && observed.digest === entry.digest, "TRADES_SYNCED_SOURCE_CHANGED");
    const stored = oldOrders.filter(item => item.order.id === entry.id);
    check(stored.length === 1 && orderMatches(stored[0], entry.id, observed.row), "TRADES_SYNCED_ORDER_CHANGED");
    synced.set(entry.id, entry.digest);
  }
  const additions = [...window.entries()].filter(([id]) => !synced.has(id))
    .sort(([a, x], [b, y]) => x.row.date.localeCompare(y.row.date) || a.localeCompare(b));
  for (const [id] of additions) check(!oldOrders.some(item => item.order.id === id), "TRADES_LEGACY_ID_COLLISION");
  if (prior === undefined) {
    // Legacy dates may be execution dates while source dates are settlement
    // dates. Without an established source-ID audit, matching economics need
    // review even when the source row falls after the legacy date boundary.
    for (const [, {row}] of additions) {
      check(!oldOrders.some(item => item.ticker === row.ticker && item.order.side === row.side
        && item.order.shares === row.shares && item.order.price === row.price),
      "TRADES_LEGACY_DUPLICATE_REQUIRES_REVIEW");
    }
  }
  const trading = copy(previous.trading);
  for (const [id, {row}] of additions) {
    if (!Object.hasOwn(trading, row.ticker)) trading[row.ticker] = {nameZh: row.ticker, orders: []};
    const item = trading[row.ticker];
    if (item.orders === undefined) item.orders = [];
    item.orders.push(orderOf(id, row));
  }
  const tradeSync = {
    version: 1, baselineCutoff: cutoff, accountHashes,
    transactions: [...window.entries()].map(([id, entry]) => ({id, digest: entry.digest})).sort((a, b) => a.id.localeCompare(b.id)),
    queriedFrom: updates.queriedFrom, sourceAsOf: updates.sourceAsOf, allPagesFetched: true,
    dateBasis: "provider-settlement-date", historyFromInception: false
  };
  // Commit only after every source/legacy check passes. No financial totals,
  // income, asOf, prices, old orders or immutable history are assigned here.
  next.trading = trading;
  next.tradeSync = tradeSync;
  next.historyStatus = {...next.historyStatus, state: "current-trades"};
  return next;
}

module.exports = {FinancesTradesError, applyTradeUpdates};
