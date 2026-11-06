import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

// In CI the contract repositories are listed in CONTRACT_REPOSITORIES and must
// be present; locally the comparison is skipped when the checkout is missing
const requiredInCi = (repository) =>
  (process.env.CONTRACT_REPOSITORIES ?? '').split(/\s+/).includes(repository);

// The gateway contract copies identity's body schemas for its public paths.
// Identity's contract is authoritative: when a service-identity checkout sits
// next to this repository, the copies must have the same structure (prose may differ).
const IDENTITY = new URL('../../../service-identity/src/api/openapi.yaml', import.meta.url);
const skip = !existsSync(IDENTITY) && !requiredInCi('service-identity') && 'no service-identity checkout next to this repository';

const PROSE = new Set(['description', 'example', 'examples', 'summary']);
const structure = (v) => (Array.isArray(v) ? v.map(structure)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !PROSE.has(k)).map(([k, x]) => [k, structure(x)]))
    : v);

const load = (url) => parse(readFileSync(url, 'utf8'));
const operations = (doc) => Object.fromEntries(Object.values(doc.paths).flatMap((item) =>
  Object.entries(item).filter(([m]) => m !== 'parameters').map(([, op]) => [op.operationId, op])));
const json = (part) => part?.content?.['application/json']?.schema;

test('shared schemas have the same structure as in identity', { skip }, () => {
  const gateway = load(new URL('../../src/api/openapi.yaml', import.meta.url));
  const identity = load(IDENTITY);
  for (const name of ['User', 'AdminUser', 'Problem']) {
    assert.deepEqual(structure(gateway.components.schemas[name]), structure(identity.components.schemas[name]), name);
  }
});

test('every routed operation has the same request and success bodies as in identity', { skip }, () => {
  const gateway = operations(load(new URL('../../src/api/openapi.yaml', import.meta.url)));
  const identity = operations(load(IDENTITY));
  for (const [id, op] of Object.entries(gateway)) {
    if (!id || !identity[id]) continue; // operational endpoints of the gateway itself
    assert.deepEqual(structure(json(op.requestBody)), structure(json(identity[id].requestBody)), `${id} request body`);
    const ok = Object.keys(identity[id].responses).find((s) => s.startsWith('2'));
    assert.deepEqual(structure(json(op.responses[ok])), structure(json(identity[id].responses[ok])), `${id} ${ok} response`);
  }
});
