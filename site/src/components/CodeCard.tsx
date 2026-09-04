import { cn } from "@/lib/utils";

interface Props {
  file: string;
  lines: string[];
  /** 0-based lines to set in the accent */
  highlight?: number[];
  className?: string;
  size?: "sm" | "md";
}

/** a code snippet on surface-2 with a filename row and one or two highlighted lines (the only body accent use) */
export function CodeCard({ file, lines, highlight = [], className, size = "md" }: Props) {
  return (
    <div className={cn("panel-2 overflow-hidden", className)}>
      <div className="flex items-center bg-surface-2 px-3.5 py-2">
        <span className="mono text-[11px] text-text-muted">{file}</span>
      </div>
      <pre className={cn("mono overflow-x-auto px-1 py-2.5 [scrollbar-width:thin]", size === "md" ? "text-[12.5px] leading-[1.7]" : "text-[11px] leading-[1.65]")}>
        {lines.map((l, i) => {
          const hot = highlight.includes(i);
          return (
            <div key={i} className={cn("flex gap-3 px-3", hot && "bg-brand/[0.12]")}>
              <span aria-hidden className={cn("w-4 shrink-0 select-none text-right", hot ? "text-brand" : "text-text-faint")}>{i + 1}</span>
              <span className={hot ? "text-brand" : "text-text-muted"}>{l}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
