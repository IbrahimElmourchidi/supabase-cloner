import fsp from 'node:fs/promises';
import path from 'node:path';
import { StepError, describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { downloadObject } from '../lib/storage-api.mjs';
import { checkStorageKey } from '../lib/storage-key.mjs';
import { runPool } from '../lib/pool.mjs';
import { ensureDir, writeJson, writeAtomic, safeJoin, fileSize, fmtBytes, fmtNum, throwIfCancelled } from '../lib/util.mjs';

export default {
  id: 'a2',
  phase: 'A',
  num: 'A2',
  title: 'Back up all storage files',
  desc: 'Downloads every file of every bucket into storage/files/<bucket>/<same path>. Run it again to continue or retry failed files.',
  requires: ['a0'],
  writes: 'local',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const conn = dbConn(cfg, 'old');
    await ensureDir(paths.files);

    ctx.log('Listing buckets and files from the old database…');
    const { buckets, objects } = await withDb(conn.pgUrl, async (c) => ({
      buckets: (await c.query('select * from storage.buckets order by id')).rows,
      objects: (await c.query(`
        select bucket_id, name, metadata,
               to_jsonb(o)->>'owner' as owner, to_jsonb(o)->>'owner_id' as owner_id,
               to_jsonb(o)->'user_metadata' as user_metadata
          from storage.objects o order by bucket_id, name`)).rows,
    }), ctx.signal);
    ctx.log('Checking the secret key…');
    const seen = await checkStorageKey(cfg, 'old', buckets.length, ctx.signal);
    ctx.ok(`Secret key OK: it sees all ${seen} buckets.`);
    await writeJson(paths.buckets, buckets);
    await writeAtomic(paths.objects, objects.map((o) => JSON.stringify(o)).join('\n') + (objects.length ? '\n' : ''));
    const totalBytes = objects.reduce((a, o) => a + Number(o.metadata?.size || 0), 0);
    ctx.ok(`${buckets.length} buckets, ${fmtNum(objects.length)} files, ${fmtBytes(totalBytes)}.`);

    const fsinfo = await fsp.statfs(paths.root);
    const free = Number(fsinfo.bavail) * Number(fsinfo.bsize);
    let doneBytes = 0;
    let done = 0;
    let skipped = 0;
    const failures = [];
    const todo = [];
    for (const o of objects) {
      const local = safeJoin(paths.files, o.bucket_id, o.name);
      const expected = o.metadata?.size;
      const have = await fileSize(local);
      if (have >= 0 && (expected == null || Number(expected) === have)) {
        skipped++; done++; doneBytes += have;
      } else {
        todo.push({ ...o, local });
      }
    }
    const remainingBytes = totalBytes - doneBytes;
    if (free < remainingBytes + 512 * 1024 ** 2) {
      throw new StepError(`Not enough disk space: ${fmtBytes(free)} free, ${fmtBytes(remainingBytes)} still to download.`);
    }
    ctx.log(`${fmtNum(skipped)} files already in the backup. ${fmtNum(todo.length)} to download (${fmtBytes(remainingBytes)}), ${cfg.concurrency} at a time.`);

    const report = () => ctx.progress({
      done, total: objects.length, bytes: doneBytes, totalBytes, failed: failures.length, skipped,
      label: 'files',
    });
    report();
    const started = Date.now();

    await runPool(todo, cfg.concurrency, async (o) => {
      try {
        const buf = await downloadObject(cfg.old.ref, cfg.old.secretKey, o.bucket_id, o.name, {
          size: o.metadata?.size,
          signal: ctx.signal, onRetry: ctx.retryLogger(`${o.bucket_id}/${o.name}`),
        });
        const expected = o.metadata?.size;
        if (expected != null && Number(expected) !== buf.length) {
          throw new Error(`size mismatch: expected ${expected} bytes, got ${buf.length}`);
        }
        await ensureDir(path.dirname(o.local));
        const tmp = `${o.local}.part`;
        await fsp.writeFile(tmp, buf, { mode: 0o600 });
        await fsp.rename(tmp, o.local);
        doneBytes += buf.length;
      } catch (e) {
        if (ctx.signal.aborted) return;
        failures.push({ bucket: o.bucket_id, name: o.name, error: describe(e) });
        ctx.problem(`FAILED download ${o.bucket_id}/${o.name}: ${describe(e)}`);
      }
      done++;
      report();
    }, ctx.signal, ctx.checkpoint);
    throwIfCancelled(ctx.signal);

    await writeJson(paths.downloadFailures, failures);
    const secs = Math.max(1, (Date.now() - started) / 1000);
    ctx.log(`Speed: ${fmtBytes((doneBytes - (totalBytes - remainingBytes)) / secs)}/s.`);
    const summary = {
      Buckets: buckets.length,
      Files: fmtNum(objects.length),
      Size: fmtBytes(totalBytes),
      'Already present': fmtNum(skipped),
      Failed: failures.length,
    };
    if (failures.length) {
      throw new StepError(`${failures.length} files could not be downloaded.`,
        'Press Run again: only the missing files are tried again. The list is in storage/download_failures.json.',
        { summary, detail: failures.slice(0, 30).map((f) => `${f.bucket}/${f.name}: ${f.error}`).join('\n') });
    }
    return summary;
  },
};
