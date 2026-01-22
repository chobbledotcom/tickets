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
} from "./admin.tsx";
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
export { baseStyles, escapeHtml, Layout, layout } from "./layout.tsx";
// Payment pages
export {
  paymentCancelPage,
  paymentErrorPage,
  paymentPage,
  paymentSuccessPage,
} from "./payment.tsx";
// Public pages
export { homePage, notFoundPage, ticketPage } from "./public.tsx";

// Setup pages
export { setupCompletePage, setupPage } from "./setup.tsx";
