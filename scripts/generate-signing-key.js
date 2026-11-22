// Generates a local ES256 private key for signing the tenant context.
// Usage: npm run key:generate [-- <path>]   (default: .local/tenant-context-key.pem)
// Local development only; in Kubernetes the key comes from a Secret.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.argv[2] ?? '.local/tenant-context-key.pem';
if (existsSync(path)) {
  console.error(`${path} already exists; delete it first to rotate the key.`);
  process.exit(1);
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`Wrote ${path}`);
