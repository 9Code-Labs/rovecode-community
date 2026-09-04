import { useEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";
import { LOCALES, useI18n, type LocaleCode } from "@/i18n";
import { cn } from "@/lib/utils";

/** A plain button + popup list — 15 languages is too many for a <select> to read well on the bar, and each name
 *  is written in its own language. Keyboard: Enter/Space/ArrowDown open and focus the current language; arrows,
 *  Home/End move; Enter picks; Escape or Tab closes and focus returns to the button. Outside click closes too. */
export function LanguagePicker({ align = "end" }: { tone?: "light" | "dark"; align?: "start" | "end" }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const items = useRef<Map<LocaleCode, HTMLButtonElement>>(new Map());
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

  useEffect(() => {
    if (!open) return;
    items.current.get(locale)?.focus();
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, locale]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const pick = (c: LocaleCode) => { setLocale(c); close(); };

  const onListKey = (e: React.KeyboardEvent) => {
    const codes = LOCALES.map((l) => l.code);
    const active = document.activeElement as HTMLElement | null;
    const i = codes.findIndex((c) => items.current.get(c) === active);
    const go = (n: number) => { e.preventDefault(); items.current.get(codes[(n + codes.length) % codes.length]!)?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(codes.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="language-list"
        aria-label={`${t.ui.language}: ${current.name}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-[13.5px] font-medium text-text-muted transition-colors duration-150 hover:text-text"
      >
        <Globe className="size-4" aria-hidden />
        <span className="max-w-[7rem] truncate">{current.name}</span>
      </button>
      {open && (
        <ul
          id="language-list"
          role="listbox"
          aria-label={t.ui.language}
          aria-activedescendant={`lang-${locale}`}
          onKeyDown={onListKey}
          className={cn("panel absolute top-[calc(100%+6px)] z-50 max-h-[62vh] w-[13rem] overflow-y-auto !rounded-[var(--radius-md)] p-1.5", align === "end" ? "right-0" : "left-0")}
        >
          {LOCALES.map((l) => (
            <li key={l.code}>
              <button
                ref={(el) => { if (el) items.current.set(l.code, el); else items.current.delete(l.code); }}
                id={`lang-${l.code}`}
                type="button"
                role="option"
                aria-selected={l.code === locale}
                tabIndex={-1}
                onClick={() => pick(l.code)}
                lang={l.code}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-[10px] px-3 py-1.5 text-left text-sm transition-colors duration-150 focus-visible:bg-surface-2",
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
