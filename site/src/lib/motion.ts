import { useEffect, useState, type RefObject } from "react";

/** The little motion the page still has, without a library: a reduced-motion query, an "entered the viewport once"
 *  observer, and a requestAnimationFrame tween. That is all the transcript replay and the count-up need. */

export const EASE_OUT = (t: number): number => 1 - Math.pow(1 - t, 3);

/** true when the visitor asked for reduced motion; tracks the setting live */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** true once `amount` of the element has been on screen; stays true */
export function useInViewOnce<T extends Element>(ref: RefObject<T | null>, amount = 0.5): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => { if (e && e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: amount });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen, amount]);
  return seen;
}

/** animate a number from → to over `ms`, eased out; returns a stop function */
export function tween(from: number, to: number, ms: number, onUpdate: (v: number) => void, ease: (t: number) => number = EASE_OUT): () => void {
  let raf = 0;
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    onUpdate(from + (to - from) * ease(p));
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
