#!/usr/bin/env node
"use strict";

// Disposable synthetic directories and metadata only. No GitHub, financial data,
// credentials, repository writes, or production journal state are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { LOCK_KEY, JournalError, openJournal, validateRecord, createRpc } = require("./finances_journal.cjs");
const MODULE = path.join(__dirname, "finances_journal.cjs");
const id = "synthetic:journal/operation";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function record(overrides = {}) {
  return { version: 1, operationId: id, repository: "yuchen-mei/visual-card", branch: "main", path: "data.enc.json", publish: true, expectedHead: "a".repeat(40), sourceHash: "b".repeat(64), candidateHash: "c".repeat(64), baseTreeSha: "d".repeat(40), blobSha: null, treeSha: null, commitSha: null, phase: "ready", intent: null, ...overrides };
}
function releaseRecord(overrides = {}) {
  return { version: 2, kind: "release", operationId: id, repository: "yuchen-mei/visual-card", branch: "main", publish: true, expectedHead: "a".repeat(40), baseTreeSha: "b".repeat(40), manifest: [{ path: "index.html", sha256: "c".repeat(64), blobSha: null }, { path: "scripts/finances_journal.cjs", sha256: "d".repeat(64), blobSha: null }], treeSha: null, commitSha: null, phase: "blobs", intent: null, ...overrides };
}
function setup(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "visual-card-journal-test-")));
  const directory = path.join(parent, "journal");
  const journal = openJournal({ directory });
  const lock = path.join(directory, `${LOCK_KEY}.lock`);
  const filename = path.join(directory, `${hash(id)}.json`);
  t.after(() => { try { journal.close(); } catch {} fs.rmSync(parent, { recursive: true, force: true }); });
  return { parent, directory, journal, lock, filename };
}
function fails(code, callback) { assert.throws(callback, error => error instanceof JournalError && error.code === code && error.message === code); }

test("private metadata journal persists canonical whitelist records across reopen", t => {
  const f = setup(t);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  f.journal.acquire();
  assert.equal(f.journal.load(id), null);
  f.journal.save(id, record());
  assert.deepEqual(f.journal.load(id), record());
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.lock).mode & 0o777, 0o600);
  assert.match(path.basename(f.filename), /^[a-f0-9]{64}\.json$/);
  assert.doesNotMatch(path.basename(f.filename), /synthetic/);
  f.journal.release(); f.journal.close();
  const reopened = openJournal({ directory: f.directory });
  reopened.acquire(); assert.deepEqual(reopened.load(id), record()); reopened.close();
  assert.equal(fs.existsSync(f.lock), false);
});

test("read and write require ownership of the fixed lock", t => {
  const f = setup(t);
  fails("E_JOURNAL_LOCK_REQUIRED", () => f.journal.load(id));
  fails("E_JOURNAL_LOCK_REQUIRED", () => f.journal.save(id, record()));
  assert.deepEqual(f.journal.status(), { status: "unlocked", owned: false, ownerPid: null });
  f.journal.acquire(); fails("E_JOURNAL_ALREADY_OWNED", () => f.journal.acquire());
  assert.deepEqual(f.journal.status(), { status: "locked", owned: true, ownerPid: process.pid });
});

test("withLock spans awaited work and excludes another process", async t => {
  const f = setup(t);
  const value = await f.journal.withLock(LOCK_KEY, async () => {
    await Promise.resolve();
    const child = spawnSync(process.execPath, ["-e", "const j=require(process.argv[1]).openJournal({directory:process.argv[2]});try{j.acquire();console.log('unexpected')}catch(e){console.log(e.code)}finally{j.close()}", MODULE, f.directory], { encoding: "utf8" });
    assert.equal(child.status, 0); assert.equal(child.stdout.trim(), "E_JOURNAL_LOCKED");
    f.journal.save(id, record()); return "completed";
  });
  assert.equal(value, "completed"); assert.equal(f.journal.status().status, "unlocked");
  await assert.rejects(f.journal.withLock("wrong-key", () => {}), { code: "E_JOURNAL_LOCK_KEY" });
});

