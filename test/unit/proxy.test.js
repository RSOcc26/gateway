import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { app, auth, config, fakeFetch, newSigner, resolverFor, USER_ID } from './helpers.js';

const problem = (res, status) => {
  assert.equal(res.statusCode, status);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
  assert.equal(res.json().status, status);
  assert.equal(res.json().correlationId, res.headers['x-request-id']);
};

test('GET /api/identity/v1/me forwards to identity with a signed context', async () => {
  const signer = await newSigner();
  const upstream = fakeFetch(() => Response.json({ id: 'u1' }, { headers: { etag: '"1"' } }));
  const res = await (await app({ signer, fetchImpl: upstream.impl })).inject({
    url: '/api/identity/v1/me?x=1',
    headers: { ...auth, 'x-request-id': 'req-123' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: 'u1' });
  assert.equal(res.headers.etag, '"1"');
  assert.equal(res.headers['x-request-id'], 'req-123');

  const [call] = upstream.calls;
  assert.equal(call.url, 'http://identity.test/v1/me?x=1');
  assert.equal(call.headers['x-request-id'], 'req-123');
  const context = call.headers.authorization.replace('Bearer ', '');
  const { payload, protectedHeader } = await jwtVerify(context, createLocalJWKSet(signer.jwks), {
    issuer: 'companycentral-gateway', audience: 'service-identity', typ: 'tenant-context+jwt',
  });
  assert.equal(protectedHeader.alg, 'ES256');
  assert.equal(payload.idp_sub, 'kc-1');
  assert.equal(payload.idp_iss, 'http://idp.test/realms/cc');
  assert.equal(payload.email, 'ana@test.local');
  assert.equal(payload.rid, 'req-123');
  assert.equal(payload.sub, USER_ID);
  assert.deepEqual(payload.roles, ['platform-admin']);
  assert.equal(payload.exp - payload.iat, 60);
});

test('the client token and internal headers never reach the service', async () => {
  const upstream = fakeFetch();
  await (await app({ fetchImpl: upstream.impl })).inject({
    url: '/api/identity/v1/me',
    headers: { ...auth, 'x-tenant-id': 't1', 'x-user-id': 'admin', cookie: 'a=b', 'accept-language': 'sl' },
  });
  const { headers } = upstream.calls[0];
  assert.notEqual(headers.authorization, 'Bearer valid');
  assert.equal(headers['x-tenant-id'], undefined);
  assert.equal(headers['x-user-id'], undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['accept-language'], 'sl');
});

test('an unsafe X-Request-Id is replaced by a generated one', async () => {
  const res = await (await app()).inject({ url: '/api/identity/v1/me', headers: { ...auth, 'x-request-id': 'bad id\n' } });
  assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('missing or invalid tokens return 401 without calling the service', async () => {
  const upstream = fakeFetch();
  const gw = await app({ fetchImpl: upstream.impl });
  const missing = await gw.inject('/api/identity/v1/me');
  problem(missing, 401);
  assert.equal(missing.headers['www-authenticate'], 'Bearer');
  problem(await gw.inject({ url: '/api/identity/v1/me', headers: { authorization: 'Bearer forged' } }), 401);
  problem(await gw.inject({ url: '/api/identity/v1/me', headers: { authorization: 'Basic abc' } }), 401);
  assert.equal(upstream.calls.length, 0);
});

test('an unreachable identity provider returns 503', async () => {
  problem(await (await app()).inject({ url: '/api/identity/v1/me', headers: { authorization: 'Bearer down' } }), 503);
});

test('unknown, internal and traversal paths return 404 before authentication', async () => {
  const gw = await app();
  for (const url of [
    '/api/unknown/v1/me',
    '/api/identity/v2/me',
    '/api/identity/v1/internal/memberships/check',
    '/api/identity/v1/x/../internal/memberships/check',
    '/api/identity/v1/%2e%2e/internal/x',
    '/api/identity/v1%2Finternal',
    '/nope',
  ]) problem(await gw.inject({ url, headers: auth }), 404);
});

test('tenant-scoped routes fail closed until membership checks exist', async () => {
  const upstream = fakeFetch();
  const res = await (await app({ fetchImpl: upstream.impl })).inject({
    url: '/api/inventory/v1/stock', headers: { ...auth, 'x-tenant-id': 't1' },
  });
  problem(res, 501);
  assert.equal(upstream.calls.length, 0);
});

test('a body above MAX_BODY_BYTES returns 413', async () => {
  const res = await (await app()).inject({
    method: 'POST', url: '/api/identity/v1/me', headers: { ...auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ x: 'a'.repeat(2000) }),
  });
  problem(res, 413);
});

test('an upstream timeout returns 504', async () => {
  const slow = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  problem(await (await app({ fetchImpl: slow.impl })).inject({ url: '/api/identity/v1/me', headers: auth }), 504);
  assert.equal(slow.calls.length, 1);
});

test('a refused connection is retried once for GET, then returns 503', async () => {
  const refused = fakeFetch(() => { throw new TypeError('fetch failed'); });
  problem(await (await app({ fetchImpl: refused.impl })).inject({ url: '/api/identity/v1/me', headers: auth }), 503);
  assert.equal(refused.calls.length, 2);
});

test('a retry that succeeds returns the upstream response', async () => {
  const flaky = fakeFetch((url, init, n) => {
    if (n === 1) throw new TypeError('fetch failed');
    return Response.json({ ok: true });
  });
  const res = await (await app({ fetchImpl: flaky.impl })).inject({ url: '/api/identity/v1/me', headers: auth });
  assert.equal(res.statusCode, 200);
});

test('upstream 5xx: problem documents pass through, others are wrapped', async () => {
  const withProblem = fakeFetch(() => new Response(JSON.stringify({ title: 'DB down', status: 503 }), {
    status: 503, headers: { 'content-type': 'application/problem+json' },
  }));
  const passed = await (await app({ fetchImpl: withProblem.impl })).inject({ url: '/api/identity/v1/me', headers: auth });
  assert.equal(passed.statusCode, 503);
  assert.equal(passed.json().title, 'DB down');

  const html = fakeFetch(() => new Response('<h1>oops</h1>', { status: 500, headers: { 'content-type': 'text/html' } }));
  problem(await (await app({ fetchImpl: html.impl })).inject({ url: '/api/identity/v1/me', headers: auth }), 500);
});

test('a deleted user is rejected even with a valid token', async () => {
  const upstream = fakeFetch();
  const gw = await app({ fetchImpl: upstream.impl, users: resolverFor({ 'kc-1': { id: USER_ID, status: 'deleted' } }) });
  const res = await gw.inject({ url: '/api/identity/v1/me', headers: auth });
  problem(res, 401);
  assert.equal(res.json().detail, 'This account was deleted.');
  assert.equal(upstream.calls.length, 0);
});

test('a user without a CompanyCentral account may only call /me, which creates it', async () => {
  const upstream = fakeFetch();
  const gw = await app({ fetchImpl: upstream.impl, users: resolverFor({}) });
  const me = await gw.inject({ url: '/api/identity/v1/me', headers: auth });
  assert.equal(me.statusCode, 200);
  const context = upstream.calls[0].headers.authorization.replace('Bearer ', '');
  const claims = JSON.parse(Buffer.from(context.split('.')[1], 'base64url'));
  assert.equal(claims.sub, undefined);
  problem(await gw.inject({ url: '/api/identity/v1/admin/users', headers: auth }), 403);
  assert.equal(upstream.calls.length, 1);
});

test('admin routes are forwarded with their method, path parameter and body', async () => {
  const upstream = fakeFetch(() => Response.json({ ok: true }));
  const gw = await app({ fetchImpl: upstream.impl });
  for (const [method, url] of [
    ['GET', '/api/identity/v1/admin/users?search=ana'],
    ['GET', `/api/identity/v1/admin/users/${USER_ID}`],
    ['PATCH', `/api/identity/v1/admin/users/${USER_ID}`],
    ['DELETE', `/api/identity/v1/admin/users/${USER_ID}`],
  ]) {
    const res = await gw.inject({
      method, url, headers: { ...auth, 'content-type': 'application/json' },
      payload: method === 'PATCH' ? '{"givenName":"Ana"}' : undefined,
    });
    assert.equal(res.statusCode, 200, `${method} ${url}`);
  }
  assert.deepEqual(upstream.calls.map((c) => `${c.method} ${c.url}`), [
    'GET http://identity.test/v1/admin/users?search=ana',
    `GET http://identity.test/v1/admin/users/${USER_ID}`,
    `PATCH http://identity.test/v1/admin/users/${USER_ID}`,
    `DELETE http://identity.test/v1/admin/users/${USER_ID}`,
  ]);
  assert.equal(upstream.calls[2].body.toString(), '{"givenName":"Ana"}');
  // Nested paths below a user are not routed
  problem(await gw.inject({ method: 'DELETE', url: `/api/identity/v1/admin/users/${USER_ID}/x`, headers: auth }), 501);
});

test('an unavailable user lookup returns 503 and forwards nothing', async () => {
  const upstream = fakeFetch();
  problem(await (await app({ fetchImpl: upstream.impl, users: resolverFor('down') })).inject({ url: '/api/identity/v1/me', headers: auth }), 503);
  assert.equal(upstream.calls.length, 0);
});

test('encoded delimiters cannot change which resource a request reaches', async () => {
  const upstream = fakeFetch();
  const gw = await app({ fetchImpl: upstream.impl });
  for (const url of [
    `/api/identity/v1/admin/users/${USER_ID}%23junk`,
    `/api/identity/v1/admin/users/${USER_ID}%3Fx=1`,
    '/api/identity/v1/admin/users/a%2Fb',
    '/api/identity/v1/admin/users/a%5Cb',
    '/api/identity/v1/%69nternal/users/by-subject/kc-1',
  ]) problem(await gw.inject({ method: 'DELETE', url, headers: auth }), 404);
  // A malformed escape is rejected by Fastify itself before routing
  assert.equal((await gw.inject({ method: 'DELETE', url: '/api/identity/v1/admin/users/%', headers: auth })).statusCode, 400);
  assert.equal(upstream.calls.length, 0);
});

test('the path is forwarded still encoded, so the service sees what the client sent', async () => {
  const upstream = fakeFetch(() => Response.json({}));
  await (await app({ fetchImpl: upstream.impl })).inject({ url: '/api/identity/v1/admin/users/a%20b', headers: auth });
  assert.equal(upstream.calls[0].url, 'http://identity.test/v1/admin/users/a%20b');
});

test('HEAD is served like GET', async () => {
  const res = await (await app()).inject({ method: 'HEAD', url: '/api/identity/v1/me', headers: auth });
  assert.equal(res.statusCode, 200);
});

test('a body that stalls after the headers returns 504, not 500', async () => {
  const stalled = fakeFetch((url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
    },
  }), { headers: { 'content-type': 'application/json' } }));
  problem(await (await app({ fetchImpl: stalled.impl })).inject({ url: '/api/identity/v1/me', headers: auth }), 504);
});

