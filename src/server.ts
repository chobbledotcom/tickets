/**
 * Ticket Reservation System - Bun Server
 */

import { isPaymentsEnabled } from "./lib/config.ts";
import {
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
  verifyAdminPassword,
} from "./lib/db.ts";
import {
  adminDashboardPage,
  adminEventPage,
  adminLoginPage,
  homePage,
  notFoundPage,
  paymentCancelPage,
  paymentErrorPage,
  paymentSuccessPage,
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
  const password = form.get("password") || "";

  const valid = await verifyAdminPassword(password);
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
  const name = form.get("name") || "";
  const description = form.get("description") || "";
  const maxAttendees = Number.parseInt(form.get("max_attendees") || "0", 10);
  const thankYouUrl = form.get("thank_you_url") || "";
  const unitPriceStr = form.get("unit_price");
  const unitPrice =
    unitPriceStr && unitPriceStr.trim() !== ""
      ? Number.parseInt(unitPriceStr, 10)
      : null;

  await createEvent(name, description, maxAttendees, thankYouUrl, unitPrice);
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
const requiresPayment = (event: { unit_price: number | null }): boolean => {
  return (
    isPaymentsEnabled() && event.unit_price !== null && event.unit_price > 0
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
  const name = form.get("name") || "";
  const email = form.get("email") || "";

  if (!name.trim() || !email.trim()) {
    return htmlResponse(ticketPage(event, "Name and email are required"), 400);
  }

  const available = await hasAvailableSpots(eventId);
  if (!available) {
    return htmlResponse(
      ticketPage(event, "Sorry, this event is now full"),
      400,
    );
  }

  const attendee = await createAttendee(eventId, name.trim(), email.trim());

  if (requiresPayment(event)) {
    return handlePaymentFlow(request, event, attendee);
  }

  return redirect(event.thank_you_url);
};

/**
 * Route admin event detail requests
 */
const routeAdminEvent = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
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
 * Handle incoming requests
 */
export const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/" && method === "GET") {
    return htmlResponse(homePage());
  }

  if (path === "/health" && method === "GET") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const adminResponse = await routeAdmin(request, path, method);
  if (adminResponse) return adminResponse;

  const ticketResponse = await routeTicket(request, path, method);
  if (ticketResponse) return ticketResponse;

  const paymentResponse = await routePayment(request, path, method);
  if (paymentResponse) return paymentResponse;

  return htmlResponse(notFoundPage(), 404);
};
