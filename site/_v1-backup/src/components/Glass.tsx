import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cn } from "@/lib/utils";

type Props<T extends ElementType> = {
  as?: T;
  /** 1 = default fill (60 % surface), 2 = lighter (45 %) for nested or secondary panels */
  level?: 1 | 2;
  hover?: boolean;
  pad?: "none" | "sm" | "md" | "lg";
} & ComponentPropsWithoutRef<T>;

const PAD = { none: "", sm: "p-4", md: "p-5 md:p-6", lg: "p-6 md:p-8" } as const;

/** the primary building block: frosted panel over the ink field, 20–24 px radius, hairline border,
 *  1 px inner top highlight, deep soft shadow; hover lifts the border into the sky hue (200 ms) */
export function Glass<T extends ElementType = "div">({ as, level = 1, hover = false, pad = "md", className, ...rest }: Props<T>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      className={cn(
        level === 1 ? "glass" : "glass-2",
        hover && (level === 1 ? "glass-hover" : "glass-hover-2"),
        "rounded-[20px] md:rounded-[24px]",
        PAD[pad],
        className,
      )}
      {...rest}
    />
  );
}
