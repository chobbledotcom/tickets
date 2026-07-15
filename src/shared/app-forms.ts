/* jscpd:ignore-start */
import {
  AUTH_FORM,
  type AuthPolicy,
  type AuthSession,
  OWNER_FORM,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash, requireCsrfFormWithMessage } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import type { Flash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ValidationResult } from "#shared/forms.tsx";
import type { ResponseHandler } from "#shared/response-steps.ts";
/* jscpd:ignore-end */

export type FormValidator<TValues> = {
  validate: (form: FormParams) => ValidationResult<TValues>;
};

// ── createAuthedHandler: shared auth + load primitive ─────────────────

/** The authed, context-loaded request passed to a {@link createAuthedHandler}
 * `handle`. Exported so callers can type a specialised handler factory (fixing
 * the params/context generics) over the same shape. */
export type AuthedHandlerArgs<TParams, TContext> = {
  context: TContext;
  form: FormParams;
  params: TParams;
  session: AuthSession;
};

/** Shared auth + load context fields for all authed-form route primitives. */
export type AuthedBase<TParams, TContext> = {
  /** Auth policy (default AUTH_FORM). Use OWNER_FORM for owner-only routes. */
  auth?: AuthPolicy<"form">;
  /** Load context after auth. Returning null yields a 404. */
  loadContext?: (
    params: TParams,
    session: AuthSession,
  ) => Promise<TContext | null>;
};

/** The handling step run once auth (and any context load) has passed. */
export type AuthedHandleStep<TParams, TContext> = ResponseHandler<
  [args: AuthedHandlerArgs<TParams, TContext>]
>;

type AuthedHandlerConfig<TParams, TContext> = AuthedBase<TParams, TContext> & {
  /** Handle the authed, loaded request. */
  handle: AuthedHandleStep<TParams, TContext>;
};

/**
 * Authed form handler: CSRF + auth, optional entity load (null → 404), then
 * dispatch to `handle` with the raw form. Shared core used by the passthrough
 * factories (ownerFormById, groupFormPost) and createAuthedFormRoute.
 */
export const createAuthedHandler =
  <TParams = Record<string, never>, TContext = void>(
    config: AuthedHandlerConfig<TParams, TContext>,
  ) =>
  (request: Request, params: TParams): Promise<Response> =>
    withAuth<"form">(
      request,
      config.auth ?? AUTH_FORM,
      async (session, form) => {
        const loaded = config.loadContext
          ? await config.loadContext(params, session)
          : (undefined as TContext);
        if (config.loadContext && loaded === null) return notFoundResponse();
        return config.handle({
          context: loaded as TContext,
          form,
          params,
          session,
        });
      },
    );

/** A finished authed route: takes the request and its typed params, gives back
 * the response. The shape every {@link createAuthedHandler} factory returns. */
export type AuthedRoute<TParams> = (
  request: Request,
  params: TParams,
) => Promise<Response>;

/** An owner-only authed form route with no params or loaded context:
 * {@link createAuthedHandler} with the owner policy already applied, so callers
 * pass only their `handle` step. */
export const ownerFormHandler = (
  handle: AuthedHandleStep<Record<string, never>, void>,
): AuthedRoute<Record<string, never>> =>
  createAuthedHandler({ auth: OWNER_FORM, handle });

/** Build an authed route from the shared auth/load config plus its own
 * handling step. The factories that layer more behaviour on top of
 * {@link createAuthedHandler} — typed-form validation below, typed-name
 * confirmation in the admin confirmation module — attach their step here. */
export const authedHandlerWithStep = <TParams, TContext>(
  config: AuthedBase<TParams, TContext>,
  handle: AuthedHandleStep<TParams, TContext>,
): AuthedRoute<TParams> =>
  createAuthedHandler<TParams, TContext>({ ...config, handle });

// ── createAuthedFormRoute: adds schema validation on top ──────────────

type HandlerArgs<TValues, TParams, TContext> = AuthedHandlerArgs<
  TParams,
  TContext
