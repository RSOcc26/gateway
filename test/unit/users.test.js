import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createUserResolver, UserLookupUnavailableError } from '../../src/middleware/users.js';
import { newSigner } from './helpers.js';

const resolverWith = async (respond, ttlMs = 60_000) => {
  const signer = await newSigner();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(url); };
  return { resolver: createUserResolver({ identityUrl: 'http://identity.test', signer, ttlMs, fetchImpl }), calls, signer };
};

test('looks up the subject with a gateway service context', async () => {
  const { resolver, calls, signer } = await resolverWith(() => Response.json({ id: 'u1', status: 'active', email: 'x' }));
  assert.deepEqual(await resolver.resolve('kc/1', 'r1'), { id: 'u1', status: 'active' });
  assert.equal(calls[0].url, 'http://identity.test/v1/internal/users/by-subject/kc%2F1');
  const context = calls[0].init.headers.authorization.replace('Bearer ', '');
  const { payload } = await jwtVerify(context, createLocalJWKSet(signer.jwks), { audience: 'service-identity' });
  assert.equal(payload.svc, 'gateway');
  assert.equal(payload.sub, undefined);
});

test('caches known users but not unknown ones', async () => {
  const { resolver, calls } = await resolverWith((url) => (url.endsWith('kc-1')
    ? Response.json({ id: 'u1', status: 'active' })
    : new Response(null, { status: 404 })));
  await resolver.resolve('kc-1', 'r');
  await resolver.resolve('kc-1', 'r');
  assert.equal(await resolver.resolve('kc-new', 'r'), null);
  assert.equal(await resolver.resolve('kc-new', 'r'), null);
  assert.equal(calls.length, 3);
});

test('cached answers expire after the TTL', async () => {
  const { resolver, calls } = await resolverWith(() => Response.json({ id: 'u1', status: 'active' }), 1);
  await resolver.resolve('kc-1', 'r');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await resolver.resolve('kc-1', 'r');
  assert.equal(calls.length, 2);
});

test('identity errors and outages are reported as unavailable, never as unknown', async () => {
  const failing = await resolverWith(() => new Response(null, { status: 500 }));
  await assert.rejects(failing.resolver.resolve('kc-1', 'r'), UserLookupUnavailableError);
  const offline = await resolverWith(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.resolver.resolve('kc-1', 'r'), UserLookupUnavailableError);
});

test('a malformed identity answer is an outage, never an active user', async () => {
  for (const respond of [
    () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => Response.json({}),
    () => Response.json({ id: 'u1' }),
  ]) {
    const { resolver } = await resolverWith(respond);
    await assert.rejects(resolver.resolve('kc-1', 'r'), UserLookupUnavailableError);
  }
});
