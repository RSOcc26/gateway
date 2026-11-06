import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, oidc } from './helpers.js';

test('GET /health/live returns ok', async () => {
  const res = await (await app()).inject('/health/live');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET /health/ready returns ok when the identity provider keys load', async () => {
  const res = await (await app()).inject('/health/ready');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checks.oidc.status, 'ok');
});

test('GET /health/ready returns 503 when the identity provider is down', async () => {
  const down = { ...oidc, ready: async () => { throw new Error('unreachable'); } };
  const res = await (await app({ oidc: down })).inject('/health/ready');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, 'fail');
});

test('GET /metrics returns Prometheus metrics', async () => {
  const gw = await app();
  await gw.inject('/api/identity/v1/me');
  const res = await gw.inject('/metrics');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /gateway_requests_total/);
});

test('GET /.well-known/jwks.json returns only the public key', async () => {
  const res = await (await app()).inject('/.well-known/jwks.json');
  assert.equal(res.statusCode, 200);
  const [key] = res.json().keys;
  assert.equal(key.kty, 'EC');
  assert.equal(key.alg, 'ES256');
  assert.ok(key.kid);
  assert.equal(key.d, undefined);
});
