import path from 'node:path';

/** Every file the backup writes, in one place. */
export function backupPaths(cfg) {
  const root = path.resolve(cfg.backupDir);
  const db = path.join(root, 'db');
  const storage = path.join(root, 'storage');
  const config = path.join(root, 'config');
  const secrets = path.join(root, 'secrets');
  const functions = path.join(root, 'functions');
  return {
    root,
    manifest: path.join(root, 'MANIFEST.json'),
    report: path.join(root, 'VERIFY_REPORT.md'),
    oldInfo: path.join(root, 'old_project.json'),
    db,
    roles: path.join(db, 'roles.sql'),
    schema: path.join(db, 'schema.sql'),
    data: path.join(db, 'data.sql'),
    extras: path.join(db, 'extras.sql'),
    migSchema: path.join(db, 'migrations_history_schema.sql'),
    migData: path.join(db, 'migrations_history_data.sql'),
    prepared: path.join(db, 'prepared'),
    userSchemas: path.join(db, 'user_schemas.json'),
    excluded: path.join(db, 'excluded_tables.json'),
    rowCounts: path.join(db, 'row_counts.json'),
    schemaCounts: path.join(db, 'schema_counts.json'),
    cronJobs: path.join(db, 'cron_jobs.json'),
    extensions: path.join(db, 'extensions.json'),
    pgmqQueues: path.join(db, 'pgmq_queues.json'),
    storage,
    buckets: path.join(storage, 'buckets.json'),
    objects: path.join(storage, 'objects.jsonl'),
    files: path.join(storage, 'files'),
    downloadFailures: path.join(storage, 'download_failures.json'),
    uploadFailures: path.join(storage, 'upload_failures.json'),
    functions,
    functionsList: path.join(functions, 'functions.json'),
    functionsWorkdir: functions,
    functionsSrc: path.join(functions, 'supabase', 'functions'),
    config,
    auth: path.join(config, 'auth.json'),
    postgrest: path.join(config, 'postgrest.json'),
    storageConfig: path.join(config, 'storage.json'),
    secrets,
    vault: path.join(secrets, 'vault.json'),
    functionSecrets: path.join(secrets, 'function_secret_names.json'),
  };
}
