import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type BulkEmailDraft,
  contactFrequencySummary,
  MAX_BULK_EMAIL_SUBJECT_LENGTH,
  parseDraft,
  serializeDraft,
  validateDraftInput,
} from "#shared/bulk-email.ts";
import {
  targetComposeControl,
  targetQuery,
} from "#shared/bulk-email-targets/registry.ts";
import {
  AUDIENCES,
  audienceById,
  DEFAULT_AUDIENCE_ID,
  isAudienceId,
} from "#shared/bulk-email-targets/types.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";

const audienceTarget = (audience: BulkEmailDraft["target"]) => audience;

describe("bulk-email audiences and targets", () => {
  test("AUDIENCES has a stable default that exists in the registry", () => {
    expect(isAudienceId(DEFAULT_AUDIENCE_ID)).toBe(true);
    expect(
      AUDIENCES.some((audience) => audience.id === DEFAULT_AUDIENCE_ID),
    ).toBe(true);
  });

  test("isAudienceId rejects unknown ids", () => {
    expect(isAudienceId("active")).toBe(true);
    expect(isAudienceId("nonsense")).toBe(false);
  });

  test("audienceById returns the matching definition", () => {
    expect(audienceById("all").label).toBe("All attendees");
  });

  test("targetQuery round-trips audience and listing targets", () => {
    expect(targetQuery({ audience: "upcoming", kind: "audience" })).toBe(
      "?audience=upcoming",
    );
    expect(targetQuery({ kind: "listing", listingId: 7 })).toBe("?listing=7");
  });

  test("targetQuery URL-encodes an attendee token", () => {
    expect(targetQuery({ kind: "attendee", token: "abc/def+ghi" })).toBe(
      "?attendee=abc%2Fdef%2Bghi",
    );
  });

  test("targetComposeControl drives the recipient control per kind", () => {
    const audience = targetComposeControl({
      audience: "active",
      kind: "audience",
    });
    expect(audience.mode).toBe("select");
    if (audience.mode === "select") {
      expect(audience.name).toBe("audience");
      expect(audience.selected).toBe("active");
      expect(audience.options.map((option) => option.value)).toEqual(
        AUDIENCES.map((entry) => entry.id),
      );
    }
    expect(targetComposeControl({ kind: "listing", listingId: 7 })).toEqual({
      fields: [["listing_id", "7"]],
      mode: "fixed",
    });
    expect(targetComposeControl({ kind: "attendee", token: "tok" })).toEqual({
      fields: [["attendee", "tok"]],
      mode: "fixed",
    });
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

describe("contactFrequencySummary", () => {
  test("is empty with no recipients", () => {
    expect(contactFrequencySummary([])).toBe("");
  });

  test("reports never-contacted when all counts are zero", () => {
    expect(contactFrequencySummary([0, 0, 0])).toBe(
      "These attendees have never been contacted through this page.",
    );
  });

  test("reports a whole number when the average is an integer", () => {
    expect(contactFrequencySummary([2, 2, 2])).toBe(
      "These attendees have been contacted through this page 2 times each.",
    );
  });

  test("reports a one-decimal average otherwise", () => {
    expect(contactFrequencySummary([1, 2])).toBe(
      "These attendees have been contacted through this page an average of 1.5 times each.",
    );
  });
});
