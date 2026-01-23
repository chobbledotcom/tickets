/**
 * Database module for ticket reservation system
 * Uses libsql for SQLite-compatible storage
 */

// Attendees
export {
  createAttendee,
  deleteAttendee,
  getAttendee,
  getAttendees,
  hasAvailableSpots,
  updateAttendeePayment,
} from "./attendees.ts";
// Client
export { getDb, setDb } from "./client.ts";
export type { EventInput } from "./events.ts";

// Events
export {
  deleteEvent,
  eventsTable,
  getAllEvents,
  getEvent,
  getEventWithCount,
  updateEvent,
} from "./events.ts";
// Login attempts
export {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "./login-attempts.ts";
// Migrations
export { initDb } from "./migrations/index.ts";

// Sessions
export {
  createSession,
  deleteAllSessions,
  deleteOtherSessions,
  deleteSession,
  getAllSessions,
  getSession,
} from "./sessions.ts";
// Settings
export {
  CONFIG_KEYS,
  completeSetup,
  getAdminPasswordFromDb,
  getCurrencyCodeFromDb,
  getSetting,
  getStripeSecretKeyFromDb,
  hasStripeKey,
  isSetupComplete,
  setSetting,
  updateAdminPassword,
  updateStripeKey,
  verifyAdminPassword,
} from "./settings.ts";
