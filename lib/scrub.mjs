const secrets = new Set();

export function registerSecret(value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < 6) return;
  secrets.add(v);
  try { secrets.add(encodeURIComponent(v)); } catch { /* ignore */ }
  try {
    const json = JSON.parse(v);
    if (json && typeof json === 'object' && typeof json.private_key === 'string') {
      secrets.add(json.private_key);
      secrets.add(JSON.stringify(json.private_key).slice(1, -1));
    }
  } catch { /* not JSON */ }
}

export function scrub(text) {
  let t = String(text ?? '');
  for (const s of secrets) if (s && t.includes(s)) t = t.split(s).join('•••');
  t = t.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1•••@');
  t = t.replace(/\b(sb_secret_|sbp_)[A-Za-z0-9_-]+/g, '$1•••');
  t = t.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ•••');
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '•••private key•••');
  t = t.replace(/(PGPASSWORD=)\S+/g, '$1•••');
  return t;
}
