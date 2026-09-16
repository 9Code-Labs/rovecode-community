import { expect, test } from "bun:test";
import { join, parse } from "node:path";
import { shouldWarmRepoMap } from "../../src/cli/repomap-root.ts";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();

test("automatic repo-map warmup skips home and filesystem root, not actual projects or siblings", () => {
  const home = scratch("rove-index-home-");
  expect(shouldWarmRepoMap(home, home)).toBe(false);
  expect(shouldWarmRepoMap(join(home, "."), home)).toBe(false);
  expect(shouldWarmRepoMap(parse(home).root, home)).toBe(false);
  expect(shouldWarmRepoMap(join(home, "projects", "app"), home)).toBe(true);
  expect(shouldWarmRepoMap(home + "-project", home)).toBe(true);
});
