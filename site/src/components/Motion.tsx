import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { cn } from "@/lib/utils";

export const EASE = [0.22, 1, 0.36, 1] as const;

const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
};

/** one entrance per block: fade + 16 px rise, 700 ms ease-out, once; no motion under prefers-reduced-motion */
export function Reveal({ children, className, delay = 0, ...rest }: { children: ReactNode; className?: string; delay?: number } & ComponentPropsWithoutRef<"div">) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className} {...rest}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.15, margin: "0px 0px -5% 0px" }}
      variants={{ hidden: rise.hidden!, show: { ...(rise.show as object), transition: { duration: 0.7, ease: EASE, delay } } }}
    >
      {children}
    </motion.div>
  );
}

/** a grid whose children enter 60 ms apart (use <Item> for each child) */
export function Stagger({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol" } & Record<string, unknown>) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  if (reduce) { const Plain = as; return <Plain className={className} {...(rest as object)}>{children}</Plain>; }
  return (
    <Tag
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.1, margin: "0px 0px -5% 0px" }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
      {...(rest as object)}
    >
      {children}
    </Tag>
  );
}

export function Item({ children, className, as = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "li" | "article" } & Record<string, unknown>) {
  const reduce = useReducedMotion();
  if (reduce) { const Plain = as; return <Plain className={cn("min-w-0", className)} {...(rest as object)}>{children}</Plain>; }
  const Tag = motion[as];
  return <Tag className={cn("min-w-0", className)} variants={rise} {...(rest as object)}>{children}</Tag>;
}