test('an upstream response above MAX_RESPONSE_BYTES returns 502', async () => {
  const big = fakeFetch(() => new Response('x'.repeat(4096)));
  const res = await (await app({ fetchImpl: big.impl, config: { ...config, maxResponseBytes: 1024 } }))
    .inject({ url: '/api/identity/v1/me', headers: auth });
  problem(res, 502);
});

test('Location headers never expose internal service URLs', async () => {
  const redirect = fakeFetch((url) => new Response(null, {
    status: 201,
    headers: { location: url.includes('users/') ? '/v1/admin/users/1' : 'http://identity.test/v1/admin/users/2' },
  }));
  const gw = await app({ fetchImpl: redirect.impl });
  const a = await gw.inject({ url: '/api/identity/v1/admin/users', headers: auth });
  assert.equal(a.headers.location, '/api/identity/v1/admin/users/2');
  const b = await gw.inject({ url: `/api/identity/v1/admin/users/${USER_ID}`, headers: auth });
  assert.equal(b.headers.location, '/api/identity/v1/admin/users/1');
});

test('X-Forwarded-For keeps the incoming chain and appends the peer', async () => {
  const upstream = fakeFetch();
  await (await app({ fetchImpl: upstream.impl })).inject({
    url: '/api/identity/v1/me', headers: { ...auth, 'x-forwarded-for': '203.0.113.7' }, remoteAddress: '10.0.0.5',
  });
  assert.equal(upstream.calls[0].headers['x-forwarded-for'], '203.0.113.7, 10.0.0.5');
});

test('an unknown account status fails closed', async () => {
  const upstream = fakeFetch();
  const gw = await app({ fetchImpl: upstream.impl, users: resolverFor({ 'kc-1': { id: USER_ID, status: 'suspended' } }) });
  problem(await gw.inject({ url: '/api/identity/v1/me', headers: auth }), 401);
  assert.equal(upstream.calls.length, 0);
});
