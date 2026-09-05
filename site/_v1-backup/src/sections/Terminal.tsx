import { Reveal } from "@/components/Motion";
import { Section } from "@/components/Section";
import { Shot } from "@/components/Shot";
import { SHOTS } from "@/content";

export function Terminal() {
  return (
    <Section
      id="terminal"
      n="05"
      eyebrow="from the terminal"
      title="Four real frames at 160×44, with the parts worth reading numbered."
      lead="Rendered headlessly through the sextant painters at a fixed clock: the same code path the TUI paints with, not a mockup. Hover a frame to flatten it; hover a row to light its marker."
      headMax="max-w-[52rem]"
    >
      <div className="grid gap-20 md:gap-28">
        {SHOTS.map((s, i) => (
          <Reveal key={s.file}>
            <Shot {...s} index={i} flip={i % 2 === 1} />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
