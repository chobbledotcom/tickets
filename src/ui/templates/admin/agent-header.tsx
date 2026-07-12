/**
 * Bare page header for an agent-class user: just a title, no staff navigation,
 * since an agent may only ever reach the one page. Flagging the page as an
 * admin page makes the logout button appear in the footer.
 */

import { markAdminFooter } from "#templates/admin/footer.tsx";

export const AgentHeader = ({ title }: { title: string }): JSX.Element => {
  markAdminFooter("agent");
  return (
    <header class="agent-header">
      <h1>{title}</h1>
    </header>
  );
};
