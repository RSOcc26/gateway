# gateway

CompanyCentral API gateway: the single entry point that authenticates every
API call, validates the tenant context and routes the call to the service that
owns it.

Part of **CompanyCentral**, a multi-tenant, cloud-native platform built for
the *Cloud Computing Services* course (RSO 2026/27, FRI UL).
See the [architecture](https://github.com/RSOcc26/.github/blob/main/docs/architecture.md) and the
[RSOcc26 organization](https://github.com/RSOcc26) for the other repositories.

> **Status:** scaffold — no implementation yet.

## Responsibilities

- Routing `/api/...` requests to the owning service
- Authenticating the request (the mechanism depends on the open
  [ADR-0002](https://github.com/RSOcc26/.github/blob/main/docs/adr/0002-identity-provider.md))
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
| Routes | _To be defined._ The combined OpenAPI documentation will be served at `/api-docs`. |
| Health | `/health/live` and `/health/ready` for Kubernetes probes. |
| Metrics | `/metrics` in Prometheus format. |

## Configuration

All configuration comes from environment variables (see `.env.example`
once it exists), including the internal URL of every service. Secrets are
never committed; in Kubernetes they come from Secrets, everything else from
ConfigMaps.

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP port (default `8080`) |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error` (default `info`) |
| `IDENTITY_URL`, `ACCESS_URL`, `WORKFLOW_URL`, `INVENTORY_URL`, `PRODUCTION_URL` | yes | Internal base URL of each service |
| `UPSTREAM_TIMEOUT_MS` | no | Timeout for a call to a service (default `5000`) |
| `RATE_LIMIT_PER_MINUTE` | no | Requests per minute per user and company (default `300`) |
| `MAX_BODY_BYTES` | no | Maximum request body size (default `1048576`) |
| `MEMBERSHIP_CACHE_TTL_SECONDS` | no | How long membership and access answers are cached (default `30`) |
| `TENANT_CONTEXT_ISSUER` | yes | Issuer of the tenant context token |
| `TENANT_CONTEXT_SIGNING_KEY_FILE` | yes | Path to the private key that signs the tenant context (mounted Secret) |
| `TENANT_CONTEXT_TTL_SECONDS` | no | Lifetime of a tenant context token (default `60`) |
| `KAFKA_BROKERS` | yes | Kafka bootstrap servers; the gateway reads membership and role events to invalidate its caches |
| `KAFKA_GROUP_ID` | no | Consumer group (default `gateway`) |
| `KAFKA_CONSUME_TOPICS` | no | Topics read for cache invalidation (default `identity.events,access.events`) |
| `KAFKA_SASL_MECHANISM`, `KAFKA_USERNAME`, `KAFKA_PASSWORD` | in Kubernetes | SCRAM credentials of the gateway's Kafka user; empty for the local broker |

Authentication settings are added once ADR-0002 is decided. See
[`.env.example`](.env.example).

## Getting started

Prerequisites: Node.js 24 (see `.nvmrc`) and Docker. The services it routes
to must be running for end-to-end calls.

_Commands will be added with the first implementation._

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
