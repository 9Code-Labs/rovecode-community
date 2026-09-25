import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { HOOKS_API_VERSION, PLUGIN_API_VERSION, ToolRegistry, providerStream } from "../../src/public-api.ts";

describe("supported package API", () => {
  test("declares only documented subpath exports", () => {
    // dist-only tarball (0.4.0-beta.0): the published exports answer from the minified lib bundles
    // that `prepack` → build:npm produces; this repository's src/ is the AGPL source of those bundles
    expect(pkg.exports).toEqual({
      ".": "./dist/lib/index.js",
      "./extensions": "./dist/lib/public-api.js",
      "./plugins": "./dist/lib/plugins.js",
      "./providers": "./dist/lib/providers.js",
      "./sdk": "./dist/lib/sdk.js",
      "./package.json": "./package.json",
    });
  });

  test("extension compatibility gates and constructors are reachable", () => {
    expect(HOOKS_API_VERSION).toBe(1);
    expect(PLUGIN_API_VERSION).toBe(1);
    expect(typeof ToolRegistry).toBe("function");
    expect(typeof providerStream).toBe("function");
  });
});
