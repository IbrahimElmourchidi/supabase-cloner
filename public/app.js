const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_TEXT = {
  idle: 'Not run', running: 'Running…', done: 'Done', failed: 'Failed',
  cancelled: 'Stopped', interrupted: 'Interrupted', paused: 'Paused', pausing: 'Pausing…',
};
const SECRET_FIELDS = ['old.dbPassword', 'old.secretKey', 'new.dbPassword', 'new.secretKey', 'pat'];
const isSecret = (name) => SECRET_FIELDS.includes(name) || name.startsWith('secrets.');

let state = { steps: [], running: {}, config: null, jobs: [] };
let logStep = null;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.hint = data.hint;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  const s = $('#saved');
  s.textContent = msg;
  s.style.color = isError ? 'var(--err)' : '';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { s.textContent = ''; }, 6000);
}

/* ---------- credentials form ---------- */

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

function fillForm(cfg) {
  const form = $('#cfg');
  for (const input of $$('input, select, textarea', form)) {
    const name = input.name;
    if (!name) continue;
    if (isSecret(name)) {
      input.value = '';
      input.placeholder = cfg.has[name] ? 'saved — leave empty to keep' : '';
    } else if (input.type === 'checkbox') {
      input.checked = Boolean(getPath(cfg, name));
    } else {
      const v = getPath(cfg, name);
      if (document.activeElement !== input) input.value = v ?? '';
    }
  }
  lockRefs();
}

/** A clone belongs to one pair of projects: once a phase has started, its project ref is fixed. */
function lockRefs() {
  const started = (phase) => state.steps.some((s) => s.phase === phase && s.status !== 'idle');
  for (const [side, phase] of [['old', 'A'], ['new', 'B']]) {
    const input = $(`#cfg [name="${side}.ref"]`);
    const locked = started(phase) && Boolean(state.config?.[side]?.ref);
    input.readOnly = locked;
    input.title = locked ? 'Fixed for this clone. Press "New clone" to work with another project.' : '';
  }
}

function formData() {
  const out = {};
  for (const input of $$('#cfg input, #cfg select, #cfg textarea')) {
    if (!input.name) continue;
    const value = input.type === 'checkbox' ? input.checked : input.value;
    const keys = input.name.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) o = o[k] ||= {};
    o[keys.at(-1)] = value;
  }
  return out;
}

async function saveForm() {
  const data = await api('/api/config', formData());
  state.config = data.config;
  fillForm(data.config);
  renderSecrets(true);
  return data;
}

/* ---------- secrets the new project needs ---------- */

let secretsKey = null;

function secretField(kind, item) {
  const name = `secrets.${kind}.${item.name}`;
  const hint = kind === 'auth'
    ? (item.why === 'fingerprint' ? 'login setting — the API gives only a fingerprint of it' : 'login setting — the API does not return it')
    : (item.from ? `edge function secret — found in the backup (${item.from}); leave empty to use it` : 'edge function secret — the API cannot read it back');
  return el('label', {}, item.name, ' ', el('small', {}, hint),
    el('textarea', { name, rows: '2', spellcheck: 'false', placeholder: item.has ? 'saved — leave empty to keep' : '' }));
}

async function renderSecrets(force = false) {
  let data;
  try { data = await api('/api/secrets'); } catch { return; }
  const key = JSON.stringify([state.config?.job?.id, data]);
  if (!force && key === secretsKey) return;
  secretsKey = key;
  const items = [...data.functions.map((f) => secretField('functions', f)), ...data.auth.map((a) => secretField('auth', a))];
  $('#secrets-note').textContent = !data.ready
    ? 'This list appears after A3 has backed up the old project. It shows every secret the new project needs that Supabase cannot copy.'
    : items.length
      ? 'Every value here is needed: B5 and B6 stop until each one is set. Values that span several lines (like JSON) are fine.'
      : 'The old project has no secrets that need a value here.';
  $('#secret-list').replaceChildren(...items);
}

/* ---------- clones (jobs) ---------- */

function renderJobs() {
  const job = state.config?.job;
  const sel = $('#job');
  sel.replaceChildren(...state.jobs.map((j) => el('option', { value: j.id, selected: j.id === job?.id },
    `${j.name}${j.oldRef || j.newRef ? ` (${j.oldRef || '?'} → ${j.newRef || '?'})` : ''}`)));
  $('#job-dir').textContent = job ? `folder: ${job.dir}` : '';
  const busy = Boolean(state.running?.step || state.running?.phase);
  sel.disabled = busy;
  $('#new-job').disabled = busy;
}

