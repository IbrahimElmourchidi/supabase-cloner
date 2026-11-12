import { StepError } from './errors.mjs';

const label = (side) => (side === 'old' ? 'OLD' : 'NEW');

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Parses a Postgres URL. The password may contain unencoded @ or : characters. */
export function parseDbUrl(raw) {
  const s = String(raw || '').trim();
  const m = /^(postgres(?:ql)?):\/\/(.*)$/i.exec(s);
  if (!m) throw new StepError('The connection string must start with postgresql://',
    'Copy it from Dashboard → Connect → Session pooler.');
  const rest = m[2];
  const at = rest.lastIndexOf('@');
  if (at < 0) throw new StepError('The connection string has no user part (user@host).',
    'Copy it from Dashboard → Connect → Session pooler.');
  const userinfo = rest.slice(0, at);
  const hostpart = rest.slice(at + 1);
  const colon = userinfo.indexOf(':');
  const user = safeDecode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? '' : (userinfo.slice(colon + 1) === '[YOUR-PASSWORD]'
    ? '[YOUR-PASSWORD]' : safeDecode(userinfo.slice(colon + 1)));
  const hm = /^([^:/?]+)(?::(\d+))?(?:\/([^?]*))?(\?.*)?$/.exec(hostpart);
  if (!hm) throw new StepError('The host part of the connection string is not valid.');
  return { user, password, host: hm[1], port: hm[2] || '5432', database: safeDecode(hm[3] || 'postgres') };
}

export function buildDbUrl({ user, password, host, port, database }, { sslmode } = {}) {
  const q = sslmode ? `?sslmode=${sslmode}` : '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}${q}`;
}

/** Returns connection info for one side, after checking it belongs to that project. */
export function dbConn(cfg, side) {
  const s = cfg[side];
  const other = cfg[side === 'old' ? 'new' : 'old'];
  if (!s?.ref) throw new StepError(`Enter the ${label(side)} project ref.`);
  if (!s.dbUrl) throw new StepError(`Enter the ${label(side)} database connection string and press Save.`);
  const p = parseDbUrl(s.dbUrl);
  const password = s.dbPassword || (p.password !== '[YOUR-PASSWORD]' ? p.password : '');
  if (!password) throw new StepError(`Enter the ${label(side)} database password and press Save.`);
  const belongs = p.user.includes(s.ref) || p.host.includes(s.ref);
  if (!belongs) {
    throw new StepError(`The ${label(side)} connection string does not belong to project ${s.ref}.`,
      'Copy it again from the right project: Dashboard → Connect → Session pooler. The user should be postgres.<project-ref>.');
  }
  if (other?.ref && (p.user.includes(other.ref) || p.host.includes(other.ref))) {
    throw new StepError(`The ${label(side)} connection string points to the other project (${other.ref}).`,
      'The OLD and NEW connection strings seem to be swapped. Fix them and press Save.');
  }
  if (cfg.old.ref === cfg.new.ref) throw new StepError('The OLD and NEW project refs are the same.');
  const full = { ...p, password };
  return {
    pgUrl: buildDbUrl(full),
    cliUrl: buildDbUrl(full),
    psqlUrl: buildDbUrl(full, { sslmode: 'require' }),
    host: p.host,
    user: p.user,
  };
}

export function apiBase(ref) {
  return `https://${ref}.supabase.co`;
}

export function hostOf(ref) {
  return `${ref}.supabase.co`;
}
