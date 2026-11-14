// The Usercentrics adapter, dist/adapters/usercentrics.js: the core loads it once it detects
// Usercentrics on the page (src/core/consent-sources.ts, watchCmpAdapters), and it connects back to
// follow Usercentrics' consent (src/cmp/usercentrics.ts).
import { connectAdapter } from "../core/adapter-api";
import type { AmandaHost } from "../core/queue";
import { watchUsercentrics, type UsercentricsHost } from "../cmp/usercentrics";

connectAdapter(window as unknown as AmandaHost, "usercentrics", (api) => watchUsercentrics(window as unknown as UsercentricsHost, api));
