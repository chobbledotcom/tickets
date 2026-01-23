/**
 * Admin routes - dashboard, events, settings, authentication
 */

import {
  clearLoginAttempts,
  createSession,
  deleteEvent,
  deleteSession,
  type EventInput,
  eventsTable,
  getAllEvents,
  getAttendees,
  getEventWithCount,
  hasStripeKey,
  isLoginRateLimited,
  recordFailedLogin,
  updateAdminPassword,
  updateStripeKey,
  verifyAdminPassword,
} from "#lib/db";
import { validateForm } from "#lib/forms.tsx";
import {
  createHandler,
  defineResource,
  deleteHandler,
  updateHandler,
} from "#lib/rest";
import type { EventWithCount } from "#lib/types.ts";
import {
  adminDashboardPage,
  adminDeleteEventPage,
  adminEventEditPage,
  adminEventPage,
  adminLoginPage,
  adminSettingsPage,
  changePasswordFields,
  eventFields,
  generateAttendeesCsv,
  loginFields,
  notFoundPage,
  stripeKeyFields,
} from "#templates";
import type { ServerContext } from "./types.ts";
import {
  type AuthSession,
  chainRoutes,
  createIdRoute,
  generateSecureToken,
  getClientIp,
  htmlResponse,
  isAuthenticated,
  matchRoute,
  parseFormData,
  type RouteHandler,
  type RouteHandlerWithServer,
  redirect,
  requireAuthForm,
  requireSessionOr,
  withAuthForm,
  withEvent,
  withSession,
} from "./utils.ts";

/** Form field definition type */
type FormFields = Parameters<typeof validateForm>[1];

/** Result of form validation with typed values */
type ValidatedForm = ReturnType<typeof validateForm> & { valid: true };

/** Auth + form + validation result */
type AuthValidationResult =
  | { ok: true; session: AuthSession; validation: ValidatedForm }
  | { ok: false; response: Response };

/** Require auth + form + validation, with custom error handler */
const requireAuthValidation = async (
  request: Request,
  fields: FormFields,
  onError?: (
    session: AuthSession,
    form: URLSearchParams,
    error: string,
  ) => Response | Promise<Response>,
): Promise<AuthValidationResult> => {
  const auth = await requireAuthForm(request);
  if (!auth.ok) return auth;

  const validation = validateForm(auth.form, fields);
  if (!validation.valid) {
    const errorResponse = onError
      ? await onError(auth.session, auth.form, validation.error)
      : redirect("/admin/");
    return { ok: false, response: errorResponse };
  }

  return { ok: true, session: auth.session, validation };
};

/** Extract event input from validated form */
const extractEventInput = (values: Record<string, unknown>): EventInput => ({
  name: values.name as string,
  description: values.description as string,
  maxAttendees: values.max_attendees as number,
  thankYouUrl: values.thank_you_url as string,
  unitPrice: values.unit_price as number | null,
  maxQuantity: values.max_quantity as number,
  webhookUrl: (values.webhook_url as string) || null,
});

/** Events resource for REST operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: eventFields,
  toInput: extractEventInput,
  nameField: "name",
  onDelete: (id) => deleteEvent(id as number),
});

/** Attendee type */
type Attendee = Awaited<ReturnType<typeof getAttendees>>[number];

/** Handle event with attendees - auth, fetch, then apply handler fn */
const withEventAttendees = async (
  request: Request,
  eventId: number,
  handler: (event: EventWithCount, attendees: Attendee[]) => Response,
): Promise<Response> => {
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }
  return withEvent(eventId, async (event) =>
    handler(event, await getAttendees(eventId)),
  );
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) =>
      htmlResponse(adminDashboardPage(await getAllEvents(), session.csrfToken)),
    () => htmlResponse(adminLoginPage()),
  );

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

/** Cookie to clear admin session */
const clearSessionCookie =
  "session=; HttpOnly; Secure; SameSite=Strict; Path=/admin/; Max-Age=0";

/**
 * Handle GET /admin/logout
 */
const handleAdminLogout = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      await deleteSession(session.token);
      return redirect("/admin/", clearSessionCookie);
    },
    () => redirect("/admin/", clearSessionCookie),
  );

/**
 * Handle GET /admin/settings
 */
const handleAdminSettingsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) =>
    htmlResponse(adminSettingsPage(session.csrfToken, await hasStripeKey())),
  );

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
const handleAdminSettingsPost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const stripeKeyConfigured = await hasStripeKey();
    const settingsPageWithError = (error: string, status: number) =>
      htmlResponse(
        adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
        status,
      );

    const validation = validateChangePasswordForm(form);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const isCurrentValid = await verifyAdminPassword(
      validation.currentPassword,
    );
    if (!isCurrentValid) {
      return settingsPageWithError("Current password is incorrect", 401);
    }

    await updateAdminPassword(validation.newPassword);
    return redirect("/admin/", clearSessionCookie);
  });

/**
 * Handle POST /admin/settings/stripe
 */
const handleAdminStripePost = async (request: Request): Promise<Response> => {
  const stripeErrorHandler = async (
    session: AuthSession,
    _: URLSearchParams,
    error: string,
  ) => {
    const stripeKeyConfigured = await hasStripeKey();
    return htmlResponse(
      adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
      400,
    );
  };

  const result = await requireAuthValidation(
    request,
    stripeKeyFields,
    stripeErrorHandler,
  );
  if (!result.ok) return result.response;

  await updateStripeKey(result.validation.values.stripe_secret_key as string);
  const stripeKeyConfigured = await hasStripeKey();
  return htmlResponse(
    adminSettingsPage(
      result.session.csrfToken,
      stripeKeyConfigured,
      undefined,
      "Stripe key updated successfully",
    ),
  );
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = createHandler(eventsResource, {
  onSuccess: () => redirect("/admin/"),
  onError: () => redirect("/admin/"),
});

/**
 * Handle GET /admin/event/:id
 */
const handleAdminEventGet = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, (event, attendees) =>
    htmlResponse(adminEventPage(event, attendees)),
  );

