/** The market's public face. Every surface — the CLI, the sextant's /market, the site's build step —
 *  imports from here and from nowhere deeper, so the internals can move without touching them.
 *
 *  Importing this module pulls in `registry.ts` and `install.ts`, which reach the MCP and plugin modules;
 *  it is NOT free, so keep it off the boot path (cli/main.ts loads `market-cmd.ts` with a dynamic import
 *  inside `case "market"`, and the TUI should reach it the same way, on first use). `types.ts` alone is
 *  free — import that directly when all you need is a shape. */

export type {
  MarketKind, MarketSource, MarketScope, MarketEnv, InstallSpec, MarketItem,
  InstalledState, MarketRow, SourceStatus, MarketResult, InstallPlanView, InstallOutcome, ItemDocs,
} from "./types.ts";
export { LIMITS, parseQualifiedId, qualify, itemLine } from "./types.ts";

export type { RegistryDeps } from "./registry.ts";
export { searchMarket, findItem, allItems, itemFromCatalog, itemFromMcp, CATALOG_FILES, CATALOG_DIR, MCP_DOCS_FILE } from "./registry.ts";

export type { Resolution } from "./resolve.ts";
export { resolveTarget, resolveDirect } from "./resolve.ts";

export type { PlanOptions, RunDeps } from "./install.ts";
export { planInstall, runInstall, installedState, withInstalled, removeItem, skillDir } from "./install.ts";
