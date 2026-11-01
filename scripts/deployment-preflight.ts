import { Effect } from "effect";

import { preflight } from "../alchemy/preflight";

await Effect.runPromise(
  preflight().pipe(
    Effect.match({
      onFailure: () => {
        process.stderr.write('{"status":"failed"}\n');
        process.exitCode = 1;
      },
      onSuccess: (result) =>
        process.stdout.write(`${JSON.stringify(result)}\n`),
    })
  )
);
