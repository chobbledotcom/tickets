import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeSequence,
  readDer,
  readDerChildren,
} from "#shared/crypto/der.ts";
import {
  importRsaPrivateKey,
  isValidRsaPrivateKey,
} from "#shared/crypto/rsa-private-key.ts";
import {
  generateGoogleTestCreds,
  generateTestCerts,
} from "#test-utils/crypto.ts";
import {
  pemFor,
  RSA_ENCRYPTION_OID,
  rsaAlgorithm,
  rsaPrivateKey,
} from "#test-utils/der.ts";
import { thrownError } from "#test-utils/errors.ts";

const pkcs8 = (key = rsaPrivateKey(), algorithm = rsaAlgorithm()): Uint8Array =>
  encodeSequence([encodeInteger(0), algorithm, encodeDer(0x04, [key])]);

/** Assert that a PKCS#8 AlgorithmIdentifier is rejected as non-RSA. */
const expectRsaAlgorithmRejected = (algorithm: Uint8Array): void => {
  expect(
    thrownError(() =>
      importRsaPrivateKey(
        pemFor("PRIVATE KEY", pkcs8(rsaPrivateKey(), algorithm)),
      ),
    ).message,
  ).toBe("Private key is not RSA");
};

describe("RSA private keys", () => {
  test("accepts the fixed PKCS#1 and PKCS#8 credentials", async () => {
    expect(await isValidRsaPrivateKey(generateTestCerts().signingKey)).toBe(
      true,
    );
    expect(
      await isValidRsaPrivateKey(generateGoogleTestCreds().serviceAccountKey),
    ).toBe(true);
  });

  test("rejects RSA values too small for a SHA-256 signature", async () => {
    expect(
      await isValidRsaPrivateKey(pemFor("RSA PRIVATE KEY", rsaPrivateKey())),
    ).toBe(false);
  });

  test("rejects an imported RSA key one bit below the 2048-bit minimum", async () => {
    const algorithm: RsaHashedKeyAlgorithm = {
      hash: { name: "SHA-256" },
      modulusLength: 2047,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    };
    const weakKey: CryptoKey = {
      algorithm,
      extractable: false,
      type: "private",
      usages: ["sign"],
    };
    const importStub = stub(crypto.subtle, "importKey", () =>
      Promise.resolve(weakKey),
    );
    try {
      expect(await isValidRsaPrivateKey(generateTestCerts().signingKey)).toBe(
        false,
      );
    } finally {
      importStub.restore();
    }
  });

  test("imports private keys as non-extractable", async () => {
    const key = await importRsaPrivateKey(generateTestCerts().signingKey);
    expect(key.extractable).toBe(false);
  });

  test("rejects an incomplete multi-prime RSA key", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", rsaPrivateKey(1))),
      ).message,
    ).toBe("Unsupported RSA private key version");
  });

  test("rejects extra fields on a two-prime RSA key", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", rsaPrivateKey(0, 10))),
      ).message,
    ).toBe("Unexpected RSA private key fields");
  });

  test("rejects incomplete and malformed PKCS#1 keys", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", rsaPrivateKey(0, 8))),
      ).message,
    ).toBe("Incomplete RSA private key");
    const fields = readDerChildren(readDer(rsaPrivateKey())).map(
      (field) => field.encoded,
    );
    fields[4] = encodeDer(0x04, [new Uint8Array([1])]);
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", encodeSequence(fields))),
      ).message,
    ).toBe("Invalid RSA private key field");
  });

  test("validates the first PKCS#1 field", () => {
    const fields = readDerChildren(readDer(rsaPrivateKey())).map(
      (field) => field.encoded,
    );
    fields[0] = encodeDer(0x04, [new Uint8Array([0])]);
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", encodeSequence(fields))),
      ).message,
    ).toBe("Invalid RSA private key field");
  });

  test("rejects an unsupported PKCS#1 version", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", rsaPrivateKey(2))),
      ).message,
    ).toBe("Unsupported RSA private key version");
  });

  test("rejects a non-sequence PKCS#1 key", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("RSA PRIVATE KEY", encodeInteger(0))),
      ).message,
    ).toBe("Invalid RSA private key");
  });

  test("rejects incomplete PKCS#8 keys", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(
          pemFor(
            "PRIVATE KEY",
            encodeSequence([encodeInteger(0), rsaAlgorithm()]),
          ),
        ),
      ).message,
    ).toBe("Incomplete private key");
  });

  test("rejects a non-RSA PKCS#8 algorithm", () => {
    expectRsaAlgorithmRejected(
      encodeSequence([encodeOid("1.2.840.10045.2.1"), encodeNull()]),
    );
  });

  test("rejects an RSA algorithm without NULL parameters", () => {
    expectRsaAlgorithmRejected(encodeSequence([encodeOid(RSA_ENCRYPTION_OID)]));
  });

  test("rejects non-NULL RSA algorithm parameters", () => {
    expectRsaAlgorithmRejected(
      encodeSequence([encodeOid(RSA_ENCRYPTION_OID), encodeInteger(0)]),
    );
  });

  test("rejects extra RSA algorithm parameters", () => {
    expectRsaAlgorithmRejected(
      encodeSequence([
        encodeOid(RSA_ENCRYPTION_OID),
        encodeNull(),
        encodeNull(),
      ]),
    );
  });

  test("rejects a malformed PKCS#8 algorithm", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(
          pemFor("PRIVATE KEY", pkcs8(rsaPrivateKey(), encodeInteger(1))),
        ),
      ).message,
    ).toBe("Invalid RSA algorithm");
  });

  test("rejects a non-sequence PKCS#8 key", () => {
    expect(
      thrownError(() =>
        importRsaPrivateKey(pemFor("PRIVATE KEY", encodeInteger(0))),
      ).message,
    ).toBe("Invalid private key");
  });

  test("rejects a mistagged PKCS#8 version", () => {
    const malformed = encodeSequence([
      encodeDer(0x04, [new Uint8Array([0])]),
      rsaAlgorithm(),
      encodeDer(0x04, [rsaPrivateKey()]),
    ]);
    expect(
      thrownError(() => importRsaPrivateKey(pemFor("PRIVATE KEY", malformed)))
        .message,
    ).toBe("Invalid private key version");
  });

  test("rejects malformed PKCS#8 private bytes", () => {
    const malformed = encodeSequence([
      encodeInteger(0),
      rsaAlgorithm(),
      encodeInteger(1),
    ]);
    expect(
      thrownError(() => importRsaPrivateKey(pemFor("PRIVATE KEY", malformed)))
        .message,
    ).toBe("Invalid private key bytes");
  });

  test("rejects encrypted and unrelated PEM values", async () => {
    expect(await isValidRsaPrivateKey(generateTestCerts().signingCert)).toBe(
      false,
    );
    expect(
      await isValidRsaPrivateKey(
        pemFor("ENCRYPTED PRIVATE KEY", new Uint8Array([1, 2, 3])),
      ),
    ).toBe(false);
  });

  test("does not hide an unexpected signing failure", async () => {
    const signStub = stub(crypto.subtle, "sign", () =>
      Promise.reject(new Error("signing unavailable")),
    );
    try {
      await expect(
        isValidRsaPrivateKey(generateTestCerts().signingKey),
      ).rejects.toThrow("signing unavailable");
    } finally {
      signStub.restore();
    }
  });

  test("maps Web Crypto key-data failures to invalid credentials", async () => {
    const failureStubs = [
      () =>
        stub(crypto.subtle, "importKey", () =>
          Promise.reject(new DOMException("bad key", "DataError")),
        ),
      () =>
        stub(crypto.subtle, "sign", () =>
          Promise.reject(new DOMException("bad values", "OperationError")),
        ),
    ];
    for (const makeStub of failureStubs) {
      const failureStub = makeStub();
      try {
        expect(await isValidRsaPrivateKey(generateTestCerts().signingKey)).toBe(
          false,
        );
      } finally {
        failureStub.restore();
      }
    }
  });
});
