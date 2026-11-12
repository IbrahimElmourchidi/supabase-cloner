import fsp from 'node:fs/promises';
import path from 'node:path';
import { StepError } from '../lib/errors.mjs';
import { run, CLI_NOISE } from '../lib/shell.mjs';
import { hostOf } from '../lib/conn.mjs';
import { lastLines, readLinesAround, fmtBytes } from '../lib/util.mjs';
import { openClient } from '../lib/db.mjs';

const mins = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

export function requireFields(cfg, side, fields) {
  const names = { ref: 'project ref', dbUrl: 'database connection string', secretKey: 'secret key' };
  const missing = fields.filter((f) => !cfg[side][f]);
  if (missing.length) {
    throw new StepError(`Missing for the ${side.toUpperCase()} project: ${missing.map((f) => names[f] || f).join(', ')}.`,
      'Fill the Credentials form and press Save.');
  }
}

export function requirePat(cfg) {
  if (!cfg.pat) throw new StepError('Missing: personal access token.', 'Create one at supabase.com/dashboard/account/tokens, paste it, press Save.');
}

export const hosts = (cfg) => ({ oldHost: hostOf(cfg.old.ref), newHost: hostOf(cfg.new.ref) });

export function replaceHostDeep(value, oldHost, newHost) {
  if (typeof value === 'string') return value.split(oldHost).join(newHost);
  if (Array.isArray(value)) return value.map((v) => replaceHostDeep(v, oldHost, newHost));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceHostDeep(v, oldHost, newHost)]));
  }
  return value;
}

export async function checkTool(ctx, cmd, args, missingHint) {
  try {
    const r = await run(cmd, args, { signal: ctx.signal });
    if (r.code !== 0) throw new StepError(`${cmd} is not ready: ${lastLines(r.stderr || r.stdout, 3)}`, missingHint);
    return lastLines(r.stdout, 1);
  } catch (e) {
    if (e instanceof StepError) throw e;
    if (e.code === 'ENOENT') throw new StepError(`${cmd} is not installed on this computer.`, missingHint);
    throw e;
  }
}

/**
 * Runs the Supabase CLI, streams useful output to the log, returns the result.
 * watchFile: a file the command writes. Its growth tells the watcher the command is really working.
 * probeUrl: the database a dump reads from. The dump writes its file only at the end, so while it
 * runs, the database session of pg_dump is what shows that it is still working.
 */
