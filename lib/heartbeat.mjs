import fs from 'node:fs';
import path from 'node:path';
import { WORK, getConfig } from './config.mjs';
import { writeJson } from './util.mjs';
import * as bus from './bus.mjs';
import { runningInfo, stepsView } from './runner.mjs';

export const STATUS_FILE = path.join(WORK, 'status.json');
const BEAT_MS = 3000;
const bootAt = Date.now();
let toolUrl = null;
let writing = false;
let kickTimer = null;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function progressInfo(p) {
  if (!p) return null;
  const out = { done: p.done ?? null, total: p.total ?? null, label: p.label || null, failed: p.failed || 0, skipped: p.skipped || 0 };
  if (p.total) out.percent = Number(((p.done / p.total) * 100).toFixed(1));
  if (p.totalBytes) { out.bytes = p.bytes || 0; out.total_bytes = p.totalBytes; }
  const secs = ((p.at || 0) - (p.firstAt || 0)) / 1000;
  if (secs >= 10) {
    if (p.totalBytes) {
      const rate = ((p.bytes || 0) - (p.firstBytes || 0)) / secs;
      out.bytes_per_sec = Math.round(rate);
      if (rate > 0) out.eta_sec = Math.round((p.totalBytes - (p.bytes || 0)) / rate);
    } else if (p.total) {
      const rate = ((p.done || 0) - (p.firstDone || 0)) / secs;
      out.items_per_sec = Number(rate.toFixed(2));
      if (rate > 0) out.eta_sec = Math.round((p.total - p.done) / rate);
    }
  }
  return out;
}

function compactSummary(summary) {
  if (!summary) return null;
  if (Array.isArray(summary.checks)) {
    const bad = summary.checks.filter((c) => c.level !== 'ok');
    return { checks_total: summary.checks.length, not_ok: bad.slice(0, 40) };
  }
  return summary;
}

function decide({ run, step, stalled, idleSec, stallSec, steps }) {
  const running = Boolean(run.step || run.phase);
  if (run.pause) {
    const p = run.pause;
    const what = p.kind === 'failed'
      ? `Step ${step?.num || p.step} failed and the phase is held there.`
      : `Paused by ${p.by}: ${p.reason}`;
    const pausing = p.state !== 'paused';
    return {
      attention: pausing ? 'pausing' : 'paused',
      message: pausing ? `${what} The work in progress is finishing; then it waits.` : what,
      next_action: p.kind === 'failed'
        ? 'Read steps[].error (message, hint, detail) and the step log (node ctl.mjs logs <step>). Explain the cause to the developer and agree on a fix. After the fix, with the developer\'s OK, run: node ctl.mjs resume — the failed step runs again and the phase continues.'
        : 'Read "problems" and the step log (node ctl.mjs logs <step>). Explain the cause to the developer and agree on a fix. Resume only with the developer\'s OK: node ctl.mjs resume.',
    };
  }
  if (stalled) {
    return {
      attention: 'stalled',
      message: `Step ${step?.num} shows no progress for ${Math.round(idleSec / 60)} min (limit ${Math.round(stallSec / 60)} min).`,
      next_action: 'Read "current.note" and the step log. A "waiting" note with a lock means something blocks the database. Tell the developer. Do not stop the run without the developer\'s OK (node ctl.mjs stop).',
    };
  }
  if (!running) {
    const bad = steps.filter((s) => s.status === 'failed' || s.status === 'interrupted')
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
    if (bad) {
      return {
        attention: bad.status,
        message: `Step ${bad.num} ${bad.status}: ${bad.error?.message || ''}`.trim(),
        next_action: 'Nothing is running. Read the error and the log, explain the cause to the developer. After the fix the developer presses Run again (finished work is kept).',
      };
    }
    return { attention: 'none', message: 'Nothing is running.', next_action: 'Nothing to watch. Stop watching, or wait until the developer starts a step.' };
  }
  return {
    attention: 'none',
    message: step ? `Step ${step.num} ${step.title} is running.` : `Phase ${run.phase} is running (between steps).`,
    next_action: 'Keep watching.',
  };
}

