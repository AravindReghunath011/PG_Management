import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { connectDB } from './db/connection';
import { authenticateOwner } from './middleware/auth';
import { authenticateSuperAdmin } from './middleware/superadmin';
import { enforceOwnerBodyScope } from './middleware/ownerScope';
import { globalErrorHandler } from './middleware/errorHandler';
import { kycUpload } from './middleware/upload';

// Controllers
import * as authController from './modules/auth/auth.controller';
import * as branchController from './modules/branches/branch.controller';
import * as roomController from './modules/rooms/room.controller';
import * as bedController from './modules/beds/bed.controller';
import * as residentController from './modules/residents/resident.controller';
import * as stayController from './modules/stays/stay.controller';
import * as paymentController from './modules/payments/payment.controller';
import * as syncController from './modules/sync/sync.controller';
import * as searchController from './modules/search/search.controller';
import * as dashboardController from './modules/dashboard/dashboard.controller';
import * as uploadController from './modules/uploads/upload.controller';
import * as reportsController from './modules/reports/reports.controller';
import * as expenseController from './modules/expenses/expense.controller';
import * as adminController from './modules/admin/admin.controller';

const app = express();
const PORT = process.env.PORT || 5001;

// ── Security & logging middleware ──────────────────────────────────
app.use(helmet());
app.use(cors());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Rate limiting ─────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Boot Database ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  connectDB();
}

// ──────────────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────────────

// Health Check (no rate limit — used by load balancers)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Authentication (Public, tighter rate limit)
app.post('/api/auth/signup', authLimiter, authController.register);
app.post('/api/auth/login', authLimiter, authController.login);

// Apply general rate limiter to all authenticated routes
app.use('/api', apiLimiter);

// Current owner (Protected)
app.get('/api/auth/me', authenticateOwner, authController.me);
app.put('/api/auth/reset-password', authenticateOwner, authController.resetPassword);
app.put('/api/auth/settings', authenticateOwner, authController.updateSettings);

// Dashboard (Protected)
app.get('/api/dashboard/stats', authenticateOwner, dashboardController.getStats);

// Admin (Protected — superadmin only): platform-wide owner list/detail
app.get('/api/admin/owners', authenticateOwner, authenticateSuperAdmin, adminController.getOwners);
app.post('/api/admin/owners', authenticateOwner, authenticateSuperAdmin, adminController.createOwner);
app.get('/api/admin/owners/:id', authenticateOwner, authenticateSuperAdmin, adminController.getOwnerById);

// Reports (Protected)
app.get('/api/reports/joinees', authenticateOwner, reportsController.getJoineesReport);
app.get('/api/reports/collections', authenticateOwner, reportsController.getCollectionsReport);
app.get('/api/reports/finance', authenticateOwner, reportsController.getFinanceReport);
app.get('/api/reports/food-preference', authenticateOwner, reportsController.getFoodPreferenceReport);

// Expenses CRUD (supports ?from= ?to= ?branchId= ?category= filters)
app.get('/api/expenses', authenticateOwner, expenseController.getExpenses);
app.post('/api/expenses', authenticateOwner, enforceOwnerBodyScope, expenseController.createExpense);
app.put('/api/expenses/:id', authenticateOwner, expenseController.updateExpense);
app.delete('/api/expenses/:id', authenticateOwner, expenseController.deleteExpense);

// Sync Routes (Protected & Owner-scoped)
app.post('/api/sync/pull', authenticateOwner, syncController.pullChanges);
app.post('/api/sync/push', authenticateOwner, syncController.pushChanges);

// Search (Protected)
app.get('/api/search/resident', authenticateOwner, searchController.searchResidents);
app.get('/api/search/bed-history', authenticateOwner, searchController.queryBedHistory);

// Branches CRUD (Protected & Scope-forced)
app.get('/api/branches', authenticateOwner, branchController.getBranches);
app.get('/api/branches/:id', authenticateOwner, branchController.getBranchById);
app.post('/api/branches', authenticateOwner, enforceOwnerBodyScope, branchController.createBranch);
app.put('/api/branches/:id', authenticateOwner, branchController.updateBranch);
app.delete('/api/branches/:id', authenticateOwner, branchController.deleteBranch);

// Rooms CRUD
app.get('/api/rooms', authenticateOwner, roomController.getRooms);
app.get('/api/rooms/:id', authenticateOwner, roomController.getRoomById);
app.post('/api/rooms', authenticateOwner, enforceOwnerBodyScope, roomController.createRoom);
app.put('/api/rooms/:id', authenticateOwner, roomController.updateRoom);
app.delete('/api/rooms/:id', authenticateOwner, roomController.deleteRoom);

// Beds CRUD (supports ?roomId= and ?status= filters)
app.get('/api/beds', authenticateOwner, bedController.getBeds);
app.get('/api/beds/:id', authenticateOwner, bedController.getBedById);
app.post('/api/beds', authenticateOwner, enforceOwnerBodyScope, bedController.createBed);
app.put('/api/beds/:id', authenticateOwner, bedController.updateBed);
app.delete('/api/beds/:id', authenticateOwner, bedController.deleteBed);

// Residents CRUD
app.get('/api/residents', authenticateOwner, residentController.getResidents);
app.get('/api/residents/:id', authenticateOwner, residentController.getResidentById);
app.post('/api/residents', authenticateOwner, enforceOwnerBodyScope, residentController.createResident);
app.put('/api/residents/:id', authenticateOwner, residentController.updateResident);
app.delete('/api/residents/:id', authenticateOwner, residentController.deleteResident);

// Occupancy & Stays (supports ?residentId= ?bedId= ?active= filters)
app.get('/api/stays', authenticateOwner, stayController.getStays);
app.get('/api/stays/:id', authenticateOwner, stayController.getStayById);
app.post('/api/stays', authenticateOwner, enforceOwnerBodyScope, stayController.checkInResident);
app.put('/api/stays/:id', authenticateOwner, stayController.updateStay);
app.put('/api/stays/:id/checkout', authenticateOwner, stayController.checkOutResident);

// Rent & Payments (supports ?stayId= ?residentId= ?status= filters)
app.get('/api/payments', authenticateOwner, paymentController.getPayments);
app.get('/api/payments/:id', authenticateOwner, paymentController.getPaymentById);
app.post('/api/payments', authenticateOwner, enforceOwnerBodyScope, paymentController.generateDue);
app.put('/api/payments/:id', authenticateOwner, paymentController.recordPayment);

// KYC Image Upload (Protected, multipart/form-data)
app.post(
  '/api/uploads/kyc',
  authenticateOwner,
  kycUpload.single('file'),
  uploadController.uploadKyc
);

// ── Global error handler (must be last middleware) ─────────────────
app.use(globalErrorHandler);

// ── Start server ──────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`PG Management Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode.`);
  });
}

export default app;
