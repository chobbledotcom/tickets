import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encode } from "uqr";
import { decodeImage } from "#shared/images/codecs.ts";
import {
  generateQrSvg,
  listingSupportsDirectCheckout,
  qrPng,
} from "#shared/qr.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SCALE = 8;
const URL = "https://example.com/t/abc123";

test("renders a QR code as a square PNG on the module grid", async () => {
  const png = await qrPng(URL);

  expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
  const image = await decodeImage(png, "image/png");
  expect(image.width).toBe(encode(URL, { border: 1 }).size * SCALE);
  expect(image.height).toBe(image.width);
});

test("draws one quiet border of white and a black square per dark module", async () => {
  const png = await qrPng(URL);
  const image = await decodeImage(png, "image/png");
  const qr = encode(URL, { border: 1 });
  const data = [...image.data];
  const red = data.filter((_, index) => index % 4 === 0);

  expect(red.slice(0, SCALE)).toEqual(Array(SCALE).fill(255));

  const darkColours = new Set<string>();
  let darkPixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] !== 0) continue;
    darkPixels += 1;
    darkColours.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
  }
  expect([...darkColours]).toEqual(["0,0,0"]);
  expect(darkPixels).toBe(
    qr.data.flat().filter(Boolean).length * SCALE * SCALE,
  );
});

test("different URLs produce different pictures", async () => {
  const first = await qrPng("https://example.com/t/aaa");
  const second = await qrPng("https://example.com/t/bbb");

  expect(first).not.toEqual(second);
});

test("keeps the quiet border in the SVG that a page shows", () => {
  const size = encode(URL, { border: 1 }).size;

  expect(generateQrSvg(URL)).toContain(
    `viewBox="0 0 ${size * 10} ${size * 10}"`,
  );
});

describeWithEnv("listingSupportsDirectCheckout", { db: true }, () => {
  test("sends a scanner to checkout when the listing asks nothing", async () => {
    const listing = await createTestListing({ fields: "" });

    expect(await listingSupportsDirectCheckout(listing)).toBe(true);
  });

  test("keeps the ticket page when the listing collects a contact field", async () => {
    const listing = await createTestListing({ fields: "email" });

    expect(await listingSupportsDirectCheckout(listing)).toBe(false);
  });

  test("keeps the ticket page when the listing has a question", async () => {
    const listing = await createTestListing({ fields: "" });
    await createQuestionWithAnswer([listing.id]);

    expect(await listingSupportsDirectCheckout(listing)).toBe(false);
  });
});
