import { generateKeyPairSync } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { createTenantContextSigner } from '../../src/middleware/tenant-context.js';
import { OidcUnavailableError } from '../../src/middleware/auth.js';

export const config = {
  maxBodyBytes: 1024,
  maxResponseBytes: 1048576,
  upstreamTimeoutMs: 200,
  services: {
    identity: 'http://identity.test',
    access: 'http://access.test',
    workflow: 'http://workflow.test',
    inventory: 'http://inventory.test',
    production: 'http://production.test',
  },
};

export const privateKeyPem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

export const newSigner = () => createTenantContextSigner({
  issuer: 'companycentral-gateway', ttlSeconds: 60, privateKeyPem: privateKeyPem(),
});

export const user = {
  iss: 'http://idp.test/realms/cc', sub: 'kc-1', aud: 'gateway',
  email: 'ana@test.local', email_verified: true, name: 'Ana',
  realm_access: { roles: ['offline_access', 'platform-admin'] },
};
export const USER_ID = '0192f8e0-0000-7000-8000-000000000001';

// Fake user resolver: subject -> CompanyCentral user
export const resolverFor = (accounts = { 'kc-1': { id: USER_ID, status: 'active' } }) => ({
  resolve: async (sub) => {
    if (accounts === 'down') {
      const { UserLookupUnavailableError } = await import('../../src/middleware/users.js');
      throw new UserLookupUnavailableError('down');
    }
    return accounts[sub] ?? null;
  },
});

// Fake OIDC verifier: "valid" is accepted, "down" simulates an unreachable provider
export const oidc = {
  verify: async (token) => {
    if (token === 'down') throw new OidcUnavailableError('unreachable');
    if (token !== 'valid') throw new Error('invalid');
    return user;
  },
  ready: async () => {},
};

// Records upstream calls and answers with the given responder
export const fakeFetch = (respond = () => Response.json({ ok: true })) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ...init });
    return respond(url, init, calls.length);
  };
  return { impl, calls };
};

export const app = async ({ fetchImpl = fakeFetch().impl, signer, users = resolverFor(), config: cfg = config, ...rest } = {}) =>
  buildApp({ config: cfg, oidc, signer: signer ?? await newSigner(), users, fetchImpl, ...rest });

export const auth = { authorization: 'Bearer valid' };
