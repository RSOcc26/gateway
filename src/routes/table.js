// The route table: the only place that maps public paths to services.
// Public /api/<service>/v1/... is forwarded to <service URL>/v1/...
export const SERVICES = ['identity', 'access', 'workflow', 'inventory', 'production'];

// Routes that need an authenticated user but no company. Everything else
// requires a tenant (X-Tenant-Id) and a membership check. `newUser: true`
// marks the one route a user without a CompanyCentral account yet may call
// (it creates the account). `:param` matches one path segment.
const TENANTLESS = [
  { service: 'identity', method: 'GET', path: '/v1/me', newUser: true },
  // Platform administration (ADR-0003); identity checks the platform-admin role
  { service: 'identity', method: 'GET', path: '/v1/admin/users' },
  { service: 'identity', method: 'GET', path: '/v1/admin/users/:id' },
  { service: 'identity', method: 'PATCH', path: '/v1/admin/users/:id' },
  { service: 'identity', method: 'DELETE', path: '/v1/admin/users/:id' },
].map((r) => ({
  ...r,
  pattern: new RegExp(`^${r.path.replace(/:[a-z]+/gi, '[^/]+')}$`),
}));

// Splits a raw request URL into the service and the rest of the path, both
// still percent-encoded exactly as the client sent them
const RAW_API_PATH = /^\/api\/([^/?#]*)\/([^?#]*)/;
export const splitApiPath = (rawUrl) => {
  const match = RAW_API_PATH.exec(rawUrl);
  return match ? { service: match[1], rest: match[2] } : null;
};

// Encoded characters that would change the path's structure once decoded:
// "/" and "\" (segments), "#" and "?" (end of path), NUL
const ENCODED_DELIMITERS = /%(2f|5c|23|3f|00)/i;

// Resolves the raw (encoded) path to { service, path } or null when it must
// not be routed. The path is forwarded still encoded, so the upstream decodes
// exactly what the client sent and every check here sees the same resource.
export const resolveRoute = (service, rawRest) => {
  if (!SERVICES.includes(service)) return null;
  if (ENCODED_DELIMITERS.test(rawRest) || rawRest.includes('\\')) return null;
  // Normalize dot segments (also encoded ones) the same way the upstream will
  const path = new URL(`/${rawRest}`, 'http://upstream').pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null; // malformed escape such as a bare "%"
  }
  if (!decoded.startsWith('/v1/')) return null;
  // Service-to-service paths are never reachable from outside, however encoded
  if (decoded === '/v1/internal' || decoded.startsWith('/v1/internal/')) return null;
  return { service, path };
};

// The tenantless route entry for this request, or undefined; HEAD is served like GET
export const tenantlessRoute = ({ service, path }, method) => {
  const m = method === 'HEAD' ? 'GET' : method;
  return TENANTLESS.find((r) => r.service === service && r.method === m && r.pattern.test(path));
};
