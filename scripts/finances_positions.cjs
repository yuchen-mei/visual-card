"use strict";

// Encrypted position identities and snapshot-to-snapshot lifecycle events only.
// Never reconstruct a full historical ledger or alter orders, prices or income.
const crypto = require("node:crypto");
const {validateOpeningQuantities, resolveQuantitySeparation} = require("./finances_opening.cjs");
class FinancesPositionsError extends Error {
  constructor(code) { super(code); this.name = "FinancesPositionsError"; this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new FinancesPositionsError(code); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const copy = v => JSON.parse(JSON.stringify(v));
const encode = v => JSON.stringify(v);
const hash = v => crypto.createHash("sha256").update(v).digest("hex");
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const same = (a, b, code) => check(encode(a) === encode(b), code);
const quantityEqual = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-7;
function id(v) { check(typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v), "POSITION_INVALID_ID"); return v; }
function day(v) {
  check(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v), "POSITION_INVALID_DATE");
  const t = Date.parse(v + "T00:00:00Z");
  check(Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v, "POSITION_INVALID_DATE");
  return v;
}
function ticker(v) { check(typeof v === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(v) && !["CASH", "CD"].includes(v), "POSITION_INVALID_TICKER"); return v; }
function cash(h) {
  return h.is_cash_equivalent === true || h.isCashEquivalent === true
    || /现金|存款|储蓄|cash|checking|saving|sweep/.test(String(h.type || "").toLowerCase())
    || String(h.type || "").toLowerCase() === "cd" || ["CASH", "CD"].includes(String(h.ticker || "").toUpperCase());
}
function quantities(rows) {
  const values = new Map();
  for (const row of rows) values.set(row.ticker, (values.get(row.ticker) || 0) + row.shares);
  return values;
}
function matchHoldings(rows, holdings) {
  check(Array.isArray(holdings), "POSITION_BASELINE_HOLDINGS_REQUIRED");
  check(holdings.every(object), "POSITION_BASELINE_HOLDINGS_REQUIRED");
  const baseline = holdings.filter(h => !cash(h));
  for (const h of baseline) {
    ticker(h.ticker); check(Number.isFinite(h.shares) && h.shares > 0, "POSITION_BASELINE_HOLDINGS_REQUIRED");
  }
  const a = quantities(rows.filter(p => p.shares > 0)), b = quantities(baseline);
  same([...a.keys()].sort(), [...b.keys()].sort(), "POSITION_BASELINE_MISMATCH");
  for (const [symbol, shares] of a) check(quantityEqual(shares, b.get(symbol)), "POSITION_BASELINE_MISMATCH");
}
function syncEntries(sync) {
  check(object(sync) && sync.version === 1 && Array.isArray(sync.transactions)
    && sync.allPagesFetched === true && sync.dateBasis === "provider-settlement-date"
    && sync.historyFromInception === false, "POSITION_TRADE_SYNC_REQUIRED");
  day(sync.baselineCutoff);
  const entries = new Map();
  for (const item of sync.transactions) {
    check(object(item) && digest(item.id) && digest(item.digest) && !entries.has(item.id), "POSITION_INVALID_TRADE_SYNC");
    entries.set(item.id, item.digest);
  }
  return entries;
}
function legacyPosition(previous, symbol) {
  return [previous.trading, previous.historySnapshot?.trading].some(trading => {
    const item = Array.isArray(trading) ? trading.find(p => p?.ticker === symbol) : trading?.[symbol];
    return item?.priceSource !== "preview" && Array.isArray(item?.orders)
      && item.orders.some(order => ["buy", "sell"].includes(order?.side)
        && typeof order.date === "string" && Number.isFinite(order.shares) && order.shares > 0);
  });
}

