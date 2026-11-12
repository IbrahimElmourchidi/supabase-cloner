import { request } from './http.mjs';
import { apiBase } from './conn.mjs';

export const encodePath = (name) => String(name).split('/').map(encodeURIComponent).join('/');

const authHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });

export async function listBuckets(ref, key, signal) {
  const res = await request(`${apiBase(ref)}/storage/v1/bucket`, {
    headers: authHeaders(key), read: 'json', signal, retries: 2, timeoutMs: 30000,
  });
  return res.data;
}

export async function createBucket(ref, key, bucket, signal) {
  await request(`${apiBase(ref)}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      file_size_limit: bucket.file_size_limit ?? null,
      allowed_mime_types: bucket.allowed_mime_types ?? null,
    }),
    read: 'json', signal, retries: 3,
  });
}

const BASE_TIMEOUT_MS = 180000;
const SLOWEST_BYTES_PER_SEC = 16 * 1024;

/** Time allowed for one file: 3 min, plus enough to move the file at 16 KB/s (a slow line shared by 8 transfers). */
export const timeoutFor = (bytes) => BASE_TIMEOUT_MS + Math.ceil((Number(bytes) || 0) / SLOWEST_BYTES_PER_SEC) * 1000;

export async function downloadObject(ref, key, bucket, name, { signal, onRetry, size }) {
  const res = await request(`${apiBase(ref)}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodePath(name)}`, {
    headers: authHeaders(key), read: 'buffer', signal, retries: 5, timeoutMs: timeoutFor(size), onRetry,
  });
  return res.data;
}

export async function uploadObject(ref, key, bucket, name, buffer, { contentType, cacheControl, signal, onRetry }) {
  const headers = {
    ...authHeaders(key),
    'Content-Type': contentType || 'application/octet-stream',
    'x-upsert': 'true',
  };
  if (cacheControl) headers['Cache-Control'] = /max-age|no-cache|no-store/.test(cacheControl) ? cacheControl : `max-age=${cacheControl}`;
  await request(`${apiBase(ref)}/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(name)}`, {
    method: 'POST', headers, body: buffer, read: 'none', signal, retries: 5, timeoutMs: timeoutFor(buffer.length), onRetry,
  });
}

export async function fetchStatus(url, signal) {
  try {
    const res = await request(url, { read: 'none', signal, retries: 2, timeoutMs: 30000, okStatuses: [200, 206, 304, 400, 401, 403, 404] });
    return res.status;
  } catch (e) {
    return e.status || 0;
  }
}
