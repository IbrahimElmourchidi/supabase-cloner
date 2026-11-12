import { spawn } from 'node:child_process';
import { CancelledError } from './errors.mjs';

const MAX_KEEP = 2 * 1024 * 1024;

export function run(cmd, args, { cwd, env, signal, onLine, onTick, tickMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let stdout = '';
    let stderr = '';
    const partial = { stdout: '', stderr: '' };
    const feed = (stream, chunk) => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout = (stdout + text).slice(-MAX_KEEP);
      else stderr = (stderr + text).slice(-MAX_KEEP);
      if (!onLine) return;
      const lines = (partial[stream] + text).split('\n');
      partial[stream] = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l, stream);
    };
    const started = Date.now();
    const ticker = onTick ? setInterval(() => {
      Promise.resolve().then(() => onTick(Date.now() - started)).catch(() => { /* a status probe must never break the run */ });
    }, tickMs) : null;
    ticker?.unref();
    child.stdout.on('data', (c) => feed('stdout', c));
    child.stderr.on('data', (c) => feed('stderr', c));
    const onAbort = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearInterval(ticker); signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
      for (const s of ['stdout', 'stderr']) if (onLine && partial[s].trim()) onLine(partial[s], s);
      if (signal?.aborted) return reject(new CancelledError());
      resolve({ code, stdout, stderr });
    });
  });
}

export const CLI_NOISE = /new version of Supabase CLI is available|recommend updating regularly|supabase\.com\/docs\/guides\/cli\/getting-started#updating/i;