// Imported source IDs need not have changed the last saved holdings. Once an
// opening is verified, only an appended, source-bound real order is a delta.
function openingOrderChanges(next, previous, source, nextIds) {
  check(object(previous.trading) && object(next.trading), "POSITION_INVALID_TRADING");
  const changes = new Map(), seen = new Set();
  for (const [symbol, item] of Object.entries(previous.trading)) {
    check(object(item) && object(next.trading[symbol])
      && (item.orders === undefined || Array.isArray(item.orders))
      && (next.trading[symbol].orders === undefined || Array.isArray(next.trading[symbol].orders)), "POSITION_INVALID_TRADING");
    const before = item.orders || [], after = next.trading[symbol].orders || [];
    check(after.length >= before.length, "POSITION_TRADING_HISTORY_CHANGED");
    same(after.slice(0, before.length), before, "POSITION_TRADING_HISTORY_CHANGED");
  }
  for (const [symbol, item] of Object.entries(next.trading)) {
    check(object(item) && (item.orders === undefined || Array.isArray(item.orders)), "POSITION_INVALID_TRADING");
    const oldLength = previous.trading[symbol]?.orders?.length || 0;
    for (const [index, order] of (item.orders || []).entries()) {
      check(object(order), "POSITION_INVALID_TRADING");
      if (order.date <= next.tradeSync.baselineCutoff && index < oldLength) {
        if (digest(order.id)) {
          check(!seen.has(order.id), "POSITION_ORDER_SOURCE_MISMATCH"); seen.add(order.id);
        }
        continue;
      }
      const row = source.get(order.id);
      check(digest(order.id) && !seen.has(order.id) && nextIds.has(order.id) && row
        && row.ticker === symbol && ["date", "side", "shares", "price"].every(key => order[key] === row[key]), "POSITION_ORDER_SOURCE_MISMATCH");
      seen.add(order.id);
      if (index < oldLength) continue;
      const rows = changes.get(row.key) || [];
      rows.push({...row, id: order.id}); changes.set(row.key, rows);
    }
  }
  return changes;
}

