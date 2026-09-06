// Standalone cost of importing one module in a fresh bun: wall ms for the import, RSS over the bare-bun
// floor, and the module count it pulled in. Usage: bun scripts/probe-import.ts <specifier relative to repo root> [floorMB]  (floor: what `bun scripts/probe-import.ts node:path` reports)
const spec = process.argv[2]!;
const floor = Number(process.argv[3] ?? "0");
const before = Object.keys(require.cache).length;
const rss0 = process.memoryUsage().rss;
const t0 = performance.now();
await import(spec);
const ms = performance.now() - t0;
Bun.gc(true);
const rss = process.memoryUsage().rss / 1048576;
const mods = Object.keys(require.cache).length - before;
const nm = [...new Set(Object.keys(require.cache).filter((k) => k.includes("node_modules")).map((k) => k.replace(/\\/g, "/").replace(/.*node_modules\//, "").split("/").slice(0, k.includes("/@") ? 2 : 1).join("/")))];
console.log(JSON.stringify({ spec, ms: +ms.toFixed(1), rssMB: +rss.toFixed(1), overFloorMB: floor ? +(rss - floor).toFixed(1) : undefined, deltaMB: +((rss * 1048576 - rss0) / 1048576).toFixed(1), mods, sinceStartMs: +performance.now().toFixed(0), nm }));

export {};
