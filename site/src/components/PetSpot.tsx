import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/** the five illustrated poses of the cloud mascot, drawn on transparent so they sit straight on the page */
export type Pose = "edit" | "read" | "guard" | "rewind" | "done";

const SIZES = { sm: "size-10", md: "size-14", lg: "size-20" } as const;

/** One mascot drawing, used sparingly and held still. Decorative by default: the alt text is only spoken when
 *  `labelled` is on. */
export function PetSpot({ pose, size = "md", className, labelled = false }: { pose: Pose; size?: keyof typeof SIZES; className?: string; labelled?: boolean }) {
  const t = useT();
  const alt = `${t.pet.alt}, ${t.pet[pose]}`;
  return (
    <img
      src={`/brand/pet/${pose}.webp`}
      srcSet={`/brand/pet/${pose}-160.webp 160w, /brand/pet/${pose}.webp 512w`}
      sizes="80px"
      width={512}
      height={512}
      loading="lazy"
      decoding="async"
      alt={labelled ? alt : ""}
      aria-hidden={labelled ? undefined : true}
      className={cn(SIZES[size], "select-none object-contain", className)}
    />
  );
}
