import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ignoredProviderNotice,
  invalidProviderNotice,
  parseVerifiedProviderNotice,
  providerNotice,
} from "#shared/payment-runtime/provider-notice.ts";
import { SESSION_RESOURCE } from "#test/shared/db/payments/fixtures.ts";

const EventSchema = v.object({ id: v.string() });

test("builds typed provider notice results", () => {
  expect(
    providerNotice("event-one", SESSION_RESOURCE, "payment.updated"),
  ).toEqual({
    notice: {
      eventId: "event-one",
      resource: SESSION_RESOURCE,
      type: "payment.updated",
    },
    valid: true,
  });
  expect(ignoredProviderNotice()).toEqual({ notice: null, valid: true });
  expect(invalidProviderNotice("Bad notice")).toEqual({
    error: "Bad notice",
    valid: false,
  });
});

test("parses only verified provider notices", () => {
  const build = (event: { id: string }) =>
    providerNotice(event.id, SESSION_RESOURCE, "payment.updated");
  expect(
    parseVerifiedProviderNotice(
      { error: "Bad signature", valid: false },
      EventSchema,
      build,
    ),
  ).toEqual({ error: "Bad signature", valid: false });
  expect(
    parseVerifiedProviderNotice(
      { valid: true, value: { missing: "id" } },
      EventSchema,
      build,
    ),
  ).toEqual({ error: "Invalid webhook payload", valid: false });
  expect(
    parseVerifiedProviderNotice(
      { valid: true, value: { id: "event-two" } },
      EventSchema,
      build,
    ),
  ).toEqual(providerNotice("event-two", SESSION_RESOURCE, "payment.updated"));
});
