import Fastify, { LogController } from 'fastify';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { genRequestId } from './middleware/request-id.js';
import { sendProblem } from './middleware/problem.js';
import { bearerToken, OidcUnavailableError } from './middleware/auth.js';
import { userClaims } from './middleware/tenant-context.js';
import { STATUS_CODES } from 'node:http';
import { fileURLToPath } from 'node:url';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { resolveRoute, splitApiPath, tenantlessRoute } from './routes/table.js';
import { UserLookupUnavailableError } from './middleware/users.js';
import {
  forward, upstreamHeaders, copyResponseHeaders, UpstreamTimeoutError, UpstreamUnavailableError,
} from './routes/proxy.js';

// Process metrics and per-route request metrics (registered once per process)
collectDefaultMetrics();
const requests = new Counter({
  name: 'gateway_requests_total',
  help: 'Requests handled by the gateway',
  labelNames: ['method', 'service', 'status'],
});
const duration = new Histogram({
  name: 'gateway_request_duration_seconds',
  help: 'Request duration including the upstream call',
  labelNames: ['method', 'service'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const CONTRACT = fileURLToPath(new URL('./api/openapi.yaml', import.meta.url));

// Reads a response body up to maxBytes; larger bodies are an upstream error
class ResponseTooLargeError extends Error {}
const readBody = async (res, maxBytes) => {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError('upstream response too large');
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > maxBytes) throw new ResponseTooLargeError('upstream response too large');
  return body;
};

// Builds the gateway. Dependencies are injected so tests need no network:
// oidc { verify, ready }, signer { sign, jwks }, users { resolve } and
// fetchImpl for upstream calls.
export const buildApp = ({ config, oidc, signer, users, fetchImpl = fetch, ...opts }) => {
  const app = Fastify({
    genReqId: genRequestId,
    bodyLimit: config.maxBodyBytes,
    // Fastify's own request lines are replaced by the access log below
    logController: new LogController({ disableRequestLogging: true }),
    ...opts,
  });

  // Bodies are forwarded unparsed, whatever their type
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // One structured access-log line per request; never tokens, cookies or bodies
  app.addHook('onResponse', async (req, reply) => {
    const service = req.upstream?.service ?? 'gateway';
    requests.inc({ method: req.method, service, status: reply.statusCode });
    duration.observe({ method: req.method, service }, reply.elapsedTime / 1000);
    req.log.info({
      method: req.method,
      route: req.routeOptions.url,
      service,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      userId: req.userId,
      requestId: req.id,
    }, 'request completed');
  });

  app.setNotFoundHandler((req, reply) => sendProblem(reply, 404, 'Not Found'));
  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode === 413) return sendProblem(reply, 413, 'Payload Too Large');
    if (err.statusCode >= 400 && err.statusCode < 500) return sendProblem(reply, err.statusCode, STATUS_CODES[err.statusCode] ?? 'Bad Request');
    req.log.error({ err }, 'unhandled error');
    return sendProblem(reply, 500, 'Internal Server Error');
  });

  // The public contract (JSON, or YAML on request); needs no token, not part of /api/
  app.register(swagger, { mode: 'static', specification: { path: CONTRACT } });
  app.get('/api-docs', async (req, reply) => (req.headers.accept?.includes('yaml')
    ? reply.type('application/yaml').send(app.swagger({ yaml: true }))
    : app.swagger()));

  // Interactive docs (Swagger UI) on the gateway's own origin, so "Try it out"
  // calls are same-origin. Signing in uses the public "api-docs" Keycloak
  // client with PKCE; calls carry the user's own token, so the UI can do only
  // what that user may. Off unless API_DOCS_UI_ENABLED is set.
  if (config.apiDocs?.uiEnabled) {
    app.register(swaggerUi, {
      routePrefix: '/api-docs/ui',
      uiConfig: { tryItOutEnabled: true, persistAuthorization: false, displayRequestDuration: true },
      initOAuth: { clientId: config.apiDocs.clientId, usePkceWithAuthorizationCodeGrant: true, scopes: ['openid'] },
    });
  }

  app.get('/health/live', async () => ({ status: 'ok' }));
  // Ready when the identity provider's keys can be loaded
  app.get('/health/ready', async (req, reply) => {
    try {
      await oidc.ready();
      return { status: 'ok', checks: { oidc: { status: 'ok' } } };
    } catch (err) {
      return reply.code(503).send({ status: 'fail', checks: { oidc: { status: 'fail', detail: err.message } } });
    }
  });
  app.get('/metrics', async (req, reply) => reply.type(register.contentType).send(await register.metrics()));
  // Public keys for verifying the tenant context; cluster-internal (not routed by the Ingress)
  app.get('/.well-known/jwks.json', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return signer.jwks;
  });

  app.all('/api/:service/*', async (req, reply) => {
    // Route on the raw URL: Fastify's params are already decoded
    const raw = splitApiPath(req.url);
    const route = raw && resolveRoute(raw.service, raw.rest);
    if (!route) return sendProblem(reply, 404, 'Not Found');
    req.upstream = route;

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      reply.header('www-authenticate', 'Bearer');
      return sendProblem(reply, 401, 'Unauthorized', 'A bearer access token is required.');
    }
    try {
      req.user = await oidc.verify(token);
    } catch (err) {
      if (err instanceof OidcUnavailableError) {
        req.log.error({ err }, 'identity provider unavailable');
        return sendProblem(reply, 503, 'Service Unavailable', 'Authentication is temporarily unavailable.');
      }
      reply.header('www-authenticate', 'Bearer error="invalid_token"');
      return sendProblem(reply, 401, 'Unauthorized', 'The access token is invalid or expired.');
    }

    // Fail closed: membership validation (Identity) and application access
    // (Access) are not built yet, so tenant-scoped routes cannot be served.
    const tenantless = tenantlessRoute(route, req.method);
    if (!tenantless) {
      return sendProblem(reply, 501, 'Not Implemented', 'Tenant-scoped routes are not available yet.');
    }

    // A deleted user is rejected at once, even with a still-valid token (ADR-0003)
    let account;
    try {
      account = await users.resolve(req.user.sub, req.id);
    } catch (err) {
      if (!(err instanceof UserLookupUnavailableError)) throw err;
      req.log.error({ err }, 'user lookup unavailable');
      return sendProblem(reply, 503, 'Service Unavailable', 'Authentication is temporarily unavailable.');
    }
    // Fail closed: anything but an active user (deleted, or a status this
    // gateway does not know) is rejected
    if (account && account.status !== 'active') {
      reply.header('www-authenticate', 'Bearer error="invalid_token"');
      return sendProblem(reply, 401, 'Unauthorized',
        account.status === 'deleted' ? 'This account was deleted.' : 'This account cannot be used.');
    }
    if (!account && !tenantless.newUser) {
      return sendProblem(reply, 403, 'Forbidden', 'Sign in to CompanyCentral first.');
    }
    req.userId = account?.id;

    const tenantContext = await signer.sign(userClaims(req.user, req.id, account?.id), `service-${route.service}`);
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    let upstream;
    try {
      upstream = await forward({
        fetchImpl,
        url: `${config.services[route.service]}${route.path}${query}`,
        method: req.method,
        headers: upstreamHeaders(req, tenantContext),
        body: req.body,
        timeoutMs: config.upstreamTimeoutMs,
      });
    } catch (err) {
      req.log.warn({ err, service: route.service }, 'upstream call failed');
      if (err instanceof UpstreamTimeoutError) return sendProblem(reply, 504, 'Gateway Timeout');
      if (err instanceof UpstreamUnavailableError) return sendProblem(reply, 503, 'Service Unavailable');
      throw err;
    }

    // The upstream timeout also covers reading the body
    let body;
    try {
      body = await readBody(upstream, config.maxResponseBytes);
    } catch (err) {
      req.log.warn({ err, service: route.service }, 'reading the upstream response failed');
      if (err.name === 'TimeoutError' || err.name === 'AbortError') return sendProblem(reply, 504, 'Gateway Timeout');
      return sendProblem(reply, 502, 'Bad Gateway');
    }
    // Upstream 5xx without a problem document is wrapped so clients always get one
    if (upstream.status >= 500 && !upstream.headers.get('content-type')?.includes('application/problem+json')) {
      return sendProblem(reply, upstream.status, 'Upstream Error');
    }
    copyResponseHeaders(upstream, reply, {
      serviceUrl: config.services[route.service],
      publicPrefix: `/api/${route.service}`,
    });
    return reply.code(upstream.status).send(body);
  });

  return app;
};
