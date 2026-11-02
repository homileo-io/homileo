---
homileo: minor
'@homileo-io/sdk': minor
---

Search: `GET /v1/search/messages` (full-text and typo-tolerant, with filters, exact `metadata[key]=value` filters and highlighted snippets; attachment filenames match too), `GET /v1/search/sessions` (spaces and sessions in one ranked list) and `GET /v1/search/principals` (principals who took part in a session the caller can read), all limited to what the caller can read through the raw-SQL form of the access policy (`readableSpaceSql`, `readableSessionSql`). The migration installs `pg_trgm` in schema `chat` (a trusted extension; the migrating role needs `CREATE`, not superuser) and adds `search_text` columns and indexes. A provisioned kind's `search.metadata` feeds them, and a worker job (`searchTextRebuild`) rebuilds them after it changes. Paging is by offset up to the new `SEARCH_MAX_DEPTH` env var (default 1,000). The SDK carries the search response types and schemas.
