import { useEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";
import { LOCALES, useI18n, type LocaleCode } from "@/i18n";
import { cn } from "@/lib/utils";

/** A plain button + popup list — 15 languages is too many for a <select> to read well on the bar, and each name
 *  is written in its own language. Escape closes, an outside click closes, and the choice persists. */
export function LanguagePicker({ tone = "light", align = "end" }: { tone?: "light" | "dark"; align?: "start" | "end" }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
  const dark = tone === "dark";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pick = (c: LocaleCode) => { setLocale(c); setOpen(false); };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.ui.language}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-150",
          dark ? "bg-white/10 text-ink-muted hover:bg-white/20 hover:text-ink-text" : "bg-surface-2 text-text-muted hover:text-text",
        )}
      >
        <Globe className="size-4" aria-hidden />
        <span className="max-w-[7rem] truncate">{current.name}</span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t.ui.language}
          className={cn(
            "panel absolute top-[calc(100%+6px)] z-50 max-h-[62vh] w-[13rem] overflow-y-auto p-1",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {LOCALES.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === locale}
                onClick={() => pick(l.code)}
                lang={l.code}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-sm transition-colors duration-150",
                  l.code === locale ? "text-text" : "text-text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                <span className="truncate">{l.name}</span>
                {l.code === locale ? <Check className="size-3.5 shrink-0 text-brand" aria-hidden /> : <span className="mono shrink-0 text-[11px] text-text-faint">{l.code}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