// Published holdings and notification proof advance independently. Only real,
// source-bound orders can advance proof; imported IDs alone are not applied.
function separatedLifecycle(next, previous, records, current, source, nextIds, oldIds, events, authorization) {
  const saved = previous.positionLifecycle?.eventProofBaseline, migration = saved === undefined;
  function ledger(data, symbol, ids) {
    const item = data.trading?.[symbol] || {}, rows = new Map();
    let base = item.openingPosition?.shares || 0, baseDate = item.openingPosition?.asOf || "";
    for (const order of item.orders || []) {
      if (digest(order.id) && ids.has(order.id)) {
        const row = source.get(order.id);
        check(row && row.ticker === symbol && !rows.has(order.id), "POSITION_INVALID_EVENT_PROOF");
        rows.set(order.id, {...row, id: order.id});
      } else {
        base += order.side === "buy" ? order.shares : -order.shares;
        if (order.date > baseDate) baseDate = order.date;
      }
    }
    return {base, baseDate, rows};
  }
  const delta = rows => rows.reduce((n, row) => n + (row.side === "buy" ? row.shares : -row.shares), 0);
  const proofs = new Map();
  if (!migration) {
    check(exact(saved, ["version", "authorizationRef", "positions"]) && saved.version === 1
      && saved.authorizationRef === authorization.authorizationRef && Array.isArray(saved.positions), "POSITION_INVALID_EVENT_PROOF");
    const oldKeys = new Set(previous.positionLifecycle.positions.map(p => p.key));
    for (const proof of saved.positions) {
      check(exact(proof, ["key", "shares", "hasBeenOpen", "initialized", "consumedTradeIds", "pendingTradeIds"])
        && oldKeys.has(proof.key) && !proofs.has(proof.key) && Number.isFinite(proof.shares) && proof.shares >= 0
        && typeof proof.hasBeenOpen === "boolean" && typeof proof.initialized === "boolean"
        && Array.isArray(proof.consumedTradeIds) && Array.isArray(proof.pendingTradeIds), "POSITION_INVALID_EVENT_PROOF");
      const before = ledger(previous, records.get(proof.key).ticker, oldIds);
      const all = [...proof.consumedTradeIds, ...proof.pendingTradeIds];
      check(all.every(digest) && new Set(all).size === all.length, "POSITION_INVALID_EVENT_PROOF");
      same([...all].sort(), [...before.rows.keys()].sort(), "POSITION_INVALID_EVENT_PROOF");
      check(quantityEqual(proof.shares, before.base + delta(proof.consumedTradeIds.map(id => before.rows.get(id))))
        && (proof.shares === 0 || proof.hasBeenOpen), "POSITION_INVALID_EVENT_PROOF");
      proofs.set(proof.key, copy(proof));
    }
    same([...proofs.keys()].sort(), [...oldKeys].sort(), "POSITION_INVALID_EVENT_PROOF");
  }
  const added = [];
  for (const record of records.values()) {
    const actual = current.get(record.key) || 0, full = ledger(next, record.ticker, nextIds);
    let proof = proofs.get(record.key);
    if (!proof) {
      const shares = migration ? full.base + delta([...full.rows.values()]) : full.base;
      check(Number.isFinite(shares) && shares >= -1e-7, "POSITION_INVALID_EVENT_PROOF");
      const historicalBuy = [...source.values()].some(row => row.key === record.key && row.side === "buy" && row.date <= next.tradeSync.baselineCutoff);
      proof = {key: record.key, shares: Math.max(0, shares), hasBeenOpen: shares > 0 || historicalBuy || legacyPosition(previous, record.ticker),
        initialized: !migration || quantityEqual(shares, actual), consumedTradeIds: migration ? [...full.rows.keys()].sort() : [], pendingTradeIds: []};
    }
    const consumed = new Set(proof.consumedTradeIds);
    check([...consumed].every(id => full.rows.has(id)), "POSITION_INVALID_EVENT_PROOF");
    const pending = [...full.rows.values()].filter(row => !consumed.has(row.id)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    proof.pendingTradeIds = pending.map(row => row.id).sort();
    const proofDate = [...consumed].reduce((date, id) => full.rows.get(id).date > date ? full.rows.get(id).date : date, full.baseDate);
    // Late or same-day orders cannot be replayed after an already consumed
    // endpoint. Keep their evidence pending without blocking current holdings.
    if (!migration && (pending.length > 0 || !proof.initialized)
      && pending.every(row => row.date > proofDate) && quantityEqual(proof.shares + delta(pending), actual)) {
      // Same-day opposite sides can hide a close/reopen. Never invent their
      // order, and never discard a pending round trip just because its net is 0.
      let shares = proof.shares, held = proof.hasBeenOpen, ambiguous = false;
      const proposed = [], days = [...new Set(pending.map(row => row.date))];
      for (const date of days) {
        const rows = pending.filter(row => row.date === date), buys = rows.filter(row => row.side === "buy"), sells = rows.filter(row => row.side === "sell");
        const after = shares + delta(rows), sold = sells.reduce((n, row) => n + row.shares, 0);
        if (after < -1e-7 || (buys.length && sells.length && sold >= shares - 1e-7)) {ambiguous = true; break;}
        let kind;
        if (shares > 1e-7 && Math.abs(after) <= 1e-7) kind = "closed";
        else if (Math.abs(shares) <= 1e-7 && after > 1e-7) kind = held ? "reopened" : "opened";
        if (kind) {
          const event = {id: hash(encode([kind, record.key, rows.map(row => row.id).sort()])), kind, key: record.key,
            ticker: record.ticker, date, firstKnownBuyDate: record.firstKnownBuyDate};
          validateEventDate(event); proposed.push(event);
        }
        shares = Math.max(0, after); held ||= shares > 0;
      }
      if (!ambiguous) {
        if (proof.initialized) for (const event of proposed) if (!events.some(old => old.id === event.id)) added.push(event);
        proof.shares = actual; proof.hasBeenOpen = held || actual > 0; proof.initialized = true;
        proof.consumedTradeIds = [...full.rows.keys()].sort(); proof.pendingTradeIds = [];
      }
    }
    proofs.set(record.key, proof);
    record.shares = actual; record.status = actual > 0 ? "open" : "closed";
  }
  events.push(...added.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)));
  return {version: 1, accountHashes: next.tradeSync.accountHashes, positions: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)), events,
    eventProofBaseline: {version: 1, authorizationRef: authorization.authorizationRef, positions: [...proofs.values()].sort((a, b) => a.key.localeCompare(b.key))}};
}

