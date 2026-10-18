"use strict";

// Portable public-market planning. No credentials, clock, filesystem, or network
// are accessed on import. The immutable GitHub reader uses injected callbacks.
(function install(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VisualCardMarket = api;
})(globalThis, function factory() {
  const API = "https://api.github.com/repos/yuchen-mei/visual-card";
  const RANGE_PATH = "scripts/market_price_ranges.json", MARKET_PATH = "market.prices.json";
  const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
  const MAX_TEXT = 24 * 1024 * 1024;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  class MarketError extends Error { constructor(code) { super(code); this.name = "MarketError"; this.code = code; } }
  function need(ok, code) { if (!ok) throw new MarketError(code); }
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, keys) => record(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");
  function ticker(value) { return typeof value === "string" && value.length <= 15 && !["CASH", "CD"].includes(value) && /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(value); }
  function date(value) {
    need(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "E_MARKET_DATE");
    const time = Date.parse(`${value}T00:00:00Z`);
    need(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "E_MARKET_DATE");
    return value;
  }
  function validateRanges(value) {
    need(record(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 1000, "E_MARKET_RANGES");
    for (const [key, start] of Object.entries(value)) { need(ticker(key), "E_MARKET_TICKER"); date(start); }
    return value;
  }
  function validatePrices(value) {
    need(record(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 1000, "E_MARKET_PRICES");
    let count = 0;
    for (const [key, rows] of Object.entries(value)) {
      need(ticker(key), "E_MARKET_TICKER");
      need(Array.isArray(rows) && rows.length > 0 && rows.length <= 100000, "E_MARKET_ROWS");
      let previous = "";
      for (const row of rows) {
        need(exact(row, ["date", "close"]), "E_MARKET_ROW_FIELDS");
        date(row.date); need(row.date > previous, "E_MARKET_ROW_ORDER"); previous = row.date;
        need(typeof row.close === "number" && Number.isFinite(row.close) && row.close > 0, "E_MARKET_CLOSE");
      }
      count += rows.length; need(count <= 500000, "E_MARKET_ROWS");
    }
    return value;
  }
  function validateMarketData(value) {
    need(exact(value, ["asOf", "source", "generatedAt", "prices"]), "E_MARKET_FIELDS");
    date(value.asOf); need(value.source === "yahoo-chart", "E_MARKET_SOURCE");
    need(typeof value.generatedAt === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(value.generatedAt) && Number.isFinite(Date.parse(value.generatedAt)), "E_MARKET_TIMESTAMP");
    date(value.generatedAt.slice(0, 10)); validatePrices(value.prices);
    for (const rows of Object.values(value.prices)) need(rows[rows.length - 1].date <= value.asOf, "E_MARKET_AFTER_ASOF");
    return value;
  }
  function validateEvents(events) {
    need(Array.isArray(events) && events.length <= 1000, "E_POSITION_MARKET_EVENTS");
    const ids = new Set(), tickers = new Set();
    for (const event of events) {
      need(exact(event, ["id", "kind", "ticker", "date", "firstKnownBuyDate"]), "E_POSITION_MARKET_FIELDS");
      need(typeof event.id === "string" && HASH.test(event.id) && !ids.has(event.id), "E_POSITION_MARKET_ID"); ids.add(event.id);
      need(["opened", "reopened", "closed"].includes(event.kind) && ticker(event.ticker), "E_POSITION_MARKET_EVENT");
      date(event.date);
      if (event.firstKnownBuyDate !== null || event.kind !== "closed") { date(event.firstKnownBuyDate); need(event.firstKnownBuyDate <= event.date, "E_POSITION_MARKET_DATE"); }
      need(!tickers.has(event.ticker), "E_POSITION_MARKET_CONFLICT"); tickers.add(event.ticker);
    }
    return events;
  }
  function planRanges({ ranges, prices, events } = {}) {
    validateRanges(ranges); validatePrices(prices); validateEvents(events);
    const next = Object.fromEntries(Object.entries(ranges));
    for (const event of events) {
      if (["SPY", "QQQ"].includes(event.ticker) && Object.hasOwn(ranges, event.ticker)) continue;
      if (event.kind === "closed") delete next[event.ticker];
      else {
        const starts = [event.firstKnownBuyDate];
        if (Object.hasOwn(ranges, event.ticker)) starts.push(ranges[event.ticker]);
        if (Object.hasOwn(prices, event.ticker)) starts.push(prices[event.ticker][0].date);
        next[event.ticker] = starts.sort()[0];
      }
    }
    const ordered = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    validateRanges(ordered);
    const changed = Object.keys(ranges).length !== Object.keys(ordered).length || Object.keys(ordered).some(key => ranges[key] !== ordered[key]);
    return { ranges: ordered, changed, shouldFetch: changed };
  }
  function validText(value) {
    if (typeof value !== "string" || value.length > MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return false;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { const d = value.charCodeAt(++i); if (!(d >= 0xdc00 && d <= 0xdfff)) return false; }
      else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
  }
  function parsePublicJSON(text) {
    need(validText(text), "E_MARKET_TEXT");
    let value; try { value = JSON.parse(text); } catch { throw new MarketError("E_MARKET_JSON"); }
    // Duplicate keys can conceal disallowed raw text behind a permitted value.
    // Reject them while retaining the original formatting for byte hashing.
    let at = 0;
    const space = () => { while (/\s/.test(text[at] || "") && at < text.length) at++; };
    function string() {
      const start = at++;
      while (at < text.length) { if (text[at++] === "\\") at++; else if (text[at - 1] === '"') return JSON.parse(text.slice(start, at)); }
      throw new MarketError("E_MARKET_JSON");
    }
    function visit(depth) {
      need(depth <= 64, "E_MARKET_JSON"); space();
      if (text[at] === '"') { string(); return; }
      if (text[at] === "{") {
        at++; space(); const seen = new Set();
        if (text[at] === "}") { at++; return; }
        do {
          space(); const key = string(); need(!seen.has(key), "E_MARKET_DUPLICATE_KEY"); seen.add(key);
          space(); at++; visit(depth + 1); space();
          if (text[at++] === "}") return;
        } while (at < text.length);
      } else if (text[at] === "[") {
        at++; space(); if (text[at] === "]") { at++; return; }
        do { visit(depth + 1); space(); if (text[at++] === "]") return; } while (at < text.length);
      } else { while (at < text.length && !/[\s,}\]]/.test(text[at])) at++; return; }
      throw new MarketError("E_MARKET_JSON");
    }
    visit(0); space(); need(at === text.length, "E_MARKET_JSON"); return value;
  }
  function unwrap(raw) {
    let value = raw;
    for (let i = 0; i < 8; i++) {
      need(value && value.isError !== true, "E_MARKET_TOOL");
      if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new MarketError("E_MARKET_TOOL"); } }
      else if (record(value.structuredContent)) value = value.structuredContent;
      else if (typeof value.content === "string") { try { value = JSON.parse(value.content); } catch { return value; } }
      else if (Array.isArray(value.content)) { const texts = value.content.filter(item => item?.type === "text"); need(texts.length === 1, "E_MARKET_TOOL"); value = texts[0].text; }
      else { need(record(value), "E_MARKET_TOOL"); return value; }
    }
    throw new MarketError("E_MARKET_TOOL");
  }
  function base64Text(text) {
    need(typeof text === "string" && text.length <= MAX_TEXT * 2, "E_MARKET_BASE64");
    const value = text.replace(/[\r\n\t ]/g, "");
    need(value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "E_MARKET_BASE64");
    const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    need(!pad || (alphabet.indexOf(value[value.length - pad - 1]) & (pad === 2 ? 15 : 3)) === 0, "E_MARKET_BASE64");
    const bytes = [], length = value.length / 4 * 3 - pad;
    for (let i = 0; i < value.length; i += 4) {
      const n = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12) | (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]));
      for (const shift of [16, 8, 0]) if (bytes.length < length) bytes.push((n >> shift) & 255);
    }
    const out = [];
    for (let i = 0; i < bytes.length;) {
      let c = bytes[i++], n, min;
      if (c < 128) { out.push(String.fromCharCode(c)); continue; }
      if (c >= 194 && c <= 223) { n = 1; min = 128; c &= 31; }
      else if (c >= 224 && c <= 239) { n = 2; min = 2048; c &= 15; }
      else if (c >= 240 && c <= 244) { n = 3; min = 65536; c &= 7; }
      else throw new MarketError("E_MARKET_UTF8");
      need(i + n <= bytes.length, "E_MARKET_UTF8");
      for (let k = 0; k < n; k++) { const b = bytes[i++]; need((b & 192) === 128, "E_MARKET_UTF8"); c = (c << 6) | (b & 63); }
      need(c >= min && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff), "E_MARKET_UTF8"); out.push(String.fromCodePoint(c));
    }
    return out.join("");
  }
  async function fetchRaw(url, publication) {
    let raw; try { raw = await publication.github.fetch({ url }); } catch { throw new MarketError("E_MARKET_READ"); }
    need(raw && raw.isError !== true, "E_MARKET_READ");
    if (record(raw.structuredContent) && typeof raw.structuredContent.url === "string") need(raw.structuredContent.url === url, "E_MARKET_READ_BINDING");
    return raw;
  }
  async function tree(sha, publication) {
    const value = unwrap(await fetchRaw(`${API}/git/trees/${sha}`, publication));
    need(value.sha === sha && value.truncated === false && Array.isArray(value.tree) && value.tree.length <= 20000, "E_MARKET_TREE");
    const seen = new Set();
    for (const row of value.tree) {
      need(record(row) && typeof row.path === "string" && row.path.length > 0 && row.path.length <= 1024 && !/[\/\\\x00-\x1f\x7f]/.test(row.path) && ![".", ".."].includes(row.path) && !seen.has(row.path) && SHA.test(row.sha || ""), "E_MARKET_TREE");
      need((row.type === "tree" && row.mode === "040000") || (row.type === "blob" && ["100644", "100755", "120000"].includes(row.mode)) || (row.type === "commit" && row.mode === "160000"), "E_MARKET_TREE"); seen.add(row.path);
    }
    return value.tree;
  }
  async function readMarketBaseline(head, publication) {
    need(typeof head === "string" && SHA.test(head), "E_MARKET_HEAD");
    need(typeof publication?.github?.fetch === "function" && typeof publication.hash === "function", "E_MARKET_DEPENDENCIES");
    const commit = unwrap(await fetchRaw(`${API}/git/commits/${head}`, publication));
    need(commit.sha === head && SHA.test(commit.tree?.sha || ""), "E_MARKET_COMMIT");
    const root = await tree(commit.tree.sha, publication);
    const directory = root.find(row => row.path === "scripts"), market = root.find(row => row.path === MARKET_PATH);
    need(directory?.type === "tree" && directory.mode === "040000", "E_MARKET_FILE");
    const children = await tree(directory.sha, publication), ranges = children.find(row => row.path === "market_price_ranges.json");
    const entries = [[RANGE_PATH, ranges], [MARKET_PATH, market]], files = [], parsed = [];
    for (const [path, entry] of entries) {
      need(entry?.type === "blob" && entry.mode === "100644", "E_MARKET_FILE");
      const url = `${API}/git/blobs/${entry.sha}`, raw = await fetchRaw(url, publication);
      let content;
      if (record(raw.structuredContent) && typeof raw.structuredContent.url === "string") {
        need(typeof raw.structuredContent.content === "string", "E_MARKET_BLOB"); content = raw.structuredContent.content;
      } else {
        const blob = unwrap(raw); need(blob.sha === entry.sha && blob.encoding === "base64", "E_MARKET_BLOB"); content = base64Text(blob.content);
      }
      const value = parsePublicJSON(content);
      if (path === RANGE_PATH) validateRanges(value); else validateMarketData(value);
      let sha256; try { sha256 = await publication.hash(content); } catch { throw new MarketError("E_MARKET_HASH"); }
      need(typeof sha256 === "string" && HASH.test(sha256), "E_MARKET_HASH");
      files.push({ path, blobSha: entry.sha, content, sha256 }); parsed.push(value);
    }
    return { head, treeSha: commit.tree.sha, ranges: parsed[0], market: parsed[1], files };
  }
  return { RANGE_PATH, MARKET_PATH, MarketError, validateRanges, validatePrices, validateMarketData, validateEvents, parsePublicJSON, planRanges, readMarketBaseline };
});
