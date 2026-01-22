/**
 * Ticket Reservation System - Bun Server
 */

import { isPaymentsEnabled, isSetupComplete } from "./lib/config.ts";

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * Get security headers for a response
 * @param embeddable - Whether the page should be embeddable in iframes
 */
export const getSecurityHeaders = (
  embeddable: boolean,
): Record<string, string> => {
  if (embeddable) {
    return {
      ...BASE_SECURITY_HEADERS,
    };
  }
  return {
    ...BASE_SECURITY_HEADERS,
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  };
};

/**
 * Check if a path is embeddable (public ticket pages only)
 */
export const isEmbeddablePath = (path: string): boolean =>
  /^\/ticket\/\d+$/.test(path);

/**
 * Validate origin for CORS protection on POST requests
 * Returns true if the request should be allowed
 */
export const isValidOrigin = (request: Request): boolean => {
  const method = request.method;

  // Only check POST requests
  if (method !== "POST") {
    return true;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // If no origin header, check referer (some browsers may not send origin)
  const requestUrl = new URL(request.url);
  const requestHost = requestUrl.host;

  // If origin is present, it must match
  if (origin) {
    const originUrl = new URL(origin);
    return originUrl.host === requestHost;
  }

  // Fallback to referer check
  if (referer) {
    const refererUrl = new URL(referer);
    return refererUrl.host === requestHost;
  }

  // If neither origin nor referer, reject (could be a direct form submission from another site)
  return false;
};

/**
 * Validate Content-Type for POST requests
 * Returns true if the request is valid (not a POST, or has correct Content-Type)
 */
export const isValidContentType = (request: Request): boolean => {
  if (request.method !== "POST") {
    return true;
  }
  const contentType = request.headers.get("content-type") || "";
  // Accept application/x-www-form-urlencoded (with optional charset)
  return contentType.startsWith("application/x-www-form-urlencoded");
};

/**
 * Create Content-Type rejection response
 */
const contentTypeRejectionResponse = (): Response =>
  new Response("Bad Request: Invalid Content-Type", {
    status: 400,
    headers: {
      "content-type": "text/plain",
      ...getSecurityHeaders(false),
    },
  });

/**
 * Create CORS rejection response
 */
const corsRejectionResponse = (): Response =>
  new Response("Forbidden: Cross-origin requests not allowed", {
    status: 403,
    headers: {
      "content-type": "text/plain",
      ...getSecurityHeaders(false),
    },
  });

/**
 * Apply security headers to a response
 */
const applySecurityHeaders = (
  response: Response,
  embeddable: boolean,
): Response => {
  const headers = new Headers(response.headers);
  const securityHeaders = getSecurityHeaders(embeddable);

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  clearLoginAttempts,
  completeSetup,
  createAttendee,
  createEvent,
  createSession,
  deleteAttendee,
  deleteSession,
  getAllEvents,
  getAttendee,
  getAttendees,
  getEvent,
  getEventWithCount,
  getSession,
  hasAvailableSpots,
  isLoginRateLimited,
  recordFailedLogin,
  updateAdminPassword,
  updateAttendeePayment,
  updateEvent,
  verifyAdminPassword,
} from "./lib/db.ts";
import { validateForm } from "./lib/forms.ts";
import {
  adminDashboardPage,
  adminEventEditPage,
  adminEventPage,
  adminLoginPage,
  adminSettingsPage,
  changePasswordFields,
  eventFields,
  generateAttendeesCsv,
  homePage,
  loginFields,
  notFoundPage,
  paymentCancelPage,
  paymentErrorPage,
  paymentSuccessPage,
  setupCompletePage,
  setupFields,
  setupPage,
  ticketFields,
  ticketPage,
} from "./lib/html.ts";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
} from "./lib/stripe.ts";
import type { Attendee, Event, EventWithCount } from "./lib/types.ts";

/**
 * Server context for accessing connection info
 */
type ServerContext = {
  requestIP?: (req: Request) => { address: string } | null;
};

