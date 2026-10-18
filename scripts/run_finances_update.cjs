#!/usr/bin/env node
"use strict";

// This entry point never fetches financial data or obtains credentials. A complete,
// private Finances snapshot and an already-open password descriptor are required.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomBytes, createHash } = require("node:crypto");

const ORIGIN = "https://github.com/yuchen-mei/visual-card.git";
const DATA_FILE = "data.enc.json";
const MAX_ENVELOPE_BYTES = 24 * 1024 * 1024;
// Self-contained synthetic Node suites. Native deployment checks need a separate
// test-only signed helper and are documented in docs/finances-update.md.
const VALIDATION_TESTS = Object.freeze([
  "test_cash_normalization.cjs", "test_security_holdings.cjs", "test_snapshot_display.cjs",
  "test_finances_update.cjs", "test_asset_update.cjs", "test_basis_revision.cjs",
  "test_finances_source.cjs", "test_finances_daily.cjs", "test_finances_orchestrator.cjs",
  "test_finances_github.cjs", "test_finances_release.cjs", "test_finances_journal.cjs",
  "test_finances_schedule.cjs", "test_finances_schedule_bridge.cjs",
  "test_finances_tool_runtime.cjs", "test_finances_runner.cjs"
]);
const HELP = "Usage: node scripts/run_finances_update.cjs --input /private/snapshot.json --policy /private/policy.json [--publish]\n" +
  "Default: fetch and fast-forward main, run tests, then validate without writing.\n" +
  "--publish: write, commit and push only validated, changed encrypted data.\n" +
  "Provide the existing password through an inherited open descriptor >=3 named by VISUAL_CARD_PASSWORD_FD.\n" +
  "Input and policy must be private regular files outside the repository. No dependencies are installed.\n";

class RunnerError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new RunnerError(code); };

function parseArgs(args) {
  const result = { publish: false };
  if (args.length === 1 && args[0] === "--help") return { help: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--publish" && !result.publish) result.publish = true;
    else if (args[i] === "--input" && !result.input && args[i + 1] && !args[i + 1].startsWith("--")) result.input = args[++i];
    else if (args[i] === "--policy" && !result.policy && args[i + 1] && !args[i + 1].startsWith("--")) result.policy = args[++i];
    else fail("E_ARGUMENTS");
  }
  if (!result.input || !result.policy) fail("E_ARGUMENTS");
  return result;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ENVELOPE_BYTES) fail("E_ENVELOPE");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { fail("E_ENVELOPE"); }
  if (!envelope || Array.isArray(envelope) || typeof envelope !== "object" ||
      Object.keys(envelope).sort().join(",") !== "cipher,ciphertext,iterations,iv,kdf,salt,version" ||
      envelope.version !== 1 || envelope.kdf !== "PBKDF2-SHA256" || envelope.cipher !== "AES-GCM" ||
      !Number.isSafeInteger(envelope.iterations) || envelope.iterations < 250000 || envelope.iterations > 1000000) fail("E_ENVELOPE");
  for (const key of ["salt", "iv", "ciphertext"]) {
    const value = envelope[key];
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("E_ENVELOPE");
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value ||
        (key === "salt" && decoded.length !== 16) ||
        (key === "iv" && decoded.length !== 12) ||
        (key === "ciphertext" && decoded.length < 16)) fail("E_ENVELOPE");
  }
  return envelope;
}