function applyPositionLifecycle(next, previous, snapshot, policy = {}) {
  check(object(next) && object(previous) && object(snapshot) && object(policy), "POSITION_INVALID_INPUT");
  const prior = previous.positionLifecycle, approved = policy.positionAccountIds;
  if (approved === undefined || (Array.isArray(approved) && approved.length === 0)) {
    check(prior === undefined, "POSITION_ACCOUNT_POLICY_REQUIRED"); return next;
  }
  check(Array.isArray(approved) && approved.length > 0, "POSITION_ACCOUNT_POLICY_REQUIRED");
  const separation = resolveQuantitySeparation(previous, policy);
  check(prior?.eventProofBaseline === undefined || separation !== undefined, "POSITION_SEPARATION_AUTHORIZATION_REQUIRED");
  const accounts = approved.map(id).sort();
  check(accounts.length === 1, "POSITION_MULTIPLE_BROKERAGE_REQUIRES_REVIEW");
  check(new Set(accounts).size === accounts.length && Array.isArray(snapshot.accounts)
    && snapshot.coverage?.accountsComplete === true && snapshot.coverage.allPagesFetched === true
    && Array.isArray(snapshot.coverage.accountIds), "POSITION_INCOMPLETE_ACCOUNTS");
  const brokers = snapshot.accounts.filter(a => a?.type === "brokerage");
  same(brokers.map(a => id(a.id)).sort(), accounts, "POSITION_ACCOUNT_SCOPE_MISMATCH");
  check(accounts.every(a => snapshot.coverage.accountIds.includes(a)), "POSITION_ACCOUNT_SCOPE_MISMATCH");
  for (const a of brokers) check(a.coverage?.holdings?.complete === true && a.coverage.holdings.allPagesFetched === true, "POSITION_INCOMPLETE_HOLDINGS");
  const accountHashes = accounts.map(hash).sort();
  const updates = snapshot.tradeUpdates;
  check(object(updates) && updates.version === 1 && updates.allPagesFetched === true
    && updates.dateBasis === "provider-settlement-date" && Array.isArray(updates.rows)
    && Array.isArray(updates.accountIds) && Array.isArray(snapshot.positions), "POSITION_INCOMPLETE_TRADES");
  same([...updates.accountIds].sort(), accounts, "POSITION_TRADE_SCOPE_MISMATCH");
  const nextIds = syncEntries(next.tradeSync), oldIds = previous.tradeSync ? syncEntries(previous.tradeSync) : new Map();
  same(next.tradeSync.accountHashes, accountHashes, "POSITION_TRADE_SCOPE_MISMATCH");
  if (previous.tradeSync) {
    same(previous.tradeSync.accountHashes, accountHashes, "POSITION_TRADE_SCOPE_MISMATCH");
    same(next.tradeSync.baselineCutoff, previous.tradeSync.baselineCutoff, "POSITION_TRADE_WINDOW_CHANGED");
    for (const [key, value] of oldIds) check(nextIds.get(key) === value, "POSITION_TRADE_HISTORY_CHANGED");
  }
  const records = new Map(), bindings = new Map(), oldRecords = new Map();
  let events = [];
  function bind(key, accountHash, symbol) {
    const found = records.get(key);
    check(!found || (found.accountHash === accountHash && found.ticker === symbol), "POSITION_IDENTITY_CHANGED");
    const label = encode([accountHash, symbol]);
    check(!bindings.has(label) || bindings.get(label) === key, "POSITION_SECURITY_CHANGED");
    bindings.set(label, key);
    if (!found) records.set(key, {key, accountHash, ticker: symbol, shares: 0, status: "closed", firstKnownBuyDate: null});
    return records.get(key);
  }
  if (prior !== undefined) {
    check(object(prior) && prior.version === 1 && Array.isArray(prior.positions) && Array.isArray(prior.events)
      && previous.tradeSync, "POSITION_INVALID_LEDGER");
    same(prior.accountHashes, accountHashes, "POSITION_ACCOUNT_SCOPE_MISMATCH");
    for (const p of prior.positions) {
      check(object(p) && digest(p.key) && accountHashes.includes(p.accountHash) && !oldRecords.has(p.key)
        && Number.isFinite(p.shares) && p.shares >= 0 && p.status === (p.shares > 0 ? "open" : "closed"), "POSITION_INVALID_LEDGER");
      ticker(p.ticker); if (p.firstKnownBuyDate !== null) day(p.firstKnownBuyDate);
      bind(p.key, p.accountHash, p.ticker); records.set(p.key, copy(p)); oldRecords.set(p.key, copy(p));
    }
    const seen = new Set();
    for (const event of prior.events) {
      check(object(event) && digest(event.id) && !seen.has(event.id) && oldRecords.has(event.key)
        && ["opened", "reopened", "closed"].includes(event.kind) && event.ticker === oldRecords.get(event.key).ticker, "POSITION_INVALID_EVENTS");
      validateEventDate(event); seen.add(event.id);
    }
    events = copy(prior.events);
    matchHoldings([...oldRecords.values()], previous.holdings);
  }
  function identity(row) {
    check(object(row) && accounts.includes(id(row.accountId)), "POSITION_ACCOUNT_SCOPE_MISMATCH");
    const key = hash(encode([row.accountId, id(row.securityId)]));
    return bind(key, hash(row.accountId), ticker(row.ticker));
  }
  const current = new Map();
  for (const p of snapshot.positions) {
    const record = identity(p);
    check(!current.has(record.key) && Number.isFinite(p.shares) && p.shares > 0, "POSITION_DUPLICATE_OR_INVALID_HOLDING");
    current.set(record.key, p.shares);
  }
  const sourceIds = new Set(), source = new Map(), pastBuys = new Set(), historicalBuys = new Set();
  let changes = new Map();
  const retrieved = day(String(snapshot.fetchedAt || "").slice(0, 10));
  for (const row of updates.rows) {
    const record = identity(row), tradeId = hash(encode([row.accountId, id(row.sourceId)]));
    check(!sourceIds.has(tradeId) && ["buy", "sell"].includes(row.side)
      && Number.isFinite(row.shares) && row.shares > 0, "POSITION_DUPLICATE_OR_INVALID_TRADE");
    sourceIds.add(tradeId); day(row.date); check(row.date <= retrieved, "POSITION_FUTURE_TRADE");
    source.set(tradeId, {...row, key: record.key});
    if (row.side === "buy" && (record.firstKnownBuyDate === null || row.date < record.firstKnownBuyDate)) record.firstKnownBuyDate = row.date;
    if (row.side === "buy" && row.date <= next.tradeSync.baselineCutoff) historicalBuys.add(record.key);
    if (row.side === "buy" && (!nextIds.has(tradeId) || oldIds.has(tradeId))) pastBuys.add(record.key);
    if (row.date > next.tradeSync.baselineCutoff) check(nextIds.has(tradeId), "POSITION_UNMERGED_TRADE");
    if (nextIds.has(tradeId)) {
      const economics = {date: row.date, ticker: row.ticker, side: row.side, shares: row.shares,
        price: row.price, amountCents: row.amountCents, feesCents: row.feesCents};
      check(row.date > next.tradeSync.baselineCutoff && nextIds.get(tradeId) === hash(encode(economics)), "POSITION_TRADE_SOURCE_CHANGED");
    }
    if (!nextIds.has(tradeId) || oldIds.has(tradeId)) continue;
    const rows = changes.get(record.key) || []; rows.push({...row, id: tradeId}); changes.set(record.key, rows);
  }
  for (const tradeId of nextIds.keys()) check(sourceIds.has(tradeId), "POSITION_INCOMPLETE_TRADES");
  const opening = next.openingPositionAudit !== undefined, migration = opening && previous.openingPositionAudit === undefined;
  check(previous.openingPositionAudit === undefined || opening, "POSITION_OPENING_AUDIT_CHANGED");
  if (opening) {
    same(next.historySnapshot, previous.historySnapshot, "POSITION_TRADING_HISTORY_CHANGED");
    validateOpeningQuantities(next, snapshot, separation ? {currentSnapshotLedgerSeparation: separation} : {});
    if (migration) {
      const authorization = policy.openingPositionAuthorization;
      check(object(authorization) && Object.keys(authorization).sort().join(",") === "authorizationRef,historySha256,version"
        && authorization.version === 1 && authorization.authorizationRef === next.openingPositionAudit.authorizationRef
        && authorization.historySha256 === next.openingPositionAudit.historySha256, "POSITION_OPENING_AUTHORIZATION_REQUIRED");
    } else {
      same(next.openingPositionAudit, previous.openingPositionAudit, "POSITION_OPENING_AUDIT_CHANGED");
      check(Array.isArray(previous.holdings) && previous.holdings.every(object), "POSITION_BASELINE_HOLDINGS_REQUIRED");
      validateOpeningQuantities(previous, {positions: previous.holdings.filter(h => !cash(h))},
        previous.quantityReconciliation ? {currentSnapshotLedgerSeparation: separation} : {});
    }
    changes = openingOrderChanges(next, previous, source, nextIds);
  }
  if (separation) {
    check(opening, "POSITION_SEPARATION_OPENING_REQUIRED");
    next.positionLifecycle = separatedLifecycle(next, previous, records, current, source, nextIds, oldIds, events, separation);
    return next;
  }
  if (prior === undefined) matchHoldings([...current].map(([key, shares]) => ({ticker: records.get(key).ticker, shares})), previous.holdings);
  const addedEvents = [];
  for (const record of records.values()) {
    const old = oldRecords.get(record.key), before = old?.shares || 0, after = current.get(record.key) || 0;
    const trades = changes.get(record.key) || [];
    if (prior !== undefined && migration) {
      // A corrected baseline is not a real buy or sell and cannot announce one.
      check((before > 0) === (after > 0), "POSITION_OPENING_MIGRATION_STATE_CHANGED");
    } else if (prior !== undefined) {
      const delta = trades.reduce((n, row) => n + (row.side === "buy" ? row.shares : -row.shares), 0);
      check(quantityEqual(after - before, delta), "POSITION_QUANTITY_UNEXPLAINED");
      let kind;
      if (before > 0 && after === 0) kind = "closed";
      else if (before === 0 && after > 0) {
        const heldBefore = opening
          ? historicalBuys.has(record.key) || events.some(event => event.key === record.key) || legacyPosition(previous, record.ticker)
          : old || pastBuys.has(record.key) || legacyPosition(previous, record.ticker);
        kind = heldBefore ? "reopened" : "opened";
      }
      if (kind) {
        const relevant = trades.filter(t => t.side === (kind === "closed" ? "sell" : "buy"));
        check(relevant.length > 0, "POSITION_EVENT_EVIDENCE_REQUIRED");
        const dates = relevant.map(t => t.date).sort();
        const date = kind === "closed" ? dates.at(-1) : dates[0];
        const eventId = hash(encode([kind, record.key, trades.map(t => t.id).sort()]));
        const event = {id: eventId, kind, key: record.key, ticker: record.ticker, date, firstKnownBuyDate: record.firstKnownBuyDate};
        validateEventDate(event);
        if (!events.some(stored => stored.id === eventId)) addedEvents.push(event);
      }
    }
    record.shares = after; record.status = after > 0 ? "open" : "closed";
  }
  events.push(...addedEvents.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)));
  next.positionLifecycle = {version: 1, accountHashes, positions: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)), events};
  return next;
}

function validateEventDate(event) {
  day(event.date);
  check(event.kind === "closed" || event.firstKnownBuyDate !== null, "POSITION_INVALID_EVENTS");
  if (event.firstKnownBuyDate !== null) {
    day(event.firstKnownBuyDate);
    check(event.firstKnownBuyDate <= event.date, "POSITION_INVALID_EVENTS");
  }
}

function positionEffects(previous, next) {
  if (!previous?.positionLifecycle) return [];
  const known = new Set(previous.positionLifecycle.events.map(event => event.id));
  return (next?.positionLifecycle?.events || []).filter(event => !known.has(event.id))
    .map(({id, kind, ticker, date, firstKnownBuyDate}) => ({id, kind, ticker, date, firstKnownBuyDate}));
}
module.exports = {FinancesPositionsError, applyPositionLifecycle, positionEffects};
