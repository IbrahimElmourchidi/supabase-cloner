import fs from 'node:fs';
import readline from 'node:readline';
import { StepError } from '../lib/errors.mjs';
import { readJson, readJsonl, fileSize, sha256File, writeJson, safeJoin, fmtBytes, fmtNum, throwIfCancelled } from '../lib/util.mjs';
import { fileNonEmpty } from './common.mjs';

async function copiedTables(file) {
  const set = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const re = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)"/;
  for await (const line of rl) {
    if (!line.startsWith('COPY ')) continue;
    const m = re.exec(line);
    if (m) set.add(`${m[1].replace(/""/g, '"')}.${m[2].replace(/""/g, '"')}`);
  }
  return set;
}

export default {
  id: 'a4',
  phase: 'A',
  num: 'A4',
  title: 'Check the backup',
  desc: 'Checks every dump file, that every table with rows is in data.sql, and that every storage file is on disk with the right size. Phase B needs this.',
  requires: ['a1', 'a2', 'a3'],
  writes: 'local',
  async run(ctx) {
    const { paths } = ctx;
    const problems = [];

    for (const f of [paths.roles, paths.schema, paths.data, paths.extras]) {
      if (!(await fileNonEmpty(f)) && f !== paths.roles) problems.push(`Missing or empty: ${f}`);
    }
    for (const f of [paths.rowCounts, paths.schemaCounts, paths.cronJobs, paths.extensions, paths.userSchemas,
      paths.buckets, paths.objects, paths.functionsList, paths.vault, paths.functionSecrets]) {
      if ((await fileSize(f)) < 0) problems.push(`Missing: ${f}`);
    }
    if (problems.length) throw new StepError('The backup is not complete.', 'Run the step that makes the missing file again.', { detail: problems.join('\n') });

    ctx.log('Checking that every table with rows is in data.sql…');
    const copied = await copiedTables(paths.data);
    const { tables } = await readJson(paths.rowCounts);
    const missingTables = Object.entries(tables).filter(([t, n]) => n > 0 && !copied.has(t)).map(([t, n]) => `${t} (${n} rows)`);
    if (missingTables.length) problems.push(`Tables with rows but no data in data.sql:\n  ${missingTables.join('\n  ')}`);
    else ctx.ok(`All ${Object.keys(tables).length} tables are covered (${copied.size} have data).`);

    ctx.log('Checking storage files on disk…');
    const objects = await readJsonl(paths.objects);
    let bytes = 0;
    const badFiles = [];
    for (const o of objects) {
      throwIfCancelled(ctx.signal);
      const size = await fileSize(safeJoin(paths.files, o.bucket_id, o.name));
      const expected = o.metadata?.size;
      if (size < 0) badFiles.push(`missing: ${o.bucket_id}/${o.name}`);
      else if (expected != null && Number(expected) !== size) badFiles.push(`wrong size: ${o.bucket_id}/${o.name}`);
      else bytes += size;
    }
    if (badFiles.length) problems.push(`${badFiles.length} storage files are missing or wrong. Run A2 again.\n  ${badFiles.slice(0, 20).join('\n  ')}`);
    else ctx.ok(`All ${fmtNum(objects.length)} files are on disk (${fmtBytes(bytes)}).`);

    const failures = await readJson(paths.downloadFailures, []);
    if (failures.length) problems.push(`${failures.length} download failures are recorded. Run A2 again.`);

    if (problems.length) throw new StepError('The backup has problems.', 'Fix them with the step named in the detail box, then run A4 again.', { detail: problems.join('\n\n') });

    ctx.log('Writing MANIFEST.json with checksums…');
    const hashes = {};
    for (const f of [paths.roles, paths.schema, paths.data, paths.extras]) {
      hashes[f.slice(paths.root.length + 1)] = { sha256: await sha256File(f), bytes: await fileSize(f) };
    }
    const fns = await readJson(paths.functionsList, []);
    await writeJson(paths.manifest, {
      createdAt: new Date().toISOString(),
      oldProject: await readJson(paths.oldInfo, null),
      tables: Object.keys(tables).length,
      rows: Object.values(tables).reduce((a, b) => a + b, 0),
      storage: { files: objects.length, bytes },
      functions: fns.map((f) => f.slug),
      files: hashes,
    });
    ctx.ok('Backup is complete and checked.');
    return {
      Tables: Object.keys(tables).length,
      'Storage files': `${fmtNum(objects.length)} (${fmtBytes(bytes)})`,
      'Edge functions': fns.length,
      Manifest: paths.manifest,
    };
  },
};
