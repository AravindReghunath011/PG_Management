# CLAUDE.md — AI agent context for the PG Management Platform

> Read this file in full before writing any code. It encodes decisions that are
> easy to accidentally break. If a change would violate anything in **Non-negotiable
> rules** or **Do NOT**, stop and flag it instead of "fixing" it.
>
> This file works as `CLAUDE.md` (Claude Code), as a Cursor rules file, or as
> general context for any AI coding assistant. Companion docs: `FEATURES.md`,
> `DATA_MODEL.md`, `API_CONTRACT.md`.

## 1. What we are building

A SaaS that lets **Paying Guest (PG) operators** run their properties: model
branches → rooms → beds, register residents with ID/KYC images, track rent
due/paid, and — most importantly — **retrieve any historical fact instantly**
(who stayed in which bed on any past date, and whether they had paid).

The product thesis: a notebook can *store* data but cannot *recall* it. Our wedge
is **retrieval** (search, filters, per-bed/per-resident history). Build that as a
first-class feature, not an afterthought.

Scope of this version: **PG only.** Hotel mode is a future product line — do not
build hourly/daily billing or booking calendars now, but do not design anything
that blocks them later.

## 2. Glossary (use these exact terms everywhere — names, comments, models)

| Term | Meaning | Never call it |
|------|---------|---------------|
| **Owner** | The paying SaaS customer / PG operator who logs in. The "tenant" in the multi-tenant architecture sense. | "tenant" (ambiguous), "user" in domain code |
| **Resident** | The person who stays in a bed. | "tenant", "guest" |
| **Stay** | One Resident occupying one Bed for a date range. The history-bearing record. | "booking", "assignment" |
| **Branch** | One physical property of an Owner. | "property" in code (use Branch) |

The word "tenant" in code is reserved **only** for multi-tenant infrastructure
(data isolation). It must never refer to a resident.

## 3. Tech stack

- **Client:** Flutter (Dart) — single codebase for mobile (primary) and web.
- **Server:** Node.js REST API.
- **Cloud DB:** MongoDB (sits *behind* the Node API; it is a plain store, not a sync engine).
- **Local DB (client):** SQLite via Drift, or Isar — source of truth for the UI.
- Use latest stable versions; confirm exact versions against current docs rather
  than assuming. Do not reintroduce MongoDB Atlas Device Sync / Realm sync — that
  product was discontinued (EOL Sept 2025).

## 4. Architecture — offline-aware from day one

```
Flutter app
  App UI  <->  Local DB (Drift/Isar, source of truth)  ->  Outbox queue
                                                              |
                                                  sync when online (HTTPS)
                                                              v
                                                        Node.js API  <->  MongoDB
```

- The UI **only ever reads/writes the local DB.** It never blocks on the network.
- Writes are also appended to an **outbox**. When online, the outbox drains to the
  Node API; the API persists to MongoDB and returns records changed since the
  client's last sync (pull).
- **v1 ships the "graceful" version:** local cache + outbox + retry-when-online.
- **Full bidirectional offline sync is Phase 2** (feature `SYNC-*`). The data model
  below already supports it, so you must include the sync metadata fields now.

### Why sync is simple here (do not over-engineer it)
Access is **owner-only**, so it is effectively single-writer per account. Two
conflicting edits to the same record are rare and low-stakes. Use
**last-write-wins by `updatedAt`**. Do NOT build CRDTs or a conflict-resolution UI.

## 5. Non-negotiable data rules (breaking these forces a rewrite)

1. **Never overwrite occupancy.** A new resident moving into a bed creates a NEW
   `Stay`. The old `Stay` is closed (set `checkOutDate`), never edited away or
   deleted. All history is permanent.
2. **A resident's identity never lives on a Bed.** Bed ↔ Resident is connected
   only through a `Stay`. A Bed stores status, not a name.
3. **Dues are line-items, not a single number.** A `Payment`/due holds
   `{ rent, electricity, other }`. This is what lets us add electricity metering
   later without a migration.
4. **Every domain record is scoped to an `ownerId`.** Every query, on client and
   server, filters by the authenticated owner. Owner A must never read Owner B's data.
5. **Client-generated IDs.** New records get a UUID minted on the client (so they
   can be created offline before the server has seen them). The server accepts the
   client UUID as the primary key; do not rely on Mongo's `_id` as the domain id.
6. **Soft delete only** for sync-tracked entities: set `deletedAt`, never hard-delete.
7. **Every record carries sync metadata:** `id` (uuid), `ownerId`, `createdAt`,
   `updatedAt`, `deletedAt` (nullable). See `DATA_MODEL.md`.

## 6. Do NOT

- Do NOT store a resident's name/phone directly on a Bed or Room.
- Do NOT delete or mutate a past `Stay` to record a new occupant.
- Do NOT allow two open (un-checked-out) `Stay`s on the same Bed at once.
- Do NOT add payment-gateway/UPI code — v1 only tracks paid/unpaid status.
- Do NOT add staff/warden logins or role-based permissions — owner-only for v1.
- Do NOT build hotel features (hourly/daily rates, calendars).
- Do NOT use `localStorage`/`sessionStorage`-style assumptions; the client store is the local DB.
- Do NOT hardcode secrets; read from env config.
- Do NOT skip the `ownerId` filter on any query "to make it work" — that is a data-leak bug.

## 7. Suggested repo layout

```
/app            Flutter client
  /lib
    /features   one folder per module (auth, property, residents, occupancy, rent, search, dashboard, sync)
    /data       local DB (Drift/Isar), models, repositories, outbox
    /api        Node API client
/server         Node.js API
  /src
    /modules    one per resource (auth, branches, rooms, beds, residents, stays, payments, sync)
    /db         Mongo connection, collections, indexes
    /middleware auth, owner-scoping, error handling
/docs           these markdown files
```

Organize by **feature/module**, not by technical layer alone. Keep domain logic
out of route handlers.

## 8. Conventions

- REST, JSON. Auth via `Authorization: Bearer <token>`. See `API_CONTRACT.md`.
- Timestamps are ISO-8601 UTC strings.
- Money stored in integer minor units (paise) to avoid float errors. Currency = INR.
- Validate all input at the API boundary; never trust the client for `ownerId`
  (derive it from the auth token, not the request body).
- Errors return a consistent shape: `{ "error": { "code": "...", "message": "..." } }`.
- Write tests for: owner-scoping isolation, no-double-occupancy, stay history
  queries by date, and sync push/pull idempotency.

## 9. Definition of done (per feature)

A feature is done when: it works offline-first (local read/write succeeds without
network), it respects owner-scoping, it has the sync metadata fields, the
no-overwrite/no-double-occupancy invariants hold, and there is at least one test
covering the core invariant. See `FEATURES.md` for per-feature acceptance criteria.
