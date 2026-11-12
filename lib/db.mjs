import pg from 'pg';
import { CancelledError } from './errors.mjs';
import { sleep } from './util.mjs';

const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|Connection terminated|timeout expired|too many connections|server closed the connection|Max client connections/i;

async function connect(url, signal, appName = 'supabase-cloner') {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new CancelledError();
    const client = new pg.Client({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20000,
      keepAlive: true,
      application_name: appName,
    });
    client.on('error', () => { /* handled by the failing query */ });
    try {
      await client.connect();
      return client;
    } catch (e) {
      await client.end().catch(() => {});
      if (!TRANSIENT.test(`${e.message} ${e.code}`) || attempt >= 3) throw e;
      attempt++;
      await sleep(2000 * attempt, signal);
    }
  }
}

/** Opens one long-lived connection for status probes. The caller must end() it. */
export const openClient = (url, appName, signal) => connect(url, signal, appName);

/** Opens a connection, runs fn(client), always closes it. A cancel ends the connection. */
export async function withDb(url, fn, signal) {
  const client = await connect(url, signal);
  const onAbort = () => client.end().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(client);
  } catch (e) {
    if (signal?.aborted) throw new CancelledError();
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await client.end().catch(() => {});
  }
}

export const MANAGED_SCHEMAS = [
  'auth', 'storage', 'cron', 'extensions', 'graphql', 'graphql_public', 'net', 'realtime',
  'supabase_migrations', 'supabase_functions', 'vault', 'pgmq', 'pgmq_public', 'pgbouncer', 'pgsodium',
  'pgsodium_masks', 'pgtle', '_realtime', '_analytics', '_supavisor', 'information_schema',
  'topology', 'tiger', 'tiger_data', 'repack', 'dbdev', 'etl',
];

export async function userSchemas(client) {
  const r = await client.query(
    `select nspname from pg_namespace
      where nspname not like 'pg\\_%' and nspname <> all($1::text[])
      order by 1`, [MANAGED_SCHEMAS]);
  return r.rows.map((x) => x.nspname);
}

export async function schemaCounts(client, schemas) {
  const r = await client.query(`
    select 'tables' k, count(*)::int n from pg_tables where schemaname = any($1)
    union all select 'views', count(*)::int from pg_views where schemaname = any($1)
    union all select 'materialized views', count(*)::int from pg_matviews where schemaname = any($1)
    union all select 'functions', count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    union all select 'triggers', count(*)::int from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
      where not t.tgisinternal and (n.nspname = any($1) or (n.nspname in ('auth','storage') and pn.nspname = any($1)))
    union all select 'RLS policies', count(*)::int from pg_policies where schemaname = any($1) or schemaname in ('storage','auth')
    union all select 'tables with RLS on', count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and c.relrowsecurity and n.nspname = any($1)
    union all select 'indexes', count(*)::int from pg_indexes where schemaname = any($1)
    union all select 'sequences', count(*)::int from pg_sequences where schemaname = any($1)
    union all select 'enum types', count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and n.nspname = any($1)
    union all select 'auth/storage triggers', count(*)::int from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
      where not t.tgisinternal and n.nspname in ('auth','storage') and pn.nspname = any($1)
  `, [schemas]);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.n]));
}

/** Tables whose rows are part of the backup: user schemas, auth, and storage.buckets. */
export async function countedTables(client, schemas) {
  const r = await client.query(`
    select schemaname s, tablename t from pg_tables
     where (schemaname = any($1) or schemaname = 'auth' or (schemaname = 'storage' and tablename = 'buckets'))
       and not (schemaname = 'auth' and tablename = 'schema_migrations')
     order by 1, 2`, [schemas]);
  return r.rows;
}

/** text-like columns in user tables, for finding and replacing the old project URL. */
export async function textColumns(client, schemas) {
  const r = await client.query(`
    select c.table_schema s, c.table_name t, c.column_name col, c.data_type dt, c.udt_name udt
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = any($1) and tb.table_type = 'BASE TABLE'
       and coalesce(c.is_generated, 'NEVER') = 'NEVER'
       and (c.data_type in ('text','character varying','json','jsonb')
            or (c.data_type = 'ARRAY' and c.udt_name in ('_text','_varchar')))
     order by 1, 2, 3`, [schemas]);
  return r.rows;
}
