/** Stage a first-party download outside Git tracking. Windows x64 only until other targets are CI-built and smoked. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import pkg from "../package.json";

const root = resolve(import.meta.dir, "..");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("release staging currently supports only windows-x64");
const binary = join(root, "dist", "rovecode.exe");
if (!existsSync(binary)) throw new Error("dist/rovecode.exe is missing — run `bun run build` first");
const stagingRoot = resolve(process.argv[2] ?? join(root, "..", "rovecode-release-staging"));
const releaseDir = join(stagingRoot, `v${pkg.version}`), payload = join(releaseDir, "payload", "rovecode");
rmSync(releaseDir, { recursive: true, force: true }); mkdirSync(payload, { recursive: true });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) cpSync(join(root, file), join(payload, file));
cpSync(binary, join(payload, "rovecode.exe"));
writeFileSync(join(payload, "INSTALL.txt"), [
  `Rovecode v${pkg.version} — Windows x64`, "", "1. Extract this archive.", "2. Run rovecode.exe --version and rovecode.exe --help.",
  "3. Run rovecode.exe connect to configure a provider.", "", "The binary does not include credentials. Keep credentials out of the extracted folder.", "",
].join("\r\n"));
const filename = `rovecode-v${pkg.version}-windows-x64.zip`, archive = join(releaseDir, filename);
mkdirSync(releaseDir, { recursive: true });
const ps = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${payload.replaceAll("'", "''")}\\*' -DestinationPath '${archive.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`], { stdout: "pipe", stderr: "pipe" });
if (ps.exitCode !== 0) throw new Error(ps.stderr.toString());
const bytes = readFileSync(archive), sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  schemaVersion: 1, product: "rovecode", version: pkg.version, channel: "stable",
  publishedAt: null,
  artifacts: [{ platform: "windows", arch: "x64", filename, url: `./${filename}`, bytes: statSync(archive).size, sha256, contentType: "application/zip" }],
};
writeFileSync(join(releaseDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(releaseDir, "SHA256SUMS"), `${sha256}  ${filename}\n`);
console.log(JSON.stringify({ releaseDir, archive: basename(archive), sha256, bytes: statSync(archive).size }, null, 2));
