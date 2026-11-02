-- DropIndex
DROP INDEX "core"."core_outbox_next_attempt_at_idx";

-- Raw SQL: Prisma cannot express a partial index. The predicate matches
-- @tereo-io/sdk's outboxTableSql, so the reaper's claim skips dead-lettered rows.
CREATE INDEX "core_outbox_pending_idx" ON "core"."core_outbox" ("next_attempt_at") WHERE "dead_lettered_at" IS NULL;

-- Raw SQL: Prisma cannot express a partial index. Provisioning probes it to
-- tell whether a message type is in use; the built-in text type is left out.
CREATE INDEX "messages_type_idx" ON "chat"."messages" ("type") WHERE "type" <> 'text';
