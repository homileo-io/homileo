-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "chat";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateEnum
CREATE TYPE "chat"."principal_kind" AS ENUM ('user', 'external');

-- CreateEnum
CREATE TYPE "chat"."space_visibility" AS ENUM ('public', 'members');

-- CreateEnum
CREATE TYPE "chat"."join_policy" AS ENUM ('open', 'request', 'invite');

-- CreateEnum
CREATE TYPE "chat"."post_policy" AS ENUM ('members', 'moderators');

-- CreateEnum
CREATE TYPE "chat"."space_role" AS ENUM ('owner', 'moderator', 'member');

-- CreateEnum
CREATE TYPE "chat"."session_type" AS ENUM ('direct', 'group');

-- CreateEnum
CREATE TYPE "chat"."session_access" AS ENUM ('space', 'members');

-- CreateEnum
CREATE TYPE "chat"."participant_role" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "chat"."notify_level" AS ENUM ('all', 'mentions', 'none');

-- CreateEnum
CREATE TYPE "chat"."join_request_status" AS ENUM ('pending', 'approved', 'denied');

-- CreateEnum
CREATE TYPE "chat"."mention_kind" AS ENUM ('user', 'here', 'session');

-- CreateTable
CREATE TABLE "chat"."principals" (
    "id" UUID NOT NULL,
    "kind" "chat"."principal_kind" NOT NULL,
    "tereo_user_id" UUID,
    "app" VARCHAR(100),
    "external_id" VARCHAR(255),
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(255),
    "avatar_url" VARCHAR(2048),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."spaces" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "visibility" "chat"."space_visibility" NOT NULL DEFAULT 'members',
    "join_policy" "chat"."join_policy" NOT NULL DEFAULT 'invite',
    "post_policy" "chat"."post_policy" NOT NULL DEFAULT 'members',
    "state" VARCHAR(64),
    "external_ref" VARCHAR(255),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."space_members" (
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "chat"."space_role" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_members_pkey" PRIMARY KEY ("space_id","user_id")
);

-- CreateTable
CREATE TABLE "chat"."space_join_requests" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "chat"."join_request_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "space_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID,
    "type" "chat"."session_type" NOT NULL,
    "access" "chat"."session_access" NOT NULL DEFAULT 'space',
    "name" VARCHAR(255),
    "state" VARCHAR(64),
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "direct_key" VARCHAR(80),
    "external_ref" VARCHAR(255),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."session_participants" (
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "chat"."participant_role" NOT NULL DEFAULT 'member',
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "notify" "chat"."notify_level" NOT NULL DEFAULT 'all',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("session_id","user_id")
);

-- CreateTable
CREATE TABLE "chat"."messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "sender_id" UUID NOT NULL,
    "client_message_id" VARCHAR(128) NOT NULL,
    "type" VARCHAR(64) NOT NULL DEFAULT 'text',
    "body" TEXT,
    "body_text" TEXT,
    "payload" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "thread_root_id" UUID,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "last_reply_at" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."message_revisions" (
    "message_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "edited_by" UUID NOT NULL,
    "edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_revisions_pkey" PRIMARY KEY ("message_id","revision")
);

-- CreateTable
CREATE TABLE "chat"."message_mentions" (
    "id" BIGSERIAL NOT NULL,
    "message_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" "chat"."mention_kind" NOT NULL,
    "user_id" UUID,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."reactions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("message_id","user_id","emoji")
);

-- CreateTable
CREATE TABLE "chat"."attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "tereo_object_id" VARCHAR(255) NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "size" BIGINT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."thread_followers" (
    "thread_root_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "following" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "thread_followers_pkey" PRIMARY KEY ("thread_root_id","user_id")
);

-- CreateTable
CREATE TABLE "chat"."events" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" VARCHAR(100) NOT NULL,
    "organization_id" UUID NOT NULL,
    "space_id" UUID,
    "session_id" UUID,
    "actor_id" UUID,
    "payload" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id","created_at")
)
PARTITION BY RANGE ("created_at");

