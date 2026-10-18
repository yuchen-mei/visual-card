#!/usr/bin/env node
"use strict";

// Synthetic encrypted envelopes, mocked GitHub objects, and in-memory journals.
// No network, GitHub writes, credentials, financial data, or production state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const publisher = require("./finances_github.cjs");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const sha = char => char.repeat(40);
const IDS = { head: sha("a"), baseTree: sha("b"), oldBlob: sha("c"), blob: sha("d"), tree: sha("e"), commit: sha("f"), other: sha("1") };
const clone = value => JSON.parse(JSON.stringify(value));
function envelope(seed = 1) {
  return `${JSON.stringify({ version: 1, kdf: "PBKDF2-SHA256", iterations: 250000, cipher: "AES-GCM", salt: Buffer.alloc(16, seed).toString("base64"), iv: Buffer.alloc(12, seed).toString("base64"), ciphertext: Buffer.alloc(32, seed).toString("base64") }, null, 2)}\n`;
}
function fixture(settings = {}) {
  const oldText = settings.compactBaseline ? JSON.stringify(JSON.parse(envelope())) : envelope();
  const records = new Map(), calls = [], saves = [];
  const blobs = new Map([[IDS.oldBlob, oldText]]);
  const baseRows = [
    { path: "data.enc.json", mode: "100644", type: "blob", sha: IDS.oldBlob },
    { path: "index.html", mode: "100644", type: "blob", sha: sha("2") },
    { path: "scripts", mode: "040000", type: "tree", sha: sha("3") }
  ];
  const trees = new Map([[IDS.baseTree, baseRows]]);
  const commits = new Map([[IDS.head, { sha: IDS.head, tree: { sha: IDS.baseTree }, parents: [], message: "baseline" }]]);
  let remoteHead = settings.advanced ? IDS.other : IDS.head;
  let locked = false, fetches = 0, failReadOnce = !!settings.failAfterBlob;
  function wrap(value) {
    return settings.mcpResponses ? { content: [{ type: "text", text: "Action completed." }], structuredContent: { content: JSON.stringify(value) }, isError: false } : value;
  }
  function intent(stage) {
    const current = records.get(request.operationId);
    assert.equal(current?.intent, stage, "durable matching intent must exist before every remote mutation");
    assert.ok(locked, "global publication lock must span remote mutation");
  }
  const github = {
    fetch: async args => {
      calls.push({ method: "fetch", args }); fetches++;
      assert.ok(args.url.startsWith("https://api.github.com/repos/yuchen-mei/visual-card/"));
      if (failReadOnce && records.get(request.operationId)?.phase === "blob" && records.get(request.operationId)?.intent === null) { failReadOnce = false; throw new Error("synthetic temporary read failure"); }
      const route = args.url.replace("https://api.github.com/repos/yuchen-mei/visual-card", "");
      if (route === "/git/ref/heads/main") return wrap({ ref: "refs/heads/main", object: { sha: remoteHead, type: "commit" } });
      let match;
      if ((match = route.match(/^\/git\/commits\/([a-f0-9]{40})$/))) { assert.ok(commits.has(match[1])); return wrap(clone(commits.get(match[1]))); }
      if ((match = route.match(/^\/git\/trees\/([a-f0-9]{40})$/))) {
        assert.ok(trees.has(match[1]));
        return wrap({ sha: match[1], truncated: !!settings.truncated, tree: clone(trees.get(match[1])) });
      }
      if ((match = route.match(/^\/git\/blobs\/([a-f0-9]{40})$/))) {
        assert.ok(blobs.has(match[1]));
        if (settings.decodedBlobResponses) return {
          content: [{ type: "text", text: "Action completed." }], isError: false,
          structuredContent: { url: args.url, content: blobs.get(match[1]), structuredContent: { display_url: args.url, content: blobs.get(match[1]) } }
        };
        return wrap({ sha: match[1], encoding: "base64", content: Buffer.from(blobs.get(match[1])).toString("base64") });
      }
      throw new Error("Unhandled synthetic endpoint");
    },
    createBlob: async args => {
      calls.push({ method: "createBlob", args }); intent("blob");
      assert.deepEqual(args, { repository_full_name: publisher.REPOSITORY, encoding: "utf-8", content: request.content });
      if (settings.waitBlob) await settings.waitBlob();
      blobs.set(IDS.blob, settings.wrongBlob ? envelope(3) : args.content);
      if (settings.unknownBlob) throw new Error("synthetic secret-bearing transport error must not escape");
      return wrap({ sha: IDS.blob });
    },
    createTree: async args => {
      calls.push({ method: "createTree", args }); intent("tree");
      assert.deepEqual(args, { repository_full_name: publisher.REPOSITORY, base_tree_sha: IDS.baseTree, tree_elements: [{ path: "data.enc.json", mode: "100644", type: "blob", sha: IDS.blob }] });
      const rows = baseRows.map(row => row.path === "data.enc.json" ? { ...row, sha: IDS.blob } : row);
      if (settings.extraFile) rows.push({ path: "private.json", mode: "100644", type: "blob", sha: sha("4") });
      if (settings.changedScript) rows.find(row => row.path === "scripts").sha = sha("4");
      trees.set(IDS.tree, rows);
      if (settings.unknownTree) throw new Error("synthetic unknown tree outcome");
      return wrap({ sha: IDS.tree });
    },
    createCommit: async args => {
      calls.push({ method: "createCommit", args }); intent("commit");
      assert.deepEqual(args, { repository_full_name: publisher.REPOSITORY, parent_sha: IDS.head, additional_parent_shas: [], tree_sha: IDS.tree, message: "Update encrypted portfolio data" });
      commits.set(IDS.commit, { sha: IDS.commit, tree: { sha: IDS.tree }, parents: [{ sha: settings.wrongParent ? IDS.other : IDS.head }], message: args.message });
      if (settings.advanceAfterCommit) remoteHead = IDS.other;
      if (settings.unknownCommit) throw new Error("synthetic unknown commit outcome");
      return wrap({ sha: IDS.commit });
    },
    updateRef: async args => {
      calls.push({ method: "updateRef", args }); intent("ref");
      assert.deepEqual(args, { repository_full_name: publisher.REPOSITORY, branch_name: "main", sha: IDS.commit, expected_sha: IDS.head, force: false });
      if (settings.casRace) remoteHead = IDS.other;
      if (remoteHead !== args.expected_sha) throw new Error("synthetic CAS rejection");
      if (settings.unknownRefUnapplied) throw new Error("synthetic uncertain ref response");
      remoteHead = args.sha;
      if (settings.unknownRefApplied) throw new Error("synthetic uncertain applied response");
      return wrap({ ref: "refs/heads/main", object: { sha: remoteHead } });
    }
  };
  const journal = {
    withLock: async (key, fn) => {
      assert.equal(key, publisher.LOCK_KEY);
      if (locked) throw new Error("synthetic journal busy");
      locked = true; try { return await fn(); } finally { locked = false; }
    },
    load: async id => records.has(id) ? clone(records.get(id)) : null,
    save: async (id, record) => {
      saves.push(clone(record));
      assert.equal(record.operationId, id);
      assert.ok(!JSON.stringify(record).includes("ciphertext"));
      assert.ok(!Object.hasOwn(record, "content"));
      if (settings.intentWriteFails && record.intent) throw new Error("synthetic journal failure");
      if (settings.blobReceiptFails && record.phase === "blob" && record.intent === null) throw new Error("synthetic receipt failure");
      records.set(id, clone(record));
    }
  };
  const request = { operationId: "visual-card:America/Los_Angeles:2026-10-17", expectedHead: IDS.head, expectedCipherSha256: hash(oldText), content: envelope(2), validatedSha256: hash(envelope(2)) };
  return {
    request, deps: { github, hash, journal }, calls, records, saves,
    mutations: () => calls.filter(call => call.method !== "fetch"),
    run: (patch = {}, api = publisher) => api.publishData({ ...request, ...patch }, { github, hash, journal }),
    setHead: value => { remoteHead = value; }, getHead: () => remoteHead,
    setRecord: record => records.set(request.operationId, clone(record)),
    get fetches() { return fetches; }
  };
}

