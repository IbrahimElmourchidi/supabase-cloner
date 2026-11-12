import { STEPS, stepById } from '../steps/index.mjs';
import { getConfig } from './config.mjs';
import { backupPaths } from './paths.mjs';
import { StepError, CancelledError, hintFor, describe } from './errors.mjs';
import { scrub } from './scrub.mjs';
import * as bus from './bus.mjs';
import * as st from './state.mjs';

let current = null;
let phaseRun = null;
/** { reason, by, at, state: 'pausing'|'paused', step, kind: 'request'|'problem'|'failed', pausedAt } */
let pause = null;
let resumeWaiters = [];

export function runningInfo() {
  return {
    step: current?.id || null,
    phase: phaseRun?.phase || null,
    pause: pause ? { ...pause } : null,
    watcherAt: bus.getAgentCheck(),
  };
}

export function stepsView() {
  return STEPS.map((m) => ({
    id: m.id, phase: m.phase, num: m.num, title: m.title, desc: m.desc,
    requires: m.requires, writes: m.writes, confirm: m.confirm || null,
    ...st.getStep(m.id),
    progress: bus.getProgress(m.id),
  }));
}

function broadcast() {
  bus.emit({ type: 'state', steps: stepsView(), running: runningInfo() });
}

function missingRequirements(meta) {
  return meta.requires.filter((r) => !st.isDone(r)).map((r) => stepById(r));
}

export function preflight(id, { fromPhase = false } = {}) {
  const meta = stepById(id);
  if (!meta) throw new StepError(`Unknown step ${id}`);
  if (current) throw new StepError(`Step ${stepById(current.id).num} is still running. Wait or press Stop.`);
  if (phaseRun && !fromPhase) {
    throw new StepError(`Phase ${phaseRun.phase} is ${pause ? 'paused' : 'running'}. Resume it or press Stop first.`);
  }
  const missing = missingRequirements(meta);
  if (missing.length) {
    throw new StepError(`First finish: ${missing.map((m) => `${m.num} ${m.title}`).join(', ')}.`);
  }
  return meta;
}

/* ---------- pause / resume ---------- */

const where = () => current?.id || phaseRun?.lastStep || 'server';

export function requestPause(reason, by = 'user', kind = 'request') {
  if (!current && !phaseRun) throw new StepError('Nothing is running, so there is nothing to pause.');
  if (pause) return pause;
  pause = {
    reason: scrub(String(reason || 'Paused').slice(0, 500)),
    by, kind, at: Date.now(), state: 'pausing', step: where(), pausedAt: null,
  };
  bus.log(where(), 'warn', `PAUSE requested by ${by}: ${pause.reason}. Work in progress finishes first, then the step waits.`);
  broadcast();
  return pause;
}

export function resume(by = 'user') {
  if (!pause) throw new StepError('Nothing is paused.');
  const p = pause;
  pause = null;
  bus.log(p.step || where(), 'info', `RESUMED by ${by}.`);
  for (const w of resumeWaiters.splice(0)) w.resolve();
  broadcast();
}

/** Waits here while a pause is requested. Throws CancelledError when the run is stopped. */
async function waitWhilePaused(signal) {
  if (signal?.aborted) throw new CancelledError();
  if (!pause) return;
  if (pause.state !== 'paused') {
    pause.state = 'paused';
    pause.pausedAt = Date.now();
    bus.log(pause.step || where(), 'warn', 'PAUSED. Waiting for Resume (page button, or: node ctl.mjs resume).');
    broadcast();
  }
  await new Promise((resolve, reject) => {
    const w = {};
    const onAbort = () => {
      resumeWaiters = resumeWaiters.filter((x) => x !== w);
      reject(new CancelledError());
    };
    w.resolve = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    resumeWaiters.push(w);
  });
}

/* ---------- running ---------- */

