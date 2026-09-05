import { CopyCommand } from "@/components/CopyCommand";
import { Glass } from "@/components/Glass";
import { GitHubMark } from "@/components/GitHubMark";
import { LightField } from "@/components/LightField";
import { Mascot } from "@/components/Mascot";
import { Reveal } from "@/components/Motion";
import { INSTALL, REPO } from "@/content";

export function Cta() {
  return (
    <section id="get" className="section-pad relative overflow-x-clip" aria-labelledby="cta-title">
      <LightField className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" size={1400} strength={0.22} />
      <div className="relative mx-auto w-full max-w-[1200px] px-5 md:px-8">
        <Reveal>
          <Glass pad="lg" className="grid gap-10 md:p-12 lg:grid-cols-12 lg:items-center lg:p-14">
            <div className="lg:col-span-8">
              <p className="eyebrow mb-5 flex items-center gap-3">
                <span className="text-brand">09</span>
                <span aria-hidden className="h-px w-6 bg-border-strong" />
                get nimbus
              </p>
              <h2 id="cta-title" className="h2 max-w-[24rem]">
                Six panels. Sixteen providers. Zero pricing page.
              </h2>
              <div className="mt-8 grid gap-3 sm:grid-cols-12 sm:items-center">
                <CopyCommand command={INSTALL} wrap className="min-w-0 sm:col-span-8" />
                <div className="min-w-0 sm:col-span-4 sm:justify-self-end">
                  <a
                    href={REPO}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-12 items-center gap-2.5 rounded-pill bg-brand pl-5 pr-6 text-[15px] font-medium text-on-brand shadow-[0_12px_32px_rgba(92,184,255,0.25)] transition-[background-color,transform,box-shadow] duration-150 hover:bg-brand-hover hover:shadow-[0_16px_40px_rgba(92,184,255,0.32)] active:scale-[0.98]"
                  >
                    <GitHubMark className="size-[18px]" />
                    Star on GitHub
                  </a>
                </div>
              </div>
            </div>
            <div className="lg:col-span-4 lg:justify-self-end">
              <Mascot size="lg" quip="sun's out." mood="sunny" />
            </div>
          </Glass>
        </Reveal>
      </div>
    </section>
  );
}
