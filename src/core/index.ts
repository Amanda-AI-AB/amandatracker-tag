// The a.js entry point. The command queue, config fetch and pageview come with AAI-67, which
// reads currentScript(document) once, synchronously at the IIFE's top level, and resolves the
// endpoint from that script tag's data-endpoint (endpointFromScript, with location), fetches the
// config from configUrl with configRequestInit and calls loadAdapter with that endpoint for the
// consent manager a site's config names. The transport (AAI-68) posts batches to eventsUrl with
// batchRequestInit, naming each batch's kind, and splits its pagehide flush by bodyBytes to stay
// within KEEPALIVE_BODY_LIMIT.
export { loadAdapter } from "./adapter-loader";
export {
  BatchSizeError,
  KEEPALIVE_BODY_LIMIT,
  REFERRER_POLICY,
  batchRequestInit,
  bodyBytes,
  configRequestInit,
  configUrl,
  currentScript,
  endpointFromScript,
  eventsUrl,
} from "./endpoint";
