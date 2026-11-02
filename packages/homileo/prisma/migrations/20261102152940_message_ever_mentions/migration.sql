-- CreateTable
CREATE TABLE "chat"."message_ever_mentions" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "message_ever_mentions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- AddForeignKey
ALTER TABLE "chat"."message_ever_mentions" ADD CONSTRAINT "message_ever_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat"."message_ever_mentions" ADD CONSTRAINT "message_ever_mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "chat"."principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: SQL cannot parse the earlier revisions, so only each message's current
-- user mentions are known. A reader mentioned only in an earlier revision may be
-- emailed once more if an edit mentions them again.
INSERT INTO "chat"."message_ever_mentions" (message_id, user_id)
SELECT DISTINCT message_id, user_id FROM "chat"."message_mentions"
WHERE kind = 'user' AND user_id IS NOT NULL
ON CONFLICT DO NOTHING;
