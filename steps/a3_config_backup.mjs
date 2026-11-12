import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { registerSecret } from '../lib/scrub.mjs';
import { ensureDir, writeJson, writeAtomic, lastLines, listFiles } from '../lib/util.mjs';
import { requirePat, supabaseCli } from './common.mjs';

export default {
  id: 'a3',
  phase: 'A',
  num: 'A3',
  title: 'Back up edge functions, settings and secrets',
  desc: 'Saves the live edge function code, auth / Data API / storage settings, the function secret names and the Vault secrets.',
  requires: ['a0'],
  writes: 'local',
  async run(ctx) {
    const { cfg, paths } = ctx;
    requirePat(cfg);
    const api = mgmt(cfg.pat, ctx.signal, ctx.retryLogger('Management API'));
    const ref = cfg.old.ref;
    const warnings = [];
    for (const d of [paths.functions, paths.config, paths.secrets]) await ensureDir(d);
    await fsp.chmod(paths.secrets, 0o700).catch(() => {});

    ctx.log('Listing edge functions…');
    const fns = await api.get(`/v1/projects/${ref}/functions`);
    await writeJson(paths.functionsList, fns);
    ctx.ok(`${fns.length} functions: ${fns.map((f) => `${f.slug} (verify_jwt=${f.verify_jwt})`).join(', ')}`);

    await ensureDir(path.join(paths.functionsWorkdir, 'supabase'));
    const toml = path.join(paths.functionsWorkdir, 'supabase', 'config.toml');
    await writeAtomic(toml, 'project_id = "backup-of-old-project"\n', 0o600);
    let downloaded = 0;
    for (const f of fns) {
      await ctx.checkpoint();
      ctx.log(`Downloading live code of ${f.slug}…`);
      const r = await supabaseCli(ctx, ['functions', 'download', f.slug, '--project-ref', ref, '--use-api',
        '--workdir', paths.functionsWorkdir], { env: { SUPABASE_ACCESS_TOKEN: cfg.pat } });
      const files = await listFiles(path.join(paths.functionsSrc, f.slug));
      if (r.code === 0 && files.length) {
        downloaded++;
        ctx.ok(`${f.slug}: ${files.length} files.`);
      } else {
        const msg = `Could not download ${f.slug}: ${lastLines(r.stderr || r.stdout, 4)}`;
        warnings.push(msg);
        ctx.warn(`${msg} — not fatal if B5 deploys this function from a repo folder.`);
      }
    }

    const saveConfig = async (label, url, file) => {
      try {
        const data = await api.get(url);
        await writeJson(file, data, 0o600);
        ctx.ok(`${label} settings saved.`);
        return data;
      } catch (e) {
        const msg = `${label} settings not saved: ${describe(e)}`;
        warnings.push(msg);
        ctx.warn(msg);
        return null;
      }
    };
    const auth = await saveConfig('Auth', `/v1/projects/${ref}/config/auth`, paths.auth);
    for (const [k, v] of Object.entries(auth || {})) {
      if (typeof v === 'string' && /(secret|pass|password|token|private)/i.test(k)) registerSecret(v);
    }
    await saveConfig('Data API', `/v1/projects/${ref}/postgrest`, paths.postgrest);
    await saveConfig('Storage', `/v1/projects/${ref}/config/storage`, paths.storageConfig);

    ctx.log('Saving function secret names…');
    const secrets = await api.get(`/v1/projects/${ref}/secrets`);
    await writeJson(paths.functionSecrets, secrets.map((s) => ({ name: s.name, digest: s.value ?? null })), 0o600);
    ctx.ok(`Function secrets: ${secrets.map((s) => s.name).join(', ')}`);

    ctx.log('Saving Vault secrets…');
    const conn = dbConn(cfg, 'old');
    const vault = await withDb(conn.pgUrl, async (c) => {
      const ok = (await c.query(`select to_regclass('vault.decrypted_secrets') is not null x`)).rows[0].x;
      if (!ok) return [];
      return (await c.query('select name, description, decrypted_secret as value from vault.decrypted_secrets order by name')).rows;
    }, ctx.signal);
    for (const v of vault) registerSecret(v.value);
    await writeJson(paths.vault, vault, 0o600);
    ctx.ok(`${vault.length} Vault secrets: ${vault.map((v) => v.name).join(', ')}`);

    return {
      'Edge functions': `${downloaded} of ${fns.length} downloaded`,
      'Function secrets': secrets.length,
      'Vault secrets': vault.length,
      Warnings: warnings.length,
    };
  },
};
