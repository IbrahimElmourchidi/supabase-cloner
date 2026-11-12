import fsp from 'node:fs/promises';
import path from 'node:path';
import { StepError } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb, userSchemas, schemaCounts, countedTables } from '../lib/db.mjs';
import { ensureDir, writeJson, writeAtomic, lastLines, qi, fmtBytes, throwIfCancelled } from '../lib/util.mjs';
import { supabaseCli } from './common.mjs';

const CMD = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };

async function dump(ctx, url, file, extra, label) {
  const tmp = `${file}.part`;
  await ctx.checkpoint();
  await fsp.rm(tmp, { force: true });
  ctx.log(`Dumping ${label}…`);
  const r = await supabaseCli(ctx, ['db', 'dump', '--db-url', url, '-f', tmp, ...extra],
    { cwd: path.dirname(file), watchFile: tmp, label: `dump ${label}`, probeUrl: url });
  if (r.code !== 0) {
    throw new StepError(`supabase db dump failed for ${label}.`, null, { detail: lastLines(r.stderr || r.stdout, 25) });
  }
  const size = (await fsp.stat(tmp).catch(() => ({ size: 0 }))).size;
  if (size === 0) throw new StepError(`The ${label} dump is empty.`, 'Check the log. Docker must be running.');
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600);
  ctx.ok(`${label}: ${path.basename(file)} (${fmtBytes(size)})`);
}

async function buildExtras(c, schemas) {
  const out = ['-- Triggers and policies on the auth and storage schemas.', '-- The standard schema dump leaves these out.', ''];
  const trg = await c.query(`
    select n.nspname s, c.relname t, tg.tgname name, tg.tgenabled enabled, pg_get_triggerdef(tg.oid) def
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = tg.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
     where not tg.tgisinternal and n.nspname in ('auth','storage') and pn.nspname = any($1)
     order by 1, 2, 3`, [schemas]);
  for (const r of trg.rows) {
    out.push(`DROP TRIGGER IF EXISTS ${qi(r.name)} ON ${qi(r.s)}.${qi(r.t)};`);
    out.push(`${r.def};`);
    if (r.enabled === 'D') out.push(`ALTER TABLE ${qi(r.s)}.${qi(r.t)} DISABLE TRIGGER ${qi(r.name)};`);
    out.push('');
  }
  const pol = await c.query(`
    select pol.polname name, n.nspname s, c.relname t, pol.polpermissive permissive, pol.polcmd cmd,
           case when pol.polroles = '{0}'::oid[] then array['public']
                else array(select rolname::text from pg_roles where oid = any(pol.polroles) order by rolname) end roles,
           pg_get_expr(pol.polqual, pol.polrelid) qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) wc
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('auth','storage')
     order by 2, 3, 1`);
  for (const r of pol.rows) {
    const roles = r.roles.map((x) => (x === 'public' ? 'PUBLIC' : qi(x))).join(', ');
    let sql = `CREATE POLICY ${qi(r.name)} ON ${qi(r.s)}.${qi(r.t)} AS ${r.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${CMD[r.cmd] || 'ALL'} TO ${roles}`;
    if (r.qual) sql += ` USING (${r.qual})`;
    if (r.wc) sql += ` WITH CHECK (${r.wc})`;
    out.push(`DROP POLICY IF EXISTS ${qi(r.name)} ON ${qi(r.s)}.${qi(r.t)};`, `${sql};`, '');
  }
  return { sql: out.join('\n'), triggers: trg.rowCount, policies: pol.rowCount };
}

