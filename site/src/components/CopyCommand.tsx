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
  /** "dark" sits on the hero clip: translucent ink, white type, the prompt in the flower yellow */
  tone?: "light" | "dark";
}

/** mono command block on surface-2 with a copy button; the label swaps for 1.4 s after a copy */
export function CopyCommand({ command, display, prompt = "$", className, size = "md", wrap = false, tone = "light" }: Props) {
  const t = useT();
  const dark = tone === "dark";
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = command; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  }, [command]);

  return (
    <div
      className={cn(
        "group flex min-w-0 items-stretch gap-2 overflow-hidden ps-4 pe-2 text-start",
        dark
          ? "rounded-md bg-ink-2 transition-colors duration-200"
          : "panel-2 panel-hover",
        size === "md" ? "py-2.5" : "py-2",
        className,
      )}
    >
      <code
        dir="ltr"
        className={cn(
          "mono min-w-0 flex-1 self-center",
          dark ? "text-ink-text" : "text-text",
          wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre [scrollbar-width:thin]",
          size === "md" ? "text-[13.5px] leading-6 md:text-sm" : "text-[12.5px] leading-5",
        )}
      >
        <span className={cn("select-none", dark ? "text-ink-accent" : "text-brand")}>{prompt} </span>
        {display ?? command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? t.ui.copiedAria : t.ui.copyAria}
        className={cn(
          "mono inline-flex shrink-0 items-center gap-1.5 self-center rounded-sm px-3 py-1.5 text-xs transition-[color,background-color] duration-150",
          dark
            ? "bg-white/10 text-ink-muted hover:bg-white/20 hover:text-ink-text focus-visible:text-ink-text"
            : "bg-surface-2 text-text-muted hover:text-text focus-visible:text-text",
          copied && (dark ? "text-ink-accent" : "text-brand"),
        )}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        <span className="min-w-[3.4em] text-left rtl:text-right">{copied ? t.ui.copied : t.ui.copy}</span>
      </button>
    </div>
  );
}
