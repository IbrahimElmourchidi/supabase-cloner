import { StepError } from '../lib/errors.mjs';
import { dbConn } from '../lib/conn.mjs';
import { withDb, textColumns } from '../lib/db.mjs';
import { readJson, qi, ql, throwIfCancelled } from '../lib/util.mjs';
import { hosts } from './common.mjs';

function castBack(col) {
  if (col.dt === 'jsonb') return '::jsonb';
  if (col.dt === 'json') return '::json';
  if (col.dt === 'ARRAY') return col.udt === '_varchar' ? '::varchar[]' : '::text[]';
  return '';
}

export async function scanOldHost(c, schemas, oldHost, signal) {
  const cols = await textColumns(c, schemas);
  const hits = [];
  for (const col of cols) {
    throwIfCancelled(signal);
    const n = Number((await c.query(
      `select count(*)::bigint n from ${qi(col.s)}.${qi(col.t)} where ${qi(col.col)}::text like $1`, [`%${oldHost}%`])).rows[0].n);
    if (n > 0) hits.push({ ...col, n });
  }
  const fns = (await c.query(`
    select p.oid, n.nspname s, p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1) and p.prokind in ('f','p') and p.prosrc like $2
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`, [schemas, `%${oldHost}%`])).rows;
  return { hits, fns };
}

export default {
  id: 'b4',
  phase: 'B',
  num: 'B4',
  title: 'Fix saved links',
  desc: 'Replaces the old project address in every text/JSON column and in function bodies (for example get_storage_url) with the new address.',
  requires: ['b2'],
  writes: 'new',
  confirm: 'This rewrites saved links in the NEW project database. Continue?',
  async run(ctx) {
    const { cfg, paths } = ctx;
    const { oldHost, newHost } = hosts(cfg);
    const schemas = await readJson(paths.userSchemas);
    const conn = dbConn(cfg, 'new');

    return withDb(conn.pgUrl, async (c) => {
      ctx.log(`Searching for "${oldHost}" in all text columns…`);
      const { hits, fns } = await scanOldHost(c, schemas, oldHost, ctx.signal);
      for (const h of hits) ctx.log(`  ${h.s}.${h.t}.${h.col}: ${h.n.toLocaleString('en-US')} rows`);
      for (const f of fns) ctx.log(`  function ${f.s}.${f.name}`);
      if (!hits.length && !fns.length) {
        ctx.ok('Nothing to change: no old links found.');
        return { 'Rows changed': 0, 'Functions changed': 0 };
      }

      let rows = 0;
      await c.query('begin');
      try {
        await c.query('set local session_replication_role = replica');
        for (const h of hits) {
          throwIfCancelled(ctx.signal);
          const expr = `replace(${qi(h.col)}::text, ${ql(oldHost)}, ${ql(newHost)})${castBack(h)}`;
          const r = await c.query(`update ${qi(h.s)}.${qi(h.t)} set ${qi(h.col)} = ${expr} where ${qi(h.col)}::text like $1`, [`%${oldHost}%`]);
          rows += r.rowCount;
        }
        for (const f of fns) {
          const def = (await c.query('select pg_get_functiondef($1) d', [f.oid])).rows[0].d;
          await c.query(def.split(oldHost).join(newHost));
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw new StepError(`Fixing links failed and was rolled back: ${e.message}`);
      }
      ctx.ok(`Changed ${rows.toLocaleString('en-US')} rows in ${hits.length} columns and ${fns.length} functions.`);

      const after = await scanOldHost(c, schemas, oldHost, ctx.signal);
      if (after.hits.length || after.fns.length) {
        throw new StepError('Some old links are still there after the change.', null,
          { detail: [...after.hits.map((h) => `${h.s}.${h.t}.${h.col}`), ...after.fns.map((f) => `${f.s}.${f.name}`)].join('\n') });
      }
      const defaults = (await c.query(`
        select n.nspname || '.' || cl.relname || '.' || a.attname x from pg_attrdef d
          join pg_class cl on cl.oid = d.adrelid join pg_namespace n on n.oid = cl.relnamespace
          join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
         where n.nspname = any($1) and pg_get_expr(d.adbin, d.adrelid) like $2`, [schemas, `%${oldHost}%`])).rows;
      for (const d of defaults) ctx.warn(`Column default still has the old address (fix by hand): ${d.x}`);
      return { 'Rows changed': rows.toLocaleString('en-US'), Columns: hits.length, 'Functions changed': fns.map((f) => `${f.s}.${f.name}`).join(', ') || 0 };
    }, ctx.signal);
  },
};