/** Everything a watcher needs, in one JSON object. Contains no secrets (all text is scrubbed). */
export function agentStatus() {
  const now = Date.now();
  const cfg = getConfig();
  const run = runningInfo();
  const steps = stepsView();
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const stepId = run.step || run.pause?.step || null;
  const step = stepId ? byId[stepId] : null;
  const lastAct = run.step ? bus.getActivity(run.step) : null;
  const idleSec = lastAct ? Math.round((now - lastAct) / 1000) : null;
  const stallSec = cfg.stallAfterMin * 60;
  const stalled = Boolean(run.step) && run.pause?.state !== 'paused' && idleSec != null && idleSec >= stallSec;
  const verdict = decide({ run, step, stalled, idleSec, stallSec, steps });

  let state = 'idle';
  if (run.pause) state = run.pause.state;
  else if (stalled) state = 'stalled';
  else if (run.step || run.phase) state = 'running';

  const note = stepId ? bus.getNote(stepId) : null;
  const counters = stepId ? bus.getCounters(stepId) : null;
  const phases = {};
  for (const ph of ['A', 'B']) {
    const list = steps.filter((s) => s.phase === ph);
    phases[ph] = { done: list.filter((s) => s.status === 'done').length, total: list.length };
  }

  return {
    schema: 1,
    tool: {
      pid: process.pid,
      started_at: iso(bootAt),
      heartbeat_at: iso(now),
      beat_every_sec: BEAT_MS / 1000,
      url: toolUrl,
      status_file: STATUS_FILE,
      logs_dir: bus.getLogDir(),
      backup_dir: path.resolve(cfg.backupDir),
    },
    job: { id: cfg.job.id, name: cfg.job.name, dir: cfg.job.dir, old_ref: cfg.old.ref || null, new_ref: cfg.new.ref || null },
    settings: { pause_on_error: cfg.pauseOnError, stall_after_min: cfg.stallAfterMin },
    state,
    attention: verdict.attention,
    message: verdict.message,
    next_action: verdict.next_action,
    run: { phase: run.phase, step: run.step },
    pause: run.pause ? { ...run.pause, at: iso(run.pause.at), pausedAt: iso(run.pause.pausedAt) } : null,
    current: step ? {
      id: step.id,
      num: step.num,
      title: step.title,
      status: step.status,
      started_at: iso(step.startedAt),
      last_activity_at: iso(lastAct),
      idle_sec: idleSec,
      note: note ? { ...note, ts: iso(note.ts) } : null,
      progress: progressInfo(step.progress),
      counters: counters ? { errors: counters.errors, warnings: counters.warnings, retries: counters.retries } : null,
      error: step.error || null,
      recent_log: bus.getLogs(step.id).slice(-25).map((l) => ({ t: iso(l.ts), level: l.level, msg: l.msg.slice(0, 400) })),
    } : null,
    problems: bus.getProblems().slice(-20).map((p) => ({ ...p, ts: iso(p.ts) })),
    phases,
    steps: steps.map((s) => ({
      id: s.id,
      num: s.num,
      title: s.title,
      phase: s.phase,
      status: s.status,
      started_at: iso(s.startedAt),
      finished_at: iso(s.finishedAt),
      error: s.status === 'done' ? null : (s.error || null),
      summary: compactSummary(s.summary),
    })),
    watcher: { last_check_at: iso(bus.getAgentCheck()) },
  };
}

async function write() {
  if (writing) return;
  writing = true;
  try { await writeJson(STATUS_FILE, agentStatus(), 0o600); } catch { /* next beat tries again */ }
  writing = false;
}

export function startHeartbeat(url) {
  toolUrl = url;
  write();
  setInterval(write, BEAT_MS).unref();
  bus.onEmit((ev) => {
    if (ev.type !== 'state') return;
    clearTimeout(kickTimer);
    kickTimer = setTimeout(write, 300);
  });
}

/** Last write on shutdown, so a watcher sees "the tool was stopped" instead of an old heartbeat. */
export function writeStopped() {
  try {
    const s = agentStatus();
    s.state = 'tool_stopped';
    s.attention = 'tool_down';
    s.message = 'The cloner tool was closed.';
    s.next_action = 'Tell the developer. Start it again with: npm start (in the tool folder). Interrupted steps can be run again.';
    fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* nothing more to do */ }
}
