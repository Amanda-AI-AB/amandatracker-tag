// The npm package's entry point (AAI-222), for a site that bundles its front end rather than install
// a.js with a script tag. It is the same tag as a.js, started by the same code (src/core/tag.ts),
// with two differences: the site's code gives the site and endpoint to init, as the script tag's
// data-site and data-endpoint would, and a config's pinned build is never loaded in its place, since
// the site chose the package's version when it bundled it.
//
// Importing it does nothing: the tag starts at init. amanda(...) is the command queue's function,
// window.amanda: a call made before init, or while the config loads, queues and runs once the tag
// has booted, as a call to the snippet's stub does.
import { ensureStub, type AmandaHost } from "../core/queue";
import { startTag } from "../core/tag";

export interface InitOptions {
  /** The site's public id, as data-site gives it to a.js. */
  readonly site: string;
  /**
   * Where the tag fetches its config and sends its events, as data-endpoint gives it to a.js: a
   * path on the page's own origin behind a first-party reverse proxy, such as "/amnda", or an
   * https: URL. None means the default collection host.
   */
  readonly endpoint?: string;
}

class NoWindowError extends Error {
  override name = "NoWindowError";
}

/** The page's window; there is none on a server, where a site's code may also run (SSR). */
function pageWindow(): AmandaHost {
  if (typeof window === "undefined") {
    throw new NoWindowError("amandatracker-tag: no window: call init and amanda in the browser, not on the server");
  }
  return window as unknown as AmandaHost;
}

/**
 * Starts the tag for options.site. Call it once, in the browser, as the app loads. Settles with
 * true once the tag has booted, or false when it didn't: its failure was reported to the collector,
 * a.js or an earlier init already runs on the page, or the site's kill switch is on. It never
 * rejects.
 */
export function init(options: InitOptions): Promise<boolean> {
  pageWindow();
  const started = startTag({ site: options.site, endpoint: options.endpoint });
  return started === undefined ? Promise.resolve(false) : started.then((tag) => tag !== undefined);
}

/**
 * Runs a command of the tag, as window.amanda(command, ...args) does, such as
 * amanda("consent", { analytics: "granted", ads: "denied" }) or amanda("event", "signup", { plan: "pro" }).
 * Before init, and until the tag has booted, the call queues.
 */
export function amanda(command: string, ...args: unknown[]): void {
  const win = pageWindow();
  ensureStub(win);
  win.amanda!(command, ...args);
}
