-- Raw SQL: Prisma cannot express a partial index. Retiring a kind probes it to
-- tell whether any unarchived space still has that kind.
CREATE INDEX "spaces_kind_unarchived_idx" ON "chat"."spaces" ("kind") WHERE "archived_at" IS NULL;
