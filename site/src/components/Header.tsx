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

/** a thin bar: the word mark, a few small links, GitHub as text. Frosted paper once the page moves; no fills. */
export function Header() {
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
    <header className={cn("fixed inset-x-0 top-0 z-40 transition-[background-color] duration-300", scrolled ? "bg-bg/85 backdrop-blur-md" : "bg-transparent")}>
      <div className="mx-auto flex h-[var(--header-h)] w-full max-w-[1200px] items-center justify-between gap-6 px-6 md:px-10">
        <a href="#top" className="flex shrink-0 items-center gap-2.5 rounded-sm" title={t.ui.backToTop}>
          <img src="/brand/mark-sky-96.png" alt="" width={20} height={20} className="size-5 opacity-80 grayscale" />
          <span className="text-[14px] font-medium tracking-[-0.01em]">rovecode</span>
          <span className="label hidden sm:inline">v0.2.0</span>
        </a>
        <nav aria-label={t.ui.sections} className="hidden min-w-0 items-center gap-7 lg:flex">
          {nav.map(([label, href]) => (
            <a key={href} href={href} className="truncate rounded-sm text-[13.5px] text-text-muted transition-colors duration-150 hover:text-text">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-6 text-[13.5px]">
          <LanguagePicker />
          <a href={README} target="_blank" rel="noreferrer" className="hidden rounded-sm text-text-muted transition-colors duration-150 hover:text-text xl:inline">
            {t.ui.readme}
          </a>
          <a href={REPO} target="_blank" rel="noreferrer" className="rounded-sm text-text transition-colors duration-150 hover:text-brand">
            {t.ui.github} ↗
          </a>
        </div>
      </div>
    </header>
  );
}
