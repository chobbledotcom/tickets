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
import {
  importRsaPrivateKey,
  importRsaPublicKey,
} from "#shared/crypto/rsa-private-key.ts";
import { startOfHour } from "#shared/dates.ts";
import { readAppleCertificate, readCertificateBytes } from "./certificate.ts";

// Registered CMS, PKCS #9, PKCS #1, and NIST identifiers written on the wire.
const OID = {
  contentType: "1.2.840.113549.1.9.3",
  data: "1.2.840.113549.1.7.1",
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256: "2.16.840.1.101.3.4.2.1",
  signedData: "1.2.840.113549.1.7.2",
  signingTime: "1.2.840.113549.1.9.5",
} as const;

const algorithmIdentifier = (oid: string, includeNull = false): Uint8Array =>
  encodeSequence(
    includeNull ? [encodeOid(oid), encodeNull()] : [encodeOid(oid)],
  );

// CMS Attribute uses SET OF even when an attribute has only one value.
const attribute = (oid: string, value: Uint8Array): Uint8Array =>
  encodeSequence([encodeOid(oid), encodeSet([value])]);

const digest = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

// IMPLICIT tagging replaces the SET tag, but its children still require DER
// SET OF ordering.
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
    const [privateKey, publicKey] = await Promise.all([
      importRsaPrivateKey(signingKeyPem),
      importRsaPublicKey(certificate.publicKey),
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
  // Any successful sign-and-verify proves the pair; empty bytes keep this
  // check independent of pass content.
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
  // The WWDR intermediate is embedded, not used to verify the RSA signature;
  // Apple has issued both RSA and ECC WWDR certificates.
  const wwdrCertificate = readCertificateBytes(wwdrCertPem);
  const manifestDigest = await digest(manifest);
  const attributes = [
    attribute(OID.contentType, encodeOid(OID.data)),
    attribute(OID.messageDigest, encodeOctetString(manifestDigest)),
    attribute(OID.signingTime, encodeTime(signingTime)),
  ];
  // CMS signs the DER SET OF encoding (tag 0x31). SignerInfo stores the same
  // children below under the [0] IMPLICIT tag (0xa0).
  const signedAttributes = encodeSet(attributes);
  const { certificate: signingCertificate, signature } =
    await signWithCertificate(signedAttributes, signingCertPem, signingKeyPem);

  // SHA-256 AlgorithmIdentifier omits parameters. The rsaEncryption signature
  // identifier below uses NULL and takes its hash choice from digestAlgorithm.
  const digestAlgorithm = algorithmIdentifier(OID.sha256);
  const signerInfo = encodeSequence([
    // SignerInfo v1 is required for an issuer-and-serial-number signer ID.
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
    // SignedData v1 covers id-data, ordinary X.509 certificates, and v1 signers.
    encodeInteger(1),
    encodeSet([digestAlgorithm]),
    // Omitting eContent makes the signature detached: manifest.json is
    // supplied separately by the pass archive.
    encodeSequence([encodeOid(OID.data)]),
    // Apple needs both the signing and WWDR certificates to build its chain.
    implicitSet(0xa0, [signingCertificate.bytes, wwdrCertificate]),
    encodeSet([signerInfo]),
  ]);
  const cms = encodeSequence([
    encodeOid(OID.signedData),
    // ContentInfo wraps SignedData in [0] EXPLICIT, preserving its SEQUENCE tag.
    encodeDer(0xa0, [signedData]),
  ]);
  // Catch any malformed length or top-level envelope produced above.
  readDer(cms);
  return cms;
};