test("normal callback errors release only the current owner lock", async t => {
  const f = setup(t);
  await assert.rejects(f.journal.withLock(LOCK_KEY, async () => { throw new Error("synthetic callback failure"); }), /synthetic callback failure/);
  assert.equal(f.journal.status().status, "unlocked");
});

test("another journal can inspect status but cannot release or steal an existing lock", t => {
  const f = setup(t); f.journal.acquire();
  const other = openJournal({ directory: f.directory });
  assert.deepEqual(other.status(), { status: "locked", owned: false, ownerPid: process.pid });
  fails("E_JOURNAL_LOCKED", () => other.acquire());
  fails("E_JOURNAL_LOCK_REQUIRED", () => other.release());
  other.close(); assert.equal(fs.existsSync(f.lock), true);
});

test("crashed process leaves a durable lock and uncertainty record for manual recovery", t => {
  const f = setup(t);
  const child = spawnSync(process.execPath, ["-e", "const j=require(process.argv[1]).openJournal({directory:process.argv[2]});j.acquire();j.save(process.argv[3],JSON.parse(process.argv[4]));process.exit(9)", MODULE, f.directory, id, JSON.stringify(record({ intent: "blob" }))], { encoding: "utf8" });
  assert.equal(child.status, 9); assert.equal(fs.existsSync(f.lock), true);
  assert.equal(f.journal.status().status, "locked");
  fails("E_JOURNAL_LOCKED", () => f.journal.acquire());
  // Explicit test-only manual recovery of this disposable directory.
  fs.unlinkSync(f.lock);
  f.journal.acquire(); assert.equal(f.journal.load(id).intent, "blob");
});

test("record writes fsync both file and parent directory before returning", t => {
  const f = setup(t); f.journal.acquire();
  const original = fs.fsyncSync, types = [];
  fs.fsyncSync = fd => { const stat = fs.fstatSync(fd); types.push(stat.isDirectory() ? "directory" : "file"); return original(fd); };
  try { f.journal.save(id, record()); } finally { fs.fsyncSync = original; }
  assert.deepEqual(types, ["file", "directory"]);
});

test("failed atomic replacement preserves the prior record and removes temporary files", t => {
  const f = setup(t); f.journal.acquire(); f.journal.save(id, record());
  const before = fs.readFileSync(f.filename);
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error("synthetic secret-like native error must be hidden"); };
  try { fails("E_JOURNAL_IO", () => f.journal.save(id, record({ intent: "blob" }))); } finally { fs.renameSync = original; }
  assert.ok(fs.readFileSync(f.filename).equals(before));
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith(".tmp")), false);
});

test("identical retry reconfirms directory durability after post-rename fsync failure", t => {
  const f = setup(t); f.journal.acquire();
  const original = fs.fsyncSync;
  let directoryCalls = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory() && ++directoryCalls === 1) throw new Error("synthetic fsync failure");
    return original(fd);
  };
  try {
    fails("E_JOURNAL_IO", () => f.journal.save(id, record({ intent: "blob" })));
    assert.equal(fs.existsSync(f.filename), true);
    assert.deepEqual(f.journal.save(id, record({ intent: "blob" })), { status: "saved" });
    assert.equal(directoryCalls, 2);
  } finally { fs.fsyncSync = original; }
});

test("valid publication intents and receipts advance durably without regressions", t => {
  const f = setup(t); f.journal.acquire();
  let current = record({ intent: "blob" }); f.journal.save(id, current);
  current = { ...current, phase: "blob", blobSha: "e".repeat(40), intent: null }; f.journal.save(id, current);
  current = { ...current, intent: "tree" }; f.journal.save(id, current);
  current = { ...current, phase: "tree", treeSha: "f".repeat(40), intent: null }; f.journal.save(id, current);
  current = { ...current, intent: "commit" }; f.journal.save(id, current);
  current = { ...current, phase: "commit", commitSha: "1".repeat(40), intent: null }; f.journal.save(id, current);
  current = { ...current, intent: "ref" }; f.journal.save(id, current);
  current = { ...current, phase: "published", intent: null }; f.journal.save(id, current);
  assert.deepEqual(f.journal.load(id), current);
  fails("E_JOURNAL_PHASE_REGRESSION", () => f.journal.save(id, { ...current, phase: "commit" }));
});

