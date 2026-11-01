/* oxlint-disable anti-slop/no-unknown-parameters -- Receiver regression deliberately inspects the runtime global this identity. */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun is the actual test runtime. */
/* oxlint-disable eslint/require-await, eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Deterministic async provider fixture responses mirror the transport contract. */
/* oxlint-disable anti-slop/no-runtime-typeof -- Parsing serialized request body at the fake transport boundary. */
import { expect, test } from "vitest";

import { GitHubClient } from "../../src/providers/github";
import { request } from "../../src/providers/http";

const repository = {
  archived: false,
  disabled: false,
  id: 1,
  name: "repo",
  owner: "mynameistito",
  url: "https://github.com/mynameistito/repo",
};

const hook = {
  active: false,
  config: {
    content_type: "form",
    insecure_ssl: "1",
    url: "https://api.linear.app/hooks/test-only",
  },
  events: ["issues"],
  id: 10,
};

const options = {
  endpoint: hook.config.url,
  owner: repository.owner,
  token: "test-token",
  webhookSecret: "test-secret",
};

test("inventory paginates through short pages and filters foreign owners without excluding forks or private repositories", async () => {
  let calls = 0;

  const client = new GitHubClient({
    ...options,
    fetch: async (url) => {
      calls += 1;
      expect(url).toContain(`page=${calls}`);

      const repos =
        calls === 1
          ? [
              {
                ...repository,
                fork: true,
                html_url: repository.url,
                owner: { login: repository.owner },
                private: true,
              },
            ]
          : calls === 2
            ? [
                {
                  ...repository,
                  html_url: repository.url,
                  id: 2,
                  owner: { login: "another" },
                },
              ]
            : [];

      return Response.json(repos);
    },
  });

  expect(await client.listRepositories()).toEqual({
    ok: true,
    value: [repository],
  });
  expect(calls).toBe(3);
});

test("repair refuses unrelated webhook ids without writing", async () => {
  const methods: string[] = [];

  const client = new GitHubClient({
    ...options,
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");

      return Response.json(
        methods.length === 1
          ? [
              {
                ...hook,
                config: { ...hook.config, url: "https://unrelated.example" },
              },
            ]
          : []
      );
    },
  });

  const repair = await client.repairHook(repository, 10);
  expect(repair.ok).toBe(false);
  expect(methods).toEqual(["GET", "GET"]);
});

test("repair sets native push configuration without resetting signing secret", async () => {
  let reads = 0;
  let body: unknown;

  const client = new GitHubClient({
    ...options,
    fetch: async (_url, init) => {
      if (init?.method === "PATCH") {
        body = JSON.parse(typeof init.body === "string" ? init.body : "null");

        return Response.json(hook);
      }

      reads += 1;

      return Response.json(reads === 1 ? [hook] : []);
    },
  });

  const repair = await client.repairHook(repository, 10);
  expect(repair.ok).toBe(true);
  expect(body).toEqual({
    active: true,
    config: { content_type: "json", insecure_ssl: "0", url: options.endpoint },
    events: ["push"],
    name: "web",
  });
});

test("rate limits expose only durable retry deadline and status", async () => {
  const result = await request(
    "https://secret.example/credential",
    {},
    {
      fetch: async () =>
        new Response("secret response", {
          headers: { "retry-after": "120" },
          status: 429,
        }),
      now: () => 1000,
    }
  );

  expect(result).toEqual({
    error: { kind: "http", retryAt: 121_000, status: 429 },
    ok: false,
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("hook discovery fails closed at five pages instead of exceeding platform limits", async () => {
  let calls = 0;

  const client = new GitHubClient({
    ...options,
    fetch: async () => {
      calls += 1;

      return Response.json([hook]);
    },
  });

  expect(await client.listHooks(repository)).toEqual({
    error: { kind: "invalid-response" },
    ok: false,
  });
  expect(calls).toBe(5);
});

test("absent native webhook credentials never send a hook mutation", async () => {
  let writes = 0;

  const client = new GitHubClient({
    fetch: async () => {
      writes += 1;

      return Response.json({});
    },
    owner: "mynameistito",
    token: "test",
  });

  const result = await client.createHook(repository);
  expect(result.ok).toBe(false);
  expect(writes).toBe(0);
});

test("transport failures classify receiver errors without retaining sensitive exception text", async () => {
  const result = await request(
    "https://secret.example/path",
    {},
    {
      fetch: async () => {
        throw new TypeError(
          "Illegal invocation secret-token https://private.example"
        );
      },
      now: () => 0,
    }
  );

  expect(result).toEqual({
    error: { kind: "network", reason: "illegal-invocation", retryAt: 60_000 },
    ok: false,
  });
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("default transport preserves the Workers global fetch receiver", async () => {
  const original = globalThis.fetch;
  let receiverValid = false;

  const replacement = Object.assign(
    async function replacement(this: typeof globalThis): Promise<Response> {
      receiverValid = this === globalThis;

      return Response.json({ ok: true });
    },
    { preconnect: original.preconnect }
  );

  globalThis.fetch = replacement;

  try {
    const result = await request("https://example.com", {}, {});
    expect(result.ok).toBe(true);
    expect(receiverValid).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test("Workers-compatible manual redirects fail closed without forwarding credentials", async () => {
  let calls = 0;

  const result = await request(
    "https://api.example",
    { headers: { Authorization: "secret-test" } },
    {
      fetch: async (_url, init) => {
        calls += 1;
        expect(init.redirect).toBe("manual");

        return new Response(null, {
          headers: { Location: "https://unrelated.example/private" },
          status: 302,
        });
      },
    }
  );

  expect(result).toEqual({ error: { kind: "http", status: 302 }, ok: false });
  expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toContain("private");
});
