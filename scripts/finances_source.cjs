"use strict";

// Dependency-free normalization for authenticated Finances tool responses. This
// module has no network, file, credential, logging, or clock access. Callers keep
// raw responses and this private snapshot out of Git and ordinary tool output.
class FinancesSourceError extends Error {
  constructor(code) { super(code); this.name = "FinancesSourceError"; this.code = code; }
}
function sourceRequire(ok, code) { if (!ok) throw new FinancesSourceError(code); }
function sourceId(value) {
  sourceRequire(typeof value === "string" && value.length > 0 && value.length <= 512, "SOURCE_INVALID_ID");
  return value;
}
function sourceDate(value) {
  sourceRequire(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "SOURCE_INVALID_DATE");
  const time = Date.parse(`${value}T00:00:00Z`);
  sourceRequire(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "SOURCE_INVALID_DATE");
  return value;
}
function sourceTimestamp(value) {
  sourceRequire(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value), "SOURCE_INVALID_TIMESTAMP");
  sourceDate(value.slice(0, 10));
  sourceRequire(Number.isFinite(Date.parse(value)), "SOURCE_INVALID_TIMESTAMP");
  return new Date(value).toISOString();
}
function sourceCents(value) {
  sourceRequire(typeof value === "number" && Number.isFinite(value) && value >= 0, "SOURCE_INVALID_MONEY");
  const cents = Math.round(value * 100);
  sourceRequire(Number.isSafeInteger(cents), "SOURCE_MONEY_OVERFLOW");
  return cents;
}
function sourceSum(values) {
  return values.reduce((total, value) => {
    const next = total + value;
    sourceRequire(Number.isSafeInteger(next), "SOURCE_MONEY_OVERFLOW");
    return next;
  }, 0);
}
function sourceCurrency(row) {
  sourceRequire(row?.iso_currency_code === "USD" && (row.unofficial_currency_code === undefined || row.unofficial_currency_code === null), "SOURCE_UNSUPPORTED_CURRENCY");
}
function sourceComplete(coverage, dataset) {
  sourceRequire(coverage?.dataset === dataset && coverage.availability === "ready" && coverage.state === "complete" && coverage.is_complete_for_query === true, "SOURCE_INCOMPLETE_ACCOUNT_COVERAGE");
}
function unwrapFinancesResponse(value, expectedKey) {
  let current = value;
  for (let depth = 0; depth < 8; depth++) {
    sourceRequire(current && typeof current === "object" && !Array.isArray(current) && current.isError !== true, "SOURCE_TOOL_ERROR");
    if (Object.prototype.hasOwnProperty.call(current, expectedKey)) return current;
    if (current.structuredContent && typeof current.structuredContent === "object") { current = current.structuredContent; continue; }
    const texts = Array.isArray(current.content) ? current.content.filter(item => item?.type === "text" && typeof item.text === "string") : [];
    sourceRequire(texts.length === 1, "SOURCE_RESPONSE_SHAPE");
    try { current = JSON.parse(texts[0].text); } catch { throw new FinancesSourceError("SOURCE_RESPONSE_SHAPE"); }
  }
  throw new FinancesSourceError("SOURCE_RESPONSE_DEPTH");
}
function sourceBalanceProof(balances, fetchedAt) {
  let updatedAt = null, dateBasis = null;
  if (balances.balance_date !== undefined && balances.balance_date !== null) {
    updatedAt = `${sourceDate(balances.balance_date)}T00:00:00.000Z`;
    dateBasis = "balance_date";
  }
  // Record updates, connector sync times, and query times never date a balance.
  if (balances.last_updated_datetime_source === "source_reported") {
    updatedAt = sourceTimestamp(balances.last_updated_datetime);
    dateBasis = "source_reported";
  }
  if (updatedAt !== null) sourceRequire(Date.parse(updatedAt) <= Date.parse(fetchedAt) + 300000, "SOURCE_FUTURE_BALANCE_DATE");
  return { complete: true, allPagesFetched: true, updatedAt, sourceDateStatus: updatedAt === null ? "unknown" : "known", ...(dateBasis ? { dateBasis } : {}), basis: "observed_account_coverage" };
}
function sourceAccountType(account) {
  if (account.type === "investment" && account.subtype === "brokerage") return "brokerage";
  sourceRequire(account.type === "depository", "SOURCE_UNSUPPORTED_ACCOUNT_TYPE");
  if (account.subtype === "checking") return "checking";
  if (account.subtype === "savings") return "savings";
  sourceRequire(account.subtype === "cd" || account.subtype === "money market", "SOURCE_UNSUPPORTED_ACCOUNT_TYPE");
  return "cash";
}

