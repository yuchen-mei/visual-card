#!/usr/bin/env node
"use strict";

// No network adapter is assumed. Accept only a complete, independently reconciled
// Finances export. Never emit input values, decrypted data, or native error text.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const {applyTradeUpdates} = require("./finances_trades.cjs");
const ROOT = path.resolve(__dirname, "..");
const DAY = 86400000;
class ValidationError extends Error {}
function requireThat(ok, code) { if (!ok) throw new ValidationError(code); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const sum = values => values.reduce((a, b) => a + b, 0);
function cents(n) { requireThat(Number.isSafeInteger(n), "MONEY_MUST_BE_INTEGER_CENTS"); return n; }
function roundedCents(n) { requireThat(Number.isFinite(n), "NONFINITE_MONEY"); return cents(Math.round(n * 100)); }
function date(value) {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "INVALID_DATE");
  const t = Date.parse(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value, "INVALID_DATE");
  return t;
}
function identifier(value) { requireThat(typeof value === "string" && value.length > 0 && value.length <= 200, "INVALID_IDENTIFIER"); return value; }
function symbol(value) { requireThat(typeof value === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value) && value !== "CASH", "UNSUPPORTED_TICKER"); return value; }
function unique(items, key, code) {
  requireThat(Array.isArray(items), "MISSING_ARRAY");
  const seen = new Set();
  for (const item of items) { const k = key(item); requireThat(!seen.has(k), code); seen.add(k); }
  return seen;
}
function close(a, b, code) { requireThat(Math.abs(a - b) <= 1e-7, code); }
function same(a, b, code) { requireThat(canonical(a) === canonical(b), code); }
function fresh(value, now) {
  requireThat(typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value), "MISSING_SOURCE_TIMESTAMP");
  const t = Date.parse(value);
  requireThat(Number.isFinite(t) && t <= now + 300000 && now - t <= 36 * 3600000, "STALE_OR_FUTURE_SOURCE");
}

function validateEnvelope(envelope) {
  requireThat(envelope && envelope.version === 1 && envelope.kdf === "PBKDF2-SHA256" && envelope.cipher === "AES-GCM", "UNSUPPORTED_ENVELOPE");
  same(Object.keys(envelope).sort(), ["version", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"].sort(), "UNEXPECTED_ENVELOPE_FIELDS");
  requireThat(Number.isInteger(envelope.iterations) && envelope.iterations >= 250000 && envelope.iterations <= 2000000, "UNSUPPORTED_KDF_COST");
  for (const k of ["salt", "iv", "ciphertext"]) {
    requireThat(typeof envelope[k] === "string" && Buffer.from(envelope[k], "base64").toString("base64") === envelope[k], "INVALID_BASE64");
  }
  requireThat(Buffer.from(envelope.salt, "base64").length === 16 && Buffer.from(envelope.iv, "base64").length === 12 && Buffer.from(envelope.ciphertext, "base64").length > 16, "INVALID_ENVELOPE_LENGTH");
}
function decrypt(envelope, password) {
  validateEnvelope(envelope);
  let key;
  try {
    key = crypto.pbkdf2Sync(password, Buffer.from(envelope.salt, "base64"), envelope.iterations, 32, "sha256");
    const all = Buffer.from(envelope.ciphertext, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    d.setAuthTag(all.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(all.subarray(0, -16)), d.final()]).toString("utf8"));
  } catch { throw new ValidationError("DECRYPTION_FAILED"); }
  finally { key?.fill(0); }
}
function encrypt(data, password, iterations = 250000) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  try {
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([c.update(canonical(data), "utf8"), c.final(), c.getAuthTag()]);
    return {version: 1, kdf: "PBKDF2-SHA256", iterations, cipher: "AES-GCM", salt: salt.toString("base64"), iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64")};
  } finally { key.fill(0); }
}

// Run the actual browser functions rather than maintaining a second UI formula.
function browserContract(html) {
  const names = ["base64ToBytes", "deriveKey", "decryptPayload", "normalizeData", "isCashHolding", "normalizeCashHoldings", "isCashInterestItem", "normalizeCashInterestItems", "normalizePerformanceData", "normalizePerformanceItem", "isStockEtfPerformanceItem", "summarizeTradableHoldingPerformance", "calculateReturnPct", "isTradableHolding", "stableHash", "previewTradingDates", "generatePreviewTradingForHolding", "normalizeTradingData", "numericOrNull", "holdingGain", "holdingReturnPct", "dayTime", "closeOnOrBefore", "sharesAt", "markPrice", "annualPositions", "normalizePublicPriceRows", "priceRowsFromMarketData", "computeAnnualSummary"];
  const functions = names.map(name => {
    const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, "m"));
    requireThat(match, "BROWSER_CONTRACT_CHANGED"); return match[0];
  });
  const context = vm.createContext({state: {raw: null, data: null, marketPrices: null}, DAY_MS: DAY, crypto: crypto.webcrypto, TextEncoder, TextDecoder, atob});
  vm.runInContext(functions.join("\n"), context, {timeout: 1000});
  return context;
}

// Display names come only from saved metadata, never from a new provider payload.
// A ticker-only placeholder must not hide an older confirmed security label.
function preservedSecurityNames(previous) {
  const names = new Map();
  const tickerOf = value => typeof value === "string" ? value.trim().toUpperCase() : "";
  const isCash = item => item.is_cash_equivalent === true || item.isCashEquivalent === true
    || /现金|存款|储蓄|cash|checking|saving|sweep/.test(String(item.type || "").toLowerCase())
    || String(item.type || "").toLowerCase() === "cd" || ["CD", "CASH"].includes(tickerOf(item.ticker));
  const remember = item => {
    if (!item || typeof item !== "object") return;
    const ticker = tickerOf(item.ticker);
    if (!ticker || isCash(item) || names.has(ticker) || typeof item.nameZh !== "string"
      || !item.nameZh.trim() || tickerOf(item.nameZh) === ticker) return;
    names.set(ticker, item.nameZh);
  };
  for (const saved of [previous, previous?.historySnapshot]) {
    const holdings = Array.isArray(saved?.holdings) ? saved.holdings : [];
    holdings.forEach(remember);
    const entries = Array.isArray(saved?.trading)
      ? saved.trading.filter(item => item && typeof item === "object").map(item => [item.ticker, item])
      : Object.entries(saved?.trading || {});
    for (const [ticker, item] of entries) {
      if (!item || typeof item !== "object") continue;
      const matching = holdings.filter(h => h && tickerOf(h.ticker) === tickerOf(ticker));
      if (matching.length && matching.every(isCash)) continue;
      remember({...item, ticker});
    }
  }
  return names;
}

