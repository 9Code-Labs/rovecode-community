import { cn } from "@/lib/utils";
import { FRAME_SIZES, FRAME_WIDTHS, Pic } from "./Pic";

interface Chip { text: string; className?: string }

interface Props {
  src: string;
  alt: string;
  title: string;
  meta?: string;
  /** facts read off the frame; set as pills under the image */
  chips?: Chip[];
  className?: string;
}

/** the full 160×44 frame in a white card: a title row, the image with 16 px corners, a row of pills. No tilt,
 *  no parallax, nothing floating over the screenshot — the frame is the proof, so it is shown flat. */
export function Device({ src, alt, title, meta, chips = [], className }: Props) {
  return (
    <figure className={cn("panel overflow-hidden p-2 md:p-3", className)}>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 md:px-4">
        <span className="mono text-xs text-text-muted">
          {title}
          {meta && <span className="hidden text-text-faint sm:inline"> · {meta}</span>}
        </span>
        <span className="chip px-2.5 py-1 text-[11px] text-text-muted">real frame</span>
      </div>
      <Pic src={src} widths={FRAME_WIDTHS} sizes={FRAME_SIZES} alt={alt} width={2497} height={1496} fetchPriority="high" decoding="async" className="block w-full rounded-[var(--radius-md)]" />
      {chips.length > 0 && (
        <figcaption className="flex flex-wrap gap-2 px-2 pb-1 pt-3 md:px-3">
          {chips.map((c) => (
            <span key={c.text} className="chip px-3 py-1.5 text-xs text-text-muted">
              <span aria-hidden className="size-1.5 rounded-full bg-brand-soft" />
              {c.text}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
