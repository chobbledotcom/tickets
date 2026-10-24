import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rewriteImageDestinations } from "#shared/markdown.ts";

describe("rewriteImageDestinations", () => {
  const toPoster = (href: string): string | undefined =>
    href === "img#5" ? "/image/poster.webp" : undefined;

  test("rewrites the picture's address and keeps the rest of the source", () => {
    expect(rewriteImageDestinations("See ![A](img#5) now.", toPoster)).toBe(
      "See ![A](/image/poster.webp) now.",
    );
  });

  test("keeps the written form of an address the rewrite leaves alone", () => {
    expect(rewriteImageDestinations("See ![A](img#9) now.", toPoster)).toBe(
      "See ![A](img#9) now.",
    );
  });

  test("resolves a picture inside a link's text", () => {
    expect(rewriteImageDestinations("[![A](img#5)](https://x)", toPoster)).toBe(
      "[![A](/image/poster.webp)](https://x)",
    );
  });

  test("keeps a `![alt][label]` picture reference as written", () => {
    expect(rewriteImageDestinations("See ![A][5] now.", toPoster)).toBe(
      "See ![A][5] now.",
    );
  });

  test("keeps a picture's title when it rewrites the address", () => {
    expect(
      rewriteImageDestinations('See ![A](img#5 "the poster") now.', toPoster),
    ).toBe('See ![A](/image/poster.webp "the poster") now.');
  });

  test("keeps a title that holds a closing parenthesis", () => {
    expect(
      rewriteImageDestinations(
        'See ![A](img#5 "the (best) poster") now.',
        toPoster,
      ),
    ).toBe('See ![A](/image/poster.webp "the (best) poster") now.');
  });

  test("reads an address written in angle brackets", () => {
    expect(rewriteImageDestinations("See ![A](<img#5>) now.", toPoster)).toBe(
      "See ![A](/image/poster.webp) now.",
    );
  });

  test("keeps a defined `![alt][label]` picture reference as written", () => {
    expect(rewriteImageDestinations("![A][5]\n\n[5]: img#5", toPoster)).toBe(
      "![A][5]\n\n[5]: img#5",
    );
  });

  test("resolves a picture whose alt text ends in an escaped bracket", () => {
    expect(rewriteImageDestinations("![a\\](b](img#5)", toPoster)).toBe(
      "![a\\](b](/image/poster.webp)",
    );
  });
});