test("same operation cannot change identity, receipts or erase uncertain outcomes", t => {
  const f = setup(t); f.journal.acquire(); f.journal.save(id, record({ intent: "blob" }));
  fails("E_JOURNAL_OPERATION_REUSED", () => f.journal.save(id, record({ intent: "blob", candidateHash: "1".repeat(64) })));
  fails("E_JOURNAL_UNCERTAINTY_REMOVED", () => f.journal.save(id, record()));
  const next = record({ phase: "blob", blobSha: "e".repeat(40) }); f.journal.save(id, next);
  fails("E_JOURNAL_RECEIPT_CHANGED", () => f.journal.save(id, { ...next, blobSha: "f".repeat(40) }));
});

test("schema rejects extra data, arrays, foreign targets and invalid stage combinations", () => {
  for (const patch of [
    { content: "synthetic secret" }, { ciphertext: "synthetic" }, { password: "synthetic" },
    { operationId: [id] }, { sourceHash: ["b".repeat(64)] }, { repository: "other/repo" },
    { path: "private.json" }, { branch: "other" }, { publish: false }, { version: 2 },
    { phase: "ready", blobSha: "e".repeat(40) }, { phase: "published" }, { intent: "ref" }
  ]) fails("E_JOURNAL_RECORD", () => validateRecord(record(patch)));
});

test("release manifest persists only metadata and advances one intended blob at a time", t => {
  const f = setup(t); f.journal.acquire();
  let current = releaseRecord(); f.journal.save(id, current);
  for (let i = 0; i < current.manifest.length; i++) {
    current = { ...current, intent: { stage: "blob", path: current.manifest[i].path } }; f.journal.save(id, current);
    current = { ...current, intent: null, manifest: current.manifest.map((file, at) => at === i ? { ...file, blobSha: String(i + 1).repeat(40) } : file) }; f.journal.save(id, current);
  }
  current = { ...current, intent: { stage: "tree" } }; f.journal.save(id, current);
  current = { ...current, phase: "tree", treeSha: "e".repeat(40), intent: null }; f.journal.save(id, current);
  current = { ...current, intent: { stage: "commit" } }; f.journal.save(id, current);
  current = { ...current, phase: "commit", commitSha: "f".repeat(40), intent: null }; f.journal.save(id, current);
  current = { ...current, intent: { stage: "ref" } }; f.journal.save(id, current);
  current = { ...current, phase: "published", intent: null }; f.journal.save(id, current);
  assert.deepEqual(f.journal.load(id), current);
  f.journal.release(); f.journal.close();
  const reopened = openJournal({ directory: f.directory });
  reopened.acquire(); assert.deepEqual(reopened.load(id), current); reopened.close();
});

test("release schema rejects raw content, invalid types, unsafe paths and published intents", () => {
  for (const patch of [
    { content: "synthetic-secret-marker" }, { kind: "other" }, { expectedHead: ["a".repeat(40)] },
    { baseTreeSha: ["b".repeat(40)] }, { manifest: [{ path: "private.json", sha256: "c".repeat(64), blobSha: null }] },
    { manifest: [{ path: "index.html", sha256: "c".repeat(64), blobSha: null, content: "synthetic" }] },
    { intent: { stage: "blob", path: "scripts/finances_journal.cjs" } }
  ]) fails("E_JOURNAL_RECORD", () => validateRecord(releaseRecord(patch)));
  const done = releaseRecord({ phase: "published", treeSha: "e".repeat(40), commitSha: "f".repeat(40), manifest: [{ path: "index.html", sha256: "c".repeat(64), blobSha: "1".repeat(40) }], intent: { stage: null } });
  fails("E_JOURNAL_RECORD", () => validateRecord(done));
});

