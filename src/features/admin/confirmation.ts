/**
 * Confirmation and verification utilities for admin actions
 */

/* jscpd:ignore-start */
import { asString } from "#fp";
import type { AuthSession } from "#routes/auth.ts";
import {
  AUTH_FORM,
  type Guard,
  OWNER_FORM,
  requireOwnerOr,
  requireSessionOr,
  type SessionGuard,
  withAuth,
} from "#routes/auth.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import {
  type AuthedBase,
  type AuthedHandleStep,
  authedHandlerWithStep,
} from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ParamsRoute, ResponseHandler } from "#shared/response-steps.ts";
/* jscpd:ignore-end */

/** Form guard: require auth + CSRF, call handler with session and form */
export type FormGuard<TSession> = Guard<[TSession, FormParams]>;

/** Verify identifier matches for confirmation (case-insensitive, trimmed) */
export const verifyIdentifier = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/**
 * Verify a form confirmation field matches an expected value, or return an error redirect.
 * One function to handle all confirmation flows consistently:
 *   const error = verifyOrRedirect(form, listing.name, "/admin/listing/1/delete", "Listing name", "deletion");
 *   if (error) return error;
 */
export const verifyOrRedirect = (
  form: FormParams,
  expected: string,
  redirectUrl: string,
  label = "Name",
  action?: string,
): Response | null => {
  if (!verifyIdentifier(expected, form.getString("confirm_identifier"))) {
    const suffix = action ? ` ${action}` : "";
    return errorRedirect(
      redirectUrl,
      `${label} does not match. Please type the exact ${label.toLowerCase()} to confirm${suffix}.`,
    );
  }
  return null;
};

/**
 * Verify a JSON body confirmation field matches an expected value, or return an error message.
 * API-safe counterpart to verifyOrRedirect for JSON endpoints:
 *   const error = verifyIdentifierOrJsonError(listing.name, body.confirm_identifier, "Listing name");
 *   if (error) return errorResponse(error);
 */
export const verifyIdentifierOrJsonError = (
  expected: string,
  provided: unknown,
  label = "Name",
): string | null => {
  if (!verifyIdentifier(expected, asString(provided))) {
    return `${label} does not match. Please provide the exact ${label.toLowerCase()} in confirm_identifier.`;
  }
  return null;
};

// ── createVerifiedFormRoute: auth + load + verify identifier + action ─

type VerifiedFormRouteConfig<TParams, TContext> = AuthedBase<
  TParams,
  TContext
> & {
  /** The identifier the user must type (e.g. entity name) */
  identifier: (context: TContext, params: TParams) => string | Promise<string>;
  /** Label for the identifier field (e.g. "Listing name") */
  identifierLabel: string;
  /** Action suffix for the mismatch error (e.g. "deletion") */
  actionLabel?: string;
  /** Where to redirect on identifier mismatch */
  mismatchRedirect: (context: TContext, params: TParams) => string;
  /** Run after identifier verifies */
  onConfirm: AuthedHandleStep<TParams, TContext>;
};

/**
 * Auth + CSRF + optional entity load + confirm_identifier verification,
 * then dispatch to `onConfirm`. Mismatch → errorRedirect with a consistent
 * "X does not match" message.
 */
export const createVerifiedFormRoute = <TParams, TContext>(
  config: VerifiedFormRouteConfig<TParams, TContext>,
): ParamsRoute<TParams> =>
  authedHandlerWithStep<TParams, TContext>(config, async (args) => {
    const expected = await config.identifier(args.context, args.params);
    const error = verifyOrRedirect(
      args.form,
      expected,
      config.mismatchRedirect(args.context, args.params),
      config.identifierLabel,
      config.actionLabel,
    );
    if (error) return error;
    return config.onConfirm(args);
  });

/** Auth option: string shorthand or explicit guard pair */
type AuthOption<TSession> =
  | "owner"
  | "any"
  | {
      requireSession: SessionGuard<TSession>;
      withForm: FormGuard<TSession>;
    };

