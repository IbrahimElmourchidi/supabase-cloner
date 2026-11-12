import { StepError, describe } from '../lib/errors.mjs';
import { dbConn, apiBase } from '../lib/conn.mjs';
import { withDb, schemaCounts } from '../lib/db.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { fetchStatus, encodePath } from '../lib/storage-api.mjs';
import { readJson, readJsonl, writeAtomic, qi, fmtBytes, throwIfCancelled } from '../lib/util.mjs';
import { hosts } from './common.mjs';
import { scanOldHost } from './b4_fix_links.mjs';

const VOLATILE = /^auth\.(audit_log_entries|refresh_tokens|sessions|mfa_amr_claims|flow_state|one_time_tokens)$/;

export default {
  id: 'b8',
  phase: 'B',
  num: 'B8',
  title: 'Verify the new project',
  desc: 'Compares old and new: rows per table, functions, triggers, policies, files per bucket, cron, Vault, edge functions, leftover old links, and a test image.',
  requires: ['b2'],
  always: true,
  writes: 'local',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const { oldHost } = hosts(cfg);
    const checks = [];
    const add = (group, name, ok, detail, level = 'error') => {
      checks.push({ group, name, ok, detail, level: ok ? 'ok' : level });
      (ok ? ctx.ok : ctx.warn)(`${ok ? 'OK  ' : 'FAIL'} ${group} — ${name}: ${detail}`);
    };
    const schemas = await readJson(paths.userSchemas);
    const { tables: oldRows } = await readJson(paths.rowCounts);
    const oldSchema = await readJson(paths.schemaCounts);
    const objects = await readJsonl(paths.objects);
    const jobs = await readJson(paths.cronJobs, []);
    const vault = await readJson(paths.vault, []);
    const queues = await readJson(paths.pgmqQueues, []);
    const conn = dbConn(cfg, 'new');

    let sampleUrl = null;
    await withDb(conn.pgUrl, async (c) => {
      ctx.log('Counting rows in the new database…');
      let same = 0;
      for (const [t, n] of Object.entries(oldRows)) {
        throwIfCancelled(ctx.signal);
        const [s, name] = t.split('.');
        let m;
        try {
          m = Number((await c.query(`select count(*)::bigint n from ${qi(s)}.${qi(name)}`)).rows[0].n);
        } catch (e) {
          add('Rows', t, false, `table missing: ${describe(e)}`);
          continue;
        }
        if (m === n) same++;
        else add('Rows', t, false, `old ${n}, new ${m}`, VOLATILE.test(t) ? 'warn' : 'error');
      }
      add('Rows', 'tables with the same row count', true, `${same} of ${Object.keys(oldRows).length}`);

      const newSchema = await schemaCounts(c, schemas);
      for (const [k, v] of Object.entries(oldSchema)) add('Schema', k, newSchema[k] === v, `old ${v}, new ${newSchema[k] ?? 0}`);

      const stor = (await c.query(`select bucket_id b, count(*)::int n, coalesce(sum((metadata->>'size')::bigint),0)::bigint bytes from storage.objects group by 1`)).rows;
      const byBucket = {};
      for (const o of objects) {
        byBucket[o.bucket_id] ||= { n: 0, bytes: 0 };
        byBucket[o.bucket_id].n++;
        byBucket[o.bucket_id].bytes += Number(o.metadata?.size || 0);
      }
      for (const [b, v] of Object.entries(byBucket)) {
        const got = stor.find((r) => r.b === b);
        const ok = got && got.n === v.n && Number(got.bytes) === v.bytes;
        add('Storage', b, Boolean(ok), `old ${v.n} files / ${fmtBytes(v.bytes)}, new ${got?.n ?? 0} files / ${fmtBytes(got?.bytes ?? 0)}`);
      }

      const left = await scanOldHost(c, schemas, oldHost, ctx.signal);
      add('Links', 'old address in columns', left.hits.length === 0,
        left.hits.length ? left.hits.map((h) => `${h.s}.${h.t}.${h.col} (${h.n})`).join(', ') : 'none left');
      add('Links', 'old address in functions', left.fns.length === 0,
        left.fns.length ? left.fns.map((f) => `${f.s}.${f.name}`).join(', ') : 'none left');

      if (jobs.length) {
        const have = (await c.query('select jobname, command from cron.job')).rows;
        const missing = jobs.filter((j) => j.jobname && !have.some((h) => h.jobname === j.jobname)).map((j) => j.jobname);
        add('Cron', 'jobs', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${have.length} jobs`);
        const oldCmd = have.filter((h) => h.command.includes(oldHost)).map((h) => h.jobname);
        add('Cron', 'old address in commands', oldCmd.length === 0, oldCmd.join(', ') || 'none');
      }
      if (vault.length) {
        const have = (await c.query('select name, decrypted_secret v from vault.decrypted_secrets')).rows;
        const missing = vault.filter((v) => !have.some((h) => h.name === v.name)).map((v) => v.name);
        add('Vault', 'secrets', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${vault.length} present`);
        const oldVals = have.filter((h) => String(h.v || '').includes(oldHost)).map((h) => h.name);
        add('Vault', 'old address in values', oldVals.length === 0, oldVals.join(', ') || 'none');
      }
      if (queues.length) {
        const have = (await c.query(`select queue_name from pgmq.meta`).catch(() => ({ rows: [] }))).rows.map((r) => r.queue_name);
        const missing = queues.filter((q) => !have.includes(q.queue_name)).map((q) => q.queue_name);
        add('Queues', 'pgmq', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : have.join(', '));
      }

      const pub = (await c.query(`select id from storage.buckets where public order by id`)).rows.map((r) => r.id);
      const sample = objects.find((o) => pub.includes(o.bucket_id) && !o.name.endsWith('.emptyFolderPlaceholder'));
      if (sample) sampleUrl = `${apiBase(cfg.new.ref)}/storage/v1/object/public/${encodeURIComponent(sample.bucket_id)}/${encodePath(sample.name)}`;
    }, ctx.signal);

    if (sampleUrl) {
      const status = await fetchStatus(sampleUrl, ctx.signal);
      add('Storage', 'public test file over HTTP', status === 200, `HTTP ${status} — ${sampleUrl}`);
    }

    try {
      const api = mgmt(cfg.pat, ctx.signal);
      const oldFns = await readJson(paths.functionsList, []);
      const newFns = await api.get(`/v1/projects/${cfg.new.ref}/functions`);
      const missing = oldFns.filter((f) => !newFns.some((n) => n.slug === f.slug)).map((f) => f.slug);
      add('Edge functions', 'deployed', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : newFns.map((f) => f.slug).join(', '));
      const jwt = oldFns.filter((f) => { const n = newFns.find((x) => x.slug === f.slug); return n && n.verify_jwt !== f.verify_jwt; }).map((f) => f.slug);
      add('Edge functions', 'verify_jwt same as old', jwt.length === 0, jwt.join(', ') || 'all the same');
      const oldSec = (await readJson(paths.functionSecrets, [])).map((s) => s.name).filter((n) => !/^SUPABASE_/.test(n));
      const newSec = (await api.get(`/v1/projects/${cfg.new.ref}/secrets`)).map((s) => s.name);
      const ms = oldSec.filter((n) => !newSec.includes(n));
      add('Edge functions', 'secrets', ms.length === 0, ms.length ? `missing: ${ms.join(', ')}` : oldSec.join(', ') || 'none needed');
    } catch (e) {
      add('Edge functions', 'Management API', false, describe(e), 'warn');
    }

    const errors = checks.filter((c) => c.level === 'error');
    const warns = checks.filter((c) => c.level === 'warn');
    const md = ['# Verify report', '', `Date: ${new Date().toISOString()}`, `Old: ${cfg.old.ref} → New: ${cfg.new.ref}`, '',
      `Result: ${errors.length} errors, ${warns.length} warnings`, '', '| Group | Check | Result | Detail |', '|---|---|---|---|',
      ...checks.map((c) => `| ${c.group} | ${c.name} | ${c.level.toUpperCase()} | ${String(c.detail).replace(/\|/g, '\\|')} |`)].join('\n');
    await writeAtomic(paths.report, md);
    ctx.log(`Report saved: ${paths.report}`);

    const summary = { checks };
    if (errors.length) {
      throw new StepError(`${errors.length} checks failed${warns.length ? `, ${warns.length} warnings` : ''}.`,
        'Look at the red rows. Re-run the step that owns them (rows → B2, files → B3, links → B4, functions → B5, cron/Vault → B7), then run B8 again.',
        { summary });
    }
    return summary;
  },
};
