import type { Child } from "#jsx/jsx-runtime.ts";
import { divWithClass } from "#templates/components/div-with-class.tsx";

/** Lets a wide table scroll sideways instead of stretching the page. */
export const TableScroll: (props: { children: Child }) => JSX.Element =
  divWithClass("table-scroll");