function showJob(data) {
  state.config = data.config;
  state.jobs = data.jobs;
  state.steps = data.steps;
  state.running = data.running;
  for (const id of ['test-old', 'test-new']) $(`#${id}`).replaceChildren();
  fillForm(data.config);
  renderJobs();
  renderSteps();
  renderManual();
  renderSecrets(true);
  $('#logpanel').hidden = true;
  logStep = null;
}

$('#job').addEventListener('change', async (e) => {
  const id = e.target.value;
  try {
    showJob(await api('/api/jobs/open', { id }));
    toast('Clone opened. Type its secrets again unless they were remembered.');
  } catch (err) { alert(err.message); renderJobs(); }
});

$('#new-job').addEventListener('click', async () => {
  const name = prompt('Name of the new clone (for example: shop to EU):', '');
  if (name === null) return;
  try { showJob(await api('/api/jobs', { name })); toast('New clone created. Fill in both projects.'); } catch (err) { alert(err.message); }
});

$('#cfg').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await saveForm(); toast('Saved.'); } catch (err) { toast(err.message, true); }
});

$('#forget').addEventListener('click', async () => {
  if (!confirm('Remove all saved secrets from memory and from disk?')) return;
  try {
    const data = await api('/api/config/forget', {});
    fillForm(data.config);
    toast('Secrets forgotten.');
  } catch (err) { toast(err.message, true); }
});

