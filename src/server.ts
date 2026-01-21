/**
 * Ticket Reservation System - Bun Server
 */

import {
  createAttendee,
  createEvent,
  getAllEvents,
  getAttendees,
  getEventWithCount,
  hasAvailableSpots,
  verifyAdminPassword,
} from "./lib/db.ts";
import { log } from "./lib/log.ts";
import {
  adminDashboardPage,
  adminEventPage,
  adminLoginPage,
  homePage,
  notFoundPage,
  ticketPage,
} from "./lib/html.ts";

export const sessions = new Map<string, { expires: number }>();

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
const isAuthenticated = (request: Request): boolean => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (!token) return false;

  const session = sessions.get(token);
  if (!session) return false;

  if (session.expires < Date.now()) {
    sessions.delete(token);
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
  const headers = new Headers();
  headers.set("Location", url);
  if (cookie) {
    headers.set("Set-Cookie", cookie);
    log("redirect: setting cookie", { url, cookieLength: cookie.length });
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
  if (!isAuthenticated(request)) {
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
  sessions.set(token, { expires });

  return redirect(
    "/admin/",
    `session=${token}; HttpOnly; Path=/; Max-Age=86400`,
  );
};

/**
 * Handle GET /admin/logout
 */
const handleAdminLogout = (request: Request): Response => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (token) {
    sessions.delete(token);
  }
  return redirect("/admin/", "session=; HttpOnly; Path=/; Max-Age=0");
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = async (request: Request): Promise<Response> => {
  if (!isAuthenticated(request)) {
    return redirect("/admin/");
  }

  const form = await parseFormData(request);
  const name = form.get("name") || "";
  const description = form.get("description") || "";
  const maxAttendees = Number.parseInt(form.get("max_attendees") || "0", 10);
  const thankYouUrl = form.get("thank_you_url") || "";

  await createEvent(name, description, maxAttendees, thankYouUrl);
  return redirect("/admin/");
};

/**
 * Handle GET /admin/event/:id
 */
const handleAdminEventGet = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  if (!isAuthenticated(request)) {
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

  await createAttendee(eventId, name.trim(), email.trim());
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

  return htmlResponse(notFoundPage(), 404);
};
