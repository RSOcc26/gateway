# Request handling

> **Status:** design; nothing is implemented yet.

How the gateway handles a request from the browser. Cross-cutting background:
[architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md),
[ADR-0001 multi-tenancy](https://github.com/RSOcc26/.github/blob/main/docs/adr/0001-multi-tenancy.md).

## Routing

| Public path | Service | Forwarded as |
|---|---|---|
| `/api/identity/v1/...` | `service-identity` | `/v1/...` |
| `/api/access/v1/...` | `service-access` | `/v1/...` |
| `/api/workflow/v1/...` | `service-workflow` | `/v1/...` |
| `/api/inventory/v1/...` | `service-inventory` | `/v1/...` |
| `/api/production/v1/...` | `service-production` | `/v1/...` |
| `/api-docs` | gateway | Combined index of the services' OpenAPI documents |
| `/health/live`, `/health/ready`, `/metrics` | gateway | Not routed through the Ingress |

- Paths under `/v1/internal/...` are service-to-service only and return `404`
  from the gateway.
- Unknown paths return `404` as `application/problem+json`.
- The route table lives in `src/routes/` and is the only place that knows
  service URLs (from configuration).

## Authentication and authorization

| Step | Responsibility | Failure |
|---|---|---|
| Authenticate the request | gateway, against Identity or the OIDC provider (ADR-0002, open) | `401` |
| Is the user an active member of the requested company? | gateway asks Identity (`/v1/internal/memberships/check`), cached `MEMBERSHIP_CACHE_TTL_SECONDS` | `403` |
| Is the application enabled for the company, and may the user use it? | gateway asks Access (`/v1/internal/access/check`), cached the same way | `403` |
| May the user do *this* action on *this* object? | the owning service | `403` from the service |

The caches are invalidated early by `identity.membership.*` and
`access.role.*` events, read from the `identity.events` and `access.events`
Kafka topics with consumer group `gateway`. Until then the short TTL bounds how
stale they can be.

Public endpoints that need no company (for example "list my companies" or
accepting an invitation) are marked explicitly in the route table. Everything
else requires a tenant.

## Tenant context

- The browser sends the requested company as `X-Tenant-Id`.
- After the checks above, the gateway **removes** the client's `X-Tenant-Id`
  and any internal headers. It then adds `Authorization: Bearer <tenant context>`:
  a JWT signed by the gateway with `sub` (user ID), `tid` (tenant ID), `roles`,
  `aud` (target service), `iss`, a short `exp` and the correlation ID.
- Services verify the signature using the gateway's JWKS
  (`/.well-known/jwks.json`, cluster-internal) and use only `tid` as the tenant.

## Rate limiting and size limits

- Per user and company when authenticated, per client IP otherwise.
- Limits are in memory per gateway replica at first, so the effective limit is
  `limit × replicas`. A shared store (for example Redis) is a later option and
  is not added now.
- Exceeding the limit returns `429` with `Retry-After`. Bodies above
  `MAX_BODY_BYTES` return `413`.

## Correlation IDs and logging

- `X-Request-Id`: reused if the client sends a valid one (UUID or up to 64
  safe characters), otherwise generated. Returned on every response, forwarded
  to services, and copied into events as `correlationId`.
- One structured JSON access-log line per request: method, route, status,
  duration, user ID, tenant ID, correlation ID. Never tokens, cookies or bodies.
- Metrics: request count, latency histogram and error count per route and
  upstream service.

## Timeouts, retries and errors

| Situation | Gateway behaviour | Client sees |
|---|---|---|
| Service does not answer within `UPSTREAM_TIMEOUT_MS` | Abort the call | `504` |
| Connection refused or service not ready | One retry for idempotent methods (`GET`, `HEAD`, `PUT`, `DELETE`), with jitter; never for `POST` | `503` |
| Service returns `5xx` | Pass through the body if it is a problem document, otherwise wrap it | same status |
| Repeated failures of one service | Circuit breaker opens for a short time, fails fast (planned) | `503` |

All gateway-generated errors use `application/problem+json` (RFC 9457) and
include `correlationId`.

## Implementation options

Besides the CompanyCentral-specific steps (authentication, membership and
application checks, signing the tenant context), the gateway needs generic
proxy features: routing, limits, retries, circuit breaking.

| Option | Strengths | Weaknesses |
|---|---|---|
| **Custom Node.js** (chosen) | Tenant logic is ordinary, testable code in the team's stack; no extra infrastructure | We maintain the generic proxy parts ourselves |
| Kong (OSS, DB-less) | Mature routing, rate limiting and JWT plugins; Helm chart | OIDC plugin is Enterprise-only; tenant checks need a custom plugin; new technology |
| Traefik | Middlewares for limits, retries, circuit breaking; can also be the Ingress controller | Tenant checks via ForwardAuth still need a small auth service; harder to mirror in Docker Compose |

The tenant and authentication logic is kept in one bounded module with its own
HTTP endpoint, so it could later serve as a Traefik ForwardAuth target if the
generic proxy code becomes a burden.
