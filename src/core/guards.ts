// Type guards shared by the core, the wire and the adapters. This module imports nothing, so an
// adapter's bundle that uses it takes only what it uses.

/** Whether value is an object whose properties can be read: not null, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
