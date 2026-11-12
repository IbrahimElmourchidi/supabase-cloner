import path from 'node:path';
import { StepError } from '../lib/errors.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { registerSecret } from '../lib/scrub.mjs';
import { readJson, listFiles, sha256File, sha256, lastLines, exists } from '../lib/util.mjs';
import { functionSecretsNeeded } from '../lib/needed-secrets.mjs';
import { requirePat, supabaseCli } from './common.mjs';

async function compareDirs(a, b) {
  const fa = await listFiles(a);
  const fb = await listFiles(b);
  const diffs = [];
  for (const f of new Set([...fa, ...fb])) {
    if (!fa.includes(f)) diffs.push(`only live: ${f}`);
    else if (!fb.includes(f)) diffs.push(`only repo: ${f}`);
    else if (await sha256File(path.join(a, f)) !== await sha256File(path.join(b, f))) diffs.push(`different: ${f}`);
  }
  return diffs;
}

export default {
  id: 'b5',
  phase: 'B',
  num: 'B5',
  title: 'Deploy edge functions and set their secrets',
  desc: 'Deploys every function to the new project (same verify_jwt), from the live code in the backup or from a repo folder, and sets the function secrets.',
  requires: ['b2'],
  writes: 'new',
  async run(ctx) {
    const { cfg, paths } = ctx;
    requirePat(cfg);
    const fns = await readJson(paths.functionsList, []);
    const repoFns = cfg.repoDir ? path.join(cfg.repoDir, 'supabase', 'functions') : null;
    const deployed = [];
    const failed = [];

    for (const f of fns) {
      await ctx.checkpoint();
      const live = path.join(paths.functionsSrc, f.slug);
      const repo = repoFns ? path.join(repoFns, f.slug) : null;
      const hasLive = (await listFiles(live)).length > 0;
      const hasRepo = repo ? (await listFiles(repo)).length > 0 : false;
      if (hasLive && hasRepo) {
        const diffs = await compareDirs(live, repo);
        if (diffs.length) ctx.warn(`${f.slug}: live code and repo code differ:\n  ${diffs.join('\n  ')}`);
        else ctx.log(`${f.slug}: live code and repo code are the same.`);
      }
      let source = cfg.functionsSource === 'repo' && repoFns ? 'repo' : 'backup';
      if (source === 'repo' && !hasRepo) { source = 'backup'; ctx.warn(`${f.slug}: not in the repo, using the live code from the backup.`); }
      if (source === 'backup' && !hasLive) { source = 'repo'; ctx.warn(`${f.slug}: no live code in the backup, using the repo code.`); }
      if (source === 'repo' && !hasRepo) {
        failed.push(`${f.slug}: no code found anywhere`);
        ctx.problem(`${f.slug}: no code found in the backup${repoFns ? ' or the repo' : ''}.`);
        continue;
      }
      const workdir = source === 'repo' ? cfg.repoDir : paths.functionsWorkdir;
      const args = ['functions', 'deploy', f.slug, '--project-ref', cfg.new.ref, '--use-api', '--workdir', workdir];
      if (f.verify_jwt === false) args.push('--no-verify-jwt');
      ctx.log(`Deploying ${f.slug} from the ${source} (verify_jwt=${f.verify_jwt !== false})…`);
      let r = await supabaseCli(ctx, args, { env: { SUPABASE_ACCESS_TOKEN: cfg.pat } });
      if (r.code !== 0) {
        ctx.warn(`${f.slug}: first deploy attempt failed, trying once more…`);
        r = await supabaseCli(ctx, args, { env: { SUPABASE_ACCESS_TOKEN: cfg.pat } });
      }
      if (r.code === 0) { deployed.push(f.slug); ctx.ok(`${f.slug} deployed.`); }
      else {
        failed.push(`${f.slug}: ${lastLines(r.stderr || r.stdout, 6)}`);
        ctx.problem(`${f.slug}: deploy failed twice — ${lastLines(r.stderr || r.stdout, 2)}`);
      }
    }

    await ctx.checkpoint();
    ctx.log('Collecting function secrets…');
    const oldSecrets = await functionSecretsNeeded(paths);
    const given = cfg.secrets.functions || {};
    const values = {};
    for (const s of oldSecrets) {
      let value = given[s.name];
      let from = 'the secrets form';
      if (!value && s.vault) { value = s.vault.value; from = `Vault secret ${s.vault.name}`; }
      if (!value) continue;
      registerSecret(value);
      values[s.name] = value;
      const match = s.digest ? (sha256(value) === s.digest ? 'matches the old value' : 'cannot confirm it matches the old value') : '';
      ctx.log(`${s.name}: from ${from}${match ? ` — ${match}` : ''}.`);
    }
    const missing = oldSecrets.map((s) => s.name).filter((n) => !values[n]);

    if (Object.keys(values).length) {
      const api = mgmt(cfg.pat, ctx.signal, ctx.retryLogger('Management API'));
      await api.post(`/v1/projects/${cfg.new.ref}/secrets`, Object.entries(values).map(([name, value]) => ({ name, value })));
      ctx.ok(`Set ${Object.keys(values).length} function secrets: ${Object.keys(values).join(', ')}.`);
    }

    const summary = {
      Deployed: deployed.join(', ') || 'none',
      'Secrets set': Object.keys(values).join(', ') || 'none',
      'Secrets missing': missing.join(', ') || 'none',
    };
    if (failed.length || missing.length) {
      const parts = [];
      if (failed.length) parts.push(`Deploy failed:\n${failed.join('\n')}`);
      if (missing.length) parts.push(`No value for: ${missing.join(', ')}`);
      throw new StepError(`${failed.length} functions failed, ${missing.length} secrets have no value.`,
        missing.length ? 'Fill in the missing values under "Secrets for the new project", press Save, then run B5 again (or Resume).' : 'Read the detail box, then run B5 again.',
        { summary, detail: parts.join('\n\n') });
    }
    if (repoFns && !await exists(repoFns)) ctx.warn(`Repo functions folder not found: ${repoFns}`);
    return summary;
  },
};
