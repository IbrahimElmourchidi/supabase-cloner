import { CancelledError } from './errors.mjs';
import { sleep } from './util.mjs';

export class HttpError extends Error {
  constructor(status, body, url) {
    const short = String(body || '').slice(0, 500);
    super(`HTTP ${status} from ${url.replace(/\?.*$/, '')}: ${short}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED']);

function isNetworkError(e) {
  if (e?.name === 'TimeoutError' || e?.message === 'request timeout') return true;
  if (e?.name === 'TypeError' && /fetch failed|terminated/i.test(e.message)) return true;
  const code = e?.cause?.code || e?.code;
  return NET_CODES.has(code);
}

const DEFAULT_RETRY_ON = (status) => status === 429 || status === 408 || status >= 500;

/**
 * fetch with timeout, retries and cancel. The body is read inside the retry loop,
 * so a connection that drops while downloading is retried too.
 * read: 'buffer' | 'json' | 'text' | 'none'
 */
export async function request(url, {
  method = 'GET', headers = {}, body, read = 'json', signal, retries = 5,
  timeoutMs = 120000, retryOn = DEFAULT_RETRY_ON, okStatuses, onRetry,
} = {}) {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new CancelledError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('request timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(new CancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
      if (!ok) {
        const text = await res.text().catch(() => '');
        if (retryOn(res.status) && attempt < retries) {
          const err = new HttpError(res.status, text, url);
          err.retryable = true;
          throw err;
        }
        throw new HttpError(res.status, text, url);
      }
      let data = null;
      if (read === 'buffer') data = Buffer.from(await res.arrayBuffer());
      else if (read === 'json') { const t = await res.text(); data = t ? JSON.parse(t) : null; }
      else if (read === 'text') data = await res.text();
      else await res.arrayBuffer().catch(() => null);
      return { status: res.status, headers: res.headers, data };
    } catch (e) {
      if (signal?.aborted) throw new CancelledError();
      const retryable = e?.retryable || isNetworkError(e) || ctrl.signal.aborted;
      if (!retryable || attempt >= retries) {
        if (ctrl.signal.aborted && !(e instanceof HttpError)) {
          const te = new Error(`request timeout after ${Math.round(timeoutMs / 1000)}s: ${url.replace(/\?.*$/, '')}`);
          te.cause = e;
          throw te;
        }
        throw e;
      }
      attempt++;
      const wait = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      onRetry?.(attempt, e, wait);
      await sleep(wait, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
