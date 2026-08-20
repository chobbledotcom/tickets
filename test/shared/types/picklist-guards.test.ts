/**
 * Pure unit tests for the email-template picklist guards that `types.ts`
 * exports. Table-driven and deterministic — no DB or harness needed, so
 * mutation testing stays fast. Guards exported by other modules are tested
 * beside those modules.
 */

import { describe } from "@std/testing/bdd";
import { checkBothArms } from "#test-utils/picklist-guard.ts";
import { isEmailTemplateFormat, isEmailTemplateType } from "#types";

describe("EmailTemplateType picklist", () => {
  checkBothArms(
    isEmailTemplateType,
    ["confirmation", "admin"],
    ["", "Confirmation", "admin ", "owner", "newsletter"],
  );
});

describe("EmailTemplateFormat picklist", () => {
  checkBothArms(
    isEmailTemplateFormat,
    ["subject", "html", "text"],
    ["", "Subject", "body", "html_body", "TEXT"],
  );
});
