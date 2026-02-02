import { describe, expect, test } from "#test-compat";
import { generateQrSvg } from "#lib/qr.ts";

describe("generateQrSvg", () => {
  test("returns an SVG string for a URL", async () => {
    const svg = await generateQrSvg("https://example.com/checkin/test-token");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  test("returns different SVGs for different inputs", async () => {
    const svg1 = await generateQrSvg("https://example.com/a");
    const svg2 = await generateQrSvg("https://example.com/b");
    expect(svg1).not.toBe(svg2);
  });
});
