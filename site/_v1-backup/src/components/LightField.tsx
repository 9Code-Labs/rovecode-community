import { cn } from "@/lib/utils";

/** a very large, very soft sky-blue light behind the glass — tonal only, ~8 % average alpha (14 % core), no hue shift */
export function LightField({ className, strength = 0.2, size = 900 }: { className?: string; strength?: number; size?: number }) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute -z-0 rounded-full", className)}
      style={{
        width: size,
        height: Math.round(size * 0.66),
        background: `radial-gradient(closest-side, rgba(92,184,255,${strength}) 0%, rgba(92,184,255,${strength * 0.8}) 40%, rgba(92,184,255,${strength * 0.3}) 75%, rgba(92,184,255,0) 100%)`,
        filter: "blur(40px)",
        transform: "translateZ(0)",
      }}
    />
  );
}
