import { LanguagePicker } from "@/components/LanguagePicker";
import { useT } from "@/i18n";
import { FOOTER } from "@/content";

/** the legend: small links in four quiet columns, then the legal line */
export function Footer() {
  const t = useT();
  return (
    <footer className="relative pb-16 pt-8 md:pb-24" aria-label={t.ui.footerLabel}>
      <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <nav className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-4" aria-label={t.ui.sitemap}>
          {FOOTER.map((col, i) => (
            <div key={col.head}>
              <p className="label mb-5">{t.footer.heads[i]}</p>
              <ul className="grid gap-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} target="_blank" rel="noreferrer" className="block text-[13.5px] leading-5 text-text-muted transition-colors duration-150 [overflow-wrap:anywhere] hover:text-text" dir="ltr">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="mt-20 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <img src="/brand/mark-sky.png" alt="" width={20} height={20} className="size-5 opacity-80 grayscale" />
              <span className="text-[14px] font-medium tracking-[-0.01em]">rovecode</span>
            </div>
            <p className="mt-4 text-[12.5px] leading-5 text-text-faint">
              {t.footer.legal}
              <br />
              {t.footer.notice}
            </p>
          </div>
          <LanguagePicker align="start" />
        </div>
      </div>
    </footer>
  );
}
