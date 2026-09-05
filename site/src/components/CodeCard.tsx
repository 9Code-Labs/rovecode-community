import { cn } from "@/lib/utils";

interface Props {
  file: string;
  lines: string[];
  /** 0-based lines to set in the accent */
  highlight?: number[];
  className?: string;
  size?: "sm" | "md";
}

/** a code snippet on a tint of the ground with a filename row and one or two highlighted lines */
export function CodeCard({ file, lines, highlight = [], className, size = "md" }: Props) {
  return (
    <div className={cn("panel-2 overflow-hidden", className)}>
      <div className="flex items-center border-b border-border/70 px-4 py-2.5">
        <span className="mono text-[11px] text-text-muted">{file}</span>
      </div>
      {/* source and its line-number gutter are code: left to right, whatever the page direction is */}
      <pre dir="ltr" className={cn("mono overflow-x-auto px-1.5 py-3 [scrollbar-width:thin]", size === "md" ? "text-[12.5px] leading-[1.7]" : "text-[11px] leading-[1.65]")}>
        {lines.map((l, i) => {
          const hot = highlight.includes(i);
          return (
            <div key={i} className={cn("flex gap-3 rounded-[8px] px-3", hot && "bg-mist-soft")}>
              <span aria-hidden className={cn("w-4 shrink-0 select-none text-right", hot ? "text-text" : "text-text-faint")}>{i + 1}</span>
              <span className={hot ? "font-medium text-text" : "text-text-muted"}>{l}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
