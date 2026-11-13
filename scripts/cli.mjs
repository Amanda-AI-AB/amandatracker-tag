// What the scripts share as commands: the repo root, and how each runs as `node scripts/<name>.mjs`.
// It imports only Node's own modules: cloudbuild/release.yaml runs release-version.mjs before
// `pnpm install`.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

/**
 * Runs `main` when the module at `moduleUrl` is the script node was started with. An error of one of
 * the `expected` classes is printed as `<label>: <message>` and exits 1, as CI sees it; any other
 * propagates.
 * @param {string} moduleUrl the script's import.meta.url
 * @param {() => unknown} main
 * @param {[new (...args: any[]) => Error, string][]} [expected] each error class with its label
 */
export async function runMain(moduleUrl, main, expected = []) {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  try {
    await main();
  } catch (error) {
    const match = expected.find(([type]) => error instanceof type);
    if (match === undefined || !(error instanceof Error)) throw error;
    console.error(`${match[1]}: ${error.message}`);
    process.exit(1);
  }
}
