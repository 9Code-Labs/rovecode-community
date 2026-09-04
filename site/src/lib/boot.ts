/** Where and how this module is running, decided once at load.
 *
 *  `SSR`          — rendering to a string at build time (scripts/prerender.mjs), no window.
 *  `PRERENDERED`  — the browser is booting on HTML that already contains the page (the normal production case):
 *                   the text was on screen before any script ran, so nothing may hide it again to animate it in.
 *  `STATIC`       — either of the above: components render their finished state, no entrances, no replays.
 *  In `bun run dev` the root is empty, so STATIC is false and the motion is visible while designing. */
export const SSR = typeof window === "undefined";
export const PRERENDERED = !SSR && (document.getElementById("root")?.childElementCount ?? 0) > 0;
export const STATIC = SSR || PRERENDERED;
