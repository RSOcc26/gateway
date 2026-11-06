import { setTimeout as sleep } from 'node:timers/promises';

// Only these client headers reach a service. Everything else, including any
// client-supplied identity, tenant or internal header, is dropped.
const FORWARDED_REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'user-agent', 'prefer', 'idempotency-key',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
];

// Hop-by-hop headers, and headers the gateway sets itself, are not copied back.
// fetch() has already decoded the body, so its encoding and length no longer apply.
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'trailer', 'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length', 'set-cookie', 'x-request-id',
]);

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export class UpstreamTimeoutError extends Error {}
export class UpstreamUnavailableError extends Error {}

const isTimeout = (err) => err.name === 'TimeoutError' || err.name === 'AbortError';

// Forwards one request to a service: one retry with jitter for idempotent
// methods when the connection fails, never after a timeout or for POST.
export const forward = async ({ fetchImpl, url, method, headers, body, timeoutMs }) => {
  const attempt = () => fetchImpl(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    return await attempt();
  } catch (err) {
    if (isTimeout(err)) throw new UpstreamTimeoutError(err.message);
    if (!IDEMPOTENT.has(method)) throw new UpstreamUnavailableError(err.message);
  }
  await sleep(50 + Math.random() * 100);
  try {
    return await attempt();
  } catch (err) {
    if (isTimeout(err)) throw new UpstreamTimeoutError(err.message);
    throw new UpstreamUnavailableError(err.message);
  }
};

export const upstreamHeaders = (req, tenantContext) => {
  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  headers.authorization = `Bearer ${tenantContext}`;
  headers['x-request-id'] = req.id;
  // Standard proxy behaviour: append the peer to the chain received so far
  const chain = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = typeof chain === 'string' && chain ? `${chain}, ${req.ip}` : req.ip;
  return headers;
};

// Internal service URLs never reach the browser: a Location pointing at the
// service (absolute, or relative to its root) is rewritten to the public path
const publicLocation = (location, { serviceUrl, publicPrefix }) => {
  if (location.startsWith(`${serviceUrl}/`)) return publicPrefix + location.slice(serviceUrl.length);
  if (location.startsWith('/') && !location.startsWith('//')) return publicPrefix + location;
  return location;
};

export const copyResponseHeaders = (upstream, reply, target) => {
  // Headers the upstream names in Connection are hop-by-hop too (RFC 9110 7.6.1)
  const nominated = new Set((upstream.headers.get('connection') ?? '').toLowerCase().split(',').map((h) => h.trim()));
  for (const [name, value] of upstream.headers) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || nominated.has(name)) continue;
    if (name === 'location' || name === 'content-location') reply.header(name, publicLocation(value, target));
    else reply.header(name, value);
  }
};
