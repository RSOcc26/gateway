import { createRemoteJWKSet, jwtVerify, errors } from 'jose';

// Thrown when the identity provider cannot be reached, as opposed to a bad token
export class OidcUnavailableError extends Error {}

const TIMEOUT_MS = 5000;
// After a failed discovery, requests fail fast for this long instead of each
// waiting for its own timeout
const RETRY_AFTER_FAILURE_MS = 2000;

// jose errors that mean "could not get the keys", not "bad token": a JWKS
// endpoint that times out, answers non-200 or sends something that is not a JWKS
const OUTAGE_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID']);

// Verifies OIDC access tokens with standard OIDC only (ADR-0002): discovery,
// JWKS, issuer, audience and expiry. The JWKS URL comes from discovery unless
// overridden (for example when the issuer URL is not reachable from a container).
export const createOidcVerifier = ({ issuer, audience, jwksUrl, fetchImpl = fetch }) => {
  let keys = null; // { url, jwks } once known
  let pending = null; // the one discovery in flight
  let failedUntil = 0;
  let lastFailure = null;

  const discover = async () => {
    if (jwksUrl) return jwksUrl;
    let doc;
    try {
      const res = await fetchImpl(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      doc = await res.json();
    } catch (err) {
      throw new OidcUnavailableError(`OIDC discovery failed: ${err.message}`);
    }
    if (doc?.issuer !== issuer) throw new OidcUnavailableError('OIDC discovery returned a different issuer');
    try {
      return new URL(doc.jwks_uri).href;
    } catch {
      throw new OidcUnavailableError('OIDC discovery returned no valid jwks_uri');
    }
  };

  // Concurrent callers share one discovery; a failure is remembered briefly
  const loadKeys = async () => {
    if (keys) return keys;
    if (Date.now() < failedUntil) throw lastFailure;
    pending ??= discover()
      .then((url) => { keys = { url, jwks: createRemoteJWKSet(new URL(url)) }; return keys; })
      .catch((err) => { lastFailure = err; failedUntil = Date.now() + RETRY_AFTER_FAILURE_MS; throw err; })
      .finally(() => { pending = null; });
    return pending;
  };

  const verify = async (token) => {
    const { jwks } = await loadKeys();
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
      });
      return payload;
    } catch (err) {
      if (!(err instanceof errors.JOSEError) || OUTAGE_CODES.has(err.code)) {
        throw new OidcUnavailableError(err.message);
      }
      throw err;
    }
  };

  // Readiness: the signing keys can actually be fetched right now
  const ready = async () => {
    const { url } = await loadKeys();
    let body;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = await res.json();
    } catch (err) {
      throw new OidcUnavailableError(`JWKS not available: ${err.message}`);
    }
    if (!Array.isArray(body?.keys) || body.keys.length === 0) throw new OidcUnavailableError('JWKS has no keys');
  };

  return { verify, ready };
};

// The bearer token from an Authorization header; the scheme is case-insensitive (RFC 9110)
export const bearerToken = (header) => {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header ?? '');
  return match?.[1];
};
