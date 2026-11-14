// The a.js entry point: it boots the tag (src/core/boot.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, inside the error boundary, whose
// sampled reports go to the collector as tag errors (src/core/telemetry.ts).
//
// Still to come: a pageview goes through the consent state machine (src/core/consent.ts,
// createConsent), which makes it an event with the visitor and session ids (AAI-98) and the
// consent snapshot, or a ping in declined mode; then it goes to the transport
// (src/core/transport.ts, createTransport) (AAI-964). Until then, a pageview goes nowhere.
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
  }),
);
