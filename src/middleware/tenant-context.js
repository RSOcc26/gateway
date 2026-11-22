import { randomUUID } from 'node:crypto';
import { importPKCS8, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose';

const ALG = 'ES256';
// Services require this type, so no other JWT can be passed off as a tenant context
export const TENANT_CONTEXT_TYP = 'tenant-context+jwt';

// Signs the short-lived context forwarded to services (ADR-0001) and exposes
// the public key as a JWKS so services can verify it.
export const createTenantContextSigner = async ({ issuer, ttlSeconds, privateKeyPem }) => {
  const privateKey = await importPKCS8(privateKeyPem, ALG, { extractable: true });
  const { d, ...publicJwk } = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);

  const sign = (claims, audience) => new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid, typ: TENANT_CONTEXT_TYP })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setJti(randomUUID())
    .sign(privateKey);

  return { sign, jwks: { keys: [{ ...publicJwk, kid, alg: ALG, use: 'sig' }] } };
};

// Platform roles taken from the provider's token; everything else is ignored
export const PLATFORM_ROLES = ['platform-admin'];
export const platformRoles = (token) =>
  (token.realm_access?.roles ?? []).filter((role) => PLATFORM_ROLES.includes(role));

// Claims for a route that needs no company: the CompanyCentral user ID (sub,
// absent before the user's first sign-in), platform roles, and the verified
// identity-provider subject and profile claims.
export const userClaims = (token, requestId, userId) => ({
  ...(userId && { sub: userId }),
  roles: platformRoles(token),
  idp_iss: token.iss,
  idp_sub: token.sub,
  // When the provider issued the token: lets identity ignore claims older than its last change
  idp_iat: token.iat,
  ...(token.email && { email: token.email, email_verified: token.email_verified === true }),
  ...(token.name && { name: token.name }),
  ...(token.given_name && { given_name: token.given_name }),
  ...(token.family_name && { family_name: token.family_name }),
  rid: requestId,
});
