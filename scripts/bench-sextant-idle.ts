/** Idle cost of the sextant frame loop: a SextantRenderer over MemoryIO, real clock, nobody typing.
 *  Prints CPU ms per wall second, ticks and frames. `--busy` keeps a spinner running (s.running) so the
 *  animated cost is visible next to the idle one. Usage: bun scripts/bench-sextant-idle.ts <seconds> [--busy] [--warm <seconds>] (warm-up default 2 s; 15 s reaches the asleep stage) */
import { SextantRenderer } from "../src/sextant/sextant-renderer.ts";
import { MemoryIO } from "../src/tui/sextant-io.ts";

const secs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? "5");
const busy = process.argv.includes("--busy");
const warmIx = process.argv.indexOf("--warm");
const warmMs = warmIx !== -1 ? Number(process.argv[warmIx + 1]) * 1000 : 2000;
const io = new MemoryIO(160, 44, {});
const r = new SextantRenderer({ io, cwd: process.cwd(), scan: false, pet: "rovecode" });
r.setCommands([]);
r.start({ onSubmit: () => {}, onInterrupt: () => {}, onExit: () => {} });
if (busy) r.setBusy(true, "thinking");
// let the boot reveal (600 ms) and the pet's boot (1300 ms) finish before measuring
await new Promise((res) => setTimeout(res, warmMs));
const f0 = r.frames, c0 = process.cpuUsage(), t0 = performance.now();
await new Promise((res) => setTimeout(res, secs * 1000));
const c1 = process.cpuUsage(c0), wall = (performance.now() - t0) / 1000;
const cpuMs = (c1.user + c1.system) / 1000;
console.log(JSON.stringify({ mode: busy ? "busy" : "idle", warmS: warmMs / 1000, wallS: +wall.toFixed(2), cpuMsPerS: +(cpuMs / wall).toFixed(2), framesPerS: +((r.frames - f0) / wall).toFixed(2), bytesWritten: io.output().length }));
r.stop();
await r.drain();
process.exit(0);
