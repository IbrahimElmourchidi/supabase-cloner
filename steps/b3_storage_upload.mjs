import fsp from 'node:fs/promises';
import { StepError, describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { uploadObject, createBucket } from '../lib/storage-api.mjs';
import { checkStorageKey } from '../lib/storage-key.mjs';
import { runPool } from '../lib/pool.mjs';
import { readJson, readJsonl, writeJson, safeJoin, fmtBytes, fmtNum, throwIfCancelled } from '../lib/util.mjs';

export default {
  id: 'b3',
  phase: 'B',
  num: 'B3',
  title: 'Upload storage files',
  desc: 'Uploads every file from the backup folder to the same bucket and path in the new project, then restores file owners. Run again to continue or retry.',
  requires: ['b2'],
  writes: 'new',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const conn = dbConn(cfg, 'new');
    const buckets = await readJson(paths.buckets);
    const objects = await readJsonl(paths.objects);

    const present = await withDb(conn.pgUrl, async (c) => {
      const have = new Set((await c.query('select id from storage.buckets')).rows.map((r) => r.id));
      ctx.log('Checking the secret key…');
      const seen = await checkStorageKey(cfg, 'new', have.size, ctx.signal);
      ctx.ok(`Secret key OK: it sees all ${seen} buckets.`);
      const missing = buckets.filter((b) => !have.has(b.id));
      for (const b of missing) {
        ctx.log(`Bucket ${b.id} is missing — creating it…`);
        await createBucket(cfg.new.ref, cfg.new.secretKey, b, ctx.signal);
      }
      const rows = (await c.query(`select bucket_id, name, (metadata->>'size')::bigint size from storage.objects`)).rows;
      return new Map(rows.map((r) => [`${r.bucket_id}/${r.name}`, Number(r.size)]));
    }, ctx.signal);

    const totalBytes = objects.reduce((a, o) => a + Number(o.metadata?.size || 0), 0);
    let done = 0;
    let doneBytes = 0;
    let skipped = 0;
    const todo = [];
    for (const o of objects) {
      const size = present.get(`${o.bucket_id}/${o.name}`);
      const expected = o.metadata?.size;
      if (size != null && (expected == null || Number(expected) === size)) {
        skipped++; done++; doneBytes += size;
      } else {
        todo.push(o);
      }
    }
    ctx.log(`${fmtNum(skipped)} files already in the new project. ${fmtNum(todo.length)} to upload, ${cfg.concurrency} at a time.`);
    const failures = [];
    const report = () => ctx.progress({ done, total: objects.length, bytes: doneBytes, totalBytes, failed: failures.length, skipped, label: 'files' });
    report();

    await runPool(todo, cfg.concurrency, async (o) => {
      try {
        const local = safeJoin(paths.files, o.bucket_id, o.name);
        const buf = await fsp.readFile(local);
        await uploadObject(cfg.new.ref, cfg.new.secretKey, o.bucket_id, o.name, buf, {
          contentType: o.metadata?.mimetype,
          cacheControl: o.metadata?.cacheControl,
          signal: ctx.signal,
          onRetry: ctx.retryLogger(`${o.bucket_id}/${o.name}`),
        });
        doneBytes += buf.length;
      } catch (e) {
        if (ctx.signal.aborted) return;
        const msg = e.code === 'ENOENT' ? 'not in the backup folder (run A2 and A4 again)' : describe(e);
        failures.push({ bucket: o.bucket_id, name: o.name, error: msg });
        ctx.problem(`FAILED upload ${o.bucket_id}/${o.name}: ${msg}`);
      }
      done++;
      report();
    }, ctx.signal, ctx.checkpoint);
    throwIfCancelled(ctx.signal);
    await writeJson(paths.uploadFailures, failures);

    const owned = objects.filter((o) => o.owner || o.owner_id || (o.user_metadata && Object.keys(o.user_metadata).length));
    let ownersFixed = 0;
    if (owned.length) {
      await ctx.checkpoint();
      ctx.log(`Restoring owner / metadata on ${owned.length} files…`);
      await withDb(conn.pgUrl, async (c) => {
        const cols = new Set((await c.query(`select column_name from information_schema.columns where table_schema = 'storage' and table_name = 'objects'`)).rows.map((r) => r.column_name));
        for (const o of owned) {
          const sets = [];
          const vals = [o.bucket_id, o.name];
          if (cols.has('owner') && o.owner) { vals.push(o.owner); sets.push(`owner = $${vals.length}::uuid`); }
          if (cols.has('owner_id') && o.owner_id) { vals.push(o.owner_id); sets.push(`owner_id = $${vals.length}`); }
          if (cols.has('user_metadata') && o.user_metadata) { vals.push(JSON.stringify(o.user_metadata)); sets.push(`user_metadata = $${vals.length}::jsonb`); }
          if (!sets.length) continue;
          try {
            const r = await c.query(`update storage.objects set ${sets.join(', ')} where bucket_id = $1 and name = $2`, vals);
            ownersFixed += r.rowCount;
          } catch (e) {
            ctx.problem(`Owner of ${o.bucket_id}/${o.name} not restored: ${describe(e)}`);
          }
        }
      }, ctx.signal);
      ctx.ok(`Owner restored on ${ownersFixed} of ${owned.length} files.`);
    }

    const summary = {
      Files: fmtNum(objects.length),
      Size: fmtBytes(totalBytes),
      'Already there': fmtNum(skipped),
      Failed: failures.length,
      'Owners restored': `${ownersFixed} of ${owned.length}`,
    };
    if (failures.length) {
      throw new StepError(`${failures.length} files could not be uploaded.`,
        'Press Run again: only the missing files are tried again. The list is in storage/upload_failures.json.',
        { summary, detail: failures.slice(0, 30).map((f) => `${f.bucket}/${f.name}: ${f.error}`).join('\n') });
    }
    return summary;
  },
};
