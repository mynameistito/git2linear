import { AlchemyContext } from "alchemy/AlchemyContext";
import { Effect, Layer } from "effect";

/** Approving a Worker deployment must not approve shared-state infrastructure changes. */
export const stateContextLayer = Layer.effect(
  AlchemyContext,
  Effect.gen(function* stateContext() {
    const context = yield* AlchemyContext;

    return { ...context, updateStateStore: false };
  })
);
