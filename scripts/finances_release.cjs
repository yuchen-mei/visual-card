"use strict";

// Dependency-free release core. Importing/evaluating this file never performs IO.
// Source privacy review and encrypted-data validation happen before the reviewed
// SHA-256 manifest is supplied. Only injected callbacks can read/write GitHub.
(function install(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VisualCardRelease = api;
})(globalThis, function factory() {
  const REPOSITORY = "yuchen-mei/visual-card", BRANCH = "main";
  const API = `https://api.github.com/repos/${REPOSITORY}`;
  const LOCK_KEY = "visual-card-github-main", MESSAGE = "Install verified portfolio update workflow";
  const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
  const OPERATION = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,159}$/;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clone = value => JSON.parse(JSON.stringify(value));
  const ordered = rows => rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  class ReleaseError extends Error { constructor(code) { super(code); this.code = code; } }
  function need(ok, code) { if (!ok) throw new ReleaseError(code); }
  function exact(value, names) {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names.slice().sort().join(",");
  }
  function validOperation(value) { return typeof value === "string" && OPERATION.test(value) && !value.includes("//"); }
  function validPath(value) {
    if (typeof value !== "string" || value.length > 240 || value.includes("..")) return false;
    if ([".gitignore", "README.md", "index.html", "index.preview.html", "data.enc.json"].includes(value)) return true;
    if (!/^(?:docs\/[A-Za-z0-9][A-Za-z0-9_.-]*\.md|scripts\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:cjs|py)|scripts\/native\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:swift|py|c|m|cjs))$/.test(value)) return false;
    return !value.split("/").some(part => /(?:^|[_.-])(?:secrets?|credentials?|private[_-]?key|id_rsa|id_ed25519|env)(?:[_.-]|$)/i.test(part));
  }
  function validText(value, max) {
    if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return false;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { const d = value.charCodeAt(++i); if (!(d >= 0xdc00 && d <= 0xdfff)) return false; }
      else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
  }
  function base64Bytes(text) {
    need(typeof text === "string" && text.length <= 34 * 1024 * 1024, "E_BASE64");
    const value = text.replace(/[\r\n\t ]/g, "");
    need(value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "E_BASE64");
    if (!value.length) return [];
    const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    need(!pad || (alphabet.indexOf(value[value.length - pad - 1]) & (pad === 2 ? 15 : 3)) === 0, "E_BASE64");
    const length = value.length / 4 * 3 - pad, bytes = [];
    for (let i = 0; i < value.length; i += 4) {
      const n = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12) | (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]));
      for (const shift of [16, 8, 0]) if (bytes.length < length) bytes.push((n >> shift) & 255);
    }
    return bytes;
  }
  function utf8(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length;) {
      let c = bytes[i++], n, min;
      if (c < 128) { out.push(String.fromCharCode(c)); continue; }
      if (c >= 194 && c <= 223) { n = 1; min = 128; c &= 31; }
      else if (c >= 224 && c <= 239) { n = 2; min = 2048; c &= 15; }
      else if (c >= 240 && c <= 244) { n = 3; min = 65536; c &= 7; }
      else throw new ReleaseError("E_UTF8");
      need(i + n <= bytes.length, "E_UTF8");
      for (let k = 0; k < n; k++) { const b = bytes[i++]; need((b & 192) === 128, "E_UTF8"); c = (c << 6) | (b & 63); }
      need(c >= min && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff), "E_UTF8");
      out.push(String.fromCodePoint(c));
    }
    return out.join("");
  }
  function validateEnvelope(text, canonicalRequired = false) {
    need(typeof text === "string" && text.length <= 24 * 1024 * 1024 && /^[\x00-\x7f]*$/.test(text), "E_ENVELOPE");
    let value; try { value = JSON.parse(text); } catch { throw new ReleaseError("E_ENVELOPE"); }
    need(exact(value, ["version", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"]) && value.version === 1 && value.kdf === "PBKDF2-SHA256" && value.cipher === "AES-GCM" && Number.isSafeInteger(value.iterations) && value.iterations >= 250000 && value.iterations <= 2000000, "E_ENVELOPE");
    // Envelope base64 must itself be canonical, without whitespace.
    for (const key of ["salt", "iv", "ciphertext"]) need(typeof value[key] === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value[key]), "E_ENVELOPE");
    need(base64Bytes(value.salt).length === 16 && base64Bytes(value.iv).length === 12 && base64Bytes(value.ciphertext).length > 16, "E_ENVELOPE");
    if (canonicalRequired) need(text === `${JSON.stringify(value, null, 2)}\n`, "E_NONCANONICAL_ENVELOPE");
    return value;
  }
  function envelopeChange(before, after) {
    const a = validateEnvelope(before), b = validateEnvelope(after, true);
    for (const key of ["version", "kdf", "iterations", "cipher"]) need(a[key] === b[key], "E_ENVELOPE_PARAMETERS");
    for (const key of ["salt", "iv", "ciphertext"]) need(a[key] !== b[key], "E_ENVELOPE_RANDOMNESS");
  }
  function unwrap(raw) {
    need(raw && raw.isError !== true, "E_TOOL_RESULT");
    let value = raw;
    for (let i = 0; i < 8; i++) {
      if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw new ReleaseError("E_TOOL_RESULT"); } }
      else if (value && typeof value === "object" && value.structuredContent) value = value.structuredContent;
      else if (value && typeof value.content === "string") { try { value = JSON.parse(value.content); } catch { return value; } }
      else if (value && Array.isArray(value.content)) { const texts = value.content.filter(item => item.type === "text"); need(texts.length === 1, "E_TOOL_RESULT"); value = texts[0].text; }
      else break;
    }
    need(value && typeof value === "object" && !Array.isArray(value), "E_TOOL_RESULT"); return value;
  }
  function snapshot(input) {
    const names = ["operationId", "expectedHead", "expectedSourceHashes", "files", "publish"];
    need(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => names.includes(key)), "E_REQUEST");
    const operationId = input.operationId, expectedHead = input.expectedHead, publish = input.publish;
    need(validOperation(operationId), "E_OPERATION_ID"); need(typeof expectedHead === "string" && SHA.test(expectedHead), "E_HASH");
    need(publish === undefined || typeof publish === "boolean", "E_PUBLISH_FLAG");
    const rawFiles = input.files, rawManifest = input.expectedSourceHashes;
    need(Array.isArray(rawFiles) && rawFiles.length > 0 && rawFiles.length <= 128 && rawManifest && typeof rawManifest === "object" && !Array.isArray(rawManifest), "E_MANIFEST");
    const expectedSourceHashes = Object.create(null);
    for (const key of Object.keys(rawManifest)) {
      const value = rawManifest[key]; need(validPath(key) && typeof value === "string" && HASH.test(value), "E_MANIFEST"); expectedSourceHashes[key] = value;
    }
    let size = 0; const seen = new Set();
    const files = ordered(rawFiles.map(file => {
      need(exact(file, ["path", "content", "sha256"]), "E_FILE");
      const path = file.path, content = file.content, sha256 = file.sha256;
      need(validPath(path) && !seen.has(path), "E_PATH"); seen.add(path);
      need(validText(content, path === "data.enc.json" ? 24 * 1024 * 1024 : 2 * 1024 * 1024), "E_CONTENT");
      need(typeof sha256 === "string" && HASH.test(sha256) && expectedSourceHashes[path] === sha256, "E_MANIFEST_HASH");
      if (path === "data.enc.json") validateEnvelope(content, true);
      size += content.length; return Object.freeze({ path, content, sha256 });
    }));
    need(size <= 30 * 1024 * 1024 && files.length === Object.keys(expectedSourceHashes).length, "E_MANIFEST");
    return Object.freeze({ operationId, expectedHead, publish, expectedSourceHashes: Object.freeze(expectedSourceHashes), files: Object.freeze(files) });
  }
  function dependencies(deps, publishing) {
    need(deps && typeof deps.hash === "function" && typeof deps.github?.fetch === "function", "E_DEPENDENCIES");
    if (publishing) {
      for (const key of ["createBlob", "createTree", "createCommit", "updateRef"]) need(typeof deps.github[key] === "function", "E_DEPENDENCIES");
      for (const key of ["withLock", "load", "save"]) need(typeof deps.journal?.[key] === "function", "E_JOURNAL_REQUIRED");
    }
  }
  async function digest(text, deps) {
    let hash; try { hash = await deps.hash(text); } catch { throw new ReleaseError("E_HASH_PROVIDER"); }
    need(typeof hash === "string" && HASH.test(hash), "E_HASH_PROVIDER"); return hash;
  }
  async function get(suffix, deps) {
    try { return unwrap(await deps.github.fetch({ url: API + suffix })); } catch { throw new ReleaseError("E_READ"); }
  }
  async function head(deps) {
    const ref = await get("/git/ref/heads/main", deps);
    need(ref.ref === "refs/heads/main" && ref.object?.type === "commit" && SHA.test(ref.object.sha || ""), "E_REF"); return ref.object.sha;
  }
  async function commit(sha, deps) {
    const value = await get(`/git/commits/${sha}`, deps);
    need(value.sha === sha && SHA.test(value.tree?.sha || "") && Array.isArray(value.parents), "E_COMMIT"); return value;
  }
  async function blob(sha, deps) {
    const url = `${API}/git/blobs/${sha}`; let raw;
    try { raw = await deps.github.fetch({ url }); } catch { throw new ReleaseError("E_READ"); }
    need(raw && raw.isError !== true, "E_BLOB");
    // Connected fetch returns already-decoded UTF-8 at this exact immutable URL.
    // Inspect it BEFORE unwrapping/parsing arbitrary source text or JSON content.
    const metadata = raw.structuredContent;
    if (metadata && typeof metadata.url === "string") {
      need(metadata.url === url && typeof metadata.content === "string", "E_BLOB");
      need(validText(metadata.content, 24 * 1024 * 1024), "E_BLOB"); return metadata.content;
    }
    const value = unwrap(raw);
    need(value.sha === sha && value.encoding === "base64", "E_BLOB");
    const text = utf8(base64Bytes(value.content)); need(validText(text, 24 * 1024 * 1024), "E_BLOB"); return text;
  }
  function treeRows(value, sha, recursive) {
    need(value.sha === sha && value.truncated === false && Array.isArray(value.tree) && value.tree.length <= 20000, "E_TREE");
    const seen = new Set();
    return ordered(value.tree.map(item => {
      need(typeof item.path === "string" && item.path.length > 0 && item.path.length <= 1024 && !item.path.split("/").some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part)) && (recursive || !item.path.includes("/")) && !seen.has(item.path) && SHA.test(item.sha || ""), "E_TREE");
      need((item.type === "tree" && item.mode === "040000") || (item.type === "blob" && ["100644", "100755", "120000"].includes(item.mode)) || (item.type === "commit" && item.mode === "160000"), "E_TREE");
      seen.add(item.path); return { path: item.path, mode: item.mode, type: item.type, sha: item.sha };
    }));
  }
  async function tree(sha, deps) {
    const rows = treeRows(await get(`/git/trees/${sha}?recursive=1`, deps), sha, true), map = new Map(rows.map(row => [row.path, row]));
    for (const row of rows) {
      const at = row.path.lastIndexOf("/"); if (at >= 0) need(map.get(row.path.slice(0, at))?.type === "tree", "E_TREE");
    }
    // Bind every intermediate tree OID to the same child entries as the flattened
    // response. This detects omissions, injected descendants and inconsistent OIDs.
    for (const directory of [{ path: "", sha }, ...rows.filter(row => row.type === "tree")]) {
      const prefix = directory.path ? directory.path + "/" : "";
      const children = ordered(rows.filter(row => row.path.startsWith(prefix) && !row.path.slice(prefix.length).includes("/")).map(row => ({ ...row, path: row.path.slice(prefix.length) })));
      const direct = treeRows(await get(`/git/trees/${directory.sha}`, deps), directory.sha, false);
      need(JSON.stringify(children) === JSON.stringify(direct), "E_TREE_CONSISTENCY");
    }
    return rows;
  }
  async function baseline(expectedHead, manifest, deps, requireCurrent = true) {
    if (requireCurrent) need(await head(deps) === expectedHead, "E_HEAD_CHANGED");
    const base = await commit(expectedHead, deps), rows = await tree(base.tree.sha, deps), files = new Map();
    for (const file of manifest) {
      const row = rows.find(item => item.path === file.path);
      if (row) {
        need(row.type === "blob" && row.mode === "100644", "E_FILE_MODE");
        const content = await blob(row.sha, deps); files.set(file.path, { sha: row.sha, hash: await digest(content, deps), content });
      }
      const parts = file.path.split("/"); parts.pop();
      while (parts.length) { const ancestor = rows.find(item => item.path === parts.join("/")); need(!ancestor || ancestor.type === "tree", "E_PATH_CONFLICT"); parts.pop(); }
    }
    if (requireCurrent) need(await head(deps) === expectedHead, "E_HEAD_CHANGED");
    return { treeSha: base.tree.sha, rows, files };
  }
  function scope(base, rows, manifest) {
    const leaves = new Map(base.rows.filter(row => row.type !== "tree").map(row => [row.path, row]));
    const directories = new Map(base.rows.filter(row => row.type === "tree").map(row => [row.path, row]));
    const changedPaths = new Set();
    for (const file of manifest) {
      if (leaves.get(file.path)?.sha !== file.blobSha) changedPaths.add(file.path);
      leaves.set(file.path, { path: file.path, mode: "100644", type: "blob", sha: file.blobSha });
      const parts = file.path.split("/"); parts.pop();
      while (parts.length) { if (!directories.has(parts.join("/"))) directories.set(parts.join("/"), null); parts.pop(); }
    }
    need(JSON.stringify(ordered([...leaves.values()])) === JSON.stringify(rows.filter(row => row.type !== "tree")), "E_TREE_SCOPE");
    const actual = rows.filter(row => row.type === "tree");
    need(actual.length === directories.size && actual.every(row => directories.has(row.path)), "E_TREE_SCOPE");
    for (const row of actual) {
      const before = directories.get(row.path);
      const changed = [...changedPaths].some(path => path.startsWith(row.path + "/"));
      if (before && !changed) need(before.sha === row.sha && before.mode === row.mode, "E_TREE_SCOPE");
    }
  }
  const RECORD_KEYS = ["version", "kind", "operationId", "repository", "branch", "publish", "expectedHead", "baseTreeSha", "manifest", "treeSha", "commitSha", "phase", "intent"];
  function validateRecord(record) {
    need(exact(record, RECORD_KEYS) && record.version === 2 && record.kind === "release" && validOperation(record.operationId) && record.repository === REPOSITORY && record.branch === BRANCH && record.publish === true && typeof record.expectedHead === "string" && SHA.test(record.expectedHead) && typeof record.baseTreeSha === "string" && SHA.test(record.baseTreeSha), "E_JOURNAL_RECORD");
    need(Array.isArray(record.manifest) && record.manifest.length > 0 && record.manifest.length <= 128, "E_JOURNAL_RECORD");
    let previous = "", missing = false;
    for (const file of record.manifest) {
      need(exact(file, ["path", "sha256", "blobSha"]) && validPath(file.path) && file.path > previous && typeof file.sha256 === "string" && HASH.test(file.sha256) && (file.blobSha === null || (typeof file.blobSha === "string" && SHA.test(file.blobSha))), "E_JOURNAL_RECORD");
      previous = file.path; missing ||= file.blobSha === null;
    }
    const position = ["blobs", "tree", "commit", "published"].indexOf(record.phase); need(position >= 0, "E_JOURNAL_RECORD");
    need(position === 0 || !missing, "E_JOURNAL_RECORD");
    need(position >= 1 ? typeof record.treeSha === "string" && SHA.test(record.treeSha) : record.treeSha === null, "E_JOURNAL_RECORD");
    need(position >= 2 ? typeof record.commitSha === "string" && SHA.test(record.commitSha) : record.commitSha === null, "E_JOURNAL_RECORD");
    if (record.intent !== null) {
      const next = record.phase === "blobs" ? missing ? "blob" : "tree" : record.phase === "tree" ? "commit" : record.phase === "commit" ? "ref" : null;
      need(next !== null && record.intent?.stage === next && (next === "blob" ? exact(record.intent, ["stage", "path"]) && record.intent.path === record.manifest.find(file => file.blobSha === null).path : exact(record.intent, ["stage"])), "E_JOURNAL_RECORD");
    }
    return record;
  }
  async function save(record, deps) {
    validateRecord(record);
    try { await deps.journal.save(record.operationId, clone(record)); } catch { throw new ReleaseError("E_JOURNAL_WRITE"); }
  }
  async function load(operationId, deps) {
    let raw; try { raw = await deps.journal.load(operationId); } catch { throw new ReleaseError("E_JOURNAL_READ"); }
    if (raw == null) return null;
    const record = validateRecord(clone(raw)); need(record.operationId === operationId, "E_JOURNAL_RECORD"); return record;
  }
  function result(status, context, code) {
    return { status, ...(code ? { code } : {}), ...(context.record ? { head: context.head || context.record.expectedHead, ...(context.record.commitSha ? { commit: context.record.commitSha } : {}) } : {}) };
  }
  async function verifyBlobReceipt(file, base, deps) {
    const content = await blob(file.blobSha, deps); need(await digest(content, deps) === file.sha256, "E_CANDIDATE_CHANGED");
    if (file.path === "data.enc.json") {
      validateEnvelope(content, true);
      const old = base.files.get(file.path); if (old && old.hash !== file.sha256) envelopeChange(old.content, content);
    }
  }
  async function verifyTreeReceipt(record, base, deps) { scope(base, await tree(record.treeSha, deps), record.manifest); }
  async function verifyCommitReceipt(record, deps) {
    const value = await commit(record.commitSha, deps);
    need(value.tree.sha === record.treeSha && value.parents.length === 1 && value.parents[0].sha === record.expectedHead && value.message === MESSAGE, "E_COMMIT_SCOPE");
  }
  async function verifyReceipts(record, base, deps) {
    for (const file of record.manifest) if (file.blobSha !== null) await verifyBlobReceipt(file, base, deps);
    if (record.treeSha) await verifyTreeReceipt(record, base, deps);
    if (record.commitSha) await verifyCommitReceipt(record, deps);
  }
  async function reconcileLocked(record, deps, context) {
    context.record = record; context.head = await head(deps);
    if (!record.commitSha || (record.intent !== null && record.intent.stage !== "ref")) return result("recovery_required", context, "E_OBJECT_OUTCOME_UNCERTAIN");
    const base = await baseline(record.expectedHead, record.manifest, deps, false);
    need(base.treeSha === record.baseTreeSha, "E_JOURNAL_BASELINE"); await verifyReceipts(record, base, deps);
    if (record.phase === "published") return result("published", context);
    if (context.head !== record.commitSha) return result("recovery_required", context, "E_REF_NOT_CONFIRMED");
    record.phase = "published"; record.intent = null; await save(record, deps); return result("published", context);
  }
  async function mutate(stage, args, record, deps, context, file) {
    record.intent = stage === "blob" ? { stage, path: file.path } : { stage }; await save(record, deps);
    context.uncertain = true; let value;
    try { value = unwrap(await deps.github[{ blob: "createBlob", tree: "createTree", commit: "createCommit" }[stage]](args)); }
    catch { throw new ReleaseError("E_MUTATION_UNCERTAIN"); }
    const oids = [value.sha, value[`${stage}_sha`]].filter(item => item !== undefined);
    need(oids.length > 0 && oids.every(item => item === oids[0]) && typeof oids[0] === "string" && SHA.test(oids[0]), "E_MUTATION_UNCERTAIN");
    if (stage === "blob") file.blobSha = oids[0];
    else { record[`${stage}Sha`] = oids[0]; record.phase = stage; }
    record.intent = null; await save(record, deps); context.uncertain = false;
  }
  async function publishLocked(request, deps, context) {
    let record = await load(request.operationId, deps);
    if (record) {
      context.record = record;
      need(record.expectedHead === request.expectedHead && JSON.stringify(record.manifest.map(({ path, sha256 }) => ({ path, sha256 }))) === JSON.stringify(request.files.map(({ path, sha256 }) => ({ path, sha256 }))), "E_OPERATION_REUSED");
      if (record.intent || record.phase === "published") return reconcileLocked(record, deps, context);
    }
    const base = await baseline(request.expectedHead, request.files, deps);
    const changed = request.files.filter(file => base.files.get(file.path)?.hash !== file.sha256);
    if (!changed.length) return { status: "unchanged", head: request.expectedHead };
    for (const file of changed) if (file.path === "data.enc.json" && base.files.has(file.path)) envelopeChange(base.files.get(file.path).content, file.content);
    if (!record) record = { version: 2, kind: "release", operationId: request.operationId, repository: REPOSITORY, branch: BRANCH, publish: true, expectedHead: request.expectedHead, baseTreeSha: base.treeSha,
      manifest: request.files.map(file => ({ path: file.path, sha256: file.sha256, blobSha: base.files.get(file.path)?.hash === file.sha256 ? base.files.get(file.path).sha : null })), treeSha: null, commitSha: null, phase: "blobs", intent: null };
    context.record = record; need(record.baseTreeSha === base.treeSha, "E_JOURNAL_BASELINE"); await verifyReceipts(record, base, deps);
    for (const file of record.manifest) if (file.blobSha === null) {
      need(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("blob", { repository_full_name: REPOSITORY, content: request.files.find(item => item.path === file.path).content, encoding: "utf-8" }, record, deps, context, file);
      await verifyBlobReceipt(file, base, deps);
    }
    if (!record.treeSha) {
      need(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("tree", { repository_full_name: REPOSITORY, base_tree_sha: record.baseTreeSha, tree_elements: record.manifest.filter(file => changed.some(item => item.path === file.path)).map(file => ({ path: file.path, mode: "100644", type: "blob", sha: file.blobSha })) }, record, deps, context);
      await verifyTreeReceipt(record, base, deps);
    }
    if (!record.commitSha) {
      need(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
      await mutate("commit", { repository_full_name: REPOSITORY, parent_sha: record.expectedHead, additional_parent_shas: [], tree_sha: record.treeSha, message: MESSAGE }, record, deps, context);
      await verifyCommitReceipt(record, deps);
    }
    need(await head(deps) === record.expectedHead, "E_HEAD_CHANGED");
    record.intent = { stage: "ref" }; await save(record, deps); context.uncertain = true;
    try { await deps.github.updateRef({ repository_full_name: REPOSITORY, branch_name: BRANCH, sha: record.commitSha, expected_sha: record.expectedHead, force: false }); } catch { /* Reconcile once; never replay. */ }
    const answer = await reconcileLocked(record, deps, context); if (answer.status === "published") context.uncertain = false; return answer;
  }
  async function publishRelease(input, deps) {
    const context = { record: null, uncertain: false };
    try {
      // Deep primitive snapshots precede the first await, including the manifest,
      // file objects, content and publish flag. Caller mutation cannot authorize IO.
      const request = snapshot(input); dependencies(deps, request.publish === true);
      for (const file of request.files) need(await digest(file.content, deps) === file.sha256, "E_VALIDATION_HASH");
      if (request.publish !== true) {
        const base = await baseline(request.expectedHead, request.files, deps);
        const changed = request.files.filter(file => base.files.get(file.path)?.hash !== file.sha256);
        for (const file of changed) if (file.path === "data.enc.json" && base.files.has(file.path)) envelopeChange(base.files.get(file.path).content, file.content);
        return { status: changed.length ? "dry_run" : "unchanged", head: request.expectedHead };
      }
      return await deps.journal.withLock(LOCK_KEY, () => publishLocked(request, deps, context));
    } catch (error) { return result(context.uncertain || context.record?.intent ? "recovery_required" : "blocked", context, error instanceof ReleaseError ? error.code : "E_ADAPTER"); }
  }
  async function reconcileRelease(operationId, deps) {
    const context = { record: null, uncertain: true };
    try {
      need(validOperation(operationId), "E_OPERATION_ID"); dependencies(deps, true);
      return await deps.journal.withLock(LOCK_KEY, async () => {
        const record = await load(operationId, deps); if (!record) return { status: "not_found" };
        return reconcileLocked(record, deps, context);
      });
    } catch (error) { return result("recovery_required", context, error instanceof ReleaseError ? error.code : "E_ADAPTER"); }
  }
  return { REPOSITORY, BRANCH, LOCK_KEY, MESSAGE, ReleaseError, validPath, validateEnvelope, validateRecord, publishRelease, reconcileRelease };
});