test("release receipts, manifest identity and uncertain blob intent cannot be replaced", t => {
  const f = setup(t); f.journal.acquire();
  let current = releaseRecord({ intent: { stage: "blob", path: "index.html" } }); f.journal.save(id, current);
  fails("E_JOURNAL_UNCERTAINTY_REMOVED", () => f.journal.save(id, releaseRecord()));
  fails("E_JOURNAL_OPERATION_REUSED", () => f.journal.save(id, releaseRecord({ intent: current.intent, manifest: current.manifest.map(file => ({ ...file, sha256: "9".repeat(64) })) })));
  fails("E_JOURNAL_INTENT_REQUIRED", () => f.journal.save(id, releaseRecord({ manifest: current.manifest.map(file => ({ ...file, blobSha: "e".repeat(40) })) })));
  fails("E_JOURNAL_INTENT_REQUIRED", () => f.journal.save(id, releaseRecord({ manifest: current.manifest.map((file, i) => i === 1 ? { ...file, blobSha: "e".repeat(40) } : file) })));
  current = releaseRecord({ manifest: current.manifest.map((file, i) => i === 0 ? { ...file, blobSha: "e".repeat(40) } : file) }); f.journal.save(id, current);
  fails("E_JOURNAL_RECEIPT_CHANGED", () => f.journal.save(id, { ...current, manifest: current.manifest.map((file, i) => i === 0 ? { ...file, blobSha: "f".repeat(40) } : file) }));
  fails("E_JOURNAL_OPERATION_REUSED", () => f.journal.save(id, record()));
});

test("release initial manifest can retain verified unchanged blobs and uses the same RPC lock", t => {
  const f = setup(t), rpc = createRpc(f.journal);
  const current = releaseRecord({ manifest: [{ path: "index.html", sha256: "c".repeat(64), blobSha: "e".repeat(40) }] });
  assert.deepEqual(rpc({ id: 1, action: "acquire" }), { id: 1, status: "acquired" });
  assert.deepEqual(rpc({ id: 2, action: "save", operationId: id, record: current }), { id: 2, status: "saved" });
  assert.deepEqual(rpc({ id: 3, action: "load", operationId: id }), { id: 3, status: "loaded", record: current });
  const second = record({ operationId: "synthetic:daily/operation" });
  assert.deepEqual(rpc({ id: 4, action: "save", operationId: second.operationId, record: second }), { id: 4, status: "saved" });
  assert.deepEqual(rpc({ id: 5, action: "release" }), { id: 5, status: "released" });
});

test("journal directory must be private, outside repository and not a symlink", t => {
  const f = setup(t);
  fails("E_JOURNAL_OUTSIDE_REPOSITORY_REQUIRED", () => openJournal({ directory: path.resolve(__dirname, "..") }));
  const unsafe = path.join(f.parent, "unsafe"); fs.mkdirSync(unsafe, { mode: 0o755 });
  fails("E_JOURNAL_DIRECTORY_PERMISSIONS", () => openJournal({ directory: unsafe }));
  const link = path.join(f.parent, "link"); fs.symlinkSync(f.directory, link);
  fails("E_JOURNAL_DIRECTORY_PERMISSIONS", () => openJournal({ directory: link }));
});

test("journal files reject symlinks, hardlinks and broad permissions", t => {
  const f = setup(t); f.journal.acquire();
  const target = path.join(f.parent, "target"); fs.writeFileSync(target, "{}", { mode: 0o600 });
  fs.symlinkSync(target, f.filename);
  fails("E_JOURNAL_FILE_OPEN", () => f.journal.load(id));
  fails("E_JOURNAL_FILE_OPEN", () => f.journal.save(id, record()));
  fs.unlinkSync(f.filename); fs.linkSync(target, f.filename);
  fails("E_JOURNAL_FILE_PERMISSIONS", () => f.journal.load(id));
  fs.unlinkSync(f.filename); f.journal.save(id, record()); fs.chmodSync(f.filename, 0o644);
  fails("E_JOURNAL_FILE_PERMISSIONS", () => f.journal.load(id));
});

