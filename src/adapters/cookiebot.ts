// The Cookiebot adapter, dist/adapters/cookiebot.js: the core loads it once it detects Cookiebot on
// the page (src/core/consent-sources.ts, watchCmpAdapters), and it connects back to follow
// Cookiebot's consent (src/cmp/cookiebot.ts).
import { connectAdapter } from "../core/adapter-api";
import type { AmandaHost } from "../core/queue";
import { watchCookiebot, type CookiebotHost } from "../cmp/cookiebot";

connectAdapter(window as unknown as AmandaHost, "cookiebot", (api) => watchCookiebot(window as unknown as CookiebotHost, api));