const tests = [], test = (name, run) => tests.push({ name, run });
test("default dry-run checks actual remote baseline without any journal or GitHub writes", async () => {
  const f = fixture({ mcpResponses: true });
  const result = await f.run();
  assert.equal(result.status, "dry_run"); assert.equal(result.sourceHash, f.request.expectedCipherSha256);
  assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0); assert.ok(f.fetches > 0);
});
test("actual trusted hash must match the validation receipt before any remote access", async () => {
  const f = fixture(); const result = await f.run({ validatedSha256: "0".repeat(64), publish: true });
  assert.equal(result.code, "E_VALIDATION_HASH"); assert.equal(f.calls.length, 0);
});
test("readBaseline returns fresh exact ciphertext and no writes", async () => {
  const f = fixture({ decodedBlobResponses: true, compactBaseline: true });
  const result = await publisher.readBaseline(f.deps);
  assert.deepEqual(Object.keys(result).sort(), ["content", "head", "sha256", "treeSha"]);
  assert.equal(result.head, IDS.head); assert.equal(result.treeSha, IDS.baseTree);
  assert.equal(result.sha256, hash(result.content)); assert.equal(result.sha256, f.request.expectedCipherSha256);
  assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
});
test("readBaseline rejects a remote head race during the read", async () => {
  const f = fixture(); const fetch = f.deps.github.fetch;
  f.deps.github.fetch = async args => {
    const response = await fetch(args);
    if (args.url.includes("/git/blobs/")) f.setHead(IDS.other);
    return response;
  };
  await assert.rejects(publisher.readBaseline(f.deps), error => error.code === "E_HEAD_CHANGED");
  assert.equal(f.mutations().length, 0);
});
test("decoded GitHub blob responses preserve exact ciphertext bytes through publication", async () => {
  const f = fixture({ decodedBlobResponses: true });
  assert.equal((await f.run({ publish: true })).status, "published");
});
test("caller mutation during hashing cannot escalate dry-run into publication", async () => {
  const f = fixture(), request = { ...f.request, publish: false };
  const deps = { ...f.deps, hash: async text => { request.publish = true; return hash(text); } };
  const result = await publisher.publishData(request, deps);
  assert.equal(result.status, "dry_run"); assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
});
test("caller mutation during remote reads cannot replace validated content", async () => {
  const f = fixture(), request = { ...f.request, publish: true }, fetch = f.deps.github.fetch;
  let headReads = 0;
  f.deps.github.fetch = async args => {
    if (args.url.endsWith("/git/ref/heads/main") && ++headReads === 3) request.content = "synthetic unvalidated plaintext";
    return fetch(args);
  };
  const result = await publisher.publishData(request, f.deps);
  assert.equal(result.status, "published");
  assert.equal(f.mutations().find(call => call.method === "createBlob").args.content, f.request.content);
});
test("unchanged envelope causes zero mutations including format-only differences", async () => {
  for (const compactBaseline of [false, true]) {
    const f = fixture({ compactBaseline }); const content = envelope();
    const result = await f.run({ content, validatedSha256: hash(content), publish: true });
    assert.equal(result.status, "unchanged"); assert.equal(f.mutations().length, 0); assert.equal(f.saves.length, 0);
  }
});
test("explicit publication verifies every object and CAS updates only fixed main", async () => {
  const f = fixture({ mcpResponses: true }); const result = await f.run({ publish: true });
  assert.equal(result.status, "published"); assert.equal(result.commit, IDS.commit); assert.equal(f.getHead(), IDS.commit);
  assert.deepEqual(f.mutations().map(call => call.method), ["createBlob", "createTree", "createCommit", "updateRef"]);
  assert.deepEqual(f.saves.filter(record => record.intent).map(record => record.intent), ["blob", "tree", "commit", "ref"]);
  assert.equal(f.records.get(f.request.operationId).phase, "published");
  assert.ok(Object.keys(result).every(key => ["status", "sourceHash", "candidateHash", "head", "commit", "code"].includes(key)));
});
test("already advanced remote head blocks before object creation", async () => {
  const f = fixture({ advanced: true }); const result = await f.run({ publish: true });
  assert.equal(result.code, "E_HEAD_CHANGED"); assert.equal(f.mutations().length, 0);
});
test("advance after commit creation stops before ref update", async () => {
  const f = fixture({ advanceAfterCommit: true }); const result = await f.run({ publish: true });
  assert.equal(result.code, "E_HEAD_CHANGED"); assert.equal(f.mutations().some(call => call.method === "updateRef"), false);
});
test("CAS race never forces or retries and preserves pending ref intent", async () => {
  const f = fixture({ casRace: true }); const result = await f.run({ publish: true });
  assert.equal(result.status, "recovery_required"); assert.equal(result.code, "E_REF_NOT_CONFIRMED");
  assert.equal(f.records.get(f.request.operationId).intent, "ref");
  const before = f.mutations().length;
  assert.equal((await f.run({ publish: true })).status, "recovery_required");
  assert.equal(f.mutations().length, before); assert.equal(f.getHead(), IDS.other);
});
test("lost successful ref response reconciles by fetching the exact verified head", async () => {
  const f = fixture({ unknownRefApplied: true }); const result = await f.run({ publish: true });
  assert.equal(result.status, "published"); assert.equal(f.mutations().filter(call => call.method === "updateRef").length, 1);
  assert.equal(f.records.get(f.request.operationId).intent, null);
});
test("unknown unapplied ref response is never blindly replayed while still on old head", async () => {
  const f = fixture({ unknownRefUnapplied: true });
  assert.equal((await f.run({ publish: true })).status, "recovery_required");
  assert.equal((await publisher.reconcile(f.request.operationId, f.deps)).status, "recovery_required");
  assert.equal(f.mutations().filter(call => call.method === "updateRef").length, 1);
  f.setHead(IDS.commit); // Simulate eventual completion of the already-issued call.
  assert.equal((await publisher.reconcile(f.request.operationId, f.deps)).status, "published");
  assert.equal(f.mutations().filter(call => call.method === "updateRef").length, 1);
});
for (const [setting, stage] of [["unknownBlob", "blob"], ["unknownTree", "tree"], ["unknownCommit", "commit"]]) {
  test(`unknown ${stage} creation outcome blocks all replay`, async () => {
    const f = fixture({ [setting]: true }); const result = await f.run({ publish: true });
    assert.equal(result.status, "recovery_required"); assert.equal(f.records.get(f.request.operationId).intent, stage);
    const count = f.mutations().length;
    assert.equal((await f.run({ publish: true })).status, "recovery_required"); assert.equal(f.mutations().length, count);
    assert.doesNotMatch(JSON.stringify(result), /secret-bearing|transport/);
  });
}
test("journal intent must save successfully before any mutation", async () => {
  const f = fixture({ intentWriteFails: true }); const result = await f.run({ publish: true });
  assert.equal(result.code, "E_JOURNAL_WRITE"); assert.equal(f.mutations().length, 0);
});
test("lost receipt persistence leaves pending intent and prevents duplicate object creation", async () => {
  const f = fixture({ blobReceiptFails: true });
  assert.equal((await f.run({ publish: true })).status, "recovery_required");
  assert.equal(f.records.get(f.request.operationId).intent, "blob");
  await f.run({ publish: true }); assert.equal(f.mutations().length, 1);
});
test("known saved receipt resumes after read failure without recreating its object", async () => {
  const f = fixture({ failAfterBlob: true });
  assert.equal((await f.run({ publish: true })).code, "E_READ");
  assert.equal(f.records.get(f.request.operationId).phase, "blob");
  assert.equal((await f.run({ publish: true })).status, "published");
  assert.equal(f.mutations().filter(call => call.method === "createBlob").length, 1);
});
for (const [setting, code, stoppedBefore] of [
  ["wrongBlob", "E_CANDIDATE_CHANGED", "createTree"], ["extraFile", "E_TREE_SCOPE", "createCommit"],
  ["changedScript", "E_TREE_SCOPE", "createCommit"], ["wrongParent", "E_COMMIT_SCOPE", "updateRef"], ["truncated", "E_TREE", "createBlob"]
]) test(`${setting} is rejected before ${stoppedBefore}`, async () => {
  const f = fixture({ [setting]: true }); const result = await f.run({ publish: true });
  assert.equal(result.code, code); assert.equal(f.mutations().some(call => call.method === stoppedBefore), false);
});
test("malicious or extra-file requests are rejected before remote access", async () => {
  for (const patch of [{ files: [{ path: "private.json" }] }, { mode: "initial-code" }, { repository: "other/repo" }, { publish: "true" }]) {
    const f = fixture(); assert.equal((await f.run(patch)).status, "blocked"); assert.equal(f.calls.length, 0);
  }
  for (const content of [JSON.stringify({ plaintext: "synthetic" }), envelope(2).replace('"version": 1,', '"salt": "synthetic ignored plaintext",\n  "version": 1,')]) {
    const f = fixture(); assert.equal((await f.run({ content, validatedSha256: hash(content), publish: true })).status, "blocked"); assert.equal(f.calls.length, 0);
  }
});
test("operation identity cannot be reused for a different candidate", async () => {
  const f = fixture({ unknownBlob: true }); await f.run({ publish: true });
  const content = envelope(3), before = f.mutations().length;
  assert.equal((await f.run({ content, validatedSha256: hash(content), publish: true })).code, "E_OPERATION_REUSED");
  assert.equal(f.mutations().length, before);
});
test("confirmed publication remains idempotent after later remote advancement", async () => {
  const f = fixture(); await f.run({ publish: true }); const count = f.mutations().length;
  f.setHead(IDS.other);
  const result = await f.run({ publish: true });
  assert.equal(result.status, "published"); assert.equal(result.commit, IDS.commit); assert.equal(result.head, IDS.other);
  assert.equal(f.mutations().length, count);
});
test("global journal lock excludes a concurrent operation with a different key", async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ waitBlob: async () => { started(); await new Promise(resolve => { release = resolve; }); } });
  const first = f.run({ publish: true }); await ready;
  const second = await f.run({ publish: true, operationId: "other-operation" });
  assert.equal(second.status, "blocked"); release(); assert.equal((await first).status, "published");
  assert.equal(f.mutations().filter(call => call.method === "createBlob").length, 1);
});
test("same source runs embedded without Node globals or imports", async () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "finances_github.cjs"), "utf8"), context);
  assert.equal(typeof context.VisualCardGitHub.publishData, "function");
  const f = fixture(); const result = await f.run({}, context.VisualCardGitHub);
  assert.equal(result.status, "dry_run"); assert.equal(f.mutations().length, 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures++; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} synthetic GitHub adapter tests passed.\n`);
  process.exitCode = failures ? 1 : 0;
})();
