---
name: docs
description: Documentation maintenance guide. Use when making code changes that affect APIs, features, patterns, or architecture to keep documentation in sync.
paths:
  - packages/homileo/src/routes/**
  - packages/homileo/src/definitions/**
  - packages/homileo/src/policy/**
  - packages/homileo/src/utils/provisioning/**
  - packages/homileo/src/env.ts
  - packages/homileo/prisma/schema.prisma
  - packages/homileo/openapi/**
  - packages/homileo/docs/**
  - packages/homileo-sdk/src/**
  - docs/**
  - docker-compose.yml
  - docker/**
---

# Documentation Maintenance

When making code changes, check whether related documentation needs updating.

Homileo is one service (`packages/homileo`) plus libraries, so most docs are either repo-wide or per
*area* of that service — spaces, sessions, messages, events, provisioning, access (the policy
module) and platform.

## What to Update When

### Backend Route Changes (add/modify/remove endpoints)

- [ ] OpenAPI path file: `packages/homileo/openapi/paths/<area>/<resource>.yaml`
- [ ] OpenAPI schemas: `packages/homileo/openapi/components/<area>/schemas.yaml`
- [ ] Reference the new path in the one root, `packages/homileo/openapi/openapi.yaml`
- [ ] Area doc under `packages/homileo/docs/` (if it lists endpoints or the behavior changes)
- [ ] SDK: a request and a client method in `packages/homileo-sdk/src/`, if apps should call it

Then `npm run openapi:build` in `packages/homileo` (see the `openapi` skill; the spec arrives in plan 2).

### Database Schema Changes (Prisma models)

- [ ] The area doc under `packages/homileo/docs/` (its data model section, where present)
- [ ] Root `CLAUDE.md` *Migrations* convention, if the change needs a new kind of raw SQL
      (partitioning, partial or opclass indexes, CHECK constraints)

### Events and Access

- [ ] New event type: `packages/homileo-sdk/src/events/registry.ts`, `packages/homileo/docs/events.md`,
      and the webhook definition in the OpenAPI spec; the tereo declaration if it is a webhook
      (`npm run tereo:provisioning -w homileo`, commit `tereo-provisioning.json`)
- [ ] Access rule (visibility, join, posting, grants, admin): `packages/homileo/src/policy/`,
      `packages/homileo/docs/access.md` and the spec's *Access rules* section
- [ ] Provisioning document keys or validation: `packages/homileo/docs/provisioning.md` and the
      JSON Schema exported by the SDK

### SDK Changes (`@homileo-io/sdk`)

- [ ] `packages/homileo-sdk/README.md` — usage, provisioning types, event registry
- [ ] Root `CLAUDE.md` if the SDK's shape changes

### Environment, Process Roles

- [ ] New or changed env var: `packages/homileo/src/env.ts` is the schema; also
      `packages/homileo/.env.example`
- [ ] `ROLE`, entry points, background jobs: root `CLAUDE.md` layout table

### Architecture / Roadmap Changes

- [ ] Root `CLAUDE.md` — project overview, layout table, key conventions, what not to do
- [ ] Root `README.md` — packages table, *Run it*, *Develop*, *Current state* (which plans are done)
- [ ] The design spec in `docs/superpowers/specs/` when a decision changes
- [ ] Local stack: `docker-compose.yml`, `docker/` and the commands in root `README.md`/`CLAUDE.md`

### Code Style / Tooling Changes

- [ ] `docs/code-style.md` (Prettier, import order, ESLint, comments)

## Documentation Locations

| Type | Location | Purpose |
|------|----------|---------|
| Root CLAUDE.md | `CLAUDE.md` | Claude Code guidance: layout, key conventions, local development, what not to do |
| Root README.md | `README.md` | Overview, packages, run/develop, current state |
| Code style | `docs/code-style.md` | Formatting, TypeScript, naming, errors, import order |
| Design spec and plans | `docs/superpowers/` | The approved design and the implementation plans |
| Area docs | `packages/homileo/docs/*.md` | `provisioning`, `events`, `access`, … |
| OpenAPI spec | `packages/homileo/openapi/` | API contract, one spec for every area |
| Skills | `.claude/skills/*/SKILL.md` | Task guides for Claude Code (`outbox`, `openapi`, `docs`, …) |

There is no `packages/homileo/CLAUDE.md` or `README.md` — the root files cover the service.

## Guidelines

- Only update docs that are actually affected by the change — don't update everything
- Keep CLAUDE.md files focused on implementation-level guidance (what Claude needs to know)
- Keep README.md files focused on human readers (setup, usage)
- Keep area docs focused on how that area behaves; cross-cutting decisions go in root `CLAUDE.md`
- The OpenAPI spec is the contract for endpoints — update it with the route, not afterwards
- When a doc section no longer matches the code, correct it to match the code rather than copying
  its pattern
- Keep `docs/superpowers/` specs and plans out of feature PRs' scope: they record decisions, they
  are not updated to track code
