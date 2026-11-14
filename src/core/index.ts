// The a.js entry point: it boots the tag (src/core/boot.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, inside the error boundary, whose
// sampled reports go to the collector as tag errors (src/core/telemetry.ts).
//
// Still to come: the transport (AAI-68) takes the pageviews, posting batches to eventsUrl with
// batchRequestInit, naming each batch's kind, and splitting its pagehide flush by bodyBytes to stay
// within KEEPALIVE_BODY_LIMIT. Until it does, a pageview goes nowhere.
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
