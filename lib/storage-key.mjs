import { StepError } from './errors.mjs';
import { HttpError } from './http.mjs';
import { listBuckets } from './storage-api.mjs';

const LABEL = { old: 'OLD', new: 'NEW' };

const fixHint = (ref) =>
  `Open project ${ref} → Settings → API Keys, copy the secret key (sb_secret_…) again, paste it, and press "Save and test". Then run this step again.`;

function jwtPayload(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** A problem that the key text alone shows, without any network call. Returns a message or null. */
export function keyShapeProblem(cfg, side) {
  const s = cfg[side];
  const other = cfg[side === 'old' ? 'new' : 'old'];
  const L = LABEL[side];
  const key = String(s.secretKey || '');
  if (!key) return `The ${L} project's secret key is empty.`;
  if (/\s/.test(key)) return `The ${L} project's secret key contains a space or a line break. The paste picked up extra characters.`;
  if (key.startsWith('sb_publishable_')) {
    return `The ${L} project's secret key box holds a publishable key (sb_publishable_…). Storage needs the secret key (sb_secret_…).`;
  }
  if (other?.secretKey && key === other.secretKey) {
    return 'The OLD and NEW secret keys are the same. Each project has its own secret key.';
  }
  const payload = jwtPayload(key);
  if (payload) {
    if (payload.ref && payload.ref !== s.ref) return `The ${L} key belongs to project ${payload.ref}, not to ${s.ref}.`;
    if (payload.role && payload.role !== 'service_role') {
      return `The ${L} key is the legacy "${payload.role}" key. Use the secret key (sb_secret_…) or the legacy service_role key.`;
    }
    return null;
  }
  if (!key.startsWith('sb_secret_')) return `The ${L} project's secret key must start with sb_secret_ (or be the legacy service_role key).`;
  return null;
}

/**
 * Proves the secret key works on Storage and sees every bucket the database has.
 * expectedBuckets: the number of rows in storage.buckets, or null when unknown.
 * Returns the number of buckets the key sees. Throws a StepError with a plain message.
 */
export async function checkStorageKey(cfg, side, expectedBuckets, signal) {
  const L = LABEL[side];
  const ref = cfg[side].ref;
  const shape = keyShapeProblem(cfg, side);
  if (shape) throw new StepError(shape, fixHint(ref));
  let buckets;
  try {
    buckets = await listBuckets(ref, cfg[side].secretKey, signal);
  } catch (e) {
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
      throw new StepError(`Project ${ref} refused the ${L} secret key (HTTP ${e.status}). The key is wrong, cut off, or from the other project.`,
        fixHint(ref), { detail: e.message });
    }
    throw e;
  }
  if (expectedBuckets != null && buckets.length < expectedBuckets) {
    throw new StepError(`The ${L} key sees only ${buckets.length} of ${expectedBuckets} buckets, so it is not the secret key.`, fixHint(ref));
  }
  return buckets.length;
}
