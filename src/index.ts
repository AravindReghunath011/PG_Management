import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { connectDB } from './db/connection';
import { backfillResidentIsDeleted } from './modules/residents/resident.model';
import { authenticateOwner, authenticateOwnerAllowPending } from './middleware/auth';
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
import { getResidentChanges } from './modules/changeLog/changeLog';
import * as stayController from './modules/stays/stay.controller';
import { reviseRents } from './modules/stays/rentRevision';
import * as paymentController from './modules/payments/payment.controller';
import * as syncController from './modules/sync/sync.controller';
import * as searchController from './modules/search/search.controller';
import * as dashboardController from './modules/dashboard/dashboard.controller';
import * as uploadController from './modules/uploads/upload.controller';
import * as reportsController from './modules/reports/reports.controller';
import * as expenseController from './modules/expenses/expense.controller';
import * as adminController from './modules/admin/admin.controller';
import * as notificationsController from './modules/notifications/notifications.controller';
import * as dailyStayController from './modules/dailyStays/dailyStay.controller';
import * as pushController from './modules/push/push.controller';
import { startPushScheduler } from './modules/push/pushAlerts';
import * as inviteController from './modules/invites/invite.controller';
import { serveJoinPage } from './modules/invites/joinPage';
import * as joinRequestController from './modules/joinRequests/joinRequest.controller';
import { serveApplyPage } from './modules/joinRequests/applyPage';

const app = express();
const PORT = process.env.PORT || 5001;
// Behind Render's proxy: use the real client IP for rate limits and https for
// the self check-in links we hand out.
app.set('trust proxy', 1);

// ── Security & logging middleware ──────────────────────────────────
app.use(helmet());
app.use(cors());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Rate limiting ─────────────────────────────────────────────────
// Counters are per-process and per-IP, so under test every suite shares one
// budget and a suite that logs in more than `max` times starts getting 429s
// that have nothing to do with what it is asserting. Skipped in test for the
// same reason morgan and connectDB are.
const skipInTest = () => process.env.NODE_ENV === 'test';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } },
});

// Self check-in links are public (the token is the credential), so they get
// their own tight per-IP budget.
const publicInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Boot Database ─────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  connectDB().then(() => backfillResidentIsDeleted()).catch((err) => console.error('isDeleted backfill failed:', err));
  // Push alerts need the DB; the first sweep's queries buffer until it connects.
  startPushScheduler();
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

// Self check-in (Public): the page a new Resident opens, and its API
app.get('/join/:token', publicInviteLimiter, serveJoinPage);
app.get('/api/public/invites/:token', publicInviteLimiter, inviteController.getPublicInvite);
app.post(
  '/api/public/invites/:token',
  publicInviteLimiter,
  kycUpload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'kycFront', maxCount: 1 },
    { name: 'kycBack', maxCount: 1 },
  ]),
  inviteController.submitPublicInvite
);

// Apply links (Public, reusable): pick a bed and send a request the owner approves
app.get('/apply/:token', publicInviteLimiter, serveApplyPage);
app.get('/api/public/join-links/:token', publicInviteLimiter, joinRequestController.getPublicJoinLink);
app.post(
  '/api/public/join-links/:token',
  publicInviteLimiter,
  kycUpload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'kycFront', maxCount: 1 },
    { name: 'kycBack', maxCount: 1 },
  ]),
  joinRequestController.submitJoinRequest
);

// Apply general rate limiter to all authenticated routes
app.use('/api', apiLimiter);

// Current owner (Protected)
app.get('/api/auth/me', authenticateOwnerAllowPending, authController.me);
app.put('/api/auth/reset-password', authenticateOwner, authController.resetPassword);
app.put('/api/auth/settings', authenticateOwner, authController.updateSettings);
app.put('/api/auth/profile', authenticateOwner, authController.updateProfile);
app.delete('/api/auth/account', authenticateOwner, authController.deleteAccount);

// Dashboard (Protected)
app.get('/api/dashboard/stats', authenticateOwner, dashboardController.getStats);
app.get('/api/dashboard/overview', authenticateOwner, dashboardController.getOverview);

// Self check-in links (Protected): the owner creates, lists and cancels them
app.get('/api/invites', authenticateOwner, inviteController.getInvites);
app.post('/api/invites', authenticateOwner, enforceOwnerBodyScope, inviteController.createInvite);
app.delete('/api/invites/:id', authenticateOwner, inviteController.revokeInvite);

