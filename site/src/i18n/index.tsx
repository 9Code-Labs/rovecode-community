import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Dict, type PartialDict } from "./en";
import { tr } from "./locales/tr";
import { de } from "./locales/de";
import { fr } from "./locales/fr";
import { es } from "./locales/es";
import { pt } from "./locales/pt";
import { it } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { ru } from "./locales/ru";
import { uk } from "./locales/uk";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { zh } from "./locales/zh";
import { ar } from "./locales/ar";

/** `code` is what goes in <html lang>, `name` is the language written in itself — never in English, a picker
 *  that says "Turkish" is useless to the person looking for "Türkçe". */
export const LOCALES = [
  { code: "en", name: "English", dict: en as PartialDict },
  { code: "tr", name: "Türkçe", dict: tr },
  { code: "de", name: "Deutsch", dict: de },
  { code: "fr", name: "Français", dict: fr },
  { code: "es", name: "Español", dict: es },
  { code: "pt", name: "Português", dict: pt },
  { code: "it", name: "Italiano", dict: it },
  { code: "nl", name: "Nederlands", dict: nl },
  { code: "pl", name: "Polski", dict: pl },
  { code: "ru", name: "Русский", dict: ru },
  { code: "uk", name: "Українська", dict: uk },
  { code: "ja", name: "日本語", dict: ja },
  { code: "ko", name: "한국어", dict: ko },
  { code: "zh", name: "简体中文", dict: zh },
  { code: "ar", name: "العربية", dict: ar, rtl: true },
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

interface Ctx {
  locale: LocaleCode;
  setLocale: (c: LocaleCode) => void;
  t: Dict;
  rtl: boolean;
}
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => {
    if (typeof window === "undefined") return "en";
    const saved = window.localStorage.getItem(KEY);
    return isCode(saved) ? saved : detect();
  });

  const entry = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
  const rtl = "rtl" in entry && entry.rtl === true;
  const t = useMemo(() => (locale === "en" ? en : merge(en, entry.dict)), [locale, entry.dict]);

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