// holdingsResponses is [{ queries: <exact submitted requests>, response: <raw
// tool result or unwrapped {results}> }]. The query is required because an empty
// page does not echo its account_id. Every cursor chain starts at null, keeps the
// same request shape, and ends at an observed has_more:false / next_cursor:null.
function normalizeAssetSnapshot({ linkedAccounts, holdingsResponses, fetchedAt, baselineSha256, policy } = {}) {
  const retrieved = sourceTimestamp(fetchedAt);
  sourceRequire(typeof baselineSha256 === "string" && /^[a-f0-9]{64}$/.test(baselineSha256), "SOURCE_INVALID_BASELINE_HASH");
  sourceRequire(Array.isArray(policy?.accountIds) && policy.accountIds.length > 0, "SOURCE_APPROVED_POLICY_REQUIRED");
  const approved = new Set(policy.accountIds.map(sourceId));
  sourceRequire(approved.size === policy.accountIds.length, "SOURCE_DUPLICATE_POLICY_ACCOUNT");
  const linked = unwrapFinancesResponse(linkedAccounts, "institutions");
  sourceRequire(Array.isArray(linked.institutions), "SOURCE_RESPONSE_SHAPE");
  const selected = new Map();
  for (const institution of linked.institutions) {
    sourceRequire(Array.isArray(institution?.accounts), "SOURCE_RESPONSE_SHAPE");
    for (const account of institution.accounts) {
      if (!approved.has(account?.account_id)) continue;
      sourceRequire(!selected.has(account.account_id), "SOURCE_DUPLICATE_ACCOUNT");
      sourceRequire(!institution.deleted_at && !institution.is_reset_tombstone, "SOURCE_DELETED_INSTITUTION");
      sourceComplete(institution.account_coverage, "accounts");
      const type = sourceAccountType(account);
      sourceCurrency(account.balances);
      const totalCents = sourceCents(account.balances.current);
      selected.set(account.account_id, {
        id: account.account_id, type, currency: "USD", totalCents,
        cashCents: type === "brokerage" ? 0 : totalCents, securitiesCents: 0,
        coverage: {
          balances: sourceBalanceProof(account.balances, retrieved),
          holdings: { complete: true, allPagesFetched: true, updatedAt: null, sourceDateStatus: "unknown", basis: type === "brokerage" ? "queried_pages_reconciled_to_account_balance" : "depository_account_classification" }
        }
      });
    }
  }
  sourceRequire(selected.size === approved.size, "SOURCE_APPROVED_ACCOUNT_MISSING");
  sourceRequire(Array.isArray(holdingsResponses), "SOURCE_HOLDINGS_RESPONSES_REQUIRED");
  const pages = new Map();
  const stable = value => JSON.stringify(value, Object.keys(value).sort());
  const queryAllowed = new Set(["query_type", "account_id", "cursor", "limit", "order_by_field", "order_by_direction", "select_fields"]);
  const requiredFields = ["account_id", "security_id", "ticker_symbol", "is_cash_equivalent", "type", "quantity", "institution_price", "institution_value", "iso_currency_code"];
  const allowedFields = new Set([...requiredFields, "provider", "item_id", "account_name", "name", "subtype", "institution_price_as_of", "institution_price_datetime", "cost_basis", "unofficial_currency_code", "vested_quantity", "vested_value"]);
  for (const batch of holdingsResponses) {
    sourceRequire(Array.isArray(batch?.queries) && batch.queries.length > 0, "SOURCE_QUERY_CONTEXT_REQUIRED");
    const response = unwrapFinancesResponse(batch.response, "results");
    sourceRequire(Array.isArray(response.results) && response.results.length === batch.queries.length, "SOURCE_QUERY_RESULTS_MISSING");
    const indices = new Set();
    for (const result of response.results) {
      sourceRequire(Number.isSafeInteger(result?.index) && result.index >= 0 && result.index < batch.queries.length && !indices.has(result.index), "SOURCE_QUERY_INDEX_INVALID");
      indices.add(result.index);
      const query = batch.queries[result.index];
      sourceRequire(query && Object.keys(query).every(key => queryAllowed.has(key)) && query.query_type === "investment_holdings", "SOURCE_FILTERED_OR_UNSUPPORTED_QUERY");
      if (query.select_fields !== undefined && query.select_fields !== null) {
        sourceRequire(Array.isArray(query.select_fields) && requiredFields.every(field => query.select_fields.includes(field)) && query.select_fields.every(field => allowedFields.has(field)) && new Set(query.select_fields).size === query.select_fields.length, "SOURCE_INCOMPLETE_PROJECTION");
      }
      if (query.limit !== undefined) sourceRequire(Number.isSafeInteger(query.limit) && query.limit > 0, "SOURCE_INVALID_QUERY_LIMIT");
      if (query.order_by_field !== undefined && query.order_by_field !== null) sourceRequire(allowedFields.has(query.order_by_field), "SOURCE_INVALID_QUERY_ORDER");
      if (query.order_by_direction !== undefined && query.order_by_direction !== null) sourceRequire(["asc", "desc"].includes(query.order_by_direction), "SOURCE_INVALID_QUERY_ORDER");
      if (typeof query.account_id !== "string") sourceRequire(query.account_id && Object.keys(query.account_id).sort().join(",") === "op,val", "SOURCE_INVALID_ACCOUNT_FILTER");
      const accountId = typeof query.account_id === "string" ? query.account_id : query.account_id?.op === "eq" ? query.account_id.val : null;
      sourceId(accountId);
      sourceRequire(selected.get(accountId)?.type === "brokerage", "SOURCE_QUERY_ACCOUNT_MISMATCH");
      sourceRequire(result.query_type === "investment_holdings" && result.is_error === false, "SOURCE_HOLDINGS_QUERY_FAILED");
      const page = result.result;
      sourceRequire(page && Array.isArray(page.items) && typeof page.has_more === "boolean" && (page.next_cursor === null || typeof page.next_cursor === "string"), "SOURCE_HOLDINGS_PAGE_SHAPE");
      sourceRequire(page.has_more ? typeof page.next_cursor === "string" && page.next_cursor.length > 0 : page.next_cursor === null, "SOURCE_CURSOR_STATE_INVALID");
      const coverage = page.coverage || result.coverage;
      if (coverage) sourceRequire(coverage.availability === "ready" && coverage.is_complete_for_query === true && coverage.state === "complete", "SOURCE_INCOMPLETE_HOLDINGS_COVERAGE");
      const cursor = query.cursor ?? null;
      sourceRequire(cursor === null || (typeof cursor === "string" && cursor.length > 0), "SOURCE_CURSOR_STATE_INVALID");
      const base = { ...query, account_id: accountId }; delete base.cursor;
      const entries = pages.get(accountId) || new Map();
      sourceRequire(!entries.has(cursor), "SOURCE_DUPLICATE_PAGE");
      entries.set(cursor, { page, signature: stable(base) }); pages.set(accountId, entries);
    }
  }
  const positions = [];
  for (const account of selected.values()) {
    if (account.type !== "brokerage") continue;
    const entries = pages.get(account.id);
    sourceRequire(entries?.has(null), "SOURCE_HOLDINGS_FIRST_PAGE_MISSING");
    const visited = new Set(), securityIds = new Set(), tickers = new Set();
    const signature = entries.get(null).signature;
    let cursor = null, cashRows = 0;
    const cash = [], securities = [];
    while (true) {
      sourceRequire(!visited.has(cursor), "SOURCE_CURSOR_CYCLE");
      visited.add(cursor);
      const entry = entries.get(cursor);
      sourceRequire(entry && entry.signature === signature, "SOURCE_PAGE_MISSING_OR_QUERY_CHANGED");
      for (const row of entry.page.items) {
        sourceRequire(row?.account_id === account.id, "SOURCE_HOLDING_ACCOUNT_MISMATCH");
        sourceId(row.security_id);
        sourceRequire(!securityIds.has(row.security_id), "SOURCE_DUPLICATE_SECURITY"); securityIds.add(row.security_id);
        sourceCurrency(row);
        const value = sourceCents(row.institution_value);
        const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
        sourceRequire(typeof row.is_cash_equivalent === "boolean", "SOURCE_CASH_CLASSIFICATION_MISSING");
        sourceRequire(!(type === "cash" && !row.is_cash_equivalent) && !(["equity", "stock", "etf"].includes(type) && row.is_cash_equivalent), "SOURCE_CASH_CLASSIFICATION_CONFLICT");
        if (row.is_cash_equivalent || type === "cash") {
          if (row.quantity !== undefined && row.quantity !== null) sourceRequire(typeof row.quantity === "number" && Number.isFinite(row.quantity) && row.quantity >= 0, "SOURCE_INVALID_QUANTITY");
          if (row.institution_price !== undefined && row.institution_price !== null) sourceRequire(typeof row.institution_price === "number" && Number.isFinite(row.institution_price) && row.institution_price >= 0, "SOURCE_INVALID_PRICE");
          cash.push(value); cashRows++; continue;
        }
        sourceRequire(["equity", "stock", "etf"].includes(type), "SOURCE_UNSUPPORTED_SECURITY_TYPE");
        sourceRequire(typeof row.ticker_symbol === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.ticker_symbol) && !["CASH", "CD"].includes(row.ticker_symbol), "SOURCE_INVALID_TICKER");
        sourceRequire(!tickers.has(row.ticker_symbol), "SOURCE_DUPLICATE_TICKER"); tickers.add(row.ticker_symbol);
        sourceRequire(typeof row.quantity === "number" && Number.isFinite(row.quantity) && row.quantity > 0, "SOURCE_INVALID_QUANTITY");
        sourceRequire(typeof row.institution_price === "number" && Number.isFinite(row.institution_price) && row.institution_price > 0, "SOURCE_INVALID_PRICE");
        sourceRequire(Math.abs(sourceCents(row.quantity * row.institution_price) - value) <= 1, "SOURCE_POSITION_VALUE_MISMATCH");
        const position = { accountId: account.id, ticker: row.ticker_symbol, type: type === "etf" ? "etf" : "stock", shares: row.quantity, valueCents: value };
        if (row.cost_basis !== null && row.cost_basis !== undefined) position.costBasisCents = sourceCents(row.cost_basis);
        let priceDate = null;
        if (row.institution_price_datetime !== null && row.institution_price_datetime !== undefined) {
          const timestamp = sourceTimestamp(row.institution_price_datetime);
          sourceRequire(Date.parse(timestamp) <= Date.parse(retrieved) + 300000, "SOURCE_FUTURE_PRICE_DATE");
          priceDate = timestamp.slice(0, 10);
        }
        if (row.institution_price_as_of !== null && row.institution_price_as_of !== undefined) priceDate = sourceDate(row.institution_price_as_of);
        if (priceDate) {
          sourceRequire(Date.parse(`${priceDate}T00:00:00Z`) <= Date.parse(retrieved), "SOURCE_FUTURE_PRICE_DATE");
          position.priceAsOf = priceDate;
        }
        securities.push(value); positions.push(position);
      }
      if (!entry.page.has_more) break;
      cursor = entry.page.next_cursor;
    }
    sourceRequire(visited.size === entries.size, "SOURCE_ORPHAN_HOLDINGS_PAGE");
    sourceRequire(cashRows > 0, "SOURCE_EXPLICIT_CASH_HOLDING_REQUIRED");
    account.cashCents = sourceSum(cash); account.securitiesCents = sourceSum(securities);
    sourceRequire(sourceSum([account.cashCents, account.securitiesCents]) === account.totalCents, "SOURCE_BROKER_BALANCE_MISMATCH");
  }
  const accounts = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
  positions.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.ticker.localeCompare(b.ticker));
  return {
    schemaVersion: 2, mode: "assets", source: "Finances", currency: "USD", fetchedAt: retrieved,
    previousCiphertextSha256: baselineSha256,
    coverage: { accountsComplete: true, allPagesFetched: true, accountIds: [...approved].sort() },
    accounts, positions,
    reconciliation: { independentSourceTotals: true, totalValueCents: sourceSum(accounts.map(account => account.totalCents)), cashCents: sourceSum(accounts.map(account => account.totalCents - account.securitiesCents)) }
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { FinancesSourceError, normalizeAssetSnapshot, unwrapFinancesResponse };