function buildPayload(snapshot, previous, {now = Date.now(), market, html, policy} = {}) {
  requireThat(snapshot?.schemaVersion === 1 && snapshot.source === "Finances" && snapshot.currency === "USD", "UNSUPPORTED_SOURCE_SCHEMA");
  requireThat(policy && cents(policy.historicalCashInterestCents) > 0 && Array.isArray(policy.accountIds), "APPROVED_PRIVATE_POLICY_REQUIRED");
  const asOfTime = date(snapshot.asOf);
  requireThat(asOfTime <= now && now - asOfTime <= 2 * DAY, "STALE_SNAPSHOT_DATE");
  if (previous.asOf) requireThat(asOfTime >= date(previous.asOf), "SNAPSHOT_DATE_REGRESSION");
  fresh(snapshot.fetchedAt, now);
  const coverage = snapshot.coverage;
  requireThat(coverage?.accountsComplete === true && coverage.allPagesFetched === true && coverage.historyFromInception === true, "INCOMPLETE_SOURCE_COVERAGE");
  const accounts = snapshot.accounts;
  const accountIds = unique(accounts, a => identifier(a.id), "DUPLICATE_ACCOUNT");
  requireThat(accounts.length > 0 && accounts.some(a => a.type === "brokerage") && accounts.some(a => a.type === "checking") && accounts.some(a => a.type === "savings"), "REQUIRED_ACCOUNTS_MISSING");
  same([...accountIds].sort(), [...unique(coverage.accountIds, identifier, "DUPLICATE_COVERAGE_ACCOUNT")].sort(), "ACCOUNT_COVERAGE_MISMATCH");
  same([...accountIds].sort(), [...unique(policy.accountIds, identifier, "DUPLICATE_POLICY_ACCOUNT")].sort(), "APPROVED_ACCOUNT_SCOPE_MISMATCH");
  for (const a of accounts) {
    requireThat(["brokerage", "checking", "savings"].includes(a.type) && a.currency === "USD", "UNSUPPORTED_ACCOUNT");
    for (const dataset of ["balances", "holdings", "transactions", "interest"]) {
      const proof = a.coverage?.[dataset];
      requireThat(proof?.complete === true && proof.allPagesFetched === true, "INCOMPLETE_ACCOUNT_DATASET");
      if (["transactions", "interest"].includes(dataset)) requireThat(proof.fromInception === true, "INCOMPLETE_HISTORY");
      fresh(proof.updatedAt, now);
    }
    for (const field of ["cashCents", "securitiesCents", "totalCents"]) requireThat(cents(a[field]) >= 0, "NEGATIVE_BALANCE_UNSUPPORTED");
    requireThat(a.cashCents + a.securitiesCents === a.totalCents, "ACCOUNT_BALANCE_MISMATCH");
    requireThat(a.type === "brokerage" || a.securitiesCents === 0, "INVALID_BANK_SECURITIES");
  }
  const positions = snapshot.positions;
  unique(positions, p => `${identifier(p.accountId)}:${symbol(p.ticker)}`, "DUPLICATE_POSITION");
  for (const p of positions) {
    requireThat(accounts.find(a => a.id === p.accountId)?.type === "brokerage" && ["stock", "etf"].includes(p.type), "UNSUPPORTED_POSITION");
    requireThat(Number.isFinite(p.shares) && p.shares > 0 && cents(p.valueCents) >= 0 && cents(p.costBasisCents) >= 0, "INVALID_POSITION");
  }
  for (const a of accounts) same(sum(positions.filter(p => p.accountId === a.id).map(p => p.valueCents)), a.securitiesCents, "SECURITIES_BALANCE_MISMATCH");
  const transactions = clone(snapshot.transactions);
  const savedNames = preservedSecurityNames(previous);
  unique(transactions, t => `${identifier(t.accountId)}:${identifier(t.id)}`, "DUPLICATE_TRANSACTION");
  const kinds = ["buy", "sell", "cash_interest", "dividend", "external_in", "external_out", "transfer_in", "transfer_out"];
  const transfers = new Map(), lots = new Map(), trading = {}, income = [], transactionDigests = [];
  let realized = 0, interest = 0, dividends = 0, principal = 0;
  transactions.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.sequence - b.sequence || String(a.accountId).localeCompare(String(b.accountId)) || String(a.id).localeCompare(String(b.id)));
  unique(transactions, t => `${t.accountId}:${t.date}:${t.sequence}`, "AMBIGUOUS_TRANSACTION_ORDER");
  for (const t of transactions) {
    requireThat(accountIds.has(t.accountId) && kinds.includes(t.kind) && t.status === "posted", "UNSUPPORTED_TRANSACTION");
    requireThat(date(t.date) <= asOfTime && Number.isSafeInteger(t.sequence) && t.sequence >= 0, "INVALID_TRANSACTION_DATE_OR_ORDER");
    cents(t.amountCents);
    const positive = ["sell", "cash_interest", "dividend", "external_in", "transfer_in"].includes(t.kind);
    requireThat(positive ? t.amountCents > 0 : t.amountCents < 0, "INVALID_TRANSACTION_SIGN");
    const identity = hash(`${t.accountId}:${t.id}`);
    const economic = {date: t.date, sequence: t.sequence, kind: t.kind, amountCents: t.amountCents};
    if (t.kind.startsWith("transfer_")) {
      identifier(t.transferId);
      const pair = transfers.get(t.transferId) || []; pair.push(t); transfers.set(t.transferId, pair);
      economic.transferId = hash(t.transferId);
    } else if (t.kind.startsWith("external_")) principal += t.amountCents;
    else if (t.kind === "cash_interest" || t.kind === "dividend") {
      if (t.kind === "cash_interest") interest += t.amountCents; else dividends += t.amountCents;
      income.push({id: identity, date: t.date, amount: t.amountCents / 100, kind: t.kind, label: t.kind === "cash_interest" ? "现金利息" : "股息"});
    } else {
      symbol(t.ticker);
      requireThat(accounts.find(a => a.id === t.accountId)?.type === "brokerage" && Number.isFinite(t.shares) && t.shares > 0, "INVALID_TRADE");
      const lotKey = `${t.accountId}:${t.ticker}`, lot = lots.get(lotKey) || {shares: 0, cost: 0};
      if (t.kind === "buy") { lot.shares += t.shares; lot.cost -= t.amountCents; }
      else {
        requireThat(cents(t.disposedCostBasisCents) >= 0, "MISSING_DISPOSED_COST_BASIS");
        lot.shares -= t.shares; lot.cost -= t.disposedCostBasisCents;
        realized += t.amountCents - t.disposedCostBasisCents;
        economic.disposedCostBasisCents = t.disposedCostBasisCents;
      }
      requireThat(lot.shares >= -1e-7 && lot.cost >= 0, "INCOMPLETE_POSITION_HISTORY");
      lots.set(lotKey, lot);
      economic.ticker = t.ticker; economic.shares = t.shares;
      const row = trading[t.ticker] ||= {nameZh: savedNames.get(t.ticker) || t.ticker, orders: [], prices: []};
      row.orders.push({id: identity, date: t.date, side: t.kind, shares: t.shares, price: Math.abs(t.amountCents) / 100 / t.shares});
    }
    transactionDigests.push({id: identity, digest: hash(canonical(economic))});
  }
  for (const pair of transfers.values()) {
    requireThat(pair.length === 2 && pair[0].accountId !== pair[1].accountId && pair.some(t => t.kind === "transfer_in") && pair.some(t => t.kind === "transfer_out") && sum(pair.map(t => t.amountCents)) === 0, "UNPAIRED_INTERNAL_TRANSFER");
  }
  for (const a of accounts) same(sum(transactions.filter(t => t.accountId === a.id).map(t => t.amountCents)), a.cashCents, "CASH_LEDGER_MISMATCH");
  for (const [key, lot] of lots) {
    const p = positions.find(p => `${p.accountId}:${p.ticker}` === key);
    close(lot.shares, p?.shares || 0, "POSITION_QUANTITY_MISMATCH");
    same(lot.cost, p?.costBasisCents || 0, "POSITION_COST_BASIS_MISMATCH");
  }
  for (const p of positions) requireThat(lots.has(`${p.accountId}:${p.ticker}`), "MISSING_TRADE_HISTORY");
  const historical = snapshot.historicalCashInterest;
  requireThat(historical && cents(historical.amountCents) > 0, "HISTORICAL_INTEREST_REFERENCE_REQUIRED");
  same(historical.amountCents, policy.historicalCashInterestCents, "APPROVED_HISTORICAL_INTEREST_MISMATCH");
  const historicalIds = [...unique(historical.transactionKeys, identifier, "DUPLICATE_HISTORICAL_REFERENCE")].sort();
  requireThat(historicalIds.length > 0, "HISTORICAL_DATES_REQUIRED");
  const historicalRows = historicalIds.map(key => transactions.find(t => `${t.accountId}:${t.id}` === key));
  requireThat(historicalRows.every(t => t?.kind === "cash_interest"), "HISTORICAL_INTEREST_RECORDS_MISSING");
  same(sum(historicalRows.map(t => t.amountCents)), historical.amountCents, "HISTORICAL_INTEREST_MISMATCH");
  const historicalProof = {amountCents: historical.amountCents, transactionIds: historicalIds.map(hash).sort()};
  if (previous.updateAudit) {
    same(previous.updateAudit.historicalCashInterest, historicalProof, "HISTORICAL_REFERENCE_CHANGED");
    same(previous.updateAudit.accountIds, [...accountIds].map(hash).sort(), "ACCOUNT_SET_CHANGED_REQUIRES_REVIEW");
    const next = new Map(transactionDigests.map(t => [t.id, t.digest]));
    requireThat(previous.updateAudit.transactions.every(t => next.get(t.id) === t.digest), "HISTORY_REMOVED_OR_CORRECTED_REQUIRES_REVIEW");
  } else {
    // Initial migration requires exact evidence from the decrypted legacy items.
    const indexes = snapshot.migration?.historicalPerformanceItemIndexes;
    unique(indexes, i => { requireThat(Number.isSafeInteger(i) && i >= 0, "INVALID_LEGACY_MAPPING"); return i; }, "DUPLICATE_LEGACY_MAPPING");
    const selected = indexes.map(i => previous.performance?.items?.[i]);
    const ui = browserContract(html);
    requireThat(selected.length > 0 && selected.every(i => i && ui.isCashInterestItem(i)), "LEGACY_HISTORICAL_MAPPING_REQUIRED");
    same(sum(selected.map(i => roundedCents(i.gain))), historical.amountCents, "LEGACY_HISTORICAL_INTEREST_MISMATCH");
  }

  const holdings = [{ticker: "CASH", nameZh: "现金", type: "cash", value: sum(accounts.map(a => a.cashCents)) / 100}];
  const tickers = [...new Set(positions.map(p => p.ticker))].sort();
  for (const ticker of tickers) {
    const group = positions.filter(p => p.ticker === ticker);
    requireThat(group.every(p => p.type === group[0].type), "INCONSISTENT_SECURITY_TYPE");
    const value = sum(group.map(p => p.valueCents)), cost = sum(group.map(p => p.costBasisCents));
    holdings.push({ticker, nameZh: savedNames.get(ticker) || ticker, type: group[0].type, shares: sum(group.map(p => p.shares)), value: value / 100, costBasis: cost / 100, unrealizedGain: (value - cost) / 100});
  }
  const totalValue = sum(accounts.map(a => a.totalCents));
  const unrealized = sum(positions.map(p => p.valueCents - p.costBasisCents));
  const gain = unrealized + realized + interest + dividends;
  same(totalValue - principal, gain, "CUMULATIVE_ACCOUNTING_MISMATCH");
  requireThat(principal > 0, "NONPOSITIVE_PRINCIPAL_UNSUPPORTED");
  const expected = snapshot.reconciliation;
  requireThat(expected?.independentSourceTotals === true, "INDEPENDENT_RECONCILIATION_REQUIRED");
  for (const [key, actual] of Object.entries({totalValueCents: totalValue, cashCents: sum(accounts.map(a => a.cashCents)), principalCents: principal, totalGainCents: gain, realizedGainCents: realized, cashInterestCents: interest, dividendCents: dividends})) same(cents(expected[key]), actual, "SOURCE_TOTALS_MISMATCH");

  for (const [ticker, row] of Object.entries(trading)) {
    const prices = snapshot.prices?.[ticker];
    unique(prices, p => { date(p.date); return p.date; }, "DUPLICATE_PRICE_DATE");
    requireThat(prices.length >= 2, "INSUFFICIENT_REAL_PRICES");
    row.prices = prices.map(p => { requireThat(date(p.date) <= asOfTime && Number.isFinite(p.close) && p.close > 0, "INVALID_PRICE"); return {date: p.date, close: p.close}; }).sort((a,b) => a.date.localeCompare(b.date));
    requireThat(row.prices[0].date <= row.orders[0].date, "MISSING_INCEPTION_PRICE");
    // Validate all held year-end valuations without allowing the UI's trade-price fallback.
    for (let year = Number(row.orders[0].date.slice(0,4)); year <= Number(snapshot.asOf.slice(0,4)); year++) {
      const cutoff = year === Number(snapshot.asOf.slice(0,4)) ? snapshot.asOf : `${year}-12-31`;
      const held = sum(row.orders.filter(o => o.date <= cutoff).map(o => o.side === "buy" ? o.shares : -o.shares));
      if (held <= 1e-7) continue;
      const mark = row.prices.filter(p => p.date <= cutoff).at(-1);
      requireThat(mark && date(cutoff) - date(mark.date) <= 7 * DAY, "MISSING_YEAR_END_OR_LATEST_PRICE");
    }
    const held = holdings.find(h => h.ticker === ticker);
    if (held) requireThat(Math.abs(roundedCents(held.shares * row.prices.at(-1).close) - roundedCents(held.value)) <= 1, "LATEST_MARK_BALANCE_MISMATCH");
  }
  const stockCost = sum(positions.map(p => p.costBasisCents));
  const gainItem = (label, kind, amount) => ({label, kind, gain: amount / 100, principal: 0, currentValue: 0, gainOnly: true, returnPct: null});
  const result = {
    asOf: snapshot.asOf, currency: "USD", holdings,
    performance: {totalCurrentValue: totalValue / 100, totalPrincipal: principal / 100, totalGain: gain / 100, totalReturnPct: gain / principal * 100, items: [
      {label: "股票 / ETF 浮盈", kind: "unrealized_gain", principal: stockCost / 100, currentValue: sum(positions.map(p => p.valueCents)) / 100, gain: unrealized / 100, returnPct: stockCost > 0 ? unrealized / stockCost * 100 : null},
      gainItem("股票已实现收益", "realized_gain", realized), gainItem("现金利息", "cash_interest", interest), gainItem("股息", "dividend", dividends)
    ]},
    trading: Object.fromEntries(Object.entries(trading).sort(([a], [b]) => a.localeCompare(b))),
    income: income.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
    updateAudit: {version: 1, accountIds: [...accountIds].map(hash).sort(), historicalCashInterest: historicalProof, transactions: transactionDigests.sort((a,b) => a.id.localeCompare(b.id))}
  };
  // Ledger contributions reconcile the source; they never replace a principal
  // explicitly maintained by the user. Keep that independent authority intact.
  if (previous.userConfirmedCapital) {
    validateManualCapital(previous.userConfirmedCapital);
    result.userConfirmedCapital = clone(previous.userConfirmedCapital);
    result.updateAudit.ledgerPrincipalCents = principal;
  }
  if (previous.basisRevision || previous.updateAudit?.previousBasisRevision) result.updateAudit.previousBasisRevision = clone(previous.basisRevision || previous.updateAudit.previousBasisRevision);
  const ui = browserContract(html);
  ui.state.raw = clone(result); ui.state.data = ui.normalizeData(clone(result));
  same(roundedCents(ui.state.data.totalAssetValue), totalValue, "BROWSER_BALANCE_MISMATCH");
  same(roundedCents(ui.state.data.equityValue), sum(positions.map(p => p.valueCents)), "BROWSER_SECURITIES_MISMATCH");
  same(roundedCents(ui.state.data.cashValue), sum(accounts.map(a => a.cashCents)), "BROWSER_CASH_MISMATCH");
  requireThat(ui.state.data.holdings.every(item => !ui.isCashHolding(item)), "BROWSER_CASH_IN_SECURITIES");
  same(roundedCents(sum(ui.state.data.performance.items.map(i => i.gain))), gain, "BROWSER_CUMULATIVE_MISMATCH");
  requireThat(ui.state.data.performance.items.every(i => i.kind !== "other_income"), "BROWSER_UNEXPLAINED_RESIDUAL");
  const annualShape = years => years.map(y => ({year: y.year, stockPnlCents: roundedCents(y.stockPnl), incomeCents: roundedCents(y.income), pnlCents: roundedCents(y.pnl)}));
  const annual = annualShape(ui.computeAnnualSummary().years);
  unique(expected.annual, y => y.year, "DUPLICATE_ANNUAL_RECONCILIATION");
  same(annual, [...expected.annual].sort((a,b) => a.year - b.year), "ANNUAL_RECONCILIATION_MISMATCH");
  requireThat(Math.abs(sum(annual.map(y => y.pnlCents)) - gain) <= 1, "ANNUAL_CUMULATIVE_MISMATCH");
  if (market) {
    // The live page prefers public prices, so its result must agree too.
    const embeddedDetails = ui.computeAnnualSummary();
    const detailShape = summary => summary.years.map(y => ({year: y.year, byTicker: [...y.byTicker].map(([ticker, value]) => [ticker, roundedCents(value)]).sort(([a],[b]) => a.localeCompare(b)), startValue: roundedCents(y.startValue), endValue: roundedCents(y.endValue)}));
    for (const [ticker, row] of Object.entries(trading)) {
      const publicRows = ui.priceRowsFromMarketData(market, ticker);
      if (!publicRows.length) continue;
      unique(publicRows, p => { date(p.date); return p.date; }, "DUPLICATE_PUBLIC_PRICE_DATE");
      requireThat(publicRows.every(p => date(p.date) <= asOfTime && Number.isFinite(p.close) && p.close > 0), "INVALID_PUBLIC_PRICE");
      const sorted = [...publicRows].sort((a,b) => a.date.localeCompare(b.date));
      requireThat(sorted[0].date <= row.orders[0].date, "MISSING_PUBLIC_INCEPTION_PRICE");
      for (const p of row.prices) {
        // Compare year-end and latest marks per ticker, including held quantity.
        if (p === row.prices.at(-1) || p.date === row.prices.filter(r => r.date <= p.date.slice(0,4) + "-12-31").at(-1)?.date) {
          const mark = sorted.filter(r => r.date <= p.date).at(-1);
          requireThat(mark && mark.date === p.date && Math.abs(mark.close - p.close) <= 1e-7, "PUBLIC_MARK_MISMATCH");
        }
      }
      requireThat(sorted.at(-1).date === row.prices.at(-1).date, "PUBLIC_MARK_DATE_MISMATCH");
    }
    ui.state.marketPrices = market;
    same(annualShape(ui.computeAnnualSummary().years), annual, "PUBLIC_MARKET_ANNUAL_MISMATCH");
    same(detailShape(ui.computeAnnualSummary()), detailShape(embeddedDetails), "PUBLIC_TICKER_ANNUAL_MISMATCH");
  }
  return applyUserConfirmedReturnMethod(result, previous, snapshot, {html});
}

