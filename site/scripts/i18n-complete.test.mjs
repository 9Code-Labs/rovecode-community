/** Every locale must translate every string, and the gap must be visible before a deploy rather than on
 *  the page.
 *
 *  This exists because a whole section shipped in English to fourteen locales: `security` (37 strings) was
 *  added to en.ts and only Turkish followed, and `nav.security` was missing too — so the Arabic navigation
 *  read "القمرة · القدرات · Security · الطرفية" in the first line a visitor sees. `merge()` in
 *  src/i18n/index.tsx fills a missing key with English on purpose, which is the right runtime behaviour and
 *  exactly why nothing broke: the page renders, in the wrong language, and no test noticed.
 *
 *  So the report is per key path, not a count. When a new section is added to en.ts this file goes red with
 *  the list of what to translate, which is the only moment the list is cheap to act on. */
import { describe, expect, test } from "bun:test";
import { en } from "../src/i18n/en.ts";

const LOCALES = ["ar", "de", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "uk", "zh"];

/** every leaf path in the English dictionary: "security.layers.0.decides" */
function paths(node, prefix = "") {
  if (Array.isArray(node)) return node.flatMap((v, i) => paths(v, `${prefix}${i}.`));
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => paths(v, `${prefix}${k}.`));
  return [prefix.slice(0, -1)];
}

const at = (obj, path) => path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);

/** strings that are the same in every language: proper nouns, licence names, flags, code */
const UNIVERSAL = new Set(["AGPL-3.0-only", "FAQ", "Terminal", "MCP", "rovecode", "sunny", "GitHub", "README"]);

/** …and the key paths where English IS the translation, so no locale needs to carry them: two proper nouns,
 *  a shell line, and a legal line that is version numbers and a licence id. Anything not on this list that a
 *  locale leaves out is a gap, not a decision. */
const SHARED = new Set(["ui.readme", "ui.github", "quickstart.runLabel", "footer.legal"]);

const dicts = Object.fromEntries(
  await Promise.all(LOCALES.map(async (code) => [code, (await import(`../src/i18n/locales/${code}.ts`))[code]])),
);

describe("i18n · every locale carries every string", () => {
  const all = paths(en);

  test("the English dictionary is the shape everything else is measured against", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all).toContain("nav.security");
    expect(all).toContain("security.layers.0.decides");
    expect(all).toContain("capabilities.surfaceTitle");
  });

  test.each(LOCALES)("%s translates every key", (code) => {
    const dict = dicts[code];
    const missing = all.filter((p) => !SHARED.has(p)).filter((p) => {
      const v = at(dict, p);
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });
    // the message is the work list, not a number
    expect({ code, missing }).toEqual({ code, missing: [] });
  });

  test.each(LOCALES)("%s does not simply repeat the English prose", (code) => {
    const dict = dicts[code];
    // a long sentence identical to English is a copy-paste, not a translation. Short strings and proper
    // nouns legitimately match, so only prose over 40 characters is checked.
    const copied = paths(en)
      .filter((p) => typeof at(en, p) === "string" && at(en, p).length > 40)
      .filter((p) => !SHARED.has(p) && at(dict, p) === at(en, p) && !UNIVERSAL.has(at(en, p)));
    expect({ code, copied }).toEqual({ code, copied: [] });
  });
});
