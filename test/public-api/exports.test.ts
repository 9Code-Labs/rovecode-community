import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { HOOKS_API_VERSION, PLUGIN_API_VERSION, ToolRegistry, providerStream } from "../../src/public-api.ts";

describe("supported package API", () => {
  test("declares only documented subpath exports", () => {
    expect(pkg.exports).toEqual({
      ".": "./src/index.ts",
      "./extensions": "./src/public-api.ts",
      "./plugins": "./src/plugins/index.ts",
      "./providers": "./src/providers/stream.ts",
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
