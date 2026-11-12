import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './scrub.mjs';

const clients = new Set();
const logs = new Map();
const streams = new Map();
const lastProgress = new Map();
const progressTimers = new Map();
const listeners = new Set();
const activity = new Map();
const notes = new Map();
const counters = new Map();
const problems = [];
let agentCheckAt = null;
const MAX_LINES = 3000;
const MAX_PROBLEMS = 50;
let LOG_DIR = null;

/** Switches to another clone job's log folder and forgets everything shown for the previous one. */
export function useLogDir(dir) {
  for (const s of streams.values()) s.end();
  streams.clear();
  logs.clear();
  lastProgress.clear();
  activity.clear();
  notes.clear();
  counters.clear();
  problems.length = 0;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  LOG_DIR = dir;
}
export const getLogDir = () => LOG_DIR;

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function onEmit(fn) { listeners.add(fn); }

export function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch { /* a listener must never break the run */ }
  }
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    try { c.write(data); } catch { clients.delete(c); }
  }
}

setInterval(() => {
  for (const c of clients) {
    try { c.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 20000).unref();

function fileStream(step) {
  let s = streams.get(step);
  if (!s && !LOG_DIR) return null;
  if (!s) {
    s = fs.createWriteStream(path.join(LOG_DIR, `${step}.log`), { flags: 'a', mode: 0o600 });
    s.on('error', () => streams.delete(step));
    streams.set(step, s);
  }
  return s;
}

export function log(step, level, message) {
  const msg = scrub(message);
  const line = { ts: Date.now(), level, msg };
  let arr = logs.get(step);
  if (!arr) logs.set(step, (arr = []));
  arr.push(line);
  activity.set(step, line.ts);
  const c = countersOf(step);
  if (level === 'error') {
    c.errors++;
    problems.push({ ts: line.ts, step, msg: msg.slice(0, 600) });
    if (problems.length > MAX_PROBLEMS) problems.splice(0, problems.length - MAX_PROBLEMS);
  } else if (level === 'warn') c.warnings++;
  if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
  fileStream(step)?.write(`${new Date(line.ts).toISOString()} [${level}] ${msg}\n`);
  emit({ type: 'log', step, ...line });
}

export function startRunLog(step) {
  logs.set(step, []);
  counters.set(step, { errors: 0, warnings: 0, retries: 0, startedAt: Date.now() });
  activity.set(step, Date.now());
  notes.delete(step);
  fileStream(step)?.write(`\n===== run started ${new Date().toISOString()} =====\n`);
}

export const getLogs = (step) => logs.get(step) || [];

export function progress(step, p) {
  const prev = lastProgress.get(step);
  if (!prev || prev.done !== p.done || prev.bytes !== p.bytes) activity.set(step, Date.now());
  lastProgress.set(step, { ...p, at: Date.now(), firstAt: prev?.firstAt ?? Date.now(), firstBytes: prev?.firstBytes ?? p.bytes ?? 0, firstDone: prev?.firstDone ?? p.done ?? 0 });
  if (progressTimers.has(step)) return;
  progressTimers.set(step, setTimeout(() => {
    progressTimers.delete(step);
    emit({ type: 'progress', step, ...lastProgress.get(step) });
  }, 300));
}

export const getProgress = (step) => lastProgress.get(step) || null;
export const clearProgress = (step) => lastProgress.delete(step);

function countersOf(step) {
  let c = counters.get(step);
  if (!c) counters.set(step, (c = { errors: 0, warnings: 0, retries: 0, startedAt: Date.now() }));
  return c;
}

/** Real work happened (bytes written, rows sent, the database is busy). Resets the stall timer. */
export function activityNote(step, note) {
  activity.set(step, Date.now());
  notes.set(step, { ts: Date.now(), note: scrub(note), kind: 'working' });
}

/** The step is alive but nothing shows progress (a program is running, or it waits for a lock). */
export function busyNote(step, note) {
  notes.set(step, { ts: Date.now(), note: scrub(note), kind: 'waiting' });
}

export const countRetry = (step) => { countersOf(step).retries++; };
export const getActivity = (step) => activity.get(step) || null;
export const getNote = (step) => notes.get(step) || null;
export const getCounters = (step) => counters.get(step) || null;
export const getProblems = () => problems.slice();

export function markAgentCheck() {
  agentCheckAt = Date.now();
  emit({ type: 'watcher', at: agentCheckAt });
}
export const getAgentCheck = () => agentCheckAt;
