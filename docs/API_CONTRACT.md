# API_CONTRACT.md — REST API Contract

All request/response bodies are JSON unless noted. Auth required except where marked **Public**.

## Headers & Auth
- `Authorization: Bearer <JWT>`
- Token validity: 7 days
- JWT payload: `{ id, email, role }` (`owner` | `superadmin`)

## Error format
```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Detailed explanation."
  }
}
```

Amounts for rent/deposit/dues are integers in **paise** (₹1 = 100).

---

## Auth

### `POST /api/auth/signup` — Public
```json
{ "name": "Jane Doe", "email": "jane@example.com", "password": "strongPassword123" }
```
`201` → `{ token, owner: { id, name, email, role } }`

### `POST /api/auth/login` — Public
```json
{ "email": "jane@example.com", "password": "strongPassword123" }
```
`200` → `{ token, owner: { id, name, email, role } }`

### `GET /api/auth/me` — Protected
`200` → `{ owner: { id, name, email, role } }`

---

## Profile
### `PUT /api/auth/profile`
The signed-in owner's own name: `{ name }` (1–60 chars, whitespace collapsed).
`200` → `{ owner }` (same shape as `/api/auth/me`). The email can't be changed
here — it is the login (admins can change it).

---

## Dashboard

### `GET /api/dashboard/stats`
`200` →
```json
{
  "stats": {
    "totalBranches": 0,
    "totalRooms": 0,
    "totalBeds": 0,
    "occupiedBeds": 0,
    "vacantBeds": 0,
    "occupancyRate": 0,
    "totalResidents": 0,
    "pendingDuesTotal": 0,
    "pendingDuesCount": 0
  },
  "recentActivity": [
    {
      "type": "checkin|checkout|payment",
      "residentName": "…",
      "timestamp": "…"
    }
  ]
}
```

### `GET /api/dashboard/overview`
Everything the home dashboard renders, in one request. Query: `from`, `to`
(ISO, default = current calendar month UTC), `limit` (rows per rent list,
default 5, max 100). Money in paise. `revenue.previousCollected` covers the
equally long window just before `from`. `leavingSoon` = stays with a
`checkOutDate` in the next 30 days.

`200` →
```json
{
  "period": { "from": "…", "to": "…" },
  "owner": { "name": "…", "displayName": "first branch name, else owner name", "isActive": true },
  "revenue": { "collected": 0, "target": 0, "pending": 0, "expenses": 0, "previousCollected": 0 },
  "stats": { "totalRooms": 0, "totalBeds": 0, "vacantBeds": 0, "unpaidCount": 0, "leavingSoon": 0 },
  "rentStatus": {
    "paidCount": 0,
    "unpaidCount": 0,
    "paid": [],
    "unpaid": [
      {
        "residentId": "…", "stayId": "…", "name": "…", "phone": "…",
        "roomNumber": "102", "bedNumber": "B",
        "totalDue": 0, "totalPaid": 0, "balance": 0,
        "dueDate": "…", "daysOverdue": 5
      }
    ]
  },
  "generatedAt": "…"
}
```

---

## Branches
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/branches` | Includes `roomCount`, `totalBeds`, `occupiedBeds` |
| GET | `/api/branches/:id` | |
| POST | `/api/branches` | `{ name, address }` |
| PUT | `/api/branches/:id` | |
| DELETE | `/api/branches/:id` | Soft delete |

---

## Rooms
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/rooms?branchId=` | |
| GET | `/api/rooms/:id` | |
| POST | `/api/rooms` | `{ branchId, roomNumber, floor?, bedCount? }` — `bedCount` auto-creates beds |
| PUT | `/api/rooms/:id` | |
| DELETE | `/api/rooms/:id` | Soft delete |

---

