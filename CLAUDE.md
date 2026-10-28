# CLAUDE.md

Guidance for AI coding agents (Claude Code and others) working in this
repository. The shared, organization-wide guidance lives only in the `.github`
repository and is imported below; this file adds what is specific to this
repository.

@../.github/CLAUDE.md

If the import above did not load (no `.github` clone next to this repository,
or an agent without `@` imports), read
[.github/CLAUDE.md](https://github.com/RSOcc26/.github/blob/main/CLAUDE.md)
before making changes.

## This repository: `gateway`

The API gateway, the only backend reachable through the Ingress (TLS ends at
the Ingress). It strips client-supplied identity and tenant headers, adds a
request ID, authenticates the request, checks that the user is a member of the
requested company and forwards a signed, short-lived tenant context to the
services. It also does routing, rate and size limits, timeouts, retries and
circuit breaking.

It holds **no business rules and no business data**. If a change needs a
domain decision, it belongs in a service. Kong and Traefik are evaluated as
alternatives in `docs/request-handling.md`.

Layout: `src/routes/` (route table), `src/middleware/` (auth, tenant context,
limits, logging), `src/config/`, `test/unit/`, `test/integration/`, `docs/adr/`.
