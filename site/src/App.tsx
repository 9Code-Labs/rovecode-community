import { Header } from "@/components/Header";
import { SceneBand } from "@/sections/SceneBand";
import { useT } from "@/i18n";
import { Hero } from "@/sections/Hero";
import { Cockpit } from "@/sections/Cockpit";
import { Problems } from "@/sections/Problems";
import { Capabilities } from "@/sections/Capabilities";
import { Security } from "@/sections/Security";
import { Terminal } from "@/sections/Terminal";
import { Quickstart } from "@/sections/Quickstart";
import { Providers } from "@/sections/Providers";
import { Faq } from "@/sections/Faq";
import { Cta } from "@/sections/Cta";
import { Footer } from "@/sections/Footer";

/** section order; the figures live in the hero now, so the numerals start at 02 with the cockpit */
export default function App() {
  const t = useT();
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <a href="#hero-title" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand focus:px-4 focus:py-2 focus:text-on-brand">
        {t.ui.skip}
      </a>
      <Header />
      <main className="relative">
        <Hero />
        <SceneBand />
        <Cockpit n="02" />
        <Problems n="03" />
        <Capabilities n="04" />
        <Security n="05" />
        <Terminal n="06" />
        <Quickstart n="07" />
        <Providers n="08" />
        <Faq n="09" />
        <Cta n="10" />
      </main>
      <Footer />
    </div>
  );
}