/** Configuration for creating confirmed-action GET/POST handler pair */
export type ConfirmedHandlerConfig<T, TSession = AuthSession> = {
  /** Auth guards: "owner" | "any" shorthand, or explicit { requireSession, withForm } */
  auth?: AuthOption<TSession>;
  /** Route path pattern, e.g. "/admin/users/:id/delete" */
  path: string;
  /** Load the entity by ID (return null if not found) */
  load: (id: number, session: TSession) => Promise<T | null>;
  /** Render the confirmation page HTML */
  render: (
    model: T,
    session: TSession,
    error?: string,
  ) => string | Promise<string>;
  /** Extract the identifier the user must type to confirm */
  identifier: (model: T) => string | Promise<string>;
  /** Perform the confirmed action. A response can keep the operator on the
   * confirmation page when a transaction rejects the action. */
  onConfirm: (
    model: T,
    id: number,
    session: TSession,
  ) => Promise<void> | Promise<Response | undefined>;
  /** Where to redirect after success (string or function of model + id) */
  successRedirect: string | ((model: T, id: number) => string);
  /** Flash message shown after success */
  successMessage: string;
  /** Human-readable label for the identifier field (e.g. "Username") */
  identifierLabel: string;
  /** Action label for the verification prompt (default "deletion") */
  actionLabel?: string;
  /** Optional pre-validation before loading (e.g. self-delete check) */
  preValidate?: (
    id: number,
    session: TSession,
  ) => Response | null | Promise<Response | null>;
  /**
   * Optional guard producing a user-facing error message (or null when the
   * action is allowed). Unlike {@link preValidate} — which returns a full
   * Response and runs identically on the GET and the POST — this distinguishes
   * the two requests so the confirmation GET never redirects to itself:
   * the GET **renders** the confirmation page *with* the
   * error (still 200), while the POST **blocks** the action with an error
   * redirect back to the confirmation page. Runs after the entity loads, so it
   * can reason about the loaded model's id.
   */
  guardError?: (
    model: T,
    id: number,
    session: TSession,
  ) => Promise<string | null>;
  /** Optional custom not-found handler (defaults to 404 page) */
  onNotFound?: ResponseHandler<[id: number, session: TSession]>;
};

/** Return type of createConfirmedHandlers */
export type ConfirmedHandlers = {
  get: (request: Request, id: number) => Promise<Response>;
  post: (request: Request, id: number) => Promise<Response>;
};

/** Resolve auth option to concrete guard functions */
const resolveAuth = <TSession>(
  auth: AuthOption<TSession> | undefined,
): {
  requireSession: SessionGuard<TSession>;
  withForm: FormGuard<TSession>;
} => {
  if (typeof auth === "object") return auth;
  const isOwner = auth !== "any";
  return {
    requireSession: (isOwner
      ? requireOwnerOr
      : requireSessionOr) as SessionGuard<TSession>,
    withForm: ((r: Request, h: ResponseHandler<never[]>) =>
      withAuth(
        r,
        isOwner ? OWNER_FORM : AUTH_FORM,
        h as Parameters<typeof withAuth>[2],
      )) as FormGuard<TSession>,
  };
};

/**
 * Create a pair of GET (confirmation page) and POST (execute action) handlers
 * for resources that need typed-identifier confirmation.
 */
export const createConfirmedHandlers = <T, TSession = AuthSession>(
  config: ConfirmedHandlerConfig<T, TSession>,
): ConfirmedHandlers => {
  const notFound = (id: number, session: TSession) =>
    config.onNotFound ? config.onNotFound(id, session) : notFoundResponse();
  const { requireSession, withForm } = resolveAuth(config.auth);
  const actionLabel = config.actionLabel ?? "deletion";
  const resolveRedirect = (model: T, id: number) =>
    typeof config.successRedirect === "function"
      ? config.successRedirect(model, id)
      : config.successRedirect;
  const confirmPath = (id: number) => config.path.replace(/:(\w+)/, String(id));

  const guardError = (model: T, id: number, session: TSession) =>
    config.guardError ? config.guardError(model, id, session) : null;

  /** The shared opening step of the GET and the POST: run `preValidate`, load
   * the model (not-found response when missing), then hand it to `proceed`. */
  const withModel = async (
    id: number,
    session: TSession,
    proceed: (model: T) => Promise<Response>,
  ): Promise<Response> => {
    const rejection = config.preValidate
      ? await config.preValidate(id, session)
      : null;
    if (rejection) return rejection;
    const model = await config.load(id, session);
    return model === null ? notFound(id, session) : proceed(model);
  };

  const get = (request: Request, id: number): Promise<Response> =>
    requireSession(request, (session) =>
      withModel(id, session, async (result) => {
        // A guard error is rendered into the confirmation page (200), never a
        // redirect — so the GET can't loop back to itself. A flash error
        // from a prior POST block takes precedence when present.
        const flash = getFlash();
        const error = flash.error ?? (await guardError(result, id, session));
        return htmlResponse(
          await config.render(result, session, error ?? undefined),
        );
      }),
    );

  const post = (request: Request, id: number): Promise<Response> =>
    withForm(request, (session, form) =>
      withModel(id, session, async (result) => {
        // The POST blocks a guarded action with an error redirect back to the
        // confirmation page (where the GET will then render the error).
        const guard = await guardError(result, id, session);
        if (guard) return errorRedirect(confirmPath(id), guard);

        const expected = await config.identifier(result);
        const error = verifyOrRedirect(
          form,
          expected,
          confirmPath(id),
          config.identifierLabel,
          actionLabel,
        );
        if (error) return error;

        return (
          (await config.onConfirm(result, id, session)) ??
          redirect(resolveRedirect(result, id), config.successMessage, true)
        );
      }),
    );

  return { get, post };
};
