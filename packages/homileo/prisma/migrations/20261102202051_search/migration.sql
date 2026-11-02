-- AlterTable
ALTER TABLE "chat"."messages" ADD COLUMN     "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body_text, ''))) STORED;

-- AlterTable
ALTER TABLE "chat"."provisioned_space_kinds" ADD COLUMN     "search_built_at" TIMESTAMP(3),
ADD COLUMN     "search_changed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "chat"."sessions" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "chat"."spaces" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "spaces_metadata_idx" ON "chat"."spaces" USING GIN ("metadata");

-- Raw SQL: Prisma cannot express the extension, trigram or expression indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA chat;
CREATE INDEX messages_search_vector_idx ON "chat"."messages" USING gin (search_vector);
CREATE INDEX messages_body_text_trgm_idx ON "chat"."messages" USING gin (body_text chat.gin_trgm_ops);
CREATE INDEX attachments_filename_trgm_idx ON "chat"."attachments" USING gin (filename chat.gin_trgm_ops);
CREATE INDEX principals_display_name_trgm_idx ON "chat"."principals" USING gin (display_name chat.gin_trgm_ops);
CREATE INDEX spaces_search_text_fts_idx ON "chat"."spaces" USING gin (to_tsvector('english', search_text));
CREATE INDEX spaces_search_text_trgm_idx ON "chat"."spaces" USING gin (search_text chat.gin_trgm_ops);
CREATE INDEX sessions_search_text_fts_idx ON "chat"."sessions" USING gin (to_tsvector('english', search_text));
CREATE INDEX sessions_search_text_trgm_idx ON "chat"."sessions" USING gin (search_text chat.gin_trgm_ops);
