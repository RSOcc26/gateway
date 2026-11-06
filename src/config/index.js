// Loads and validates configuration from environment variables; fails fast on startup
const required = (env, name) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInt = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const url = (env, name) => {
  const value = required(env, name);
  try {
    return new URL(value).href.replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
};

export const loadConfig = (env = process.env) => ({
  port: positiveInt(env, 'PORT', 8080),
  logLevel: env.LOG_LEVEL || 'info',
  services: {
    identity: url(env, 'IDENTITY_URL'),
    access: url(env, 'ACCESS_URL'),
    workflow: url(env, 'WORKFLOW_URL'),
    inventory: url(env, 'INVENTORY_URL'),
    production: url(env, 'PRODUCTION_URL'),
  },
  upstreamTimeoutMs: positiveInt(env, 'UPSTREAM_TIMEOUT_MS', 5000),
  maxBodyBytes: positiveInt(env, 'MAX_BODY_BYTES', 1048576),
  maxResponseBytes: positiveInt(env, 'MAX_RESPONSE_BYTES', 10485760),
  userCacheTtlSeconds: positiveInt(env, 'USER_CACHE_TTL_SECONDS', 5),
  apiDocs: {
    uiEnabled: env.API_DOCS_UI_ENABLED === 'true',
    clientId: env.API_DOCS_OIDC_CLIENT_ID || 'api-docs',
  },
  oidc: {
    issuer: required(env, 'OIDC_ISSUER'),
    audience: required(env, 'OIDC_AUDIENCE'),
    // Optional override; by default the JWKS URL comes from OIDC discovery
    jwksUrl: env.OIDC_JWKS_URL ? url(env, 'OIDC_JWKS_URL') : undefined,
  },
  tenantContext: {
    issuer: required(env, 'TENANT_CONTEXT_ISSUER'),
    signingKeyFile: required(env, 'TENANT_CONTEXT_SIGNING_KEY_FILE'),
    ttlSeconds: positiveInt(env, 'TENANT_CONTEXT_TTL_SECONDS', 60),
  },
});
