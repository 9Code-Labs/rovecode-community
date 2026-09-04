import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cn } from "@/lib/utils";

type Props<T extends ElementType> = {
  as?: T;
  /** 1 = surface (cards), 2 = surface-2 (nested blocks: code, commands, crops) */
  level?: 1 | 2;
  hover?: boolean;
  pad?: "none" | "sm" | "md" | "lg";
} & ComponentPropsWithoutRef<T>;

const PAD = { none: "", sm: "p-4", md: "p-5 md:p-6", lg: "p-6 md:p-8" } as const;

/** the primary building block: an opaque tonal step of the ink with a hairline border — no blur, no shadow;
 *  hover moves the border one step (200 ms) */
export function Panel<T extends ElementType = "div">({ as, level = 1, hover = false, pad = "md", className, ...rest }: Props<T>) {
  const Tag = (as ?? "div") as ElementType;
  return <Tag className={cn(level === 1 ? "panel" : "panel-2", hover && "panel-hover", PAD[pad], className)} {...rest} />;
}
