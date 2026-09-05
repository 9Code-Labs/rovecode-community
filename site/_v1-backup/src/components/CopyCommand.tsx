import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
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
}

/** mono command block in glass with a copy button; the label swaps for 1.4 s after a copy */
export function CopyCommand({ command, display, prompt = "$", className, size = "md", wrap = false }: Props) {
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
        "glass-2 glass-hover-2 group flex min-w-0 items-stretch gap-2 overflow-hidden rounded-[16px] pl-4 pr-2 text-left",
        size === "md" ? "py-2.5" : "py-2",
        className,
      )}
    >
      <code
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
        aria-label={copied ? "Copied" : "Copy command"}
        className={cn(
          "mono inline-flex shrink-0 items-center gap-1.5 self-center rounded-pill border border-border px-3 py-1.5 text-xs text-text-muted transition-[color,border-color,background-color] duration-150",
          "hover:border-brand/40 hover:bg-brand/[0.08] hover:text-text focus-visible:text-text",
          copied && "border-brand/50 text-brand",
        )}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        <span className="w-[3.4em] text-left">{copied ? "copied" : "copy"}</span>
      </button>
    </div>
  );
}
