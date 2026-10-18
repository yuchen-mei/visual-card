"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto"), vm = require("node:vm"), {PassThrough} = require("node:stream"), {EventEmitter} = require("node:events");
const {spawnSync} = require("node:child_process");
const {prepareMarket,loadBoundBaseline} = require("./finances_market_io.cjs");
const helper = path.join(__dirname, "finances_market_io.cjs");
const baselinePath = path.join(__dirname,"..","market.prices.json");
const ERROR = {message:"E_MARKET_PREPARATION"};

function fixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vc-market-io-"));
  fs.chmodSync(directory, 0o700);
  const existing = {
    asOf:"2026-10-16", source:"yahoo-chart", generatedAt:"2026-10-17T01:00:00Z",
    prices:{AAA:[{date:"2026-10-15",close:10},{date:"2026-10-16",close:11}], OLD:[{date:"2026-10-01",close:20}]},
  };
  const existingContent = JSON.stringify(existing);
  return {directory, existing, request:{ranges:{AAA:"2026-10-15"},existingContent,end:"2026-10-16"}, cleanup:() => fs.rmSync(directory,{recursive:true,force:true})};
}
function writer(value, mutate) {
  return async ({configPath,outputPath,script,end}) => {
    assert(path.isAbsolute(script)); assert.equal(path.basename(script), "fetch_market_prices.py");
    assert.equal(end, "2026-10-16");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    fs.writeFileSync(outputPath, JSON.stringify(value));
    if (mutate) mutate({configPath,outputPath});
  };
}