## Beds
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/beds?roomId=&status=` | Enriched with occupancy / resident |
| GET | `/api/beds/:id` | |
| POST | `/api/beds` | `{ roomId, bedNumber }` |
| PUT | `/api/beds/:id` | |
| DELETE | `/api/beds/:id` | Soft delete; blocked if occupied |

---

## Residents
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/residents` | Includes current bed / branch labels |
| GET | `/api/residents/:id` | |
| POST | `/api/residents` | `{ name, phone, email?, kycType, kycRef, guardianName?, guardianPhone?, guardianRelation? }` |
| PUT | `/api/residents/:id` | Any of the create fields; `""`/`null` clears a guardian field |
| DELETE | `/api/residents/:id` | Soft delete |

`kycType`: `Aadhaar` | `Passport` | `DL` | `Other`

Responses also carry `kycImageUrl` (ID front), `kycBackImageUrl`, `photoUrl`
(set via `POST /api/uploads/kyc`) and the three `guardian*` fields.
`guardianPhone` must be 10 digits when present.

---

## Stays (occupancy)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/stays?residentId=&bedId=&active=` | Enriched with `residentName`, `bedLabel` |
| GET | `/api/stays/:id` | |
| POST | `/api/stays` | Check-in: `{ residentId, bedId, checkInDate, monthlyRent, securityDeposit }` |
| PUT | `/api/stays/:id/checkout` | `{ checkOutDate }` — frees bed |
| PUT | `/api/stays/:id/notice` | `{ moveOutDate }` — notice period; bed stays occupied until checkout |
| DELETE | `/api/stays/:id/notice` | Withdraw the notice |

Stay responses include `noticeMoveOutDate` (null when not on notice).

---

## Payments
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/payments?stayId=&residentId=&status=` | Enriched with `residentName`, `bedLabel`, `totalDue`, `totalPaid` |
| GET | `/api/payments/:id` | |
| POST | `/api/payments` | Generate due: `{ stayId, dueDate, rentDue, electricityDue?, otherDue?, notes? }` |
| PUT | `/api/payments/:id` | Record: `{ rentPaid?, electricityPaid?, otherPaid?, notes? }` |

`status`: `pending` | `partial` | `paid`

**Automatic monthly rent dues.** Every open stay gets one rent due per month
(`rentDue` = the stay's `monthlyRent`, `dueDate` = that month on the check-in
day at local noon, `dueMonth` = `"YYYY-MM"`). They're created when needed — on
check-in (current month), `GET /api/payments` (current month), and
`GET /api/dashboard/overview` / `GET /api/reports/collection-summary` (the
requested months, never future ones). A stay that already has a due dated in a
month isn't given another. `POST /api/payments` for a month whose automatic due
has nothing paid on it updates that due instead of adding a second one.
Checkout and notice soft-delete untouched automatic dues dated on/after the
move-out date; cancelling a notice restores them. Months use local business
time (`BUSINESS_UTC_OFFSET_MINUTES`, default 330 = IST).

---

## Search
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/search/resident?q=` | Name / phone → `{ results: [{ resident, stays }] }` |
| GET | `/api/search/bed-history?bedId=&date=` | Occupancy + payments for bed on ISO date |

---

## Uploads
### `POST /api/uploads/kyc` — multipart
Fields: `file` (jpg/png/pdf ≤5MB), `residentId`, `kind?`  
`kind`: `kyc_front` (default → `kycImageUrl`) | `kyc_back` (→ `kycBackImageUrl`) | `photo` (jpg/png only → `photoUrl`)  
`200` → `{ kind, url, kycImageUrl, residentId }` — persists `url` on the resident's field for that kind.

Static files: `GET /uploads/*`

---

## Sync
### `POST /api/sync/pull`
```json
{ "lastPulledAt": "2026-05-30T10:00:00.000Z" }
```

### `POST /api/sync/push`
```json
{
  "actions": [
    {
      "id": 12,
      "action": "create|update|delete",
      "entityType": "branch|room|bed|resident|stay|payment",
      "entityId": "uuid",
      "payload": {}
    }
  ]
}
```
LWW via `updatedAt`.

---

## Health
### `GET /health` — Public
`{ "status": "ok", "timestamp": "…" }`

See also: [API_INVENTORY.md](./API_INVENTORY.md) for page → API mapping.
