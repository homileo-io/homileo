-- CreateIndex
CREATE INDEX "space_members_space_id_joined_at_user_id_idx" ON "chat"."space_members"("space_id", "joined_at", "user_id");

-- CreateIndex
CREATE INDEX "spaces_organization_id_created_at_id_idx" ON "chat"."spaces"("organization_id", "created_at" DESC, "id" DESC);

-- Raw SQL: Prisma cannot express NULLS LAST in an index. A space's session list
-- orders by exactly this.
CREATE INDEX "sessions_space_list_idx" ON "chat"."sessions" ("space_id", "last_message_at" DESC NULLS LAST, "created_at" DESC, "id" DESC);

-- Raw SQL: Prisma cannot express a partial index. The participant list pages
-- current participants in this order.
CREATE INDEX "session_participants_current_idx" ON "chat"."session_participants" ("session_id", "joined_at", "user_id") WHERE "left_at" IS NULL;
