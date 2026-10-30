---
name: routes
description: Route layout standards for Homileo's Express routers (packages/homileo/src/routes). Use when adding, moving, renaming or reviewing a route, router, controller, route schema or route-local middleware; when deciding where a new endpoint's files go or what order to register routes in; or when routeLayout.unit.test.ts fails.
paths:
  - packages/homileo/src/routes/**
---

# Route Layout

The folder tree under `src/routes` mirrors the URL, one folder per segment, and every folder has the
same files. `src/tests/conventions/routeLayout.unit.test.ts` enforces the mechanical rules; registration order is
checked in review.

## The Tree

`routes/index.ts` is the root: `/health`, then `/v1`. `routes/v1/index.ts` mounts Homileo's API areas
(`me/` today; `spaces/`, `sessions/`, `messages/`, `events/` as the plans add them), each with its
body limit. **A new API route goes under `routes/v1/`.** Authentication (`authenticate`, then
`requireOrganization`) goes once on the `/v1` router, not on each area or route.

## Files in a Folder

| File | Holds | Never holds |
|---|---|---|
| `index.ts` | Exactly one `Router()` and its `router.<verb>/use(…)` calls | Function definitions (no `=>`, no `function`) |
| `controllers.ts` | Handlers — functions that answer the request | Routers, route registration |
| `schemas.ts` | Zod schemas and their `z.infer` types | — (the only file that calls `z.*`) |
| `middleware.ts` | Middleware used only by this folder's routes (guards such as `guardSessionAccess`) | Middleware several areas share → `src/middleware/` |
| `utils.ts`, `events.ts`, … | Other helpers, if needed | Routes |

A controller shared with a nested route stays in the parent's `controllers.ts`; the nested
`index.ts` imports it from `../controllers.js`.

## `:param` Folders

Every `:param` is its own folder, named for the **singular** of what it addresses, and mounted one
segment at a time:

| URL | Folders |
|---|---|
| `/spaces/:spaceId` | `spaces/space/` |
| `/sessions/:sessionId` | `sessions/session/` |
| `/sessions/:sessionId/messages/:messageId` | `sessions/session/messages/message/` |
| `/messages/:messageId/reactions/:emoji` | `messages/message/reactions/reaction/` |

- Parent: `router.use("/:sessionId", sessionRouter)` — a single-segment path, always `use`.
- Item: `Router({ mergeParams: true })`, its own routes at `"/"`.
- Never a `:param` in a verb route (`router.delete("/:userId", …)`) or inside a longer path
  (`router.use("/by-id/:id", …)`).
- Folder names match the URL segment (`read-state/`, `by-key/`).

## Registration Order

Within an `index.ts`, most specific first:

1. Path-less middleware — `router.use(guard)`
2. Static paths — sub-routers (`/members`) and actions (`/archive`, `/read`)
3. `:param` mounts — `router.use("/:id", itemRouter)`, after the statics so `/archive` is never an id
4. Generic `/` routes — `GET /`, `POST /`, `PATCH /`, `DELETE /`

HEAD before GET on the same path (Express otherwise answers HEAD with the GET handler).

`routes/index.ts` registers `/health` before `/v1`, and anything that serves a UI last.

## Example — `/v1/sessions`

`GET|POST /`, `GET|PATCH|DELETE /:sessionId`, `POST /:sessionId/archive`, with an access guard on
every `:sessionId` route (the guard asks `src/policy/`, never inlines an access rule):

```
v1/sessions/
├── index.ts  controllers.ts  schemas.ts        # list, create
└── session/                                    # /:sessionId
    ├── index.ts  controllers.ts  schemas.ts    # get, update, /archive; SessionParamsSchema
    ├── middleware.ts                           # guardSessionAccess
    └── messages/
        └── index.ts  controllers.ts  schemas.ts
```

```typescript
// v1/sessions/index.ts
const sessionsRouter = Router();

sessionsRouter.use("/:sessionId", sessionRouter);

sessionsRouter.get("/", listSessions);
sessionsRouter.post("/", createSession);

export default sessionsRouter;

// v1/sessions/session/index.ts
const sessionRouter = Router({ mergeParams: true });

sessionRouter.use(guardSessionAccess);

sessionRouter.use("/messages", messagesRouter);
sessionRouter.post("/archive", archiveSession);

sessionRouter.get("/", getSession);
sessionRouter.patch("/", updateSession);

export default sessionRouter;
```

## Common Mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Item router without `mergeParams` | `req.params.sessionId` is `undefined`; validation 400s | `Router({ mergeParams: true })` |
| `/:id` mounted before `/archive` | `/archive` reaches the item router as an id | Statics first |
| Guard written inline in `index.ts` | `routeLayout.unit.test.ts`: "defines no functions in index.ts" | Move it to `middleware.ts` |
| `z.guid().safeParse(id)` in a controller | "builds Zod schemas only in schemas.ts" | Export the schema from `schemas.ts` |
| Moving a folder and hand-fixing imports | A parent still imports the old (now leaf) router; routes 404 | Re-check every parent `index.ts` import after a move, then run `npm run test:unit` and the route's tests |

Related: `backend` (validation, errors, auth, db, `recordChange`), `openapi` (spec paths for new routes),
`test`.
