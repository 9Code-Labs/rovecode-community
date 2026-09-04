import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

interface Props {
  command: string;
  /** shown in the mono block; defaults to the command itself */
  display?: string;
  prompt?: string;
  className?: string;
  size?: "sm" | "md";
  /** let a long command wrap onto two or three lines instead of scrolling */
  wrap?: boolean;
  /** "card" sits on the ground (white, hairline); "tint" sits inside a card (a tint of the ground) */
  tone?: "card" | "tint";
}

/** a mono command block with a pill copy button; the label swaps for 1.4 s after a copy */
export function CopyCommand({ command, display, prompt = "$", className, size = "md", wrap = false, tone = "card" }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const code = useRef<HTMLElement | null>(null);
  /** copy through the async clipboard when the origin allows it (https, localhost); otherwise the legacy
   *  execCommand path, which Firefox and Safari still honour on a click. If neither works — plain http on a
   *  browser that refuses both — the command text is selected instead and the label stays "copy": the visitor
   *  presses ⌘/Ctrl+C, and the button never claims a copy that did not happen. */
  const copy = useCallback(async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(command); ok = true; }
    } catch { /* insecure origin or permission denied: fall through */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = command; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    if (!ok) {
      const el = code.current;
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
      return;
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  }, [command]);

  return (
    <div
      className={cn(
        "group flex min-w-0 items-stretch gap-2 overflow-hidden ps-4 pe-2 text-start",
        tone === "card" ? "panel panel-hover !rounded-[var(--radius-md)] !shadow-none" : "panel-2",
        size === "md" ? "py-2.5" : "py-2",
        className,
      )}
    >
      <code
        ref={code}
        dir="ltr"
        className={cn(
          "mono min-w-0 flex-1 self-center text-text",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre [scrollbar-width:thin]",
          size === "md" ? "text-[13.5px] leading-6 md:text-sm" : "text-[12.5px] leading-5",
        )}
      >
        <span className="select-none text-brand">{prompt} </span>
        {display ?? command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? t.ui.copiedAria : t.ui.copyAria}
        className={cn(
          "mono chip shrink-0 self-center px-3 py-1.5 text-xs text-text-muted transition-[color,background-color] duration-150 hover:text-text focus-visible:text-text",
          copied && "!text-brand",
        )}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        <span className="min-w-[3.4em] text-left rtl:text-right">{copied ? t.ui.copied : t.ui.copy}</span>
      </button>
    </div>
  );
}
