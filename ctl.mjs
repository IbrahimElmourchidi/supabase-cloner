#!/usr/bin/env node
// Command line for a watcher (a person or an AI agent). Talks to the running cloner on 127.0.0.1.
//
//   node ctl.mjs status [--json]                 one look; exit code says what needs attention
//   node ctl.mjs wait [--timeout 1800] [--json]  blocks until something needs attention, the run ends, or the timeout
//   node ctl.mjs pause "reason"                  pause at the next safe point
//   node ctl.mjs resume                          continue (only with the developer's OK)
//   node ctl.mjs stop                            stop the running step (only with the developer's OK)
//   node ctl.mjs logs <step> [--lines 80]        last log lines of a step, e.g. a2 or b3
//
// Exit codes: 0 nothing needs attention · 1 paused, pausing, failed or interrupted · 2 stalled
//             3 the tool is not running · 4 wrong usage or request refused
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(ROOT, 'work', 'status.json');
const STALE_MS = 30000;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));

function readStatusFile() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return null; }
}

function baseUrl() {
  if (process.env.PORT) return `http://127.0.0.1:${process.env.PORT}`;
  return readStatusFile()?.tool?.url || 'http://127.0.0.1:4545';
}

async function call(method, route, body) {
  const res = await fetch(`${baseUrl()}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.refused = true;
    throw e;
  }
  return data;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Status from the server, or from the status file when the server does not answer. */
async function getStatus() {
  try {
    return await call('GET', '/api/agent/status?agent=1');
  } catch (e) {
    if (e.refused) throw e;
    const s = readStatusFile();
    const age = s?.tool?.heartbeat_at ? Date.now() - Date.parse(s.tool.heartbeat_at) : null;
    const down = {
      state: 'tool_down',
      attention: 'tool_down',
      message: s
        ? `The cloner does not answer. Last heartbeat ${Math.round(age / 1000)}s ago; process ${pidAlive(s.tool.pid) ? 'still exists (hung?)' : 'is gone'}.`
        : 'The cloner is not running and has never written a status file.',
      next_action: `Tell the developer. Start it with: cd ${ROOT} && npm start. Then run the interrupted step again (finished work is kept).`,
      last_known: s,
    };
    return down;
  }
}

function exitCodeFor(s) {
  if (s.attention === 'tool_down') return 3;
  if (s.attention === 'stalled') return 2;
  if (['paused', 'pausing', 'failed', 'interrupted'].includes(s.attention)) return 1;
  return 0;
}

const fmtBytes = (n) => {
  let v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(1)} ${u[i]}`;
};
const fmtSec = (s) => (s == null ? '?' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

function human(s) {
  const out = [];
  out.push(`STATE: ${String(s.state).toUpperCase()}   ATTENTION: ${String(s.attention).toUpperCase()}`);
  out.push(`Message: ${s.message}`);
  if (s.job) out.push(`Clone: ${s.job.name} (${s.job.old_ref || '?'} → ${s.job.new_ref || '?'})`);
  if (s.attention === 'tool_down') {
    out.push(`Next: ${s.next_action}`);
    return out.join('\n');
  }
  if (s.run?.phase || s.run?.step) out.push(`Run: ${s.run.phase ? `phase ${s.run.phase}` : 'single step'}${s.current ? `, step ${s.current.num} ${s.current.title}` : ''}`);
  if (s.pause) out.push(`Pause: ${s.pause.state} by ${s.pause.by} (${s.pause.kind}) — ${s.pause.reason}`);
  const c = s.current;
  if (c) {
    const p = c.progress;
    if (p?.total) {
      let line = `Progress: ${p.done}/${p.total} ${p.label || ''} (${p.percent}%)`;
      if (p.total_bytes) line += `, ${fmtBytes(p.bytes)} / ${fmtBytes(p.total_bytes)}`;
      if (p.bytes_per_sec) line += `, ${fmtBytes(p.bytes_per_sec)}/s`;
      if (p.eta_sec != null) line += `, about ${fmtSec(p.eta_sec)} left`;
      if (p.failed) line += `, ${p.failed} failed`;
      out.push(line);
    }
    if (c.idle_sec != null) out.push(`Last activity: ${fmtSec(c.idle_sec)} ago (stall limit ${s.settings.stall_after_min}m)`);
    if (c.note) out.push(`Now: [${c.note.kind}] ${c.note.note}`);
    if (c.counters) out.push(`This run: ${c.counters.errors} errors, ${c.counters.warnings} warnings, ${c.counters.retries} retries`);
    if (c.error) out.push(`Error: ${c.error.message}${c.error.hint ? `\nHint: ${c.error.hint}` : ''}`);
  }
  const recent = (s.problems || []).slice(-5);
  if (recent.length && s.attention !== 'none') {
    out.push('Recent problems:');
    for (const p of recent) out.push(`  ${p.ts} [${p.step}] ${p.msg}`);
  }
  out.push(`Phases: A ${s.phases.A.done}/${s.phases.A.total} done, B ${s.phases.B.done}/${s.phases.B.total} done`);
  out.push(`Next: ${s.next_action}`);
  return out.join('\n');
}

function print(s) {
  console.log(flag('json') ? JSON.stringify(s, null, 2) : human(s));
}

async function main() {
  switch (cmd) {
    case 'status': {
      const s = await getStatus();
      print(s);
      return exitCodeFor(s);
    }
    case 'wait': {
      const timeoutMs = Number(opt('timeout', '1800')) * 1000;
      const pollMs = Math.max(2, Number(opt('every', '5'))) * 1000;
      const start = Date.now();
      const first = await getStatus();
      if (exitCodeFor(first) !== 0) { print(first); return exitCodeFor(first); }
      if (first.state === 'idle') { print(first); return 0; }
      let downCount = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        const s = await getStatus();
        if (s.attention === 'tool_down') {
          if (++downCount < 3) continue;
          print(s);
          return 3;
        }
        downCount = 0;
        if (exitCodeFor(s) !== 0) { print(s); return exitCodeFor(s); }
        if (s.state === 'idle') {
          if (!flag('json')) console.log('The run has ended without problems.');
          print(s);
          return 0;
        }
        if (Date.now() - start >= timeoutMs) {
          if (!flag('json')) console.log(`Still running fine after ${fmtSec(Math.round(timeoutMs / 1000))}. Run "wait" again to keep watching.`);
          print(s);
          return 0;
        }
      }
    }
    case 'pause': {
      const reason = positional.join(' ') || 'Paused by the watcher';
      print(await call('POST', '/api/pause', { reason, by: 'agent' }));
      return 0;
    }
    case 'resume': {
      print(await call('POST', '/api/resume', { by: 'agent' }));
      return 0;
    }
    case 'stop': {
      await call('POST', '/api/cancel', {});
      console.log('Stop sent. The step ends at once; finished work is kept.');
      return 0;
    }
    case 'logs': {
      const step = positional[0];
      if (!step) { console.error('Usage: node ctl.mjs logs <step> [--lines 80]   (step ids: a0..a4, b0..b8)'); return 4; }
      const n = Number(opt('lines', '80'));
      try {
        const { lines } = await call('GET', `/api/logs?step=${encodeURIComponent(step)}`);
        if (lines.length) {
          for (const l of lines.slice(-n)) console.log(`${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`);
          return 0;
        }
      } catch (e) {
        if (e.refused) throw e;
      }
      const logDir = readStatusFile()?.tool?.logs_dir;
      if (!logDir) { console.error(`No log for step "${step}" yet.`); return 4; }
      const file = path.join(logDir, `${path.basename(step)}.log`);
      try {
        const text = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        console.log(text.slice(-n).join('\n'));
        return 0;
      } catch {
        console.error(`No log for step "${step}" yet.`);
        return 4;
      }
    }
    default:
      console.error('Commands: status | wait | pause "reason" | resume | stop | logs <step>   (add --json for machine output)');
      return 4;
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error(`Refused: ${e.message}`);
  process.exit(4);
});
