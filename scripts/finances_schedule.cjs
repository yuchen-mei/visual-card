#!/usr/bin/env node
"use strict";

// Scheduling primitives only. No connector, shell command, credential storage,
// scheduler installation, daemon, commit, or push is implemented here.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ZONE = "America/Los_Angeles";
const RETRY_MS = 5 * 60 * 1000;
const ROOT = fs.realpathSync(path.join(__dirname, ".."));
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
class ScheduleError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new ScheduleError(code); }
function time(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) value = Date.parse(value);
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) fail("E_TIME");
  return value;
}
const iso = value => new Date(time(value)).toISOString();
function parts(value) {
  return Object.fromEntries(formatter.formatToParts(new Date(time(value))).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}
function dayString(p) { return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; }
function dayTime(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("E_DAY");
  const result = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== day) fail("E_DAY");
  return result;
}
function shiftDay(day, amount) { return new Date(dayTime(day) + amount * 86400000).toISOString().slice(0, 10); }
function dueForDay(day) {
  // Convert a local 20:00 with the IANA timezone, not a fixed UTC offset. This
  // local time is outside the DST transition's missing/repeated early hours.
  const target = dayTime(day) + 20 * 3600000;
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(guess);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += target - localAsUtc;
  }
  const p = parts(guess);
  if (dayString(p) !== day || p.hour !== 20 || p.minute !== 0 || p.second !== 0) fail("E_TIMEZONE");
  return iso(guess);
}
const keyForDay = day => `visual-card:${ZONE}:${day}`;
function latestDue(now) {
  const p = parts(now);
  const day = p.hour >= 20 ? dayString(p) : shiftDay(dayString(p), -1);
  return { day, idempotencyKey: keyForDay(day), dueAt: dueForDay(day) };
}
function firstAtOrAfter(value) {
  const day = dayString(parts(value));
  const candidate = dueForDay(day);
  return time(candidate) >= time(value) ? candidate : dueForDay(shiftDay(day, 1));
}
function exactKeys(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === names.slice().sort().join(",");
}
function newState(notBefore) {
  return { version: 1, timeZone: ZONE, notBefore: iso(notBefore), lastCompletedDay: null, pending: null, retry: null };
}
function validateState(state, notBefore) {
  if (!exactKeys(state, ["version", "timeZone", "notBefore", "lastCompletedDay", "pending", "retry"]) || state.version !== 1 || state.timeZone !== ZONE) fail("E_STATE");
  if (state.notBefore !== iso(notBefore)) fail("E_NOT_BEFORE_CHANGED");
  if (state.lastCompletedDay !== null) dayTime(state.lastCompletedDay);
  if (state.pending !== null && state.retry !== null) fail("E_STATE");
  for (const [name, extra] of [["pending", ["claimedAt", "pid"]], ["retry", ["nextAttemptAt", "reason"]]]) {
    const item = state[name];
    if (item === null) continue;
    if (!exactKeys(item, ["day", "idempotencyKey", "dueAt", ...extra]) || item.idempotencyKey !== keyForDay(item.day) || item.dueAt !== dueForDay(item.day) || time(item.dueAt) < time(notBefore)) fail("E_STATE");
    if (state.lastCompletedDay !== null && item.day <= state.lastCompletedDay) fail("E_STATE");
    if (name === "pending") {
      time(item.claimedAt);
      if (!Number.isSafeInteger(item.pid) || item.pid <= 0) fail("E_STATE");
    } else {
      time(item.nextAttemptAt);
      if (!["offline", "failed"].includes(item.reason)) fail("E_STATE");
    }
  }
  return state;
}

// Pure plan: dates/keys are schedule metadata only, never financial data.
function plan({ now, notBefore, state = newState(notBefore) }) {
  now = time(now); notBefore = time(notBefore);
  validateState(state, notBefore);
  if (state.pending) return { status: "recovery_required", ...state.pending };
  const due = latestDue(now);
  if (time(due.dueAt) < notBefore || now < notBefore) return { status: "not_due", nextAt: firstAtOrAfter(Math.max(now + 1, notBefore)) };
  if (state.lastCompletedDay !== null && due.day <= state.lastCompletedDay) return { status: "already_completed", nextAt: dueForDay(shiftDay(state.lastCompletedDay, 1)) };
  // An old offline/definitely failed job is replaced by the latest due day.
  if (state.retry?.day === due.day && now < time(state.retry.nextAttemptAt)) return { status: "waiting", ...due, nextAt: state.retry.nextAttemptAt };
  return { status: "due", ...due };
}

