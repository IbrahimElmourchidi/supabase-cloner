import { StepError, describe } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb } from '../lib/db.mjs';
import { readJson, qi } from '../lib/util.mjs';

const SKIP = new Set(['plpgsql']);

export default {
  id: 'b1',
  phase: 'B',
  num: 'B1',
  title: 'Turn on extensions',
  desc: 'Enables the same extensions as the old project (pg_cron, pg_net, pgmq, vector, pg_trgm…). The schema dump needs them first.',
  requires: ['b0'],
  writes: 'new',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const wanted = (await readJson(paths.extensions)).filter((e) => !SKIP.has(e.name));
    const conn = dbConn(cfg, 'new');
    const failed = [];
    const created = [];
    await withDb(conn.pgUrl, async (c) => {
      const have = new Set((await c.query('select extname from pg_extension')).rows.map((r) => r.extname));
      for (const e of wanted) {
        await ctx.checkpoint();
        if (have.has(e.name)) { ctx.log(`${e.name}: already on.`); continue; }
        const attempts = [
          `create extension if not exists ${qi(e.name)} with schema ${qi(e.schema)}`,
          `create extension if not exists ${qi(e.name)}`,
        ];
        let ok = false;
        let lastErr = null;
        for (const sql of attempts) {
          try {
            await c.query(sql);
            ok = true;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (ok) {
          const where = (await c.query(`select n.nspname s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where extname = $1`, [e.name])).rows[0]?.s;
          created.push(e.name);
          ctx.ok(`${e.name}: turned on (schema ${where}${where !== e.schema ? `, old project used ${e.schema}` : ''}).`);
        } else {
          failed.push(`${e.name}: ${describe(lastErr)}`);
          ctx.problem(`${e.name}: could not turn on — ${describe(lastErr)}`);
        }
      }
    }, ctx.signal);
    if (failed.length) {
      throw new StepError(`${failed.length} extensions could not be turned on.`,
        'Turn them on in the new project: Dashboard → Database → Extensions (same schema as listed), then run B1 again.',
        { detail: failed.join('\n') });
    }
    return { 'Turned on now': created.length ? created.join(', ') : 'none', 'Total checked': wanted.length };
  },
};
