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
  // However, some legitimate scenarios may not have these headers (curl, etc.)
  // For now, allow requests without origin/referer for backwards compatibility
  // A stricter policy would return false here
  return true;
};

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

import {
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
 * Generate a session token
 */
const generateSessionToken = (): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
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
 * Check if request has valid session
 */
const isAuthenticated = async (request: Request): Promise<boolean> => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (!token) return false;

  const session = await getSession(token);
  if (!session) return false;

  if (session.expires < Date.now()) {
    await deleteSession(token);
    return false;
  }

  return true;
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
  if (!(await isAuthenticated(request))) {
    return htmlResponse(adminLoginPage());
  }
  const events = await getAllEvents();
  return htmlResponse(adminDashboardPage(events));
};

/**
 * Handle POST /admin/login
 */
const handleAdminLogin = async (request: Request): Promise<Response> => {
  const form = await parseFormData(request);
  const validation = validateForm(form, loginFields);

  if (!validation.valid) {
    return htmlResponse(adminLoginPage(validation.error), 400);
  }

  const valid = await verifyAdminPassword(validation.values.password as string);
  if (!valid) {
    return htmlResponse(adminLoginPage("Invalid password"), 401);
  }

  const token = generateSessionToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  await createSession(token, expires);

  return redirect(
    "/admin/",
    `session=${token}; HttpOnly; Path=/; Max-Age=86400`,
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
  return redirect("/admin/", "session=; HttpOnly; Path=/; Max-Age=0");
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = async (request: Request): Promise<Response> => {
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }

  const form = await parseFormData(request);
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
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }

  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }

  return htmlResponse(adminEventEditPage(event));
};

/**
 * Handle POST /admin/event/:id/edit
 */
const handleAdminEventEditPost = async (
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

  const form = await parseFormData(request);
  const validation = validateForm(form, eventFields);

  if (!validation.valid) {
    return htmlResponse(adminEventEditPage(event, validation.error), 400);
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
 * Route admin auth requests (login/logout)
 */
const routeAdminAuth = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (path === "/admin/login" && method === "POST") {
    return handleAdminLogin(request);
  }
  if (path === "/admin/logout" && method === "GET") {
    return handleAdminLogout(request);
  }
  return null;
};

/**
 * Route core admin requests
 */
const routeAdminCore = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (isAdminRoot(path) && method === "GET") {
    return handleAdminGet(request);
  }
  if (path === "/admin/event" && method === "POST") {
    return handleCreateEvent(request);
  }
  return routeAdminAuth(request, path, method);
};

/**
 * Route admin requests
 */
const routeAdmin = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const coreResponse = await routeAdminCore(request, path, method);
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
 */
const handleSetupGet = async (): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }
  return htmlResponse(setupPage());
};

/**
 * Handle POST /setup/
 */
const handleSetupPost = async (request: Request): Promise<Response> => {
  if (await isSetupComplete()) {
    return redirect("/");
  }

  const form = await parseFormData(request);
  const validation = validateSetupForm(form);

  if (!validation.valid) {
    return htmlResponse(setupPage(validation.error), 400);
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
): Promise<Response> => {
  if (path === "/" && method === "GET") {
    return htmlResponse(homePage());
  }

  const adminResponse = await routeAdmin(request, path, method);
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
const handleRequestInternal = async (request: Request): Promise<Response> => {
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

  return routeMainApp(request, path, method);
};

/**
 * Handle incoming requests with security headers and CORS protection
 */
export const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const embeddable = isEmbeddablePath(path);

  // CORS protection: reject cross-origin POST requests
  if (!isValidOrigin(request)) {
    return corsRejectionResponse();
  }

  const response = await handleRequestInternal(request);
  return applySecurityHeaders(response, embeddable);
};
