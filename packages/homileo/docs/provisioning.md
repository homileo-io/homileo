# Provisioning documents

Apps declare their space kinds and custom message types in provisioning documents: JSON files in
the folder `PROVISIONING_PATH` names. Homileo reads them at every start, validates the whole set
and applies it in one transaction, before it listens (`ROLE` `all` and `api`).
`npm run cli -- provision [--path <path>]` applies them on demand and prints
`{ "applied": n, "retired": [...] }`. The production image has no `tsx` and no `src`; there, run
the compiled CLI with `npm run cli:prod -- provision` (`node dist/cli/index.js provision`), e.g.
`kubectl exec deploy/homileo -- npm run cli:prod -- provision`.

With `PROVISIONING_PATH` unset nothing is read and nothing changes. An invalid set stops the
start (or exits the CLI with 1) after logging every problem, each with its file and path.

## Loading

- A directory: every `*.json` directly inside it, in name order. Names starting with `.`, other
  extensions and subdirectories are skipped. A directory with no `*.json` is an error.
- A single file path is accepted too.
- Unknown keys are refused, in the document and in every nested object.

## A document

```jsonc
{
  "version": "1.0.0",                     // semver, at most 64 characters
  "app": "support",                       // ^[a-z][a-z0-9-]{0,62}$; the namespace of kinds and message types
  "spaceKinds": [
    {
      "name": "support:case",             // "<app>:<slug>", at most 64 characters
      "defaults": { "visibility": "members", "join": "invite", "posting": "members" },
      "overridable": [],                  // which defaults a space may change; default []
      "states": ["open", "resolved"],     // unique, ^[a-z][a-z0-9_]{0,62}$; a space starts with `state: null` unless its create names one
      "grants": [{ "permission": "support.cases.read", "access": "moderate" }], // access: read | moderate
      "bots": ["<service-account user id>"], // tereo user UUIDs that join every session of the kind
      "editWindowSeconds": null,          // integer >= 0, or null for no limit
      "search": { "metadata": ["customerName"] } // metadata keys search matches
    }
  ],
  "messageTypes": [
    { "name": "support:order-card", "payloadSchema": { /* JSON Schema 2020-12 */ } }
  ]
}
```

Only `version`, `app`, `defaults` and the names and `payloadSchema` are required. Omitted
optional fields resolve to `overridable []`, `states []`, `grants []`, `bots []`,
`editWindowSeconds null` and `search { metadata: [] }`.

The built-in kind `default` (visibility `members`, join `invite`, posting `members`, everything
overridable) is used when a space names no kind; the built-in message type is `text`. Neither can
be declared.

## Rules across the set

- One document per app: the same `app` in two files is a problem naming both.
- Kind names and message type names are unique across the set.
- A `payloadSchema` must compile as JSON Schema 2020-12 (Ajv, non-strict: unknown keywords are
  allowed, `format` is not enforced).
- Every problem is reported, not the first.

## Applying

One transaction. Declared kinds and types are created, changed or re-activated (a retired name
that returns); unchanged rows are not written, so a second run changes nothing. `document_version`
holds the document's version string.

Kinds and types missing from the set are retired (`retired_at`), except:

- a kind with unarchived spaces is a problem: archive the spaces first;
- a message type some message uses is a problem. (Messages of a retired type render their `body`.)

The transaction may take `max(60 s, 2 × DB_TRANSACTION_TIMEOUT_MS)`, and runs with `lock_timeout`
one second below that: retiring a name waits for the requests using it to finish, and Prisma's own
timeout cannot interrupt a wait already on the server.

A problem rolls the whole transaction back. Retired kinds drop out of `loadKinds()`, which returns
the active kinds and the built-in one by name. Provisioned rows are read-only through the API.

## Search metadata

A kind's `search.metadata` lists the metadata keys whose values `GET /v1/search/sessions` matches
for spaces and sessions of that kind, together with the name. Changing it stamps the kind
(`search_changed_at`); the worker (`src/jobs/searchTextRebuild.ts`) then rebuilds `search_text` for
that kind's spaces and sessions in batches of 500, but only once `DB_TRANSACTION_TIMEOUT_MS` has
passed since the change, so no write still using the old keys can undo it. Expect search to
reflect the change within about that time plus the 60 s job interval.

## JSON Schema for editors

`@homileo-io/sdk` exports `provisioningJsonSchema`, and `packages/homileo-sdk/provisioning.schema.json`
is the generated file (`npm run provisioning:schema -w @homileo-io/sdk`). Point a document's `"$schema"` at it for editor validation (Homileo accepts and ignores the key).
The schema cannot express the `<app>:` name prefix, the unique `states` or the cross-document
rules; Homileo enforces those at start.
