import { Header } from "@/components/Header";
import { Hero } from "@/sections/Hero";
import { Proof } from "@/sections/Proof";
import { Problems } from "@/sections/Problems";
import { Capabilities } from "@/sections/Capabilities";
import { Terminal } from "@/sections/Terminal";
import { Quickstart } from "@/sections/Quickstart";
import { Providers } from "@/sections/Providers";
import { Faq } from "@/sections/Faq";
import { Cta } from "@/sections/Cta";
import { Footer } from "@/sections/Footer";

export default function App() {
  return (
    <div className="ink-field min-h-dvh overflow-x-clip">
      <a href="#hero-title" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-brand focus:px-4 focus:py-2 focus:text-on-brand">
        Skip to content
      </a>
      <Header />
      <main className="relative">
        <Hero />
        <Proof />
        <Problems />
        <Capabilities />
        <Terminal />
        <Quickstart />
        <Providers />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
