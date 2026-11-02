# @homileo-io/sdk

The contract of [Homileo](https://github.com/homileo-io/homileo), a chat service for apps built on
[tereo](https://github.com/tereo-io/tereo):

- **Event registry**: `EVENT_TYPES`, with one payload schema per event (`message.created`,
  `space.updated` and so on), plus the envelope that sockets and `GET /v1/sync` deliver.
- **Resource schemas**: the shape of each API resource (`Space`, `Session`, `Message` and others).
- **Provisioning documents**: the schema for the JSON documents an app uses to declare space kinds
  and message types (`provisioningDocumentSchema`), also shipped as `provisioning.schema.json`.

```sh
npm install @homileo-io/sdk
```

```ts
import { EVENT_TYPES, EventEnvelopeSchema } from "@homileo-io/sdk";

const event = EventEnvelopeSchema.parse(json);

const { message } = EVENT_TYPES["message.created"].payload.parse(event.payload);
```

A typed API client comes in a later release.

Licensed under Apache-2.0.