export default {
  id: 'a1',
  phase: 'A',
  num: 'A1',
  title: 'Back up the database',
  desc: 'Saves roles, schema (tables, functions, triggers, RLS), all data, auth users, cron jobs, and the counts used later to verify.',
  requires: ['a0'],
  writes: 'local',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const conn = dbConn(cfg, 'old');
    await ensureDir(paths.db);

    ctx.log('Reading the old database structure…');
    const meta = await withDb(conn.pgUrl, async (c) => {
      const schemas = await userSchemas(c);
      const excluded = (await c.query(`
        select schemaname || '.' || tablename x from pg_tables
         where schemaname <> all($1) and schemaname <> 'auth'
           and not (schemaname = 'storage' and tablename = 'buckets')
           and schemaname not like 'pg\\_%' and schemaname <> 'information_schema'
         order by 1`, [schemas])).rows.map((r) => r.x);
      const extensions = (await c.query(`
        select e.extname name, e.extversion version, n.nspname schema, e.extrelocatable relocatable
          from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1`)).rows;
      const hasCron = extensions.some((e) => e.name === 'pg_cron');
      const hasPgmq = extensions.some((e) => e.name === 'pgmq');
      const cron = hasCron ? (await c.query(`select jobid, jobname, schedule, command, database, username, active from cron.job order by jobid`)).rows : [];
      const queues = hasPgmq ? (await c.query(`select * from pgmq.meta order by queue_name`)).rows : [];
      const hasMigrations = (await c.query(`select to_regclass('supabase_migrations.schema_migrations') is not null x`)).rows[0].x;
      const extras = await buildExtras(c, schemas);
      return { schemas, excluded, extensions, cron, queues, hasMigrations, extras };
    }, ctx.signal);

    ctx.log(`User schemas: ${meta.schemas.join(', ')}`);
    ctx.log(`Left out of the data dump (recreated on purpose later): ${meta.excluded.length} platform tables (cron, net, pgmq, storage internals…).`);
    await writeJson(paths.userSchemas, meta.schemas);
    await writeJson(paths.excluded, meta.excluded);
    await writeJson(paths.extensions, meta.extensions);
    await writeJson(paths.cronJobs, meta.cron);
    await writeJson(paths.pgmqQueues, meta.queues);
    await writeAtomic(paths.extras, meta.extras.sql);
    ctx.ok(`extras.sql: ${meta.extras.triggers} auth/storage triggers, ${meta.extras.policies} storage/auth policies.`);
    ctx.ok(`${meta.cron.length} cron jobs, ${meta.extensions.length} extensions, ${meta.queues.length} pgmq queues saved.`);

    throwIfCancelled(ctx.signal);
    await dump(ctx, conn.cliUrl, paths.roles, ['--role-only'], 'roles');
    await dump(ctx, conn.cliUrl, paths.schema, [], 'schema');
    const ex = meta.excluded.flatMap((t) => ['-x', t]);
    await dump(ctx, conn.cliUrl, paths.data, ['--data-only', '--use-copy', ...ex], 'data');
    if (meta.hasMigrations) {
      try {
        await dump(ctx, conn.cliUrl, paths.migSchema, ['--schema', 'supabase_migrations'], 'migration history (schema)');
        await dump(ctx, conn.cliUrl, paths.migData, ['--data-only', '--use-copy', '--schema', 'supabase_migrations'], 'migration history (data)');
      } catch (e) {
        ctx.warn(`Migration history was not saved (not required): ${e.message}`);
      }
    }

    await ctx.checkpoint();
    ctx.log('Counting rows in every table (used by the final check)…');
    const counts = await withDb(conn.pgUrl, async (c) => {
      const tables = await countedTables(c, meta.schemas);
      const rows = {};
      for (const t of tables) {
        throwIfCancelled(ctx.signal);
        rows[`${t.s}.${t.t}`] = (await c.query(`select count(*)::bigint n from ${qi(t.s)}.${qi(t.t)}`)).rows[0].n;
      }
      return { rows, schema: await schemaCounts(c, meta.schemas) };
    }, ctx.signal);
    const rowCounts = Object.fromEntries(Object.entries(counts.rows).map(([k, v]) => [k, Number(v)]));
    await writeJson(paths.rowCounts, { countedAt: new Date().toISOString(), tables: rowCounts });
    await writeJson(paths.schemaCounts, counts.schema);
    const total = Object.values(rowCounts).reduce((a, b) => a + b, 0);
    ctx.ok(`${Object.keys(rowCounts).length} tables, ${total.toLocaleString('en-US')} rows counted.`);

    return {
      Tables: Object.keys(rowCounts).length,
      Rows: total.toLocaleString('en-US'),
      ...Object.fromEntries(Object.entries(counts.schema).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v])),
      'Cron jobs': meta.cron.length,
    };
  },
};