for (const btn of $$('[data-test]')) {
  btn.addEventListener('click', async () => {
    const side = btn.dataset.test;
    const list = $(`#test-${side}`);
    list.replaceChildren(el('li', {}, 'Testing…'));
    btn.disabled = true;
    try {
      await saveForm();
      const { results } = await api('/api/test', { side });
      list.replaceChildren(...results.map((r) =>
        el('li', { class: r.ok ? 'ok' : 'bad' }, `${r.ok ? '✓' : '✗'} ${r.label}: ${r.detail}`)));
    } catch (err) {
      list.replaceChildren(el('li', { class: 'bad' }, `✗ ${err.message}`));
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- steps ---------- */

function fmtBytes(n) {
  let v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

function progressNode(p) {
  if (!p || !p.total) return null;
  const pct = Math.min(100, (p.done / p.total) * 100);
  const parts = [`${fmtNum(p.done)} / ${fmtNum(p.total)} ${p.label || ''}`];
  if (p.totalBytes) parts.push(`${fmtBytes(p.bytes)} / ${fmtBytes(p.totalBytes)}`);
  if (p.skipped) parts.push(`${fmtNum(p.skipped)} already there`);
  if (p.failed) parts.push(`${fmtNum(p.failed)} failed`);
  const bar = el('div', { class: 'bar' });
  bar.style.width = `${pct.toFixed(1)}%`;
  return el('div', { class: 'progress' },
    el('div', { class: 'track' }, bar),
    el('div', { class: 'ptext' }, `${pct.toFixed(1)}% · ${parts.join(' · ')}`));
}

function summaryNode(summary) {
  if (!summary) return null;
  if (Array.isArray(summary.checks)) {
    const rows = [...summary.checks].sort((a, b) => ({ error: 0, warn: 1, ok: 2 }[a.level] - { error: 0, warn: 1, ok: 2 }[b.level]));
    return el('div', { class: 'vtable-wrap' }, el('table', { class: 'vtable' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Group'), el('th', {}, 'Check'), el('th', {}, 'Result'), el('th', {}, 'Detail'))),
      el('tbody', {}, rows.map((c) => el('tr', {},
        el('td', {}, c.group), el('td', {}, c.name),
        el('td', { class: `r-${c.level}` }, c.level === 'ok' ? 'OK' : c.level === 'warn' ? 'WARN' : 'FAIL'),
        el('td', {}, String(c.detail)))))));
  }
  return el('dl', { class: 'summary' }, Object.entries(summary).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]));
}

function errorNode(error) {
  if (!error) return null;
  return el('div', { class: 'errbox' },
    el('strong', {}, error.message),
    error.hint ? el('div', { class: 'hint' }, `What to do: ${error.hint}`) : null,
    error.detail ? el('pre', {}, error.detail) : null);
}

function shownStatus(s) {
  const p = state.running?.pause;
  if (p && p.step === s.id && (s.status === 'running' || p.kind === 'failed')) return p.state;
  return s.status;
}

function stepNode(s) {
  const status = shownStatus(s);
  const busy = Boolean(state.running?.step || state.running?.phase);
  const doneIds = new Set(state.steps.filter((x) => x.status === 'done').map((x) => x.id));
  const missing = s.requires.filter((r) => !doneIds.has(r));
  const nums = Object.fromEntries(state.steps.map((x) => [x.id, x.num]));
  const isRunning = s.status === 'running';
  const tag = s.writes === 'new' ? el('span', { class: 'tag tag-write' }, 'writes to NEW')
    : s.writes === 'local' ? el('span', { class: 'tag tag-local' }, 'writes to backup folder') : null;
  return el('li', { class: `step s-${status}`, 'data-id': s.id },
    el('div', { class: 'step-head' },
      el('span', { class: 'num' }, s.num),
      el('div', { class: 'info' },
        el('div', { class: 'title' }, s.title, ' ', tag),
        el('div', { class: 'desc' }, s.desc),
        missing.length && s.status !== 'done' ? el('div', { class: 'needs' }, `Needs: ${missing.map((m) => nums[m]).join(', ')}`) : null),
      el('span', { class: `status st-${status}` }, STATUS_TEXT[status] || status)),
    isRunning || s.status !== 'done' ? progressNode(s.progress) : null,
    s.status === 'done' || s.summary ? summaryNode(s.summary) : null,
    s.status !== 'done' ? errorNode(s.error) : null,
    el('div', { class: 'btns' },
      el('button', {
        type: 'button', class: s.status === 'done' ? 'secondary' : 'primary',
        disabled: busy || missing.length > 0,
        onclick: () => runStep(s),
      }, s.status === 'done' ? 'Run again' : (s.status === 'idle' ? 'Run' : 'Run again / continue')),
      isRunning ? el('button', { type: 'button', class: 'danger', onclick: stop }, 'Stop') : null,
      el('button', { type: 'button', class: 'secondary', onclick: () => openLog(s) }, 'Show log'),
      s.status !== 'idle' && !isRunning ? el('button', {
        type: 'button', class: 'secondary', disabled: busy,
        onclick: () => resetStep(s),
      }, 'Mark as not run') : null));
}

function renderSteps() {
  for (const phase of ['A', 'B']) {
    $(`#steps-${phase}`).replaceChildren(...state.steps.filter((s) => s.phase === phase).map(stepNode));
  }
  const busy = Boolean(state.running?.step || state.running?.phase);
  for (const b of $$('[data-phase]')) b.disabled = busy;
  $('#stop').hidden = !busy;
  lockRefs();
  renderJobs();
  renderPause();
  renderWatcher();
}

function renderPause() {
  const busy = Boolean(state.running?.step || state.running?.phase);
  const p = state.running?.pause;
  $('#pause').hidden = !busy || Boolean(p);
  $('#resume').hidden = !p;
  $('#pausebar').hidden = !p;
  if (!p) return;
  const num = state.steps.find((x) => x.id === p.step)?.num || p.step;
  $('#pause-title').textContent = p.state === 'paused'
    ? `Paused at ${num} (by ${p.by})`
    : `Pausing at ${num} — the work in progress finishes first`;
  $('#pause-reason').textContent = p.kind === 'failed'
    ? `${p.reason.replace(/\.$/, "")}. Fix the cause, then press Resume: the step runs again and the phase continues.`
    : `${p.reason.replace(/\.$/, "")}. Fix the cause, then press Resume.`;
}

function renderWatcher() {
  const at = state.running?.watcherAt;
  const pill = $('#watcher');
  if (!at) { pill.className = 'pill pill-wait'; pill.textContent = 'no watcher'; return; }
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  const ago = sec < 90 ? `${sec}s` : `${Math.round(sec / 60)}m`;
  pill.className = `pill ${sec < 600 ? 'pill-ok' : 'pill-wait'}`;
  pill.textContent = `watcher checked ${ago} ago`;
}
setInterval(renderWatcher, 5000);

$('#pause').addEventListener('click', async () => {
  try { await api('/api/pause', { reason: 'Paused from the page', by: 'user' }); } catch (err) { alert(err.message); }
});
$('#resume').addEventListener('click', async () => {
  const p = state.running?.pause;
  const msg = p?.kind === 'failed'
    ? 'Resume? The failed step runs again, then the phase continues.'
    : 'Resume the run?';
  if (!confirm(msg)) return;
  try { await api('/api/resume', { by: 'user' }); } catch (err) { alert(err.message); }
});
$('#pause-on-error').addEventListener('change', async (e) => {
  try {
    const data = await api('/api/config', { pauseOnError: e.target.checked });
    state.config = data.config;
  } catch (err) { alert(err.message); e.target.checked = !e.target.checked; }
});

function updateProgress(stepId, p) {
  const s = state.steps.find((x) => x.id === stepId);
  if (!s) return;
  s.progress = p;
  const li = $(`.step[data-id="${stepId}"]`);
  if (!li) return;
  const old = $('.progress', li);
  const next = progressNode(p);
  if (old && next) old.replaceWith(next);
  else if (next) $('.step-head', li).after(next);
}

async function runStep(s) {
  if (s.confirm && !confirm(`${s.num}: ${s.confirm}\n\nNew project: ${state.config?.new?.ref}`)) return;
  try {
    await saveForm();
    await api('/api/run', { step: s.id });
    openLog(s);
  } catch (err) {
    alert(`${err.message}${err.hint ? `\n\n${err.hint}` : ''}`);
  }
}

async function stop() {
  await api('/api/cancel', {}).catch(() => {});
}

async function resetStep(s) {
  if (!confirm(`Mark ${s.num} as not run? Files and data are not deleted. Steps that need it will wait until it runs again.`)) return;
  try { await api('/api/reset', { step: s.id }); } catch (err) { alert(err.message); }
}

for (const b of $$('[data-phase]')) {
  b.addEventListener('click', async () => {
    const phase = b.dataset.phase;
    const msg = phase === 'A'
      ? 'Run all unfinished steps of phase A? It only reads from the old project.'
      : `Run all unfinished steps of phase B? This writes to the NEW project (${state.config?.new?.ref}).`;
    if (!confirm(msg)) return;
    try {
      await saveForm();
      await api('/api/run-phase', { phase });
    } catch (err) { alert(err.message); }
  });
}
$('#stop').addEventListener('click', stop);

/* ---------- log panel ---------- */

function logLine(l) {
  const t = new Date(l.ts).toLocaleTimeString();
  return el('span', { class: `l-${l.level}` }, `${t}  ${l.msg}\n`);
}

async function openLog(s) {
  logStep = s.id;
  $('#log-title').textContent = `Log — ${s.num} ${s.title}`;
  $('#logpanel').hidden = false;
  const { lines } = await api(`/api/logs?step=${encodeURIComponent(s.id)}`);
  if (logStep !== s.id) return;
  $('#log').replaceChildren(...lines.map(logLine));
  scrollLog();
}

function scrollLog() {
  if ($('#log-follow').checked) $('#log').scrollTop = $('#log').scrollHeight;
}

$('#log-close').addEventListener('click', () => { $('#logpanel').hidden = true; logStep = null; });

/* ---------- manual steps ---------- */

function renderManual() {
  const newRef = state.config?.new?.ref || '<new-ref>';
  const items = [
    ['oauth', `Each OAuth provider you use (Google, Apple, GitHub…): add the redirect URL https://${newRef}.supabase.co/auth/v1/callback in its console.`],
    ['secrets', 'Any auth setting that B6 reports as refused: set it by hand in the new dashboard.'],
    ['apps', 'Point your apps at the new project: its URL and its publishable key.'],
    ['users', 'Users sign in again (sessions of the old project do not work on the new one).'],
    ['oldcron', 'After your apps use the new project: pause the cron jobs in the OLD project (SQL: update cron.job set active = false;) so both projects do not run them.'],
    ['delete', 'Only after everything works on the new project: delete the old project, then this clone folder (it holds personal data).'],
  ];
  const key = `manual:${state.config?.job?.id || ''}`;
  let done = {};
  try { done = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* storage blocked */ }
  $('#manual').replaceChildren(...items.map(([id, text]) => el('li', {}, el('label', {},
    el('input', {
      type: 'checkbox', checked: Boolean(done[id]),
      onchange: (e) => {
        done[id] = e.target.checked;
        try { localStorage.setItem(key, JSON.stringify(done)); } catch { /* ignore */ }
      },
    }), el('span', {}, text)))));
}

/* ---------- live updates ---------- */

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#conn').className = 'pill pill-ok'; $('#conn').textContent = 'connected'; };
  es.onerror = () => { $('#conn').className = 'pill pill-err'; $('#conn').textContent = 'reconnecting… (is the tool running?)'; };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'state') {
      const a3Before = state.steps.find((x) => x.id === 'a3')?.status;
      if (ev.jobs) state.jobs = ev.jobs;
      state.steps = ev.steps;
      state.running = ev.running;
      if (ev.config) {
        const jobChanged = state.config?.job?.id !== ev.config.job?.id;
        state.config = ev.config;
        if (jobChanged) { fillForm(ev.config); renderManual(); renderSecrets(true); }
        $('#pause-on-error').checked = Boolean(ev.config.pauseOnError);
      }
      renderSteps();
      if (state.steps.find((x) => x.id === 'a3')?.status !== a3Before) renderSecrets();
    } else if (ev.type === 'watcher') {
      state.running = { ...state.running, watcherAt: ev.at };
      renderWatcher();
    } else if (ev.type === 'progress') {
      updateProgress(ev.step, ev);
    } else if (ev.type === 'log' && ev.step === logStep) {
      $('#log').append(logLine(ev));
      scrollLog();
    }
  };
}

connect();
