import { cn } from "@/lib/utils";

/** the TUI pet sprite (src/sextant/pet.ts SPRITE + FACE anchors), drawn in mono at a fixed cell grid */
const SPRITE = [
  "       ╭────╮     ",
  "   ╭───╯    ╰──╮  ",
  "  ╭╯           ╰╮ ",
  "  │   •     •   │ ",
  "  ╰╮     ◡     ╭╯ ",
  "   ╰───────────╯  ",
];

interface Props {
  /** a line from pet.ts QUIPS */
  quip?: string;
  mood?: string;
  size?: "sm" | "lg";
  className?: string;
}

export function Mascot({ quip, mood = "patient", size = "sm", className }: Props) {
  return (
    <div className={cn("glass-pill !rounded-[18px] flex items-center gap-3 px-3 py-2", size === "lg" && "!rounded-[24px] gap-5 px-6 py-5", className)} role="img" aria-label={`nimbus, the weather-cloud pet, mood ${mood}${quip ? `, saying: ${quip}` : ""}`}>
      <pre aria-hidden className={cn("mono select-none leading-[1.05] text-text", size === "sm" ? "text-[8px]" : "text-[13px] md:text-[15px]")}>
        {SPRITE.join("\n")}
      </pre>
      <div className="min-w-0">
        <p className={cn("mono text-text-muted", size === "sm" ? "text-[10px] leading-4" : "text-xs leading-5")}>
          <span className="text-text">nimbus</span> · {mood}
        </p>
        {quip && <p className={cn("mono text-text", size === "sm" ? "text-[11px] leading-4" : "text-sm leading-6")}>“{quip}”</p>}
      </div>
    </div>
  );
}
