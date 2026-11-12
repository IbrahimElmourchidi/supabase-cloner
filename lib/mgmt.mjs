import { request } from './http.mjs';
import { StepError } from './errors.mjs';

const API = 'https://api.supabase.com';

/** Supabase Management API client (personal access token). */
export function mgmt(pat, signal, onRetry) {
  if (!pat) throw new StepError('Enter the personal access token and press Save.',
    'Create one at supabase.com/dashboard/account/tokens.');
  const call = async (method, path, body) => {
    const res = await request(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      read: 'json',
      signal,
      retries: 4,
      timeoutMs: 60000,
      onRetry,
    });
    return res.data;
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
  };
}
