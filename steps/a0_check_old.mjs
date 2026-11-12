import fsp from 'node:fs/promises';
import path from 'node:path';
import { StepError } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { checkStorageKey } from '../lib/storage-key.mjs';
import { ensureDir, writeJson, fmtBytes, fmtNum } from '../lib/util.mjs';
import { requireFields, requirePat, checkTool } from './common.mjs';

export default {
  id: 'a0',
  phase: 'A',
  num: 'A0',
  title: 'Check the old project and this computer',
  desc: 'Tests the old project credentials, Docker, the Supabase CLI, psql and free disk space.',
  requires: [],
  writes: 'local',
  async run(ctx) {
    const { cfg, paths } = ctx;
    requireFields(cfg, 'old', ['ref', 'dbUrl', 'secretKey']);
    requirePat(cfg);
    const conn = dbConn(cfg, 'old');

    ctx.log('Connecting to the old database…');
    const info = await withDb(conn.pgUrl, async (c) => {
      const version = (await c.query('show server_version')).rows[0].server_version;
      const st = (await c.query(`select count(*)::int n, coalesce(sum((metadata->>'size')::bigint),0)::bigint b from storage.objects`)).rows[0];
      const dbBytes = (await c.query('select pg_database_size(current_database())::bigint s')).rows[0].s;
      const buckets = (await c.query('select count(*)::int n from storage.buckets')).rows[0].n;
      return { version, files: st.n, fileBytes: Number(st.b), dbBytes: Number(dbBytes), buckets };
    }, ctx.signal);
    ctx.ok(`Database OK: Postgres ${info.version}, database ${fmtBytes(info.dbBytes)}, ${fmtNum(info.files)} files (${fmtBytes(info.fileBytes)}).`);

    ctx.log('Checking the secret key…');
    const seen = await checkStorageKey(cfg, 'old', info.buckets, ctx.signal);
    ctx.ok(`Secret key OK: it sees all ${seen} buckets.`);

    ctx.log('Checking the personal access token…');
    const project = await mgmt(cfg.pat, ctx.signal).get(`/v1/projects/${cfg.old.ref}`);
    ctx.ok(`Token OK: "${project.name}", region ${project.region}, status ${project.status}.`);

    ctx.log('Checking tools on this computer…');
    const docker = await checkTool(ctx, 'docker', ['info', '--format', '{{.ServerVersion}}'],
      'Start Docker. The Supabase CLI needs it to dump the database.');
    const cli = await checkTool(ctx, 'supabase', ['--version'], 'Install the Supabase CLI.');
    const psql = await checkTool(ctx, 'psql', ['--version'], 'Install the PostgreSQL client (psql).');
    ctx.ok(`Docker ${docker}, Supabase CLI ${cli}, ${psql}.`);

    await ensureDir(paths.root);
    await fsp.chmod(paths.root, 0o700).catch(() => {});
    const fsinfo = await fsp.statfs(paths.root);
    const free = Number(fsinfo.bavail) * Number(fsinfo.bsize);
    const need = info.fileBytes + info.dbBytes * 2 + 1024 ** 3;
    ctx.log(`Backup folder: ${paths.root} — free ${fmtBytes(free)}, needed about ${fmtBytes(need)}.`);
    if (free < need) {
      throw new StepError(`Not enough free disk space: ${fmtBytes(free)} free, about ${fmtBytes(need)} needed.`,
        'Free some space, or choose another backup folder in the Credentials form.');
    }

    await writeJson(paths.oldInfo, {
      ref: cfg.old.ref, name: project.name, region: project.region,
      postgres: info.version, checkedAt: new Date().toISOString(),
    });
    return {
      Project: `${project.name} (${project.region})`,
      Postgres: info.version,
      Files: `${fmtNum(info.files)} (${fmtBytes(info.fileBytes)})`,
      'Free disk': fmtBytes(free),
      'Backup folder': path.resolve(paths.root),
    };
  },
};
