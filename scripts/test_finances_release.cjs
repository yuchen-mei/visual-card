#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const release = require("./finances_release.cjs");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const oid = text => crypto.createHash("sha1").update(text).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const HEAD = oid("synthetic base head"), OTHER = oid("synthetic raced head");
function envelope(seed = 1) {
  return `${JSON.stringify({ version: 1, kdf: "PBKDF2-SHA256", iterations: 250000, cipher: "AES-GCM", salt: Buffer.alloc(16, seed).toString("base64"), iv: Buffer.alloc(12, seed).toString("base64"), ciphertext: Buffer.alloc(32, seed).toString("base64") }, null, 2)}\n`;
}
function fixture(options = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), records = new Map(), calls = [], saves = [];
  let remoteHead = options.advanced ? OTHER : HEAD, locked = false, failedRead = false, createCount = 0;
  function makeBlob(content) { const sha = oid(content); blobs.set(sha, content); return sha; }
  const baseFiles = new Map([
    ["data.enc.json", { mode: "100644", type: "blob", sha: makeBlob(envelope()) }],
    ["index.html", { mode: "100644", type: "blob", sha: makeBlob("<html>old</html>\n") }],
    ["README.md", { mode: "100644", type: "blob", sha: makeBlob("# Synthetic fixture\n") }],
    ["scripts/old.cjs", { mode: "100644", type: "blob", sha: makeBlob("// unchanged source\n") }],
    ["assets/picture.bin", { mode: "100644", type: "blob", sha: oid("unchanged opaque binary") }]
  ]);
  function buildTree(files) {
    const root = new Map();
    for (const [file, entry] of files) {
      const parts = file.split("/"); let folder = root;
      for (const part of parts.slice(0, -1)) { if (!folder.has(part)) folder.set(part, new Map()); folder = folder.get(part); }
      folder.set(parts.at(-1), entry);
    }
    function visit(folder) {
      const direct = [];
      for (const [name, value] of folder) direct.push(value instanceof Map ? { path: name, mode: "040000", type: "tree", sha: visit(value) } : { path: name, ...value });
      direct.sort(compare); const sha = oid(JSON.stringify(direct)); trees.set(sha, direct); return sha;
    }
    return visit(root);
  }
  function recursive(sha, prefix = "") {
    const rows = [];
    for (const row of trees.get(sha)) { rows.push({ ...row, path: prefix + row.path }); if (row.type === "tree") rows.push(...recursive(row.sha, prefix + row.path + "/")); }
    return rows.sort(compare);
  }
  const baseTree = buildTree(baseFiles);
  commits.set(HEAD, { sha: HEAD, tree: { sha: baseTree }, parents: [], message: "synthetic baseline" });
  let candidateTree = null, candidateCommit = null;
  const candidateFiles = options.files || [
    { path: "index.html", content: "<html>统一现金 🌱</html>\n" },
    { path: "data.enc.json", content: envelope(2) },
    { path: "README.md", content: "# Synthetic fixture\n" },
    { path: "docs/update.md", content: "# Synthetic operation instructions\n" },
    { path: "scripts/native/helper.m", content: "// Synthetic source fixture\n" },
    { path: "scripts/new.cjs", content: '"use strict";\n// synthetic update\n' }
  ].map(file => ({ ...file, sha256: hash(file.content) }));
  const request = { operationId: "release:synthetic-test", expectedHead: HEAD, expectedSourceHashes: Object.fromEntries(candidateFiles.map(file => [file.path, file.sha256])), files: candidateFiles };
  function wrap(value) { return options.mcp ? { content: [{ type: "text", text: "Action completed." }], structuredContent: { content: JSON.stringify(value) }, isError: false } : clone(value); }
  function intent(stage, path) {
    assert.ok(locked, "global journal lock must span writes");
    assert.deepEqual(records.get(request.operationId)?.intent, stage === "blob" ? { stage, path } : { stage }, "intent must be durable before remote write");
  }
  const github = {
    fetch: async args => {
      calls.push({ method: "fetch", args: clone(args) });
      assert.ok(args.url.startsWith("https://api.github.com/repos/yuchen-mei/visual-card/"));
      if (options.failAfterBlob && !failedRead && createCount && records.get(request.operationId)?.intent === null) { failedRead = true; throw new Error("synthetic temporary read failure"); }
      const route = args.url.replace("https://api.github.com/repos/yuchen-mei/visual-card", ""); let match;
      if (route === "/git/ref/heads/main") return wrap({ ref: "refs/heads/main", object: { sha: remoteHead, type: "commit" } });
      if ((match = route.match(/^\/git\/commits\/([a-f0-9]{40})$/))) { assert.ok(commits.has(match[1])); return wrap(commits.get(match[1])); }
      if ((match = route.match(/^\/git\/trees\/([a-f0-9]{40})(\?recursive=1)?$/))) {
        assert.ok(trees.has(match[1])); let rows = match[2] ? recursive(match[1]) : clone(trees.get(match[1]));
        if (options.inconsistentTree && candidateTree && !match[2] && match[1] !== baseTree && match[1] !== candidateTree && rows.some(row => row.path === "helper.m")) rows[0].sha = oid("inconsistent intermediate child");
        if (options.fakeUnchangedDirectory && match[2] && match[1] === candidateTree) rows.find(row => row.path === "assets").sha = oid("fake unchanged directory");
        if (options.omittedRecursive && match[2]) rows = rows.filter(row => row.path !== "scripts/old.cjs");
        return wrap({ sha: match[1], truncated: !!options.truncated, tree: rows });
      }
      if ((match = route.match(/^\/git\/blobs\/([a-f0-9]{40})$/))) {
        assert.ok(blobs.has(match[1]));
        const content = blobs.get(match[1]);
        if (options.decoded) return { isError: false, content: [{ type: "text", text: "Action completed." }], structuredContent: { url: options.wrongUrl ? args.url + "?changed" : args.url, content, structuredContent: { display_url: args.url, content } } };
        return wrap({ sha: match[1], encoding: "base64", content: options.invalidUtf8 ? "/w==" : Buffer.from(content).toString("base64") });
      }
      throw new Error("Unhandled synthetic URL");
    },
    createBlob: async args => {
      calls.push({ method: "createBlob", args: clone(args) });
      const file = request.files.find(file => file.content === args.content); assert.ok(file);
      intent("blob", file.path); assert.equal(args.repository_full_name, release.REPOSITORY); assert.equal(args.encoding, "utf-8");
      if (options.waitBlob) await options.waitBlob();
      createCount++; const sha = makeBlob(options.wrongBlob ? "synthetic unreviewed source\n" : args.content);
      if (options.unknownBlob) throw new Error("synthetic credential in untrusted error must not escape");
      return wrap({ sha });
    },
    createTree: async args => {
      calls.push({ method: "createTree", args: clone(args) }); intent("tree");
      assert.equal(args.repository_full_name, release.REPOSITORY); assert.equal(args.base_tree_sha, baseTree);
      const changed = new Map(baseFiles);
      for (const row of args.tree_elements) { assert.equal(row.mode, "100644"); assert.equal(row.type, "blob"); changed.set(row.path, { mode: row.mode, type: row.type, sha: row.sha }); }
      if (options.extraFile) changed.set("private.json", { mode: "100644", type: "blob", sha: makeBlob("synthetic unexpected file") });
      if (options.changedSibling) changed.set("scripts/old.cjs", { mode: "100644", type: "blob", sha: makeBlob("synthetic unwanted change") });
      if (options.deletedSibling) changed.delete("assets/picture.bin");
      if (options.extraEmptyDirectory) { candidateTree = buildTree(changed); const rows = clone(trees.get(candidateTree)); const empty = oid("[]"); trees.set(empty, []); rows.push({ path: "unapproved", mode: "040000", type: "tree", sha: empty }); candidateTree = oid(JSON.stringify(rows)); trees.set(candidateTree, rows.sort(compare)); }
      else candidateTree = buildTree(changed);
      if (options.unknownTree) throw new Error("synthetic unknown tree response");
      return wrap({ tree_sha: candidateTree });
    },
    createCommit: async args => {
      calls.push({ method: "createCommit", args: clone(args) }); intent("commit");
      assert.deepEqual(args, { repository_full_name: release.REPOSITORY, parent_sha: HEAD, additional_parent_shas: [], tree_sha: candidateTree, message: release.MESSAGE });
      const parents = [{ sha: options.wrongParent ? OTHER : HEAD }]; if (options.extraParent) parents.push({ sha: OTHER });
      candidateCommit = oid(JSON.stringify(args)); commits.set(candidateCommit, { sha: candidateCommit, tree: { sha: candidateTree }, parents, message: args.message });
      if (options.advanceAfterCommit) remoteHead = OTHER;
      if (options.unknownCommit) throw new Error("synthetic unknown commit response");
      return wrap({ commit_sha: candidateCommit });
    },
    updateRef: async args => {
      calls.push({ method: "updateRef", args: clone(args) }); intent("ref");
      assert.deepEqual(args, { repository_full_name: release.REPOSITORY, branch_name: "main", sha: candidateCommit, expected_sha: HEAD, force: false });
      if (options.casRace) remoteHead = OTHER;
      if (remoteHead !== args.expected_sha) throw new Error("synthetic CAS rejection");
      if (options.unknownRefUnapplied) throw new Error("synthetic uncertain unapplied ref");
      remoteHead = args.sha;
      if (options.unknownRefApplied) throw new Error("synthetic uncertain applied ref");
      return wrap({ ref: "refs/heads/main", object: { sha: remoteHead } });
    }
  };
  const journal = {
    withLock: async (key, callback) => { assert.equal(key, "visual-card-github-main"); if (locked) throw new Error("synthetic locked"); locked = true; try { return await callback(); } finally { locked = false; } },
    load: async id => records.has(id) ? clone(records.get(id)) : null,
    save: async (id, record) => {
      assert.ok(locked); release.validateRecord(record); assert.equal(record.operationId, id);
      assert.doesNotMatch(JSON.stringify(record), /ciphertext|uniform synthetic password|统一现金|source fixture/);
      saves.push(clone(record));
      if (options.intentWriteFails && record.intent) throw new Error("synthetic journal write failure");
      if (options.blobReceiptFails && record.intent === null && createCount) throw new Error("synthetic journal receipt failure");
      records.set(id, clone(record));
    }
  };
  const deps = { hash, github, journal };
  return { request, deps, calls, saves, records, blobs, trees, commits, baseFiles, baseTree,
    mutations: () => calls.filter(call => call.method !== "fetch"),
    run: (patch = {}, api = release) => api.publishRelease({ ...request, ...patch }, deps),
    getHead: () => remoteHead, setHead: value => { remoteHead = value; }, getCommit: () => candidateCommit };
}
const tests = [], test = (name, run) => tests.push({ name, run });
test("dry-run is default and neither saves journal nor mutates remote", async () => {
  const f = fixture({ mcp: true }); assert.equal((await f.run()).status, "dry_run"); assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
});
test("publish checks exact UTF8 and creates only changed reviewed files and a CAS main ref", async () => {
  const f = fixture({ decoded: true }); const answer = await f.run({ publish: true });
  assert.equal(answer.status, "published"); assert.equal(f.getHead(), answer.commit);
  const names = f.mutations().map(call => call.method);
  assert.deepEqual(names, [...Array(5).fill("createBlob"), "createTree", "createCommit", "updateRef"]);
  const tree = f.mutations().find(call => call.method === "createTree");
  assert.deepEqual(tree.args.tree_elements.map(row => row.path), f.request.files.map(row => row.path).filter(path => path !== "README.md").sort());
  assert.equal(f.records.get(f.request.operationId).phase, "published");
  assert.equal(f.saves.filter(record => record.intent).length, 8);
});
test("REST base64 blobs retain Chinese and emoji UTF8 bytes", async () => {
  const f = fixture({ mcp: true }); assert.equal((await f.run({ publish: true })).status, "published");
});
test("unchanged source and ciphertext cause no object, ref or journal writes", async () => {
  const f = fixture(); const files = [{ path: "README.md", content: "# Synthetic fixture\n", sha256: hash("# Synthetic fixture\n") }];
  const result = await f.run({ files, expectedSourceHashes: Object.fromEntries(files.map(file => [file.path, file.sha256])), publish: true });
  assert.equal(result.status, "unchanged"); assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
});
test("independent manifest requires exact file set and exact actual hashes", async () => {
  for (const change of [
    f => ({ expectedSourceHashes: { ...f.request.expectedSourceHashes, "docs/extra.md": hash("x") } }),
    f => ({ files: f.request.files.slice(1) }),
    f => ({ files: f.request.files.map((file, i) => i ? file : { ...file, content: "synthetic unreviewed content" }) }),
    f => ({ expectedSourceHashes: { ...f.request.expectedSourceHashes, "index.html": hash("different review") } })
  ]) { const f = fixture(); assert.equal((await f.run({ ...change(f), publish: true })).status, "blocked"); assert.equal(f.calls.length, 0); }
});
test("path whitelist accepts reviewed native sources and refuses unsupported or secret files", async () => {
  for (const filename of ["scripts/native/a.c", "scripts/native/a.m", "scripts/native/a.cjs", "scripts/native/a.py", "scripts/native/a.swift", "scripts/run.cjs", "docs/update.md", ".gitignore", "index.html", "README.md"]) assert.equal(release.validPath(filename), true);
  for (const filename of ["index.preview.html", "index.private.html", "scripts/native/a", "scripts/native/a.o", "scripts/native/a.dylib", "scripts/private_key.py", "docs/secrets.md", "scripts/credentials.cjs", ".github/workflows/a.yml", "scripts/../a.py", "scripts//a.py", "/scripts/a.py", "scripts/native/sub/a.py", "data.json", "password.pem", ".env", "docs/deep/a.md"]) {
    assert.equal(release.validPath(filename), false, filename);
    const f = fixture(); const files = [{ path: filename, content: "synthetic", sha256: hash("synthetic") }];
    assert.equal((await f.run({ files, expectedSourceHashes: { [filename]: hash("synthetic") }, publish: true })).status, "blocked"); assert.equal(f.calls.length, 0);
  }
});
test("canonical v1 envelope rejects plaintext, duplicate keys and altered parameters", async () => {
  for (const content of [JSON.stringify({ plaintext: "synthetic" }), envelope(2).replace('"version": 1,', '"salt":"synthetic hidden content",\n"version": 1,'), envelope(2).replace("250000", "300000")]) {
    const f = fixture(); const files = [{ path: "data.enc.json", content, sha256: hash(content) }];
    assert.equal((await f.run({ files, expectedSourceHashes: { "data.enc.json": hash(content) }, publish: true })).status, "blocked"); assert.equal(f.mutations().length, 0);
  }
});
test("deep snapshot prevents caller from escalating dry-run or replacing nested files", async () => {
  const f = fixture(), input = clone({ ...f.request, publish: false }); let mutated = false;
  const deps = { ...f.deps, hash: async text => { if (!mutated) { mutated = true; input.publish = true; input.files[0].content = "unreviewed source"; input.files[0].sha256 = hash(input.files[0].content); input.expectedSourceHashes[input.files[0].path] = input.files[0].sha256; input.files.push({ path: "private.json" }); } return hash(text); } };
  assert.equal((await release.publishRelease(input, deps)).status, "dry_run"); assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
});
test("caller cannot replace a reviewed candidate during remote awaits", async () => {
  const f = fixture(), input = clone({ ...f.request, publish: true }), fetch = f.deps.github.fetch;
  f.deps.github.fetch = async args => { input.files[0].content = "unreviewed content"; input.expectedSourceHashes["index.html"] = hash("unreviewed content"); return fetch(args); };
  assert.equal((await release.publishRelease(input, f.deps)).status, "published");
  assert.ok(f.mutations().some(call => call.args.content === "<html>统一现金 🌱</html>\n"));
});
test("head change blocks before the first object write", async () => {
  const f = fixture({ advanced: true }); assert.equal((await f.run({ publish: true })).code, "E_HEAD_CHANGED"); assert.equal(f.mutations().length, 0);
});
test("head advance after commit never updates ref", async () => {
  const f = fixture({ advanceAfterCommit: true }); assert.equal((await f.run({ publish: true })).code, "E_HEAD_CHANGED"); assert.equal(f.mutations().some(call => call.method === "updateRef"), false);
});
test("CAS race never forces or retries an uncertain ref", async () => {
  const f = fixture({ casRace: true }); assert.equal((await f.run({ publish: true })).code, "E_REF_NOT_CONFIRMED");
  const count = f.mutations().length; assert.equal((await f.run({ publish: true })).status, "recovery_required"); assert.equal(f.mutations().length, count); assert.equal(f.getHead(), OTHER);
});
test("lost successful ref response reconciles exact verified commit", async () => {
  const f = fixture({ unknownRefApplied: true }); assert.equal((await f.run({ publish: true })).status, "published"); assert.equal(f.mutations().filter(call => call.method === "updateRef").length, 1);
});
test("unapplied uncertain ref is read-only until observed on the expected commit", async () => {
  const f = fixture({ unknownRefUnapplied: true }); assert.equal((await f.run({ publish: true })).status, "recovery_required");
  const before = f.mutations().length; assert.equal((await release.reconcileRelease(f.request.operationId, f.deps)).code, "E_REF_NOT_CONFIRMED");
  f.setHead(f.getCommit()); assert.equal((await release.reconcileRelease(f.request.operationId, f.deps)).status, "published"); assert.equal(f.mutations().length, before);
});
for (const setting of ["unknownBlob", "unknownTree", "unknownCommit"]) test(`${setting} stops and never blindly replays`, async () => {
  const f = fixture({ [setting]: true }); const result = await f.run({ publish: true }); assert.equal(result.status, "recovery_required");
  const before = f.mutations().length; assert.equal((await f.run({ publish: true })).code, "E_OBJECT_OUTCOME_UNCERTAIN"); assert.equal(f.mutations().length, before); assert.doesNotMatch(JSON.stringify(result), /credential|untrusted/);
});
test("failed intent persistence prevents any remote mutation", async () => {
  const f = fixture({ intentWriteFails: true }); assert.equal((await f.run({ publish: true })).code, "E_JOURNAL_WRITE"); assert.equal(f.mutations().length, 0);
});
test("failed receipt persistence leaves durable pending intent and blocks replay", async () => {
  const f = fixture({ blobReceiptFails: true }); assert.equal((await f.run({ publish: true })).status, "recovery_required");
  assert.equal(f.records.get(f.request.operationId).intent.stage, "blob"); await f.run({ publish: true }); assert.equal(f.mutations().length, 1);
});
test("known blob receipt resumes after a read failure without recreating the blob", async () => {
  const f = fixture({ failAfterBlob: true }); assert.equal((await f.run({ publish: true })).code, "E_READ");
  assert.equal(f.records.get(f.request.operationId).intent, null);
  assert.equal((await f.run({ publish: true })).status, "published"); assert.equal(f.mutations().filter(call => call.method === "createBlob").length, 5);
});
for (const [setting, code, before] of [
  ["wrongBlob", "E_CANDIDATE_CHANGED", "createTree"], ["extraFile", "E_TREE_SCOPE", "createCommit"], ["changedSibling", "E_TREE_SCOPE", "createCommit"],
  ["deletedSibling", "E_TREE_SCOPE", "createCommit"], ["extraEmptyDirectory", "E_TREE_SCOPE", "createCommit"], ["wrongParent", "E_COMMIT_SCOPE", "updateRef"],
  ["extraParent", "E_COMMIT_SCOPE", "updateRef"], ["inconsistentTree", "E_TREE_CONSISTENCY", "createCommit"], ["truncated", "E_TREE", "createBlob"],
  ["omittedRecursive", "E_TREE_CONSISTENCY", "createBlob"], ["wrongUrl", "E_BLOB", "createBlob"], ["invalidUtf8", "E_UTF8", "createBlob"]
]) test(`${setting} is rejected before ${before}`, async () => {
  const f = fixture({ [setting]: true, decoded: setting === "wrongUrl" }); const result = await f.run({ publish: true });
  assert.equal(result.code, code); assert.equal(f.mutations().some(call => call.method === before), false);
});
test("operation identity binds head and complete reviewed candidate manifest", async () => {
  const f = fixture({ unknownBlob: true }); await f.run({ publish: true }); const before = f.mutations().length;
  const files = f.request.files.map((file, i) => i ? file : { path: file.path, content: "approved replacement", sha256: hash("approved replacement") });
  assert.equal((await f.run({ files, expectedSourceHashes: Object.fromEntries(files.map(file => [file.path, file.sha256])), publish: true })).code, "E_OPERATION_REUSED"); assert.equal(f.mutations().length, before);
});
test("published record remains idempotent after later branch advancement", async () => {
  const f = fixture(); assert.equal((await f.run({ publish: true })).status, "published"); const count = f.mutations().length;
  f.setHead(OTHER); const answer = await f.run({ publish: true }); assert.equal(answer.status, "published"); assert.equal(answer.head, OTHER); assert.equal(f.mutations().length, count);
});
test("strict journal metadata rejects content, out-of-order manifests and impossible published intents", async () => {
  const f = fixture(); await f.run({ publish: true }); const original = f.records.get(f.request.operationId);
  for (const edit of [r => { r.content = "unexpected raw data"; }, r => { r.manifest.reverse(); }, r => { r.intent = { stage: null }; }, r => { r.expectedHead = { toString: () => HEAD }; }, r => { r.manifest[0].content = "unexpected raw source"; }]) {
    const record = clone(original); edit(record); assert.throws(() => release.validateRecord(record), error => error.code === "E_JOURNAL_RECORD");
  }
});
test("global journal lock excludes concurrent release operations", async () => {
  let unblock, started; const ready = new Promise(resolve => { started = resolve; }); let waited = false;
  const f = fixture({ waitBlob: async () => { if (waited) return; waited = true; started(); await new Promise(resolve => { unblock = resolve; }); } });
  const first = f.run({ publish: true }); await ready;
  assert.equal((await f.run({ publish: true, operationId: "other-release" })).status, "blocked"); unblock(); assert.equal((await first).status, "published");
});
test("new nested native source uses verified intermediate trees and unchanged sibling OIDs", async () => {
  const f = fixture(); assert.equal((await f.run({ publish: true })).status, "published");
  const before = f.trees.get(f.baseTree).find(row => row.path === "assets");
  const after = f.trees.get(f.commits.get(f.getCommit()).tree.sha).find(row => row.path === "assets"); assert.deepEqual(after, before);
  assert.ok(f.calls.some(call => call.args.url?.includes("?recursive=1")));
});
test("blob reads scale linearly with candidate manifest size", async () => {
  const f = fixture(); assert.equal((await f.run({ publish: true })).status, "published");
  const reads = f.calls.filter(call => call.args.url?.includes("/git/blobs/")).length; assert.ok(reads <= f.request.files.length * 4, `unexpected blob rereads: ${reads}`);
});
test("module embeds without Node globals or imports", async () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(__dirname, "finances_release.cjs"), "utf8"), context);
  const f = fixture({ decoded: true }); assert.equal(typeof context.VisualCardRelease.publishRelease, "function"); assert.equal((await f.run({}, context.VisualCardRelease)).status, "dry_run");
});
test("reconcile unknown operation is read-only not_found", async () => {
  const f = fixture(); assert.equal((await release.reconcileRelease("missing-release", f.deps)).status, "not_found"); assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
});
(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures++; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} synthetic release adapter tests passed.\n`); process.exitCode = failures ? 1 : 0;
})();
