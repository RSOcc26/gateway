import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';

const env = {
  IDENTITY_URL: 'http://localhost:3001/',
  ACCESS_URL: 'http://localhost:3002',
  WORKFLOW_URL: 'http://localhost:3003',
  INVENTORY_URL: 'http://localhost:3004',
  PRODUCTION_URL: 'http://localhost:3005',
  OIDC_ISSUER: 'http://localhost:8180/realms/companycentral',
  OIDC_AUDIENCE: 'gateway',
  TENANT_CONTEXT_ISSUER: 'companycentral-gateway',
  TENANT_CONTEXT_SIGNING_KEY_FILE: '.local/key.pem',
};

test('loads defaults and normalizes service URLs', () => {
  const config = loadConfig(env);
  assert.equal(config.port, 8080);
  assert.equal(config.services.identity, 'http://localhost:3001');
  assert.equal(config.tenantContext.ttlSeconds, 60);
  assert.equal(config.oidc.jwksUrl, undefined);
});

test('fails fast on missing or invalid values', () => {
  assert.throws(() => loadConfig({ ...env, OIDC_AUDIENCE: '' }), /OIDC_AUDIENCE is required/);
  assert.throws(() => loadConfig({ ...env, IDENTITY_URL: 'not a url' }), /IDENTITY_URL must be a valid URL/);
  assert.throws(() => loadConfig({ ...env, MAX_BODY_BYTES: '-1' }), /MAX_BODY_BYTES must be a positive integer/);
});
