// Resolves the identity provider's subject to the CompanyCentral user
// (ADR-0003), so a deleted user is rejected even while their access token is
// still valid. Answers are cached briefly to keep this off the hot path.

export class UserLookupUnavailableError extends Error {}

const MAX_ENTRIES = 10_000;

export const createUserResolver = ({ identityUrl, signer, ttlMs, timeoutMs = 2000, fetchImpl = fetch }) => {
  const cache = new Map();

  const lookup = async (idpSub, requestId) => {
    // Service-to-service call, authenticated with a gateway-signed context
    const context = await signer.sign({ svc: 'gateway', rid: requestId }, 'service-identity');
    let res;
    try {
      res = await fetchImpl(`${identityUrl}/v1/internal/users/by-subject/${encodeURIComponent(idpSub)}`, {
        headers: { authorization: `Bearer ${context}`, 'x-request-id': requestId, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UserLookupUnavailableError(err.message);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new UserLookupUnavailableError(`identity answered ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new UserLookupUnavailableError('identity answered with an invalid body');
    }
    if (typeof body?.id !== 'string' || typeof body?.status !== 'string') {
      throw new UserLookupUnavailableError('identity answered without a user ID and status');
    }
    return { id: body.id, status: body.status };
  };

  return {
    // { id, status } or null when no CompanyCentral user exists for the subject yet
    async resolve(idpSub, requestId) {
      const hit = cache.get(idpSub);
      if (hit && hit.expiresAt > Date.now()) return hit.user;
      const user = await lookup(idpSub, requestId);
      // Unknown users are not cached: they are created by their first /me call
      if (user) {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(idpSub, { user, expiresAt: Date.now() + ttlMs });
      }
      return user;
    },
  };
};
