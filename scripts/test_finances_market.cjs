#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const market = require("./finances_market.cjs");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const oid = text => crypto.createHash("sha1").update(text).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const HEAD = oid("synthetic immutable head"), ROOT = oid("synthetic root tree"), SCRIPTS = oid("synthetic scripts tree");
const API = "https://api.github.com/repos/yuchen-mei/visual-card";
const ranges = () => ({ SPY: "2026-01-02", QQQ: "2026-01-02", LIVE: "2026-01-05" });
const rows = (...dates) => dates.map((date, index) => ({ date, close: 100 + index }));
const prices = () => ({ SPY: rows("2026-01-02", "2026-01-05"), QQQ: rows("2026-01-02", "2026-01-05"), LIVE: rows("2026-01-05"), OLD: rows("2025-06-02", "2025-06-03") });
const data = () => ({ asOf: "2026-01-05", source: "yahoo-chart", generatedAt: "2026-01-05T23:00:00Z", prices: prices() });
function event(kind, ticker, date = "2026-01-06", firstKnownBuyDate = date) { return { id: hash([kind, ticker, date].join(":")), kind, ticker, date, firstKnownBuyDate }; }
function fixture(options = {}) {
  const rangeText = options.rangeText || JSON.stringify(ranges(), null, 2) + "\n";
  const marketText = options.marketText || JSON.stringify(data(), null, 4) + "\r\n";
  const rangeOid = oid(rangeText), marketOid = oid(marketText), calls = [];
  const blobs = new Map([[rangeOid, rangeText], [marketOid, marketText]]);
  function wrap(value) { return options.wrapped ? { isError: false, structuredContent: { content: JSON.stringify(value) }, content: [{ type: "text", text: "Action completed." }] } : value; }
  const publication = { hash, github: { fetch: async ({ url }) => {
    calls.push(url);
    assert.ok(!url.includes("/main") && !url.includes("/ref/"), "never read a moving branch");
    if (url === `${API}/git/commits/${HEAD}`) return wrap({ sha: options.wrongCommit ? oid("other commit") : HEAD, tree: { sha: ROOT } });
    if (url === `${API}/git/trees/${ROOT}`) return wrap({ sha: ROOT, truncated: !!options.truncated, tree: [
      { path: "scripts", type: "tree", mode: "040000", sha: SCRIPTS },
      { path: "market.prices.json", type: "blob", mode: options.symlink ? "120000" : "100644", sha: marketOid },
      { path: "data.enc.json", type: "blob", mode: "100644", sha: oid("unread opaque ciphertext") }
    ] });
    if (url === `${API}/git/trees/${SCRIPTS}`) return wrap({ sha: options.wrongTree ? ROOT : SCRIPTS, truncated: false, tree: [{ path: "market_price_ranges.json", type: "blob", mode: "100644", sha: rangeOid }] });
    const found = url.match(/\/git\/blobs\/([a-f0-9]{40})$/);
    assert.ok(found && blobs.has(found[1]), "read only the two bound public blobs");
    const content = blobs.get(found[1]);
    if (options.decoded) return { isError: false, structuredContent: { url: options.wrongUrl ? `${url}?unbound` : url, content }, content: [{ type: "text", text: "Action completed." }] };
    return wrap({ sha: options.wrongBlob ? oid("other blob") : found[1], encoding: "base64", content: options.invalidUtf8 ? "/w==" : Buffer.from(content, "utf8").toString("base64") });
  } } };
  return { publication, calls, rangeText, marketText, rangeOid, marketOid };
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("immutable same-commit read preserves exact UTF8 text and SHA256 for both files", async () => {
  const f = fixture({ decoded: true }), result = await market.readMarketBaseline(HEAD, f.publication);
  assert.equal(result.head, HEAD); assert.equal(result.treeSha, ROOT); assert.equal(f.calls.length, 5);
  assert.deepEqual(result.ranges, ranges()); assert.deepEqual(result.market, data());
  assert.deepEqual(result.files, [
    { path: market.RANGE_PATH, blobSha: f.rangeOid, content: f.rangeText, sha256: hash(f.rangeText) },
    { path: market.MARKET_PATH, blobSha: f.marketOid, content: f.marketText, sha256: hash(f.marketText) }
  ]);
});
test("REST base64 and nested connector wrappers follow the same immutable protocol", async () => {
  const f = fixture({ wrapped: true }), result = await market.readMarketBaseline(HEAD, f.publication);
  assert.equal(result.files[1].content, f.marketText); assert.deepEqual(result.market, data());
  assert.ok(f.calls.every(url => !url.includes("main")));
});
test("wrong commit tree blob URL and symlink bindings fail closed", async () => {
  for (const options of [{ wrongCommit: true }, { wrongTree: true }, { wrongBlob: true }, { decoded: true, wrongUrl: true }, { symlink: true }, { truncated: true }, { invalidUtf8: true }]) {
    const f = fixture(options); await assert.rejects(market.readMarketBaseline(HEAD, f.publication), error => error instanceof market.MarketError);
  }
});
test("branch names never substitute for the immutable commit argument", async () => {
  const f = fixture(); await assert.rejects(market.readMarketBaseline("main", f.publication), { code: "E_MARKET_HEAD" }); assert.equal(f.calls.length, 0);
});
test("unknown public fields and concealed duplicate keys are rejected before hashing", async () => {
  for (const marketText of [JSON.stringify({ ...data(), accountId: "synthetic forbidden field" }), JSON.stringify(data()).replace('"source":"yahoo-chart"', '"source":"synthetic hidden value","source":"yahoo-chart"')]) {
    const f = fixture({ decoded: true, marketText });
    await assert.rejects(market.readMarketBaseline(HEAD, f.publication), error => ["E_MARKET_FIELDS", "E_MARKET_DUPLICATE_KEY"].includes(error.code));
  }
  const f = fixture({ rangeText: '{"SPY":"2026-01-02","\\u0053PY":"2026-01-03"}' });
  await assert.rejects(market.readMarketBaseline(HEAD, f.publication), { code: "E_MARKET_DUPLICATE_KEY" });
});
test("read and hashing failures expose fixed codes without injected diagnostics", async () => {
  let f = fixture(); f.publication.github.fetch = async () => { throw new Error("synthetic opaque diagnostic"); };
  await assert.rejects(market.readMarketBaseline(HEAD, f.publication), { message: "E_MARKET_READ" });
  f = fixture(); f.publication.hash = () => "invalid";
  await assert.rejects(market.readMarketBaseline(HEAD, f.publication), { code: "E_MARKET_HASH" });
});
test("protected benchmark settings survive close and earlier reopen events", () => {
  const before = ranges();
  const result = market.planRanges({ ranges: before, prices: prices(), events: [event("closed", "SPY", "2026-01-06", null), event("reopened", "QQQ", "2026-01-06", "2020-01-02")] });
  assert.deepEqual(result.ranges, { LIVE: before.LIVE, QQQ: before.QQQ, SPY: before.SPY });
  assert.equal(result.changed, false); assert.equal(result.shouldFetch, false);
});
test("close removes only active range and never mutates or deletes archived history", () => {
  const input = { ranges: ranges(), prices: prices(), events: [event("closed", "LIVE", "2026-01-06", "2026-01-05")] }, original = clone(input);
  const result = market.planRanges(input);
  assert.equal(result.ranges.LIVE, undefined); assert.equal(result.changed, true); assert.equal(result.shouldFetch, true);
  assert.deepEqual(input, original); assert.deepEqual(input.prices.OLD, original.prices.OLD);
});
test("reopen keeps earliest actual buy configured start or archived first price", () => {
  const result = market.planRanges({ ranges: ranges(), prices: prices(), events: [event("reopened", "OLD", "2026-01-06", "2026-01-06"), event("opened", "NEW", "2026-01-06", "2026-01-05")] });
  assert.equal(result.ranges.OLD, "2025-06-02"); assert.equal(result.ranges.NEW, "2026-01-05");
  const earlier = market.planRanges({ ranges: ranges(), prices: prices(), events: [event("reopened", "LIVE", "2026-01-06", "2025-01-02")] });
  assert.equal(earlier.ranges.LIVE, "2025-01-02");
});
test("empty or semantically unchanged events do not trigger market fetch", () => {
  for (const events of [[], [event("closed", "OLD", "2026-01-06", null)], [event("reopened", "LIVE", "2026-01-06", "2026-01-06")]]) {
    const result = market.planRanges({ ranges: ranges(), prices: prices(), events }); assert.equal(result.changed, false); assert.equal(result.shouldFetch, false);
  }
});
test("conflicting same-ticker events never infer ordering from hashes", () => {
  const events = [event("opened", "NEW", "2026-01-05"), event("closed", "NEW", "2026-01-06", "2026-01-05")];
  for (const ordered of [events, events.slice().reverse()]) assert.throws(() => market.validateEvents(ordered), { code: "E_POSITION_MARKET_CONFLICT" });
});
test("event schema refuses raw identifiers extra values unknown dates and duplicate IDs", () => {
  const bad = [
    { ...event("opened", "NEW"), id: "raw-provider-id" },
    { ...event("opened", "NEW"), accountId: "synthetic forbidden field" },
    { ...event("opened", "NEW"), firstKnownBuyDate: null },
    { ...event("reopened", "NEW"), firstKnownBuyDate: "2026-02-30" },
    { ...event("opened", "NEW"), firstKnownBuyDate: "2026-02-01" },
    { ...event("opened", "NEW"), kind: "guessed" }
  ];
  for (const value of bad) assert.throws(() => market.validateEvents([value]), error => error instanceof market.MarketError);
  const one = event("opened", "NEW"); assert.throws(() => market.validateEvents([one, { ...one, ticker: "OTHER" }]), { code: "E_POSITION_MARKET_ID" });
});
test("public validators return originals and reject non-public fields malformed prices and empty ranges", () => {
  const r = ranges(), p = prices(), d = data(); assert.equal(market.validateRanges(r), r); assert.equal(market.validatePrices(p), p); assert.equal(market.validateMarketData(d), d);
  for (const mutate of [
    v => { v.prices.LIVE[0].quantity = 10; }, v => { v.source = "unapproved source"; },
    v => { v.generatedAt = "2026-02-30T00:00:00Z"; }, v => { v.prices.LIVE[0].close = NaN; },
    v => { v.prices.LIVE[0].close = true; }, v => { v.prices.LIVE.push(v.prices.LIVE[0]); },
    v => { v.prices.LIVE[0].date = "2026-01-06"; }
  ]) { const value = data(); mutate(value); assert.throws(() => market.validateMarketData(value), error => error instanceof market.MarketError); }
  assert.throws(() => market.validateRanges({}), { code: "E_MARKET_RANGES" });
  assert.throws(() => market.validateRanges({ NEW: { start: "2026-01-05" } }), { code: "E_MARKET_DATE" });
});
test("portable UMD works without require Buffer process or IO globals", async () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, "finances_market.cjs"), "utf8"), context);
  const api = context.VisualCardMarket, result = api.planRanges({ ranges: ranges(), prices: prices(), events: [] });
  assert.equal(result.changed, false);
  const f = fixture({ wrapped: true }), baseline = await api.readMarketBaseline(HEAD, f.publication);
  assert.equal(baseline.files[1].content, f.marketText);
});
test("cash and CD cannot enter public ranges prices or position events", () => {
  for (const ticker of ["CASH", "CD"]) {
    assert.throws(() => market.validateRanges({ [ticker]: "2026-01-05" }), { code: "E_MARKET_TICKER" });
    assert.throws(() => market.validatePrices({ [ticker]: rows("2026-01-05") }), { code: "E_MARKET_TICKER" });
    assert.throws(() => market.validateEvents([event("opened", ticker)]), { code: "E_POSITION_MARKET_EVENT" });
  }
});
(async () => {
  for (const item of tests) { await item.run(); console.log(`ok - ${item.name}`); }
  console.log(`${tests.length} tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
