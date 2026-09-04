import { useEffect, useRef, useState } from "react";
import { STATIC } from "@/lib/boot";
import { tween, useInViewOnce, usePrefersReducedMotion } from "@/lib/motion";

/** "1,800+" counts from 0 to 1,800 over 1.1 s the first time it scrolls into view and keeps its suffix; a value
 *  without a leading number ("AGPL-3.0") is rendered as is. Prerendered and reduced-motion pages show the figure. */
export function CountUp({ value }: { value: string }) {
  const m = /^([\d,]+)(.*)$/.exec(value);
  const target = m ? Number(m[1].replace(/,/g, "")) : NaN;
  const suffix = m ? m[2] : "";
  const still = usePrefersReducedMotion() || STATIC;
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInViewOnce(ref, 0.6);
  const [n, setN] = useState(still ? target : 0);

  useEffect(() => {
    if (!inView || still || Number.isNaN(target)) return;
    return tween(0, target, 1100, (v) => setN(Math.round(v)));
  }, [inView, still, target]);

  if (Number.isNaN(target)) return <span ref={ref}>{value}</span>;
  return (
    <span ref={ref} className="tabular-nums">
      {(still ? target : n).toLocaleString("en-US")}
      {suffix}
    </span>
  );
}
