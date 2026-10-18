#!/usr/bin/env node
"use strict";
// This boundary accepts public tickers, dates and prices only. It never writes
// repository files, and child-process diagnostics never enter its protocol.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");
const Market = require("./finances_market.cjs");

const ROOT = fs.realpathSync(path.join(__dirname, ".."));
const SCRIPT = path.join(ROOT, "scripts", "fetch_market_prices.py");
const BASELINE = path.join(ROOT, "market.prices.json");
const MAX_BYTES = 1024 * 1024;
const ERROR = "E_MARKET_PREPARATION";

function failure() { const error = Error(ERROR); error.code = ERROR; return error; }
function check(ok) { if (!ok) throw failure(); }
function exactKeys(value, keys) {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"));
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function pretty(value) { return JSON.stringify(value, null, 2) + "\n"; }
function date(value) {
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const n = Date.parse(value + "T00:00:00Z");
  check(Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value);
  return n;
}
function privateDirectory(value) {
  check(typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value);
  const real = fs.realpathSync(value), st = fs.lstatSync(value);
  check(real === value && !st.isSymbolicLink() && st.isDirectory());
  check(real !== ROOT && !real.startsWith(ROOT + path.sep));
  check(st.uid === process.getuid() && (st.mode & 0o777) === 0o700);
  return {path:real, dev:st.dev, ino:st.ino};
}
function sameDirectory(expected) {
  const actual = privateDirectory(expected.path);
  check(actual.dev === expected.dev && actual.ino === expected.ino);
}
function writePrivate(file, content) {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    check(st.isFile() && st.nlink === 1 && st.uid === process.getuid() && (st.mode & 0o777) === 0o600 && st.size <= MAX_BYTES);
    const content = fs.readFileSync(fd, "utf8");
    check(Buffer.byteLength(content) <= MAX_BYTES);
    return content;
  } finally { fs.closeSync(fd); }
}
function loadBoundBaseline(sha) {
  let fd;
  try {
    check(arguments.length === 1 && typeof sha === "string" && /^[a-f0-9]{64}$/.test(sha));
    const before = fs.lstatSync(BASELINE, {bigint:true});
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(MAX_BYTES));
    fd = fs.openSync(BASELINE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const same = actual => {
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) check(actual[key] === before[key]);
      check(actual.isFile() && !actual.isSymbolicLink());
    };
    same(fs.fstatSync(fd, {bigint:true}));
    const read = () => {
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        check(count > 0); offset += count;
      }
      check(crypto.createHash("sha256").update(bytes).digest("hex") === sha);
      return bytes;
    };
    const bytes = read();
    same(fs.fstatSync(fd, {bigint:true}));
    check(bytes.equals(read()));
    same(fs.fstatSync(fd, {bigint:true}));
    same(fs.lstatSync(BASELINE, {bigint:true}));
    const content = bytes.toString("utf8");
    check(Buffer.from(content, "utf8").equals(bytes));
    Market.validateMarketData(Market.parsePublicJSON(content));
    return content;
  } catch { throw failure(); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { throw failure(); } } }
}
function validateRequest(request) {
  exactKeys(request, ["ranges", "existingContent", "end"]);
  check(Buffer.byteLength(JSON.stringify(request)) <= MAX_BYTES);
  Market.validateRanges(request.ranges);
  check(typeof request.existingContent === "string" && Buffer.byteLength(request.existingContent) <= MAX_BYTES);
  const end = date(request.end);
  for (const start of Object.values(request.ranges)) check(date(start) <= end);
  const existing = Market.parsePublicJSON(request.existingContent);
  Market.validateMarketData(existing);
  check(date(existing.asOf) <= end);
  return existing;
}
function validateResult(ranges, existing, result, end) {
  Market.validateMarketData(result);
  check(date(result.asOf) <= date(end) && date(end) - date(result.asOf) <= 7 * 86400000);
  const permitted = new Set([...Object.keys(ranges), ...Object.keys(existing.prices)]);
  check(Object.keys(result.prices).every(ticker => permitted.has(ticker)));
  for (const [ticker, rows] of Object.entries(existing.prices)) {
    const next = result.prices[ticker];
    check(Array.isArray(next));
    const dates = new Set(next.map(row => row.date));
    check(rows.every(row => dates.has(row.date)));
    if (!Object.hasOwn(ranges, ticker)) check(canonical(rows) === canonical(next));
  }
  for (const [ticker, start] of Object.entries(ranges)) {
    const rows = result.prices[ticker];
    check(Array.isArray(rows) && rows.length > 0 && rows[0].date === start && rows.at(-1).date === result.asOf);
  }
}
function runPython({script, configPath, outputPath, end}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", [script, "--config", configPath, "--output", outputPath, "--end", end], {
      cwd:path.dirname(outputPath), shell:false, stdio:"ignore", timeout:10 * 60 * 1000,
      env:{PATH:"/usr/bin:/bin", PYTHONDONTWRITEBYTECODE:"1", PYTHONUTF8:"1"},
    });
    child.once("error", () => reject(failure()));
    child.once("close", code => code === 0 ? resolve() : reject(failure()));
  });
}
async function prepareMarket(request, options = {}) {
  let temporary;
  try {
    exactKeys(options, Object.hasOwn(options, "runPython") ? ["directory", "runPython"] : ["directory"]);
    check(options.runPython === undefined || typeof options.runPython === "function");
    const existing = validateRequest(request);
    const directory = privateDirectory(options.directory);
    temporary = fs.mkdtempSync(path.join(directory.path, "market-"));
    fs.chmodSync(temporary, 0o700);
    const work = privateDirectory(temporary);
    const configPath = path.join(temporary, "ranges.json"), outputPath = path.join(temporary, "prices.json");
    const rangesContent = pretty(request.ranges);
    writePrivate(configPath, rangesContent);
    writePrivate(outputPath, request.existingContent);
    sameDirectory(directory);
    await (options.runPython || runPython)({script:SCRIPT, configPath, outputPath, end:request.end});
    sameDirectory(directory); sameDirectory(work);
    check(readPrivate(configPath) === rangesContent);
    const result = Market.parsePublicJSON(readPrivate(outputPath));
    validateResult(request.ranges, existing, result, request.end);
    const marketContent = canonical(result) === canonical(existing) ? request.existingContent : pretty(result);
    return {status:"validated", rangesContent, marketContent};
  } catch { throw failure(); }
  finally { if (temporary) { try { fs.rmSync(temporary, {recursive:true, force:true}); } catch {} } }
}
function readOneLine(input) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, done = false;
    const finish = (error, value) => {
      if (done) return; done = true;
      input.removeListener("data", onData); input.removeListener("end", onEnd); input.removeListener("error", onError); input.pause();
      error ? reject(failure()) : resolve(value);
    };
    const onError = () => finish(true);
    const onEnd = () => finish(true);
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES + 1) return finish(true);
      chunks.push(bytes);
      if (!bytes.includes(10)) return;
      try {
        const all = Buffer.concat(chunks), newline = all.indexOf(10);
        check(newline === all.length - 1);
        const line = all.subarray(0, newline).toString("utf8"), request = JSON.parse(line);
        check(JSON.stringify(request) === line);
        finish(false, request);
      } catch { finish(true); }
    };
    input.on("data", onData); input.once("end", onEnd); input.once("error", onError);
  });
}
async function main(args) {
  const bound = args.length === 5 && args[3] === "--baseline-sha";
  check((args.length === 3 || bound) && args[0] === "--serve" && args[1] === "--directory");
  privateDirectory(args[2]);
  const existingContent = bound ? loadBoundBaseline(args[4]) : undefined;
  process.stdout.write(JSON.stringify({status:"ready", protocol:1}) + "\n");
  let request = await readOneLine(process.stdin);
  if (bound) {
    exactKeys(request, ["ranges", "end"]);
    request = {ranges:request.ranges, existingContent, end:request.end};
  }
  const result = await prepareMarket(request, {directory:args[2]});
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stdout.write(JSON.stringify({status:"failed", code:ERROR}) + "\n");
  process.exitCode = 1;
});
module.exports = {prepareMarket, loadBoundBaseline, main};