-- CreateTable
CREATE TABLE "chat"."provisioned_space_kinds" (
    "name" VARCHAR(64) NOT NULL,
    "app" VARCHAR(100) NOT NULL,
    "definition" JSONB NOT NULL,
    "document_version" INTEGER NOT NULL,
    "source_file" VARCHAR(512) NOT NULL,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioned_space_kinds_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "chat"."provisioned_message_types" (
    "name" VARCHAR(64) NOT NULL,
    "app" VARCHAR(100) NOT NULL,
    "payload_schema" JSONB NOT NULL,
    "document_version" INTEGER NOT NULL,
    "source_file" VARCHAR(512) NOT NULL,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioned_message_types_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "core"."core_outbox" (
    "id" UUID NOT NULL,
    "destination" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "traceparent" VARCHAR(64),
    "tracestate" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claimed_by" VARCHAR(255),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "dead_lettered_at" TIMESTAMP(3),

    CONSTRAINT "core_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "principals_tereo_user_id_key" ON "chat"."principals"("tereo_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "principals_app_external_id_key" ON "chat"."principals"("app", "external_id");

-- CreateIndex
CREATE INDEX "spaces_organization_id_idx" ON "chat"."spaces"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_organization_id_kind_external_ref_key" ON "chat"."spaces"("organization_id", "kind", "external_ref");

-- CreateIndex
CREATE INDEX "space_members_user_id_idx" ON "chat"."space_members"("user_id");

-- CreateIndex
CREATE INDEX "space_join_requests_space_id_status_idx" ON "chat"."space_join_requests"("space_id", "status");

-- CreateIndex
CREATE INDEX "sessions_organization_id_space_id_idx" ON "chat"."sessions"("organization_id", "space_id");

-- CreateIndex
CREATE INDEX "sessions_external_ref_idx" ON "chat"."sessions"("external_ref");

-- CreateIndex
CREATE INDEX "sessions_metadata_idx" ON "chat"."sessions" USING GIN ("metadata");

-- CreateIndex
CREATE INDEX "session_participants_user_id_idx" ON "chat"."session_participants"("user_id");

-- CreateIndex
CREATE INDEX "messages_thread_root_id_seq_idx" ON "chat"."messages"("thread_root_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_session_id_seq_key" ON "chat"."messages"("session_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_session_id_sender_id_client_message_id_key" ON "chat"."messages"("session_id", "sender_id", "client_message_id");

-- CreateIndex
CREATE INDEX "message_mentions_message_id_idx" ON "chat"."message_mentions"("message_id");

-- CreateIndex
CREATE INDEX "message_mentions_user_id_message_id_idx" ON "chat"."message_mentions"("user_id", "message_id");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "chat"."attachments"("message_id");

-- CreateIndex
CREATE INDEX "events_organization_id_id_idx" ON "chat"."events"("organization_id", "id");

-- CreateIndex
CREATE INDEX "events_session_id_id_idx" ON "chat"."events"("session_id", "id");

-- CreateIndex
CREATE INDEX "core_outbox_next_attempt_at_idx" ON "core"."core_outbox"("next_attempt_at");

-- AddForeignKey
ALTER TABLE "chat"."spaces" ADD CONSTRAINT "spaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."space_members" ADD CONSTRAINT "space_members_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "chat"."spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."space_members" ADD CONSTRAINT "space_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."space_join_requests" ADD CONSTRAINT "space_join_requests_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "chat"."spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."space_join_requests" ADD CONSTRAINT "space_join_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."space_join_requests" ADD CONSTRAINT "space_join_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "chat"."principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."sessions" ADD CONSTRAINT "sessions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "chat"."spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."sessions" ADD CONSTRAINT "sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."session_participants" ADD CONSTRAINT "session_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."session_participants" ADD CONSTRAINT "session_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "chat"."principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_thread_root_id_fkey" FOREIGN KEY ("thread_root_id") REFERENCES "chat"."messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_revisions" ADD CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_revisions" ADD CONSTRAINT "message_revisions_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_mentions" ADD CONSTRAINT "message_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_mentions" ADD CONSTRAINT "message_mentions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat"."sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_mentions" ADD CONSTRAINT "message_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."reactions" ADD CONSTRAINT "reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."reactions" ADD CONSTRAINT "reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."thread_followers" ADD CONSTRAINT "thread_followers_thread_root_id_fkey" FOREIGN KEY ("thread_root_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."thread_followers" ADD CONSTRAINT "thread_followers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."events" ADD CONSTRAINT "events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "chat"."principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Raw SQL Prisma cannot express.

-- A user principal carries a tereo user; an external one an app and an id.
ALTER TABLE "chat"."principals"
    ADD CONSTRAINT "principals_kind_columns_check" CHECK (
        (kind = 'user') = (tereo_user_id IS NOT NULL)
        AND (kind = 'external') = (app IS NOT NULL AND external_id IS NOT NULL)
    );

-- A direct session is unique per pair of principals within an organization.
CREATE UNIQUE INDEX "sessions_organization_id_direct_key_key"
    ON "chat"."sessions" ("organization_id", "direct_key")
    WHERE "direct_key" IS NOT NULL;

-- A direct session has no space and always has a direct key.
ALTER TABLE "chat"."sessions"
    ADD CONSTRAINT "sessions_direct_check" CHECK (
        type <> 'direct' OR (space_id IS NULL AND direct_key IS NOT NULL)
    );

-- One pending request per user and space.
CREATE UNIQUE INDEX "space_join_requests_space_id_user_id_pending_key"
    ON "chat"."space_join_requests" ("space_id", "user_id")
    WHERE "status" = 'pending';

-- The session timeline: top-level messages by seq (replies are read through
-- the thread index).
CREATE INDEX "messages_session_id_seq_top_level_idx"
    ON "chat"."messages" ("session_id", "seq")
    WHERE "thread_root_id" IS NULL;
