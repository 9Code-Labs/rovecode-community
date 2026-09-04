import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Dict, type PartialDict } from "./en";

/** `code` is what goes in <html lang>, `name` is the language written in itself — never in English, a picker
 *  that says "Turkish" is useless to the person looking for "Türkçe". English ships in the main bundle; every
 *  other dictionary is its own chunk, fetched the first time that language is shown. */
export const LOCALES = [
  { code: "en", name: "English", load: async () => en as PartialDict },
  { code: "tr", name: "Türkçe", load: () => import("./locales/tr").then((m) => m.tr) },
  { code: "de", name: "Deutsch", load: () => import("./locales/de").then((m) => m.de) },
  { code: "fr", name: "Français", load: () => import("./locales/fr").then((m) => m.fr) },
  { code: "es", name: "Español", load: () => import("./locales/es").then((m) => m.es) },
  { code: "pt", name: "Português", load: () => import("./locales/pt").then((m) => m.pt) },
  { code: "it", name: "Italiano", load: () => import("./locales/it").then((m) => m.it) },
  { code: "nl", name: "Nederlands", load: () => import("./locales/nl").then((m) => m.nl) },
  { code: "pl", name: "Polski", load: () => import("./locales/pl").then((m) => m.pl) },
  { code: "ru", name: "Русский", load: () => import("./locales/ru").then((m) => m.ru) },
  { code: "uk", name: "Українська", load: () => import("./locales/uk").then((m) => m.uk) },
  { code: "ja", name: "日本語", load: () => import("./locales/ja").then((m) => m.ja) },
  { code: "ko", name: "한국어", load: () => import("./locales/ko").then((m) => m.ko) },
  { code: "zh", name: "简体中文", load: () => import("./locales/zh").then((m) => m.zh) },
  { code: "ar", name: "العربية", load: () => import("./locales/ar").then((m) => m.ar), rtl: true },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

const KEY = "rovecode.locale";
const isCode = (v: string | null): v is LocaleCode => !!v && LOCALES.some((l) => l.code === v);

/** navigator.languages in order, matched on the primary subtag: "pt-BR" and "pt" both pick pt */
function detect(): LocaleCode {
  if (typeof navigator === "undefined") return "en";
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split("-")[0];
    if (isCode(base)) return base;
  }
  return "en";
}

/** the locale the page should open in: the saved choice, else the browser's */
export function initialLocale(): LocaleCode {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage.getItem(KEY);
  return isCode(saved) ? saved : detect();
}

/** fill every key missing from `part` with the English one; arrays merge element by element so a locale can
 *  translate three of four FAQ answers and leave the fourth in English rather than dropping it */
function merge<T>(base: T, part: unknown): T {
  if (part === undefined || part === null) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(part)) return base;
    return base.map((b, i) => merge(b, part[i])) as T;
  }
  if (typeof base === "object" && base !== null) {
    if (typeof part !== "object" || Array.isArray(part)) return base;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(base as object)) out[k] = merge((base as Record<string, unknown>)[k], (part as Record<string, unknown>)[k]);
    return out as T;
  }
  return (part as T) ?? base;
}

/** merged dictionaries, one per locale once fetched */
const cache = new Map<LocaleCode, Dict>([["en", en]]);

/** resolve a locale's full dictionary (fetching its chunk the first time) */
export async function loadDict(code: LocaleCode): Promise<Dict> {
  const hit = cache.get(code);
  if (hit) return hit;
  const entry = LOCALES.find((l) => l.code === code) ?? LOCALES[0];
  const part = await entry.load();
  const dict = code === "en" ? en : merge(en, part);
  cache.set(code, dict);
  return dict;
}

interface Ctx {
  locale: LocaleCode;
  setLocale: (c: LocaleCode) => void;
  t: Dict;
  rtl: boolean;
}
const I18nContext = createContext<Ctx | null>(null);

/** `initial` should be the locale main.tsx already awaited with loadDict(), so the first paint is in the right
 *  language; later switches show the previous language until the new chunk lands (tens of ms). */
export function I18nProvider({ children, initial }: { children: ReactNode; initial: LocaleCode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(initial);
  const [t, setT] = useState<Dict>(() => cache.get(initial) ?? en);

  useEffect(() => {
    let live = true;
    loadDict(locale).then((d) => { if (live) setT(d); });
    return () => { live = false; };
  }, [locale]);

  const rtl = useMemo(() => { const e = LOCALES.find((l) => l.code === locale); return !!e && "rtl" in e && e.rtl === true; }, [locale]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = rtl ? "rtl" : "ltr";
    document.title = t.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", t.meta.description);
  }, [locale, rtl, t]);

  const setLocale = useCallback((c: LocaleCode) => {
    setLocaleState(c);
    try { window.localStorage.setItem(KEY, c); } catch { /* private mode: the choice just does not persist */ }
  }, []);

  return <I18nContext.Provider value={{ locale, setLocale, t, rtl }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}

/** the common case: just the strings */
export function useT(): Dict {
  return useI18n().t;
}
