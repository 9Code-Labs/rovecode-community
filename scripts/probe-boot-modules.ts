/** Where the wall time between typing `rovecode` and the first frame goes, module by module.
 *
 *  Berkay reported the TUI "opening very late" (2026-09-07). `ROVECODE_TRACE_BOOT=1` now covers the whole
 *  stretch and answers most of it — on this machine, piped stdin: intro started +13 ms, surface modules
 *  loaded +131 ms, runTui entered +138 ms, first paint +224 ms. On a REAL terminal the intro's own floor
 *  (core/intro.ts INTRO_MS) is added on top, because `await intro.done` holds the TUI back until the show
 *  ends — so the gap between "surface modules loaded" and "intro finished" is pure waiting.
 *
 *  This probe measures the other half: the import cost itself, in the order src/cli/main.ts's interactive
 *  branch pays it. That number matters because it is the floor the intro is hiding — shortening the show
 *  only helps down to this. Sister probe: scripts/probe-boot.ts times a whole sextant BOOT (RSS, modules,
 *  first frame); this one times only module evaluation. Run: `bun scripts/probe-boot-modules.ts` */

const ms = (t: number): string => `${(performance.now() - t).toFixed(0).padStart(5)} ms`;

async function step(label: string, load: () => Promise<unknown>): Promise<void> {
  const t = performance.now();
  await load();
  console.log(`${ms(t)}  ${label}`);
}

const total = performance.now();
console.log("module evaluation, in the order the interactive path does it:\n");

// Each is charged only for what it pulls in that nothing before it already pulled, which is the honest
// way to read the list: a module that looks cheap here may only be cheap because the one above it
// already paid for its dependencies.
await step("core/intro.ts", () => import("../src/core/intro.ts"));
await step("tui/app.ts", () => import("../src/tui/app.ts"));
await step("tui/notify.ts", () => import("../src/tui/notify.ts"));
await step("cli/run-flags.ts", () => import("../src/cli/run-flags.ts"));

console.log(`\n${ms(total)}  total`);
export {};