test("validated unchanged public data keeps exact original bytes and removes temporary files", async () => {
  const f = fixture();
  try {
    const result = await prepareMarket(f.request, {directory:f.directory,runPython:async () => {}});
    assert.deepEqual(result, {status:"validated",rangesContent:'{\n  "AAA": "2026-10-15"\n}\n',marketContent:f.request.existingContent});
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("new ticker with one real closing price preserves the archived series", async () => {
  const f = fixture();
  try {
    f.request.ranges.NEW = "2026-10-16";
    const next = structuredClone(f.existing); next.prices.NEW = [{date:"2026-10-16",close:30}];
    const result = await prepareMarket(f.request, {directory:f.directory,runPython:writer(next)});
    assert.deepEqual(JSON.parse(result.marketContent).prices.OLD, f.existing.prices.OLD);
    assert.deepEqual(JSON.parse(result.marketContent).prices.NEW, next.prices.NEW);
    assert(result.marketContent.endsWith("\n"));
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("refresh may correct active public closes while retaining every historic date", async () => {
  const f = fixture();
  try {
    const next = structuredClone(f.existing); next.prices.AAA[0].close = 10.25;
    const result = await prepareMarket(f.request, {directory:f.directory,runPython:writer(next)});
    assert.equal(JSON.parse(result.marketContent).prices.AAA[0].close, 10.25);
  } finally { f.cleanup(); }
});
test("fetch failure leaves all original bytes untouched and emits no exception content", async () => {
  const f = fixture();
  try {
    const oldPath = path.join(f.directory,"original.json");
    fs.writeFileSync(oldPath, f.request.existingContent, {mode:0o600});
    await assert.rejects(() => prepareMarket(f.request, {directory:f.directory,runPython:async ({outputPath}) => {
      fs.writeFileSync(outputPath, "partial output"); throw Error("untrusted subprocess error");
    }}), ERROR);
    assert.equal(fs.readFileSync(oldPath,"utf8"), f.request.existingContent);
    assert.deepEqual(fs.readdirSync(f.directory), ["original.json"]);
  } finally { f.cleanup(); }
});
for (const [name, mutate] of [
  ["removed archive", next => delete next.prices.OLD],
  ["changed archive", next => next.prices.OLD[0].close = 19],
  ["dropped active historic date", next => next.prices.AAA.shift()],
  ["unexpected public ticker", next => next.prices.OTHER = [{date:"2026-10-16",close:4}]],
  ["unknown top level field", next => next.accountId = "synthetic"],
  ["unknown price field", next => next.prices.AAA[0].shares = 1],
  ["invalid date", next => next.prices.AAA[0].date = "2026-02-30"],
  ["zero close", next => next.prices.AAA[0].close = 0],
]) test(`rejects ${name} without keeping temporary output`, async () => {
  const f = fixture();
  try {
    const next = structuredClone(f.existing); mutate(next);
    await assert.rejects(() => prepareMarket(f.request, {directory:f.directory,runPython:writer(next)}), ERROR);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("unchanged runner cannot satisfy a newly configured ticker", async () => {
  const f = fixture();
  try {
    f.request.ranges.NEW = "2026-10-16";
    await assert.rejects(() => prepareMarket(f.request, {directory:f.directory,runPython:async () => {}}), ERROR);
  } finally { f.cleanup(); }
});
test("rejects duplicate output keys instead of returning hidden raw text", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => prepareMarket(f.request, {directory:f.directory,runPython:async ({outputPath}) => {
      fs.writeFileSync(outputPath, f.request.existingContent.replace('"source":"yahoo-chart"', '"source":"do-not-echo","source":"yahoo-chart"'));
    }}), ERROR);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("rejects stale, future and mismatched active prices", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => prepareMarket({...f.request,end:"2026-10-24"}, {directory:f.directory,runPython:async () => {}}), ERROR);
    await assert.rejects(() => prepareMarket({...f.request,end:"2026-10-15"}, {directory:f.directory,runPython:async () => {}}), ERROR);
    const next = structuredClone(f.existing); next.asOf = "2026-10-17";
    await assert.rejects(() => prepareMarket({...f.request,end:"2026-10-17"}, {directory:f.directory,runPython:async ({outputPath}) => fs.writeFileSync(outputPath,JSON.stringify(next))}), ERROR);
  } finally { f.cleanup(); }
});
for (const [name, mutate] of [
  ["unknown input key", request => request.accountId = "synthetic"],
  ["invalid range values", request => request.ranges.AAA = {date:"2026-10-15",shares:1}],
  ["noncanonical date", request => request.end = "2026-1-1"],
  ["invalid existing JSON", request => request.existingContent = "{"],
  ["sensitive existing data", request => request.existingContent = '{"accountId":"synthetic"}'],
  ["hidden duplicate existing field", request => request.existingContent = request.existingContent.replace('"source":"yahoo-chart"', '"source":"do-not-echo","source":"yahoo-chart"')],
  ["oversized input", request => request.existingContent = " ".repeat(1024*1024)],
]) test(`rejects ${name} before child launch`, async () => {
  const f = fixture(); let called = false;
  try {
    mutate(f.request);
    await assert.rejects(() => prepareMarket(f.request, {directory:f.directory,runPython:async () => {called=true;}}), ERROR);
    assert.equal(called,false); assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("private directory must be owner-only, outside the repository and not a symlink", async () => {
  const f = fixture();
  const repoTemp = fs.mkdtempSync(path.join(__dirname,".market-test-"));
  try {
    fs.chmodSync(f.directory,0o755);
    await assert.rejects(() => prepareMarket(f.request,{directory:f.directory,runPython:async () => {}}),ERROR);
    fs.chmodSync(f.directory,0o700);
    const link = path.join(f.directory,"link"); fs.symlinkSync(f.directory,link);
    await assert.rejects(() => prepareMarket(f.request,{directory:link,runPython:async () => {}}),ERROR);
    await assert.rejects(() => prepareMarket(f.request,{directory:repoTemp,runPython:async () => {}}),ERROR);
  } finally { f.cleanup(); fs.rmSync(repoTemp,{recursive:true,force:true}); }
});
for (const [name, mutate] of [
  ["symlink output", ({outputPath}) => {const target=outputPath+".real";fs.renameSync(outputPath,target);fs.symlinkSync(target,outputPath);}],
  ["hardlinked output", ({outputPath}) => fs.linkSync(outputPath,outputPath+".link")],
  ["world-readable output", ({outputPath}) => fs.chmodSync(outputPath,0o644)],
  ["changed config", ({configPath}) => fs.writeFileSync(configPath,'{"OTHER":"2026-10-16"}')],
]) test(`rejects ${name}`, async () => {
  const f = fixture();
  try {
    await assert.rejects(() => prepareMarket(f.request,{directory:f.directory,runPython:writer(f.existing,mutate)}),ERROR);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});
test("CLI import is silent and malformed input returns only fixed public protocol", () => {
  const f = fixture();
  try {
    const imported = spawnSync(process.execPath,["-e",`require(${JSON.stringify(helper)})`],{encoding:"utf8"});
    assert.equal(imported.status,0); assert.equal(imported.stdout,""); assert.equal(imported.stderr,"");
    for (const input of ["{broken}\n",'{"private":"do-not-echo"}\n',"{}\n{}\n"," {}\n","x".repeat(1024*1024+2)]) {
      const result = spawnSync(process.execPath,[helper,"--serve","--directory",f.directory],{input,encoding:"utf8",timeout:5000});
      assert.equal(result.status,1);
      assert.equal(result.stderr,"");
      assert.equal(result.stdout,'{"status":"ready","protocol":1}\n{"status":"failed","code":"E_MARKET_PREPARATION"}\n');
    }
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

function boundFixture() {
  const content = fs.readFileSync(baselinePath,"utf8");
  return {content,sha:crypto.createHash("sha256").update(content).digest("hex")};
}
function loadIsolated({filesystem=fs,processObject=process,childProcess=require("node:child_process")}={}) {
  const module = {exports:{}};
  const isolatedRequire = name => name === "node:fs" ? filesystem : name === "node:child_process" ? childProcess : require(name);
  vm.runInNewContext(fs.readFileSync(helper,"utf8"), {module,require:isolatedRequire,__dirname,process:processObject,Buffer});
  return module.exports;
}
test("fixed repository baseline loads only by its exact SHA256 without changing original bytes", () => {
  const f = boundFixture();
  assert.equal(loadBoundBaseline(f.sha), f.content);
  assert.equal(fs.readFileSync(baselinePath,"utf8"),f.content);
  for (const value of ["0".repeat(64),baselinePath,{path:baselinePath},f.sha.toUpperCase(),null]) assert.throws(() => loadBoundBaseline(value),ERROR);
  assert.throws(() => loadBoundBaseline(f.sha,baselinePath),ERROR);
});
for (const [name, modify] of [
  ["symbolic baseline", (st,call) => call === 1 ? {isSymbolicLink:() => true} : {}],
  ["hardlinked baseline", (st,call) => call === 1 ? {nlink:2n} : {}],
  ["replaced baseline path", (st,call) => call === 2 ? {ino:st.ino+1n} : {}],
]) test(`bound baseline rejects ${name} without modifying production data`, () => {
  const f = boundFixture(); let count = 0;
  const filesystem = {...fs,lstatSync:(...args) => {
    const stat = fs.lstatSync(...args), changes = modify(stat,++count);
    return new Proxy(stat,{get:(target,key) => Object.hasOwn(changes,key) ? changes[key] : target[key]});
  }};
  assert.throws(() => loadIsolated({filesystem}).loadBoundBaseline(f.sha),ERROR);
  assert.equal(fs.readFileSync(baselinePath,"utf8"),f.content);
});
test("bound baseline detects descriptor metadata changes during its reads", () => {
  const f = boundFixture(); let count = 0;
  const filesystem = {...fs,fstatSync:(...args) => {
    const stat = fs.fstatSync(...args); count++;
    return new Proxy(stat,{get:(target,key) => count > 1 && key === "mtimeNs" ? target[key]+1n : target[key]});
  }};
  assert.throws(() => loadIsolated({filesystem}).loadBoundBaseline(f.sha),ERROR);
});
test("small-input CLI uses the fixed hash-bound baseline and leaves repository bytes unchanged", async () => {
  const f = fixture(), baseline = boundFixture(), parsed = JSON.parse(baseline.content);
  const stdin = new PassThrough(); let output = "", launches = 0;
  const processObject = Object.create(process);
  Object.defineProperties(processObject,{stdin:{value:stdin},stdout:{value:{write:text => {output += text;}}}});
  const childProcess = {spawn:() => {launches++;const child=new EventEmitter();queueMicrotask(() => child.emit("close",0));return child;}};
  try {
    const api = loadIsolated({processObject,childProcess});
    const pending = api.main(["--serve","--directory",f.directory,"--baseline-sha",baseline.sha]);
    const ranges = Object.fromEntries(Object.entries(parsed.prices).map(([ticker,rows]) => [ticker,rows[0].date]));
    stdin.write(JSON.stringify({ranges,end:parsed.asOf})+"\n");
    await pending;
    const lines = output.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines[0],{status:"ready",protocol:1}); assert.equal(lines[1].status,"validated");
    assert.equal(crypto.createHash("sha256").update(lines[1].marketContent).digest("hex"),baseline.sha);
    assert.equal(launches,1); assert.deepEqual(fs.readdirSync(f.directory),[]);
    assert.equal(fs.readFileSync(baselinePath,"utf8"),baseline.content);
  } finally { f.cleanup(); }
});
test("small-input CLI rejects injected baseline data, arbitrary paths and wrong hashes before fetch", () => {
  const f = fixture(), baseline = boundFixture();
  try {
    const args = [helper,"--serve","--directory",f.directory,"--baseline-sha",baseline.sha];
    for (const input of [JSON.stringify(f.request)+"\n",'{"ranges":{"AAA":"2026-10-15"},"end":"invalid"}\n','{"ranges":{},"end":"2026-10-16","path":"/arbitrary"}\n']) {
      const result = spawnSync(process.execPath,args,{input,encoding:"utf8",timeout:5000});
      assert.equal(result.status,1); assert.equal(result.stderr,"");
      assert.equal(result.stdout,'{"status":"ready","protocol":1}\n{"status":"failed","code":"E_MARKET_PREPARATION"}\n');
    }
    for (const invalidArgs of [[...args.slice(0,-1),"0".repeat(64)],[...args,"--baseline","/arbitrary"]]) {
      const result = spawnSync(process.execPath,invalidArgs,{input:"{}\n",encoding:"utf8",timeout:5000});
      assert.equal(result.status,1); assert.equal(result.stderr,"");
      assert.equal(result.stdout,'{"status":"failed","code":"E_MARKET_PREPARATION"}\n');
    }
    assert.deepEqual(fs.readdirSync(f.directory),[]);
    assert.equal(fs.readFileSync(baselinePath,"utf8"),baseline.content);
  } finally { f.cleanup(); }
});
