import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";
import { STATIC } from "@/lib/boot";
import { cn } from "@/lib/utils";
import { TRANSCRIPT } from "@/content";

/** the messages panel of the real approval frame (shots/approval-160x44.png), row for row, set in HTML so it stays
 *  crisp at any width — the one dark block on the page, in the sextant "night" colours. Nothing here is invented:
 *  see TRANSCRIPT in content.ts.
 *
 *  The run replays once as the panel scrolls into view: the user line is typed, the agent thinks, the two tool
 *  rows land, the approval card slides in. Under prefers-reduced-motion the finished panel is shown at once. */

/** milliseconds from the panel entering view to each step of the replay */
const STEPS = [
  0, // 0 · user line typing
  1250, // 1 · ◆ rovecode · thinking
  1600, // 2 · note typing
  2400, // 3 · read row
  2750, // 4 · … 16 lines
  3100, // 5 · edit row (status editing)
  3500, // 6 · +4 −1
  4300, // 7 · approval card (status needs you)
] as const;
const DONE = STEPS.length - 1;

/** the first `n` characters of `text`, where n runs 0 → length at `msPerChar` once `active`; whole text if `instant` */
function useTyped(text: string, active: boolean, msPerChar: number, instant: boolean): { shown: string; done: boolean } {
  const [n, setN] = useState(instant ? text.length : 0);
  useEffect(() => {
    if (instant) { setN(text.length); return; }
    if (!active) return;
    const c = animate(0, text.length, { duration: (text.length * msPerChar) / 1000, ease: "linear", onUpdate: (v) => setN(Math.round(v)) });
    return () => c.stop();
  }, [active, instant, text, msPerChar]);
  return { shown: text.slice(0, n), done: n >= text.length };
}

/** a row that is invisible until `on`, then rises 6 px into place */
function Row({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn("transition-[opacity,transform] duration-400 ease-(--ease-out-soft) motion-reduce:transition-none", on ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1.5", className)}>
      {children}
    </div>
  );
}

export function Transcript({ className }: { className?: string }) {
  const t = TRANSCRIPT;
  const reduce = (useReducedMotion() ?? false) || STATIC;
  const root = useRef<HTMLDivElement | null>(null);
  const inView = useInView(root, { once: true, amount: 0.45 });
  const [step, setStep] = useState(reduce ? DONE : -1);

  useEffect(() => {
    if (reduce) { setStep(DONE); return; }
    if (!inView) return;
    const timers = STEPS.map((ms, i) => window.setTimeout(() => setStep(i), ms));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [inView, reduce]);

  const user = useTyped(t.user, step >= 0, 16, reduce);
  const note = useTyped(t.note, step >= 2, 14, reduce);
  const status = step < 1 ? "" : step < 5 ? "thinking" : step < 7 ? "editing callback.ts" : t.status;
  const live = step >= 0 && step < DONE;

  return (
    <div
      ref={root}
      className={cn("terminal mono overflow-hidden text-[13px] leading-6", className)}
      role="img"
      aria-label={`The messages panel of a real rovecode run. You: ${t.user}. Rovecode: ${t.note} Tool rows: read callback.ts, 16 lines; edit callback.ts, plus 4 minus 1. Then an approval card: ${t.approval.title}, ${t.approval.argv}, with allow selected.`}
    >
      <div className="flex items-center justify-between border-b border-(--t-line) px-4 py-2 text-xs">
        <span className="text-(--t-muted)">{t.panel}</span>
        <span className={cn("text-(--t-accent) transition-opacity duration-300", status ? "opacity-100" : "opacity-0")}>◆ {status || t.status}</span>
      </div>

      <div className="grid gap-4 px-4 py-4">
        <div>
          <p className="text-[11px] text-(--t-muted)">
            you <span className={cn("transition-opacity duration-300", user.done ? "opacity-100" : "opacity-0")}>· sent</span>
          </p>
          <p className="font-bold">
            {user.shown}
            {!user.done && <span aria-hidden className="caret-blink text-(--t-accent)">▌</span>}
          </p>
        </div>

        <Row on={step >= 1}>
          <p>
            <span className="text-(--t-accent)">◆</span> <span className="font-bold">rovecode</span>
            <span className="text-(--t-faint)"> · </span>
            <span className="text-(--t-accent)">{status || t.status}</span>
          </p>
          <p className="text-(--t-muted) min-h-6">
            {note.shown}
            {step >= 2 && !note.done && <span aria-hidden className="caret-blink text-(--t-accent)">▌</span>}
          </p>
        </Row>

        <ul className="grid gap-0.5">
          {t.tools.map((r, i) => {
            const on = step >= (i === 0 ? 3 : 5);
            const right = step >= (i === 0 ? 4 : 6);
            return (
              <li key={r.verb} className={cn("flex items-center gap-3 text-(--t-muted) transition-[opacity,transform] duration-400 ease-(--ease-out-soft) motion-reduce:transition-none", on ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1.5")}>
                <span aria-hidden className="w-3 text-center text-(--t-faint)">{r.glyph}</span>
                <span className="w-10">{r.verb}</span>
                <span className="text-[#e6edf5]">{r.file}</span>
                <span className={cn("ml-auto whitespace-nowrap transition-opacity duration-300", right ? "opacity-100" : "opacity-0")}>
                  {"plus" in r ? (
                    <>
                      <span className="text-(--t-plus)">+{r.plus}</span> <span className="text-[#f0605d]">−{r.minus}</span>
                    </>
                  ) : (
                    r.right
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        <Row on={step >= 7} className="rounded-md border border-(--t-line) bg-(--t-card) px-3 py-2.5">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span>
              <span className="text-(--t-accent)">◆</span> <span className="font-bold">{t.approval.title}</span>
            </span>
            <span className="text-(--t-muted)">{t.approval.argv}</span>
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {t.approval.choices.map((c, i) => (
              <span key={c} className={i === 0 ? "rounded-sm bg-(--t-accent) px-1.5 py-0.5 text-[#0e1a26]" : "text-(--t-muted)"}>
                {c}
              </span>
            ))}
            <span className="ml-auto text-(--t-faint)">{t.approval.hint}</span>
          </p>
        </Row>
      </div>

      <div className="flex items-center gap-3 border-t border-(--t-line) px-4 py-2 text-xs text-(--t-faint)">
        <span aria-hidden className={cn("h-4 w-0.5 bg-(--t-accent)", live && "caret-blink")} />
        {t.prompt}
      </div>
    </div>
  );
}
