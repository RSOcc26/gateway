import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createOidcVerifier, bearerToken, OidcUnavailableError } from '../../src/middleware/auth.js';

// A minimal local identity provider: discovery document and JWKS
let server; let issuer; let privateKey; let certsStatus = 200; let discoveryCalls = 0;
before(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/realms/cc/.well-known/openid-configuration') {
      discoveryCalls += 1;
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs` }));
    } else if (req.url === '/realms/cc/certs') {
      res.statusCode = certsStatus;
      res.end(certsStatus === 200 ? JSON.stringify({ keys: [jwk] }) : 'Bad Gateway');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}/realms/cc`;
});
after(() => server.close());

const token = ({ aud = 'gateway', iss = issuer, exp = '5m' } = {}) => new SignJWT({ email: 'ana@test.local' })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(iss).setAudience(aud).setSubject('kc-1').setIssuedAt().setExpirationTime(exp)
  .sign(privateKey);

test('accepts a valid access token found through discovery', async () => {
  const oidc = createOidcVerifier({ issuer, audience: 'gateway' });
  const claims = await oidc.verify(await token());
  assert.equal(claims.sub, 'kc-1');
});

test('rejects a wrong audience, wrong issuer or expired token', async () => {
  const oidc = createOidcVerifier({ issuer, audience: 'gateway' });
  await assert.rejects(oidc.verify(await token({ aud: 'web' })), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  await assert.rejects(oidc.verify(await token({ iss: 'http://evil.test' })), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  await assert.rejects(oidc.verify(await token({ exp: '-1m' })), { code: 'ERR_JWT_EXPIRED' });
});

test('rejects a token without a subject', async () => {
  const oidc = createOidcVerifier({ issuer, audience: 'gateway' });
  const noSub = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer).setAudience('gateway').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(oidc.verify(noSub), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
});

test('an unreachable provider is reported as unavailable, not as a bad token', async () => {
  const oidc = createOidcVerifier({ issuer: 'http://127.0.0.1:1/realms/cc', audience: 'gateway' });
  await assert.rejects(oidc.ready(), OidcUnavailableError);
});

test('bearerToken extracts only well-formed bearer tokens', () => {
  assert.equal(bearerToken('Bearer abc.def-ghi_jkl'), 'abc.def-ghi_jkl');
  assert.equal(bearerToken('bearer abc'), 'abc', 'the scheme is case-insensitive');
  assert.equal(bearerToken('Bearer a b'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test('a JWKS endpoint answering 5xx is an outage (503), not an invalid token (401)', async () => {
  certsStatus = 502;
  try {
    const oidc = createOidcVerifier({ issuer, audience: 'gateway' });
    await assert.rejects(oidc.verify(await token()), OidcUnavailableError);
    await assert.rejects(oidc.ready(), OidcUnavailableError, 'readiness actually fetches the keys');
  } finally {
    certsStatus = 200;
  }
});

test('readiness fetches the keys every time, even with an explicit JWKS URL', async () => {
  const oidc = createOidcVerifier({ issuer, audience: 'gateway', jwksUrl: `${issuer}/certs` });
  await oidc.ready();
  certsStatus = 503;
  try {
    await assert.rejects(oidc.ready(), OidcUnavailableError);
  } finally {
    certsStatus = 200;
  }
});

test('concurrent requests share one discovery; a failed one is remembered briefly', async () => {
  const before = discoveryCalls;
  const oidc = createOidcVerifier({ issuer, audience: 'gateway' });
  const t = await token();
  await Promise.all(Array.from({ length: 10 }, () => oidc.verify(t)));
  assert.equal(discoveryCalls - before, 1);

  let calls = 0;
  const down = createOidcVerifier({
    issuer: 'http://idp.test/realms/cc', audience: 'gateway',
    fetchImpl: async () => { calls += 1; throw new TypeError('fetch failed'); },
  });
  await assert.rejects(down.ready(), OidcUnavailableError);
  await assert.rejects(down.ready(), OidcUnavailableError);
  assert.equal(calls, 1, 'the second call fails fast without a new discovery');
});

test('a discovery document without a valid jwks_uri is an outage, not a crash', async () => {
  const oidc = createOidcVerifier({
    issuer: 'http://idp.test/realms/cc', audience: 'gateway',
    fetchImpl: async () => Response.json({ issuer: 'http://idp.test/realms/cc' }),
  });
  await assert.rejects(oidc.ready(), OidcUnavailableError);
});
