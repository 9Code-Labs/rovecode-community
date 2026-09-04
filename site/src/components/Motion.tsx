import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const EASE = [0.22, 1, 0.36, 1] as const;

/** The quiet page has no entrance animations: content is on screen from the first paint (prerendered) and stays.
 *  These wrappers remain so section files keep their structure; they render the plain element. */
export function Reveal({ children, className, delay: _delay, ...rest }: { children: ReactNode; className?: string; delay?: number } & ComponentPropsWithoutRef<"div">) {
  return <div className={className} {...rest}>{children}</div>;
}

export function Stagger({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol" } & Record<string, unknown>) {
  const Tag = as;
  return <Tag className={className} {...(rest as object)}>{children}</Tag>;
}

export function Item({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "li" | "article" } & Record<string, unknown>) {
  const Tag = as;
  return <Tag className={cn("min-w-0", className)} {...(rest as object)}>{children}</Tag>;
}