// A current-assets update has deliberately independent gates. Missing historical
// records do not authorize recalculating old returns, deleting ledgers, or dating
// an undated interest adjustment. This mode retains the original history verbatim.
function freezeHistory(previous) {
  requireThat(previous && Array.isArray(previous.holdings) && previous.performance,"LEGACY_HISTORY_REQUIRED");
  const retainedHistory = ["preserved", "current-trades"].includes(previous.historyStatus?.state);
  const historyDate=(retainedHistory ? previous.historyStatus.asOf : previous.asOf)||null;
  if(historyDate!==null)date(historyDate);
  const historySnapshot=retainedHistory && previous.historySnapshot ? clone(previous.historySnapshot) : {asOf:historyDate,holdings:clone(previous.holdings),performance:clone(previous.performance),...(previous.trading!==undefined?{trading:clone(previous.trading)}:{}),...(previous.income!==undefined?{income:clone(previous.income)}:{})};
  const historyStatus={...clone(previous.historyStatus||{}),state:"preserved",asOf:historyDate};
  if(!retainedHistory && previous.historyStatus?.reason !== "incomplete_history")historyStatus.reason="history_not_revalidated";
  return {...clone(previous),historyStatus,historySnapshot};
}
function attachHistoricalReview(next, review, {html,policy}) {
  requireThat(!next.basisRevision?.cumulativeGainCorrected,"SUPERSEDED_HISTORICAL_REVIEW");
  requireThat(policy?.historicalInterestReview,"APPROVED_HISTORICAL_REVIEW_REQUIRED");
  same(review,policy.historicalInterestReview,"HISTORICAL_REVIEW_POLICY_MISMATCH");
  const r=review;
  requireThat(cents(r.previouslyIncludedCents)>=0&&cents(r.maturityTotalCents)>=r.previouslyIncludedCents&&r.additionalIncomeDate===null,"INVALID_UNDATED_HISTORICAL_REVIEW");
  const indices=policy.historicalPerformanceItemIndexes;
  unique(indices,i=>{requireThat(Number.isSafeInteger(i)&&i>=0,"INVALID_LEGACY_MAPPING");return i;},"DUPLICATE_LEGACY_MAPPING");
  const ui=browserContract(html);
  const rows=indices.map(i=>next.historySnapshot.performance.items?.[i]);
  requireThat(rows.length>0&&rows.every(i=>i&&ui.isCashInterestItem(i)),"LEGACY_HISTORICAL_MAPPING_REQUIRED");
  same(sum(rows.map(i=>roundedCents(i.gain))),r.previouslyIncludedCents,"LEGACY_HISTORICAL_INTEREST_MISMATCH");
  next.historyReview={previouslyIncludedCents:r.previouslyIncludedCents,maturityTotalCents:r.maturityTotalCents,unallocatedDifferenceCents:r.maturityTotalCents-r.previouslyIncludedCents,additionalIncomeDate:null,state:"awaiting_dated_evidence",includedInIncome:false};
  return next;
}
function buildHistoricalReviewPayload(snapshot,previous,{html,policy}={}) {
  requireThat(snapshot?.schemaVersion===2&&snapshot.mode==="history-review"&&snapshot.source==="user-confirmed","UNSUPPORTED_HISTORY_REVIEW_SCHEMA");
  const next=attachHistoricalReview(freezeHistory(previous),snapshot.historicalInterestReview,{html,policy});
  for(const key of ["holdings","performance","trading","income","asOf"])same(next[key],previous[key],"PRESERVED_HISTORY_CHANGED");
  const normalized=browserContract(html).normalizeData(clone(next));
  for(const key of ["totalGain","totalPrincipal","totalCurrentValue","totalReturnPct"])same(normalized.performance[key],previous.performance[key],"PRESERVED_PERFORMANCE_CHANGED");
  return next;
}

