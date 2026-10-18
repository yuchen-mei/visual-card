# Schedule bridge

`node scripts/finances_schedule_bridge.cjs --state /private/schedule.json --not-before ISO_TIMESTAMP`

The parent directory must be owned by the current user, mode 0700, and outside Git. The activation timestamp is persistent: later calls must use the same value. The CLI uses the real clock; it accepts no clock override, publication switch, credential or command. Running it installs no local or cloud schedule.

Each invocation performs one existing schedule `tick`. Execution of this program means only that this Mac is online. At a due Los Angeles 20:00 boundary (including a later startup), it durably records pending and holds the schedule lock while emitting:

```json
{"status":"run_requested","idempotencyKey":"visual-card:America/Los_Angeles:YYYY-MM-DD","operationId":"visual-card-daily-YYYY-MM-DD","day":"YYYY-MM-DD","dueAt":"ISO_TIMESTAMP"}
```

Use the supplied `operationId` for the fixed runtime's operation and preserve `idempotencyKey` in the bridge response. Write one canonical JSON line using `JSON.stringify(value) + "\n"`:

- Confirmed publication or verified no change: `{status:"completed",idempotencyKey,outcome:"published"}` or outcome `"unchanged"`.
- A failure proven safe to retry, with no uncertain publication: `{status:"retryable",idempotencyKey,safeToRetry:true}`. An optional uppercase fixed `code` is allowed. Retry occurs at the next invocation at least five minutes after the result, with the same operation ID; a later due day replaces a definitely failed earlier day.
- Uncertain or nonretryable result: `{status:"failure",idempotencyKey}` or status `"recovery_required"`, optionally with a fixed uppercase `code`. Pending remains; later ticks must reconcile the original operation rather than replay it.

`dry_run` or `validated` is never a completion outcome. EOF, malformed input, wrong keys, timeout (15 minutes), or an unknown result preserve pending. A crashed process also leaves its lock; the bridge never steals a stale lock. Recovery must first determine the original operation's actual outcome.

Final output has `type:"final"`, a fixed `status`, `notify`, and applicable scheduling metadata (`day`, `idempotencyKey`, `operationId`, `dueAt`, `nextAt`, fixed `code`). `not_due`, `already_completed` and `waiting` emit no run request and set `notify:false`; the caller should keep these skips silent. The program exits 0 for completion/skip/retry scheduling, 2 for recovery, 3 for an existing lock, and 1 for a failed tick. In a PTY, ignore echoed input and select the final line by `type:"final"`.

The parent may call this bridge every five minutes, but neither this bridge nor its schedule state can execute while the Mac is off. After startup, only the latest due day is run; missed days are not replayed in bulk. No sensitive source data, password or ciphertext is part of this RPC.
