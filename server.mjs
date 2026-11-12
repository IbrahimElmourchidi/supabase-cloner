import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, loadConfig, getConfig, updateConfig, forgetSecrets, publicConfig,
  listJobs, createJob, openJob, currentJobPaths,
} from './lib/config.mjs';
import { loadState, allSteps } from './lib/state.mjs';
import { STEPS } from './steps/index.mjs';
import { secretsForm } from './lib/needed-secrets.mjs';
import { StepError } from './lib/errors.mjs';
import * as bus from './lib/bus.mjs';
import * as runner from './lib/runner.mjs';
import { testSide } from './lib/checks.mjs';
import { scrub } from './lib/scrub.mjs';
import { describe } from './lib/errors.mjs';
import { startHeartbeat, agentStatus, writeStopped } from './lib/heartbeat.mjs';

const PORT = Number(process.env.PORT || 4545);
const HOST = '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function activateJob() {
  const p = currentJobPaths();
  loadState(p.state);
  bus.useLogDir(p.logs);
}

await loadConfig();
activateJob();

process.on('unhandledRejection', (e) => console.error('[unhandled]', scrub(describe(e))));
process.on('uncaughtException', (e) => console.error('[uncaught]', scrub(describe(e))));

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('Request too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function fullState() {
  return { config: publicConfig(), jobs: listJobs(), steps: runner.stepsView(), running: runner.runningInfo() };
}

function requireIdle(what) {
  const r = runner.runningInfo();
  if (r.step || r.phase) throw new StepError(`Cannot ${what} while a step or phase is running. Wait, or press Stop first.`);
}

/** A clone belongs to one pair of projects: once a step has run, its refs cannot change. */
function checkRefLock(body) {
  const cfg = getConfig();
  const states = allSteps();
  const started = (phase) => STEPS.some((m) => m.phase === phase && states[m.id] && states[m.id].status !== 'idle');
  for (const [side, phase, did] of [['old', 'A', 'has a backup of'], ['new', 'B', 'already wrote to']]) {
    const v = body?.[side]?.ref;
    if (typeof v !== 'string' || !cfg[side].ref || v.trim() === cfg[side].ref) continue;
    if (started(phase)) {
      throw new StepError(`This clone ${did} project ${cfg[side].ref}, so its ${side.toUpperCase()} project ref cannot change.`,
        'To work with another project, press "New clone" at the top of the page.');
    }
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const routes = {
  'GET /api/state': async () => fullState(),
  'GET /api/logs': async (req) => {
    const step = new URL(req.url, 'http://x').searchParams.get('step');
    return { step, lines: bus.getLogs(step) };
  },
  'POST /api/config': async (req, body) => {
    checkRefLock(body);
    await updateConfig(body);
    runner.broadcast();
    return fullState();
  },
  'POST /api/config/forget': async () => {
    await forgetSecrets();
    return fullState();
  },
  'GET /api/secrets': async () => secretsForm(getConfig()),
  'POST /api/jobs': async (req, body) => {
    requireIdle('start a new clone');
    const id = await createJob(String(body?.name || '').trim() || `clone ${new Date().toISOString().slice(0, 10)}`);
    await openJob(id);
    activateJob();
    runner.broadcast();
    return fullState();
  },
  'POST /api/jobs/open': async (req, body) => {
    requireIdle('switch clones');
    await openJob(String(body?.id || ''));
    activateJob();
    runner.broadcast();
    return fullState();
  },
  'POST /api/test': async (req, body) => {
    if (!['old', 'new'].includes(body.side)) throw new Error('side must be old or new');
    return { side: body.side, results: await testSide(getConfig(), body.side) };
  },
  'POST /api/run': async (req, body) => {
    runner.preflight(body.step);
    runner.runStep(body.step).catch(() => {});
    return { started: body.step };
  },
  'POST /api/run-phase': async (req, body) => {
    if (!['A', 'B'].includes(body.phase)) throw new Error('phase must be A or B');
    runner.runPhase(body.phase).catch((e) => bus.log('server', 'error', describe(e)));
    return { started: body.phase };
  },
  'POST /api/cancel': async () => { runner.cancel(); return { ok: true }; },
  'GET /api/agent/status': async (req) => {
    if (new URL(req.url, 'http://x').searchParams.get('agent') === '1') bus.markAgentCheck();
    return agentStatus();
  },
  'POST /api/pause': async (req, body) => {
    const by = body.by === 'agent' ? 'agent' : 'user';
    runner.requestPause(body.reason || `Paused by the ${by}`, by);
    return agentStatus();
  },
  'POST /api/resume': async (req, body) => {
    runner.resume(body.by === 'agent' ? 'agent' : 'user');
    return agentStatus();
  },
  'POST /api/reset': async (req, body) => { runner.reset(body.step); return fullState(); },
};

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden origin' });
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'JSON only' });
  }
  const pathname = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'state', ...fullState() })}\n\n`);
    bus.addClient(res);
    return;
  }
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) {
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res);
    return send(res, 404, { error: 'Not found' });
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    send(res, 200, await handler(req, body));
  } catch (e) {
    send(res, 400, { error: scrub(describe(e)), hint: e.hint ? scrub(e.hint) : null });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Is the cloner already running? Open http://127.0.0.1:${PORT} or start with PORT=4546 npm start.`);
    process.exit(1);
  }
  console.error(scrub(describe(e)));
});

server.listen(PORT, HOST, () => {
  startHeartbeat(`http://127.0.0.1:${PORT}`);
  console.log(`Supabase Cloner: open http://127.0.0.1:${PORT}`);
  console.log('Watcher: node ctl.mjs status | wait | pause | resume | logs <step>   (see AGENT_WATCH.md)');
  console.log(`Current clone: ${getConfig().job.name} (${getConfig().job.dir})`);
  console.log('Press Ctrl+C to stop. Finished work is kept.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    runner.cancel();
    setTimeout(() => { writeStopped(); process.exit(0); }, 500);
  });
}
