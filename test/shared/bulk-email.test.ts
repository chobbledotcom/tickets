import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  resolveImageReferences,
  summarizeProviderResponse,
} from "#shared/bulk-email.ts";
import type {
  BatchMessageOutcome,
  BulkBatchResponse,
} from "#shared/email/bulk.ts";

const TOOK_ALL: BatchMessageOutcome = {
  reasons: [],
  refused: 0,
  unconfirmed: 0,
};

/** One batch reply. A provider that took every message refuses none. */
const reply = (
  status: number,
  body: string,
  outcome: BatchMessageOutcome = TOOK_ALL,
): BulkBatchResponse => ({ body, ok: status < 400, outcome, status });

describe("summarizeProviderResponse", () => {
  test("notes when there were no responses at all", () => {
    expect(summarizeProviderResponse([])).toBe(
      "The email provider sent no response.",
    );
  });

  test("reports just the status when the body is empty", () => {
    expect(summarizeProviderResponse([reply(200, "")])).toBe(
      "The email provider responded with HTTP 200.",
    );
  });

  test("includes the provider's reply body when present", () => {
    expect(summarizeProviderResponse([reply(200, '{"id":"abc-123"}')])).toBe(
      'The email provider responded with HTTP 200: {"id":"abc-123"}.',
    );
  });

  test("surfaces a failed batch's status and reason", () => {
    expect(summarizeProviderResponse([reply(429, "rate limit exceeded")])).toBe(
      "The email provider responded with HTTP 429: rate limit exceeded.",
    );
  });

  test("de-duplicates identical replies across batches", () => {
    expect(
      summarizeProviderResponse([reply(200, "queued"), reply(200, "queued")]),
    ).toBe("The email provider responded with HTTP 200: queued.");
  });

  test("joins distinct per-batch replies", () => {
    expect(
      summarizeProviderResponse([reply(200, "queued"), reply(422, "rejected")]),
    ).toBe(
      "The email provider responded with HTTP 200: queued; HTTP 422: rejected.",
    );
  });

  test("truncates an over-long reply", () => {
    const long = "x".repeat(1000);
    const summary = summarizeProviderResponse([reply(200, long)]);
    expect(summary).toContain("...");
    // Capped well below the raw body, which is never echoed in full.
    expect(summary.length).toBeLessThan(long.length);
    expect(summary).not.toContain(long);
  });

  test("names the messages an accepted batch refused anyway", () => {
    expect(
      summarizeProviderResponse([
        reply(200, "[]", {
          reasons: ["Postmark error 406: Inactive recipient"],
          refused: 2,
          unconfirmed: 0,
        }),
      ]),
    ).toBe(
      "The email provider responded with HTTP 200: []. It refused 2 messages." +
        " Postmark error 406: Inactive recipient.",
    );
  });

  test("counts one refused message in the singular", () => {
    expect(
      summarizeProviderResponse([
        reply(200, "[]", {
          reasons: ["Inactive recipient"],
          refused: 1,
          unconfirmed: 0,
        }),
      ]),
    ).toContain("It refused 1 message.");
  });

  test("still gives the refused count when no reason came back", () => {
    expect(
      summarizeProviderResponse([
        reply(429, "rate limit exceeded", {
          reasons: [],
          refused: 100,
          unconfirmed: 0,
        }),
      ]),
    ).toBe(
      "The email provider responded with HTTP 429: rate limit exceeded." +
        " It refused 100 messages.",
    );
  });

  test("adds the refused counts up across batches", () => {
    const refusal: BatchMessageOutcome = {
      reasons: ["Inactive recipient"],
      refused: 1,
      unconfirmed: 0,
    };
    expect(
      summarizeProviderResponse([
        reply(200, "[]", refusal),
        reply(200, "[]", refusal),
      ]),
    ).toBe(
      "The email provider responded with HTTP 200: []. It refused 2 messages." +
        " Inactive recipient.",
    );
  });

  test("warns about messages the provider did not confirm", () => {
    expect(
      summarizeProviderResponse([
        reply(200, "[]", { reasons: [], refused: 0, unconfirmed: 2 }),
      ]),
    ).toBe(
      "The email provider responded with HTTP 200: []." +
        " It did not confirm 2 messages. They may still have been sent." +
        " Check the provider before you send them again.",
    );
  });

  test("never calls an unconfirmed message a refusal", () => {
    const summary = summarizeProviderResponse([
      reply(200, "[]", { reasons: [], refused: 0, unconfirmed: 1 }),
    ]);

    expect(summary).toContain("It did not confirm 1 message.");
    expect(summary).not.toContain("refused");
  });

  test("separates two different refusal reasons", () => {
    expect(
      summarizeProviderResponse([
        reply(200, "[]", {
          reasons: ["Inactive recipient", "Hard bounce"],
          refused: 2,
          unconfirmed: 0,
        }),
      ]),
    ).toContain("It refused 2 messages. Inactive recipient; Hard bounce.");
  });

  test("caps an over-long list of refusal reasons", () => {
    const reasons = Array.from({ length: 40 }, (_, i) => `reason ${i} is long`);
    const summary = summarizeProviderResponse([
      reply(200, "[]", { reasons, refused: 40, unconfirmed: 0 }),
    ]);

    expect(summary).toContain("It refused 40 messages.");
    expect(summary).toContain("...");
    expect(summary).not.toContain(reasons.join("; "));
  });
});

