// The a.js entry point: it starts the tag (src/core/tag.ts) synchronously at the IIFE's top level,
// where document.currentScript is the installing script tag, which names the site and endpoint.
import { startTag } from "./tag";

startTag();
