import { StepError, describe } from '../lib/errors.mjs';
import { mgmt } from '../lib/mgmt.mjs';
import { readJson, sha256 } from '../lib/util.mjs';
import { registerSecret } from '../lib/scrub.mjs';
import { AUTH_SECRET_KEY, FINGERPRINT, authSecretsNeeded } from '../lib/needed-secrets.mjs';
import { stripPaidAuth } from '../lib/paid-features.mjs';
import { requirePat, hosts, replaceHostDeep } from './common.mjs';

/** PATCH the whole object; if refused, split it in halves to find the fields the API will not take. */
async function patchSplitting(api, url, obj, rejected) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  try {
    await api.patch(url, obj);
  } catch (e) {
    if (e.status && e.status < 500 && keys.length > 1) {
      const mid = Math.ceil(keys.length / 2);
      await patchSplitting(api, url, Object.fromEntries(keys.slice(0, mid).map((k) => [k, obj[k]])), rejected);
      await patchSplitting(api, url, Object.fromEntries(keys.slice(mid).map((k) => [k, obj[k]])), rejected);
    } else {
      for (const k of keys) rejected.push({ key: k, error: describe(e).slice(0, 200) });
    }
  }
}

/**
 * Builds the auth PATCH body. The API returns some secrets only as a SHA-256 fingerprint;
 * those are never sent. A value from the "Auth secrets" box replaces them.
 */
function authBody(ctx, auth, provided, oldHost, newHost) {
  const body = replaceHostDeep(Object.fromEntries(Object.entries(auth).filter(([, v]) => v !== null)), oldHost, newHost);
  for (const [k, v] of Object.entries(auth)) {
    if (AUTH_SECRET_KEY.test(k) && FINGERPRINT.test(String(v ?? ''))) delete body[k];
  }
  const manual = authSecretsNeeded(auth)
    .filter((a) => !provided[a.name])
    .map((a) => `${a.name} (${a.why === 'fingerprint' ? 'the API gave only a fingerprint of it' : 'the API did not return it'})`);
  for (const [k, value] of Object.entries(provided)) {
    registerSecret(value);
    body[k] = value;
    const old = auth[k] == null ? '' : String(auth[k]);
    const match = FINGERPRINT.test(old) ? (sha256(value) === old ? 'matches the old value' : 'cannot confirm it matches the old value') : 'no old value to compare';
    ctx.log(`${k}: from the secrets form — ${match}.`);
  }
  return { body, manual };
}

export default {
  id: 'b6',
  phase: 'B',
  num: 'B6',
  title: 'Copy auth, Data API and storage settings',
  desc: 'Copies login providers, OTP, anonymous sign-in, email templates, SMTP, redirect URLs, exposed schemas and storage settings.',
  requires: ['b0'],
  writes: 'new',
  async run(ctx) {
    const { cfg, paths } = ctx;
    requirePat(cfg);
    const { oldHost, newHost } = hosts(cfg);
    const api = mgmt(cfg.pat, ctx.signal, ctx.retryLogger('Management API'));
    const ref = cfg.new.ref;
    const rejected = [];
    const manual = [];
    const paidOn = [];

    const auth = await readJson(paths.auth, null);
    if (auth) {
      const built = authBody(ctx, auth, cfg.secrets.auth || {}, oldHost, newHost);
      manual.push(...built.manual);
      const paid = stripPaidAuth(auth, built.body);
      if (paid.removed.length) ctx.log(`Not sent, because they belong to paid add-ons: ${paid.removed.join(', ')}.`);
      paidOn.push(...paid.enabledInOld);
      const url = `/v1/projects/${ref}/config/auth`;
      ctx.log(`Copying ${Object.keys(built.body).length} auth settings…`);
      let refused = [];
      await patchSplitting(api, url, built.body, refused);
      if (refused.length) {
        ctx.log(`${refused.length} fields were refused. Trying them once more: some need another setting first (for example SMTP).`);
        const again = [];
        await patchSplitting(api, url, Object.fromEntries(refused.map((r) => [r.key, built.body[r.key]])), again);
        if (again.length < refused.length) ctx.ok(`${refused.length - again.length} of them were accepted on the second try.`);
        refused = again;
      }
      rejected.push(...refused.map((r) => `${r.key}: ${r.error}`));
      ctx.ok(`Auth settings copied${refused.length ? ` (${refused.length} fields refused)` : ''}.`);
    } else {
      ctx.warn('No auth settings in the backup (A3 could not read them). Set them by hand.');
    }

    const pg = await readJson(paths.postgrest, null);
    if (pg) {
      const body = {};
      for (const k of ['db_schema', 'max_rows', 'db_extra_search_path', 'db_pool']) if (pg[k] != null) body[k] = pg[k];
      try {
        await api.patch(`/v1/projects/${ref}/postgrest`, body);
        ctx.ok(`Data API settings copied (schemas: ${pg.db_schema}).`);
      } catch (e) {
        rejected.push(`Data API: ${describe(e)}`);
      }
    }

    const sc = await readJson(paths.storageConfig, null);
    if (sc) {
      try {
        await api.patch(`/v1/projects/${ref}/config/storage`, { fileSizeLimit: sc.fileSizeLimit, features: sc.features });
        ctx.ok('Storage settings copied.');
      } catch (e) {
        try {
          await api.patch(`/v1/projects/${ref}/config/storage`, { fileSizeLimit: sc.fileSizeLimit });
          ctx.warn(`Only the file size limit was copied: ${describe(e)}`);
        } catch (e2) {
          rejected.push(`Storage: ${describe(e2)}`);
        }
      }
    }

    for (const r of rejected) ctx.warn(`Not copied: ${r}`);
    for (const m of manual) ctx.warn(`Not set: ${m}.`);
    for (const p of paidOn) ctx.warn(`Not turned on: ${p}. The old project uses it, but it is a paid add-on. Turn it on by hand in the new dashboard if you want to pay for it.`);
    const summary = {
      'Auth fields refused': rejected.length,
      'Paid add-ons left off': paidOn.join(', ') || 'none',
      'Secrets missing': manual.map((m) => m.split(' ')[0]).join(', ') || 'none',
    };
    if (manual.length) {
      throw new StepError(`${manual.length} login secrets that the old project uses are not set in the new one.`,
        'Fill them in under "Secrets for the new project", press Save, then run B6 again (or Resume). Everything else is already copied.',
        { summary, detail: manual.join('\n') });
    }
    return summary;
  },
};
