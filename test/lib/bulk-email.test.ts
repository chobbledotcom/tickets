import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  AUDIENCES,
  audienceById,
  type BulkEmailDraft,
  buildBulkMessages,
  buildMailtoLink,
  DEFAULT_AUDIENCE_ID,
  dedupeEmails,
  isAudienceId,
  isBulkEmailTarget,
  MAX_BULK_EMAIL_SUBJECT_LENGTH,
  marketingFooterHtml,
  marketingFooterText,
  parseDraft,
  resolveRecipientEmails,
  serializeDraft,
  targetQuery,
  unsubscribeUrl,
  validateDraftInput,
} from "#shared/bulk-email.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { hashEmail } from "#shared/db/unsubscribes.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { describeWithEnv, getTestPrivateKey } from "#test-utils";
import {
  createTestAttendeeDirect,
  createTestEvent,
  deactivateTestEvent,
} from "#test-utils/db-helpers.ts";

const audienceTarget = (audience: BulkEmailDraft["target"]) => audience;

describe("bulk-email audiences and targets", () => {
  test("AUDIENCES has a stable default that exists in the registry", () => {
    expect(isAudienceId(DEFAULT_AUDIENCE_ID)).toBe(true);
    expect(AUDIENCES.some((a) => a.id === DEFAULT_AUDIENCE_ID)).toBe(true);
  });

  test("isAudienceId rejects unknown ids", () => {
    expect(isAudienceId("active")).toBe(true);
    expect(isAudienceId("nonsense")).toBe(false);
  });

  test("audienceById returns the matching definition", () => {
    expect(audienceById("all").label).toBe("All attendees");
  });

  test("targetQuery round-trips audience and event targets", () => {
    expect(targetQuery({ audience: "upcoming", kind: "audience" })).toBe(
      "?audience=upcoming",
    );
    expect(targetQuery({ eventId: 7, kind: "event" })).toBe("?event=7");
  });

  test("isBulkEmailTarget validates shape", () => {
    expect(isBulkEmailTarget({ audience: "active", kind: "audience" })).toBe(
      true,
    );
    expect(isBulkEmailTarget({ eventId: 3, kind: "event" })).toBe(true);
    expect(isBulkEmailTarget({ audience: "bogus", kind: "audience" })).toBe(
      false,
    );
    expect(isBulkEmailTarget({ kind: "audience" })).toBe(false);
    expect(isBulkEmailTarget({ eventId: 1.5, kind: "event" })).toBe(false);
    expect(isBulkEmailTarget({ kind: "event" })).toBe(false);
    expect(isBulkEmailTarget({ kind: "other" })).toBe(false);
    expect(isBulkEmailTarget(null)).toBe(false);
    expect(isBulkEmailTarget("nope")).toBe(false);
  });
});

describe("dedupeEmails", () => {
  test("trims, drops blanks, dedupes case-insensitively, and sorts", () => {
    expect(
      dedupeEmails([
        " Bob@Example.com ",
        "bob@example.com",
        "",
        "   ",
        "alice@example.com",
      ]),
    ).toEqual(["alice@example.com", "Bob@Example.com"]);
  });
});

describe("bulk-email draft validation and serialization", () => {
  const target = audienceTarget({ audience: "active", kind: "audience" });

  test("accepts a valid draft", () => {
    const result = validateDraftInput({
      body: "Hello there",
      marketing: true,
      subject: "Subject",
      target,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.draft.subject).toBe("Subject");
      expect(result.draft.marketing).toBe(true);
    }
  });

  test("rejects an empty subject", () => {
    const result = validateDraftInput({
      body: "Body",
      marketing: false,
      subject: "   ",
      target,
    });
    expect(result).toEqual({ error: "Subject is required", valid: false });
  });

  test("rejects an over-length subject", () => {
    const result = validateDraftInput({
      body: "Body",
      marketing: false,
      subject: "x".repeat(MAX_BULK_EMAIL_SUBJECT_LENGTH + 1),
      target,
    });
    expect(result.valid).toBe(false);
  });

  test("rejects an empty body", () => {
    const result = validateDraftInput({
      body: "  ",
      marketing: false,
      subject: "Subject",
      target,
    });
    expect(result).toEqual({ error: "Message body is required", valid: false });
  });

  test("rejects an over-length body", () => {
    const result = validateDraftInput({
      body: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      marketing: false,
      subject: "Subject",
      target,
    });
    expect(result.valid).toBe(false);
  });

  test("serialize/parse round-trips", () => {
    const draft: BulkEmailDraft = {
      body: "Body",
      marketing: true,
      subject: "Subject",
      target,
    };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });

  test("parseDraft returns null for empty, malformed, or invalid drafts", () => {
    expect(parseDraft("")).toBe(null);
    expect(parseDraft("{not json")).toBe(null);
    expect(parseDraft(JSON.stringify({ subject: 1 }))).toBe(null);
    expect(
      parseDraft(
        JSON.stringify({
          body: "b",
          marketing: false,
          subject: "s",
          target: { audience: "bogus", kind: "audience" },
        }),
      ),
    ).toBe(null);
  });
});

