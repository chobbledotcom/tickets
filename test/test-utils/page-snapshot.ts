import { assertEquals } from "@std/assert";

/** Assert a rendered admin page equals the frozen parent-build output. The
 *  signed CSRF value is freshly minted per render — the one genuinely variable
 *  token — so both sides mask it before comparing. */
export const assertPageMatchesSnapshot = (
  snapshot: URL,
  actual: string,
): void => {
  const normalize = (html: string): string =>
    html.replace(
      /name="csrf_token" value="[^"]*"/g,
      'name="csrf_token" value="N"',
    );
  assertEquals(normalize(actual), normalize(Deno.readTextFileSync(snapshot)));
};