describe("resolveImageReferences", () => {
  const urls = new Map([[5, "https://tickets.example/image/poster.webp"]]);

  test("replaces every reference the table holds with its address on the site", () => {
    expect(
      resolveImageReferences(
        "See ![Poster](img#5) and ![Poster](img#5).",
        urls,
      ),
    ).toBe(
      "See ![Poster](https://tickets.example/image/poster.webp) and ![Poster](https://tickets.example/image/poster.webp).",
    );
  });

  test("resolves a reference whose alt text escapes its brackets", () => {
    expect(resolveImageReferences("![Poster \\[blue\\]](img#5)", urls)).toBe(
      "![Poster \\[blue\\]](https://tickets.example/image/poster.webp)",
    );
  });

  test("resolves a titled reference and keeps its title", () => {
    expect(
      resolveImageReferences(
        'Poster: ![Poster](img#5 "our (best) poster")',
        urls,
      ),
    ).toBe(
      'Poster: ![Poster](https://tickets.example/image/poster.webp "our (best) poster")',
    );
  });

  test("keeps the written form of a reference the table lacks", () => {
    expect(resolveImageReferences("See ![Poster](img#7).", urls)).toBe(
      "See ![Poster](img#7).",
    );
  });

  test("keeps a web address that merely names an image", () => {
    expect(
      resolveImageReferences(
        "Directions: [the hall's page](https://example.org/img#5). See ![Poster](img#5).",
        urls,
      ),
    ).toBe(
      "Directions: [the hall's page](https://example.org/img#5). See ![Poster](https://tickets.example/image/poster.webp).",
    );
  });

  test("keeps the written form of a picture whose address is a web address", () => {
    expect(
      resolveImageReferences(
        "Poster: ![hall](https://files.example/hall.webp). See ![Poster](img#5).",
        urls,
      ),
    ).toBe(
      "Poster: ![hall](https://files.example/hall.webp). See ![Poster](https://tickets.example/image/poster.webp).",
    );
  });

  test("keeps prose that merely names an image", () => {
    expect(
      resolveImageReferences("Poster is picture img#5 on the wall.", urls),
    ).toBe("Poster is picture img#5 on the wall.");
  });

  test("keeps the written form when an escaped bracket closes the alt text", () => {
    expect(resolveImageReferences("![a\\](img#5)", urls)).toBe("![a\\](img#5)");
  });

  test("leaves a long run of backslashes after ![ alone", () => {
    const body = `![${"\\".repeat(10_000)}`;
    expect(resolveImageReferences(body, urls)).toBe(body);
  });

  test("keeps a reference inside a code span written as code", () => {
    expect(resolveImageReferences("`![Poster](img#5)`", urls)).toBe(
      "`![Poster](img#5)`",
    );
  });

  test("keeps a reference inside a fenced code block written as code", () => {
    const body = "```\n![Poster](img#5)\n```";
    expect(resolveImageReferences(body, urls)).toBe(body);
  });

  test("keeps code as code and resolves the picture beside it", () => {
    expect(
      resolveImageReferences(
        "Write `![Poster](img#5)` by hand: ![Poster](img#5).",
        urls,
      ),
    ).toBe(
      "Write `![Poster](img#5)` by hand: ![Poster](https://tickets.example/image/poster.webp).",
    );
  });
});