test("malformed or duplicate-key metadata is rejected instead of normalized silently", t => {
  const f = setup(t); f.journal.acquire(); f.journal.save(id, record());
  fs.writeFileSync(f.filename, fs.readFileSync(f.filename, "utf8").replace('"version": 1,', '"version": 1, "version": 1,'));
  fails("E_JOURNAL_FILE_FORMAT", () => f.journal.load(id));
});

test("RPC enforces sequence ids and replays the same request without repeat mutation", t => {
  const f = setup(t), rpc = createRpc(f.journal);
  const acquire = { id: 1, action: "acquire" };
  assert.deepEqual(rpc(acquire), { id: 1, status: "acquired" });
  assert.deepEqual(rpc(acquire), { id: 1, status: "acquired" });
  assert.equal(rpc({ id: 1, action: "release" }).code, "E_RPC_ID_REUSED");
  assert.equal(rpc({ id: 3, action: "status" }).code, "E_RPC_SEQUENCE");
  assert.deepEqual(rpc({ id: 2, action: "save", operationId: id, record: record() }), { id: 2, status: "saved" });
  assert.deepEqual(rpc({ id: 3, action: "load", operationId: id }), { id: 3, status: "loaded", record: record() });
  assert.deepEqual(rpc({ id: 4, action: "release" }), { id: 4, status: "released" });
  assert.equal(rpc({ id: 5, action: "load", operationId: id }).code, "E_JOURNAL_LOCK_REQUIRED");
  assert.equal(rpc({ id: "sensitive", action: "status" }).id, null);
});

test("RPC rejects extra fields and never echoes invalid input or native errors", t => {
  const f = setup(t), rpc = createRpc(f.journal);
  const response = rpc({ id: 1, action: "save", operationId: id, record: record(), password: "synthetic-secret-marker" });
  assert.equal(response.code, "E_RPC_REQUEST");
  assert.doesNotMatch(JSON.stringify(response), /synthetic-secret-marker/);
});

test("persistent JSONL server reports ready, holds locks across requests and keeps crash locks", async t => {
  const f = setup(t);
  const child = spawn(process.execPath, [MODULE, "--serve", "--directory", f.directory], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let buffer = "", stderr = "";
  const queue = [], waiting = [];
  child.stderr.on("data", text => { stderr += text; });
  child.stdout.on("data", text => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const answer = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (waiting.length) waiting.shift()(answer); else queue.push(answer);
    }
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve));
  const ready = await next(); assert.equal(ready.status, "ready"); assert.equal(ready.protocol, 1);
  child.stdin.write(`${JSON.stringify({ id: 1, action: "acquire" })}\n`);
  assert.deepEqual(await next(), { id: 1, status: "acquired" });
  assert.equal(f.journal.status().ownerPid, ready.pid);
  child.stdin.write(`${JSON.stringify({ id: 2, action: "save", operationId: id, record: record({ intent: "blob" }) })}\n`);
  assert.equal((await next()).status, "saved");
  child.stdin.write('{"malformed":"synthetic-secret-marker"\n');
  const malformed = await next(); assert.equal(malformed.code, "E_RPC_JSON");
  assert.doesNotMatch(JSON.stringify(malformed), /synthetic-secret-marker/);
  child.stdin.write("x".repeat(66000));
  assert.deepEqual(await next(), { id: null, status: "error", code: "E_RPC_SIZE" });
  child.stdin.write(`\n${JSON.stringify({ id: 3, action: "status" })}\n`);
  assert.deepEqual(await next(), { id: 3, status: "locked", owned: true, ownerPid: ready.pid });
  child.stdin.end(); await once(child, "exit");
  assert.equal(stderr, ""); assert.equal(fs.existsSync(f.lock), true);
  fails("E_JOURNAL_LOCKED", () => f.journal.acquire());
});
