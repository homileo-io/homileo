---
name: test
description: Testing patterns for Homileo — the Vitest suite (unit and int projects) where int runs one real server against a dedicated test database with real Postgres and Redis and SDK test tokens, plus the SDK's unit tests. Use when writing tests, deciding where a test goes, running the suite, or debugging test failures.
paths:
  - packages/homileo/src/tests/**
  - packages/homileo/vitest.config.ts
  - packages/homileo-sdk/src/tests/**
  - docker/test/**
---

# Testing Patterns

The rules live in [`packages/homileo/src/tests/README.md`](../../../packages/homileo/src/tests/README.md):
layout, filenames, the size cap, projects, tags, what gets tested where, and a "where does my test
go" list with worked cases. `src/tests/conventions/testLayout.unit.test.ts` enforces them and names
the offending paths. Read the README first; this skill covers the parts it does not.

## Where does my test go?

`src/tests` mirrors `src/`:

| Changing | Test |
|----------|------|
| a route | `routes/<URL path>/<folder>.test.ts`, named for the router folder (`routes/v1/me/me.test.ts`) |
| the root router (`routes/index.ts`) | `routes/routes.test.ts`, `routes/routes.<aspect>.test.ts` |
| an entry point | `index.test.ts`, `app.test.ts`, `worker.test.ts` |
| a Zod schema | `<base>.validation.unit.test.ts`, one `it.each` table |
| a util or module | `utils/<name>.unit.test.ts` (pure) or `.test.ts` (database, Redis) |
| the access policy | `policy/<name>.unit.test.ts` (table-driven), plus an `int` file running the same cases against the SQL |
| a job | `jobs/<job>.test.ts` |
| a sequence across routes | `flows/<area>/<flow>.test.ts` |
| the repo's own conventions | `conventions/<name>.unit.test.ts` |

Filename form: `<base>[.<aspect>][.<method>][.unit].test.ts`. Aspects are `validation`,
`permissions`, `races`, `audit`, `limits`, `errors`; a file without one holds the main behaviour.
Split by aspect only when the main file nears the cap. A test that exercises one route belongs to
that route even if it sets up state through others.

Tags go at the top, one `// @module-tag` per line, in this order: the tier (`unit` or `int`), the
primary area, then any other area or detail tags. The primary area comes from `AREA_BY_PATH` in
`src/tests/setup/tags.ts` (longest prefix wins): areas are `auth`, `spaces`, `sessions`,
`messages`, `events`, `provisioning`, `access` and `platform`. Paths with no prefix (mostly
`utils/` and `jobs/`) accept any area: pick the one the code serves.

## Running tests

```sh
cd packages/homileo
npm run test:unit                                    # unit project; no server, database or Redis
npm run test:int                                     # int project; Postgres and Redis up, own server
npm run test:local -- --tags-filter "auth && race"   # any tag expression, both projects
npx vitest --list-tags                               # the declared tags
npx vitest run src/tests/routes/v1/me/me.test.ts --project int   # one file
npx vitest run -t "marks a service account as a bot"            # by test name
npm run test:watch / test:coverage

docker/test/run.sh                    # repo root: isolated Docker stacks, one shard each
TEST_SHARDS=1 docker/test/run.sh      # the whole suite in one stack (default 4 shards)
TEST_STACK_PREFIX=homileo-test-x docker/test/run.sh   # distinct compose names for a concurrent run
cd packages/homileo-sdk && npx vitest run             # SDK unit tests, no server or database
```

`npm test` in the package runs `docker/test/run.sh`; CI runs it too.

During work, run the focused tests (the file, or a tag expression) — CI runs the full suite.

## Setup

- Local runs read `packages/homileo/.env` (`cp .env.example .env`). A missing `.env` fails `int` at
  startup with a clear error, while `unit` needs none. `docker/test/run.sh` needs no `.env`.
- Postgres and Redis up for `int`: `docker compose up -d postgres redis` (host ports 5452 / 6399).
- `src/tests/setup/testEnv.ts` points `int` at **`<db>_test`** and **Redis db 1**;
  `TEST_DATABASE_URL`, `TEST_REDIS_URL` and `TEST_PORT` (shell or `.env`) override, so two
  worktrees can run side by side. `NODE_ENV=test`, `TEREO_TEST_MODE=true`, `LOG_LEVEL=silent`.
  `unit` gets an env with an unreachable database and Redis.
- `setup/globalSetup.ts` migrates the test database, then starts **one server** (port 4101 unless
  `TEST_PORT`) that every `int` file talks to. Stop `npm run dev` first if it holds the port.
- `int` files run serially (`fileParallelism: false`) in no promised order.
- The server starts `ensureEventPartitions()` before listening, so today's and the next week's
  `chat.events` partitions exist. Test mode turns the outbox reaper's dispatch off, so outbox rows
  stay in `core.core_outbox` for tests to read; a test that needs them drained calls the SDK's
  `processBatch()`.

## Auth in Tests

tereo is replaced in `int` by `@tereo-io/sdk`'s **test mode** and its test tokens; there is no
other shortcut. Tokens are strings:

```
test-token-<uuid>|org=<uuid>|perms=homileo.spaces.write,homileo.chat.admin   # a person
test-token-<uuid>|client=<uuid>                                               # a service account (same UUID twice)
```

- Every `/v1` token needs an organization (`|org=<uuid>`), person or service account
  (`test-token-<uuid>|client=<uuid>|org=<uuid>`); without one the answer is 400
  `organization_required`. Permissions go in `|perms=`. `X-Organization-ID` is not read.
- Use a fresh UUID for a fresh principal; the same UUID is the same principal across tests.
- `homileo.chat.admin` covers administration but never reads DMs or space-less sessions — test it.
- Permissions a test needs that Homileo does not declare are made up in the token; the SDK's test
  mode does not check them against a registry.

Route auth: a new route needs no generic 401 test if `routes/routes.permissions.test.ts` walks the
mounted route table, but it does need a `.permissions` test for its own rules (visibility, join,
posting, grants, organization isolation).

## Integration Test Pattern

```typescript
// @module-tag int
// @module-tag spaces
import { describe, it, expect } from "vitest";
import { BASE_URL, personToken } from "../../../support/tokens.js";

describe("GET /v1/spaces", () => {
  it("returns 403 without homileo.spaces.read", async () => {
    const token = personToken({ perms: [] });

    const response = await fetch(`${BASE_URL}/v1/spaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });
});
```

Errors come back as `{ error, error_description }`. (`support/tokens.ts` is the helper the first
route tests create; keep its shape small.) Tags are one `// @module-tag` per line at the top.

## Asserting Side Effects

Tests may read the test database through `prisma` (`src/utils/db/prisma.js`) to check what the API
can't show. Write one test per mutation for its side effects (in `.audit` when the main file is
near the cap):

- **Event**: a `chat.events` row with the type, organization, space/session and actor.
- **Webhook**: a `core.core_outbox` row with `destination = "webhook"`, `payload.eventType ===
  "homileo.<type>"`; none for a non-webhook event such as `read.updated`.
- **Audit**: a `core.core_outbox` row with `destination = "audit"` when the change asks for one.
- **Atomicity**: a rolled-back transaction leaves no event and no outbox row.
- **`recordChange`**: call `initializeTereo()` in `beforeAll`, run it inside `prisma.$transaction`,
  and read `core.core_outbox` with raw SQL filtered on the test's own `organizationId`.
- **Background jobs**: call the job's exported function directly (`ensureEventPartitions(day)`; pass
  a far-off day so the count is exact), then check the rows.

## DO

- Put each test where the README says; one tier tag (`unit` or `int`, matching `.unit`) first, then
  the path's primary area tag, per file, **one `// @module-tag` per line** (several on a line drop
  all but the first)
- Keep every file at 800 lines or fewer; split by aspect, then method. A file that cannot fit goes
  in `conventions/oversize.ts` with a ceiling and a reason
- Put validation in `.validation.unit` tables against the route's exported Zod schema, with one 400
  case in the route's `int` file proving the schema is wired in
- Test through HTTP against the running server for anything a route does
- Test route-specific authorization (`.permissions`), 404 for unknown **and unreadable** ids, and
  cross-organization isolation
- Put multi-route sequences in `flows/<area>/`, and a one-route test with the route
- Run the same cases through the policy function and the SQL condition
- Assert the event and outbox rows for new mutations
- Remove a duplicate from the more expensive tier, and list it in the commit message as
  `removed: <old file> > <test name> -> covered by <new file> > <test name>`
- Use unique names and fresh UUIDs — the database persists across runs
- Use descriptive names: `it("returns 404 for a session the caller cannot read")`
- Run the focused tests while working; leave the full suite to CI

## DON'T

- Don't mock the database, Redis or auth — `int` hits real Postgres, Redis and the real middleware
  with SDK test tokens
- Don't import `utils/db/`, `utils/redis.ts`, `app.ts`, `index.ts`, `worker.ts`, `setup/` (except
  `tags.ts`) or `support/` (except `support/pure/`) in a `.unit` file
- Don't name a file after a bug or ticket, or invent an aspect or a free-form name
- Don't assume a clean database: migrations apply forward, nothing is reset
- Don't point tests at the dev database or run them while the dev server holds the port
- Don't rely on another file's state, or on the server's worker being idle
- Don't forget `.js` on relative imports; sort imports longest-first like source files
