import {
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeSequence,
  encodeSet,
  encodeTime,
  readDer,
  sortDerValues,
} from "#shared/crypto/der.ts";
import { rsaPrivateKeyBytes } from "#shared/crypto/rsa-private-key.ts";
import { startOfHour } from "#shared/dates.ts";
import { readAppleCertificate } from "./certificate.ts";

const OID = {
  contentType: "1.2.840.113549.1.9.3",
  data: "1.2.840.113549.1.7.1",
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256: "2.16.840.1.101.3.4.2.1",
  signedData: "1.2.840.113549.1.7.2",
  signingTime: "1.2.840.113549.1.9.5",
} as const;

const RSA_SHA256: RsaHashedImportParams = {
  hash: "SHA-256",
  name: "RSASSA-PKCS1-v1_5",
};

const algorithmIdentifier = (oid: string, includeNull = false): Uint8Array =>
  encodeSequence(
    includeNull ? [encodeOid(oid), encodeNull()] : [encodeOid(oid)],
  );

const attribute = (oid: string, value: Uint8Array): Uint8Array =>
  encodeSequence([encodeOid(oid), encodeSet([value])]);

const digest = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

const importRsaKey = (
  format: "pkcs8" | "spki",
  bytes: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(format, bytes as BufferSource, RSA_SHA256, false, [
    usage,
  ]);

const implicitSet = (tag: number, values: readonly Uint8Array[]): Uint8Array =>
  encodeDer(tag, sortDerValues(values));

type AppleSignature = {
  certificate: ReturnType<typeof readAppleCertificate>;
  matchesCertificate: boolean;
  signature: Uint8Array;
};

/** Sign bytes and check the result against the certificate's public key. */
const createAppleSignature =
  (
    signingCertPem: string,
    signingKeyPem: string,
  ): ((data: Uint8Array) => Promise<AppleSignature>) =>
  async (data) => {
    const certificate = readAppleCertificate(signingCertPem);
    const privateKeyBytes = rsaPrivateKeyBytes(signingKeyPem);
    const [privateKey, publicKey] = await Promise.all([
      importRsaKey("pkcs8", privateKeyBytes, "sign"),
      importRsaKey("spki", certificate.publicKey, "verify"),
    ]);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        data as BufferSource,
      ),
    );
    const matchesCertificate = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      data as BufferSource,
    );
    return { certificate, matchesCertificate, signature };
  };

/** Sign bytes, failing when the private key does not belong to the certificate. */
const signWithCertificate = async (
  data: Uint8Array,
  signingCertPem: string,
  signingKeyPem: string,
): Promise<AppleSignature> => {
  const signed = await createAppleSignature(
    signingCertPem,
    signingKeyPem,
  )(data);
  if (!signed.matchesCertificate) {
    throw new Error("Apple Wallet signing key does not match its certificate");
  }
  return signed;
};

/** Whether an Apple signing certificate and private key belong together. */
export const isValidAppleSigningPair = async (
  signingCertPem: string,
  signingKeyPem: string,
): Promise<boolean> =>
  (await createAppleSignature(signingCertPem, signingKeyPem)(new Uint8Array()))
    .matchesCertificate;

/** Create an Apple-compatible detached CMS signature over manifest JSON. */
export const signManifest = async (
  manifestData: string,
  signingCertPem: string,
  signingKeyPem: string,
  wwdrCertPem: string,
): Promise<Uint8Array> => {
  const signingTime = startOfHour(new Date());
  const manifest = new TextEncoder().encode(manifestData);
  const wwdrCertificate = readAppleCertificate(wwdrCertPem);
  const manifestDigest = await digest(manifest);
  const attributes = [
    attribute(OID.contentType, encodeOid(OID.data)),
    attribute(OID.messageDigest, encodeOctetString(manifestDigest)),
    attribute(OID.signingTime, encodeTime(signingTime)),
  ];
  const signedAttributes = encodeSet(attributes);
  const { certificate: signingCertificate, signature } =
    await signWithCertificate(signedAttributes, signingCertPem, signingKeyPem);

  const digestAlgorithm = algorithmIdentifier(OID.sha256);
  const signerInfo = encodeSequence([
    encodeInteger(1),
    encodeSequence([
      signingCertificate.issuer,
      signingCertificate.serialNumber,
    ]),
    digestAlgorithm,
    implicitSet(0xa0, attributes),
    algorithmIdentifier(OID.rsaEncryption, true),
    encodeOctetString(signature),
  ]);
  const signedData = encodeSequence([
    encodeInteger(1),
    encodeSet([digestAlgorithm]),
    encodeSequence([encodeOid(OID.data)]),
    implicitSet(0xa0, [signingCertificate.bytes, wwdrCertificate.bytes]),
    encodeSet([signerInfo]),
  ]);
  const cms = encodeSequence([
    encodeOid(OID.signedData),
    encodeDer(0xa0, [signedData]),
  ]);
  readDer(cms);
  return cms;
};
