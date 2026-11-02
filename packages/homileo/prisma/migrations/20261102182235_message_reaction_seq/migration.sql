-- AlterTable
ALTER TABLE "chat"."messages" ADD COLUMN     "reaction_seq" BIGINT NOT NULL DEFAULT 0;
