import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectHtmlResponse,
  testRequiresAuth,
} from "./assertions.ts";
import { describeWithEnv } from "./db.ts";
import { awaitTestRequest, mockFormRequest } from "./mocks.ts";
import { adminFormPost, testCookie } from "./session.ts";

/** One boolean setting that has its own admin form and an advanced-settings
 *  toggle. */
export interface BooleanSetting {
  /** The flash message that reports the disabled state. */
  disabledFlash: string;
  /** The flash message that reports the enabled state. */
  enabledFlash: string;
  /** The form field that carries the toggle, such as "externalOrderEnabled". */
  field: string;
  /** Reads the saved value from the loaded settings snapshot. */
  isEnabled: () => boolean;
  /** The wording after "enables" and "disables" in the test titles. */
  label: string;
  /** The setting's name in test titles, such as "external-order". */
  name: string;
  /** The form's path, such as "/admin/settings/external-order". */
  path: string;
  /** The question that the advanced settings page asks about the toggle. */
  question: string;
}

const formBody = (
  setting: BooleanSetting,
  value: "true" | "false",
): Record<string, string> => ({ [setting.field]: value });

/** Cover one boolean setting the way every settings form does: the login and
 *  CSRF gates, enable, disable, the saved value, and the advanced toggle. */
export const describeBooleanSetting = (setting: BooleanSetting): void =>
  describeWithEnv(
    `server (admin settings: ${setting.name})`,
    { db: true },
    () => {
      describe(`POST ${setting.path}`, () => {
        testRequiresAuth(setting.path, {
          body: formBody(setting, "true"),
          method: "POST",
        });

        it("rejects invalid CSRF token", async () => {
          const response = await handleRequest(
            mockFormRequest(
              setting.path,
              {
                ...formBody(setting, "true"),
                csrfToken: "invalid-csrf-token",
              },
              await testCookie(),
            ),
          );
          await expectHtmlResponse(response, 403, "Invalid CSRF token");
        });

        const toggleCases: [value: "true" | "false", flash: string][] = [
          ["true", setting.enabledFlash],
          ["false", setting.disabledFlash],
        ];
        for (const [value, flash] of toggleCases) {
          it(`${value === "true" ? "enables" : "disables"} ${setting.label}`, async () => {
            const { response } = await adminFormPost(
              setting.path,
              formBody(setting, value),
            );
            expect(response.status).toBe(302);
            expectFlash(response, expect.stringContaining(flash));
          });
        }

        it("setting persists in the database", async () => {
          expect(setting.isEnabled()).toBe(false);

          await adminFormPost(setting.path, formBody(setting, "true"));

          expect(setting.isEnabled()).toBe(true);
        });

        it(`advanced settings page shows the ${setting.name} toggle`, async () => {
          const response = await awaitTestRequest("/admin/settings-advanced", {
            cookie: await testCookie(),
          });
          await expectHtmlResponse(
            response,
            200,
            setting.question,
            setting.field,
          );
        });
      });
    },
  );
