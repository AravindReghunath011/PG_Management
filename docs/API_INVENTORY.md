# API Inventory — Pages → Endpoints

Status key: **Ready** = implemented on server · **Incomplete** = route exists but missing required behavior · **Missing** = not built yet

## Auth

| Page / need | Method | Path | Status |
|-------------|--------|------|--------|
| Login | POST | `/api/auth/login` | Ready |
| Signup | POST | `/api/auth/signup` | Ready |
| Restore session | GET | `/api/auth/me` | Ready |
| Forgot password | POST | `/api/auth/forgot-password` | Missing (defer — no email infra) |

## Dashboard (Home tab)

| Need | Method | Path | Status |
|------|--------|------|--------|
| Stats + recent activity | GET | `/api/dashboard/stats` | Ready |

## Property — Branches

| Page | Method | Path | Status |
|------|--------|------|--------|
| Branches list | GET | `/api/branches` | Ready |
| Branch detail | GET | `/api/branches/:id` | Ready |
| Add branch | POST | `/api/branches` | Ready |
| Edit branch | PUT | `/api/branches/:id` | Ready |
| Delete branch | DELETE | `/api/branches/:id` | Ready (API only; UI optional) |

## Property — Rooms

| Page | Method | Path | Status |
|------|--------|------|--------|
| Rooms list (`?branchId=`) | GET | `/api/rooms` | Ready |
| Room detail | GET | `/api/rooms/:id` | Ready |
| Add room (+ `bedCount`) | POST | `/api/rooms` | Ready |
| Edit room | PUT | `/api/rooms/:id` | Ready |
| Delete room | DELETE | `/api/rooms/:id` | Ready |

## Property — Beds

| Page | Method | Path | Status |
|------|--------|------|--------|
| Beds list (`?roomId=` / `?status=`) | GET | `/api/beds` | Ready |
| Bed detail | GET | `/api/beds/:id` | Ready |
| Add bed | POST | `/api/beds` | Ready |
| Update bed | PUT | `/api/beds/:id` | Ready |
| Delete bed | DELETE | `/api/beds/:id` | Ready |

## Residents

| Page | Method | Path | Status |
|------|--------|------|--------|
| Residents list | GET | `/api/residents` | Ready |
| Resident detail | GET | `/api/residents/:id` | Ready |
| Add resident | POST | `/api/residents` | Ready |
| Edit resident | PUT | `/api/residents/:id` | Ready |
| Delete resident | DELETE | `/api/residents/:id` | Ready |
| KYC image upload | POST | `/api/uploads/kyc` | Ready (persists `kycImageUrl`) |

## Occupancy (Check-in / Checkout)

| Page | Method | Path | Status |
|------|--------|------|--------|
| Vacant beds | GET | `/api/beds?status=vacant` | Ready |
| List stays (`?residentId=` `?active=`) | GET | `/api/stays` | Ready |
| Stay detail | GET | `/api/stays/:id` | Ready |
| Check-in | POST | `/api/stays` | Ready |
| Checkout | PUT | `/api/stays/:id/checkout` | Ready |

## Payments

| Page | Method | Path | Status |
|------|--------|------|--------|
| Payments list (`?status=` `?residentId=` `?stayId=`) | GET | `/api/payments` | Ready |
| Payment detail | GET | `/api/payments/:id` | Ready |
| Generate due | POST | `/api/payments` | Ready |
| Record payment | PUT | `/api/payments/:id` | Ready |

## Search

| Page | Method | Path | Status |
|------|--------|------|--------|
| Search residents (`?q=`) | GET | `/api/search/resident` | Ready |
| Bed history (`?bedId=` `&date=`) | GET | `/api/search/bed-history` | Ready |

## Sync (offline — later)

| Need | Method | Path | Status |
|------|--------|------|--------|
| Pull changes | POST | `/api/sync/pull` | Ready |
| Push changes | POST | `/api/sync/push` | Ready |

## Not in current app screens (defer)

| Need | Notes |
|------|--------|
| Superadmin console APIs | Role exists; no routes mounted |
| Forgot / reset password | Login link only; needs email provider |

---

## Build order (API-first)

1. ~~Core auth + property + residents~~ (done)
2. ~~Stays check-in/checkout + payments + dashboard + search~~ (done)
3. **This pass:** `GET /auth/me`, `GET /beds/:id`, `GET /stays/:id`, `GET /payments/:id`, KYC persist — **done**
4. Then wire Flutter screens to these APIs (separate step — do not mix)
