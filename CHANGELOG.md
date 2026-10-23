# Changelog

All notable changes to this repository are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Repository scaffold.
- Request handling design (`docs/request-handling.md`): routing, authentication and authorization, tenant validation, rate limits, correlation IDs, timeouts and errors.
- ADR-0001 (Proposed): custom Node.js gateway vs. Kong vs. Traefik.
- `.env.example` and the configuration table.

### Changed

- Renamed the project from CompanyHub to CompanyCentral; routes now target the first-milestone services.
