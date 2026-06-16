/**
 * Inline "open in maps" links for a place query (e.g. an attendee address).
 * Renders nothing when the query is blank. Generic — usable anywhere a
 * location should be openable in the visitor's map app of choice.
 */

import { mapLinks } from "#shared/maps.ts";

export const MapsLinks = ({ query }: { query: string }): JSX.Element | null => {
  const links = mapLinks(query);
  if (links.length === 0) return null;
  return (
    <span class="maps-links">
      {" ("}
      maps:{" "}
      {links.map((link, i) => (
        <>
          {i > 0 ? " / " : ""}
          <a href={link.url} rel="noopener noreferrer" target="_blank">
            {link.provider}
          </a>
        </>
      ))}
      {")"}
    </span>
  );
};
