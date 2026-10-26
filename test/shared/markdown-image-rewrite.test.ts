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

  test("resolves a defined reference-style picture and its definition", () => {
    expect(rewriteImageDestinations("![A][5]\n\n[5]: img#5", toPoster)).toBe(
      "![A](/image/poster.webp)\n\n[5]: /image/poster.webp",
    );
  });

  test("keeps a repeated definition line the table does not resolve", () => {
    expect(
      rewriteImageDestinations("[5]: img#9\n\n[5]: img#7\n\n![A][5]", toPoster),
    ).toBe("[5]: img#9\n\n[5]: img#7\n\n![A][5]");
  });

  test("resolves a reference-style picture the prose surrounds", () => {
    expect(
      rewriteImageDestinations("See ![A][5] now.\n\n[5]: img#5", toPoster),
    ).toBe("See ![A](/image/poster.webp) now.\n\n[5]: /image/poster.webp");
  });

  test("resolves a collapsed reference-style picture", () => {
    expect(rewriteImageDestinations("![A][]\n\n[A]: img#5", toPoster)).toBe(
      "![A](/image/poster.webp)\n\n[A]: /image/poster.webp",
    );
  });

  test("resolves a bare reference-style picture", () => {
    expect(rewriteImageDestinations("![A]\n\n[A]: img#5", toPoster)).toBe(
      "![A](/image/poster.webp)\n\n[A]: /image/poster.webp",
    );
  });

  test("resolves a reference-style picture whose alt escapes its brackets", () => {
    expect(rewriteImageDestinations("![A\\]][5]\n\n[5]: img#5", toPoster)).toBe(
      "![A\\]](/image/poster.webp)\n\n[5]: /image/poster.webp",
    );
  });

  test("keeps a definition's title when it resolves the address", () => {
    expect(
      rewriteImageDestinations('![A][5]\n\n[5]: img#5 "the poster"', toPoster),
    ).toBe('![A](/image/poster.webp)\n\n[5]: /image/poster.webp "the poster"');
  });

  test("reads a definition's address written in angle brackets", () => {
    expect(rewriteImageDestinations("![A][5]\n\n[5]: <img#5>", toPoster)).toBe(
      "![A](/image/poster.webp)\n\n[5]: /image/poster.webp",
    );
  });

  test("keeps a definition whose address the rewrite leaves alone", () => {
    expect(rewriteImageDestinations("![A][9]\n\n[9]: img#9", toPoster)).toBe(
      "![A][9]\n\n[9]: img#9",
    );
  });

  test("keeps a definition whose address is a web address", () => {
    expect(
      rewriteImageDestinations(
        "![A][hall]\n\n[hall]: https://files.example/hall.webp",
        toPoster,
      ),
    ).toBe("![A][hall]\n\n[hall]: https://files.example/hall.webp");
  });

  test("resolves a reference-style picture inside a link's text", () => {
    expect(
      rewriteImageDestinations("[![A][5]](https://x)\n\n[5]: img#5", toPoster),
    ).toBe("[![A](/image/poster.webp)](https://x)\n\n[5]: /image/poster.webp");
  });

  test("resolves a picture inside a multi-line blockquote", () => {
    expect(rewriteImageDestinations("> ![A](img#5)\n>\n> text", toPoster)).toBe(
      "> ![A](/image/poster.webp)\n>\n> text",
    );
  });

  test("resolves a reference-style picture inside a multi-line blockquote", () => {
    expect(
      rewriteImageDestinations("> ![A][5]\n>\n> [5]: img#5", toPoster),
    ).toBe("> ![A](/image/poster.webp)\n>\n> [5]: /image/poster.webp");
  });

  test("resolves a picture whose alt text ends in an escaped bracket", () => {
    expect(rewriteImageDestinations("![a\\](b](img#5)", toPoster)).toBe(
      "![a\\](b](/image/poster.webp)",
    );
  });
});
