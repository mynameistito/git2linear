import { Schema } from "effect";

const taggedFailure = Schema.TaggedError;

/** A redacted reconciliation failure. */
export class ReconciliationError extends taggedFailure<ReconciliationError>()(
  "ReconciliationError",
  { operation: Schema.String }
) {}
