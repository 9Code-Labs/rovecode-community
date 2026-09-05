import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "./Motion";

interface Props {
  id: string;
  /** two-digit section numeral, set in mono */
  n: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
  /** narrower measure for the heading block */
  headMax?: string;
  /** light fields or other absolutely positioned backdrop */
  backdrop?: ReactNode;
}

/** section shell: numbered eyebrow, display heading (44–48 px), optional lead, then the body */
export function Section({ id, n, eyebrow, title, lead, children, className, headMax = "max-w-[46rem]", backdrop }: Props) {
  return (
    <section id={id} className={cn("section-pad relative scroll-mt-24 overflow-x-clip", className)} aria-labelledby={`${id}-title`}>
      {backdrop}
      <div className="relative mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <Reveal className={cn("mb-10 md:mb-14", headMax)}>
          <p className="eyebrow mb-4 flex items-center gap-3">
            <span className="text-brand">{n}</span>
            <span aria-hidden className="h-px w-6 bg-border-strong" />
            {eyebrow}
          </p>
          <h2 id={`${id}-title`} className="h2">{title}</h2>
          {lead && <p className="lead mt-5 max-w-[40rem]">{lead}</p>}
        </Reveal>
        {children}
      </div>
    </section>
  );
}
