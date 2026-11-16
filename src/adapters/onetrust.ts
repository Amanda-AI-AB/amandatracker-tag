// The OneTrust adapter, dist/adapters/onetrust.js: the core loads it once it detects OneTrust on
// the page (src/core/consent-sources.ts, watchCmpAdapters), and it connects back to follow
// OneTrust's consent (src/cmp/onetrust.ts).
import { connectAdapter } from "../core/adapter-api";
import type { AmandaHost } from "../core/queue";
import { watchOneTrust, type OneTrustHost } from "../cmp/onetrust";

connectAdapter(window as unknown as AmandaHost, "onetrust", (api) => watchOneTrust(window as unknown as OneTrustHost, api));
