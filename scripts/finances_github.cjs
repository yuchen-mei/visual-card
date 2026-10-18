"use strict";

// Dependency-free core: usable through require() or by evaluating this source in
// functions.exec (globalThis.VisualCardGitHub). No filesystem, crypto, process,
// credentials, network, or publication occurs at import. Only injected callbacks
// may access GitHub and the durable, exclusively locked journal.
(function install(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VisualCardGitHub = api;
})(globalThis, function factory() {
  const REPOSITORY = "yuchen-mei/visual-card";
  const BRANCH = "main";
  const FILE = "data.enc.json";
  const API = `https://api.github.com/repos/${REPOSITORY}`;
  const MESSAGE = "Update encrypted portfolio data";
  const LOCK_KEY = "visual-card-github-main";
  const SHA = /^[a-f0-9]{40}$/;
  const HASH = /^[a-f0-9]{64}$/;
  const OPERATION = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,159}$/;
  const copy = value => JSON.parse(JSON.stringify(value));
  class PublisherError extends Error { constructor(code) { super(code); this.code = code; } }
  function requireThat(ok, code) { if (!ok) throw new PublisherError(code); }
  function keys(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected.slice().sort().join(",");
  }
  function unwrapToolResult(raw) {
    requireThat(raw && raw.isError !== true, "E_TOOL_RESULT");
    let value = raw;
    for (let depth = 0; depth < 6; depth++) {
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { throw new PublisherError("E_TOOL_RESULT"); }
      } else if (value && typeof value === "object" && value.structuredContent) value = value.structuredContent;
      else if (value && typeof value.content === "string") {
        try { value = JSON.parse(value.content); } catch { return value; }
      } else if (value && Array.isArray(value.content)) {
        const blocks = value.content.filter(item => item.type === "text");
        requireThat(blocks.length === 1, "E_TOOL_RESULT"); value = blocks[0].text;
      } else break;
    }
    requireThat(value && typeof value === "object" && !Array.isArray(value), "E_TOOL_RESULT");
    return value;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function base64Length(value) {
    requireThat(typeof value === "string" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "E_BASE64");
    const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    requireThat(value.length > 0 && (!pad || (alphabet.indexOf(value[value.length - pad - 1]) & (pad === 2 ? 15 : 3)) === 0), "E_BASE64");
    return value.length / 4 * 3 - pad;
  }
  function base64Text(value) {
    requireThat(typeof value === "string" && value.length <= 34 * 1024 * 1024, "E_BASE64");
    value = value.replace(/[\r\n\t ]/g, "");
    const length = base64Length(value);
    const chunks = [];
    for (let i = 0; i < value.length; i += 4) {
      const n = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12) |
        (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]));
      for (const shift of [16, 8, 0]) {
        if (chunks.length >= length) break;
        const byte = (n >> shift) & 255;
        requireThat(byte <= 127, "E_ENVELOPE"); chunks.push(String.fromCharCode(byte));
      }
    }
    return chunks.join("");
  }
  function validateEnvelope(text, canonicalRequired = false) {
    requireThat(typeof text === "string" && text.length <= 24 * 1024 * 1024 && /^[\x00-\x7f]*$/.test(text), "E_ENVELOPE");
    let value;
    try { value = JSON.parse(text); } catch { throw new PublisherError("E_ENVELOPE"); }
    requireThat(keys(value, ["version", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"]) &&
      value.version === 1 && value.kdf === "PBKDF2-SHA256" && value.cipher === "AES-GCM" &&
      Number.isSafeInteger(value.iterations) && value.iterations >= 250000 && value.iterations <= 2000000, "E_ENVELOPE");
    requireThat(base64Length(value.salt) === 16 && base64Length(value.iv) === 12 && base64Length(value.ciphertext) > 16, "E_ENVELOPE");
    // Prevent duplicate JSON keys or ignored/escaped text from smuggling content
    // past a JSON.parse-only validator. The updater emits exactly this format.
    if (canonicalRequired) requireThat(text === `${JSON.stringify(value, null, 2)}\n`, "E_NONCANONICAL_ENVELOPE");
    return value;
  }
  function sameEnvelope(first, second) {
    const a = validateEnvelope(first), b = validateEnvelope(second);
    return ["version", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"].every(key => a[key] === b[key]);
  }
  function checkRequest(request) {
    const allowed = ["operationId", "expectedHead", "expectedCipherSha256", "content", "validatedSha256", "publish", "mode"];
    requireThat(request && typeof request === "object" && !Array.isArray(request) && Object.keys(request).every(k => allowed.includes(k)), "E_REQUEST");
    requireThat(typeof request.operationId === "string" && OPERATION.test(request.operationId) && !request.operationId.includes("//"), "E_OPERATION_ID");
    requireThat(typeof request.expectedHead === "string" && typeof request.expectedCipherSha256 === "string" && typeof request.validatedSha256 === "string" && SHA.test(request.expectedHead) && HASH.test(request.expectedCipherSha256) && HASH.test(request.validatedSha256), "E_HASH");
    requireThat(request.mode === undefined || request.mode === "data", "E_MODE");
    requireThat(request.publish === undefined || typeof request.publish === "boolean", "E_PUBLISH_FLAG");
    validateEnvelope(request.content, true);
  }
  function dependencies(deps, publishing) {
    requireThat(deps && typeof deps.hash === "function" && typeof deps.github?.fetch === "function", "E_DEPENDENCIES");
    if (publishing) {
      for (const name of ["createBlob", "createTree", "createCommit", "updateRef"]) requireThat(typeof deps.github[name] === "function", "E_DEPENDENCIES");
      for (const name of ["withLock", "load", "save"]) requireThat(typeof deps.journal?.[name] === "function", "E_JOURNAL_REQUIRED");
    }
  }
  async function digest(text, deps) {
    let value;
    try { value = await deps.hash(text); } catch { throw new PublisherError("E_HASH_PROVIDER"); }
    requireThat(HASH.test(value || ""), "E_HASH_PROVIDER"); return value;
  }
  async function get(suffix, deps) {
    try { return unwrapToolResult(await deps.github.fetch({ url: API + suffix })); }
    catch { throw new PublisherError("E_READ"); }
  }
  async function head(deps) {
    const ref = await get("/git/ref/heads/main", deps);
    requireThat(ref.ref === "refs/heads/main" && ref.object?.type === "commit" && SHA.test(ref.object.sha || ""), "E_REF");
    return ref.object.sha;
  }
  async function commit(sha, deps) {
    const value = await get(`/git/commits/${sha}`, deps);
    requireThat(value.sha === sha && SHA.test(value.tree?.sha || "") && Array.isArray(value.parents), "E_COMMIT"); return value;
  }
  async function tree(sha, deps) {
    // Root-tree equality also proves every nested subtree is unchanged, without
    // relying on recursive-tree or compare pagination limits.
    const value = await get(`/git/trees/${sha}`, deps);
    requireThat(value.sha === sha && value.truncated === false && Array.isArray(value.tree), "E_TREE");
    const seen = new Set();
    const rows = value.tree.map(item => {
      requireThat(typeof item.path === "string" && item.path.length > 0 && !seen.has(item.path) && SHA.test(item.sha || "") &&
        typeof item.mode === "string" && ["blob", "tree", "commit"].includes(item.type), "E_TREE");
      seen.add(item.path); return { path: item.path, mode: item.mode, type: item.type, sha: item.sha };
    });
    return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  function dataEntry(rows) {
    const row = rows.find(item => item.path === FILE);
    requireThat(row && row.mode === "100644" && row.type === "blob", "E_DATA_FILE"); return row;
  }
  async function blob(sha, deps) {
    const url = `${API}/git/blobs/${sha}`;
    let raw;
    try { raw = await deps.github.fetch({ url }); } catch { throw new PublisherError("E_READ"); }
    const value = unwrapToolResult(raw);
    // The connected GitHub fetch tool decodes a Git blob and places its exact
    // UTF-8 bytes in structuredContent.content. Preserve those bytes for hashing;
    // JSON.stringify(parsedEnvelope) would lose original formatting/newlines.
    if (keys(value, ["version", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"])) {
      const metadata = raw.structuredContent;
      requireThat(metadata?.url === url && typeof metadata.content === "string", "E_BLOB");
      validateEnvelope(metadata.content); return metadata.content;
    }
    requireThat(value.sha === sha && value.encoding === "base64", "E_BLOB");
    const text = base64Text(value.content); validateEnvelope(text); return text;
  }
  async function readBaseline(deps) {
    dependencies(deps, false);
    const initialHead = await head(deps);
    const base = await commit(initialHead, deps);
    const rows = await tree(base.tree.sha, deps);
    const content = await blob(dataEntry(rows).sha, deps);
    const sha256 = await digest(content, deps);
    requireThat(await head(deps) === initialHead, "E_HEAD_CHANGED");
    return { head: initialHead, content, sha256, treeSha: base.tree.sha };
  }
  async function baseline(expectedHead, sourceHash, deps, requireCurrent = true) {
    if (requireCurrent) requireThat(await head(deps) === expectedHead, "E_HEAD_CHANGED");
    const base = await commit(expectedHead, deps);
    const rows = await tree(base.tree.sha, deps);
    const text = await blob(dataEntry(rows).sha, deps);
    requireThat(await digest(text, deps) === sourceHash, "E_BASELINE_CHANGED");
    if (requireCurrent) requireThat(await head(deps) === expectedHead, "E_HEAD_CHANGED");
    return { treeSha: base.tree.sha, rows, text };
  }
  function onlyDataChanged(oldRows, newRows, blobSha) {
    const expected = oldRows.map(row => row.path === FILE ? { ...row, sha: blobSha } : row);
    requireThat(JSON.stringify(expected) === JSON.stringify(newRows), "E_TREE_SCOPE");
  }
  function envelopeChange(oldText, newText) {
    const before = validateEnvelope(oldText), after = validateEnvelope(newText, true);
    for (const name of ["version", "kdf", "iterations", "cipher"]) requireThat(before[name] === after[name], "E_ENVELOPE_PARAMETERS");
    for (const name of ["salt", "iv", "ciphertext"]) requireThat(before[name] !== after[name], "E_ENVELOPE_RANDOMNESS");
  }
  const recordKeys = ["version", "operationId", "repository", "branch", "path", "publish", "expectedHead", "sourceHash", "candidateHash", "baseTreeSha", "blobSha", "treeSha", "commitSha", "phase", "intent"];
  function validateRecord(record) {
    requireThat(keys(record, recordKeys) && record.version === 1 && record.repository === REPOSITORY && record.branch === BRANCH && record.path === FILE && record.publish === true && OPERATION.test(record.operationId || "") &&
      SHA.test(record.expectedHead || "") && HASH.test(record.sourceHash || "") && HASH.test(record.candidateHash || "") && SHA.test(record.baseTreeSha || ""), "E_JOURNAL_RECORD");
    const phases = ["ready", "blob", "tree", "commit", "published"], position = phases.indexOf(record.phase);
    requireThat(position >= 0, "E_JOURNAL_RECORD");
    for (const [index, name] of ["blobSha", "treeSha", "commitSha"].entries()) requireThat(position > index ? SHA.test(record[name] || "") : record[name] === null, "E_JOURNAL_RECORD");
    const next = { ready: "blob", blob: "tree", tree: "commit", commit: "ref", published: null }[record.phase];
    requireThat(record.intent === null || (next !== null && record.intent === next), "E_JOURNAL_RECORD");
    return record;
  }
  async function save(record, deps) {
    try { await deps.journal.save(record.operationId, copy(record)); } catch { throw new PublisherError("E_JOURNAL_WRITE"); }
  }
  function result(status, context, code) {
    const record = context.record;
    return { status, ...(code ? { code } : {}), ...(record ? { sourceHash: record.sourceHash, candidateHash: record.candidateHash, head: context.head || record.expectedHead, ...(record.commitSha ? { commit: record.commitSha } : {}) } : {}) };
  }
  async function verifyReceipts(record, base, deps) {
    if (record.blobSha) {
      const text = await blob(record.blobSha, deps);
      requireThat(await digest(text, deps) === record.candidateHash, "E_CANDIDATE_CHANGED"); envelopeChange(base.text, text);
    }
    if (record.treeSha) onlyDataChanged(base.rows, await tree(record.treeSha, deps), record.blobSha);
    if (record.commitSha) {
      const created = await commit(record.commitSha, deps);
      requireThat(created.tree.sha === record.treeSha && created.parents.length === 1 && created.parents[0].sha === record.expectedHead && created.message === MESSAGE, "E_COMMIT_SCOPE");
    }
  }
  async function loadRecord(id, deps) {
    let value;
    try { value = await deps.journal.load(id); } catch { throw new PublisherError("E_JOURNAL_READ"); }
    if (value === null || value === undefined) return null;
    const record = validateRecord(copy(value)); requireThat(record.operationId === id, "E_JOURNAL_RECORD"); return record;
  }
  async function reconcileLocked(record, context, deps) {
    context.record = record;
    context.head = await head(deps);
    // An unknown create-object result has no durable receipt: never recreate it.
    if (!record.commitSha || (record.intent !== null && record.intent !== "ref")) return result("recovery_required", context, "E_OBJECT_OUTCOME_UNCERTAIN");
    const base = await baseline(record.expectedHead, record.sourceHash, deps, false);
    requireThat(base.treeSha === record.baseTreeSha, "E_JOURNAL_BASELINE");
    await verifyReceipts(record, base, deps);
    if (record.phase === "published") return result("published", context);
    if (context.head !== record.commitSha) return result("recovery_required", context, "E_REF_NOT_CONFIRMED");
    record.phase = "published"; record.intent = null;
    await save(record, deps);
    return result("published", context);
  }
  async function mutate(stage, args, record, context, deps) {
    record.intent = stage; await save(record, deps); // MUST be durable before call.
    context.uncertain = true;
    const methods = { blob: "createBlob", tree: "createTree", commit: "createCommit" };
    let response;
    try { response = unwrapToolResult(await deps.github[methods[stage]](args)); } catch { throw new PublisherError("E_MUTATION_UNCERTAIN"); }
    const values = [response.sha, response[`${stage}_sha`]].filter(value => value !== undefined);
    requireThat(values.length > 0 && values.every(value => value === values[0]) && SHA.test(values[0] || ""), "E_MUTATION_UNCERTAIN");
    record[`${stage}Sha`] = values[0]; record.phase = stage; record.intent = null;
    await save(record, deps); context.uncertain = false;
  }
  async function publishLocked(request, deps, context) {
    let record = await loadRecord(request.operationId, deps);
    if (record) {
      context.record = record;
      requireThat(record.expectedHead === request.expectedHead && record.sourceHash === request.expectedCipherSha256 && record.candidateHash === request.validatedSha256, "E_OPERATION_REUSED");
      if (record.intent || record.phase === "published") return reconcileLocked(record, context, deps);
    }
    const base = await baseline(request.expectedHead, request.expectedCipherSha256, deps);
    if (sameEnvelope(base.text, request.content)) return { status: "unchanged", sourceHash: request.expectedCipherSha256, candidateHash: request.validatedSha256, head: request.expectedHead };
    envelopeChange(base.text, request.content);
    if (!record) record = { version: 1, operationId: request.operationId, repository: REPOSITORY, branch: BRANCH, path: FILE, publish: true,
      expectedHead: request.expectedHead, sourceHash: request.expectedCipherSha256, candidateHash: request.validatedSha256, baseTreeSha: base.treeSha,
      blobSha: null, treeSha: null, commitSha: null, phase: "ready", intent: null };
    context.record = record;
    requireThat(record.baseTreeSha === base.treeSha, "E_JOURNAL_BASELINE");
    await verifyReceipts(record, base, deps);
    if (!record.blobSha) {
      requireThat(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("blob", { repository_full_name: REPOSITORY, content: request.content, encoding: "utf-8" }, record, context, deps);
      await verifyReceipts(record, base, deps);
    }
    if (!record.treeSha) {
      requireThat(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("tree", { repository_full_name: REPOSITORY, base_tree_sha: record.baseTreeSha, tree_elements: [{ path: FILE, mode: "100644", type: "blob", sha: record.blobSha }] }, record, context, deps);
      await verifyReceipts(record, base, deps);
    }
    if (!record.commitSha) {
      requireThat(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("commit", { repository_full_name: REPOSITORY, parent_sha: record.expectedHead, additional_parent_shas: [], tree_sha: record.treeSha, message: MESSAGE }, record, context, deps);
      await verifyReceipts(record, base, deps);
    }
    requireThat(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
    record.intent = "ref"; await save(record, deps); context.uncertain = true;
    try {
      await deps.github.updateRef({ repository_full_name: REPOSITORY, branch_name: BRANCH, sha: record.commitSha, expected_sha: record.expectedHead, force: false });
    } catch { /* Fetch the head to reconcile an ambiguous response; never retry. */ }
    const answer = await reconcileLocked(record, context, deps);
    if (answer.status === "published") context.uncertain = false;
    return answer;
  }
  async function publishData(request, deps) {
    const context = { record: null, uncertain: false };
    try {
      // Capture authorization/content before the first await. A caller must not
      // mutate publish:false into true, or replace validated ciphertext mid-run.
      requireThat(request && typeof request === "object" && !Array.isArray(request), "E_REQUEST");
      request = Object.freeze({ ...request });
      checkRequest(request); dependencies(deps, request.publish === true);
      requireThat(await digest(request.content, deps) === request.validatedSha256, "E_VALIDATION_HASH");
      if (request.publish !== true) {
        const base = await baseline(request.expectedHead, request.expectedCipherSha256, deps);
        const unchanged = sameEnvelope(base.text, request.content);
        if (!unchanged) envelopeChange(base.text, request.content);
        return { status: unchanged ? "unchanged" : "dry_run", sourceHash: request.expectedCipherSha256, candidateHash: request.validatedSha256, head: request.expectedHead };
      }
      return await deps.journal.withLock(LOCK_KEY, () => publishLocked(request, deps, context));
    } catch (error) {
      return result(context.uncertain || context.record?.intent ? "recovery_required" : "blocked", context, error instanceof PublisherError ? error.code : "E_ADAPTER");
    }
  }
  async function reconcile(operationId, deps) {
    const context = { record: null, uncertain: true };
    try {
      requireThat(OPERATION.test(operationId || ""), "E_OPERATION_ID"); dependencies(deps, true);
      return await deps.journal.withLock(LOCK_KEY, async () => {
        const record = await loadRecord(operationId, deps);
        if (!record) return { status: "not_found" };
        return reconcileLocked(record, context, deps);
      });
    } catch (error) { return result("recovery_required", context, error instanceof PublisherError ? error.code : "E_ADAPTER"); }
  }
  return { REPOSITORY, BRANCH, FILE, LOCK_KEY, PublisherError, unwrapToolResult, validateEnvelope, readBaseline, publishData, reconcile };
});
