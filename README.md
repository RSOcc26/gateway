# gateway

CompanyCentral API gateway: the single entry point that authenticates every
API call, validates the tenant context and routes the call to the service that
owns it.

Part of **CompanyCentral**, a multi-tenant, cloud-native platform built for
the *Cloud Computing Services* course (RSO 2026/27, FRI UL).
See the [architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md) and the
[RSOcc26 organization](https://github.com/RSOcc26) for the other repositories.

> **Status:** first slice. Implemented: routing, OIDC token validation,
> signed context for routes that need no company, request IDs, access logs,
> metrics, body size limit, timeouts and one retry. Not yet: membership and
> application checks (tenant-scoped routes return `501`), rate limiting,
> circuit breaking, Kafka cache invalidation and the combined `/api-docs`.

## Responsibilities

- Routing `/api/...` requests to the owning service
- Authenticating the request: validating Keycloak's OIDC access tokens
  ([ADR-0002](https://github.com/RSOcc26/.github/blob/main/docs/adr/0002-identity-provider.md))
- Validating that the user is a member of the requested company and passing
  a signed tenant context to services
- Coarse authorization: is the application enabled and allowed for this user
- Rate limiting and request size limits
- Request IDs, structured access logs and metrics for every call
- Timeouts, retries and circuit breaking towards services

The gateway holds no business rules and owns no business data. It does not
serve the frontend; that is the `web` repository.

## How it fits

```
Browser ──▶ Ingress ──┬── /       ──▶ web
                      └── /api/*  ──▶ gateway ──┬──▶ service-identity
                                                ├──▶ service-access
                                                ├──▶ service-workflow
                                                ├──▶ service-inventory
                                                └──▶ service-production
```

Services are reachable only from inside the cluster; the gateway is the only
backend exposed through the Ingress. TLS ends at the Ingress.

## Request handling

The full design is in [docs/request-handling.md](docs/request-handling.md). In
short, every request passes these steps in order:

1. **Correlation ID:** reuse a valid `X-Request-Id` or generate one; return it
   in the response and pass it to services.
2. **Header hygiene:** drop client-supplied internal headers (tenant context,
   user ID, roles).
3. **Rate and size limits:** reject with `429` or `413`.
4. **Routing:** match `/api/<service>/...` to the owning service. Internal
   service paths (`/v1/internal/...`) are never routed from outside.
5. **Authentication:** validate the user's session or token.
6. **Tenant validation:** check that the user is an active member of the
   requested company (Identity, short cache).
7. **Application access:** check that the company has the application enabled
   and the user may use it (Access, short cache).
8. **Forwarding:** attach the signed, short-lived tenant context and forward
   with a timeout; map upstream failures to `502`/`503`/`504` as
   `application/problem+json`.

The gateway is a custom Node.js service. Kong and Traefik are evaluated as
alternatives in [docs/request-handling.md](docs/request-handling.md#implementation-options).

## API

| Interface | Description |
|---|---|
| Routes | `/api/<service>/v1/...`, see [request handling](docs/request-handling.md#routing). Live now: `GET /api/identity/v1/me` and the platform-admin user routes `/api/identity/v1/admin/users[/{id}]`. Contract: [`src/api/openapi.yaml`](src/api/openapi.yaml). |
| API docs | `GET /api-docs`: the gateway's public OpenAPI 3.1 contract (JSON, or YAML with `Accept: application/yaml`), no token needed. `/api-docs/ui`: interactive Swagger UI when `API_DOCS_UI_ENABLED=true`; sign in with Keycloak (public `api-docs` client, PKCE) and "Try it out" calls run as that user. Request and response bodies are defined by each service's own contract. |
| JWKS | `/.well-known/jwks.json`: the public key services use to verify the signed context. Cluster-internal. |
| Health | `/health/live` and `/health/ready` (fetches the OIDC provider's signing keys on every check) for Kubernetes probes. |
| Metrics | `/metrics` in Prometheus format. |

## Configuration

All configuration comes from environment variables (see `.env.example`), including the internal URL of every service. Secrets are
never committed; in Kubernetes they come from Secrets, everything else from
ConfigMaps.

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP port (default `8080`) |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error` (default `info`) |
| `IDENTITY_URL`, `ACCESS_URL`, `WORKFLOW_URL`, `INVENTORY_URL`, `PRODUCTION_URL` | yes | Internal base URL of each service |
| `OIDC_ISSUER` | yes | Keycloak realm URL; must equal the tokens' `iss` |
| `OIDC_AUDIENCE` | yes | Audience access tokens must carry (`gateway`) |
| `OIDC_JWKS_URL` | no | Overrides the JWKS URL from discovery, for when the issuer URL is not reachable from the gateway (Compose) |
| `MAX_RESPONSE_BYTES` | no | Largest upstream response passed on (default `10485760`); larger ones return `502` |
| `API_DOCS_UI_ENABLED` | no | Serve Swagger UI at `/api-docs/ui` (default `false`; enable locally, decide deliberately for public environments) |
| `API_DOCS_OIDC_CLIENT_ID` | no | Public Keycloak client Swagger UI signs in with (default `api-docs`) |
| `USER_CACHE_TTL_SECONDS` | no | How long a user lookup in identity is cached (default `5`); bounds how long a deleted user keeps access |
| `UPSTREAM_TIMEOUT_MS` | no | Timeout for a call to a service (default `5000`) |
| `RATE_LIMIT_PER_MINUTE` | no | Requests per minute per user and company (default `300`; not enforced yet) |
| `MAX_BODY_BYTES` | no | Maximum request body size (default `1048576`) |
| `MEMBERSHIP_CACHE_TTL_SECONDS` | no | How long membership and access answers are cached (default `30`; not used yet) |
| `TENANT_CONTEXT_ISSUER` | yes | Issuer of the tenant context token |
| `TENANT_CONTEXT_SIGNING_KEY_FILE` | yes | Path to the ES256 private key (PKCS#8 PEM) that signs the tenant context (mounted Secret) |
| `TENANT_CONTEXT_TTL_SECONDS` | no | Lifetime of a tenant context token (default `60`) |
| `KAFKA_BROKERS` | not yet | Kafka bootstrap servers; the gateway reads membership and role events to invalidate its caches |
| `KAFKA_GROUP_ID` | no | Consumer group (default `gateway`) |
| `KAFKA_CONSUME_TOPICS` | no | Topics read for cache invalidation (default `identity.events,access.events`) |
| `KAFKA_SASL_MECHANISM`, `KAFKA_USERNAME`, `KAFKA_PASSWORD` | in Kubernetes | SCRAM credentials of the gateway's Kafka user; empty for the local broker |

Kafka settings are read once cache invalidation exists. See
[`.env.example`](.env.example).

## Getting started

Prerequisites: Node.js 24 (see `.nvmrc`) and Docker. The services it routes
to must be running for end-to-end calls.

```
cp .env.example .env
npm install
npm run key:generate   # local signing key in .local/ (git-ignored)
npm run dev            # http://localhost:8080, restarts on changes
npm test
```

Keycloak must be running (deploy Compose stack) for `/health/ready` and
authenticated calls. The web dev server proxies `/api` here.

## Project structure

```
src/
  routes/       the route table: which path goes to which service
  middleware/   authentication, tenant context, rate limits, logging
  config/       configuration loading and validation
test/
  unit/         fast tests with no external dependencies
  integration/  tests against running services
docs/
  adr/          architecture decision records
```

## Deployment

Built as a container image and published to GitHub Container Registry.
Kubernetes manifests and Helm charts live in the deployment repository.

## Contributing

- Branch from `main` (`feat/…`, `fix/…`, `chore/…`) and open a pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Pull requests need a review from a code owner and passing checks; they are squash-merged.
- Record notable changes in `CHANGELOG.md`.

## License

[MIT](LICENSE)