function runUpdate(options, dependencies = {}) {
  const repo = fs.realpathSync(dependencies.repo || path.join(__dirname, ".."));
  const invoke = dependencies.spawnSync || spawnSync;
  const env = dependencies.env || process.env;
  const passwordFd = Number(env.VISUAL_CARD_PASSWORD_FD);
  if (!/^\d+$/.test(env.VISUAL_CARD_PASSWORD_FD || "") || !Number.isSafeInteger(passwordFd) || passwordFd < 3 || passwordFd > 1024) fail("E_PASSWORD_FD");
  try { fs.fstatSync(passwordFd); } catch { fail("E_PASSWORD_FD"); }

  function privateFile(filename) {
    try {
      const real = fs.realpathSync(filename);
      const stat = fs.statSync(real);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024 || containsPath(repo, real)) fail("E_PRIVATE_INPUT");
      return real;
    } catch { fail("E_PRIVATE_INPUT"); }
  }
  const input = privateFile(options.input);
  const policy = privateFile(options.policy);

  function command(binary, args, errorCode, { passPassword = false, allowFailure = false } = {}) {
    const stdio = ["ignore", "pipe", "pipe"];
    if (passPassword) {
      while (stdio.length <= passwordFd) stdio.push("ignore");
      stdio[passwordFd] = passwordFd;
    }
    let result;
    try {
      result = invoke(binary, args, {
        cwd: repo, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdio, windowsHide: true
      });
    } catch { fail(errorCode); }
    if (result.error || result.signal || (result.status !== 0 && !allowFailure)) fail(errorCode);
    return { status: result.status, output: (result.stdout || "").trim() };
  }
  const git = (args, code = "E_GIT", extra) => command("git", args, code, extra);
  const clean = () => {
    if (git(["status", "--porcelain=v1", "--untracked-files=all"]).output) fail("E_DIRTY_REPOSITORY");
  };
  const canonicalOrigin = () => {
    for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
      if (git(args, "E_ORIGIN").output !== ORIGIN) fail("E_ORIGIN");
    }
    const mirror = git(["config", "--bool", "--get", "remote.origin.mirror"], "E_ORIGIN", { allowFailure: true });
    if (!((mirror.status === 1 && !mirror.output) || (mirror.status === 0 && mirror.output === "false"))) fail("E_ORIGIN");
  };
  if (git(["rev-parse", "--show-toplevel"], "E_REPOSITORY").output !== repo) fail("E_REPOSITORY");
  const common = fs.realpathSync(path.resolve(repo, git(["rev-parse", "--git-common-dir"], "E_REPOSITORY").output));
  if (containsPath(common, input) || containsPath(common, policy)) fail("E_PRIVATE_INPUT");
  const lock = path.join(common, "visual-card-finances-update.lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) { fail(error.code === "EEXIST" ? "E_LOCKED" : "E_LOCK"); }

  let original;
  let rollbackCandidateHash;
  let committed = false;
  const dataPath = path.join(repo, DATA_FILE);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  function restoreOriginal() {
    if (!rollbackCandidateHash || !original) return;
    // Never roll back an external writer's update or an uncertain child outcome.
    if (digest(fs.readFileSync(dataPath)) !== rollbackCandidateHash) fail("E_RESTORE_RECOVERY_REQUIRED");
    const temporary = path.join(repo, `.data.enc.rollback-${randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temporary, original, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, dataPath);
    } catch { fail("E_RESTORE_RECOVERY_REQUIRED"); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  try {
    if (git(["symbolic-ref", "--quiet", "--short", "HEAD"], "E_MAIN_REQUIRED").output !== "main") fail("E_MAIN_REQUIRED");
    canonicalOrigin();
    clean();
    git(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], "E_FETCH");
    git(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], "E_LOCAL_COMMITS");
    git(["merge", "--ff-only", "refs/remotes/origin/main"], "E_FAST_FORWARD");
    clean();
    const baseHead = git(["rev-parse", "HEAD"]).output;
    if (!/^[a-f0-9]{40,64}$/.test(baseHead)) fail("E_REPOSITORY");
    if (!/^100644 [a-f0-9]{40,64} 0\tdata\.enc\.json$/.test(git(["ls-files", "--stage", "--", DATA_FILE]).output)) fail("E_DATA_TRACKING");
    if (!fs.lstatSync(dataPath).isFile()) fail("E_ENVELOPE");
    original = fs.readFileSync(dataPath);
    const oldEnvelope = validateEnvelope(original);
    for (const test of VALIDATION_TESTS) {
      command(process.execPath, [path.join(repo, "scripts", test)], "E_TESTS");
    }
    clean();
    const args = [path.join(repo, "scripts", "update_finances.cjs"), "--input", input, "--policy", policy];
    if (options.publish) args.push("--write");
    let update;
    try { update = command(process.execPath, args, "E_UPDATE", { passPassword: true }); }
    catch (error) {
      if (!fs.readFileSync(dataPath).equals(original)) fail("E_UPDATE_RECOVERY_REQUIRED");
      throw error;
    }
    let result;
    function invalidStatus() { fail(fs.readFileSync(dataPath).equals(original) ? "E_UPDATER_STATUS" : "E_UPDATE_RECOVERY_REQUIRED"); }
    try { result = update.output === "" ? { status: "unchanged" } : JSON.parse(update.output); } catch { invalidStatus(); }
    if (!result || typeof result !== "object" || !["validated", "changed", "unchanged"].includes(result.status)) invalidStatus();
    if (result.status === "changed") {
      if (!/^[a-f0-9]{64}$/.test(result.encryptedSha256 || "") || digest(fs.readFileSync(dataPath)) !== result.encryptedSha256) fail("E_UPDATE_RECOVERY_REQUIRED");
      rollbackCandidateHash = result.encryptedSha256;
    }
    if (!options.publish || result.status === "unchanged") {
      if (!fs.readFileSync(dataPath).equals(original)) fail("E_UNEXPECTED_WRITE_RECOVERY_REQUIRED");
      clean();
      if (result.status === "changed") fail("E_UPDATER_STATUS");
      rollbackCandidateHash = undefined;
      return { status: result.status };
    }
    if (result.status !== "changed") fail("E_UPDATER_STATUS");
    const updated = fs.readFileSync(dataPath);
    const envelope = validateEnvelope(updated);
    if (updated.equals(original) || ["version", "kdf", "cipher", "iterations"].some((key) => envelope[key] !== oldEnvelope[key]) ||
        envelope.salt === oldEnvelope.salt || envelope.iv === oldEnvelope.iv || envelope.ciphertext === oldEnvelope.ciphertext) fail("E_ENVELOPE_CHANGE");
    if (git(["status", "--porcelain=v1", "--untracked-files=all"]).output !== `M ${DATA_FILE}` ||
        git(["diff", "--cached", "--name-only"]).output) fail("E_UNEXPECTED_CHANGES");
    if (git(["rev-parse", "HEAD"]).output !== baseHead) fail("E_HEAD_CHANGED");
    rollbackCandidateHash = undefined;
    git(["add", "--", DATA_FILE], "E_STAGE_RECOVERY_REQUIRED");
    if (git(["diff", "--cached", "--name-only"]).output !== DATA_FILE ||
        git(["diff", "--name-only"]).output) fail("E_STAGE_RECOVERY_REQUIRED");
    const staged = git(["show", `:${DATA_FILE}`], "E_STAGE_RECOVERY_REQUIRED").output;
    if (staged !== updated.toString("utf8").trim()) fail("E_STAGE_RECOVERY_REQUIRED");
    canonicalOrigin();
    git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--only", "-m", "Update encrypted portfolio data", "--", DATA_FILE], "E_COMMIT_RECOVERY_REQUIRED");
    committed = true;
    const publishedCommit = git(["rev-parse", "HEAD"]).output;
    if (!/^[a-f0-9]{40,64}$/.test(publishedCommit) ||
        git(["rev-parse", `${publishedCommit}^`]).output !== baseHead ||
        git(["diff-tree", "--no-commit-id", "--name-only", "-r", publishedCommit]).output !== DATA_FILE ||
        git(["show", `${publishedCommit}:${DATA_FILE}`]).output !== updated.toString("utf8").trim()) fail("E_COMMIT_RECOVERY_REQUIRED");
    clean();
    canonicalOrigin();
    // Pin the verified commit so a concurrent local HEAD move cannot change what
    // is published. Explicit flags prevent user Git config from pushing tags or
    // submodules alongside this single authorized main update.
    git(["-c", "core.hooksPath=/dev/null", "push", "--no-follow-tags", "--recurse-submodules=no", "origin", `${publishedCommit}:refs/heads/main`], "E_PUSH_RECOVERY_REQUIRED");
    return { status: "published" };
  } catch (error) {
    if (!committed) restoreOriginal();
    else if (!(error instanceof RunnerError) || error.code !== "E_PUSH_RECOVERY_REQUIRED") fail("E_COMMIT_RECOVERY_REQUIRED");
    throw error;
  } finally {
    try { fs.rmdirSync(lock); } catch { /* A stale empty lock fails closed on the next run. */ }
  }
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const result = runUpdate(options);
      // Scheduled no-change runs are silent. All emitted fields are fixed strings.
      if (result.status !== "unchanged") process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof RunnerError ? error.code : "E_RUNNER"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { ORIGIN, HELP, VALIDATION_TESTS, RunnerError, parseArgs, validateEnvelope, runUpdate };
