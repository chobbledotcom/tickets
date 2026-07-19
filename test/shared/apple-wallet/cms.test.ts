import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { readCertificateBytes } from "#shared/apple-wallet/certificate.ts";
import {
  isValidAppleSigningPair,
  signManifest,
} from "#shared/apple-wallet/cms.ts";
import { createManifest, sha1Hex } from "#shared/apple-wallet.ts";
import {
  bytesEqual,
  encodeInteger,
  readDerChildren,
  readDerSequence,
  requireDerTag,
} from "#shared/crypto/der.ts";
import {
  generateGoogleTestCreds,
  generateTestCerts,
  getMismatchedAppleWalletKey,
} from "#test-utils/crypto.ts";
import { nonRsaCertificatePem } from "#test-utils/der.ts";
import { rejectedError } from "#test-utils/errors.ts";

const encoder = new TextEncoder();
const creds = generateTestCerts();

const opensslVerifies = async (
  manifest: string,
  signature: Uint8Array,
): Promise<boolean> => {
  const directory = await Deno.makeTempDir({ prefix: "wallet-cms-" });
  const manifestPath = `${directory}/manifest.json`;
  const signaturePath = `${directory}/signature.der`;
  try {
    await Promise.all([
      Deno.writeTextFile(manifestPath, manifest),
      Deno.writeFile(signaturePath, signature),
    ]);
    const result = await new Deno.Command("openssl", {
      args: [
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        signaturePath,
        "-content",
        manifestPath,
        "-noverify",
        "-out",
        "/dev/null",
      ],
      stderr: "null",
      stdout: "null",
    }).output();
    return result.success;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

const sign = (
  manifest: string,
  signingKey = creds.signingKey,
): Promise<Uint8Array> =>
  signManifest(manifest, creds.signingCert, signingKey, creds.wwdrCert);

describe("Apple Wallet signing", () => {
  test("hashes exact bytes with standard SHA-1 output", async () => {
    expect(await sha1Hex(new Uint8Array())).toBe(
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    );
    expect(await sha1Hex(encoder.encode("abc"))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
    expect(await sha1Hex(new Uint8Array([0, 128, 255]))).toBe(
      "f883686921f6ae7b94c63937715256438dc15d16",
    );
  });

  test("builds the exact compact manifest in file order", async () => {
    expect(
      await createManifest({
        "icon.png": encoder.encode("bbb"),
        "pass.json": encoder.encode("aaa"),
      }),
    ).toBe(
      '{"icon.png":"5cb138284d431abd6a053a56625ec088bfb88912","pass.json":"7e240de74fb1ed08fa08d38063f6a6a91462a815"}',
    );
  });

  test("creates a detached CMS signature OpenSSL accepts", async () => {
    const manifest = '{"pass.json":"abc123"}';

    expect(await opensslVerifies(manifest, await sign(manifest))).toBe(true);
  });

  test("uses the required CMS versions and algorithm parameters", async () => {
    const [_, signedDataWrapper] = readDerSequence(
      await sign("{}"),
      "CMS content info",
    );
    const [signedData] = readDerChildren(
      requireDerTag(signedDataWrapper!, 0xa0, "signed data"),
    );
    const signedDataFields = readDerSequence(
      signedData!.encoded,
      "CMS signed data",
    );
    expect(signedDataFields[0]!.encoded).toEqual(encodeInteger(1));

    const [digestAlgorithm] = readDerChildren(signedDataFields[1]!);
    expect(
      readDerSequence(digestAlgorithm!.encoded, "digest algorithm").map(
        ({ tag }) => tag,
      ),
    ).toEqual([0x06]);

    const [signerInfo] = readDerChildren(signedDataFields[4]!);
    const signerFields = readDerSequence(signerInfo!.encoded, "signer info");
    expect(signerFields[0]!.encoded).toEqual(encodeInteger(1));
    expect(
      readDerSequence(signerFields[4]!.encoded, "signature algorithm").map(
        ({ tag }) => tag,
      ),
    ).toEqual([0x06, 0x05]);
  });

  test("imports both signing keys as non-extractable", async () => {
    const importSpy = spy(crypto.subtle, "importKey");
    try {
      await sign("{}");
      expect(importSpy.calls.length).toBe(2);
      expect(importSpy.calls.map(({ args }) => args[3])).toEqual([
        false,
        false,
      ]);
    } finally {
      importSpy.restore();
    }
  });

  test("signs with an unencrypted PKCS#8 RSA key", async () => {
    const manifest = '{"pass.json":"pkcs8"}';
    const key = generateGoogleTestCreds().serviceAccountKey;

    expect(await opensslVerifies(manifest, await sign(manifest, key))).toBe(
      true,
    );
  });

  test("embeds a non-RSA WWDR intermediate", async () => {
    const manifest = await createManifest({
      "pass.json": encoder.encode("pass"),
    });
    const intermediatePem = nonRsaCertificatePem();
    const signature = await signManifest(
      manifest,
      creds.signingCert,
      creds.signingKey,
      intermediatePem,
    );
    const [_, signedDataWrapper] = readDerSequence(
      signature,
      "CMS content info",
    );
    const [signedData] = readDerChildren(
      requireDerTag(signedDataWrapper!, 0xa0, "signed data"),
    );
    const certificates = readDerChildren(
      readDerSequence(signedData!.encoded, "CMS signed data")[3]!,
    );
    const intermediate = readCertificateBytes(intermediatePem);
    expect(
      certificates.some((certificate) =>
        bytesEqual(certificate.encoded, intermediate),
      ),
    ).toBe(true);
  });

  test("binds the detached signature to the exact manifest bytes", async () => {
    const manifest = '{"pass.json":"abc123"}';

    expect(await opensslVerifies(`${manifest} `, await sign(manifest))).toBe(
      false,
    );
  });

  test("rejects a private key that does not match the signing certificate", async () => {
    expect(
      (await rejectedError(sign("{}", getMismatchedAppleWalletKey()))).message,
    ).toBe("Apple Wallet signing key does not match its certificate");
  });

  test("reports whether a signing certificate and key belong together", async () => {
    expect(
      await isValidAppleSigningPair(creds.signingCert, creds.signingKey),
    ).toBe(true);
    expect(
      await isValidAppleSigningPair(
        creds.signingCert,
        getMismatchedAppleWalletKey(),
      ),
    ).toBe(false);
  });

  test("does not turn a signing failure into a credential mismatch", async () => {
    const signStub = stub(crypto.subtle, "sign", () =>
      Promise.reject(new Error("crypto unavailable")),
    );
    try {
      await expect(
        isValidAppleSigningPair(creds.signingCert, creds.signingKey),
      ).rejects.toThrow("crypto unavailable");
    } finally {
      signStub.restore();
    }
  });
});
