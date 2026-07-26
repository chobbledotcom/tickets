/** Addresses on this machine may be plain, because nothing leaves the machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Make a check that only lets through addresses safe to send secrets over:
 * one of the given schemes, encrypted, or on this machine. Pass the schemes
 * the caller can speak, then the address and what to call it in the error.
 */
export const secureUrlCheck =
  (secureProtocols: Set<string>) =>
  (value: string, label: string): string => {
    try {
      const url = new URL(value);
      const secure = secureProtocols.has(url.protocol);
      const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
      const plaintext =
        url.protocol === "http:" ||
        (url.protocol === "libsql:" &&
          url.searchParams.getAll("tls").at(-1) === "0");
      if (
        url.hostname &&
        (secure || url.protocol === "http:") &&
        (!plaintext || loopback)
      ) {
        return value;
      }
    } catch {
      // Invalid addresses share the same clear configuration error as plain ones.
    }
    throw new Error(
      `${label} must use TLS. Plain connections are allowed only for loopback.`,
    );
  };