function validateManualCapital(capital) {
  requireThat(capital && cents(capital.principalCents) > 0 && capital.scope === "brokerage" && capital.source === "user-confirmed" && capital.updatePolicy === "explicit-user-only", "INVALID_MANUAL_CAPITAL");
  requireThat(capital.effectiveDate === null, "MANUAL_CAPITAL_DATE_NOT_CONFIRMED");
  if (capital.principalIncreaseCents !== undefined) cents(capital.principalIncreaseCents);
}

// This optional, encrypted policy is a user-approved display approximation.
// It never creates income rows or treats a cash transfer as a new profit entry.
function applyUserConfirmedReturnMethod(next, previous, snapshot, {html} = {}) {
  const method = previous.userConfirmedReturnMethod;
  if (method === undefined) return next;
  requireThat(method && method.version === 1 && method.method === "principal-minus-buying-power"
    && method.source === "user-confirmed" && method.classification === "user-approved-approximation"
    && method.incomeDatesInvented === false, "INVALID_CONFIRMED_RETURN_METHOD");
  validateManualCapital(previous.userConfirmedCapital);
  same(cents(method.totalPrincipalCents), previous.userConfirmedCapital.principalCents, "RETURN_METHOD_CAPITAL_MISMATCH");
  const supplement = cents(method.buyingPowerSupplementCents);
  requireThat(supplement >= 0 && cents(method.providerCashCents) >= 0
    && ["not-reflected-in-provider-snapshot", "reflected-in-provider-snapshot"].includes(method.supplementState)
    && (method.supplementState !== "reflected-in-provider-snapshot" || supplement === 0), "INVALID_BUYING_POWER_SUPPLEMENT");
  const brokerage = snapshot.accounts.filter(a => a.type === "brokerage");
  requireThat(brokerage.length > 0, "RETURN_METHOD_BROKERAGE_MISSING");
  const providerCash = cents(sum(brokerage.map(a => a.cashCents)));
  requireThat(snapshot.positions.every(p => Number.isSafeInteger(p.costBasisCents) && p.costBasisCents >= 0), "RETURN_METHOD_COST_BASIS_REQUIRED");
  const value = cents(sum(snapshot.positions.map(p => p.valueCents)));
  const cost = cents(sum(snapshot.positions.map(p => p.costBasisCents)));
  const ui = browserContract(html);
  if (supplement > 0) {
    const review = "BUYING_POWER_SUPPLEMENT_REQUIRES_REVIEW";
    const oldShares = new Map(), newShares = new Map();
    for (const h of previous.assetHoldings || previous.holdings || []) {
      if (ui.isCashHolding(h)) continue;
      requireThat(typeof h.ticker === "string" && Number.isFinite(h.shares) && h.shares > 0, "BUYING_POWER_SUPPLEMENT_REQUIRES_REVIEW");
      const ticker = h.ticker.trim().toUpperCase();
      oldShares.set(ticker, (oldShares.get(ticker) || 0) + h.shares);
    }
    for (const p of snapshot.positions) newShares.set(p.ticker, (newShares.get(p.ticker) || 0) + p.shares);
    const previousIds = new Set((previous.tradeSync?.transactions || []).map(t => t.id));
    const additions = previous.tradeSync && next.tradeSync
      ? next.tradeSync.transactions.filter(t => !previousIds.has(t.id)) : [];
    if (additions.length) {
      // The caller has merged and verified the entire fixed source window. Only
      // its newly accepted IDs can explain this snapshot's balance movement.
      requireThat(Array.isArray(snapshot.tradeUpdates?.rows), review);
      same(next.tradeSync.baselineCutoff, previous.tradeSync.baselineCutoff, review);
      const expected = new Map(additions.map(t => [t.id, t.digest]));
      const seen = new Set(), shareChanges = new Map();
      let spent = 0;
      for (const row of snapshot.tradeUpdates.rows) {
        const id = hash(JSON.stringify([row.accountId, row.sourceId]));
        if (!expected.has(id)) continue;
        requireThat(!seen.has(id) && row.feesCents === 0 && Number.isSafeInteger(row.amountCents)
          && ((row.side === "buy" && row.amountCents > 0) || (row.side === "sell" && row.amountCents < 0)), review);
        const economics = {date: row.date, ticker: row.ticker, side: row.side, shares: row.shares,
          price: row.price, amountCents: row.amountCents, feesCents: row.feesCents};
        same(hash(JSON.stringify(economics)), expected.get(id), review);
        seen.add(id); spent = cents(spent + row.amountCents);
        shareChanges.set(row.ticker, (shareChanges.get(row.ticker) || 0) + (row.side === "buy" ? row.shares : -row.shares));
      }
      same(seen.size, expected.size, review);
      same(providerCash - method.providerCashCents, -spent, review);
      for (const ticker of new Set([...oldShares.keys(), ...newShares.keys(), ...shareChanges.keys()]))
        close((newShares.get(ticker) || 0) - (oldShares.get(ticker) || 0), shareChanges.get(ticker) || 0, review);
    } else {
      // Bootstrap and runs without new trades cannot distinguish a deposit from
      // settlement. Retain the strict original cash/cost/inventory protection.
      same(providerCash, method.providerCashCents, review);
      same(cost, cents(method.holdingCostBasisCents), review);
      same([...oldShares.keys()].sort(), [...newShares.keys()].sort(), review);
      for (const [ticker, shares] of newShares) close(shares, oldShares.get(ticker), review);
    }
  }
  const buyingPower = cents(providerCash + supplement);
  const principal = cents(method.totalPrincipalCents - buyingPower);
  requireThat(principal > 0, "NONPOSITIVE_RETURN_PRINCIPAL");
  const gain = cents(value - principal), unrealized = cents(value - cost);
  const nonHolding = cents(gain - unrealized);
  const confirmedInterest = cents(method.confirmedCdInterestIncludedCents);
  requireThat(confirmedInterest >= 0, "INVALID_CONFIRMED_INTEREST_COMPONENT");
  const stockItem = previous.performance?.items?.find(i => ui.isStockEtfPerformanceItem(i)
    && i.kind !== "realized_gain" && !/已实现|止盈|\brealized\b/i.test(i.label));
  requireThat(stockItem, "RETURN_METHOD_STOCK_ITEM_REQUIRED");
  next.userConfirmedCapital = clone(previous.userConfirmedCapital);
  next.userConfirmedReturnMethod = {...clone(method), providerCashCents: providerCash,
    effectiveBuyingPowerCents: buyingPower, investedPrincipalCents: principal,
    holdingCostBasisCents: cost, unrealizedGainCents: unrealized, nonHoldingIncomeCents: nonHolding};
  next.performance = {...clone(previous.performance), totalPrincipal: principal / 100,
    totalCurrentValue: value / 100, totalGain: gain / 100, totalReturnPct: gain / principal * 100,
    items: [
      {...clone(stockItem), principal: cost / 100, currentValue: value / 100,
        gain: unrealized / 100, returnPct: cost > 0 ? unrealized / cost * 100 : null},
      {label: "现金利息/已止盈收益", kind: "cash_income_group", gainOnly: true,
        principal: 0, currentValue: 0, gain: nonHolding / 100, returnPct: null,
        components: [{kind: "cash_interest", gain: confirmedInterest / 100},
          {kind: "other_income", gain: (nonHolding - confirmedInterest) / 100}]}
    ]};
  if (next.historyStatus?.state === "preserved" || previous.basisRevision)
    next.basisRevision = {...clone(previous.basisRevision || {}), cumulativeGainCorrected: true};
  if (previous.historySnapshot) next.historySnapshot = clone(previous.historySnapshot);
  const normalized = ui.normalizeData(clone(next));
  for (const key of ["totalGain", "totalPrincipal", "totalCurrentValue", "totalReturnPct"])
    same(normalized.performance[key], next.performance[key], "BROWSER_RETURN_METHOD_MISMATCH");
  same(cents(sum(normalized.performance.items.map(i => roundedCents(i.gain)))), gain, "RETURN_METHOD_COMPONENTS_MISMATCH");
  return next;
}

