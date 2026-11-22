# Changelog

All notable changes to this repository are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial repository scaffold.
- Fastify gateway with `/health/live`, `/health/ready` (OIDC keys loadable),
  `/metrics` and one JSON access-log line per request.
- `X-Request-Id` reuse or generation, returned and forwarded.
- Route table `/api/<service>/v1/...`; internal, traversal and unknown paths
  return `404` as `application/problem+json`.
- Keycloak access-token validation through OIDC discovery and JWKS (issuer,
  audience, expiry); `401` for bad tokens, `503` when the provider is down.
- Signed context (ES256, `typ: tenant-context+jwt`) replacing the browser's
  token towards services, JWKS at `/.well-known/jwks.json`, and
  `npm run key:generate` for a local signing key. Tenant-scoped routes fail
  closed (`501`) until membership checks exist.
- Allowlist of forwarded request headers, `MAX_BODY_BYTES` (`413`),
  `UPSTREAM_TIMEOUT_MS` (`504`), one retry for idempotent methods (`503`),
  upstream `5xx` wrapped as problem documents.
- User resolution through identity on every request (ADR-0003): deleted users
  get `401`, the context carries the CompanyCentral user ID (`sub`) and
  platform `roles`; `USER_CACHE_TTL_SECONDS`.
- Routes for platform user administration (`/api/identity/v1/admin/users[/{id}]`).
- Public OpenAPI 3.1 contract (`src/api/openapi.yaml`) at `GET /api-docs` (JSON,
  or YAML on request) and optional Swagger UI at `/api-docs/ui`
  (`API_DOCS_UI_ENABLED`, `API_DOCS_OIDC_CLIENT_ID`; `@fastify/swagger`,
  `@fastify/swagger-ui`).
- CI clones the contract source repositories (`contract-repositories`) so the
  cross-repository contract checks run there and fail on drift.
- Contract tests: signed contexts against the shared tenant-context schema;
  copied identity schemas and bodies against identity's contract (drift check).
- `MAX_RESPONSE_BYTES`; `idp_iat` (token issue time) in the signed context.

### Fixed

- Routing uses the raw, still-encoded path and forwards it encoded: `%23`,
  `%3F`, `%2F`, `%5C` and `%00` can no longer cut or split the path (a DELETE on
  `<id>%23x` deleted `<id>`), and encoded `internal` is blocked too.
- A JWKS endpoint answering non-200 or invalid JSON is an outage (`503`), not
  an invalid token (`401`); discovery is shared by concurrent requests, a
  failure is remembered for 2 s, and a missing `jwks_uri` is a `503`.
- `/health/ready` fetches the signing keys on every check.
- A body that stalls after the headers returns `504` instead of `500`.
- The user lookup fails closed: only `active` users are forwarded; a malformed
  answer from identity is a `503`.
- `Location` headers are rewritten to the public path; `X-Forwarded-For`
  appends the peer to the incoming chain; `HEAD` is served like `GET`; the
  `Bearer` scheme is case-insensitive; client errors keep their HTTP title.
