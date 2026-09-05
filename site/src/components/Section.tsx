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
  /** heading block on the right two thirds instead of the full width, so sections do not all start in one
   *  column. It needs an `aside` to sit opposite it: a heading pushed right with nothing on its left is
   *  half a section of empty page. */
  shift?: boolean;
  /** the section's own index, drawn opposite a shifted heading — its cards' names, its own counts. Never
   *  new copy: whatever is here is already somewhere else in the section. */
  aside?: ReactNode;
  /** kept for callers; the page draws no fields */
  field?: unknown;
}

/** section shell: a pill (numeral · name), the heading, an optional lead, then the body.
 *
 *  A section either starts at the left margin, or shifts its heading right and fills the space it leaves
 *  with its own index. Below `md` the two columns become one and the index follows the heading, because a
 *  list of ten names above the title it belongs to reads like the page started in the middle. */
export function Section({ id, n, eyebrow, title, lead, children, className, headMax = "max-w-[40rem]", shift = false, aside }: Props) {
  const head = (
    <>
      <p className="chip label px-3.5 py-1.5 !tracking-[0.1em]">
        <span className="text-text">{n}</span>
        <span aria-hidden className="size-1 rounded-full bg-mist" />
        {eyebrow}
      </p>
      <h2 id={`${id}-title`} className="h2 mt-6">{title}</h2>
      {lead && <p className="lead mt-5 max-w-[34rem]">{lead}</p>}
    </>
  );
  const shifted = shift && aside;
  return (
    <section id={id} className={cn("section-pad relative overflow-x-clip", className)} aria-labelledby={`${id}-title`}>
      <div className="relative mx-auto w-full max-w-[1200px] px-6 md:px-10">
        {shifted ? (
          <div className="mb-12 grid gap-8 md:mb-16 md:grid-cols-12 md:gap-10">
            <Reveal className="order-last md:order-first md:col-span-4 md:pt-1">{aside}</Reveal>
            <Reveal className="md:col-span-8" delay={0.08}>{head}</Reveal>
          </div>
        ) : (
          <Reveal className={cn("mb-12 md:mb-16", headMax)}>{head}</Reveal>
        )}
        {children}
      </div>
    </section>
  );
}

/** the index that fills the space beside a shifted heading: numbered names, nothing clickable. The
 *  numerals are the `label` type — small and spaced — and the names carry the body's muted tone. */
export function SectionIndex({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((name, i) => (
        <li key={name} className="flex gap-3 text-[13.5px] leading-6 text-text-muted">
          <span className="label mono w-6 shrink-0 !tracking-[0.08em] text-text-faint" dir="ltr">{String(i + 1).padStart(2, "0")}</span>
          <span>{name}</span>
        </li>
      ))}
    </ol>
  );
}
