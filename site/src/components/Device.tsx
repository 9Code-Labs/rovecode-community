import { cn } from "@/lib/utils";

interface Chip { text: string; className?: string }

interface Props {
  src: string;
  alt: string;
  title: string;
  meta?: string;
  /** facts read off the frame; set as a plain mono row under the image */
  chips?: Chip[];
  className?: string;
}

/** the full 160×44 frame in a white bezel: title row, the image, a facts row. No tilt, no parallax, nothing
 *  floating over the screenshot — the frame is the proof, so it is shown flat. */
export function Device({ src, alt, title, meta, chips = [], className }: Props) {
  return (
    <figure className={cn("panel overflow-hidden", className)}>
      <div className="flex items-center justify-between gap-3 rounded-t-[calc(var(--radius-lg)-1px)] bg-surface-2 px-4 py-2">
        <span className="mono text-xs text-text-muted">
          {title}
          {meta && <span className="hidden text-text-faint sm:inline"> · {meta}</span>}
        </span>
        <span className="mono text-xs text-text-faint">real frame</span>
      </div>
      <div className="p-1.5 md:p-2">
        <img src={src} alt={alt} width={2497} height={1496} fetchPriority="high" decoding="async" className="block w-full rounded-md" />
      </div>
      {chips.length > 0 && (
        <figcaption className="flex flex-wrap gap-x-6 gap-y-2 bg-surface-2 px-4 py-3">
          {chips.map((c) => (
            <span key={c.text} className="mono flex items-center gap-2 text-xs text-text-muted">
              <span aria-hidden className="size-1.5 rounded-full bg-sky" />
              {c.text}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