/**
 * Generate a cryptographically secure token
 */
const generateSecureToken = (): string => {
  return randomBytes(32).toString("base64url");
};

/**
 * Get client IP from request
 * Note: This server runs directly on edge, not behind a proxy,
 * so we use the direct connection IP from the server context.
 * The IP is passed via the server's requestIP() in Bun.serve.
 */
const getClientIp = (
  request: Request,
  server?: { requestIP?: (req: Request) => { address: string } | null },
): string => {
  // Use Bun's server.requestIP() if available
  if (server?.requestIP) {
    const info = server.requestIP(request);
    if (info?.address) {
      return info.address;
    }
  }
  // Fallback for testing or when server context not available
  return "direct";
};

/**
 * Parse cookies from request
 */
const parseCookies = (request: Request): Map<string, string> => {
  const cookies = new Map<string, string>();
  const header = request.headers.get("cookie");
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key && value) {
      cookies.set(key, value);
    }
  }
  return cookies;
};

/**
 * Get authenticated session if valid
 * Returns null if not authenticated
 */
const getAuthenticatedSession = async (
  request: Request,
): Promise<{ token: string; csrfToken: string } | null> => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (session.expires < Date.now()) {
    await deleteSession(token);
    return null;
  }

  return { token, csrfToken: session.csrf_token };
};

/**
 * Check if request has valid session
 */
const isAuthenticated = async (request: Request): Promise<boolean> => {
  return (await getAuthenticatedSession(request)) !== null;
};

/**
 * Validate CSRF token using constant-time comparison
 */
const validateCsrfToken = (expected: string, actual: string): boolean => {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
};

/**
 * Create HTML response
 */
const htmlResponse = (html: string, status = 200): Response =>
  new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * Create redirect response
 */
const redirect = (url: string, cookie?: string): Response => {
  const headers: HeadersInit = { location: url };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { status: 302, headers });
};

/**
 * Parse form data from request
 */
const parseFormData = async (request: Request): Promise<URLSearchParams> => {
  const text = await request.text();
  return new URLSearchParams(text);
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return htmlResponse(adminLoginPage());
  }
  const events = await getAllEvents();
  return htmlResponse(adminDashboardPage(events, session.csrfToken));
};

/**
 * Handle POST /admin/login
 */
