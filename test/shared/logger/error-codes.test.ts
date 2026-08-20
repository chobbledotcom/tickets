import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";

// The wire code is what an operator filters an error report by, in Bugsink and
// in the activity log, so renaming one quietly breaks their saved searches.
// The label is what the activity log shows them. Both are pinned whole here:
// a changed, dropped, or emptied entry fails this test rather than reaching
// production and stranding a search that used to work.
describe("error codes", () => {
  test("every code keeps its wire string", () => {
    expect(ErrorCode).toEqual({
      ADDRESS_LOOKUP: "E_ADDRESS_LOOKUP",
      AUTH_CSRF_MISMATCH: "E_AUTH_CSRF_MISMATCH",
      AUTH_EXPIRED: "E_AUTH_EXPIRED",
      AUTH_INVALID_SESSION: "E_AUTH_INVALID_SESSION",
      AUTH_RATE_LIMITED: "E_AUTH_RATE_LIMITED",
      BOTPOISON_VERIFY: "E_BOTPOISON_VERIFY",
      CAPACITY_EXCEEDED: "E_CAPACITY_EXCEEDED",
      CDN_REQUEST: "E_CDN_REQUEST",
      CONFIG_MISSING: "E_CONFIG_MISSING",
      DATA_INVALID: "E_DATA_INVALID",
      DB_BUSY: "E_DB_BUSY",
      DB_CONNECTION: "E_DB_CONNECTION",
      DB_QUERY: "E_DB_QUERY",
      DECRYPT_FAILED: "E_DECRYPT_FAILED",
      DOMAIN_REJECTED: "E_DOMAIN_REJECTED",
      EMAIL_SEND: "E_EMAIL_SEND",
      IMAGE_BROKEN: "E_IMAGE_BROKEN",
      INVARIANT_REPORTED: "E_INVARIANT_REPORTED",
      KEY_DERIVATION: "E_KEY_DERIVATION",
      LEDGER_POST: "E_LEDGER_POST",
      NOT_FOUND_ATTENDEE: "E_NOT_FOUND_ATTENDEE",
      NOT_FOUND_LISTING: "E_NOT_FOUND_LISTING",
      PAYMENT_CHECKOUT: "E_PAYMENT_CHECKOUT",
      PAYMENT_REFUND: "E_PAYMENT_REFUND",
      PAYMENT_SESSION: "E_PAYMENT_SESSION",
      PAYMENT_SIGNATURE: "E_PAYMENT_SIGNATURE",
      PAYMENT_WEBHOOK_SETUP: "E_PAYMENT_WEBHOOK_SETUP",
      REGISTRATION_DELIVERY: "E_REGISTRATION_DELIVERY",
      SQUARE_CHECKOUT: "E_SQUARE_CHECKOUT",
      SQUARE_ORDER: "E_SQUARE_ORDER",
      SQUARE_REFUND: "E_SQUARE_REFUND",
      SQUARE_SESSION: "E_SQUARE_SESSION",
      SQUARE_SIGNATURE: "E_SQUARE_SIGNATURE",
      STORAGE_DELETE: "E_STORAGE_DELETE",
      STORAGE_UPLOAD: "E_STORAGE_UPLOAD",
      STRIPE_CHECKOUT: "E_STRIPE_CHECKOUT",
      STRIPE_REFUND: "E_STRIPE_REFUND",
      STRIPE_SESSION: "E_STRIPE_SESSION",
      STRIPE_SIGNATURE: "E_STRIPE_SIGNATURE",
      STRIPE_WEBHOOK_SETUP: "E_STRIPE_WEBHOOK_SETUP",
      VALIDATION_CONTENT_TYPE: "E_VALIDATION_CONTENT_TYPE",
      VALIDATION_FORM: "E_VALIDATION_FORM",
      WEBHOOK_PRICE_SIGNATURE: "E_WEBHOOK_PRICE_SIGNATURE",
    });
  });

  test("every wire string keeps its label", () => {
    expect(errorCodeLabel).toEqual({
      E_ADDRESS_LOOKUP: "Address lookup failed",
      E_AUTH_CSRF_MISMATCH: "CSRF mismatch",
      E_AUTH_EXPIRED: "Session expired",
      E_AUTH_INVALID_SESSION: "Invalid session",
      E_AUTH_RATE_LIMITED: "Rate limited",
      E_BOTPOISON_VERIFY: "Botpoison verification failed",
      E_CAPACITY_EXCEEDED: "Capacity exceeded",
      E_CDN_REQUEST: "CDN request failed",
      E_CONFIG_MISSING: "Configuration missing",
      E_DATA_INVALID: "Invalid data",
      E_DB_BUSY: "Database busy",
      E_DB_CONNECTION: "Database connection failed",
      E_DB_QUERY: "Database query failed",
      E_DECRYPT_FAILED: "Decryption failed",
      E_DOMAIN_REJECTED: "Domain rejected",
      E_EMAIL_SEND: "Email send failed",
      E_IMAGE_BROKEN: "Broken image",
      E_INVARIANT_REPORTED: "System invariant broken",
      E_KEY_DERIVATION: "Key derivation failed",
      E_LEDGER_POST: "Ledger post failed",
      E_NOT_FOUND_ATTENDEE: "Attendee not found",
      E_NOT_FOUND_LISTING: "Listing not found",
      E_PAYMENT_CHECKOUT: "Payment checkout failed",
      E_PAYMENT_REFUND: "Payment refund failed",
      E_PAYMENT_SESSION: "Payment session error",
      E_PAYMENT_SIGNATURE: "Payment signature verification failed",
      E_PAYMENT_WEBHOOK_SETUP: "Payment webhook setup failed",
      E_REGISTRATION_DELIVERY: "Registration notification delivery failed",
      E_SQUARE_CHECKOUT: "Square checkout failed",
      E_SQUARE_ORDER: "Square order validation failed",
      E_SQUARE_REFUND: "Square refund failed",
      E_SQUARE_SESSION: "Square session retrieval failed",
      E_SQUARE_SIGNATURE: "Square signature verification failed",
      E_STORAGE_DELETE: "Storage delete failed",
      E_STORAGE_UPLOAD: "Storage upload failed",
      E_STRIPE_CHECKOUT: "Stripe checkout failed",
      E_STRIPE_REFUND: "Stripe refund failed",
      E_STRIPE_SESSION: "Stripe session retrieval failed",
      E_STRIPE_SIGNATURE: "Stripe signature verification failed",
      E_STRIPE_WEBHOOK_SETUP: "Stripe webhook setup failed",
      E_VALIDATION_CONTENT_TYPE: "Invalid content type",
      E_VALIDATION_FORM: "Form validation error",
      E_WEBHOOK_PRICE_SIGNATURE:
        "Webhook price signature invalid, missing, or charge differs from it",
    });
  });
});
