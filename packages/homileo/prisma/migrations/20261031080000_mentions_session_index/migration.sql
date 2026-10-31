-- Raw SQL: Prisma cannot express a partial index. Serves the here/session
-- mention reads of /v1/me/mentions and /v1/me/unread, per session.
CREATE INDEX "message_mentions_session_broadcast_idx" ON "chat"."message_mentions" ("session_id", "message_id") WHERE "kind" IN ('here','session');
