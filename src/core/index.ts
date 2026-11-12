// The a.js entry point. The command queue, config fetch and pageview come with AAI-67, which
// resolves the endpoint from the script tag's data-endpoint (endpointFromScript), fetches the
// config from configUrl and calls loadAdapter with that endpoint for the consent manager a site's
// config names. The transport (AAI-68) posts batches to eventsUrl with batchRequestInit.
export { loadAdapter } from "./adapter-loader";
export { batchRequestInit, configUrl, endpointFromScript, eventsUrl } from "./endpoint";
