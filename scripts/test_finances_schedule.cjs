#!/usr/bin/env node
"use strict";

// Synthetic clocks, local temporary schedule metadata, and mocked handlers only.
// Never accesses Finances, credentials, portfolio data, Git, or OS scheduling.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { dueForDay, latestDue, keyForDay, newState, plan, tick, check, ScheduleError } = require("./finances_schedule.cjs");
const START = "2026-01-01T00:00:00Z";
const FIRST = "2026-10-18T03:00:00Z"; // October 17 at 20:00 in Los Angeles.
const tests = [];
const test = (name, run) => tests.push({ name, run });
const completed = job => ({ status: "completed", idempotencyKey: job.idempotencyKey });
const retryable = job => ({ status: "retryable", idempotencyKey: job.idempotencyKey, safeToRetry: true });
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "visual-card-schedule-test-")));
  const statePath = path.join(dir, "schedule.json");
  return {
    dir, statePath,
    call: (now = FIRST, deps = {}, extra = {}) => tick({ now, statePath, notBefore: START, ...extra }, { isOnline: () => true, run: completed, clock: () => new Date(now).getTime(), ...deps }),
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
async function withFixture(run) { const f = fixture(); try { await run(f); } finally { f.cleanup(); } }
const hasCode = code => error => error instanceof ScheduleError && error.code === code;

test("Los Angeles 20:00 boundary is exact and startup prevents backfill", () => {
  assert.equal(plan({ now: "2026-10-18T02:59:59Z", notBefore: "2026-10-18T02:00:00Z" }).status, "not_due");
  const result = plan({ now: FIRST, notBefore: FIRST });
  assert.equal(result.status, "due"); assert.equal(result.day, "2026-10-17");
  assert.equal(result.idempotencyKey, keyForDay("2026-10-17"));
  const after = plan({ now: "2026-10-18T04:00:00Z", notBefore: "2026-10-18T04:00:00Z" });
  assert.equal(after.status, "not_due"); assert.equal(after.nextAt, "2026-10-19T03:00:00.000Z");
});
test("DST spring and fall preserve local 20:00 across 23-hour and 25-hour days", () => {
  assert.equal(dueForDay("2026-03-07"), "2026-03-08T04:00:00.000Z");
  assert.equal(dueForDay("2026-03-08"), "2026-03-09T03:00:00.000Z");
  assert.equal(Date.parse(dueForDay("2026-03-08")) - Date.parse(dueForDay("2026-03-07")), 23 * 3600000);
  assert.equal(dueForDay("2026-10-31"), "2026-11-01T03:00:00.000Z");
  assert.equal(dueForDay("2026-11-01"), "2026-11-02T04:00:00.000Z");
  assert.equal(Date.parse(dueForDay("2026-11-01")) - Date.parse(dueForDay("2026-10-31")), 25 * 3600000);
});
test("latest due day uses local calendar boundaries across years and DST", () => {
  assert.equal(latestDue("2027-01-01T03:59:59Z").day, "2026-12-30");
  assert.equal(latestDue("2027-01-01T04:00:00Z").day, "2026-12-31");
  assert.equal(latestDue("2026-03-09T02:59:59Z").day, "2026-03-07");
  assert.equal(latestDue("2026-11-02T03:59:59Z").day, "2026-10-31");
});
test("offline waits five minutes without invoking a job or repeated network probes", () => withFixture(async f => {
  let probes = 0, jobs = 0;
  const deps = { isOnline: () => { probes++; return false; }, run: () => { jobs++; } };
  const result = await f.call(FIRST, deps);
  assert.equal(result.status, "offline"); assert.equal(result.nextAt, "2026-10-18T03:05:00.000Z");
  assert.equal((await f.call("2026-10-18T03:04:59Z", deps)).status, "waiting");
  assert.equal(probes, 1); assert.equal(jobs, 0);
  assert.equal((await f.call("2026-10-18T03:05:00Z", deps)).status, "offline");
  assert.equal(probes, 2); assert.equal(jobs, 0);
}));
test("return online at retry boundary runs once and repeated ticks are idempotent", () => withFixture(async f => {
  await f.call(FIRST, { isOnline: () => false });
  let runs = 0;
  const run = job => { runs++; return completed(job); };
  assert.equal((await f.call("2026-10-18T03:05:00Z", { run })).status, "completed");
  assert.equal((await f.call("2026-10-18T03:10:00Z", { run })).status, "already_completed");
  assert.equal(runs, 1); assert.equal(f.state().lastCompletedDay, "2026-10-17");
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600);
}));
test("network probe failure schedules a retry without claiming or running the job", () => withFixture(async f => {
  let runs = 0;
  const result = await f.call(FIRST, { isOnline: () => { throw new Error("synthetic network error"); }, run: () => { runs++; } });
  assert.equal(result.status, "offline"); assert.equal(runs, 0); assert.equal(f.state().pending, null);
  assert.equal(f.state().retry.reason, "offline");
}));
test("missed multiple days coalesce to only the latest due key", () => withFixture(async f => {
  await f.call(FIRST, { isOnline: () => false });
  const keys = [];
  await f.call("2026-10-22T03:01:00Z", { run: job => { keys.push(job.idempotencyKey); return completed(job); } });
  assert.deepEqual(keys, [keyForDay("2026-10-21")]);
  assert.equal(f.state().retry, null);
}));
test("explicit safe failure retries after five minutes using the same key", () => withFixture(async f => {
  const keys = [];
  const first = await f.call(FIRST, { run: job => { keys.push(job.idempotencyKey); return retryable(job); } });
  assert.equal(first.status, "retry_scheduled");
  assert.equal((await f.call("2026-10-18T03:04:59Z")).status, "waiting");
  await f.call("2026-10-18T03:05:00Z", { run: job => { keys.push(job.idempotencyKey); return completed(job); } });
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
}));
test("long failing job waits five minutes from failure time rather than start time", () => withFixture(async f => {
  let clock = Date.parse(FIRST), runs = 0;
  const result = await f.call(FIRST, { clock: () => clock, run: job => { runs++; clock += 6 * 60000; return retryable(job); } });
  assert.equal(result.nextAt, "2026-10-18T03:11:00.000Z");
  assert.equal((await f.call("2026-10-18T03:06:00Z", { run: () => { runs++; } })).status, "waiting");
  assert.equal(runs, 1);
}));
test("long offline probe waits five minutes from its result", () => withFixture(async f => {
  let clock = Date.parse(FIRST);
  const result = await f.call(FIRST, { clock: () => clock, isOnline: () => { clock += 6 * 60000; return false; } });
  assert.equal(result.nextAt, "2026-10-18T03:11:00.000Z");
  assert.equal((await f.call("2026-10-18T03:06:00Z")).status, "waiting");
}));
test("a newer due day replaces an old definitely failed job", () => withFixture(async f => {
  await f.call(FIRST, { run: retryable });
  const result = await f.call("2026-10-20T03:00:00Z");
  assert.equal(result.status, "completed"); assert.equal(result.day, "2026-10-19");
}));
for (const [label, handler] of [
  ["throw", () => { throw new Error("synthetic sensitive handler detail"); }],
  ["uncertain", job => ({ status: "uncertain", idempotencyKey: job.idempotencyKey })],
  ["unknown", () => undefined],
  ["key mismatch", () => ({ status: "completed", idempotencyKey: "wrong" })],
  ["unsafe retry", job => ({ status: "retryable", idempotencyKey: job.idempotencyKey })]
]) test(`${label} preserves pending and blocks replay even on a later day`, () => withFixture(async f => {
  const result = await f.call(FIRST, { run: handler });
  assert.equal(result.status, "recovery_required"); assert.equal(f.state().pending.day, "2026-10-17");
  let runs = 0;
  const later = await f.call("2026-10-23T03:00:00Z", { run: job => { runs++; return completed(job); } });
  assert.equal(later.status, "recovery_required"); assert.equal(later.day, "2026-10-17"); assert.equal(runs, 0);
}));
test("pending is durable before handler invocation and lock spans async execution", () => withFixture(async f => {
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const first = f.call(FIRST, { run: async job => {
    assert.equal(f.state().pending.idempotencyKey, job.idempotencyKey);
    const owner = JSON.parse(fs.readFileSync(`${f.statePath}.lock/owner.json`, "utf8"));
    assert.equal(owner.pid, process.pid); started();
    await new Promise(resolve => { release = resolve; });
    return completed(job);
  } });
  await startedPromise;
  assert.equal((await f.call()).status, "locked");
  release(); assert.equal((await first).status, "completed");
  assert.equal(fs.existsSync(`${f.statePath}.lock`), false);
}));
test("crashed process lock is not stolen or removed by another tick", () => withFixture(async f => {
  fs.mkdirSync(`${f.statePath}.lock`, { mode: 0o700 });
  fs.writeFileSync(`${f.statePath}.lock/owner.json`, JSON.stringify({ pid: 999999, claimedAt: FIRST }), { mode: 0o600 });
  assert.equal((await f.call()).status, "locked");
  assert.equal(fs.existsSync(`${f.statePath}.lock/owner.json`), true);
  assert.equal(fs.existsSync(f.statePath), false);
}));
test("notBefore persists and cannot silently be widened or reset", () => withFixture(async f => {
  await f.call(FIRST);
  await assert.rejects(f.call(FIRST, {}, { notBefore: "2025-01-01T00:00:00Z" }), hasCode("E_NOT_BEFORE_CHANGED"));
  await assert.rejects(f.call(FIRST, {}, { notBefore: undefined }), hasCode("E_TIME"));
}));
test("clock rollback cannot replay an earlier completed day", () => withFixture(async f => {
  await f.call("2026-10-23T03:00:00Z");
  let runs = 0;
  assert.equal((await f.call(FIRST, { run: () => { runs++; } })).status, "already_completed");
  assert.equal(runs, 0);
}));
test("a job crossing a later due time remains bound to its claimed day", () => withFixture(async f => {
  const first = await f.call(FIRST, { run: job => {
    assert.equal(plan({ now: "2026-10-20T03:00:00Z", notBefore: START, state: f.state() }).status, "recovery_required");
    return completed(job);
  } });
  assert.equal(first.day, "2026-10-17");
  assert.equal((await f.call("2026-10-20T03:00:00Z")).day, "2026-10-19");
}));
test("failed completion write leaves durable pending instead of repeating the handler", () => withFixture(async f => {
  const originalRename = fs.renameSync;
  try {
    const result = await f.call(FIRST, { run: job => {
      fs.renameSync = (source, target) => { if (target === f.statePath) throw new Error("synthetic write failure"); return originalRename(source, target); };
      return completed(job);
    } });
    assert.equal(result.status, "recovery_required"); assert.ok(f.state().pending);
  } finally { fs.renameSync = originalRename; }
  let runs = 0;
  assert.equal((await f.call(FIRST, { run: () => { runs++; } })).status, "recovery_required");
  assert.equal(runs, 0);
}));
test("invalid or insecure state fails closed", () => withFixture(async f => {
  fs.writeFileSync(f.statePath, "not json", { mode: 0o600 });
  await assert.rejects(f.call(), hasCode("E_STATE_READ"));
  fs.writeFileSync(f.statePath, JSON.stringify(newState(START))); fs.chmodSync(f.statePath, 0o644);
  await assert.rejects(f.call(), hasCode("E_STATE_PERMISSIONS"));
  fs.unlinkSync(f.statePath);
  const other = path.join(f.dir, "other.json"); fs.writeFileSync(other, JSON.stringify(newState(START)), { mode: 0o600 });
  fs.symlinkSync(other, f.statePath);
  await assert.rejects(f.call(), hasCode("E_STATE_PERMISSIONS"));
}));
test("planning/check CLI never writes state, acquires a lock, or invokes any job", () => withFixture(async f => {
  const result = check({ now: FIRST, notBefore: START, statePath: f.statePath });
  assert.equal(result.execution, "disabled"); assert.equal(result.status, "due");
  const script = path.join(__dirname, "finances_schedule.cjs");
  const cli = spawnSync(process.execPath, [script, "--check", "--state", f.statePath, "--not-before", START, "--now", FIRST], { encoding: "utf8" });
  assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).execution, "disabled");
  assert.equal(fs.existsSync(f.statePath), false); assert.equal(fs.existsSync(`${f.statePath}.lock`), false);
  const prohibited = spawnSync(process.execPath, [script, "--once", "--publish"], { encoding: "utf8" });
  assert.equal(prohibited.status, 1); assert.equal(prohibited.stderr.trim(), "E_ARGUMENTS");
}));

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures++; process.stderr.write(`FAIL ${name}: ${error instanceof ScheduleError ? error.code : error.message}\n`); }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} synthetic schedule tests passed.\n`);
  process.exitCode = failures ? 1 : 0;
})();
