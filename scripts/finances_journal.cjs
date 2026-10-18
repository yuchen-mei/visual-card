#!/usr/bin/env node
"use strict";

// Durable metadata only. No financial data, encrypted payload, password, or
// credential is accepted. A process crash deliberately leaves its lock behind.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const LOCK_KEY = "visual-card-github-main";
const ROOT = fs.realpathSync(path.join(__dirname, ".."));
const MAX_BYTES = 65536;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,159}$/;
const RECORD_KEYS = ["version", "operationId", "repository", "branch", "path", "publish", "expectedHead", "sourceHash", "candidateHash", "baseTreeSha", "blobSha", "treeSha", "commitSha", "phase", "intent"];
const RELEASE_KEYS = ["version", "kind", "operationId", "repository", "branch", "publish", "expectedHead", "baseTreeSha", "manifest", "treeSha", "commitSha", "phase", "intent"];
const PHASES = ["ready", "blob", "tree", "commit", "published"];
class JournalError extends Error { constructor(code) { super(code); this.code = code; } }
function need(ok, code) { if (!ok) throw new JournalError(code); }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(","); }
function operation(value) { need(typeof value === "string" && OPERATION.test(value), "E_JOURNAL_OPERATION_ID"); return value; }
function validateRecord(record) {
  if (record?.version === 2) {
    // The release adapter owns the fixed path/stage schema. This dependency has
    // no IO and does not import the journal. Never accept caller validators.
    try { require("./finances_release.cjs").validateRecord(record); }
    catch { throw new JournalError("E_JOURNAL_RECORD"); }
    need(exact(record, RELEASE_KEYS), "E_JOURNAL_RECORD");
    for (const key of ["operationId", "expectedHead", "baseTreeSha", "phase"]) need(typeof record[key] === "string", "E_JOURNAL_RECORD");
    need(record.phase !== "published" || record.intent === null, "E_JOURNAL_RECORD");
    const canonical = Object.fromEntries(RELEASE_KEYS.map(key => [key, record[key]]));
    canonical.manifest = record.manifest.map(file => ({ path: file.path, sha256: file.sha256, blobSha: file.blobSha }));
    canonical.intent = record.intent === null ? null : record.intent.stage === "blob" ? { stage: "blob", path: record.intent.path } : { stage: record.intent.stage };
    return canonical;
  }
  need(exact(record, RECORD_KEYS) && record.version === 1 && record.repository === "yuchen-mei/visual-card" && record.branch === "main" && record.path === "data.enc.json" && record.publish === true && OPERATION.test(record.operationId || "") && SHA.test(record.expectedHead || "") && HASH.test(record.sourceHash || "") && HASH.test(record.candidateHash || "") && SHA.test(record.baseTreeSha || ""), "E_JOURNAL_RECORD");
  for (const key of ["operationId", "expectedHead", "sourceHash", "candidateHash", "baseTreeSha", "phase"]) need(typeof record[key] === "string", "E_JOURNAL_RECORD");
  for (const key of ["blobSha", "treeSha", "commitSha", "intent"]) need(record[key] === null || typeof record[key] === "string", "E_JOURNAL_RECORD");
  const position = PHASES.indexOf(record.phase);
  need(position >= 0, "E_JOURNAL_RECORD");
  for (const [index, key] of ["blobSha", "treeSha", "commitSha"].entries()) need(position > index ? SHA.test(record[key] || "") : record[key] === null, "E_JOURNAL_RECORD");
  const next = { ready: "blob", blob: "tree", tree: "commit", commit: "ref", published: null }[record.phase];
  need(record.intent === null || (next !== null && record.intent === next), "E_JOURNAL_RECORD");
  return Object.fromEntries(RECORD_KEYS.map(key => [key, record[key]]));
}
function metadataBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function safeCall(fn) { try { return fn(); } catch (error) { throw error instanceof JournalError ? error : new JournalError("E_JOURNAL_IO"); } }
function secureFile(stat) { need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size <= MAX_BYTES, "E_JOURNAL_FILE_PERMISSIONS"); }
function readPrivate(filename) {
  let fd;
  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return null; throw new JournalError("E_JOURNAL_FILE_OPEN"); }
  try { secureFile(fs.fstatSync(fd)); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function parsePrivate(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new JournalError("E_JOURNAL_FILE_FORMAT"); }
}
function transition(before, after) {
  need(before.version === after.version, "E_JOURNAL_OPERATION_REUSED");
  if (before.version === 2) return releaseTransition(before, after);
  for (const key of RECORD_KEYS.filter(key => !["blobSha", "treeSha", "commitSha", "phase", "intent"].includes(key))) need(before[key] === after[key], "E_JOURNAL_OPERATION_REUSED");
  for (const key of ["blobSha", "treeSha", "commitSha"]) if (before[key] !== null) need(before[key] === after[key], "E_JOURNAL_RECEIPT_CHANGED");
  const oldPhase = PHASES.indexOf(before.phase), newPhase = PHASES.indexOf(after.phase);
  need(newPhase >= oldPhase && newPhase <= oldPhase + 1, "E_JOURNAL_PHASE_REGRESSION");
  if (newPhase === oldPhase) need(before.intent === null || before.intent === after.intent, "E_JOURNAL_UNCERTAINTY_REMOVED");
  else need(before.intent !== null && after.intent === null, "E_JOURNAL_INTENT_REQUIRED");
}
function releaseTransition(before, after) {
  for (const key of RELEASE_KEYS.filter(key => !["manifest", "treeSha", "commitSha", "phase", "intent"].includes(key))) need(before[key] === after[key], "E_JOURNAL_OPERATION_REUSED");
  need(before.manifest.length === after.manifest.length, "E_JOURNAL_OPERATION_REUSED");
  const changed = [];
  for (let i = 0; i < before.manifest.length; i++) {
    const oldFile = before.manifest[i], newFile = after.manifest[i];
    need(oldFile.path === newFile.path && oldFile.sha256 === newFile.sha256, "E_JOURNAL_OPERATION_REUSED");
    if (oldFile.blobSha !== null) need(oldFile.blobSha === newFile.blobSha, "E_JOURNAL_RECEIPT_CHANGED");
    else if (newFile.blobSha !== null) changed.push(oldFile.path);
  }
  for (const key of ["treeSha", "commitSha"]) if (before[key] !== null) need(before[key] === after[key], "E_JOURNAL_RECEIPT_CHANGED");
  const phases = ["blobs", "tree", "commit", "published"];
  const oldPhase = phases.indexOf(before.phase), newPhase = phases.indexOf(after.phase);
  need(newPhase >= oldPhase && newPhase <= oldPhase + 1, "E_JOURNAL_PHASE_REGRESSION");
  if (changed.length) {
    need(changed.length === 1 && before.phase === "blobs" && after.phase === "blobs" && before.intent?.stage === "blob" && before.intent.path === changed[0] && after.intent === null, "E_JOURNAL_INTENT_REQUIRED");
  } else if (newPhase === oldPhase) {
    need(before.intent === null || JSON.stringify(before.intent) === JSON.stringify(after.intent), "E_JOURNAL_UNCERTAINTY_REMOVED");
  } else {
    const stage = { blobs: "tree", tree: "commit", commit: "ref" }[before.phase];
    need(before.intent?.stage === stage && after.intent === null, "E_JOURNAL_INTENT_REQUIRED");
  }
}

