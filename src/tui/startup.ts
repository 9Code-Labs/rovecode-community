/** Wait for required startup work without trapping Ctrl+C behind a slow probe. The readiness promise
 *  stays observed after cancellation, so a late rejection cannot become an unhandled rejection. */
export function waitForStartup(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ready;
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason ?? new Error("startup cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) { cleanup(); abort(); }
    ready.then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
  });
}
