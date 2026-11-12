# Supabase Cloner

A local tool with a web page that copies one Supabase project into another:
database, auth users, storage files (same buckets and paths), edge functions,
function secrets, auth / Data API / storage settings, Vault secrets, cron jobs
and pgmq queues.

Use it to move a project to another region, or to make a full copy of a project.
Supabase cannot change the region of an existing project; this tool does the move
for you, with a local backup in between.

## How it works

- **Phase A, back up.** Only *reads* from the old project. Everything goes into the
  clone's `backup/` folder: the database dumps, every storage file at the same
  path, the live edge function code, the settings, and the Vault secrets.
- **A4, check the backup.** Phase B stays locked until this check passes.
- **Phase B, restore.** Fills the new project *from the backup folder*. Links to
  the old project's address in your data and functions are rewritten to the new one.
- **B8, verify.** Compares old and new (row counts, schema objects, files per
  bucket, functions, secrets, cron) and writes `backup/VERIFY_REPORT.md`.

The tool never writes to the old project.

## Requirements

- Node 20 or newer
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
- `psql` (PostgreSQL client)
- Docker running (the Supabase CLI uses it for the database dump in A1)
- A personal access token (supabase.com/dashboard/account/tokens) with access to both projects

## Start

```bash
npm install
npm start            # then open http://127.0.0.1:4545
```

Use `PORT=4546 npm start` for another port.

## Clones

Each copy you make is a **clone**: one old project, one new project, and its own
folder `jobs/<clone>/` with the backup, the step progress, the logs and the settings.

- Press **New clone** at the top of the page to start another one. Each clone has
  its own backup, so two projects never mix.
- After a phase has started, the clone's project ref is fixed. A different project
  needs a new clone.
- B0 refuses a backup that was made from a different project than the one entered.

## What you fill in

For each project: the project ref, the **Session pooler** connection string
(Dashboard → Connect), the database password and the secret key (`sb_secret_…`,
or the legacy `service_role` key). Use **Save and test** to check them; the key test
fails on a publishable key or on a key from the other project.

**Secrets for the new project.** Supabase does not give back secret values: function
secrets and some auth settings (SMTP password, SMS provider tokens) come back only
as a fingerprint. After A3, the page lists every one of them with a box. B5 and B6
stop until each has a value, and their logs say whether the value you typed matches
the old one. Function secrets that are also stored in Vault are filled in for you.

## When something fails

- Every step can be run again. Finished work is kept: files already downloaded or
  uploaded are skipped.
- The database restore is one transaction. A failure leaves the new project unchanged.
- If you close the tool during a step, the step shows as *Interrupted*. Press Run again.
- Logs are in `jobs/<clone>/logs/<step>.log`. Secrets are hidden in all logs.
- Big files get more time: 3 minutes plus enough to move the file at 16 KB/s.

## Watching a run (heartbeat)

- Every 3 seconds the tool writes `work/status.json`: state, current step, progress,
  speed, time left, the last errors, and what to do next. It holds no secrets.
- **Pause on any error** (top of the page, on by default):
  - When a file or item fails, the tool pauses and waits.
  - When a whole step fails during "Run all", the phase holds at that step. Resume
    runs the step again, then the phase continues.
- **Stall check.** A step with no progress for 10 minutes shows as *stalled*. Long
  database dumps and restores are watched through the database itself, so a slow but
  working dump is not reported as stalled.
- **Commands** for you or an AI agent:
  - `npm run status`
  - `node ctl.mjs wait`
  - `node ctl.mjs pause "reason"`
  - `node ctl.mjs resume`
  - `node ctl.mjs logs b3`
- `AGENT_WATCH.md` tells an AI agent how to watch and what it must never do.

To start a watcher in an AI coding agent, start the phase in the page, then ask:

> Be the watcher for the Supabase Cloner in this folder. Read AGENT_WATCH.md and follow it. Tell me at once when something needs attention, and do not resume without my OK.

## Safety

- The server listens on 127.0.0.1 only, and refuses requests from other hosts and
  other web pages.
- Each connection string must belong to its project ref. A swap between OLD and NEW
  is refused.
- B0 and B2 refuse a new database that already has tables.
- Secrets are kept in memory, unless you tick "Remember". Then they go to
  `jobs/<clone>/secrets.json`, readable only by you (`chmod 600`).
- A clone folder holds personal data (emails, phone numbers, password hashes) and
  secrets. Keep it out of git and cloud sync, and delete it when you no longer need
  it. `jobs/` and `work/` are in `.gitignore`.

## After the move

The page lists the manual steps: OAuth redirect URLs, settings that B6 could not set,
pointing your apps at the new project, pausing the old project's cron jobs, and
deleting the old project only when everything works.
