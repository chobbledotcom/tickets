import { assertEquals } from "@std/assert";

/** Assert a rendered admin page equals the frozen parent-build output. The
 *  signed CSRF value is freshly minted per render — the one genuinely variable
 *  token — so both sides mask it before comparing. */
export const assertPageMatchesSnapshot = (
  snapshot: URL,
  actual: string,
): void => {
  const normalize = (html: string): string =>
    // Mask only the token's value. Other attributes may sit between the name
    // and the value (the renderer emits name, type, value), and the lookbehind
    // keeps longer names such as data-name out of the mask.
    html.replace(
      /(?<![-\w])(name="csrf_token"[^>]*? value=")[^"]*(")/g,
      "$1$2",
    );
  assertEquals(normalize(actual), normalize(Deno.readTextFileSync(snapshot)));
};
