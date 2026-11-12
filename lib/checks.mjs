import { dbConn } from './conn.mjs';
import { withDb } from './db.mjs';
import { mgmt } from './mgmt.mjs';
import { checkStorageKey } from './storage-key.mjs';
import { describe, hintFor } from './errors.mjs';
import { scrub } from './scrub.mjs';

async function check(label, fn) {
  try {
    const detail = await fn();
    return { label, ok: true, detail };
  } catch (e) {
    const hint = e.hint || hintFor(e);
    return { label, ok: false, detail: scrub(`${describe(e)}${hint ? ` — ${hint}` : ''}`) };
  }
}

/** Quick credential test for the OLD or NEW side. Never throws. */
export async function testSide(cfg, side) {
  const s = cfg[side];
  const signal = AbortSignal.timeout(60000);
  const results = [];
  let dbBuckets = null;
  results.push(await check('Database connection', async () => {
    const conn = dbConn(cfg, side);
    return withDb(conn.pgUrl, async (c) => {
      const v = (await c.query('show server_version')).rows[0].server_version;
      const t = (await c.query(`select count(*)::int n from pg_tables where schemaname = 'public'`)).rows[0].n;
      dbBuckets = (await c.query('select count(*)::int n from storage.buckets')).rows[0].n;
      return `Postgres ${v}, ${t} tables in public${side === 'new' && t > 0 ? ' (the new project is not empty)' : ''}`;
    }, signal);
  }));
  results.push(await check('Secret key (storage access)', async () => {
    if (!s.secretKey) throw new Error('Enter the secret key and press Save.');
    const seen = await checkStorageKey(cfg, side, dbBuckets, signal);
    return dbBuckets == null ? `${seen} buckets visible (count not compared: the database test failed)` : `${seen} buckets visible, all of them`;
  }));
  results.push(await check('Personal access token', async () => {
    const p = await mgmt(cfg.pat, signal).get(`/v1/projects/${s.ref}`);
    return `${p.name} — region ${p.region}, status ${p.status}`;
  }));
  return results;
}
