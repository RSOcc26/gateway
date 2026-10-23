# 1. Gateway implementation: custom Node.js, Kong or Traefik

- **Status:** Proposed
- **Date:** 2026-10-23
- **Decide by:** before the first gateway implementation pull request

## Context

The gateway must do routing, rate and size limits, correlation IDs, timeouts,
retries and circuit breaking. It must also do two things specific to
CompanyCentral: validate **company membership** (Identity) and **application
access** (Access) for the requested tenant, and issue a **signed tenant
context** for the services (organization ADR-0008). Authentication itself
depends on the open organization ADR-0007.

## Options

**A. Custom Node.js service** (the current plan).

- Tenant validation and the tenant-context token are ordinary code, in the
  same stack as the services, easy to unit test.
- No extra infrastructure; one more Node.js service in the same pipeline.
- We write and maintain the generic parts ourselves (proxying, limits, retries),
  using well-known libraries.

**B. Kong Gateway (OSS, DB-less, declarative config).**

- Mature routing, rate limiting, request-size limiting, correlation-ID and
  JWT plugins; official Helm chart.
- The OpenID Connect plugin is part of Kong Enterprise, not the OSS edition.
  Membership and access checks and tenant-context signing would need a custom
  plugin (Lua, Go or JavaScript PDK) or an extra auth service.
- New technology and configuration model for the team.

**C. Traefik (as Ingress controller and gateway).**

- Middlewares cover rate limiting, buffering (size limits), retries, circuit
  breaking and header manipulation. Traefik can also be the cluster's Ingress
  controller, so one component does both jobs.
- Custom checks via the **ForwardAuth** middleware: Traefik calls an auth
  endpoint for every request and copies its response headers to the upstream
  request. The membership/access checks and tenant-context signing would live
  in a small Node.js auth service, which is most of option A's logic anyway.
- Routing is configured in Kubernetes resources, so it is harder to run the
  same setup in Docker Compose.

## Proposed decision

Start with **A (custom Node.js)**. Keep the CompanyCentral-specific logic
(authentication, membership, access, tenant context) in a separate, clearly
bounded module with its own HTTP endpoint, so that **C (Traefik with
ForwardAuth)** stays a cheap migration if the generic parts become a burden.
Kong is not pursued, because its main advantages for us (OIDC) are not in the
OSS edition.

## Consequences

- If accepted: the gateway repository implements the steps in
  `docs/request-handling.md` with a small set of pinned dependencies.
- The RSO "API gateway" criterion is met by the custom gateway. Using Traefik
  as Ingress controller is independent of this decision.
- Revisit after the first milestone, or if rate limiting or resilience code
  grows beyond a few hundred lines.
