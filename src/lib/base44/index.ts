/**
 * Adapter selection.
 *
 * The rest of the app calls getBase44Adapter() and never constructs one, so
 * there is exactly one place in the codebase where Base44 is reached.
 */
import "server-only";
import { base44Configured } from "@/lib/env";
import { LiveBase44Adapter } from "@/lib/base44/live";
import { MockBase44Adapter } from "@/lib/base44/mock";
import type { Base44Adapter } from "@/lib/base44/types";

export type { Base44Adapter, Base44Request, Base44Result } from "@/lib/base44/types";

let override: Base44Adapter | null = null;
let live: LiveBase44Adapter | null = null;
let mock: MockBase44Adapter | null = null;

/** Test hook. */
export function setBase44AdapterForTests(adapter: Base44Adapter | null) {
  override = adapter;
}

export function getBase44Adapter(): Base44Adapter {
  if (override) return override;
  if (base44Configured()) return (live ??= new LiveBase44Adapter());
  return (mock ??= new MockBase44Adapter());
}

/** Surfaced in the UI so mock data is never mistaken for real research. */
export function base44Mode(): "live" | "mock" {
  return getBase44Adapter().mode;
}