// A user statement can correct an undated cumulative item and the separately
// maintained principal. It cannot create balances, settlement, dates or orders.
function buildBasisRevisionPayload(snapshot, previous, {html, policy} = {}) {
  requireThat(snapshot?.schemaVersion === 2 && snapshot.mode === "basis-revision" && snapshot.source === "user-confirmed", "UNSUPPORTED_BASIS_REVISION_SCHEMA");
  const revision = snapshot.basisRevision;
  requireThat(revision && policy?.basisRevision, "APPROVED_BASIS_REVISION_REQUIRED");
  same(revision, policy.basisRevision, "BASIS_REVISION_POLICY_MISMATCH");
  same(Object.keys(revision).sort(), (revision.cashInterestReplacement === undefined ? ["capital"] : ["capital", "cashInterestReplacement"]).sort(), "UNEXPECTED_BASIS_REVISION_FIELDS");
  const capital = revision.capital;
  requireThat(capital && Object.keys(capital).every(k => ["principalCents", "principalIncreaseCents", "scope", "effectiveDate"].includes(k)), "UNEXPECTED_MANUAL_CAPITAL_FIELDS");
  const confirmed = {...clone(capital), source: "user-confirmed", updatePolicy: "explicit-user-only"};
  validateManualCapital(confirmed);
  const digest = hash(canonical(revision));
  if (previous.basisRevision?.requestDigest === digest) {
    same(previous.userConfirmedCapital, confirmed, "MANUAL_CAPITAL_AUDIT_MISMATCH");
    return clone(previous);
  }
  if (previous.userConfirmedCapital) {
    validateManualCapital(previous.userConfirmedCapital);
    if (capital.principalIncreaseCents !== undefined) same(previous.userConfirmedCapital.principalCents + capital.principalIncreaseCents, capital.principalCents, "MANUAL_CAPITAL_CHANGE_MISMATCH");
  }
  const next = freezeHistory(previous);
  next.userConfirmedCapital = confirmed;
  const replacement = revision.cashInterestReplacement;
  if (replacement !== undefined) {
    same(Object.keys(replacement).sort(), ["itemIndex", "expectedPreviousCents", "replacementCents", "incomeDate"].sort(), "UNEXPECTED_INTEREST_REPLACEMENT_FIELDS");
    requireThat(Number.isSafeInteger(replacement.itemIndex) && replacement.itemIndex >= 0 && cents(replacement.expectedPreviousCents) >= 0 && cents(replacement.replacementCents) >= 0 && replacement.incomeDate === null, "INVALID_INTEREST_REPLACEMENT");
    const item = next.performance.items?.[replacement.itemIndex];
    const ui = browserContract(html);
    requireThat(item && ui.isCashInterestItem(item), "LEGACY_HISTORICAL_MAPPING_REQUIRED");
    same(roundedCents(item.gain), replacement.expectedPreviousCents, "LEGACY_HISTORICAL_INTEREST_MISMATCH");
    const oldGain = roundedCents(next.performance.totalGain);
    same(cents(sum(next.performance.items.map(i => roundedCents(i.gain)))), oldGain, "LEGACY_GAIN_COMPONENTS_MISMATCH");
    next.performance.items[replacement.itemIndex] = {...clone(item), label: "现金利息", kind: "cash_interest", gain: replacement.replacementCents / 100, gainOnly: true, principal: 0, currentValue: 0, returnPct: null};
    next.performance.totalGain = (oldGain - replacement.expectedPreviousCents + replacement.replacementCents) / 100;
    // Neither the old dated market value nor the newly confirmed principal is a
    // valid dated denominator for this undated correction.
    next.performance.totalReturnPct = null;
  }
  next.basisRevision = {
    version: 1, source: "user-confirmed", requestDigest: digest,
    request: clone(revision),
    cumulativeGainCorrected: !!replacement || previous.basisRevision?.cumulativeGainCorrected === true,
    incomeDate: null, transferSettlement: "unverified",
    ...(previous.historyReview ? {supersededHistoryReview: clone(previous.historyReview)} : previous.basisRevision?.supersededHistoryReview ? {supersededHistoryReview: clone(previous.basisRevision.supersededHistoryReview)} : {})
  };
  delete next.historyReview;
  for (const key of ["holdings", "trading", "income", "asOf", "assetSnapshot", "assetAudit"]) same(next[key], previous[key], "BASIS_REVISION_CHANGED_SOURCE_DATA");
  if (previous.historySnapshot) same(next.historySnapshot, previous.historySnapshot, "BASIS_REVISION_CHANGED_ORIGINAL_HISTORY");
  const normalized = browserContract(html).normalizeData(clone(next));
  same(normalized.performance.totalGain, next.performance.totalGain, "BROWSER_REVISED_GAIN_MISMATCH");
  same(normalized.userConfirmedCapital, confirmed, "BROWSER_MANUAL_CAPITAL_MISMATCH");
  return next;
}
function buildAssetPayload(snapshot, previous, {now = Date.now(), html, policy} = {}) {
  requireThat(snapshot?.schemaVersion === 2 && snapshot.mode === "assets" && snapshot.source === "Finances" && snapshot.currency === "USD", "UNSUPPORTED_ASSET_SCHEMA");
  fresh(snapshot.fetchedAt, now);
  requireThat(policy && Array.isArray(policy.accountIds), "APPROVED_PRIVATE_POLICY_REQUIRED");
  const coverage = snapshot.coverage;
  requireThat(coverage?.accountsComplete === true && coverage.allPagesFetched === true, "INCOMPLETE_ASSET_COVERAGE");
  const accounts = snapshot.accounts;
  const ids = unique(accounts, a => identifier(a.id), "DUPLICATE_ACCOUNT");
  requireThat(accounts.length > 0, "REQUIRED_ACCOUNTS_MISSING");
  same([...ids].sort(), [...unique(policy.accountIds, identifier, "DUPLICATE_POLICY_ACCOUNT")].sort(), "APPROVED_ACCOUNT_SCOPE_MISMATCH");
  same([...ids].sort(), [...unique(coverage.accountIds, identifier, "DUPLICATE_COVERAGE_ACCOUNT")].sort(), "ACCOUNT_COVERAGE_MISMATCH");
  const sourceDates = [];
  const privateDates = [];
  for (const a of accounts) {
    const prior=previous.assetAudit?.accountSourceDates?.find(row=>row.account===hash(a.id));
    requireThat(["brokerage", "checking", "savings", "cash"].includes(a.type) && a.currency === "USD", "UNSUPPORTED_ACCOUNT");
    for (const key of ["cashCents", "securitiesCents", "totalCents"]) requireThat(cents(a[key]) >= 0, "NEGATIVE_BALANCE_UNSUPPORTED");
    same(a.cashCents + a.securitiesCents, a.totalCents, "ACCOUNT_BALANCE_MISMATCH");
    requireThat(a.type === "brokerage" || a.securitiesCents === 0, "INVALID_BANK_SECURITIES");
    for (const dataset of ["balances", "holdings"]) {
      const proof = a.coverage?.[dataset];
      requireThat(proof?.complete === true && proof.allPagesFetched === true, "INCOMPLETE_ASSET_DATASET");
      if (proof.updatedAt === null) requireThat(proof.sourceDateStatus === "unknown", "UNKNOWN_SOURCE_DATE_MUST_BE_EXPLICIT");
      else {
        requireThat(proof.sourceDateStatus === "known", "KNOWN_SOURCE_DATE_MUST_BE_EXPLICIT");
        fresh(proof.updatedAt, now);
        const lastKnown=prior?.[`${dataset}UpdatedAt`]||prior?.[`lastKnown${dataset}UpdatedAt`];
        if(lastKnown)requireThat(Date.parse(proof.updatedAt)>=Date.parse(lastKnown),"ASSET_SOURCE_TIMESTAMP_REGRESSION");
      }
    }
    const balanceDate = a.coverage.balances.updatedAt?.slice(0,10) || null;
    sourceDates.push(balanceDate);
    privateDates.push({account:hash(a.id),balanceSourceAsOf:balanceDate,holdingsSourceAsOf:a.coverage.holdings.updatedAt?.slice(0,10)||null,balancesUpdatedAt:a.coverage.balances.updatedAt,holdingsUpdatedAt:a.coverage.holdings.updatedAt,lastKnownbalancesUpdatedAt:a.coverage.balances.updatedAt||prior?.lastKnownbalancesUpdatedAt||prior?.balancesUpdatedAt||null,lastKnownholdingsUpdatedAt:a.coverage.holdings.updatedAt||prior?.lastKnownholdingsUpdatedAt||prior?.holdingsUpdatedAt||null});
  }
  const positions = snapshot.positions;
  unique(positions, p => `${identifier(p.accountId)}:${symbol(p.ticker)}`, "DUPLICATE_POSITION");
  for (const p of positions) {
    requireThat(accounts.find(a=>a.id===p.accountId)?.type === "brokerage" && ["stock","etf"].includes(p.type), "UNSUPPORTED_POSITION");
    requireThat(Number.isFinite(p.shares) && p.shares > 0 && cents(p.valueCents) >= 0, "INVALID_POSITION");
    if (p.costBasisCents !== undefined && p.costBasisCents !== null) requireThat(cents(p.costBasisCents) >= 0, "INVALID_POSITION_COST");
    if (p.priceAsOf !== undefined && p.priceAsOf !== null) requireThat(date(p.priceAsOf) <= now && now - date(p.priceAsOf) <= 7 * DAY, "INVALID_POSITION_PRICE_DATE");
  }
  for (const a of accounts) same(sum(positions.filter(p=>p.accountId===a.id).map(p=>p.valueCents)),a.securitiesCents,"SECURITIES_BALANCE_MISMATCH");
  const total = cents(sum(accounts.map(a=>a.totalCents)));
  const cash = cents(sum(accounts.map(a=>a.cashCents)));
  requireThat(snapshot.reconciliation?.independentSourceTotals === true,"INDEPENDENT_RECONCILIATION_REQUIRED");
  same(cents(snapshot.reconciliation.totalValueCents),total,"SOURCE_TOTALS_MISMATCH");
  same(cents(snapshot.reconciliation.cashCents),cash,"SOURCE_TOTALS_MISMATCH");
  const holdings = [{ticker:"CASH",nameZh:"现金",type:"cash",value:cash/100}];
  const savedNames=preservedSecurityNames(previous);
  for (const ticker of [...new Set(positions.map(p=>p.ticker))].sort()) {
    const group=positions.filter(p=>p.ticker===ticker);
    requireThat(group.every(p=>p.type===group[0].type),"INCONSISTENT_SECURITY_TYPE");
    const value=cents(sum(group.map(p=>p.valueCents)));
    const holding={ticker,nameZh:savedNames.get(ticker)||ticker,type:group[0].type,shares:sum(group.map(p=>p.shares)),value:value/100};
    requireThat(Number.isFinite(holding.shares),"INVALID_POSITION_QUANTITY_SUM");
    if(group.every(p=>Number.isSafeInteger(p.costBasisCents))){
      const cost=cents(sum(group.map(p=>p.costBasisCents)));holding.costBasis=cost/100;holding.unrealizedGain=(value-cost)/100;
    }
    holdings.push(holding);
  }
  const known=sourceDates.every(Boolean)&&new Set(sourceDates).size===1;
  const next={...freezeHistory(previous),holdings,assetSnapshot:{retrievedAt:snapshot.fetchedAt,sourceAsOf:known?sourceDates[0]:null,sourceDateStatus:known?"known":"unknown"},assetAudit:{version:1,accountSourceDates:privateDates.sort((a,b)=>a.account.localeCompare(b.account)),positionPriceDates:positions.map(p=>({position:hash(`${p.accountId}:${p.ticker}`),priceAsOf:p.priceAsOf||null})).sort((a,b)=>a.position.localeCompare(b.position))}};
  if(snapshot.historicalInterestReview!==undefined)attachHistoricalReview(next,snapshot.historicalInterestReview,{html,policy});
  if(previous.userConfirmedCapital)validateManualCapital(previous.userConfirmedCapital);
  try { applyTradeUpdates(next, previous, snapshot); }
  catch (error) { throw new ValidationError(/^[A-Z][A-Z_0-9]{0,79}$/.test(error.code) ? error.code : "TRADE_UPDATE_INVALID"); }
  applyUserConfirmedReturnMethod(next, previous, snapshot, {html});
  // Verify through the actual production display path, with old history frozen.
  const ui=browserContract(html), normalized=ui.normalizeData(clone(next));
  same(roundedCents(normalized.totalAssetValue),total,"BROWSER_BALANCE_MISMATCH");
  same(roundedCents(normalized.equityValue),total-cash,"BROWSER_SECURITIES_MISMATCH");
  same(roundedCents(normalized.cashValue),cash,"BROWSER_CASH_MISMATCH");
  requireThat(normalized.holdings.every(item=>!ui.isCashHolding(item)),"BROWSER_CASH_IN_SECURITIES");
  if (!previous.userConfirmedReturnMethod) {
    for(const key of ["totalGain","totalPrincipal","totalCurrentValue","totalReturnPct"])same(normalized.performance[key],previous.performance[key],"PRESERVED_PERFORMANCE_CHANGED");
    same(next.performance,previous.performance,"PRESERVED_HISTORY_CHANGED");
  }
  same(next.income,previous.income,"PRESERVED_HISTORY_CHANGED");
  if (snapshot.tradeUpdates === undefined) same(next.trading,previous.trading,"PRESERVED_HISTORY_CHANGED");
  else same(normalized.trading.reduce((n,row)=>n+row.orders.length,0),Object.values(next.trading).reduce((n,row)=>n+(row.orders||[]).length,0),"BROWSER_TRADE_COUNT_MISMATCH");
  return next;
}

