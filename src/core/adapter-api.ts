// The contract between the core and a consent-manager adapter (src/adapters/<name>.ts). The core
// loads an adapter only once it detects that consent manager on the page (consent-sources.ts,
// watchCmpAdapters); the adapter, its own IIFE, then connects back through the page's command
// queue, amanda('adapter', <name>, connect), and the core calls connect with the AdapterApi below.
// The core imports only types and ADAPTER_COMMAND from here; connectAdapter is the adapters' alone.

import { warn } from "./boundary";
import type { ConsentSignal } from "./consent";
import type { AmandaHost } from "./queue";

/** The command an adapter connects with: amanda('adapter', name, connect). */
export const ADAPTER_COMMAND = "adapter";

/** What the core hands a connected adapter. */
export interface AdapterApi {
  /**
   * Hands the consent manager's signal to the consent ladder, as the adapter's own source. A signal
   * names `analytics` and `ads`, each granted or denied; a category the consent manager hasn't
   * decided is left out, never assumed. Throws ConsentError on any other signal.
   */
  signal(signal: ConsentSignal): void;
  /** Runs fn inside the core's error boundary: what it throws is reported, and never thrown on. */
  guard(fn: () => void): void;
}

export type AdapterConnect = (api: AdapterApi) => void;

/**
 * An adapter's top level: connects it to the core that loaded it. Warns, and does nothing else,
 * when the page has no amanda() to connect to, since only the core loads adapters.
 */
export function connectAdapter(win: AmandaHost, name: string, connect: AdapterConnect): void {
  const amanda = win.amanda;
  if (typeof amanda !== "function") {
    warn(`amanda: the ${name} adapter loaded without the tag; it follows nothing`);
    return;
  }
  amanda(ADAPTER_COMMAND, name, connect);
}
