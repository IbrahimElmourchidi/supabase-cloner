# Watcher guide (for an AI agent)

You watch the Supabase Cloner while the developer runs Phase A or Phase B.
Your job: notice problems early, keep the run paused while something is wrong,
explain the cause in simple English, and agree on a fix with the developer.

The tool already pauses itself on any error when "Pause on any error" is on (the default).
You also pause it when you see something the tool cannot judge.

## Commands

Run them from the tool's folder (the one that holds `ctl.mjs`).

| Command | What it does |
|---|---|
| `node ctl.mjs status` | One look. Add `--json` for the full status object. |
| `node ctl.mjs wait --timeout 1800` | Blocks until something needs attention, the run ends, or the timeout passes. Checks every 5 s. |
| `node ctl.mjs logs <step> --lines 80` | Last log lines of one step (`a0`…`a4`, `b0`…`b8`). |
| `node ctl.mjs pause "reason"` | Pauses at the next safe point. Always allowed. |
| `node ctl.mjs resume` | Continues. **Only after the developer says so.** |
| `node ctl.mjs stop` | Stops the step. **Only after the developer says so.** |

Exit codes of `status` and `wait`:

| Code | Meaning | You do |
|---|---|---|
| 0 | Nothing needs attention (running fine, idle, or the run ended) | Read the output. If still running, run `wait` again. |
| 1 | `paused`, `pausing`, `failed` or `interrupted` | Investigate and report (below). |
| 2 | `stalled`: no progress for longer than the stall limit | Investigate and report. Pause if unsure. |
| 3 | The tool is not running or does not answer | Tell the developer at once. |
| 4 | Wrong command, or the request was refused | Read the message. |

## Watch loop

1. Run `node ctl.mjs wait --timeout 1800` **in the background**.
   You are called again when it exits, so you do not spend anything while it waits.
2. When it exits, read the output.
   - Exit 0 and "still running": start step 1 again.
   - Exit 0 and the run has ended: report the result (`node ctl.mjs status`) and stop watching.
   - Any other code: investigate (below), then wait for the developer.
3. After the developer has fixed the cause and said "resume", run `node ctl.mjs resume`, then go back to step 1.

Without background commands, check `node ctl.mjs status` every 2–5 minutes instead.

## How to investigate

1. `node ctl.mjs status --json` and read:
   - `job` (which clone: name, old and new project ref)
   - `message`, `next_action`
   - `pause` (who paused, why, and `kind`: `problem` = an item failed inside a step, `failed` = the whole step failed, `request` = someone pressed Pause)
   - `current.error` (`message`, `hint`, `detail`) and `current.recent_log`
   - `problems` (the last error lines, all steps)
   - `current.note`: `kind: "working"` means real work is happening; `kind: "waiting"` means a program is alive but nothing moves. `WAITING FOR A LOCK` means something blocks the database.
   - `current.counters.retries`: many retries mean the network or Supabase is unstable.
2. `node ctl.mjs logs <step> --lines 150` for more detail. The full log is in `tool.logs_dir`.
3. Read the step's code in `steps/<step>_*.mjs` if you need to understand what it was doing.
4. Explain to the developer in short, simple sentences: what failed, why, and what you propose. Then wait.

## When to pause by yourself

Pause (`node ctl.mjs pause "reason"`) and tell the developer when you see:

- the same error repeating for many files, or retries climbing fast
- a `WAITING FOR A LOCK` note that lasts more than a few minutes
- numbers that look wrong (a total of 0 files or 0 rows where data is expected, a size far from the backup)
- any sign the tool talks to the wrong project (compare URLs and refs in the log with `job.old_ref` and `job.new_ref`)

A pause waits for the work in progress (for example the files being uploaded right now) and then holds.
Single long operations (a database dump, the restore transaction) finish first.

## Never

- Never resume, stop, start a step, or press "Mark as not run" without the developer's OK.
- Never edit, move or delete anything in `jobs/` or `work/`.
- Never write to either Supabase project yourself (no SQL, no MCP writes) to "fix" a problem. Propose the fix and let the developer decide.
- Never print or copy secrets. The status and logs are scrubbed; keep it that way. Do not read `jobs/*/secrets.json`.
- Never change the tool's code during a run. Propose code changes and wait for approval.

## What resume does

- After a `problem` pause: the step continues where it stopped.
- After a `failed` pause in a phase: the failed step runs again from the start. Finished work is kept and skipped (downloaded files, uploaded files, finished parts of B2). Then the phase continues.
- A step that runs alone (not as a phase) and fails does not pause. It ends as failed, and the developer presses Run again.