// Apply links and the requests they collect (Protected)
app.get('/api/join-links', authenticateOwner, joinRequestController.getJoinLinks);
app.post('/api/join-links', authenticateOwner, enforceOwnerBodyScope, joinRequestController.createJoinLink);
app.delete('/api/join-links/:id', authenticateOwner, joinRequestController.disableJoinLink);
app.get('/api/join-requests', authenticateOwner, joinRequestController.getJoinRequests);
app.post('/api/join-requests/:id/approve', authenticateOwner, joinRequestController.approveJoinRequest);
app.post('/api/join-requests/:id/reject', authenticateOwner, joinRequestController.rejectJoinRequest);

// Notifications (Protected): derived from the owner's data on every read
// Daily tenants (Protected): short stays paid by the day
app.get('/api/daily-stays', authenticateOwner, dailyStayController.listDailyStays);
app.post('/api/daily-stays', authenticateOwner, enforceOwnerBodyScope, dailyStayController.checkInDailyStay);
app.put('/api/daily-stays/:id', authenticateOwner, dailyStayController.updateDailyStay);
app.post('/api/daily-stays/:id/check-out', authenticateOwner, dailyStayController.checkOutDailyStay);
app.delete('/api/daily-stays/:id', authenticateOwner, dailyStayController.deleteDailyStay);

app.get('/api/notifications', authenticateOwner, notificationsController.getNotifications);
app.put('/api/notifications/seen', authenticateOwner, notificationsController.markNotificationsSeen);

// Push notifications (Protected): the phones that receive this owner's alerts
app.post('/api/push/tokens', authenticateOwner, pushController.registerPushToken);
app.delete('/api/push/tokens', authenticateOwner, pushController.unregisterPushToken);

// Admin (Protected — superadmin only): platform-wide owner list/detail
app.get('/api/admin/owners', authenticateOwner, authenticateSuperAdmin, adminController.getOwners);
app.post('/api/admin/owners', authenticateOwner, authenticateSuperAdmin, adminController.createOwner);
app.get('/api/admin/owners/:id', authenticateOwner, authenticateSuperAdmin, adminController.getOwnerById);
app.put('/api/admin/owners/:id', authenticateOwner, authenticateSuperAdmin, adminController.updateOwner);
app.post('/api/admin/owners/:id/reset-password', authenticateOwner, authenticateSuperAdmin, adminController.resetOwnerPassword);

// Reports (Protected)
app.get('/api/reports/joinees', authenticateOwner, reportsController.getJoineesReport);
app.get('/api/reports/collections', authenticateOwner, reportsController.getCollectionsReport);
app.get('/api/reports/collection-summary', authenticateOwner, reportsController.getCollectionSummaryReport);
app.get('/api/reports/finance', authenticateOwner, reportsController.getFinanceReport);
app.get('/api/reports/profit-loss', authenticateOwner, reportsController.getProfitLossReport);
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
// Before /:id so "moved-out" isn't read as an id.
app.get('/api/residents/moved-out', authenticateOwner, searchController.listMovedOut);
app.get('/api/residents/:id', authenticateOwner, residentController.getResidentById);
app.get('/api/residents/:id/history', authenticateOwner, residentController.getResidentHistory);
app.get('/api/residents/:id/changes', authenticateOwner, getResidentChanges);
app.post('/api/residents', authenticateOwner, enforceOwnerBodyScope, residentController.createResident);
app.put('/api/residents/:id', authenticateOwner, residentController.updateResident);
app.delete('/api/residents/:id', authenticateOwner, residentController.deleteResident);

// Occupancy & Stays (supports ?residentId= ?bedId= ?active= filters)
app.get('/api/stays', authenticateOwner, stayController.getStays);
app.get('/api/stays/:id', authenticateOwner, stayController.getStayById);
app.post('/api/stays', authenticateOwner, enforceOwnerBodyScope, stayController.checkInResident);
// Raise every current tenant's rent at once (preview first)
app.post('/api/stays/rent-revision', authenticateOwner, reviseRents);
app.put('/api/stays/:id', authenticateOwner, stayController.updateStay);
app.get('/api/stays/:id/settlement-preview', authenticateOwner, stayController.getSettlementPreview);
app.put('/api/stays/:id/checkout', authenticateOwner, stayController.checkOutResident);
app.put('/api/stays/:id/move', authenticateOwner, stayController.moveStay);
app.put('/api/stays/:id/notice', authenticateOwner, stayController.giveNotice);
app.delete('/api/stays/:id/notice', authenticateOwner, stayController.cancelNotice);

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
