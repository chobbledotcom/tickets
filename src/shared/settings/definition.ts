/** Keep one definition's literal type, so a table's entries stay narrow. The
 *  table itself declares the shape that each entry must match. */
export const definition = <const Definition>(entry: Definition): Definition =>
  entry;
