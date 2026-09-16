// bun --preload ./scripts/probe-exit.ts <entry> [args]: at exit, print how long the process lived (ms since process start) and its RSS, to stderr.
process.on("exit", () => {
  const m = process.memoryUsage();
  process.stderr.write(`[probe-exit] ${JSON.stringify({ sinceStartMs: +performance.now().toFixed(0), rssMB: +(m.rss / 1048576).toFixed(1), heapMB: +(m.heapUsed / 1048576).toFixed(1), modules: Object.keys(require.cache).length })}\n`);
});
