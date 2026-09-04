import { motion, useReducedMotion } from "motion/react";
import { EASE } from "@/components/Motion";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/** the five illustrated poses of the cloud mascot, drawn on transparent so they sit straight on the page */
export type Pose = "edit" | "read" | "guard" | "rewind" | "done";

const SIZES = { sm: "size-10", md: "size-14", lg: "size-20" } as const;

/** One mascot drawing, used sparingly. It settles into place once as it comes into view and then holds still —
 *  on a quiet page nothing loops. Decorative by default: the alt text is only spoken when `labelled` is on. */
export function PetSpot({ pose, size = "md", className, labelled = false }: { pose: Pose; size?: keyof typeof SIZES; className?: string; labelled?: boolean }) {
  const t = useT();
  const reduce = useReducedMotion();
  const alt = `${t.pet.alt}, ${t.pet[pose]}`;
  const enter = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        whileInView: { opacity: 1, y: 0 },
        viewport: { once: true, margin: "-10% 0px" },
        transition: { duration: 0.8, ease: EASE },
      };
  return (
    <motion.img
      src={`/brand/pet/${pose}.webp`}
      width={512}
      height={512}
      loading="lazy"
      decoding="async"
      alt={labelled ? alt : ""}
      aria-hidden={labelled ? undefined : true}
      className={cn(SIZES[size], "select-none object-contain", className)}
      {...enter}
    />
  );
}
