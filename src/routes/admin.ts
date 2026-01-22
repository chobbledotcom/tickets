/**
 * Admin routes - dashboard, events, settings, authentication
 */

import {
  clearLoginAttempts,
  createEvent,
  createSession,
  deleteSession,
  getAllEvents,
  getAttendees,
  getEventWithCount,
  isLoginRateLimited,
  recordFailedLogin,
  updateAdminPassword,
  updateEvent,
  verifyAdminPassword,
} from "#lib/db.ts";
import { validateForm } from "#lib/forms.ts";
import {
  adminDashboardPage,
  adminEventEditPage,
  adminEventPage,
  adminLoginPage,
  adminSettingsPage,
  changePasswordFields,
  eventFields,
  generateAttendeesCsv,
  loginFields,
  notFoundPage,
} from "#templates";
import type { ServerContext } from "./types.ts";
import {
  generateSecureToken,
  getAuthenticatedSession,
  getClientIp,
  htmlResponse,
  isAuthenticated,
  parseFormData,
  redirect,
  validateCsrfToken,
} from "./utils.ts";

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
  const session = await getAuthenticatedSession(request);
  if (session) {
    await deleteSession(session.token);
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
export const routeAdmin = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response | null> => {
  const coreResponse = await routeAdminCore(request, path, method, server);
  if (coreResponse) return coreResponse;

  return routeAdminEvent(request, path, method);
};
