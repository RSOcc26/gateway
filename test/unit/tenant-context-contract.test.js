import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { userClaims } from '../../src/middleware/tenant-context.js';
import { newSigner, user, USER_ID } from './helpers.js';

// In CI the contract repositories are listed in CONTRACT_REPOSITORIES and must
// be present; locally the comparison is skipped when the checkout is missing
const requiredInCi = (repository) =>
  (process.env.CONTRACT_REPOSITORIES ?? '').split(/\s+/).includes(repository);

// What the gateway signs must match the shared contract (.github/docs/contracts)
const COPY = new URL('../contracts/tenant-context.schema.json', import.meta.url);
const CANONICAL = new URL('../../../.github/docs/contracts/tenant-context.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(COPY, 'utf8'));
const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
ajv.addSchema(schema, 'tc');
const check = (part, value) => {
  const validate = ajv.getSchema(`tc#/definitions/${part}`);
  assert.ok(validate(value), `${part}: ${ajv.errorsText(validate.errors)}`);
};
const signAndCheck = async (claims, audience = 'service-identity') => {
  const token = await (await newSigner()).sign(claims, audience);
  check('header', decodeProtectedHeader(token));
  check('payload', decodeJwt(token));
  return decodeJwt(token);
};

test('a user context for a known user matches the contract', async () => {
  const payload = await signAndCheck(userClaims({ ...user, iat: 1793700000, given_name: 'Ana', family_name: 'Novak' }, 'req-1', USER_ID));
  assert.equal(payload.sub, USER_ID);
});

test('a user context before the first sign-in (no sub, no email) matches the contract', async () => {
  const { email, email_verified: v, name, ...bare } = user;
  await signAndCheck(userClaims({ ...bare, iat: 1793700000 }, 'req-2'));
});

test('the gateway service context matches the contract', async () => {
  await signAndCheck({ svc: 'gateway', rid: 'req-3' });
});

test('the contract rejects an unknown claim and a mixed context', async () => {
  const validate = ajv.getSchema('tc#/definitions/payload');
  const base = decodeJwt(await (await newSigner()).sign({ svc: 'gateway', rid: 'r' }, 'service-identity'));
  assert.equal(validate({ ...base, extra: 1 }), false);
  assert.equal(validate({ ...base, idp_sub: 'kc-1' }), false);
});

test('the schema copy is identical to the canonical one (when .github is checked out next to it)', { skip: !existsSync(CANONICAL) && !requiredInCi('.github') && 'no .github checkout next to this repository' }, () => {
  assert.equal(readFileSync(COPY, 'utf8'), readFileSync(CANONICAL, 'utf8'));
});
