import { useEffect, useState } from "react";
import { REPO, README } from "@/content";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { LanguagePicker } from "./LanguagePicker";

/** true once the page has scrolled past the top of the hero */
function useScrolled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = () => setOn(window.scrollY > 24);
    f();
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  return on;
}

/** a thin bar on a light mist with a hairline under it once the page moves; the word mark, a few small links,
 *  GitHub as a filled pill. No blur. */
/** `home` is the page the section anchors live on: "" on the landing page itself, the locale root ("/", "/tr/") on a docs page */
export function Header({ home = "" }: { home?: string } = {}) {
  const t = useT();
  const scrolled = useScrolled();
  const nav = [
    [t.nav.cockpit, "#cockpit"],
    [t.nav.capabilities, "#capabilities"],
    [t.nav.security, "#security"],
    [t.nav.terminal, "#terminal"],
    [t.nav.quickstart, "#quickstart"],
    [t.nav.faq, "#faq"],
  ] as const;

  return (
    <header className={cn("fixed inset-x-0 top-0 z-40 border-b transition-[background-color,border-color] duration-300", scrolled ? "border-border bg-[#f9fafd]/95" : "border-transparent bg-transparent")}>
      <div className="mx-auto flex h-[var(--header-h)] w-full max-w-[1200px] items-center justify-between gap-6 px-6 md:px-10">
        <a href={home ? home : "#top"} className="flex shrink-0 items-center gap-2.5 rounded-full" title={t.ui.backToTop}>
          <img src="/brand/mark-sky-96.png" alt="" width={20} height={20} className="size-5" />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">rovecode</span>
          <span className="chip hidden px-2 py-0.5 text-[11px] text-text-muted sm:inline-flex">v0.2.0</span>
        </a>
        <nav aria-label={t.ui.sections} className="hidden min-w-0 items-center gap-7 lg:flex">
          {nav.map(([label, href]) => (
            <a key={href} href={home + href} className="truncate rounded-full text-[13.5px] font-medium text-text-muted transition-colors duration-150 hover:text-text">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-4 text-[13.5px]">
          <LanguagePicker />
          <a href={README} target="_blank" rel="noreferrer" className="hidden rounded-full font-medium text-text-muted transition-colors duration-150 hover:text-text xl:inline">
            {t.ui.readme}
          </a>
          <a href={REPO} target="_blank" rel="noreferrer" className="button-fill h-9 px-4 text-[13.5px]">
            {t.ui.github} ↗
          </a>
        </div>
      </div>
    </header>
  );
}
