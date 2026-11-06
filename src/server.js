import { readFile } from 'node:fs/promises';
import { loadConfig } from './config/index.js';
import { buildApp } from './app.js';
import { createOidcVerifier } from './middleware/auth.js';
import { createTenantContextSigner } from './middleware/tenant-context.js';
import { createUserResolver } from './middleware/users.js';

const config = loadConfig();

const signer = await createTenantContextSigner({
  issuer: config.tenantContext.issuer,
  ttlSeconds: config.tenantContext.ttlSeconds,
  privateKeyPem: await readFile(config.tenantContext.signingKeyFile, 'utf8'),
});

const app = buildApp({
  config,
  oidc: createOidcVerifier(config.oidc),
  signer,
  users: createUserResolver({
    identityUrl: config.services.identity,
    signer,
    ttlMs: config.userCacheTtlSeconds * 1000,
  }),
  logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
});

await app.listen({ port: config.port, host: '0.0.0.0' });
