import { REPO, README } from "@/content";
import { GitHubMark } from "./GitHubMark";

const NAV = [
  ["Capabilities", "#capabilities"],
  ["Terminal", "#terminal"],
  ["Quickstart", "#quickstart"],
  ["Providers", "#providers"],
  ["FAQ", "#faq"],
] as const;

/** sticky glass bar; its own height is reserved in the flow (pt + h) so nothing slides under it */
export function Header() {
  return (
    <header className="sticky top-0 z-40 px-3 pt-3 md:px-6 md:pt-4" style={{ height: "calc(var(--header-h) + 0.75rem)" }}>
      <div className="glass mx-auto flex h-[var(--header-h)] w-full max-w-[1200px] items-center justify-between rounded-pill pl-4 pr-2 md:pl-5">
        <a href="#top" className="flex items-center gap-2.5 rounded-pill" aria-label="Nimbus, back to top">
          <img src="/brand/mark.png" alt="" width={28} height={28} className="size-7" />
          <span className="text-[15px] font-[450] tracking-tight">nimbus</span>
          <span className="mono hidden text-xs text-text-faint sm:inline">v0.2.0</span>
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">
          {NAV.map(([label, href]) => (
            <a key={href} href={href} className="rounded-pill px-3 py-1.5 text-sm text-text-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-text">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <a href={README} target="_blank" rel="noreferrer" className="hidden rounded-pill px-3 py-1.5 text-sm text-text-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-text md:inline-flex">
            README
          </a>
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-pill bg-brand pl-3.5 pr-4 text-sm font-medium text-on-brand transition-[background-color,transform] duration-150 hover:bg-brand-hover active:scale-[0.98]"
          >
            <GitHubMark className="size-4" />
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
