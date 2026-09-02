import type { Child } from "#jsx/jsx-runtime.ts";

/**
 * One heading and what sits under it, opened by default and collapsible. Every
 * block on the admin dashboard is one of these.
 */
export const openSection = (heading: string, body: Child): string =>
  String(
    <details open>
      <summary>{heading}</summary>
      {body}
    </details>,
  );
