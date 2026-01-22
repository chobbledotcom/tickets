/**
 * HTML template functions for the ticket reservation system
 *
 * This file re-exports from the templates module for backward compatibility.
 * New code should import directly from #templates.
 */

export {
  adminDashboardPage,
  adminEventEditPage,
  adminEventPage,
  // Admin pages
  adminLoginPage,
  adminSettingsPage,
  baseStyles,
  changePasswordFields,
  // Layout utilities
  escapeHtml,
  eventFields,
  // CSV generation
  generateAttendeesCsv,
  // Public pages
  homePage,
  layout,
  // Form field definitions
  loginFields,
  notFoundPage,
  paymentCancelPage,
  paymentErrorPage,
  // Payment pages
  paymentPage,
  paymentSuccessPage,
  setupCompletePage,
  setupFields,
  // Setup pages
  setupPage,
  ticketFields,
  ticketPage,
} from "#templates";