export async function runStep(id, { fromPhase = false } = {}) {
  const meta = preflight(id, { fromPhase });
  const ac = new AbortController();
  current = { id, ac };
  if (phaseRun) phaseRun.lastStep = id;
  bus.startRunLog(id);
  bus.clearProgress(id);
  const startedAt = Date.now();
  st.setStep(id, { status: 'running', startedAt, finishedAt: null, error: null, summary: null });
  broadcast();

  const cfg = getConfig();
  const ctx = {
    cfg,
    paths: backupPaths(cfg),
    signal: ac.signal,
    log: (m) => bus.log(id, 'info', m),
    ok: (m) => bus.log(id, 'ok', m),
    warn: (m) => bus.log(id, 'warn', m),
    /** Something went wrong but the step can go on. Pauses the run when "pause on any error" is on. */
    problem: (m) => {
      bus.log(id, 'error', m);
      if (getConfig().pauseOnError && !pause) requestPause(`${meta.num}: ${m}`, 'tool', 'problem');
    },
    /** A safe place to stop: waits here while paused. */
    checkpoint: () => waitWhilePaused(ac.signal),
    activity: (note) => bus.activityNote(id, note),
    busy: (note) => bus.busyNote(id, note),
    progress: (p) => bus.progress(id, p),
    sub: () => st.getStep(id).sub || {},
    setSub: (k, v) => st.setSub(id, k, v),
    retryLogger: (what) => (attempt, err, wait) => {
      bus.countRetry(id);
      bus.log(id, 'warn', `${what}: ${describe(err)} — retry ${attempt} in ${Math.round(wait / 1000)}s`);
    },
  };

  try {
    await ctx.checkpoint();
    const summary = await meta.run(ctx);
    st.setStep(id, { status: 'done', finishedAt: Date.now(), summary: summary || null, error: null });
    bus.log(id, 'ok', `Finished in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
  } catch (e) {
    const cancelled = e instanceof CancelledError || ac.signal.aborted;
    const error = {
      message: scrub(cancelled ? new CancelledError().message : describe(e)),
      hint: scrub(cancelled ? '' : (e.hint || hintFor(e) || 'Read the log, fix the cause, then press Run again. Finished work is kept.')),
      detail: e.detail ? scrub(e.detail) : '',
    };
    st.setStep(id, {
      status: cancelled ? 'cancelled' : 'failed', finishedAt: Date.now(), error, summary: e.summary || null,
    });
    bus.log(id, cancelled ? 'warn' : 'error', error.message);
    if (!cancelled && e.stack && !(e instanceof StepError)) bus.log(id, 'debug', scrub(e.stack));
  } finally {
    current = null;
    // A pause asked for during a single step ends with that step. In a phase it holds before the next step.
    if (!phaseRun && pause) {
      pause = null;
      for (const w of resumeWaiters.splice(0)) w.resolve();
    }
    broadcast();
  }
  return st.getStep(id).status;
}

export async function runPhase(phase) {
  if (current || phaseRun) throw new StepError('Something is already running.');
  const ac = new AbortController();
  phaseRun = { phase, ac, lastStep: null };
  broadcast();
  try {
    for (const meta of STEPS.filter((s) => s.phase === phase)) {
      if (st.isDone(meta.id) && !meta.always) continue;
      for (;;) {
        await waitWhilePaused(ac.signal);
        const status = await runStep(meta.id, { fromPhase: true });
        if (status === 'done') break;
        if (status !== 'failed' || ac.signal.aborted || !getConfig().pauseOnError) return;
        const err = st.getStep(meta.id).error || {};
        pause = {
          reason: scrub(`${meta.num} failed: ${err.message || 'see the log'}`),
          by: 'tool', kind: 'failed', at: Date.now(), state: 'pausing', step: meta.id, pausedAt: null,
        };
        bus.log(meta.id, 'warn', `Phase ${phase} is held at ${meta.num}. Fix the cause, then Resume: ${meta.num} runs again and the phase continues.`);
        await waitWhilePaused(ac.signal);
      }
    }
  } catch (e) {
    if (!(e instanceof CancelledError)) bus.log(where(), 'error', describe(e));
  } finally {
    phaseRun = null;
    pause = null;
    resumeWaiters = [];
    broadcast();
  }
}

export function cancel() {
  phaseRun?.ac.abort();
  current?.ac.abort();
  broadcast();
}

export function reset(id) {
  if (current?.id === id) throw new StepError('Stop the step before resetting it.');
  st.resetStep(id);
  bus.clearProgress(id);
  broadcast();
}

export { broadcast };
