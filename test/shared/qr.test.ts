import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encode } from "uqr";
import { decodeImage } from "#shared/images/codecs.ts";
import { qrPng } from "#shared/qr.ts";

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

test("draws one quiet border of white and a square per dark module", async () => {
  const png = await qrPng(URL);
  const image = await decodeImage(png, "image/png");
  const qr = encode(URL, { border: 1 });
  const red = [...image.data].filter((_, index) => index % 4 === 0);

  expect(red.slice(0, SCALE)).toEqual(Array(SCALE).fill(255));
  expect(red.filter((value) => value === 0)).toHaveLength(
    qr.data.flat().filter(Boolean).length * SCALE * SCALE,
  );
});

test("different URLs produce different pictures", async () => {
  const first = await qrPng("https://example.com/t/aaa");
  const second = await qrPng("https://example.com/t/bbb");

  expect(first).not.toEqual(second);
});
