import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readPem } from "#crypto/pem.ts";
import { pemFor } from "#test-utils/der.ts";
import { thrownError } from "#test-utils/errors.ts";

describe("PEM", () => {
  test("reads one allowed PEM block with surrounding whitespace", () => {
    const value = readPem(
      ` \r\n${pemFor("PRIVATE KEY", new Uint8Array([1, 2, 3])).replaceAll("\n", "\r\n")}\t`,
      ["PRIVATE KEY"],
    );
    expect(value.label).toBe("PRIVATE KEY");
    expect(value.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("reads a PEM block with no surrounding text", () => {
    expect(
      readPem(pemFor("PRIVATE KEY", new Uint8Array([4, 5])), ["PRIVATE KEY"])
        .bytes,
    ).toEqual(new Uint8Array([4, 5]));
  });

  test("reads a PEM block surrounded by export metadata", () => {
    const pem = [
      "Bag Attributes",
      "    localKeyID: 01 02 03",
      "    friendlyName: Wallet key",
      "Key Attributes: <No Attributes>",
      pemFor("PRIVATE KEY", new Uint8Array([6, 7])).trim(),
      "subject=CN=Exported key",
      "issuer=CN=Export issuer",
    ].join("\n");
    expect(readPem(pem, ["PRIVATE KEY"]).bytes).toEqual(new Uint8Array([6, 7]));
  });

  test("rejects a missing or extra PEM block", () => {
    expect(thrownError(() => readPem("not PEM", ["PRIVATE KEY"])).message).toBe(
      "Expected one PEM block",
    );
    const block = pemFor("PRIVATE KEY", new Uint8Array([1]));
    expect(
      thrownError(() => readPem(`${block}${block}`, ["PRIVATE KEY"])).message,
    ).toBe("Expected one PEM block");
  });

  test("rejects text outside the PEM block", () => {
    expect(
      thrownError(() =>
        readPem(`x${pemFor("PRIVATE KEY", new Uint8Array([1]))}`, [
          "PRIVATE KEY",
        ]),
      ).message,
    ).toBe("Unexpected data outside PEM block");
    expect(
      thrownError(() =>
        readPem(
          `Bag Attributes\n    unknownValue: no\n${pemFor("PRIVATE KEY", new Uint8Array([1]))}`,
          ["PRIVATE KEY"],
        ),
      ).message,
    ).toBe("Unexpected data outside PEM block");
  });

  test("rejects a PEM label not allowed by its caller", () => {
    expect(
      thrownError(() =>
        readPem(pemFor("CERTIFICATE", new Uint8Array([1])), ["PRIVATE KEY"]),
      ).message,
    ).toBe("Unexpected PEM label: CERTIFICATE");
  });

  test("rejects malformed base64", () => {
    expect(
      thrownError(() =>
        readPem(
          "-----BEGIN PRIVATE KEY-----\nnot-base64!\n-----END PRIVATE KEY-----",
          ["PRIVATE KEY"],
        ),
      ).message,
    ).toBe("Invalid PEM base64 data");
  });
});
