# gateway

CompanyHub API gateway: the single entry point that authenticates every API
call and routes it to the service that owns it.

Part of **CompanyHub**, a multi-tenant, cloud-native microservices platform
built for the *Cloud Computing Services* course (RSO 2026/27, FRI UL).
See the [RSOcc26 organization](https://github.com/RSOcc26) for the other repositories.

> **Status:** scaffold — no implementation yet.

## Responsibilities

- Routing `/api/...` requests to the owning service
- Authenticating the session or token, with Identity as the source of truth
- Setting the tenant (company) and user context passed on to services
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
                                                ├──▶ service-audit
                                                ├──▶ service-messaging
                                                ├──▶ service-tasks
                                                └──▶ …
```

Services are reachable only from inside the cluster; the gateway is the only
backend exposed through the Ingress.

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
| _To be defined._ | | |

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