const handleAdminLogin = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const clientIp = getClientIp(request, server);

  // Check rate limiting
  if (await isLoginRateLimited(clientIp)) {
    return htmlResponse(
      adminLoginPage("Too many login attempts. Please try again later."),
      429,
    );
  }

  const form = await parseFormData(request);
  const validation = validateForm(form, loginFields);

  if (!validation.valid) {
    return htmlResponse(adminLoginPage(validation.error), 400);
  }

  const valid = await verifyAdminPassword(validation.values.password as string);
  if (!valid) {
    await recordFailedLogin(clientIp);
    return htmlResponse(adminLoginPage("Invalid credentials"), 401);
  }

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  await createSession(token, csrfToken, expires);

  return redirect(
    "/admin/",
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin/; Max-Age=86400`,
  );
};

/**
 * Handle GET /admin/logout
 */
const handleAdminLogout = async (request: Request): Promise<Response> => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (token) {
    await deleteSession(token);
  }
  return redirect(
    "/admin/",
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin/; Max-Age=0",
  );
};

/**
 * Handle GET /admin/settings
 */
const handleAdminSettingsGet = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin/");
  }
  return htmlResponse(adminSettingsPage(session.csrfToken));
};

/**
 * Validate change password form data
 */
type ChangePasswordValidation =
  | { valid: true; currentPassword: string; newPassword: string }
  | { valid: false; error: string };

const validateChangePasswordForm = (
  form: URLSearchParams,
): ChangePasswordValidation => {
  const validation = validateForm(form, changePasswordFields);
  if (!validation.valid) {
    return validation;
  }

  const { values } = validation;
  const currentPassword = values.current_password as string;
  const newPassword = values.new_password as string;
  const newPasswordConfirm = values.new_password_confirm as string;

  if (newPassword.length < 8) {
    return {
      valid: false,
      error: "New password must be at least 8 characters",
    };
  }
  if (newPassword !== newPasswordConfirm) {
    return { valid: false, error: "New passwords do not match" };
  }

  return { valid: true, currentPassword, newPassword };
};

/**
 * Handle POST /admin/settings
 */
const handleAdminSettingsPost = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin/");
  }

  const form = await parseFormData(request);

  // Validate CSRF token
  const csrfToken = form.get("csrf_token") || "";
  if (!validateCsrfToken(session.csrfToken, csrfToken)) {
    return htmlResponse("Invalid CSRF token", 403);
  }

  const validation = validateChangePasswordForm(form);
  if (!validation.valid) {
    return htmlResponse(
      adminSettingsPage(session.csrfToken, validation.error),
      400,
    );
  }

  // Verify current password
  const isCurrentValid = await verifyAdminPassword(validation.currentPassword);
  if (!isCurrentValid) {
    return htmlResponse(
      adminSettingsPage(session.csrfToken, "Current password is incorrect"),
      401,
    );
  }

  // Update password and invalidate all sessions
  await updateAdminPassword(validation.newPassword);

  // Redirect to login with session cleared
  return redirect(
    "/admin/",
    "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin/; Max-Age=0",
  );
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin/");
  }

  const form = await parseFormData(request);

  // Validate CSRF token
  const csrfToken = form.get("csrf_token") || "";
  if (!validateCsrfToken(session.csrfToken, csrfToken)) {
    return htmlResponse("Invalid CSRF token", 403);
  }

  const validation = validateForm(form, eventFields);

  if (!validation.valid) {
    // For create, redirect back to dashboard (form is on that page)
    return redirect("/admin/");
  }

  const { values } = validation;
  await createEvent(
    values.name as string,
    values.description as string,
    values.max_attendees as number,
    values.thank_you_url as string,
    values.unit_price as number | null,
  );
  return redirect("/admin/");
};

/**
 * Handle GET /admin/event/:id
 */
const handleAdminEventGet = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }

  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  const attendees = await getAttendees(eventId);
  return htmlResponse(adminEventPage(event, attendees));
};

/**
 * Handle GET /admin/event/:id/edit
 */
const handleAdminEventEditGet = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin/");
  }

  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  return htmlResponse(adminEventEditPage(event, session.csrfToken));
};

/**
 * Handle POST /admin/event/:id/edit
 */
const handleAdminEventEditPost = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin/");
  }

  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  const form = await parseFormData(request);

  // Validate CSRF token
  const csrfToken = form.get("csrf_token") || "";
  if (!validateCsrfToken(session.csrfToken, csrfToken)) {
    return htmlResponse("Invalid CSRF token", 403);
  }

  const validation = validateForm(form, eventFields);

  if (!validation.valid) {
    return htmlResponse(
      adminEventEditPage(event, session.csrfToken, validation.error),
      400,
    );
  }

  const { values } = validation;
  await updateEvent(
    eventId,
    values.name as string,
    values.description as string,
    values.max_attendees as number,
    values.thank_you_url as string,
    values.unit_price as number | null,
  );

  return redirect(`/admin/event/${eventId}`);
};

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }

  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  const attendees = await getAttendees(eventId);
  const csv = generateAttendeesCsv(attendees);
  const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
};

/**
 * Handle GET /ticket/:id
 */
const handleTicketGet = async (eventId: number): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }
  return htmlResponse(ticketPage(event));
};

/**
 * Check if payment is required for an event
 */
const requiresPayment = async (event: {
  unit_price: number | null;
}): Promise<boolean> => {
  return (
    (await isPaymentsEnabled()) &&
    event.unit_price !== null &&
    event.unit_price > 0
  );
};

/**
 * Get base URL from request
 */
const getBaseUrl = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};

/**
 * Handle payment flow for ticket purchase
 */
const handlePaymentFlow = async (
  request: Request,
  event: EventWithCount,
  attendee: Attendee,
): Promise<Response> => {
  const baseUrl = getBaseUrl(request);
  const session = await createCheckoutSession(event, attendee, baseUrl);

  if (session?.url) {
    return redirect(session.url);
  }

  // If Stripe session creation failed, clean up and show error
  await deleteAttendee(attendee.id);
  return htmlResponse(
    ticketPage(event, "Failed to create payment session. Please try again."),
    500,
  );
};

/**
 * Handle POST /ticket/:id (reserve ticket)
 */
const handleTicketPost = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  const form = await parseFormData(request);
  const validation = validateForm(form, ticketFields);

  if (!validation.valid) {
    return htmlResponse(ticketPage(event, validation.error), 400);
  }

  const available = await hasAvailableSpots(eventId);
  if (!available) {
    return htmlResponse(
      ticketPage(event, "Sorry, this event is now full"),
      400,
    );
  }

  const { values } = validation;
  const attendee = await createAttendee(
    eventId,
    values.name as string,
    values.email as string,
  );

  if (await requiresPayment(event)) {
    return handlePaymentFlow(request, event, attendee);
  }

  return redirect(event.thank_you_url);
};

/**
 * Route admin event edit requests
 */
const routeAdminEventEdit = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const editMatch = path.match(/^\/admin\/event\/(\d+)\/edit$/);
  if (!editMatch?.[1]) return null;

  const eventId = Number.parseInt(editMatch[1], 10);
  if (method === "GET") return handleAdminEventEditGet(request, eventId);
  if (method === "POST") return handleAdminEventEditPost(request, eventId);
  return null;
};

/**
 * Route admin event export requests
 */
const routeAdminEventExport = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const exportMatch = path.match(/^\/admin\/event\/(\d+)\/export$/);
  if (exportMatch?.[1] && method === "GET") {
    return handleAdminEventExport(request, Number.parseInt(exportMatch[1], 10));
  }
  return null;
};

/**
 * Route admin event detail requests
 */
const routeAdminEvent = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const editResponse = await routeAdminEventEdit(request, path, method);
  if (editResponse) return editResponse;

  const exportResponse = await routeAdminEventExport(request, path, method);
  if (exportResponse) return exportResponse;

  const eventMatch = path.match(/^\/admin\/event\/(\d+)$/);
  if (eventMatch?.[1] && method === "GET") {
    return handleAdminEventGet(request, Number.parseInt(eventMatch[1], 10));
  }
  return null;
};

/**
 * Check if path is admin root
 */
const isAdminRoot = (path: string): boolean =>
  path === "/admin/" || path === "/admin";

/**
 * Route admin settings requests
 */
const routeAdminSettings = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (path !== "/admin/settings") return null;
  if (method === "GET") return handleAdminSettingsGet(request);
  if (method === "POST") return handleAdminSettingsPost(request);
  return null;
};

/**
 * Route admin auth requests (login/logout/settings)
 */
const routeAdminAuth = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response | null> => {
  if (path === "/admin/login" && method === "POST") {
    return handleAdminLogin(request, server);
  }
  if (path === "/admin/logout" && method === "GET") {
    return handleAdminLogout(request);
  }
  return routeAdminSettings(request, path, method);
};

/**
 * Route core admin requests
 */
const routeAdminCore = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response | null> => {
  if (isAdminRoot(path) && method === "GET") {
    return handleAdminGet(request);
  }
  if (path === "/admin/event" && method === "POST") {
    return handleCreateEvent(request);
  }
  return routeAdminAuth(request, path, method, server);
};

/**
 * Route admin requests
 */
const routeAdmin = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response | null> => {
  const coreResponse = await routeAdminCore(request, path, method, server);
  if (coreResponse) return coreResponse;

  return routeAdminEvent(request, path, method);
};

/**
 * Route ticket requests
 */
const routeTicket = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const match = path.match(/^\/ticket\/(\d+)$/);
  if (!match?.[1]) return null;

  const eventId = Number.parseInt(match[1], 10);
  if (method === "GET") {
    return handleTicketGet(eventId);
  }
  if (method === "POST") {
    return handleTicketPost(request, eventId);
  }
  return null;
};

type PaymentCallbackData = { attendee: Attendee; event: Event };
type PaymentCallbackResult =
  | { success: true; data: PaymentCallbackData }
  | { success: false; response: Response };

/**
 * Load and validate attendee/event for payment callbacks
 */
const loadPaymentCallbackData = async (
  attendeeIdStr: string | null,
): Promise<PaymentCallbackResult> => {
  if (!attendeeIdStr) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Invalid payment callback"), 400),
    };
  }

  const attendee = await getAttendee(Number.parseInt(attendeeIdStr, 10));
  if (!attendee) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Attendee not found"), 404),
    };
  }

  const event = await getEvent(attendee.event_id);
  if (!event) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Event not found"), 404),
    };
  }

  return { success: true, data: { attendee, event } };
};

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 */
const handlePaymentSuccess = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const attendeeId = url.searchParams.get("attendee_id");
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return htmlResponse(paymentErrorPage("Invalid payment callback"), 400);
  }

  const result = await loadPaymentCallbackData(attendeeId);
  if (!result.success) {
    return result.response;
  }

  const { attendee, event } = result.data;

  // Verify payment with Stripe
  const session = await retrieveCheckoutSession(sessionId);
  if (!session || session.payment_status !== "paid") {
    return htmlResponse(
      paymentErrorPage("Payment verification failed. Please contact support."),
      400,
    );
  }

  // Verify the session belongs to this attendee (prevents IDOR attacks)
  if (session.metadata?.attendee_id !== attendeeId) {
    return htmlResponse(
      paymentErrorPage("Payment session mismatch. Please contact support."),
      400,
    );
  }

  // Check if payment was already recorded (prevents replay attacks)
  if (attendee.stripe_payment_id) {
    // Already paid - just show success page
    return htmlResponse(paymentSuccessPage(event, event.thank_you_url));
  }

  // Update attendee with payment ID
  const paymentId = session.payment_intent as string;
  await updateAttendeePayment(attendee.id, paymentId);

  return htmlResponse(paymentSuccessPage(event, event.thank_you_url));
};

/**
 * Handle GET /payment/cancel (Stripe redirect after cancelled payment)
 */
const handlePaymentCancel = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const attendeeId = url.searchParams.get("attendee_id");

  const result = await loadPaymentCallbackData(attendeeId);
  if (!result.success) {
    return result.response;
  }

  const { attendee, event } = result.data;

  // Delete the unpaid attendee
  await deleteAttendee(attendee.id);

  return htmlResponse(paymentCancelPage(event, `/ticket/${event.id}`));
};

/**
 * Route payment requests
 */
const routePayment = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (method !== "GET") return null;

  if (path === "/payment/success") {
    return handlePaymentSuccess(request);
  }
  if (path === "/payment/cancel") {
    return handlePaymentCancel(request);
  }
  return null;
};

/**
 * Validate setup form data (uses form framework + custom validation)
 */
type SetupValidation =
  | {
      valid: true;
      password: string;
      stripeKey: string | null;
      currency: string;
    }
  | { valid: false; error: string };

const validateSetupForm = (form: URLSearchParams): SetupValidation => {
  const validation = validateForm(form, setupFields);
  if (!validation.valid) {
    return validation;
  }

  const { values } = validation;
  const password = values.admin_password as string;
  const passwordConfirm = values.admin_password_confirm as string;
  const currency = ((values.currency_code as string) || "GBP").toUpperCase();

  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password !== passwordConfirm) {
    return { valid: false, error: "Passwords do not match" };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { valid: false, error: "Currency code must be 3 uppercase letters" };
  }

  return {
    valid: true,
    password,
    stripeKey: (values.stripe_secret_key as string | null) || null,
    currency,
  };
};

/**
 * Handle GET /setup/
 * Uses double-submit cookie pattern for CSRF protection
 */
const handleSetupGet = async (): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }
  const csrfToken = generateSecureToken();
  const response = htmlResponse(setupPage(undefined, csrfToken));
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `setup_csrf=${csrfToken}; HttpOnly; Secure; SameSite=Strict; Path=/setup/; Max-Age=3600`,
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
};

/**
 * Handle POST /setup/
 * Validates CSRF token using double-submit cookie pattern
 */
const handleSetupPost = async (request: Request): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }

  // Validate CSRF token (double-submit cookie pattern)
  const cookies = parseCookies(request);
  const cookieCsrf = cookies.get("setup_csrf") || "";
  const form = await parseFormData(request);
  const formCsrf = form.get("csrf_token") || "";

  if (!cookieCsrf || !formCsrf || !validateCsrfToken(cookieCsrf, formCsrf)) {
    // Generate new token for retry
    const newCsrfToken = generateSecureToken();
    const response = htmlResponse(
      setupPage("Invalid or expired form. Please try again.", newCsrfToken),
      403,
    );
    const headers = new Headers(response.headers);
    headers.set(
      "set-cookie",
      `setup_csrf=${newCsrfToken}; HttpOnly; Secure; SameSite=Strict; Path=/setup/; Max-Age=3600`,
    );
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  const validation = validateSetupForm(form);

  if (!validation.valid) {
    // Keep the same CSRF token for validation errors
    return htmlResponse(setupPage(validation.error, formCsrf), 400);
  }

  await completeSetup(
    validation.password,
    validation.stripeKey,
    validation.currency,
  );
  return htmlResponse(setupCompletePage());
};

/**
 * Check if path is setup route
 */
const isSetupPath = (path: string): boolean =>
  path === "/setup/" || path === "/setup";

/**
 * Route setup requests
 */
const routeSetup = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (!isSetupPath(path)) return null;

  if (method === "GET") {
    return handleSetupGet();
  }
  if (method === "POST") {
    return handleSetupPost(request);
  }
  return null;
};

/**
 * Handle health check request
 */
const handleHealthCheck = (method: string): Response | null => {
  if (method !== "GET") return null;
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json" },
  });
};

/**
 * Route main application requests (after setup is complete)
 */
const routeMainApp = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response> => {
  if (path === "/" && method === "GET") {
    return htmlResponse(homePage());
  }

  const adminResponse = await routeAdmin(request, path, method, server);
  if (adminResponse) return adminResponse;

  const ticketResponse = await routeTicket(request, path, method);
  if (ticketResponse) return ticketResponse;

  const paymentResponse = await routePayment(request, path, method);
  if (paymentResponse) return paymentResponse;

  return htmlResponse(notFoundPage(), 404);
};

/**
 * Handle incoming requests (internal, without security headers)
 */
const handleRequestInternal = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check always available
  if (path === "/health") {
    const healthResponse = handleHealthCheck(method);
    if (healthResponse) return healthResponse;
  }

  // Setup routes
  const setupResponse = await routeSetup(request, path, method);
  if (setupResponse) return setupResponse;

  // Require setup before accessing other routes
  if (!(await isSetupComplete())) {
    return redirect("/setup/");
  }

  return routeMainApp(request, path, method, server);
};

/**
 * Handle incoming requests with security headers and CORS protection
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const embeddable = isEmbeddablePath(path);

  // CORS protection: reject cross-origin POST requests
  if (!isValidOrigin(request)) {
    return corsRejectionResponse();
  }

  // Content-Type validation: reject POST requests without proper Content-Type
  if (!isValidContentType(request)) {
    return contentTypeRejectionResponse();
  }

  const response = await handleRequestInternal(request, server);
  return applySecurityHeaders(response, embeddable);
};
