/**
 * Pure unit tests for the contact-channel picklist guard that
 * `contact-preferences.ts` exports. Table-driven and deterministic — no DB
 * needed.
 */

import { describe } from "@std/testing/bdd";
import { isContactChannel } from "#db/contact-preferences.ts";
import { checkBothArms } from "#test-utils/picklist-guard.ts";

describe("ContactChannel picklist", () => {
  checkBothArms(
    isContactChannel,
    ["email", "sms"],
    ["", "Email", "phone", "whatsapp", "sms ", "push"],
  );
});