function businessData(data) {
  const copy = clone(data); delete copy.asOf;
  if(copy.assetSnapshot)delete copy.assetSnapshot.retrievedAt;
  return copy;
}
async function prepareUpdate({snapshot, existingBytes, password, html, market, now, policy, encryptFn = encrypt}) {
  requireThat(typeof snapshot?.previousCiphertextSha256 === "string" && snapshot.previousCiphertextSha256 === hash(existingBytes), "BASELINE_CHANGED");
  const envelope = JSON.parse(existingBytes.toString("utf8"));
  const previous = decrypt(envelope, password);
  const next = snapshot.mode === "assets" ? buildAssetPayload(snapshot, previous, {html,now,policy}) : snapshot.mode === "history-review" ? buildHistoricalReviewPayload(snapshot,previous,{html,policy}) : snapshot.mode === "basis-revision" ? buildBasisRevisionPayload(snapshot,previous,{html,policy}) : buildPayload(snapshot, previous, {html, market, now, policy});
  if (canonical(businessData(previous)) === canonical(businessData(next))) return {status: "unchanged"};
  const encrypted = encryptFn(next, password, envelope.iterations);
  same(decrypt(encrypted, password), next, "ENCRYPTION_ROUNDTRIP_FAILED");
  same(await browserContract(html).decryptPayload(encrypted, password), next, "BROWSER_DECRYPTION_FAILED");
  return {status: "changed", bytes: Buffer.from(JSON.stringify(encrypted, null, 2) + "\n")};
}