export async function supabaseCli(ctx, args, { env, cwd, watchFile, label, probeUrl } = {}) {
  const what = label || `supabase ${args.slice(0, 2).join(' ')}`;
  let lastSize = -1;
  const stopProbe = probeUrl ? startDbProbe(ctx, probeUrl, what, Date.now(), { tool: 'pg_dump' }) : null;
  try {
    return await run('supabase', args, {
      cwd,
      env: { SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', ...env },
      signal: ctx.signal,
      onLine: (line) => { if (!CLI_NOISE.test(line)) ctx.log(line); },
      onTick: async (ms) => {
        if (watchFile) {
          const size = (await fsp.stat(watchFile).catch(() => null))?.size ?? -1;
          if (size > lastSize && size > 0) {
            lastSize = size;
            return ctx.activity(`${what}: ${fmtBytes(size)} written after ${mins(ms)}`);
          }
        }
        if (!stopProbe) ctx.busy(`${what}: running for ${mins(ms)}${watchFile ? ', file not growing' : ''}`);
      },
    });
  } finally {
    stopProbe?.();
  }
}

/**
 * Looks at the database every 15 s while psql or pg_dump runs, so a watcher can tell
 * "the database is working" from "it waits for a lock" or "nothing happens".
 * tool 'psql': finds the session named supabase-cloner. tool 'pg_dump': finds the dump's session;
 * a dump session that sits idle inside its transaction for 60 s or more, or one dump statement that
 * runs for 10 min or more, does not count as working.
 */
function startDbProbe(ctx, url, what, started, { tool = 'psql' } = {}) {
  const app = tool === 'pg_dump' ? 'pg_dump' : 'supabase-cloner';
  const pgUrl = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  let client = null;
  let stopped = false;
  let busyProbe = false;
  const probe = async () => {
    if (stopped || busyProbe) return;
    busyProbe = true;
    const elapsed = mins(Date.now() - started);
    try {
      client ||= await openClient(pgUrl, 'supabase-cloner-probe');
      const r = (await client.query(`
        select state, wait_event_type, wait_event,
               extract(epoch from now() - coalesce(query_start, backend_start))::int secs,
               extract(epoch from now() - coalesce(state_change, backend_start))::int state_secs,
               left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 120) q
          from pg_stat_activity
         where pid <> pg_backend_pid() and backend_type = 'client backend'
           and application_name <> 'supabase-cloner-probe'
           and (application_name = $1 or (usename = current_user and state <> 'idle'))
         order by (application_name = $1) desc, query_start
         limit 1`, [app])).rows[0];
      if (!r) ctx.busy(`${what}: ${tool} running for ${elapsed}; its database session is not visible`);
      else if (r.wait_event_type === 'Lock') ctx.busy(`${what}: WAITING FOR A LOCK (${r.wait_event}) for ${r.secs}s: ${r.q}`);
      else if (tool === 'pg_dump' && r.state === 'idle in transaction' && r.state_secs >= 60) {
        ctx.busy(`${what}: the dump's database session has been idle for ${r.state_secs}s (running for ${elapsed})`);
      } else if (tool === 'pg_dump' && r.state === 'active' && r.secs >= 600) {
        ctx.busy(`${what}: one dump statement has been running for ${mins(r.secs * 1000)}${r.wait_event ? ` (${r.wait_event_type}/${r.wait_event})` : ''}: ${r.q}`);
      } else ctx.activity(`${what}: database ${r.state}${r.wait_event ? ` (${r.wait_event_type}/${r.wait_event})` : ''}, statement running ${r.secs}s: ${r.q}`);
    } catch {
      ctx.busy(`${what}: ${tool} running for ${elapsed} (status probe could not connect)`);
      await client?.end().catch(() => {});
      client = null;
    }
    busyProbe = false;
  };
  const timer = setInterval(probe, 15000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); client?.end().catch(() => {}); };
}

/**
 * Runs psql as one transaction that stops at the first error.
 * parts: [{ file } | { sql }] in order. On error, shows the failing line with context.
 */
export async function psqlTransaction(ctx, url, parts, what) {
  const args = ['-X', '-q', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-d', url];
  for (const p of parts) {
    if (p.file) args.push('-f', p.file);
    else args.push('-c', p.sql);
  }
  const stopProbe = startDbProbe(ctx, url, what, Date.now());
  let r;
  try {
    r = await run('psql', args, {
      env: { PGCONNECT_TIMEOUT: '30', PGAPPNAME: 'supabase-cloner' },
      signal: ctx.signal,
      onLine: (line, stream) => {
        if (stream === 'stderr' && /NOTICE|WARNING/.test(line) && !/ERROR/.test(line)) return;
        if (stream === 'stderr') ctx.warn(line);
      },
    });
  } finally {
    stopProbe();
  }
  if (r.code === 0) return;
  const m = /psql:(.+?):(\d+): ERROR:\s*([^\n]*)/.exec(r.stderr);
  let detail = lastLines(r.stderr, 20);
  let message = `${what} failed. Nothing from this run was saved (one transaction).`;
  if (m) {
    const [, file, line, err] = m;
    message = `${what} failed at ${path.basename(file)} line ${line}: ${err}. Nothing from this run was saved.`;
    const around = await readLinesAround(file, Number(line)).catch(() => '');
    detail = `${lastLines(r.stderr, 8)}\n\n--- ${path.basename(file)} around line ${line} ---\n${around}`;
  }
  throw new StepError(message, null, { detail });
}

export async function fileNonEmpty(file) {
  try { return (await fsp.stat(file)).size > 0; } catch { return false; }
}
