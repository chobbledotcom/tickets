/**
 * Pure unit tests for the picklist guards that `types.ts`
 * exports. Table-driven and deterministic — no DB or harness needed, so
 * mutation testing stays fast. Guards exported by other modules are tested
 * beside those modules.
 */

import { describe } from "@std/testing/bdd";
import { checkBothArms } from "#test-utils/picklist-guard.ts";
import {
  isContactField,
  isEmailTemplateFormat,
  isEmailTemplateType,
  isImageUseItemType,
  isListingType,
  isPaymentProvider,
  isPaymentProviderSetting,
  isSitePageItemType,
  isSuperuserChoice,
} from "#types";

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

describe("SuperuserChoice picklist", () => {
  checkBothArms(
    isSuperuserChoice,
    ["", "self-managed", "enabled"],
    ["managed", "super-managed", "ENABLED", "disabled"],
  );
});

describe("ContactField picklist", () => {
  checkBothArms(
    isContactField,
    ["email", "phone", "address", "special_instructions"],
    ["", "Email", "name", "instructions", "postcode"],
  );
});

describe("PaymentProvider picklist", () => {
  checkBothArms(
    isPaymentProvider,
    ["stripe", "square", "sumup"],
    ["", "Stripe", "paypal", "none"],
  );
});

describe("PaymentProviderSetting picklist", () => {
  checkBothArms(
    isPaymentProviderSetting,
    ["stripe", "square", "sumup", "none"],
    ["", "None", "unset", "absent"],
  );
});

describe("ListingType picklist", () => {
  checkBothArms(
    isListingType,
    ["standard", "daily"],
    ["", "Standard", "weekly", "one-off"],
  );
});

describe("ImageUseItemType picklist", () => {
  checkBothArms(
    isImageUseItemType,
    ["listing", "group", "news", "page"],
    ["", "Listing", "event", "post"],
  );
});

describe("SitePageItemType picklist", () => {
  checkBothArms(
    isSitePageItemType,
    ["listing", "group", "page"],
    ["", "Listing", "news", "item"],
  );
});
