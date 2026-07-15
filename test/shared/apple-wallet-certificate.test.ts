import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isValidAppleCertificate,
  readAppleCertificate,
} from "#shared/apple-wallet/certificate.ts";
import {
  encodeDer,
  encodeInteger,
  encodeOid,
  encodeSequence,
} from "#shared/crypto/der.ts";
import { generateTestCerts } from "#test-utils/crypto.ts";
import { pemFor, rsaAlgorithm } from "#test-utils/der.ts";
import { thrownError } from "#test-utils/errors.ts";

const bitString = (): Uint8Array => encodeDer(0x03, [new Uint8Array([0, 1])]);

const certificate = (
  bodyFields: readonly Uint8Array[],
  signatureAlgorithm = rsaAlgorithm(),
  signature = bitString(),
): Uint8Array =>
  encodeSequence([encodeSequence(bodyFields), signatureAlgorithm, signature]);

const body = (
  publicKey = encodeSequence([rsaAlgorithm(), bitString()]),
  includeVersion = true,
): Uint8Array[] => [
  ...(includeVersion ? [encodeDer(0xa0, [encodeInteger(2)])] : []),
  encodeInteger(42),
  rsaAlgorithm(),
  encodeSequence([encodeInteger(7)]),
  encodeSequence([]),
  encodeSequence([]),
  publicKey,
];

const expectCertificateError = (bytes: Uint8Array, message: string): void => {
  expect(
    thrownError(() => readAppleCertificate(pemFor("CERTIFICATE", bytes)))
      .message,
  ).toBe(message);
};

describe("Apple Wallet certificates", () => {
  test("extracts signing fields from the fixed RSA certificate", () => {
    const parsed = readAppleCertificate(generateTestCerts().signingCert);
    expect(parsed.serialNumber).toEqual(new Uint8Array([0x02, 0x01, 0x02]));
    expect(parsed.issuer[0]).toBe(0x30);
    expect(parsed.publicKey[0]).toBe(0x30);
    expect(parsed.bytes.length).toBeGreaterThan(500);
  });

  test("accepts v1 certificates without an explicit version", () => {
    const encoded = certificate(body(undefined, false));
    const parsed = readAppleCertificate(pemFor("CERTIFICATE", encoded));
    expect(parsed.serialNumber).toEqual(encodeInteger(42));
    expect(parsed.issuer).toEqual(encodeSequence([encodeInteger(7)]));
  });

  test("accepts the alternate X509 certificate label", () => {
    const encoded = certificate(body());
    expect(isValidAppleCertificate(pemFor("X509 CERTIFICATE", encoded))).toBe(
      true,
    );
  });

  test("rejects a certificate with the wrong outer fields", () => {
    expectCertificateError(
      encodeSequence([encodeSequence(body())]),
      "Invalid certificate fields",
    );
    expectCertificateError(
      encodeSequence([encodeInteger(1), rsaAlgorithm(), bitString()]),
      "Invalid certificate body",
    );
    expectCertificateError(
      certificate(body(), encodeInteger(1)),
      "Invalid certificate signature algorithm",
    );
    expectCertificateError(
      certificate(body(), rsaAlgorithm(), encodeInteger(1)),
      "Invalid certificate signature",
    );
    expectCertificateError(encodeInteger(1), "Invalid certificate");
  });

  test("rejects missing and mistagged certificate body fields", () => {
    expectCertificateError(certificate([]), "Certificate has no serial number");
    const wrongSerial = body();
    wrongSerial[1] = encodeSequence([]);
    expectCertificateError(
      certificate(wrongSerial),
      "Invalid certificate serial number",
    );
  });

  test("rejects every mistagged certificate body field", () => {
    for (const [index, label] of [
      [2, "signature algorithm"],
      [3, "issuer"],
      [4, "validity"],
      [5, "subject"],
      [6, "public key"],
    ] as const) {
      const fields = body();
      fields[index] = encodeInteger(1);
      expectCertificateError(
        certificate(fields),
        `Invalid certificate ${label}`,
      );
    }
  });

  test("rejects a non-RSA public key", () => {
    const ecAlgorithm = encodeSequence([encodeOid("1.2.840.10045.2.1")]);
    const publicKey = encodeSequence([ecAlgorithm, bitString()]);
    expectCertificateError(
      certificate(body(publicKey)),
      "Certificate public key is not RSA",
    );
  });

  test("rejects incomplete public-key information", () => {
    const noAlgorithm = encodeSequence([]);
    expectCertificateError(
      certificate(body(noAlgorithm)),
      "Certificate has no public-key algorithm",
    );
    const noOid = encodeSequence([encodeSequence([])]);
    expectCertificateError(
      certificate(body(noOid)),
      "Certificate has no public-key OID",
    );
    const noKey = encodeSequence([rsaAlgorithm()]);
    expectCertificateError(
      certificate(body(noKey)),
      "Certificate has no public key",
    );
  });

  test("returns false instead of suppressing malformed certificate details", () => {
    expect(isValidAppleCertificate("not a certificate")).toBe(false);
  });
});
