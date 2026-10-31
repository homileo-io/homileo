-- DropIndex
DROP INDEX "chat"."events_organization_id_id_idx";

-- AlterTable
ALTER TABLE "chat"."events" ADD COLUMN     "tx_id" xid8 NOT NULL DEFAULT pg_current_xact_id();

-- CreateIndex
CREATE INDEX "events_organization_id_tx_id_id_idx" ON "chat"."events" ("organization_id", "tx_id", "id");
