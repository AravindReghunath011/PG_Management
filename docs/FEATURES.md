# FEATURES.md — Feature Specifications & Acceptance Criteria

This document details the functional specifications and acceptance criteria (AC) for the Paying Guest (PG) Management Platform.

---

## 1. Owner Authentication (`AUTH-*`)

### AUTH-1: Owner Signup & Login
* **Description**: As a PG operator (Owner), I want to create an account and log in securely so that I can manage my PG data in isolation.
* **Rules**:
  - Registration requires: `email`, `password` (min 8 chars), `name`.
  - Credentials verified on Node API; returns JWT token on success.
  - Multi-tenant boundary: Every subsequent request must carry `Authorization: Bearer <token>`.
  - Passwords hashed using bcrypt.

---

## 2. Property Structure (`PROP-*`)

### PROP-1: Branch Management
* **Description**: Manage physical locations (Branches) of the PG.
* **Rules**:
  - Fields: `name`, `address`.
  - A Branch belongs to exactly one `ownerId`.
  - Soft delete: Deleting a branch sets `deletedAt`.

### PROP-2: Room Management
* **Description**: Manage rooms within a specific branch.
* **Rules**:
  - Fields: `roomNumber` (string, e.g. "301-A"), `floor` (integer).
  - Scope: A Room is always child to a Branch and is owned by `ownerId`.

### PROP-3: Bed Management
* **Description**: Manage beds inside a room.
* **Rules**:
  - Fields: `bedNumber` (string/number, e.g., "Bed-1").
  - **Invariants**:
    - A Bed carries status (e.g., `vacant` vs `occupied`).
    - **Never** store resident identity (name, phone, stay details) directly on the Bed schema. Identity is resolved dynamically through active Stays.

---

## 3. Resident Registry (`RES-*`)

### RES-1: Resident Registration
* **Description**: Register a new resident who will occupy a bed.
* **Rules**:
  - Fields: `name`, `phone` (unique per owner), `email` (optional), `kycType` (e.g., Aadhaar, Passport, DL), `kycRef` (ID number), `kycImageUrl` (ref to uploaded image).
  - A resident's profile can exist without an active stay.
  - Resident profiles are scoped to the `ownerId` and support soft-delete (`deletedAt`).

---

## 4. Occupancy & Stays (`OCC-*`)

### OCC-1: Assign Bed to Resident (Check-in)
* **Description**: Book a bed for a resident by creating a `Stay` record.
* **Rules**:
  - Fields: `residentId`, `bedId`, `checkInDate`, `checkOutDate` (nullable), `monthlyRent`, `securityDeposit`.
  - **Core Invariant**:
    - **NO DOUBLE OCCUPANCY**: You cannot have two open (un-checked-out) stays on the same bed at the same time. Before starting a stay, verify there are no active stays (`checkOutDate IS NULL`) on `bedId`.
    - **NO OVERWRITING OCCUPANCY**: To move a resident out, update their stay's `checkOutDate`. Never delete or overwrite the stay.

### OCC-2: Checkout Resident
* **Description**: Record that a resident has vacated a bed.
* **Rules**:
  - Set `checkOutDate` of the active `Stay` to the checkout date (ISO-8601 string).
  - Set Bed status to `vacant`.

---

## 5. Rent & Dues (`RENT-*`)

### RENT-1: Generate Monthly Rent Dues
* **Description**: Record and track line-item dues and payments for a resident.
* **Rules**:
  - Fields: `stayId`, `residentId`, `dueDate`, `paidDate` (nullable), `status` (`pending`, `paid`, `partial`).
  - **Line-Item Invariant**: Dues and payments **MUST** be recorded as separate, individual columns/fields for:
    - `rent`: Base monthly accommodation fee.
    - `electricity`: Utilities meter/fixed fee.
    - `other`: Maintenance/mess/deposits.
  - Amounts stored as **integers in minor units (paise)** to avoid floating-point errors (e.g., ₹1000.50 -> 100050 paise).

### RENT-2: Record Payments
* **Description**: Record payment against an outstanding due.
* **Rules**:
  - Increment paid balances (`rentPaid`, `electricityPaid`, `otherPaid`).
  - Update `status` to `paid` once all due amounts are fully matched, or `partial` if partially matched.

---

## 6. Historical Retrieval & Search (`SRCH-*`)

### SRCH-1: Bed Occupancy History
* **Description**: Query who stayed in Bed X on Date Y and their rent payment status.
* **Rules**:
  - Given `bedId` and `date`, find the `Stay` where `checkInDate <= date` AND (`checkOutDate >= date` OR `checkOutDate IS NULL`).
  - Fetch corresponding `Resident` details and `Payment` records matching the stay.

### SRCH-2: Global Unified Search
* **Description**: High-speed, offline-first search bar that filters residents by name or phone, showing their current bed, stay history, and active rent dues.
* **Rules**:
  - Must execute instantly on local Drift DB.

---

## 7. Offline Sync (`SYNC-*`)

### SYNC-1: Local Outbox Queueing
* **Description**: Maintain an offline-first experience by writing all writes to a local outbox.
* **Rules**:
  - Every write updates local SQLite/Drift tables immediately and pushes an action record into `OutboxItem` table.
  - The UI does not await network; it displays changes instantly.

### SYNC-2: Bidirectional Sync (Pull/Push)
* **Description**: Automatically synchronize with Node API once network connectivity is restored.
* **Rules**:
  - **Push**: The client serializes all outstanding outbox operations and sends them to `/api/sync/push`.
  - **Pull**: The client queries `/api/sync/pull?since=<lastSyncTimestamp>` to fetch changes from other devices or operators.
  - **Conflict Resolution**: Last-write-wins (LWW) using the `updatedAt` field.
