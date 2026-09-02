import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hashEmail } from "#db/contact-preferences.ts";
import {
  buildBulkPayload,
  buildMailtoLink,
  resolveRecipientEmails,
} from "#shared/bulk-email.ts";
import {
  targetFromForm,
  targetFromQuery,
} from "#shared/bulk-email-targets/registry.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { BULK_UNSUBSCRIBE_PLACEHOLDER } from "#shared/email/bulk.ts";
import { FormParams } from "#shared/form-data.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describe("mailto links", () => {
  test("buildMailtoLink addresses a lone recipient directly without BCC", () => {
    expect(buildMailtoLink(["a@b.com"], "Hi there", "Body & more")).toBe(
      "mailto:a%40b.com?subject=Hi%20there&body=Body%20%26%20more",
    );
  });

  test("buildMailtoLink addresses a lone recipient with a business email", () => {
    expect(buildMailtoLink(["a@b.com"], "Hi", "Body", "owner@biz.com")).toBe(
      "mailto:a%40b.com?subject=Hi&body=Body",
    );
  });

  test("buildMailtoLink BCCs several recipients from the business email", () => {
    expect(
      buildMailtoLink(
        ["a@b.com", "c@d.com"],
        "Hi there",
        "Body & more",
        "owner@biz.com",
      ),
    ).toBe(
      "mailto:owner%40biz.com?bcc=a%40b.com,c%40d.com&subject=Hi%20there&body=Body%20%26%20more",
    );
  });

  test("buildMailtoLink leaves To empty without a business email", () => {
    expect(
      buildMailtoLink(["a@b.com", "c@d.com"], "Hi there", "Body & more"),
    ).toBe(
      "mailto:?bcc=a%40b.com,c%40d.com&subject=Hi%20there&body=Body%20%26%20more",
    );
  });

  test("buildMailtoLink omits empty parts", () => {
    expect(buildMailtoLink([], "", "")).toBe("mailto:?");
  });

  test("buildMailtoLink encodes line breaks as a single %0A", () => {
    expect(
      buildMailtoLink([], "", "line one\r\nline two\rline three\nend"),
    ).toBe("mailto:?body=line%20one%0Aline%20two%0Aline%20three%0Aend");
  });
});

describeWithEnv("buildBulkPayload", { encryptionKey: true }, () => {
  test("transactional sends reach everyone with no footer", async () => {
    const payload = await buildBulkPayload({
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      marketing: false,
      recipients: ["a@example.com", "b@example.com"],
      subject: "News",
      unsubscribed: new Set(),
    });
    expect(payload.html).toBe("<p>Hi</p>");
    expect(payload.subject).toBe("News");
    expect(payload.recipients).toEqual([
      { to: "a@example.com" },
      { to: "b@example.com" },
    ]);
  });

  test("marketing sends omit unsubscribed recipients", async () => {
    setEffectiveDomainForTest("tickets.example.com");
    const skipHash = await hashEmail("skip@example.com");
    try {
      const payload = await buildBulkPayload({
        bodyHtml: "<p>Hi</p>",
        bodyText: "Hi",
        marketing: true,
        recipients: ["keep@example.com", "skip@example.com"],
        subject: "Promo",
        unsubscribed: new Set([skipHash]),
      });
      const keepHash = await hashEmail("keep@example.com");
      expect(payload.html).toContain(
        `<a href="${BULK_UNSUBSCRIBE_PLACEHOLDER}">`,
      );
      expect(payload.text).toContain(
        `Unsubscribe or manage your preferences: ${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
      );
      expect(payload.recipients).toEqual([
        {
          to: "keep@example.com",
          unsubscribeUrl: `https://tickets.example.com/unsubscribe?email=${encodeURIComponent(keepHash)}`,
        },
      ]);
    } finally {
      resetEffectiveDomain();
    }
  });
});

describeWithEnv("resolveRecipientEmails", { db: true }, () => {
  const setup = async () => {
    const active = await createTestListing({
      maxAttendees: 50,
      name: "Active",
    });
    await createTestAttendeeDirect(active.id, "Alice", "alice@example.com");
    await createTestAttendeeDirect(active.id, "Bob", "bob@example.com");
    const past = await createTestListing({
      date: "2020-06-01T10:00",
      maxAttendees: 50,
      name: "Past",
    });
    await createTestAttendeeDirect(past.id, "Dave", "dave@example.com");
    await createTestAttendeeDirect(past.id, "Alice", "alice@example.com");
    const inactive = await createTestListing({
      maxAttendees: 50,
      name: "Inactive",
    });
    await createTestAttendeeDirect(inactive.id, "Carol", "carol@example.com");
    await deactivateTestListing(inactive.id);
    return { active, inactive, past, pk: await getTestPrivateKey() };
  };

  test("all-attendees audience returns every de-duplicated address", async () => {
    const { pk } = await setup();
    expect(
      await resolveRecipientEmails({ audience: "all", kind: "audience" }, pk),
    ).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
    ]);
  });

  test("normalises stored addresses before it returns recipients", async () => {
    const { active, pk } = await setup();
    await createTestAttendeeDirect(active.id, "Duplicate", " Bob@Example.com ");
    await createTestAttendeeDirect(active.id, "Blank", "   ");

    expect(
      await resolveRecipientEmails(
        { kind: "listing", listingId: active.id },
        pk,
      ),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("active audience excludes deactivated listings", async () => {
    const { pk } = await setup();
    expect(
      await resolveRecipientEmails(
        { audience: "active", kind: "audience" },
        pk,
      ),
    ).toEqual(["alice@example.com", "bob@example.com", "dave@example.com"]);
  });

  test("upcoming audience excludes past and inactive listings", async () => {
    const { pk } = await setup();
    expect(
      await resolveRecipientEmails(
        { audience: "upcoming", kind: "audience" },
        pk,
      ),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("listing target returns only that listing's attendees", async () => {
    const { past, pk } = await setup();
    expect(
      await resolveRecipientEmails({ kind: "listing", listingId: past.id }, pk),
    ).toEqual(["alice@example.com", "dave@example.com"]);
  });

  test("attendee target returns just that attendee's address", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Solo" });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Eve",
      "eve@example.com",
    );
    const pk = await getTestPrivateKey();
    expect(
      await resolveRecipientEmails({ kind: "attendee", token }, pk),
    ).toEqual(["eve@example.com"]);
  });

  test("unknown attendee token resolves to no recipients", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await resolveRecipientEmails(
        { kind: "attendee", token: "does-not-exist" },
        pk,
      ),
    ).toEqual([]);
  });
});

describeWithEnv("bulk-email target parsing", { db: true }, () => {
  test("parses valid listing targets from query and form fields", async () => {
    const listing = await createTestListing({ name: "Mailout" });
    await createTestAttendeeDirect(listing.id, "Amy", "amy@example.com");
    await expect(
      targetFromQuery(new URLSearchParams({ listing: String(listing.id) })),
    ).resolves.toEqual({ kind: "listing", listingId: listing.id });
    await expect(
      targetFromForm(new FormParams({ listing_id: String(listing.id) })),
    ).resolves.toEqual({ kind: "listing", listingId: listing.id });
  });

  test("rejects malformed listing target ids", async () => {
    const listing = await createTestListing({ name: "Mailout" });
    const malformedId = `${listing.id}x`;
    await expect(
      targetFromQuery(new URLSearchParams({ listing: malformedId })),
    ).resolves.toBeNull();
    await expect(
      targetFromForm(new FormParams({ listing_id: malformedId })),
    ).resolves.toBeNull();
  });
});
