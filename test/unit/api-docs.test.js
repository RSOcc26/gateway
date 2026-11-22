import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, config } from './helpers.js';

const withUi = { ...config, apiDocs: { uiEnabled: true, clientId: 'api-docs' } };

test('GET /api-docs returns the contract as JSON without a token', async () => {
  const res = await (await app()).inject('/api-docs');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const doc = res.json();
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.paths['/api/identity/v1/me']);
  assert.ok(res.headers['x-request-id']);
});

test('GET /api-docs returns YAML when asked', async () => {
  const res = await (await app()).inject({ url: '/api-docs', headers: { accept: 'application/yaml' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/yaml/);
  assert.match(res.body, /^openapi: 3\.1\.0/);
});

test('the contract documents every routed identity operation', async () => {
  const doc = (await (await app()).inject('/api-docs')).json();
  const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((op) => op.operationId)).filter(Boolean);
  for (const id of ['getMe', 'listUsers', 'getUser', 'updateUser', 'deleteUser']) assert.ok(ids.includes(id), id);
});

test('the interactive docs are off unless enabled', async () => {
  assert.equal((await (await app()).inject('/api-docs/ui')).statusCode, 404);
});

test('when enabled, the interactive docs sign in with PKCE through the api-docs client', async () => {
  const gw = await app({ config: withUi });
  const page = await gw.inject('/api-docs/ui/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const init = await gw.inject('/api-docs/ui/static/swagger-initializer.js');
  assert.equal(init.statusCode, 200);
  assert.match(init.body, /"clientId":"api-docs"/);
  assert.match(init.body, /"usePkceWithAuthorizationCodeGrant":true/);
  assert.equal((await gw.inject('/api-docs/ui/static/oauth2-redirect.html')).statusCode, 200);
});
