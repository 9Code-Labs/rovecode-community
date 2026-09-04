import { useEffect, useRef, useState } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";

/** "1,600+" counts from 0 to 1,600 over 1.1 s the first time it scrolls into view and keeps its suffix;
 *  a value without a leading number ("AGPL-3.0") is rendered as is */
export function CountUp({ value }: { value: string }) {
  const m = /^([\d,]+)(.*)$/.exec(value);
  const target = m ? Number(m[1].replace(/,/g, "")) : NaN;
  const suffix = m ? m[2] : "";
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const [n, setN] = useState(reduce ? target : 0);

  useEffect(() => {
    if (!inView || reduce || Number.isNaN(target)) return;
    const c = animate(0, target, { duration: 1.1, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setN(Math.round(v)) });
    return () => c.stop();
  }, [inView, reduce, target]);

  if (Number.isNaN(target)) return <span ref={ref}>{value}</span>;
  return (
    <span ref={ref} className="tabular-nums">
      {(reduce ? target : n).toLocaleString("en-US")}
      {suffix}
    </span>
  );
}
