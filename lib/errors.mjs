export class StepError extends Error {
  constructor(message, hint, { detail, summary } = {}) {
    super(message);
    this.name = 'StepError';
    this.hint = hint;
    this.detail = detail;
    this.summary = summary;
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Stopped by you. Finished work is kept; press Run to continue.');
    this.name = 'CancelledError';
  }
}

const RULES = [
  [/password authentication failed/i,
    'The database password is wrong. Reset it in Dashboard → Database → Settings, paste it again, and press Save.'],
  [/Tenant or user not found|tenant\/user .* not found/i,
    'The pooler does not know this user. Copy the Session pooler string again from Dashboard → Connect. The user must look like postgres.<project-ref>.'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    'The host name could not be found. Check your internet connection and the connection string.'],
  [/ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|socket hang up|fetch failed|Connection terminated/i,
    'The network connection failed. Check your internet, then press Run again. Finished work is kept.'],
  [/Cannot connect to the Docker daemon|docker daemon|docker: not found|Is the docker daemon running/i,
    'Docker is not running. Start Docker, then press Run again.'],
  [/Invalid API key|Invalid Compact JWS|invalid signature|JWSError|\b401\b|Unauthorized/i,
    'The key was refused. Use the secret key (sb_secret_…) or the legacy service_role key of this project, and a valid personal access token.'],
  [/ENOSPC|no space left/i,
    'The disk is full. Free some space, then press Run again.'],
  [/ENOENT.*(supabase|psql|docker)|spawn (supabase|psql|docker) ENOENT/i,
    'A required program is missing on this computer (supabase CLI, psql or docker).'],
  [/permission denied/i,
    'The database refused an action. The detail box shows the exact statement. Send it to Claude.'],
  [/already exists/i,
    'Something already exists in the new project. The restore runs as one transaction, so nothing from this run was saved. Check the detail box.'],
  [/does not exist/i,
    'Something the statement needs is missing in the new project, often an extension. Run step B1 again, then this step.'],
];

export function hintFor(err) {
  const text = `${err?.message || err} ${err?.cause?.code || ''} ${err?.cause?.message || ''}`;
  for (const [re, hint] of RULES) if (re.test(text)) return hint;
  return null;
}

export function describe(err) {
  if (!err) return 'Unknown error';
  const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
  return `${err.message || String(err)}${cause}`;
}