function openJournal({ directory } = {}) {
  return safeCall(() => {
    need(typeof directory === "string" && path.isAbsolute(directory), "E_JOURNAL_DIRECTORY");
    const requested = path.resolve(directory);
    const parent = fs.realpathSync(path.dirname(requested));
    const candidate = path.join(parent, path.basename(requested));
    need(candidate !== ROOT && !candidate.startsWith(ROOT + path.sep), "E_JOURNAL_OUTSIDE_REPOSITORY_REQUIRED");
    let created = false;
    try { fs.mkdirSync(candidate, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (created) { const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); } }
    const initial = fs.lstatSync(candidate);
    need(initial.isDirectory() && !initial.isSymbolicLink() && initial.uid === process.getuid() && (initial.mode & 0o777) === 0o700, "E_JOURNAL_DIRECTORY_PERMISSIONS");
    const dir = fs.realpathSync(candidate);
    need(dir !== ROOT && !dir.startsWith(ROOT + path.sep), "E_JOURNAL_OUTSIDE_REPOSITORY_REQUIRED");
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const directoryStat = fs.fstatSync(dirFd);
    const lockFile = path.join(dir, `${LOCK_KEY}.lock`);
    let owned = null, closed = false;
    function checkDirectory() {
      need(!closed, "E_JOURNAL_CLOSED");
      const now = fs.lstatSync(dir);
      need(now.isDirectory() && now.dev === directoryStat.dev && now.ino === directoryStat.ino && now.uid === process.getuid() && (now.mode & 0o777) === 0o700, "E_JOURNAL_DIRECTORY_CHANGED");
    }
    function syncDirectory() { fs.fsyncSync(dirFd); }
    function readOwner() {
      const bytes = readPrivate(lockFile);
      if (bytes === null) return null;
      const owner = parsePrivate(bytes);
      need(exact(owner, ["version", "key", "pid", "token"]) && owner.version === 1 && owner.key === LOCK_KEY && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && /^[a-f0-9]{64}$/.test(owner.token), "E_JOURNAL_LOCK_FORMAT");
      need(bytes.equals(metadataBytes(owner)), "E_JOURNAL_LOCK_FORMAT");
      return owner;
    }
    function assertOwned() {
      checkDirectory(); need(owned !== null, "E_JOURNAL_LOCK_REQUIRED");
      const owner = readOwner();
      need(owner?.pid === process.pid && owner.token === owned.token, "E_JOURNAL_LOCK_LOST");
      const stat = fs.lstatSync(lockFile);
      need(stat.dev === owned.dev && stat.ino === owned.ino, "E_JOURNAL_LOCK_LOST");
    }
    function filename(id) { return path.join(dir, `${crypto.createHash("sha256").update(operation(id)).digest("hex")}.json`); }
    function loadUnlocked(id) {
      const bytes = readPrivate(filename(id));
      if (bytes === null) return null;
      const record = validateRecord(parsePrivate(bytes));
      need(record.operationId === id && bytes.equals(metadataBytes(record)), "E_JOURNAL_FILE_FORMAT");
      return record;
    }
    const api = {
      acquire() { return safeCall(() => {
        checkDirectory(); need(owned === null, "E_JOURNAL_ALREADY_OWNED");
        const owner = { version: 1, key: LOCK_KEY, pid: process.pid, token: crypto.randomBytes(32).toString("hex") };
        let fd;
        try { fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
        catch (error) { if (error.code === "EEXIST") throw new JournalError("E_JOURNAL_LOCKED"); throw error; }
        try {
          fs.writeFileSync(fd, metadataBytes(owner)); fs.fsyncSync(fd);
          const stat = fs.fstatSync(fd); secureFile(stat);
          syncDirectory(); owned = { token: owner.token, dev: stat.dev, ino: stat.ino };
        } finally { fs.closeSync(fd); }
        return { status: "acquired" };
      }); },
      status() { return safeCall(() => {
        checkDirectory(); const owner = readOwner();
        return { status: owner ? "locked" : "unlocked", owned: !!owner && !!owned && owner.pid === process.pid && owner.token === owned.token, ownerPid: owner?.pid || null };
      }); },
      load(id) { return safeCall(() => { assertOwned(); return loadUnlocked(operation(id)); }); },
      save(id, input) { return safeCall(() => {
        assertOwned(); operation(id);
        const record = validateRecord(input); need(record.operationId === id, "E_JOURNAL_OPERATION_MISMATCH");
        need(metadataBytes(record).length <= MAX_BYTES, "E_JOURNAL_RECORD_SIZE");
        const prior = loadUnlocked(id);
        if (prior) {
          transition(prior, record);
          if (metadataBytes(prior).equals(metadataBytes(record))) {
            // A previous rename may have succeeded before directory fsync
            // failed. Reconfirm durability even for an identical retry.
            syncDirectory();
            return { status: "saved" };
          }
        }
        const temporary = path.join(dir, `.journal-${crypto.randomBytes(16).toString("hex")}.tmp`);
        let fd;
        try {
          fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          fs.writeFileSync(fd, metadataBytes(record)); fs.fsyncSync(fd); secureFile(fs.fstatSync(fd));
          fs.closeSync(fd); fd = undefined;
          assertOwned();
          // Recheck an existing target immediately before replacement; never
          // replace a symlink, hardlink, unsafe file, or unexplained record.
          const current = loadUnlocked(id);
          need(JSON.stringify(current) === JSON.stringify(prior), "E_JOURNAL_RECORD_CHANGED");
          fs.renameSync(temporary, filename(id)); syncDirectory();
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return { status: "saved" };
      }); },
      release() { return safeCall(() => {
        assertOwned(); fs.unlinkSync(lockFile); syncDirectory(); owned = null;
        return { status: "released" };
      }); },
      async withLock(key, callback) {
        need(key === LOCK_KEY && typeof callback === "function", "E_JOURNAL_LOCK_KEY");
        api.acquire(); try { return await callback(); } finally { api.release(); }
      },
      close() { return safeCall(() => {
        if (closed) return;
        if (owned) api.release();
        fs.closeSync(dirFd); closed = true;
      }); }
    };
    return api;
  });
}

function createRpc(journal) {
  let lastId = 0;
  const cache = new Map();
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  return request => {
    const id = Number.isSafeInteger(request?.id) && request.id > 0 ? request.id : null;
    if (id === null) return { id: null, status: "error", code: "E_RPC_ID" };
    const signature = crypto.createHash("sha256").update(canonical(request)).digest("hex");
    if (cache.has(id)) return cache.get(id).signature === signature ? cache.get(id).response : { id, status: "error", code: "E_RPC_ID_REUSED" };
    if (id !== lastId + 1) return { id, status: "error", code: "E_RPC_SEQUENCE" };
    if (lastId >= 10000) return { id, status: "error", code: "E_RPC_SESSION_LIMIT" };
    lastId = id;
    let response;
    try {
      const expected = { acquire: ["id", "action"], release: ["id", "action"], status: ["id", "action"], load: ["id", "action", "operationId"], save: ["id", "action", "operationId", "record"] }[request.action];
      need(expected && exact(request, expected), "E_RPC_REQUEST");
      if (request.action === "load") response = { id, status: "loaded", record: journal.load(request.operationId) };
      else if (request.action === "save") response = { id, ...journal.save(request.operationId, request.record) };
      else response = { id, ...journal[request.action]() };
    } catch (error) { response = { id, status: "error", code: error instanceof JournalError ? error.code : "E_JOURNAL_IO" }; }
    cache.set(id, { signature, response });
    return response;
  };
}
function serve(args = process.argv.slice(2)) {
  need(args.length === 3 && args[0] === "--serve" && args[1] === "--directory", "E_JOURNAL_ARGUMENTS");
  const journal = openJournal({ directory: args[2] });
  const handle = createRpc(journal);
  process.stdout.write(`${JSON.stringify({ status: "ready", protocol: 1, pid: process.pid })}\n`);
  function receiveLine(bytes) {
    let answer;
    try {
      let request; try { request = JSON.parse(bytes.toString("utf8")); } catch { throw new JournalError("E_RPC_JSON"); }
      answer = handle(request);
    } catch (error) { answer = { id: null, status: "error", code: error instanceof JournalError ? error.code : "E_JOURNAL_IO" }; }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
  let pending = Buffer.alloc(0), discarding = false;
  process.stdin.on("data", chunk => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!discarding) {
        if (pending.length + end - start > MAX_BYTES) {
          pending = Buffer.alloc(0); discarding = true;
          process.stdout.write(`${JSON.stringify({ id: null, status: "error", code: "E_RPC_SIZE" })}\n`);
        } else pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      }
      if (newline < 0) break;
      if (!discarding) receiveLine(pending);
      pending = Buffer.alloc(0); discarding = false; start = newline + 1;
    }
  });
  process.stdin.on("end", () => { if (!discarding && pending.length) receiveLine(pending); });
  // EOF, SIGTERM, SIGINT and process crashes intentionally do not release a
  // lock. Only explicit release (or API close) establishes a completed session.
  return journal;
}
if (require.main === module) {
  try { serve(); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "error", code: error instanceof JournalError ? error.code : "E_JOURNAL_IO" })}\n`); process.exitCode = 1; }
}
module.exports = { LOCK_KEY, JournalError, validateRecord, openJournal, createRpc, serve };
