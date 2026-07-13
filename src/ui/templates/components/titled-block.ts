import type { Child } from "#jsx/jsx-runtime.ts";

/** A block with a heading and optional children — the shared prop shape of the
 * admin-guide `Section` and the settings-section wrapper. */
export type TitledBlock = { title: string; children?: Child };
