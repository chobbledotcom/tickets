/**
 * Templates module - main exports
 */

// Admin pages
export {
  adminDashboardPage,
  adminEventEditPage,
  adminEventPage,
  adminLoginPage,
  adminSettingsPage,
} from "./admin.ts";
// CSV generation
export { generateAttendeesCsv } from "./csv.ts";
// Form field definitions
export {
  changePasswordFields,
  eventFields,
  loginFields,
  setupFields,
  ticketFields,
} from "./fields.ts";
// Layout utilities
export { baseStyles, escapeHtml, layout } from "./layout.ts";
// Payment pages
export {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "./payment.ts";
// Public pages
export { homePage, notFoundPage, ticketPage } from "./public.ts";

// Setup pages
export { setupCompletePage, setupPage } from "./setup.ts";
