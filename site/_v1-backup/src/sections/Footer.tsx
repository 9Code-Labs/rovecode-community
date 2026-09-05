import { FOOTER } from "@/content";

export function Footer() {
  return (
    <footer className="relative border-t border-border py-12 md:py-16" aria-label="Footer">
      <div className="mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <div className="grid gap-10 md:grid-cols-12">
          <div className="md:col-span-4">
            <div className="flex items-center gap-2.5">
              <img src="/brand/mark.png" alt="" width={28} height={28} className="size-7" />
              <span className="text-[15px] font-[450] tracking-tight">nimbus</span>
            </div>
            <p className="mt-4 max-w-[22rem] text-[15px] leading-6 text-text-muted">
              A coding agent for the terminal. TypeScript on Bun, 47 ported patterns, one deny-default policy in front of every tool.
            </p>
            <p className="mono mt-6 text-xs leading-5 text-text-faint">
              © 2026 9Code Labs · AGPL-3.0-only · v0.2.0 · Bun ≥ 1.3.14
              <br />
              Sources ported are MIT or Apache-2.0 only; attributions in THIRD_PARTY_NOTICES.md.
            </p>
          </div>
          <nav className="grid grid-cols-2 gap-8 md:col-span-8 md:grid-cols-4" aria-label="Site map">
            {FOOTER.map((col) => (
              <div key={col.head}>
                <p className="eyebrow mb-4">{col.head}</p>
                <ul className="grid gap-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} target="_blank" rel="noreferrer" className="mono text-[12.5px] leading-5 text-text-muted transition-colors duration-150 hover:text-text">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
