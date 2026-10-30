import type { FilesClient } from "../../utils/attachments.js";
import type { FileServiceObject } from "@tereo-io/sdk";
import { v7 as uuidv7 } from "uuid";

/** An in-memory stand-in for tereo's files client; what `uploadObject` stored can be inspected and resized. */
export const fakeFiles = () => {
  const objects = new Map<string, FileServiceObject>();
  const presigned: Array<{
    id: string;
    operation?: string;
    expiresInSeconds?: number;
  }> = [];
  const failPatch = { on: false };

  const client: FilesClient = {
    uploadObject: async (_bucket, key, data) => {
      const object: FileServiceObject = {
        id: uuidv7(),
        key,
        contentType: data.contentType ?? "application/octet-stream",
        sizeBytes: String(data.file.length),
        etag: "e",
        metadata: data.metadata ?? null,
        tags: [],
        deleteAfter: null,
        createdAt: new Date().toISOString(),
      };
      objects.set(object.id, object);
      return object;
    },
    getObject: async (_bucket, id) => objects.get(id) ?? null,
    patchObject: async (_bucket, id, input) => {
      if (failPatch.on) throw new Error("tereo is down");
      const object = objects.get(id);
      if (!object) throw Object.assign(new Error("gone"), { statusCode: 404 });
      if (input.deleteAfter !== undefined)
        object.deleteAfter = input.deleteAfter;
      return object;
    },
    deleteObject: async (_bucket, id) => {
      objects.delete(id);
    },
    presignObjectUrl: async (_bucket, id, input) => {
      if (!objects.has(id)) {
        throw Object.assign(new Error("gone"), {
          statusCode: 404,
          code: "not_found",
        });
      }
      presigned.push({ id, ...input });
      return {
        url: `https://files.test/${input?.operation ?? "read"}/${id}`,
        expiresAt: new Date(
          Date.now() + (input?.expiresInSeconds ?? 3600) * 1000
        ).toISOString(),
        operation: input?.operation ?? "read",
      };
    },
  };

  return {
    client,
    objects,
    presigned,
    failPatch,
    /** Pretends the upload finished. */
    setSize: (id: string, bytes: number) => {
      objects.get(id)!.sizeBytes = String(bytes);
    },
    /** What an object expiring in tereo looks like. */
    expire: (id: string) => {
      objects.delete(id);
    },
    /** An object that is already uploaded, under a key of the caller's choosing. */
    put: (key: string, sizeBytes = "5") => {
      const object: FileServiceObject = {
        id: uuidv7(),
        key,
        contentType: "text/plain",
        sizeBytes,
        etag: "e",
        tags: [],
        deleteAfter: "2099-01-01T00:00:00.000Z",
        createdAt: new Date().toISOString(),
      };
      objects.set(object.id, object);
      return object;
    },
  };
};
