import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSecret } from './scrub.mjs';
import { writeJson } from './util.mjs';
import { parseDbUrl } from './conn.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = path.join(ROOT, 'work');
export const JOBS = path.join(ROOT, 'jobs');
const SETTINGS_FILE = path.join(WORK, 'settings.json');

/** Secret fields of the form, as dotted paths into the merged config. */
export const SECRET_PATHS = ['old.dbPassword', 'old.secretKey', 'new.dbPassword', 'new.secretKey', 'pat'];
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SETTINGS_DEFAULTS = { concurrency: 8, rememberSecrets: false, pauseOnError: true, stallAfterMin: 10, currentJob: null };
const JOB_DEFAULTS = {
  name: '', createdAt: null,
  old: { ref: '', dbUrl: '' }, new: { ref: '', dbUrl: '' },
  functionsSource: 'backup', repoDir: '',
};
const emptySecrets = () => ({
  pat: '', old: { dbPassword: '', secretKey: '' }, new: { dbPassword: '', secretKey: '' }, functions: {}, auth: {},
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, v) => {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = v;
};
const readJsonSync = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

let settings = clone(SETTINGS_DEFAULTS);
let job = null;
let secrets = emptySecrets();

/** Every file of one clone job. */
export function jobPaths(id) {
  const dir = path.join(JOBS, id);
  return {
    dir,
    file: path.join(dir, 'job.json'),
    secrets: path.join(dir, 'secrets.json'),
    state: path.join(dir, 'state.json'),
    logs: path.join(dir, 'logs'),
    backup: path.join(dir, 'backup'),
  };
}

export function listJobs() {
  let names = [];
  try { names = fs.readdirSync(JOBS); } catch { return []; }
  return names
    .map((id) => {
      const j = readJsonSync(jobPaths(id).file);
      return j ? { id, name: j.name || id, createdAt: j.createdAt, oldRef: j.old?.ref || '', newRef: j.new?.ref || '' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clone';
}

/** Creates a new, empty clone job and returns its id. */
export async function createJob(name) {
  const base = slug(name);
  let id = base;
  for (let i = 2; fs.existsSync(jobPaths(id).dir); i++) id = `${base}-${i}`;
  const p = jobPaths(id);
  await fsp.mkdir(p.dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(JOBS, 0o700).catch(() => {});
  await writeJson(p.file, { ...clone(JOB_DEFAULTS), name: String(name).trim() || id, createdAt: new Date().toISOString() });
  return id;
}

function registerAll() {
  for (const p of SECRET_PATHS) registerSecret(getPath(secrets, p));
  for (const v of Object.values(secrets.functions)) registerSecret(v);
  for (const v of Object.values(secrets.auth)) registerSecret(v);
}

/** Makes this job the current one. The account token stays; project secrets come from the job. */
export async function openJob(id) {
  const p = jobPaths(id);
  const saved = readJsonSync(p.file);
  if (!saved) throw new Error(`There is no clone "${id}".`);
  job = {
    ...clone(JOB_DEFAULTS), ...saved, id,
    old: { ...JOB_DEFAULTS.old, ...(saved.old || {}) },
    new: { ...JOB_DEFAULTS.new, ...(saved.new || {}) },
  };
  const pat = secrets.pat;
  const s = readJsonSync(p.secrets) || {};
  secrets = {
    ...emptySecrets(), ...s,
    old: { ...emptySecrets().old, ...(s.old || {}) },
    new: { ...emptySecrets().new, ...(s.new || {}) },
    functions: { ...(s.functions || {}) },
    auth: { ...(s.auth || {}) },
  };
  if (!secrets.pat) secrets.pat = pat;
  registerAll();
  settings.currentJob = id;
  await writeJson(SETTINGS_FILE, settings);
  return job;
}

/** Loads the settings and opens the last used job (or the newest, or a new one). */
export async function loadConfig() {
  settings = { ...clone(SETTINGS_DEFAULTS), ...(readJsonSync(SETTINGS_FILE) || {}) };
  fs.mkdirSync(JOBS, { recursive: true, mode: 0o700 });
  const jobs = listJobs();
  let id = jobs.find((j) => j.id === settings.currentJob)?.id || jobs[0]?.id;
  if (!id) id = await createJob(`clone ${new Date().toISOString().slice(0, 10)}`);
  await openJob(id);
}

export const currentJobPaths = () => jobPaths(job.id);

/** The view every step uses. Built fresh each time, so a running step keeps the copy it started with. */
export function getConfig() {
  return {
    old: { ...job.old, ...secrets.old },
    new: { ...job.new, ...secrets.new },
    pat: secrets.pat,
    secrets: { functions: { ...secrets.functions }, auth: { ...secrets.auth } },
    concurrency: settings.concurrency,
    rememberSecrets: settings.rememberSecrets,
    pauseOnError: settings.pauseOnError,
    stallAfterMin: settings.stallAfterMin,
    functionsSource: job.functionsSource,
    repoDir: job.repoDir,
    backupDir: jobPaths(job.id).backup,
    job: { id: job.id, name: job.name, dir: jobPaths(job.id).dir },
  };
}

/** Replaces the password in a connection string with [YOUR-PASSWORD]. The password may contain @ and :. */
export function withoutPassword(url) {
  const m = /^(postgres(?:ql)?:\/\/)(.*)$/i.exec(String(url).trim());
  if (!m) return url;
  const at = m[2].lastIndexOf('@');
  if (at < 0) return url;
  const userinfo = m[2].slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon < 0) return url;
  return `${m[1]}${userinfo.slice(0, colon)}:[YOUR-PASSWORD]@${m[2].slice(at + 1)}`;
}

function moveInlinePassword(side) {
  const s = job[side];
  if (!s.dbUrl) return;
  try {
    const p = parseDbUrl(s.dbUrl);
    if (p.password && p.password !== '[YOUR-PASSWORD]') {
      secrets[side].dbPassword = p.password;
      registerSecret(p.password);
      s.dbUrl = withoutPassword(s.dbUrl);
    }
  } catch { /* validated later, with a clear message */ }
}

export async function updateConfig(patch) {
  for (const side of ['old', 'new']) {
    for (const k of ['ref', 'dbUrl']) {
      const v = patch?.[side]?.[k];
      if (typeof v === 'string') job[side][k] = v.trim();
    }
  }
  if (patch?.functionsSource === 'backup' || patch?.functionsSource === 'repo') job.functionsSource = patch.functionsSource;
  if (typeof patch?.repoDir === 'string') job.repoDir = patch.repoDir.trim();
  if (patch?.concurrency != null) {
    const n = Math.round(Number(patch.concurrency));
    if (Number.isFinite(n)) settings.concurrency = Math.min(32, Math.max(1, n));
  }
  if (typeof patch?.rememberSecrets === 'boolean') settings.rememberSecrets = patch.rememberSecrets;
  if (typeof patch?.pauseOnError === 'boolean') settings.pauseOnError = patch.pauseOnError;
  if (patch?.stallAfterMin != null) {
    const n = Math.round(Number(patch.stallAfterMin));
    if (Number.isFinite(n)) settings.stallAfterMin = Math.min(120, Math.max(2, n));
  }
  for (const p of SECRET_PATHS) {
    const v = getPath(patch, p);
    if (typeof v === 'string' && v.trim() !== '') {
      setPath(secrets, p, v.trim());
      registerSecret(v.trim());
    }
  }
  for (const kind of ['functions', 'auth']) {
    for (const [name, v] of Object.entries(patch?.secrets?.[kind] || {})) {
      if (!SECRET_NAME.test(name) || typeof v !== 'string' || v.trim() === '') continue;
      secrets[kind][name] = v.trim();
      registerSecret(v.trim());
    }
  }
  moveInlinePassword('old');
  moveInlinePassword('new');
  await persist();
  return getConfig();
}

export async function forgetSecrets() {
  secrets = emptySecrets();
  settings.rememberSecrets = false;
  await persist();
}

async function persist() {
  const p = jobPaths(job.id);
  const { id, ...rest } = job;
  await writeJson(p.file, rest);
  await writeJson(SETTINGS_FILE, settings);
  if (settings.rememberSecrets) await writeJson(p.secrets, secrets, 0o600);
  else await fsp.rm(p.secrets, { force: true });
}

/** The config for the page: no secret values, only which ones are set. */
export function publicConfig() {
  const out = getConfig();
  const has = {};
  for (const p of SECRET_PATHS) {
    has[p] = Boolean(getPath(out, p));
    setPath(out, p, '');
  }
  for (const kind of ['functions', 'auth']) {
    for (const [name, v] of Object.entries(out.secrets[kind])) has[`secrets.${kind}.${name}`] = Boolean(v);
  }
  delete out.secrets;
  return { ...out, has };
}