> & {
  values: TValues;
};

type InvalidArgs<TParams, TContext> = AuthedHandlerArgs<TParams, TContext> & {
  error: string;
};

type FormRouteConfig<TValues, TParams, TContext> = AuthedBase<
  TParams,
  TContext
> & {
  /** Mutate the form before validation (demo overrides, secret triage, etc.). */
  preprocessForm?: (form: FormParams, context: TContext) => void;
  /** Form validator — static, or built from the loaded context. */
  form:
    | FormValidator<TValues>
    | ((context: TContext) => FormValidator<TValues>);
  onInvalid: ResponseHandler<[args: InvalidArgs<TParams, TContext>]>;
  onValid: ResponseHandler<[args: HandlerArgs<TValues, TParams, TContext>]>;
};

/** Collect common typed-form config while leaving persistence at the direct
 * `createAuthedFormRoute` call. */
export function authedFormConfig<
  TValues,
  TParams = Record<string, never>,
  TContext = void,
>(
  auth: AuthPolicy<"form">,
  form: FormValidator<TValues>,
  errorPath: (context: TContext) => string,
  loadContext?: AuthedBase<TParams, TContext>["loadContext"],
): Omit<FormRouteConfig<TValues, TParams, TContext>, "onValid"> {
  return {
    auth,
    ...(loadContext ? { loadContext } : {}),
    form,
    onInvalid: ({ context, error }) => errorRedirect(errorPath(context), error),
  };
}

/** Require auth, optionally load context, validate a typed form, then dispatch. */
export const createAuthedFormRoute = <
  TValues,
  TParams = Record<string, never>,
  TContext = void,
>(
  config: FormRouteConfig<TValues, TParams, TContext>,
) =>
  authedHandlerWithStep<TParams, TContext>(
    config,
    ({ context, form, params, session }) => {
      config.preprocessForm?.(form, context);
      const validator =
        typeof config.form === "function" ? config.form(context) : config.form;
      const result = validator.validate(form);
      return result.valid
        ? config.onValid({
            context,
            form,
            params,
            session,
            values: result.values,
          })
        : config.onInvalid({
            context,
            error: result.error,
            form,
            params,
            session,
          });
    },
  );

// ── createFormRoute: public CSRF-only (no auth) ───────────────────────

type PublicHandlerArgs<TValues, TParams> = {
  form: FormParams;
  params: TParams;
  values: TValues;
};

type PublicInvalidArgs<TParams> = {
  error: string;
  params: TParams;
};

type PublicFormRouteConfig<TValues, TParams> = {
  form: FormValidator<TValues>;
  /** Must return a synchronous Response (used as the CSRF error handler too). */
  onInvalid: (args: PublicInvalidArgs<TParams>) => Response;
  onValid: ResponseHandler<[args: PublicHandlerArgs<TValues, TParams>]>;
};

/** Render a public page that carries a form: sign a CSRF token for it, pick
 * up any flashed message, and return the page HTML. The GET-side partner of
 * {@link createFormRoute} (the join and demo-reset pages use both). */
export const publicFormPage = async (
  request: Request,
  render: (flash: Flash) => string,
): Promise<Response> => {
  await signCsrfToken();
  return htmlResponse(render(applyFlash(request)));
};

/** CSRF-only (no auth): validate a typed form, then dispatch. */
export const createFormRoute =
  <TValues, TParams = Record<string, never>>(
    config: PublicFormRouteConfig<TValues, TParams>,
  ) =>
  async (request: Request, params: TParams): Promise<Response> => {
    const csrf = await requireCsrfFormWithMessage(request, (error) =>
      config.onInvalid({ error, params }),
    );
    if (!csrf.ok) return csrf.response;

    const { form } = csrf;
    const result = config.form.validate(form);

    return result.valid
      ? config.onValid({ form, params, values: result.values })
      : config.onInvalid({ error: result.error, params });
  };
