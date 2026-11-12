import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { CancelledError } from './errors.mjs';

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = () => { clearTimeout(timer); reject(new CancelledError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CancelledError();
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeAtomic(file, data, mode = 0o600) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, data, { mode });
  await fsp.rename(tmp, file);
}

export const writeJson = (file, obj, mode = 0o600) =>
  writeAtomic(file, JSON.stringify(obj, null, 2), mode);

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function readJsonl(file) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) out.push(JSON.parse(line));
  return out;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

export function safeJoin(base, ...parts) {
  const root = path.resolve(base);
  const p = path.resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`Unsafe path rejected: ${parts.join('/')}`);
  }
  return p;
}

export async function fileSize(file) {
  try { return (await fsp.stat(file)).size; } catch { return -1; }
}

export async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

export async function listFiles(dir, base = dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x < 10 ? 2 : 1)} ${units[i]}`;
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const ql = (text) => `'${String(text).replace(/'/g, "''")}'`;

export function lastLines(text, n = 12) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n).join('\n');
}

export async function readLinesAround(file, lineNo, radius = 3) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    i++;
    if (i >= lineNo - radius && i <= lineNo + radius) {
      out.push(`${i === lineNo ? '>>' : '  '} ${i}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
    }
    if (i > lineNo + radius) { rl.close(); break; }
  }
  return out.join('\n');
}