describe("mailto and unsubscribe footers", () => {
  test("buildMailtoLink BCCs everyone with subject and body", () => {
    expect(
      buildMailtoLink(["a@b.com", "c@d.com"], "Hi there", "Body & more"),
    ).toBe(
      "mailto:?bcc=a%40b.com,c%40d.com&subject=Hi%20there&body=Body%20%26%20more",
    );
  });

  test("buildMailtoLink omits empty parts", () => {
    expect(buildMailtoLink([], "", "")).toBe("mailto:?");
  });

  test("unsubscribeUrl includes the hash, encoded", () => {
    setEffectiveDomainForTest("tickets.example.com");
    try {
      expect(unsubscribeUrl("a+b/c=")).toBe(
        "https://tickets.example.com/unsubscribe?email=a%2Bb%2Fc%3D",
      );
    } finally {
      resetEffectiveDomain();
    }
  });

  test("footers reference the unsubscribe url", () => {
    expect(marketingFooterHtml("https://x/u")).toContain(
      '<a href="https://x/u">',
    );
    expect(marketingFooterText("https://x/u")).toContain("https://x/u");
  });
});

describeWithEnv("buildBulkMessages", { encryptionKey: true }, () => {
  test("transactional sends reach everyone with no footer", async () => {
    const messages = await buildBulkMessages({
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      marketing: false,
      recipients: ["a@example.com", "b@example.com"],
      unsubscribed: new Set(),
    });
    expect(messages).toEqual([
      { html: "<p>Hi</p>", text: "Hi", to: "a@example.com" },
      { html: "<p>Hi</p>", text: "Hi", to: "b@example.com" },
    ]);
  });

  test("marketing sends skip unsubscribed and append a per-recipient footer", async () => {
    const skipHash = await hashEmail("skip@example.com");
    const messages = await buildBulkMessages({
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      marketing: true,
      recipients: ["keep@example.com", "skip@example.com"],
      unsubscribed: new Set([skipHash]),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe("keep@example.com");
    expect(messages[0]!.html.startsWith("<p>Hi</p>")).toBe(true);
    expect(messages[0]!.html).toContain("/unsubscribe?email=");
    expect(messages[0]!.text).toContain("/unsubscribe?email=");
  });
});

describeWithEnv("resolveRecipientEmails", { db: true }, () => {
  const setup = async () => {
    const active = await createTestEvent({ maxAttendees: 50, name: "Active" });
    await createTestAttendeeDirect(active.id, "Alice", "alice@example.com");
    await createTestAttendeeDirect(active.id, "Bob", "bob@example.com");

    const past = await createTestEvent({
      date: "2020-06-01T10:00",
      maxAttendees: 50,
      name: "Past",
    });
    await createTestAttendeeDirect(past.id, "Dave", "dave@example.com");
    // Alice also booked the past event — proves cross-event de-duplication.
    await createTestAttendeeDirect(past.id, "Alice", "alice@example.com");

    const inactive = await createTestEvent({
      maxAttendees: 50,
      name: "Inactive",
    });
    await createTestAttendeeDirect(inactive.id, "Carol", "carol@example.com");
    await deactivateTestEvent(inactive.id);

    return { active, inactive, past, pk: await getTestPrivateKey() };
  };

  test("all-attendees audience returns every address, de-duplicated", async () => {
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

  test("active audience excludes deactivated events", async () => {
    const { pk } = await setup();
    expect(
      await resolveRecipientEmails(
        { audience: "active", kind: "audience" },
        pk,
      ),
    ).toEqual(["alice@example.com", "bob@example.com", "dave@example.com"]);
  });

  test("upcoming audience excludes past-dated and inactive events", async () => {
    const { pk } = await setup();
    expect(
      await resolveRecipientEmails(
        { audience: "upcoming", kind: "audience" },
        pk,
      ),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("event target returns only that event's attendees", async () => {
    const { past, pk } = await setup();
    expect(
      await resolveRecipientEmails({ eventId: past.id, kind: "event" }, pk),
    ).toEqual(["alice@example.com", "dave@example.com"]);
  });
});
