import { describe, expect, it } from "vitest";
import {
  assignClientContextAttributes,
  clientContextKeys,
  createSessionAttributionCache,
} from "./client-context-attributes.js";

describe("assignClientContextAttributes", () => {
  it("no-ops on undefined context", () => {
    const attrs: Record<string, string | number | boolean> = { "openclaw.model": "x" };
    assignClientContextAttributes(attrs, undefined);
    expect(attrs).toEqual({ "openclaw.model": "x" });
  });

  it("stamps scalar keys under openclaw.client.* with preserved types", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { agentId: "Conductor", turn: 3, root: true });
    expect(attrs).toEqual({
      "openclaw.client.agentId": "Conductor",
      "openclaw.client.turn": 3,
      "openclaw.client.root": true,
    });
  });

  it("skips null/undefined values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { a: null, b: "keep" });
    expect(attrs).toEqual({ "openclaw.client.b": "keep" });
  });

  it("JSON-encodes nested values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { meta: { region: "us", tags: [1, 2] } });
    expect(attrs["openclaw.client.meta"]).toBe('{"region":"us","tags":[1,2]}');
  });

  it("preserves pre-existing attributes", () => {
    const attrs: Record<string, string | number | boolean> = { "openclaw.provider": "anthropic" };
    assignClientContextAttributes(attrs, { agentId: "Conductor" });
    expect(attrs["openclaw.provider"]).toBe("anthropic");
    expect(attrs["openclaw.client.agentId"]).toBe("Conductor");
  });

  it("truncates oversized string values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { big: "x".repeat(9000) });
    expect((attrs["openclaw.client.big"] as string).length).toBe(4096);
  });

  it("encodes empty nested objects and arrays", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { obj: {}, arr: [] });
    expect(attrs["openclaw.client.obj"]).toBe("{}");
    expect(attrs["openclaw.client.arr"]).toBe("[]");
  });
});

describe("clientContextKeys", () => {
  it("returns sessionId then sessionKey, dropping absent fields", () => {
    expect(clientContextKeys({ sessionId: "sid", sessionKey: "skey" })).toEqual(["sid", "skey"]);
    expect(clientContextKeys({ sessionKey: "skey" })).toEqual(["skey"]);
    expect(clientContextKeys({})).toEqual([]);
  });
});

describe("createSessionAttributionCache", () => {
  it("resolves a bag stored under sessionId via the sessionKey candidate (cross-field join)", () => {
    const cache = createSessionAttributionCache();
    // Seed event populated only sessionId; model-call lookup offers sessionKey too.
    cache.remember(["sid-1"], { clientContext: { agentId: "Conductor" } });
    expect(cache.resolve(["sid-1"])).toEqual({ clientContext: { agentId: "Conductor" } });
  });

  it("stores under every candidate key so either field joins", () => {
    const cache = createSessionAttributionCache();
    cache.remember(["sid-1", "skey-1"], { clientContext: { agentId: "Paperclip" } });
    expect(cache.resolve(["skey-1"])).toEqual({ clientContext: { agentId: "Paperclip" } });
    expect(cache.resolve(["sid-1"])).toEqual({ clientContext: { agentId: "Paperclip" } });
  });

  it("returns undefined on miss, empty keys, or empty bag", () => {
    const cache = createSessionAttributionCache();
    expect(cache.resolve(["nope"])).toBeUndefined();
    expect(cache.resolve([])).toBeUndefined();
    cache.remember([], { clientContext: { agentId: "x" } });
    cache.remember(["k"], undefined);
    expect(cache.resolve(["k"])).toBeUndefined();
  });

  it("clears every seeded alias when an unseeded lifecycle event supplies one alias", () => {
    const cache = createSessionAttributionCache();
    cache.remember(["sid-1", "skey-1"], { sessionCorrelationId: "opaque-token" });
    cache.remember(["sid-1"], undefined);
    expect(cache.resolve(["sid-1", "skey-1"])).toBeUndefined();
  });

  it("evicts oldest entries past the bound", () => {
    const cache = createSessionAttributionCache(2);
    cache.remember(["a"], { clientContext: { n: 1 } });
    cache.remember(["b"], { clientContext: { n: 2 } });
    cache.remember(["c"], { clientContext: { n: 3 } });
    expect(cache.resolve(["a"])).toBeUndefined();
    expect(cache.resolve(["b"])).toEqual({ clientContext: { n: 2 } });
    expect(cache.resolve(["c"])).toEqual({ clientContext: { n: 3 } });
  });

  it("clear() drops everything", () => {
    const cache = createSessionAttributionCache();
    cache.remember(["a"], { clientContext: { n: 1 } });
    cache.clear();
    expect(cache.resolve(["a"])).toBeUndefined();
  });
});
