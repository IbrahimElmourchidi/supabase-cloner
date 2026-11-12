/**
 * Auth settings that belong to paid add-ons or paid plans. Supabase can bill a project
 * just because one of these fields is sent, even with the value "off". The tool never
 * sends them. If the old project has one turned on, the step tells you to turn it on
 * by hand, so the cost is your choice.
 */
export const PAID_AUTH_FEATURES = [
  { name: 'Advanced MFA - WebAuthn / passkeys', match: /(web_?authn|passkey)/i },
  { name: 'Advanced MFA - Phone', match: /^mfa_phone_/i },
  { name: 'MFA verification attempt hook', match: /^hook_mfa_verification_attempt_/i },
  { name: 'Password verification attempt hook', match: /^hook_password_verification_attempt_/i },
];

function isOn(v) {
  return v === true || v === 'true';
}

/**
 * Removes every paid field from `body`. Returns the removed keys and the names of the
 * paid features the old project has turned on.
 */
export function stripPaidAuth(auth, body) {
  const removed = [];
  const enabledInOld = [];
  for (const f of PAID_AUTH_FEATURES) {
    const keys = Object.keys(body).filter((k) => f.match.test(k));
    if (!keys.length) continue;
    removed.push(...keys);
    for (const k of keys) delete body[k];
    if (keys.some((k) => /_enabled$/.test(k) && isOn(auth[k]))) enabledInOld.push(f.name);
  }
  return { removed, enabledInOld };
}