/** Curried event page GET handler: renderPage -> (request, eventId) -> Response */
const withEventPage =
  (renderPage: (event: EventWithCount, csrfToken: string) => string) =>
  (request: Request, eventId: number): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withEvent(eventId, (event) =>
        htmlResponse(renderPage(event, session.csrfToken)),
      ),
    );

/** Render event error page or 404 */
const eventErrorPage = async (
  id: number,
  renderPage: (
    event: EventWithCount,
    csrfToken: string,
    error: string,
  ) => string,
  csrfToken: string,
  error: string,
): Promise<Response> => {
  const event = await getEventWithCount(id);
  return event
    ? htmlResponse(renderPage(event, csrfToken, error), 400)
    : htmlResponse(notFoundPage(), 404);
};

/** Handle GET /admin/event/:id/edit */
const handleAdminEventEditGet = withEventPage(adminEventEditPage);

/** Handle POST /admin/event/:id/edit */
const handleAdminEventEditPost = updateHandler(eventsResource, {
  onSuccess: (row) => redirect(`/admin/event/${row.id}`),
  onError: (id, error, session) =>
    eventErrorPage(id as number, adminEventEditPage, session.csrfToken, error),
  onNotFound: () => htmlResponse(notFoundPage(), 404),
});

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, (event, attendees) => {
    const csv = generateAttendeesCsv(attendees);
    const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/** Handle DELETE /admin/event/:id (delete event, optionally verify name) */
const handleAdminEventDelete = deleteHandler(eventsResource, {
  onSuccess: () => redirect("/admin/"),
  onVerifyFailed: (id, _row, session) =>
    eventErrorPage(
      id as number,
      adminDeleteEventPage,
      session.csrfToken,
      "Event name does not match. Please type the exact name to confirm deletion.",
    ),
  onNotFound: () => htmlResponse(notFoundPage(), 404),
});

/** Route admin event edit requests */
const routeAdminEventEdit: RouteHandler = createIdRoute(
  /^\/admin\/event\/(\d+)\/edit$/,
  (request) => ({
    GET: (id) => handleAdminEventEditGet(request, id),
    POST: (id) => handleAdminEventEditPost(request, id),
  }),
);

/** Route admin event export requests */
const routeAdminEventExport: RouteHandler = createIdRoute(
  /^\/admin\/event\/(\d+)\/export$/,
  (request) => ({ GET: (id) => handleAdminEventExport(request, id) }),
);

/** Route admin event delete requests (DELETE for API, POST for web forms) */
const routeAdminEventDelete: RouteHandler = createIdRoute(
  /^\/admin\/event\/(\d+)\/delete$/,
  (request) => ({
    GET: (id) => handleAdminEventDeleteGet(request, id),
    POST: (id) => handleAdminEventDelete(request, id),
    DELETE: (id) => handleAdminEventDelete(request, id),
  }),
);

/** Route admin event detail requests */
const routeAdminEventDetail: RouteHandler = createIdRoute(
  /^\/admin\/event\/(\d+)$/,
  (request) => ({ GET: (id) => handleAdminEventGet(request, id) }),
);

/** Route admin event requests */
const routeAdminEvent: RouteHandler = async (request, path, method) =>
  (await routeAdminEventEdit(request, path, method)) ??
  (await routeAdminEventExport(request, path, method)) ??
  (await routeAdminEventDelete(request, path, method)) ??
  routeAdminEventDetail(request, path, method);

/**
 * Check if path is admin root
 */
const isAdminRoot = (path: string): boolean =>
  path === "/admin/" || path === "/admin";

/**
 * Route admin settings requests
 */
const routeAdminSettings = (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> =>
  matchRoute(path, method, [
    {
      path: "/admin/settings",
      method: "GET",
      handler: () => handleAdminSettingsGet(request),
    },
    {
      path: "/admin/settings",
      method: "POST",
      handler: () => handleAdminSettingsPost(request),
    },
    {
      path: "/admin/settings/stripe",
      method: "POST",
      handler: () => handleAdminStripePost(request),
    },
  ]);

/** Route admin auth requests (login/logout/settings) */
const routeAdminAuth: RouteHandlerWithServer = (
  request,
  path,
  method,
  server,
) =>
  chainRoutes(
    () =>
      matchRoute(path, method, [
        {
          path: "/admin/login",
          method: "POST",
          handler: () => handleAdminLogin(request, server),
        },
        {
          path: "/admin/logout",
          method: "GET",
          handler: () => handleAdminLogout(request),
        },
      ]),
    () => routeAdminSettings(request, path, method),
  );

/** Route core admin requests */
const routeAdminCore: RouteHandlerWithServer = (
  request,
  path,
  method,
  server,
) =>
  chainRoutes(
    () =>
      isAdminRoot(path) && method === "GET"
        ? handleAdminGet(request)
        : Promise.resolve(null),
    () =>
      matchRoute(path, method, [
        {
          path: "/admin/event",
          method: "POST",
          handler: () => handleCreateEvent(request),
        },
      ]),
    () => routeAdminAuth(request, path, method, server),
  );

/** Route admin requests */
export const routeAdmin: RouteHandlerWithServer = (
  request,
  path,
  method,
  server,
) =>
  chainRoutes(
    () => routeAdminCore(request, path, method, server),
    () => routeAdminEvent(request, path, method),
  );
