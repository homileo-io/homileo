---
homileo: major
'@homileo-io/sdk': major
---

Fixes from an audit of the realtime, chat and platform layers. Breaking: webhook events of private sessions (space-less, or `access` `members`) now use `homileo.private_*` types that need the new `homileo.messages.read_private` permission; `TEREO_SERVICE_SLUG` accepts only `homileo`; `/v1/sync` refuses a `since` cursor past the current transaction. Also: realtime events follow current access (mentions, join requests to moderators, created events to their founders, deletes to mentioned readers), bounded Markdown parsing, a 50-emoji reaction cap, attachment keep recovery, `/me/mentions` paging, message-type retirement serialized against posts, partial indexes, and DM and join-request fixes. The SDK caps a provisioning document's version at 64 characters and lists the private webhook event names.
