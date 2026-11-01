import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubClient } from "../../src/providers/github";
import { request } from "../../src/providers/http";

type GlobalTransportContext = typeof globalThis;

const parseJsonBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
);

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

describe("GitHub provider regressions", () => {
  it("reads recent nonempty deliveries once without numbered pagination", async () => {
    let calls = 0;

    const client = new GitHubClient({
      fetch: async (url) => {
        calls += 1;
        expect(new URL(url).searchParams.has("page")).toBeFalsy();
        expect(new URL(url).searchParams.get("per_page")).toBe("100");

        return await Promise.resolve(
          Response.json([{ event: "ping", id: 42, status_code: 200 }])
        );
      },
      owner: "owner",
      token: "test",
    });

    await expect(client.deliveries(repository, 1)).resolves.toStrictEqual({
      ok: true,
      value: [{ event: "ping", id: 42, statusCode: 200 }],
    });
    expect(calls).toBe(1);
  });

  it("preserves pagination across unrelated hooks with omitted configuration", async () => {
    const client = new GitHubClient({
      fetch: async (url) =>
        await Promise.resolve(
          Response.json(
            new URL(url).searchParams.get("page") === "1"
              ? [
                  { active: true, config: {}, events: ["issues"], id: 1 },
                  {
                    active: true,
                    config: {
                      insecure_ssl: 0,
                      url: "https://unrelated.example",
                    },
                    events: ["push"],
                    id: 2,
                  },
                ]
              : []
          )
        ),
      owner: "owner",
      token: "test",
    });

    await expect(client.listHooks(repository)).resolves.toStrictEqual({
      ok: true,
      value: [
        {
          active: true,
          contentType: "",
          endpoint: "",
          events: ["issues"],
          id: 1,
          insecureSsl: "",
        },
        {
          active: true,
          contentType: "",
          endpoint: "https://unrelated.example",
          events: ["push"],
          id: 2,
          insecureSsl: "0",
        },
      ],
    });
  });

  it("inventory paginates through short pages and filters foreign owners without excluding forks or private repositories", async () => {
    let calls = 0;

    const client = new GitHubClient({
      ...options,
      fetch: async (url) => {
        calls += 1;
        expect(url).toContain(`page=${calls}`);

        if (calls === 1) {
          return await Promise.resolve(
            Response.json([
              {
                ...repository,
                fork: true,
                html_url: repository.url,
                owner: { login: repository.owner },
                private: true,
              },
            ])
          );
        }

        if (calls === 2) {
          return await Promise.resolve(
            Response.json([
              {
                ...repository,
                html_url: repository.url,
                id: 2,
                owner: { login: "another" },
              },
            ])
          );
        }

        return await Promise.resolve(Response.json([]));
      },
    });

    await expect(client.listRepositories()).resolves.toStrictEqual({
      ok: true,
      value: [repository],
    });
    expect(calls).toBe(3);
  });

  it("repair refuses unrelated webhook ids without writing", async () => {
    const methods: string[] = [];

    const client = new GitHubClient({
      ...options,
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");

        return await Promise.resolve(
          Response.json(
            methods.length === 1
              ? [
                  {
                    ...hook,
                    config: {
                      ...hook.config,
                      url: "https://unrelated.example",
                    },
                  },
                ]
              : []
          )
        );
      },
    });

    const repair = await client.repairHook(repository, 10);
    expect(repair.ok).toBeFalsy();
    expect(methods).toStrictEqual(["GET", "GET"]);
  });

  it("repair sets native push configuration without resetting signing secret", async () => {
    let reads = 0;
    let body: unknown;

    const client = new GitHubClient({
      ...options,
      fetch: async (_url, init) => {
        if (init?.method === "PATCH") {
          body = parseJsonBody(init.body);

          return await Promise.resolve(Response.json(hook));
        }

        reads += 1;

        return await Promise.resolve(Response.json(reads === 1 ? [hook] : []));
      },
    });

    const repair = await client.repairHook(repository, 10);
    expect(repair.ok).toBeTruthy();
    expect(body).toStrictEqual({
      active: true,
      config: {
        content_type: "json",
        insecure_ssl: "0",
        url: options.endpoint,
      },
      events: ["push"],
      name: "web",
    });
  });

  it("rate limits expose only durable retry deadline and status", async () => {
    const result = await request(
      "https://secret.example/credential",
      {},
      {
        fetch: async () =>
          await Promise.resolve(
            new Response("secret response", {
              headers: { "retry-after": "120" },
              status: 429,
            })
          ),
        now: () => 1000,
      }
    );

    expect(result).toStrictEqual({
      error: { kind: "http", retryAt: 121_000, status: 429 },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("hook discovery fails closed at five pages instead of exceeding platform limits", async () => {
    let calls = 0;

    const client = new GitHubClient({
      ...options,
      fetch: async () => {
        calls += 1;

        return await Promise.resolve(Response.json([hook]));
      },
    });

    await expect(client.listHooks(repository)).resolves.toStrictEqual({
      error: { kind: "invalid-response" },
      ok: false,
    });
    expect(calls).toBe(5);
  });

  it("absent native webhook credentials never send a hook mutation", async () => {
    let writes = 0;

    const client = new GitHubClient({
      fetch: async () => {
        writes += 1;

        return await Promise.resolve(Response.json({}));
      },
      owner: "mynameistito",
      token: "test",
    });

    const result = await client.createHook(repository);
    expect(result.ok).toBeFalsy();
    expect(writes).toBe(0);
  });

  it("transport failures classify receiver errors without retaining sensitive exception text", async () => {
    const result = await request(
      "https://secret.example/path",
      {},
      {
        fetch: async () =>
          await Promise.reject(
            new TypeError(
              "Illegal invocation secret-token https://private.example"
            )
          ),
        now: () => 0,
      }
    );

    expect(result).toStrictEqual({
      error: { kind: "network", reason: "illegal-invocation", retryAt: 60_000 },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("default transport preserves the Workers global fetch receiver", async () => {
    const original = globalThis.fetch;
    let receiverValid = false;

    const replacement = Object.assign(
      async function replacement(
        this: GlobalTransportContext
      ): Promise<Response> {
        receiverValid = this === globalThis;

        return await Promise.resolve(Response.json({ ok: true }));
      },
      { preconnect: original.preconnect }
    );

    globalThis.fetch = replacement;

    try {
      const result = await request("https://example.com", {}, {});
      expect(result.ok).toBeTruthy();
      expect(receiverValid).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("Workers-compatible manual redirects fail closed without forwarding credentials", async () => {
    let calls = 0;

    const result = await request(
      "https://api.example",
      { headers: { Authorization: "secret-test" } },
      {
        fetch: async (_url, init) => {
          calls += 1;
          expect(init.redirect).toBe("manual");

          return await Promise.resolve(
            new Response(null, {
              headers: { Location: "https://unrelated.example/private" },
              status: 302,
            })
          );
        },
      }
    );

    expect(result).toStrictEqual({
      error: { kind: "http", status: 302 },
      ok: false,
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
