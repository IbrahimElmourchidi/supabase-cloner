import fs from 'node:fs';
import { writeJson } from './util.mjs';

let FILE = null;
let state = { steps: {} };
let saveTimer = null;

/** Loads the step progress of one clone job (its state.json). */
export function loadState(file) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveNow();
  }
  FILE = file;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = { steps: {} }; }
  state.steps ||= {};
  for (const s of Object.values(state.steps)) {
    if (s.status === 'running') {
      s.status = 'interrupted';
      s.error = {
        message: 'The tool was closed while this step was running.',
        hint: 'Press Run again. Finished work is kept and skipped.',
      };
    }
  }
  saveNow();
}

function saveNow() {
  if (!FILE) return;
  writeJson(FILE, state, 0o600).catch(() => {});
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

export const getStep = (id) => (state.steps[id] ||= { status: 'idle', sub: {} });

export function setStep(id, patch) {
  const s = getStep(id);
  Object.assign(s, patch);
  s.sub ||= {};
  save();
  return s;
}

export function setSub(id, key, value) {
  const s = getStep(id);
  s.sub ||= {};
  s.sub[key] = value;
  save();
}

export function resetStep(id) {
  state.steps[id] = { status: 'idle', sub: {} };
  save();
}

export const allSteps = () => state.steps;
export const isDone = (id) => state.steps[id]?.status === 'done';
