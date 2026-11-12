import { readJson, sha256, exists } from './util.mjs';
import { backupPaths } from './paths.mjs';

/** Function secrets that Supabase sets by itself in every project. */
export const AUTO_FUNCTION_SECRET = /^SUPABASE_/;
/** Auth settings that hold a secret. */
export const AUTH_SECRET_KEY = /(_secret|_secrets|_pass|_password|_token|_auth_token|_api_key|_private_key)$/i;
/** The Management API gives some secrets back only as a SHA-256 fingerprint. */
export const FINGERPRINT = /^[0-9a-f]{64}$/;

/** True when the old project really uses this auth secret (its provider, SMTP or SMS service is on). */
export function authSecretInUse(auth, key) {
  const prefix = key.replace(AUTH_SECRET_KEY, '');
  if (prefix.startsWith('smtp')) return Boolean(auth.smtp_host);
  if (prefix.startsWith('sms_')) {
    const provider = `sms_${auth.sms_provider || ''}`;
    return Boolean(auth.external_phone_enabled) && (prefix === provider || prefix.startsWith(`${provider}_`));
  }
  return auth[`${prefix}_enabled`] === true;
}

/** Auth secrets in use whose real value the API did not give back. [{ name, why: 'fingerprint' | 'empty' }] */
export function authSecretsNeeded(auth) {
  const out = [];
  for (const [name, v] of Object.entries(auth || {})) {
    if (!AUTH_SECRET_KEY.test(name) || !authSecretInUse(auth, name)) continue;
    const value = v == null ? '' : String(v);
    if (FINGERPRINT.test(value)) out.push({ name, why: 'fingerprint' });
    else if (value === '') out.push({ name, why: 'empty' });
  }
  return out;
}

/**
 * Function secrets of the old project, without the SUPABASE_* ones.
 * vault: a Vault secret with the same name or the same value, which B5 can use as the value.
 */
export async function functionSecretsNeeded(paths) {
  const names = await readJson(paths.functionSecrets, []);
  const vault = await readJson(paths.vault, []);
  return names
    .filter((s) => !AUTO_FUNCTION_SECRET.test(s.name))
    .map((s) => ({
      name: s.name,
      digest: s.digest,
      vault: vault.find((x) => x.name.toLowerCase() === s.name.toLowerCase())
        || vault.find((x) => s.digest && sha256(x.value || '') === s.digest)
        || null,
    }));
}

/** What the page shows under "Secrets for the new project". No secret values. */
export async function secretsForm(cfg) {
  const paths = backupPaths(cfg);
  const ready = await exists(paths.functionSecrets) || await exists(paths.auth);
  const fns = await functionSecretsNeeded(paths);
  const auth = await readJson(paths.auth, null);
  return {
    ready,
    functions: fns.map((f) => ({
      name: f.name,
      from: f.vault ? `Vault secret ${f.vault.name}` : null,
      has: Boolean(cfg.secrets.functions[f.name]),
    })),
    auth: authSecretsNeeded(auth).map((a) => ({ ...a, has: Boolean(cfg.secrets.auth[a.name]) })),
  };
}
