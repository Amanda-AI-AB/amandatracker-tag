// The a.js entry point: it boots the tag (src/core/boot.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, inside the error boundary, whose
// sampled reports go to the collector as tag errors (src/core/telemetry.ts).
//
// Still to come: a pageview goes through the consent state machine (src/core/consent.ts,
// createConsent), which makes it an event with the visitor and session ids (src/core/identity.ts,
// createIdentity: its ids() in the sink's identified path, itself as the machine's identity) and the
// consent snapshot, its click IDs dropped under denied ads (src/core/attribution.ts, gateClickIds), or a ping in declined mode `pings` (src/core/ping.ts, pingOf); then it goes to the transport
// (src/core/transport.ts, createTransport) (AAI-964), whose withdrawEvents is the machine sink's
// withdraw, so that nothing goes after a decline (AAI-86; test/declined-off.test.ts wires them all
// as a.js is to). A page_exit (src/core/engagement.ts) goes the same way, as an event only: it never
// becomes a ping, whose field list has no engagement time. A form_submit (src/core/forms.ts) goes
// as a page_exit does, an event only, and so does an identify event (src/core/identify.ts), whose
// command refuses unless the site's config turns identify on. Until then, a pageview, a page_exit, a
// form_submit and an identify event go nowhere. Scroll depth (src/core/scroll.ts) is off by default, and a.js passes no onScrollDepth: the
// per-site toggle that turns it on is AAI-791's. The
// machine is to be handed to boot as its `consent` option, which makes the consent sources
// (src/core/consent-sources.ts: GPC, the `consent` command, Google Consent Mode, TCF and the
// adapters of the consent managers it detects, such as Cookiebot's, OneTrust's and Usercentrics') drive it; until
// then the tag follows no consent source.
import { boot, type TagWindow } from "./boot";
import { ErrorBoundary, warn } from "./boundary";
import { TAG_VERSION } from "./build-info";
import { defaultTarget, ERROR_SAMPLE_RATE, tagErrorSink } from "./telemetry";

const target = defaultTarget();
const boundary = new ErrorBoundary(
  (report) => {
    if (typeof fetch !== "function") {
      warn("amanda: no fetch to report a tag error with", report);
      return;
    }
    tagErrorSink(fetch.bind(window), TAG_VERSION, target)(report);
  },
  ERROR_SAMPLE_RATE,
);

boundary.guard("boot", () =>
  boot(window as unknown as TagWindow, {
    tagVersion: TAG_VERSION,
    boundary,
    target,
    onPageview: () => undefined,
    onPageExit: () => undefined,
    onFormSubmit: () => undefined,
    onIdentify: () => undefined,
  }),
);