function readPrivateInput(filename, root) {
  root = fs.realpathSync(root);
  const real = fs.realpathSync(filename), stat = fs.statSync(real);
  requireThat(real !== root && !real.startsWith(root + path.sep), "PRIVATE_INPUT_MUST_BE_OUTSIDE_REPOSITORY");
  requireThat(stat.isFile() && stat.size <= 16 * 1024 * 1024 && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), "PRIVATE_INPUT_PERMISSIONS_REQUIRED");
  return JSON.parse(fs.readFileSync(real, "utf8"));
}
function writeAtomically(target, original, bytes) {
  let temp;
  try {
    temp = path.join(path.dirname(target), `.data.enc.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    same(hash(fs.readFileSync(target)), hash(original), "BASELINE_CHANGED_DURING_RUN");
    fs.renameSync(temp, target); temp = null;
  } finally { if (temp) fs.rmSync(temp, {force: true}); }
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log("Usage: node scripts/update_finances.cjs --input PRIVATE_JSON --policy PRIVATE_JSON [--write]\nRead-only secret-safe inspection: --inspect\nPassword: inherited VISUAL_CARD_PASSWORD_FD only. Default: dry-run; no file write."); return; }
  const inspect = args.length === 1 && args[0] === "--inspect";
  requireThat(inspect || (args[0] === "--input" && args[1] && args[2] === "--policy" && args[3] && (args.length === 4 || (args.length === 5 && args[4] === "--write"))), "INVALID_ARGUMENTS");
  const fd = Number(process.env.VISUAL_CARD_PASSWORD_FD);
  requireThat(Number.isInteger(fd) && fd >= 3 && fd <= 1024, "PASSWORD_FD_REQUIRED");
  let passwordBytes;
  let lock;
  try {
    // No secret is accepted in argv or ordinary environment variable values.
    passwordBytes = fs.readFileSync(fd);
    requireThat(passwordBytes.length > 0 && passwordBytes.length <= 4096, "INVALID_PASSWORD_INPUT");
    const password = new TextDecoder("utf-8", {fatal: true}).decode(passwordBytes).replace(/\r?\n$/, "");
    requireThat(password.length > 0, "INVALID_PASSWORD_INPUT");
    const target = path.join(ROOT, "data.enc.json");
    requireThat(!fs.lstatSync(target).isSymbolicLink(), "SYMLINK_OUTPUT_REJECTED");
    if (inspect) {
      const data = decrypt(JSON.parse(fs.readFileSync(target, "utf8")), password);
      console.log(JSON.stringify({status:"inspected",decrypted:true,hasHoldings:Array.isArray(data.holdings),hasPerformance:!!data.performance,hasTrading:!!data.trading,hasDatedIncome:Array.isArray(data.income)&&data.income.length>0,hasUpdateAudit:!!data.updateAudit}));
      return;
    }
    lock = fs.openSync(path.join(ROOT, ".finances-update.lock"), "wx", 0o600);
    const snapshot = readPrivateInput(args[1], fs.realpathSync(ROOT));
    const existingBytes = fs.readFileSync(target);
    const policy = readPrivateInput(args[3], fs.realpathSync(ROOT));
    const result = await prepareUpdate({snapshot, existingBytes, password, policy, html: fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), market: JSON.parse(fs.readFileSync(path.join(ROOT, "market.prices.json"), "utf8"))});
    if (result.status === "unchanged") return; // Quiet no-op: no randomness, writes, or log output.
    if (args.includes("--write")) writeAtomically(target, existingBytes, result.bytes);
    console.log(JSON.stringify({status: args.includes("--write") ? "changed" : "validated", encryptedSha256: hash(result.bytes)}));
  } finally {
    passwordBytes?.fill(0);
    if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(path.join(ROOT, ".finances-update.lock"), {force: true}); }
  }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({status: "failed", code: error instanceof ValidationError ? error.message : "UPDATE_FAILED", preserved: true})); process.exitCode = 1; });
module.exports = {ValidationError, canonical, hash, validateEnvelope, decrypt, encrypt, browserContract, buildPayload, buildAssetPayload, buildHistoricalReviewPayload, buildBasisRevisionPayload, applyUserConfirmedReturnMethod, businessData, prepareUpdate, writeAtomically, readPrivateInput, main};
