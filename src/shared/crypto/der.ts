/** Minimal DER TLV codec for the RSA, X.509, and CMS shapes used here. */

export interface DerValue {
  contents: Uint8Array;
  encoded: Uint8Array;
  tag: number;
}

export const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** Equality for public DER metadata only; this exits early and is not safe for secrets. */
export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const unsignedBytes = (value: number): number[] => {
  const bytes: number[] = [];
  for (
    let remaining = value;
    remaining > 0;
    remaining = Math.floor(remaining / 256)
  ) {
    bytes.unshift(remaining & 0xff);
  }
  return bytes;
};

const encodeLength = (length: number): Uint8Array => {
  // Values below 128 use one byte. Otherwise bit 7 marks how many
  // big-endian length bytes follow.
  if (length < 128) return new Uint8Array([length]);
  const bytes = unsignedBytes(length);
  return new Uint8Array([0x80 + bytes.length, ...bytes]);
};

export const encodeDer = (
  tag: number,
  parts: readonly Uint8Array[],
): Uint8Array => {
  // The formats used here need only one-byte, low-number tags. Tag 0 is
  // BER end-of-contents; 0x1f marks the unsupported high-number tag form.
  if (
    !Number.isInteger(tag) ||
    tag === 0 ||
    tag >>> 8 !== 0 ||
    (tag & 0x1f) === 0x1f
  ) {
    throw new Error(`Unsupported DER tag: ${tag}`);
  }
  const contents = joinBytes(parts);
  return joinBytes([
    new Uint8Array([tag]),
    encodeLength(contents.length),
    contents,
  ]);
};

export const encodeSequence = (parts: readonly Uint8Array[]): Uint8Array =>
  encodeDer(0x30, parts);

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

export const sortDerValues = (values: readonly Uint8Array[]): Uint8Array[] =>
  values.toSorted(compareBytes);

/** DER SET OF values must be sorted by their complete encoded bytes. */
export const encodeSet = (values: readonly Uint8Array[]): Uint8Array =>
  encodeDer(0x31, sortDerValues(values));

export const encodeInteger = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid DER integer: ${value}`);
  }
  const bytes = unsignedBytes(value);
  // ASN.1 INTEGER is signed. Zero needs a byte, and a positive value whose
  // high bit is set needs a leading zero so it is not read as negative.
  if (bytes.length === 0 || bytes[0]! >= 0x80) bytes.unshift(0);
  return encodeDer(0x02, [new Uint8Array(bytes)]);
};

const encodeBase128 = (value: bigint): number[] => {
  // OID arcs use seven data bits per byte; bit 7 says another byte follows.
  const last = Number(value & 0x7fn);
  const rest = value >> 7n;
  if (rest === 0n) return [last];
  return [...encodeBase128(rest).map((byte) => byte | 0x80), last];
};

export const encodeOid = (value: string): Uint8Array => {
  const [firstText, secondText, ...restText] = value.split(".");
  if (
    !firstText ||
    !secondText ||
    ![firstText, secondText, ...restText].every((arc) => /^\d+$/.test(arc))
  ) {
    throw new Error(`Invalid OID: ${value}`);
  }
  const first = BigInt(firstText);
  const second = BigInt(secondText);
  // DER combines the first two arcs as 40 * first + second. Roots 0 and 1
  // therefore allow only 0-39 for the second arc.
  if (first > 2n || (first < 2n && second > 39n)) {
    throw new Error(`Invalid OID: ${value}`);
  }
  const body = [
    ...encodeBase128(first * 40n + second),
    ...restText.map(BigInt).flatMap(encodeBase128),
  ];
  return encodeDer(0x06, [new Uint8Array(body)]);
};

export const encodeOctetString = (value: Uint8Array): Uint8Array =>
  encodeDer(0x04, [value]);

export const encodeNull = (): Uint8Array => encodeDer(0x05, []);

const twoDigits = (value: number): string =>
  value < 10 ? `0${value}` : String(value);

export const encodeTime = (value: Date): Uint8Array => {
  const year = value.getUTCFullYear();
  const rest = `${twoDigits(value.getUTCMonth() + 1)}${twoDigits(value.getUTCDate())}${twoDigits(value.getUTCHours())}${twoDigits(value.getUTCMinutes())}${twoDigits(value.getUTCSeconds())}Z`;
  const encoded = new TextEncoder().encode(
    // DER reserves two-digit UTCTime for 1950-2049 and uses four-digit
    // GeneralizedTime outside that window.
    year >= 1950 && year <= 2049
      ? `${String(year).substring(2)}${rest}`
      : `${year}${rest}`,
  );
  return encodeDer(year >= 1950 && year <= 2049 ? 0x17 : 0x18, [encoded]);
};

interface ReadResult {
  end: number;
  value: DerValue;
}

interface DecodedLength {
  contentStart: number;
  length: number;
}

const decodeLongLength = (
  bytes: Uint8Array,
  contentStart: number,
  count: number,
): DecodedLength => {
  // DER requires definite, shortest-form lengths. Three length bytes cap this
  // focused reader below 16 MiB, far above the keys and certificates it reads.
  if (count === 0) throw new Error("Indefinite DER length is forbidden");
  const lengthEnd = contentStart + count;
  if (count > 3 || lengthEnd > bytes.length) {
    throw new Error("Invalid DER length");
  }
  if (bytes[contentStart] === 0) throw new Error("Non-minimal DER length");
  const length = bytes
    .subarray(contentStart, lengthEnd)
    .reduce((total, byte) => total * 256 + byte, 0);
  if (length < 128) throw new Error("Non-minimal DER length");
  return { contentStart: lengthEnd, length };
};

const decodeLength = (
  bytes: Uint8Array,
  offset: number,
  firstLength: number,
): DecodedLength =>
  // Bit 7 selects long form; the low seven bits count its length bytes.
  firstLength < 0x80
    ? { contentStart: offset + 2, length: firstLength }
    : decodeLongLength(bytes, offset + 2, firstLength & 0x7f);

const readAt = (bytes: Uint8Array, offset: number): ReadResult => {
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  if (tag === undefined || firstLength === undefined) {
    throw new Error("Truncated DER value");
  }
  if (tag === 0) throw new Error("DER end-of-contents tag is forbidden");
  if ((tag & 0x1f) === 0x1f)
    throw new Error("High-number DER tags are unsupported");
  const { contentStart, length } = decodeLength(bytes, offset, firstLength);
  const end = contentStart + length;
  if (end > bytes.length) throw new Error("DER value exceeds its container");
  return {
    end,
    value: {
      contents: bytes.subarray(contentStart, end),
      encoded: bytes.subarray(offset, end),
      tag,
    },
  };
};

export const readDer = (bytes: Uint8Array): DerValue => {
  const result = readAt(bytes, 0);
  if (result.end !== bytes.length)
    throw new Error("Trailing bytes after DER value");
  return result.value;
};

export const readDerChildren = (parent: DerValue): DerValue[] => {
  const children: DerValue[] = [];
  for (let offset = 0; offset < parent.contents.length; ) {
    const result = readAt(parent.contents, offset);
    children.push(result.value);
    offset = result.end;
  }
  return children;
};

export const readDerSequence = (bytes: Uint8Array, label: string): DerValue[] =>
  readDerChildren(requireDerTag(readDer(bytes), 0x30, label));

export const requireDerTag = (
  value: DerValue,
  tag: number,
  label: string,
): DerValue => {
  if (value.tag !== tag) throw new Error(`Invalid ${label}`);
  return value;
};
