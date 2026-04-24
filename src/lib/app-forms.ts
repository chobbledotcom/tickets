import type { FormParams } from "#lib/form-data.ts";
import type { ValidationResult } from "#lib/forms.tsx";
import {
  AUTH_FORM,
  type AuthPolicy,
  type AuthSession,
  withAuth,
} from "#routes/auth.ts";
import { CSRF_INVALID_FORM_MESSAGE } from "#lib/csrf.ts";
import { requireCsrfForm } from "#routes/csrf.ts";
import { notFoundResponse } from "#routes/response.ts";

export type FormValidator<TValues> = {
  validate: (form: FormParams) => ValidationResult<TValues>;
};

// ── createAuthedHandler: shared auth + load primitive ─────────────────

type AuthedHandlerArgs<TParams, TContext> = {
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

type AuthedHandlerConfig<TParams, TContext> = AuthedBase<TParams, TContext> & {
  /** Handle the authed, loaded request. */
  handle: (
    args: AuthedHandlerArgs<TParams, TContext>,
  ) => Response | Promise<Response>;
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

// ── createAuthedFormRoute: adds schema validation on top ──────────────

type HandlerArgs<TValues, TParams, TContext> = {
  context: TContext;
  form: FormParams;
  params: TParams;
  session: AuthSession;
  values: TValues;
};

type InvalidArgs<TParams, TContext> = {
  context: TContext;
  error: string;
  form: FormParams;
  params: TParams;
  session: AuthSession;
};

type FormRouteConfig<TValues, TParams, TContext> =
  & AuthedBase<TParams, TContext>
  & {
    /** Mutate the form before validation (demo overrides, secret triage, etc.). */
    preprocessForm?: (form: FormParams, context: TContext) => void;
    /** Form validator — static, or built from the loaded context. */
    form:
      | FormValidator<TValues>
      | ((context: TContext) => FormValidator<TValues>);
    onInvalid: (
      args: InvalidArgs<TParams, TContext>,
    ) => Response | Promise<Response>;
    onValid: (
      args: HandlerArgs<TValues, TParams, TContext>,
    ) => Response | Promise<Response>;
  };

/** Require auth, optionally load context, validate a typed form, then dispatch. */
export const createAuthedFormRoute = <
  TValues,
  TParams = Record<string, never>,
  TContext = void,
>(
  config: FormRouteConfig<TValues, TParams, TContext>,
) =>
  /* jscpd:ignore-start */
  createAuthedHandler<TParams, TContext>({
    auth: config.auth,
    loadContext: config.loadContext,
    handle: ({ context, form, params, session }) => {
      /* jscpd:ignore-end */
      config.preprocessForm?.(form, context);
      const validator = typeof config.form === "function"
        ? config.form(context)
        : config.form;
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
  });

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
  onValid: (
    args: PublicHandlerArgs<TValues, TParams>,
  ) => Response | Promise<Response>;
};

/** CSRF-only (no auth): validate a typed form, then dispatch. */
export const createFormRoute =
  <TValues, TParams = Record<string, never>>(
    config: PublicFormRouteConfig<TValues, TParams>,
  ) =>
  async (request: Request, params: TParams): Promise<Response> => {
    const csrf = await requireCsrfForm(request, () =>
      config.onInvalid({ error: CSRF_INVALID_FORM_MESSAGE, params }),
    );
    if (!csrf.ok) return csrf.response;

    const { form } = csrf;
    const result = config.form.validate(form);

    return result.valid
      ? config.onValid({ form, params, values: result.values })
      : config.onInvalid({ error: result.error, params });
  };
