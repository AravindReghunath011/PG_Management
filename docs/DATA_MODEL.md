# DATA_MODEL.md — Client & Server Schemas

This document defines the schemas for both the local client database (SQLite via Drift/Isar) and the backend database (MongoDB via Mongoose).

---

## 1. Sync Metadata (Common fields)

All syncable domain entities carry these core fields to enable bidirectional sync:
- `id` (String): Client-generated UUIDv4. Primary key.
- `ownerId` (String): Reference to the authenticated Owner.
- `createdAt` (Timestamp): ISO-8601 UTC timestamp of creation.
- `updatedAt` (Timestamp): ISO-8601 UTC timestamp of last update.
- `deletedAt` (Timestamp, nullable): ISO-8601 UTC timestamp of soft deletion.

---

## 2. Server MongoDB (Mongoose) Schemas

### Owner Collection
```typescript
const OwnerSchema = new Schema({
  _id: { type: String, required: true }, // Same as id
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
```

### Branch Collection
```typescript
const BranchSchema = new Schema({
  _id: { type: String, required: true }, // Client UUID
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  address: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
BranchSchema.index({ ownerId: 1, deletedAt: 1 });
```

### Room Collection
```typescript
const RoomSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },
  branchId: { type: String, required: true, index: true },
  roomNumber: { type: String, required: true },
  floor: { type: Number, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
RoomSchema.index({ ownerId: 1, branchId: 1 });
```

### Bed Collection
```typescript
const BedSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },
  roomId: { type: String, required: true, index: true },
  bedNumber: { type: String, required: true },
  status: { type: String, enum: ['vacant', 'occupied'], default: 'vacant' },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
```

### Resident Collection
```typescript
const ResidentSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, default: null },
  kycType: { type: String, required: true }, // 'Aadhaar' | 'Passport' | 'DL' | 'Other'
  kycRef: { type: String, required: true },
  kycImageUrl: { type: String, default: null }, // URL pointing to S3/Cloud Storage
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
ResidentSchema.index({ ownerId: 1, phone: 1 }, { unique: true });
```

### Stay Collection
```typescript
const StaySchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },
  residentId: { type: String, required: true, index: true },
  bedId: { type: String, required: true, index: true },
  checkInDate: { type: Date, required: true },
  checkOutDate: { type: Date, default: null },
  monthlyRent: { type: Number, required: true }, // In paise
  securityDeposit: { type: Number, required: true }, // In paise
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
```

### Payment Collection (Dues & Drains)
```typescript
const PaymentSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },
  stayId: { type: String, required: true, index: true },
  residentId: { type: String, required: true, index: true },
  dueDate: { type: Date, required: true },
  paidDate: { type: Date, default: null },
  status: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
  
  // Dues breakdown (in paise)
  rentDue: { type: Number, required: true },
  rentPaid: { type: Number, default: 0 },
  
  electricityDue: { type: Number, default: 0 },
  electricityPaid: { type: Number, default: 0 },
  
  otherDue: { type: Number, default: 0 },
  otherPaid: { type: Number, default: 0 },
  
  notes: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: { type: Date, default: null }
});
```

---

## 3. Client Local DB (Drift SQLite) Schemas

Drift tables mirror the MongoDB structures in terms of domain columns, supplemented with local-only helper tables for sync and file tracking.

### Local SQLite Custom Tables

#### Outbox Table (`outbox_items`)
Stores operations performed while offline. Once connected, these are serialized and pushed to `/api/sync/push`.
- `id` (Integer, Primary Key, Auto-increment)
- `entityType` (Text) — 'branch' | 'room' | 'bed' | 'resident' | 'stay' | 'payment'
- `entityId` (Text) — UUID of the target record
- `action` (Text) — 'create' | 'update' | 'delete'
- `payload` (Text) — JSON representation of the entity state
- `createdAt` (DateTime)

#### Pending Files Table (`pending_uploads`)
Tracks local KYC image paths that need to be uploaded to cloud storage before their URL references can be synced.
- `id` (Integer, Primary Key, Auto-increment)
- `localPath` (Text) — Device storage absolute path
- `residentId` (Text) — Reference to target resident
- `createdAt` (DateTime)