function location(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) fail("E_STATE_PATH");
  let parent;
  try { parent = fs.realpathSync(path.dirname(filename)); } catch { fail("E_STATE_PATH"); }
  const candidate = path.join(parent, path.basename(filename));
  if (candidate === ROOT || candidate.startsWith(ROOT + path.sep)) fail("E_STATE_PATH");
  const stat = fs.statSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail("E_STATE_DIRECTORY");
  return candidate;
}
function readState(filename, notBefore) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("E_STATE_READ");
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) fail("E_STATE_PERMISSIONS");
  let state;
  try { state = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { fail("E_STATE_READ"); }
  return validateState(state, notBefore);
}
function writeState(filename, state) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
    const parentFd = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
  } catch { fail("E_STATE_WRITE"); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

// A trusted integration must pass a real handler. A confirmed result must carry
// the exact supplied idempotency key. retryable+safeToRetry:true is permitted only
// when replay needs no recovery (no uncertain push, leftover commit, or pending
// mutation). Every exception or unrecognized result leaves the claim pending.
async function tick({ now, statePath, notBefore }, { isOnline, run, clock = Date.now } = {}) {
  now = time(now); notBefore = time(notBefore);
  if (typeof isOnline !== "function" || typeof run !== "function" || typeof clock !== "function") fail("E_HANDLER_REQUIRED");
  const finishedAt = () => Math.max(now, time(clock()));
  const filename = location(statePath);
  const lock = `${filename}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") return { status: "locked" };
    fail("E_LOCK");
  }
  try {
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, claimedAt: iso(now) }), { mode: 0o600, flag: "wx" });
    let state = readState(filename, notBefore);
    if (!state) { state = newState(notBefore); writeState(filename, state); }
    const decision = plan({ now, notBefore, state });
    if (decision.status !== "due") return decision;
    const due = { day: decision.day, idempotencyKey: decision.idempotencyKey, dueAt: decision.dueAt };
    let online = false;
    try { online = (await isOnline()) === true; } catch { /* Read-only probe failed; no job has started. */ }
    if (!online) {
      state.retry = { ...due, nextAttemptAt: iso(finishedAt() + RETRY_MS), reason: "offline" };
      writeState(filename, state);
      return { status: "offline", ...due, nextAt: state.retry.nextAttemptAt };
    }
    state.retry = null;
    state.pending = { ...due, claimedAt: iso(finishedAt()), pid: process.pid };
    writeState(filename, state); // Durable claim MUST precede invoking the job.
    let outcome;
    try { outcome = await run({ ...due, now: iso(now) }); }
    catch { return { status: "recovery_required", ...due }; }
    if (outcome?.idempotencyKey !== due.idempotencyKey) return { status: "recovery_required", ...due };
    if (outcome.status === "completed") {
      state.lastCompletedDay = due.day; state.pending = null;
      try { writeState(filename, state); } catch { return { status: "recovery_required", ...due }; }
      return { status: "completed", ...due, nextAt: dueForDay(shiftDay(due.day, 1)) };
    }
    if (outcome.status === "retryable" && outcome.safeToRetry === true) {
      try {
        const nextAttemptAt = iso(finishedAt() + RETRY_MS);
        state.pending = null;
        state.retry = { ...due, nextAttemptAt, reason: "failed" };
        writeState(filename, state);
      } catch { return { status: "recovery_required", ...due }; }
      return { status: "retry_scheduled", ...due, nextAt: state.retry.nextAttemptAt };
    }
    return { status: "recovery_required", ...due };
  } finally {
    // Never steal an existing lock or remove a crashed process's lock on startup.
    try { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); } catch {}
  }
}

function check({ now, notBefore, statePath }) {
  now = time(now); notBefore = time(notBefore);
  const filename = statePath ? location(statePath) : null;
  const state = filename ? readState(filename, notBefore) : null;
  const result = plan({ now, notBefore, state: state || newState(notBefore) });
  return { execution: "disabled", ...result, ...(filename && fs.existsSync(`${filename}.lock`) ? { lockPresent: true } : {}) };
}
function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("Usage: node scripts/finances_schedule.cjs --plan|--check --not-before ISO_TIMESTAMP [--now ISO_TIMESTAMP] [--state /private/state.json]\nRead-only planning only: no job runs, state writes, credentials, or scheduler installation. --check requires --state.\n");
    return;
  }
  const mode = args[0], options = { now: Date.now() };
  if (!["--plan", "--check"].includes(mode)) fail("E_ARGUMENTS");
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const name = { "--state": "statePath", "--not-before": "notBefore", "--now": "now" }[args[i]];
    if (!name || !args[i + 1] || seen.has(name)) fail("E_ARGUMENTS");
    seen.add(name); options[name] = args[i + 1];
  }
  if (!options.notBefore || (mode === "--check" && !options.statePath)) fail("E_ARGUMENTS");
  process.stdout.write(`${JSON.stringify(check(options))}\n`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof ScheduleError ? error.code : "E_SCHEDULE"}\n`); process.exitCode = 1; }
}
module.exports = { ZONE, RETRY_MS, ScheduleError, dueForDay, latestDue, keyForDay, newState, validateState, plan, tick, check };
