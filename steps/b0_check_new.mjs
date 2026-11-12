import { StepError } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb, userSchemas } from '../lib/db.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { checkStorageKey } from '../lib/storage-key.mjs';
import { readJson } from '../lib/util.mjs';
import { isDone } from '../lib/state.mjs';
import { requireFields, requirePat, checkTool } from './common.mjs';

export default {
  id: 'b0',
  phase: 'B',
  num: 'B0',
  title: 'Check the new project',
  desc: 'Tests the new project credentials, compares Postgres versions, and makes sure the new database is still empty.',
  requires: ['a4'],
  writes: 'none',
  async run(ctx) {
    const { cfg, paths } = ctx;
    requireFields(cfg, 'new', ['ref', 'dbUrl', 'secretKey']);
    requirePat(cfg);
    if (cfg.new.ref === cfg.old.ref) throw new StepError('The NEW project ref is the same as the OLD one.');
    const conn = dbConn(cfg, 'new');
    const oldInfo = await readJson(paths.oldInfo, {});
    if (oldInfo.ref && oldInfo.ref !== cfg.old.ref) {
      throw new StepError(`This clone's backup comes from project ${oldInfo.ref}, but the OLD project ref is ${cfg.old.ref}.`,
        'Set the OLD project ref back, or create a new clone for the other project.');
    }

    ctx.log('Connecting to the new database…');
    const info = await withDb(conn.pgUrl, async (c) => {
      const version = (await c.query('show server_version')).rows[0].server_version;
      const schemas = await readJson(paths.userSchemas, ['public']);
      const tables = (await c.query(`select count(*)::int n from pg_tables where schemaname = any($1)`, [schemas])).rows[0].n;
      const users = (await c.query('select count(*)::int n from auth.users')).rows[0].n;
      const newSchemas = await userSchemas(c);
      const buckets = (await c.query('select count(*)::int n from storage.buckets')).rows[0].n;
      return { version, tables, users, newSchemas, buckets };
    }, ctx.signal);
    ctx.ok(`Database OK: Postgres ${info.version} (old: ${oldInfo.postgres || '?'}).`);
    const major = (v) => String(v || '').split('.')[0];
    if (oldInfo.postgres && major(oldInfo.postgres) !== major(info.version)) {
      ctx.warn(`Different Postgres major versions (${oldInfo.postgres} → ${info.version}). The dump is plain SQL and usually works, but watch the restore.`);
    }
    if (info.tables > 0 && !isDone('b2')) {
      throw new StepError(`The new database is not empty: ${info.tables} tables already exist in the app schemas.`,
        'Use a fresh project, or remove those tables in the new project. The tool will not mix data into a used database.');
    }
    if (info.users > 0 && !isDone('b2')) ctx.warn(`The new project already has ${info.users} auth users. The restore may fail on duplicates.`);

    const seen = await checkStorageKey(cfg, 'new', info.buckets, ctx.signal);
    ctx.ok(`Secret key OK: it sees all ${seen} buckets.`);

    const api = mgmt(cfg.pat, ctx.signal);
    const project = await api.get(`/v1/projects/${cfg.new.ref}`);
    ctx.ok(`Token OK: "${project.name}", region ${project.region}, status ${project.status}.`);
    if (project.status && project.status !== 'ACTIVE_HEALTHY') ctx.warn(`The new project status is ${project.status}. Wait until it is ACTIVE_HEALTHY.`);
    if (oldInfo.region && oldInfo.region === project.region) ctx.warn(`The new project is in the same region as the old one (${project.region}).`);

    const psql = await checkTool(ctx, 'psql', ['--version'], 'Install the PostgreSQL client (psql).');
    const cli = await checkTool(ctx, 'supabase', ['--version'], 'Install the Supabase CLI.');
    ctx.ok(`${psql}, Supabase CLI ${cli}.`);
    return {
      Project: `${project.name} (${project.region})`,
      Postgres: `${info.version} (old ${oldInfo.postgres || '?'})`,
      'Tables already there': info.tables,
    };
  },
};
