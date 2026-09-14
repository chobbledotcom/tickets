/**
 * The settings form plumbing the settings routes share: the central
 * single-line limit, applied before any save, and masked-secret handling.
 */

import { expect } from "@std/expect";
import { fn } from "@std/expect/fn";
import { beforeEach, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import {
  createSettingsHandler,
  type ErrorPageFn,
  type SettingsFormHandler,
  type SettingsHandlerConfig,
  secretFieldHandler,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import {
  expectFlash,
  expectRedirect,
  redirectFormId,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import {
  makeMockErrorPage,
  runHandler,
} from "#test-utils/settings-handlers.ts";

const FIELD = "email_api_key";
const FORM_ID = "settings-email";
const LENGTH_ERROR = `API Key must be ${MAX_INPUT_LENGTH} characters or fewer`;

/** A `save` spy a handler config can take, with its calls still readable. */
type SaveSpy = ReturnType<typeof fn> & ((value: string) => Promise<void>);

const makeSave = (): SaveSpy =>
  fn(() => Promise.resolve()) as unknown as SaveSpy;

/** One handler config: the email API key field, saved by the given spy. */
const emailKeyConfig = (saveFn: SaveSpy): SettingsHandlerConfig<string> => ({
  extract: (form) => form.getString(FIELD),
  formId: FORM_ID,
  label: "Email settings",
  save: saveFn,
});

/** The handlers that save the email API key, one wrapper per tier. */
const KEY_SAVERS: [
  name: string,
  make: (saveFn: SaveSpy) => SettingsFormHandler,
][] = [
  [
    "createSettingsHandler",
    (saveFn) => createSettingsHandler(emailKeyConfig(saveFn)),
  ],
  [
    "secretFieldHandler",
    (saveFn) =>
      secretFieldHandler({
        field: FIELD,
        formId: FORM_ID,
        label: "API key",
        save: saveFn,
      }),
  ],
];

describeWithEnv("settings form helpers", { db: true }, () => {
  let errorPage: ErrorPageFn & ReturnType<typeof fn>;

  beforeEach(() => {
    errorPage = makeMockErrorPage();
  });

  for (const [name, makeHandler] of KEY_SAVERS) {
    test(`${name} refuses a value of ${MAX_INPUT_LENGTH + 1} characters before the save`, async () => {
      const saveFn = makeSave();
      const response = await runHandler(
        makeHandler(saveFn),
        { [FIELD]: "x".repeat(MAX_INPUT_LENGTH + 1) },
        errorPage,
      );

      expect(response.status).toBe(400);
      expect(errorPage).toHaveBeenCalledWith(LENGTH_ERROR, FORM_ID);
      expect(saveFn).not.toHaveBeenCalled();
    });
  }

  test(`createSettingsHandler saves a value of exactly ${MAX_INPUT_LENGTH} characters`, async () => {
    const value = "k".repeat(MAX_INPUT_LENGTH);
    const saveFn = makeSave();
    const response = await runHandler(
      createSettingsHandler(emailKeyConfig(saveFn)),
      { [FIELD]: value },
      errorPage,
    );

    expect(saveFn).toHaveBeenCalledWith(value);
    expectRedirect(response, "/admin/settings", `form=${FORM_ID}`);
    expectFlash(response, "Email settings updated");
  });

  test("createSettingsHandler skips the limit for a masked no-change sentinel", async () => {
    const saveFn = makeSave();
    const response = await runHandler(
      createSettingsHandler(emailKeyConfig(saveFn)),
      { [FIELD]: MASK_SENTINEL },
      errorPage,
    );

    expect(saveFn).toHaveBeenCalledWith(MASK_SENTINEL);
    expect(errorPage).not.toHaveBeenCalled();
    expectFlash(response, "Email settings updated");
  });

  test("secretFieldHandler redirects a masked sentinel as unchanged without saving", async () => {
    const saveFn = makeSave();
    const response = await runHandler(
      secretFieldHandler({
        field: FIELD,
        formId: FORM_ID,
        label: "API key",
        save: saveFn as (value: string) => Promise<void>,
      }),
      { [FIELD]: MASK_SENTINEL },
      errorPage,
    );

    expect(saveFn).not.toHaveBeenCalled();
    expectRedirect(response, "/admin/settings", `form=${FORM_ID}`);
    expectFlash(response, "API key unchanged");
  });

  test("settingsHandler runs the single-line limit inside the ready-made route", async () => {
    const saveFn = makeSave();
    const route = settingsHandler(emailKeyConfig(saveFn));
    const response = await route(
      mockFormRequest(
        "/admin/settings",
        {
          [FIELD]: "x".repeat(MAX_INPUT_LENGTH + 1),
          csrf_token: await testCsrfToken(),
        },
        await testCookie(),
      ),
    );

    expect(response.status).toBe(302);
    expect(redirectFormId(response)).toBe(FORM_ID);
    expectFlash(response, LENGTH_ERROR, false);
    expect(saveFn).not.toHaveBeenCalled();
  });
});
