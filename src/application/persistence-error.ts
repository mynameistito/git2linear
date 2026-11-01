import { Schema } from "effect";

const taggedFailure = Schema.TaggedError;

/** A redacted durable storage failure. */
export class PersistenceError extends taggedFailure<PersistenceError>()(
  "PersistenceError",
  { operation: Schema.String }
) {}
