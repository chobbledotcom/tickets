import { t } from "#i18n";

export const CatalogExportNav = ({ href }: { href: string }): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href={href}>{t("catalog_transfer.export_link")}</a>
      </li>
    </ul>
  </nav>
);
