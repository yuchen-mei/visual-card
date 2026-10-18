#!/usr/bin/env node
"use strict";

// Synthetic repository state and mocked child processes only. No network,
// credentials, financial data, actual commits, or actual pushes are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { ORIGIN, RunnerError, parseArgs, validateEnvelope, runUpdate } = require("./run_finances_update.cjs");

function envelope(seed = 1) {
  return Buffer.from(`${JSON.stringify({ version: 1, kdf: "PBKDF2-SHA256", iterations: 250000, cipher: "AES-GCM",
    salt: Buffer.alloc(16, seed).toString("base64"), iv: Buffer.alloc(12, seed).toString("base64"),
    ciphertext: Buffer.alloc(32, seed).toString("base64") })}\n`);
}

function fixture(settings = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "visual-card-runner-test-")));
  const repo = path.join(temporary, "repo");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, ".git"));
  const dataPath = path.join(repo, "data.enc.json");
  fs.writeFileSync(dataPath, envelope());
  const input = path.join(temporary, "snapshot.json");
  fs.writeFileSync(input, "{}", { mode: 0o600 });
  const policy = path.join(temporary, "policy.json");
  fs.writeFileSync(policy, "{}", { mode: 0o600 });
  const passwordFile = path.join(temporary, "synthetic-password");
  fs.writeFileSync(passwordFile, "synthetic-fixture-only", { mode: 0o600 });
  const passwordFd = fs.openSync(passwordFile, "r");
  const calls = [];
  let changed = false;
  let staged = false;
  let committed = false;
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const spawnSync = (binary, originalArgs, options) => {
    calls.push({ binary, args: originalArgs, options });
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const bad = () => ({ status: 1, stdout: "private output must stay hidden", stderr: "private error must stay hidden" });
    if (binary === process.execPath) {
      if (path.basename(originalArgs[0]).startsWith("test_")) {
        assert.equal(options.stdio.length, 3, "tests must not receive password descriptor");
        return settings.testsFail ? bad() : ok("synthetic tests passed");
      }
      assert.equal(path.basename(originalArgs[0]), "update_finances.cjs");
      assert.equal(options.stdio[passwordFd], passwordFd, "updater must receive password descriptor");
      assert.equal(originalArgs[originalArgs.indexOf("--policy") + 1], policy, "updater must receive private policy");
      if (settings.externalWriteOnFailure) { fs.writeFileSync(dataPath, envelope(3)); return bad(); }
      if (settings.updateFail) return bad();
      const status = settings.status || (originalArgs.includes("--write") ? "changed" : "validated");
      if ((status === "changed" && !settings.malformedStatus) || settings.unexpectedWrite) {
        fs.writeFileSync(dataPath, settings.invalidEnvelope ? "{\"plaintext\":\"synthetic\"}" : envelope(2));
        changed = true;
      }
      const result = { status };
      if (status === "changed") result.encryptedSha256 = createHash("sha256").update(fs.readFileSync(dataPath)).digest("hex");
      if (settings.externalWriteAfterValidation) fs.writeFileSync(dataPath, envelope(3));
      return ok(settings.silent ? "" : settings.malformedStatus ? "not json" : JSON.stringify(result));
    }
    assert.equal(binary, "git");
    assert.equal(options.stdio.length, 3, "git must not receive password descriptor");
    let args = originalArgs.slice();
    while (args[0] === "-c") args = args.slice(2);
    const joined = args.join(" ");
    if (joined === "rev-parse --show-toplevel") return ok(repo);
    if (joined === "rev-parse --git-common-dir") return ok(".git");
    if (joined === "symbolic-ref --quiet --short HEAD") return ok(settings.branch || "main");
    if (args[0] === "remote") return ok(settings.wrongOrigin ? "https://example.invalid/another.git" : ORIGIN);
    if (args[0] === "config") return settings.mirror ? ok("true") : { status: 1, stdout: "", stderr: "" };
    if (args[0] === "status") {
      if (settings.dirty) return ok("?? untracked.txt");
      if (settings.extraChange && changed && !committed) return ok(" M data.enc.json\n?? unexpected.txt");
      if (committed) return ok();
      return ok(changed ? `${staged ? "M " : " M"} data.enc.json` : "");
    }
    if (args[0] === "fetch") return settings.fetchFail ? bad() : ok();
    if (args[0] === "merge-base") return settings.localCommits ? bad() : ok();
    if (args[0] === "merge") return settings.ffFail ? bad() : ok();
    if (joined === "rev-parse HEAD") return ok(committed ? head : base);
    if (joined === `rev-parse ${head}^`) return ok(base);
    if (args[0] === "ls-files") return ok(`100644 ${base} 0\tdata.enc.json`);
    if (joined === "diff --cached --name-only") return ok(staged && !committed ? "data.enc.json" : "");
    if (joined === "diff --name-only") return ok();
    if (args[0] === "add") { staged = true; return ok(); }
    if (args[0] === "show") return ok(settings.stagedMismatch && !committed ? envelope(3).toString("utf8") : fs.readFileSync(dataPath, "utf8"));
    if (args[0] === "commit") { if (settings.commitFail) return bad(); committed = true; return ok(); }
    if (args[0] === "diff-tree") return ok(settings.extraCommittedFile ? "data.enc.json\nprivate.json" : "data.enc.json");
    if (args[0] === "push") return settings.pushRace ? bad() : ok();
    throw new Error(`Unhandled synthetic git command: ${joined}`);
  };
  return {
    repo, input, policy, dataPath, calls,
    run: (options = {}) => runUpdate({ input, policy, publish: false, ...options }, { repo, spawnSync, env: { VISUAL_CARD_PASSWORD_FD: String(passwordFd) } }),
    cleanup: () => { fs.closeSync(passwordFd); fs.rmSync(temporary, { recursive: true, force: true }); },
    lock: path.join(repo, ".git", "visual-card-finances-update.lock")
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
function withFixture(settings, run) { const f = fixture(settings); try { run(f); } finally { f.cleanup(); } }
function fails(code, operation) {
  assert.throws(operation, (error) => error instanceof RunnerError && error.message === code && error.code === code);
}
const operationCalled = (f, name) => f.calls.some(({ binary, args }) => binary === "git" && args.includes(name));

test("arguments default to validation and reject ambiguous flags", () => {
  assert.deepEqual(parseArgs(["--input", "/private/input.json", "--policy", "/private/policy.json"]), { input: "/private/input.json", policy: "/private/policy.json", publish: false });
  assert.equal(parseArgs(["--input", "/private/input.json", "--policy", "/private/policy.json", "--publish"]).publish, true);
  assert.equal(parseArgs(["--help"]).help, true);
  for (const args of [[], ["--write"], ["--input", "a", "--publish", "--publish"]]) fails("E_ARGUMENTS", () => parseArgs(args));
});
test("envelope gate rejects plaintext, unexpected fields, and weak parameters", () => {
  validateEnvelope(envelope());
  for (const patch of [{ plaintext: "synthetic" }, { iterations: 1 }, { salt: "invalid!" }, { iv: "" }, { cipher: "none" }]) {
    fails("E_ENVELOPE", () => validateEnvelope(Buffer.from(JSON.stringify({ ...JSON.parse(envelope()), ...patch }))));
  }
});
test("dry-run fetches main and tests before validation without writing or publishing", () => withFixture({}, (f) => {
  assert.deepEqual(f.run(), { status: "validated" });
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope()));
  assert.deepEqual(f.calls.filter(({ binary, args }) => binary === process.execPath && path.basename(args[0]).startsWith("test_")).map(({ args }) => path.basename(args[0])), [
    "test_cash_normalization.cjs", "test_snapshot_display.cjs",
    "test_finances_update.cjs", "test_asset_update.cjs", "test_basis_revision.cjs",
    "test_finances_source.cjs", "test_finances_daily.cjs", "test_finances_orchestrator.cjs",
    "test_finances_github.cjs", "test_finances_release.cjs", "test_finances_journal.cjs",
    "test_finances_schedule.cjs", "test_finances_schedule_bridge.cjs",
    "test_finances_tool_runtime.cjs", "test_finances_runner.cjs"
  ]);
  assert.ok(operationCalled(f, "fetch"));
  assert.ok(!operationCalled(f, "add"));
  assert.ok(!operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
  assert.ok(!fs.existsSync(f.lock));
}));
test("validated changed publication stages and commits only ciphertext then pushes exact main", () => withFixture({}, (f) => {
  assert.deepEqual(f.run({ publish: true }), { status: "published" });
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  const add = f.calls.find(({ args }) => args[0] === "add");
  assert.deepEqual(add.args, ["add", "--", "data.enc.json"]);
  const push = f.calls.find(({ args }) => args.includes("push"));
  assert.deepEqual(push.args.slice(-2), ["origin", `${"b".repeat(40)}:refs/heads/main`]);
  assert.ok(push.args.includes("--no-follow-tags"));
  assert.ok(push.args.includes("--recurse-submodules=no"));
  assert.ok(!push.args.includes("--force"));
  assert.ok(!fs.existsSync(f.lock));
}));
test("unchanged publication skips all writes, staging, commits, and pushes", () => withFixture({ status: "unchanged" }, (f) => {
  assert.deepEqual(f.run({ publish: true }), { status: "unchanged" });
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope()));
  assert.ok(!operationCalled(f, "add"));
  assert.ok(!operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
}));
test("silent exit-zero is unchanged only when ciphertext is unchanged", () => withFixture({ status: "unchanged", silent: true }, (f) => {
  assert.deepEqual(f.run({ publish: true }), { status: "unchanged" });
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope()));
  assert.ok(!operationCalled(f, "commit"));
}));
test("silent exit-zero after a write fails and preserves uncertain outcome for recovery", () => withFixture({ silent: true }, (f) => {
  fails("E_UNEXPECTED_WRITE_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  assert.ok(!operationCalled(f, "commit"));
}));
for (const [setting, code] of [
  [{ dirty: true }, "E_DIRTY_REPOSITORY"], [{ branch: "feature" }, "E_MAIN_REQUIRED"],
  [{ wrongOrigin: true }, "E_ORIGIN"], [{ mirror: true }, "E_ORIGIN"],
  [{ fetchFail: true }, "E_FETCH"], [{ localCommits: true }, "E_LOCAL_COMMITS"],
  [{ ffFail: true }, "E_FAST_FORWARD"], [{ testsFail: true }, "E_TESTS"],
  [{ updateFail: true }, "E_UPDATE"], [{ malformedStatus: true }, "E_UPDATER_STATUS"],
  [{ invalidEnvelope: true }, "E_ENVELOPE"], [{ extraChange: true }, "E_UNEXPECTED_CHANGES"]
]) test(`${code} fails closed with original data and no publication`, () => withFixture(setting, (f) => {
  fails(code, () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope()));
  assert.ok(!operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
  assert.ok(!fs.existsSync(f.lock));
}));
test("unexpected dry-run writes with unknown ownership require recovery", () => withFixture({ unexpectedWrite: true }, (f) => {
  fails("E_UNEXPECTED_WRITE_RECOVERY_REQUIRED", () => f.run());
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  assert.ok(!operationCalled(f, "commit"));
}));
test("failed updater never overwrites an external concurrent update", () => withFixture({ externalWriteOnFailure: true }, (f) => {
  fails("E_UPDATE_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(3)));
  assert.ok(!operationCalled(f, "commit"));
}));
test("candidate hash mismatch preserves external update and prevents publication", () => withFixture({ externalWriteAfterValidation: true }, (f) => {
  fails("E_UPDATE_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(3)));
  assert.ok(!operationCalled(f, "commit"));
}));
test("shared Git lock blocks overlapping runs and is not removed by the blocked run", () => withFixture({}, (f) => {
  fs.mkdirSync(f.lock);
  fails("E_LOCKED", () => f.run());
  assert.ok(fs.existsSync(f.lock));
  assert.ok(!operationCalled(f, "fetch"));
}));
test("non-private and in-repository snapshots are rejected", () => withFixture({}, (f) => {
  fs.chmodSync(f.input, 0o644);
  fails("E_PRIVATE_INPUT", () => f.run());
  const local = path.join(f.repo, "private.json");
  fs.writeFileSync(local, "{}", { mode: 0o600 });
  fails("E_PRIVATE_INPUT", () => f.run({ input: local }));
  assert.ok(!operationCalled(f, "fetch"));
}));
test("non-private policies are rejected before fetching", () => withFixture({}, (f) => {
  fs.chmodSync(f.policy, 0o644);
  fails("E_PRIVATE_INPUT", () => f.run());
  assert.ok(!operationCalled(f, "fetch"));
}));
test("push race preserves validated local commit and never forces, rebases, or resets", () => withFixture({ pushRace: true }, (f) => {
  fails("E_PUSH_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(operationCalled(f, "commit"));
  assert.equal(f.calls.filter(({ args }) => args.includes("push")).length, 1);
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  for (const command of ["--force", "rebase", "reset"]) assert.ok(!operationCalled(f, command));
  assert.ok(!fs.existsSync(f.lock));
}));
test("mismatching staged bytes block commit and preserve validated candidate for recovery", () => withFixture({ stagedMismatch: true }, (f) => {
  fails("E_STAGE_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  assert.ok(!operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
}));
test("failed or uncertain commit never pushes or blindly rolls back the validated candidate", () => withFixture({ commitFail: true }, (f) => {
  fails("E_COMMIT_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(fs.readFileSync(f.dataPath).equals(envelope(2)));
  assert.ok(operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
}));
test("unexpected committed files block push and retain commit for manual recovery", () => withFixture({ extraCommittedFile: true }, (f) => {
  fails("E_COMMIT_RECOVERY_REQUIRED", () => f.run({ publish: true }));
  assert.ok(operationCalled(f, "commit"));
  assert.ok(!operationCalled(f, "push"));
}));

let failures = 0;
for (const { name, run } of tests) {
  try { run(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failures++; process.stderr.write(`FAIL ${name}: ${error instanceof RunnerError ? error.code : error.message}\n`); }
}
process.stdout.write(`${tests.length - failures}/${tests.length} synthetic runner tests passed.\n`);
process.exitCode = failures ? 1 : 0;
