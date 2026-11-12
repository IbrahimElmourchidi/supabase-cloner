import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { StepError, describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { ensureDir, readJson, exists } from '../lib/util.mjs';
import { psqlTransaction } from './common.mjs';

/** Copies a SQL file line by line and comments out lines that a Supabase project refuses. */
async function prepare(src, dest, rules) {
  await ensureDir(path.dirname(dest));
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
  let changed = 0;
  for await (const line of rl) {
    if (rules.some((re) => re.test(line))) { out.write(`-- [migrator] ${line}\n`); changed++; }
    else out.write(`${line}\n`);
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  return changed;
}

export default {
  id: 'b2',
  phase: 'B',
  num: 'B2',
  title: 'Restore the database',
  desc: 'Loads roles, schema and all data in ONE transaction (all or nothing), then auth/storage triggers and policies, pgmq queues and the migration history.',
  requires: ['b1'],
  writes: 'new',
  confirm: 'This loads the whole database into the NEW project. Continue?',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const conn = dbConn(cfg, 'new');
    const schemas = await readJson(paths.userSchemas);
    const sub = ctx.sub();

    if (!sub.core) {
      const tables = await withDb(conn.pgUrl, async (c) =>
        (await c.query('select count(*)::int n from pg_tables where schemaname = any($1)', [schemas])).rows[0].n, ctx.signal);
      if (tables > 0) {
        throw new StepError(`The new database already has ${tables} tables in the app schemas, but this tool has not restored it.`,
          'Use a fresh project, or remove those tables in the new project, then run B2 again.');
      }
      ctx.log('Preparing SQL files (commenting out statements Supabase refuses)…');
      const roles = path.join(paths.prepared, 'roles.sql');
      const schema = path.join(paths.prepared, 'schema.sql');
      const n1 = await prepare(paths.roles, roles, [/^GRANT "postgres" TO "cli_login_postgres"/]);
      const n2 = await prepare(paths.schema, schema, [/^ALTER .* OWNER TO "supabase_admin";\s*$/]);
      ctx.log(`Commented out ${n1} lines in roles.sql and ${n2} lines in schema.sql.`);

      ctx.log('Restoring roles + schema + data as one transaction. This can take several minutes…');
      const parts = [];
      if (await exists(paths.roles)) parts.push({ file: roles });
      parts.push({ file: schema }, { sql: 'SET session_replication_role = replica' }, { file: paths.data });
      await psqlTransaction(ctx, conn.psqlUrl, parts, 'Restore');
      ctx.setSub('core', new Date().toISOString());
      ctx.ok('Roles, schema and data restored.');
    } else {
      ctx.log('Roles, schema and data were restored in an earlier run — skipping.');
    }

    await ctx.checkpoint();
    ctx.log('Restoring auth/storage triggers and storage policies (extras.sql)…');
    await psqlTransaction(ctx, conn.psqlUrl, [{ file: paths.extras }], 'Auth/storage extras');
    ctx.setSub('extras', new Date().toISOString());
    ctx.ok('Triggers on auth.users and storage policies restored.');

    await ctx.checkpoint();
    const queues = await readJson(paths.pgmqQueues, []);
    if (queues.length) {
      ctx.log(`Creating ${queues.length} pgmq queues…`);
      await withDb(conn.pgUrl, async (c) => {
        for (const q of queues) {
          try {
            if (q.is_partitioned) {
              ctx.warn(`Queue ${q.queue_name} is partitioned. Create it by hand with pgmq.create_partitioned.`);
              continue;
            }
            await c.query(q.is_unlogged ? 'select pgmq.create_unlogged($1)' : 'select pgmq.create($1)', [q.queue_name]);
            ctx.ok(`Queue ${q.queue_name} ready (old messages are not copied).`);
          } catch (e) {
            if (/already exists/i.test(e.message)) ctx.log(`Queue ${q.queue_name} already exists.`);
            else throw new StepError(`Could not create pgmq queue ${q.queue_name}: ${describe(e)}`);
          }
        }
      }, ctx.signal);
    }
    ctx.setSub('pgmq', new Date().toISOString());

    await ctx.checkpoint();
    if (!sub.history && await exists(paths.migSchema) && await exists(paths.migData)) {
      try {
        await psqlTransaction(ctx, conn.psqlUrl, [{ file: paths.migSchema }, { file: paths.migData }], 'Migration history');
        ctx.setSub('history', new Date().toISOString());
        ctx.ok('Migration history restored.');
      } catch (e) {
        ctx.warn(`Migration history not restored (not required): ${e.message}`);
      }
    }

    const counts = await withDb(conn.pgUrl, async (c) => ({
      tables: (await c.query('select count(*)::int n from pg_tables where schemaname = any($1)', [schemas])).rows[0].n,
      users: (await c.query('select count(*)::int n from auth.users')).rows[0].n,
      buckets: (await c.query('select count(*)::int n from storage.buckets')).rows[0].n,
    }), ctx.signal);
    await fsp.rm(paths.prepared, { recursive: true, force: true }).catch(() => {});
    return { Tables: counts.tables, 'Auth users': counts.users, Buckets: counts.buckets };
  },
};
