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
| POST | `/api/residents` | `{ name, phone, email?, kycType, kycRef }` |
| PUT | `/api/residents/:id` | |
| DELETE | `/api/residents/:id` | Soft delete |

`kycType`: `Aadhaar` | `Passport` | `DL` | `Other`

---

## Stays (occupancy)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/stays?residentId=&bedId=&active=` | Enriched with `residentName`, `bedLabel` |
| GET | `/api/stays/:id` | |
| POST | `/api/stays` | Check-in: `{ residentId, bedId, checkInDate, monthlyRent, securityDeposit }` |
| PUT | `/api/stays/:id/checkout` | `{ checkOutDate }` — frees bed |

---

## Payments
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/payments?stayId=&residentId=&status=` | Enriched with `residentName`, `bedLabel`, `totalDue`, `totalPaid` |
| GET | `/api/payments/:id` | |
| POST | `/api/payments` | Generate due: `{ stayId, dueDate, rentDue, electricityDue?, otherDue?, notes? }` |
| PUT | `/api/payments/:id` | Record: `{ rentPaid?, electricityPaid?, otherPaid?, notes? }` |

`status`: `pending` | `partial` | `paid`

---

## Search
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/search/resident?q=` | Name / phone → `{ results: [{ resident, stays }] }` |
| GET | `/api/search/bed-history?bedId=&date=` | Occupancy + payments for bed on ISO date |

---

## Uploads
### `POST /api/uploads/kyc` — multipart
Fields: `file` (jpg/png/pdf ≤5MB), `residentId`  
`200` → `{ kycImageUrl, residentId }` — also persists `kycImageUrl` on the resident.

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
