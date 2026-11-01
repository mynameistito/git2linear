import { Config, Effect, Redacted, Schema } from "effect";

import { readJsonEffect, requestEffect } from "../src/providers/http";

const OperatorResponse = Schema.Struct({
  dryRun: Schema.optionalKey(Schema.Boolean),
  runId: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(
    Schema.Struct({
      alreadyConfigured: Schema.Number,
      created: Schema.Number,
      discovered: Schema.Number,
      failed: Schema.Number,
      manualActionRequired: Schema.Number,
      repaired: Schema.Number,
      skipped: Schema.Number,
    })
  ),
  updatedAt: Schema.optionalKey(Schema.Number),
});

const Action = Schema.Literals(["status", "dry-run", "apply"]);
const Token = Schema.String.check(Schema.isMinLength(43));
const taggedFailure = Schema.TaggedError;

class OperatorFailure extends taggedFailure<OperatorFailure>()(
  "OperatorFailure",
  {}
) {}

const operate = Effect.fn("Operator.operate")(function* operate(
  actionInput: string
) {
  const origin = yield* Config.String("WORKER_ORIGIN");
  const secret = yield* Config.Redacted("MANUAL_TRIGGER_TOKEN");

  const action = yield* Schema.decodeUnknownEffect(Action)(actionInput);

  const token = yield* Schema.decodeUnknownEffect(Token)(
    Redacted.value(secret)
  ).pipe(Effect.mapError(() => new OperatorFailure()));

  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(
    origin
  ).pipe(Effect.mapError(() => new OperatorFailure()));

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return yield* Effect.fail(new OperatorFailure());
  }

  if (url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    return yield* Effect.fail(new OperatorFailure());
  }

  url.pathname = action === "status" ? "/status" : "/reconcile";

  if (action !== "status") {
    url.searchParams.set("dryRun", String(action === "dry-run"));
  }

  const response = yield* requestEffect(
    url.toString(),
    {
      headers: { Authorization: `Bearer ${token}` },
      method: action === "status" ? "GET" : "POST",
    },
    {}
  );

  const body = yield* readJsonEffect(response);

  const decoded = yield* Schema.decodeUnknownEffect(OperatorResponse)(
    body
  ).pipe(Effect.mapError(() => new OperatorFailure()));

  return { ...decoded, httpStatus: response.status };
});

await Effect.runPromise(
  operate(process.argv[2] ?? "status").pipe(
    Effect.match({
      onFailure: () => {
        process.stderr.write(
          "Operator request failed; credentials and remote response suppressed.\n"
        );
        process.exitCode = 1;
      },
      onSuccess: (result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      },
    })
  )
);
