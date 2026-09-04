import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "./Motion";

interface Props {
  id: string;
  /** two-digit section numeral */
  n: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
  /** measure for the heading block */
  headMax?: string;
  /** heading block on the right half instead of the left, so sections do not all start in one column */
  shift?: boolean;
  /** kept for callers; the page draws no fields */
  field?: unknown;
}

/** section shell: a pill (numeral · name), the heading, an optional lead, then the body. Headings sit left or right
 *  so the page does not read as one column. */
export function Section({ id, n, eyebrow, title, lead, children, className, headMax = "max-w-[40rem]", shift = false }: Props) {
  return (
    <section id={id} className={cn("section-pad relative overflow-x-clip", className)} aria-labelledby={`${id}-title`}>
      <div className="relative mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <Reveal className={cn("mb-12 md:mb-16", headMax, shift && "md:ml-auto")}>
          <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">
            <span className="text-text">{n}</span>
            <span aria-hidden className="size-1 rounded-full bg-mist" />
            {eyebrow}
          </p>
          <h2 id={`${id}-title`} className="h2 mt-6">{title}</h2>
          {lead && <p className="lead mt-5 max-w-[34rem]">{lead}</p>}
        </Reveal>
        {children}
      </div>
    </section>
  );
}
