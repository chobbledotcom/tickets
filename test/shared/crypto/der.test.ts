import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bytesEqual,
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeSequence,
  encodeSet,
  encodeTime,
  joinBytes,
  readDer,
  readDerChildren,
  readDerSequence,
  requireDerTag,
  sortDerValues,
} from "#crypto/der.ts";
import { thrownError } from "#test-utils/errors.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("DER", () => {
  test("joins byte arrays in order", () => {
    expect(joinBytes([bytes(1, 2), new Uint8Array(), bytes(3)])).toEqual(
      bytes(1, 2, 3),
    );
  });

  test("compares complete byte arrays", () => {
    expect(bytesEqual(bytes(1, 2), bytes(1, 2))).toBe(true);
    expect(bytesEqual(bytes(1, 2), bytes(1))).toBe(false);
    expect(bytesEqual(bytes(1, 2), bytes(1, 3))).toBe(false);
  });

  test("encodes short and long lengths minimally", () => {
    expect(encodeOctetString(new Uint8Array(127)).slice(0, 2)).toEqual(
      bytes(0x04, 0x7f),
    );
    expect(encodeOctetString(new Uint8Array(128)).slice(0, 3)).toEqual(
      bytes(0x04, 0x81, 0x80),
    );
    expect(encodeOctetString(new Uint8Array(256)).slice(0, 4)).toEqual(
      bytes(0x04, 0x82, 0x01, 0x00),
    );
    expect(encodeOctetString(new Uint8Array(65_536)).slice(0, 5)).toEqual(
      bytes(0x04, 0x83, 0x01, 0x00, 0x00),
    );
  });

  test("reads short and one-, two-, and three-byte long lengths", () => {
    for (const length of [127, 128, 256, 65_536]) {
      const payload = new Uint8Array(length);
      payload[length - 1] = 7;
      const value = readDer(encodeOctetString(payload));
      expect(value.contents.length).toBe(length);
      expect(value.contents[length - 1]).toBe(7);
    }
  });

  test("rejects unsupported tags", () => {
    for (const tag of [-2, -1, 0, 0x1f, 0xff, 0x100, 1.5]) {
      expect(thrownError(() => encodeDer(tag, [])).message).toBe(
        `Unsupported DER tag: ${tag}`,
      );
    }
  });

  test("accepts the lowest and highest supported one-byte tags", () => {
    expect(encodeDer(1, [])).toEqual(bytes(1, 0));
    expect(encodeDer(0xfe, [])).toEqual(bytes(0xfe, 0));
  });

  test("encodes non-negative integers minimally", () => {
    expect(encodeInteger(0)).toEqual(bytes(0x02, 0x01, 0x00));
    expect(encodeInteger(127)).toEqual(bytes(0x02, 0x01, 0x7f));
    expect(encodeInteger(128)).toEqual(bytes(0x02, 0x02, 0x00, 0x80));
    expect(encodeInteger(255)).toEqual(bytes(0x02, 0x02, 0x00, 0xff));
    expect(encodeInteger(256)).toEqual(bytes(0x02, 0x02, 0x01, 0x00));
    expect(encodeInteger(257)).toEqual(bytes(0x02, 0x02, 0x01, 0x01));
    expect(encodeInteger(65_535)).toEqual(bytes(0x02, 0x03, 0x00, 0xff, 0xff));
    expect(encodeInteger(65_536)).toEqual(bytes(0x02, 0x03, 0x01, 0x00, 0x00));
  });

  test("rejects invalid integer inputs", () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(thrownError(() => encodeInteger(value)).message).toBe(
        `Invalid DER integer: ${value}`,
      );
    }
  });

  test("encodes object identifiers", () => {
    expect(encodeOid("1.2.840.113549.1.1.1")).toEqual(
      bytes(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1),
    );
    expect(encodeOid("2.999.3")).toEqual(bytes(0x06, 0x03, 0x88, 0x37, 0x03));
    expect(encodeOid("1.39.128")).toEqual(bytes(0x06, 0x03, 0x4f, 0x81, 0x00));
  });

  test("rejects invalid object identifiers", () => {
    for (const oid of ["", "1", ".1", "1.", "1.a", "3.1", "1.40"]) {
      expect(thrownError(() => encodeOid(oid)).message).toBe(
        `Invalid OID: ${oid}`,
      );
    }
  });

  test("sorts SET values by complete DER bytes", () => {
    const one = encodeInteger(1);
    const two = encodeInteger(2);
    expect(sortDerValues([two, one])).toEqual([one, two]);
    expect(encodeSet([two, one])).toEqual(
      bytes(0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02),
    );
  });

  test("sorts a shorter equal-prefix value first", () => {
    expect(sortDerValues([bytes(1, 2), bytes(1)])).toEqual([
      bytes(1),
      bytes(1, 2),
    ]);
  });

  test("sorts values that differ in their first byte", () => {
    expect(sortDerValues([bytes(2), bytes(1)])).toEqual([bytes(1), bytes(2)]);
  });

  test("encodes ASN.1 NULL exactly", () => {
    expect(encodeNull()).toEqual(bytes(0x05, 0x00));
  });

  test("encodes UTC and generalized times", () => {
    const utc = readDer(encodeTime(new Date("2026-07-15T10:20:30Z")));
    const future = readDer(encodeTime(new Date("2050-01-02T03:04:05Z")));
    const past = readDer(encodeTime(new Date("1949-12-31T23:59:58Z")));
    expect(utc.tag).toBe(0x17);
    expect(new TextDecoder().decode(utc.contents)).toBe("260715102030Z");
    expect(future.tag).toBe(0x18);
    expect(new TextDecoder().decode(future.contents)).toBe("20500102030405Z");
    expect(past.tag).toBe(0x18);
    expect(new TextDecoder().decode(past.contents)).toBe("19491231235958Z");
  });

  test("uses UTC time at both inclusive year boundaries", () => {
    const first = readDer(encodeTime(new Date("1950-01-01T00:00:00Z")));
    const last = readDer(encodeTime(new Date("2049-12-31T23:59:59Z")));
    expect(first.tag).toBe(0x17);
    expect(new TextDecoder().decode(first.contents)).toBe("500101000000Z");
    expect(last.tag).toBe(0x17);
    expect(new TextDecoder().decode(last.contents)).toBe("491231235959Z");
  });

  test("pads every one-digit UTC time part", () => {
    const value = readDer(encodeTime(new Date("2009-09-09T09:09:09Z")));
    expect(new TextDecoder().decode(value.contents)).toBe("090909090909Z");
  });

  test("reads nested DER values without changing their bytes", () => {
    const first = encodeInteger(7);
    const second = encodeNull();
    const third = encodeOctetString(bytes(9));
    const sequence = encodeSequence([first, second, third]);
    const parent = readDer(sequence);
    expect(parent.tag).toBe(0x30);
    expect(parent.encoded).toEqual(sequence);
    expect(readDerChildren(parent).map((child) => child.encoded)).toEqual([
      first,
      second,
      third,
    ]);
    expect(requireDerTag(parent, 0x30, "sequence")).toBe(parent);
    expect(readDerSequence(sequence, "sequence")).toHaveLength(3);
  });

  test("rejects malformed DER encodings", () => {
    const malformed = [
      { bytes: bytes(0x30), error: "Truncated DER value" },
      { bytes: bytes(0, 0), error: "DER end-of-contents tag is forbidden" },
      { bytes: bytes(0x1f, 0), error: "High-number DER tags are unsupported" },
      { bytes: bytes(0x30, 0x80), error: "Indefinite DER length is forbidden" },
      { bytes: bytes(0x30, 0x84, 1, 0, 0, 0), error: "Invalid DER length" },
      { bytes: bytes(0x30, 0x82, 1), error: "Invalid DER length" },
      {
        bytes: bytes(0x30, 0x83, 1, 0, 0),
        error: "DER value exceeds its container",
      },
      { bytes: bytes(0x30, 0x82, 0, 0x80), error: "Non-minimal DER length" },
      { bytes: bytes(0x30, 0x81, 0x7f), error: "Non-minimal DER length" },
      { bytes: bytes(0x30, 2, 0), error: "DER value exceeds its container" },
      { bytes: bytes(0x05, 0, 0), error: "Trailing bytes after DER value" },
    ];
    for (const example of malformed) {
      expect(thrownError(() => readDer(example.bytes)).message).toBe(
        example.error,
      );
    }
  });

  test("rejects a malformed child value", () => {
    expect(
      thrownError(() => readDerChildren(readDer(bytes(0x30, 0x01, 0x00))))
        .message,
    ).toBe("Truncated DER value");
  });

  test("rejects a value with the wrong expected tag", () => {
    expect(
      thrownError(() => requireDerTag(readDer(encodeNull()), 0x30, "sequence"))
        .message,
    ).toBe("Invalid sequence");
  });
});
