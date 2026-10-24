import { expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";
import { collectRegistryInvocationInstances } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRecord } from "./status.test-helpers.js";

it("does not admit an optional context-gated tool until it has an active call", () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "poll-only-fixture" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  registry.tools.push({
    pluginId: record.id,
    source: "fixture",
    names: ["poll_only_fixture"],
    optional: true,
    factory: () => null,
  });

  expect(collectRegistryInvocationInstances(registry)).not.toContain(instance);
});

it("continues to retain required tool factories", () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "required-fixture" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const factory = instance.adopt(() => null);
  registry.tools.push({
    pluginId: record.id,
    source: "fixture",
    names: ["required_fixture"],
    optional: false,
    factory,
  });

  expect(collectRegistryInvocationInstances(registry)).toContain(instance);
});

it("retains owners of non-tool contributions that can escape a prepared registry", () => {
  const registry = createEmptyPluginRegistry();
  const owner = (id: string) => {
    const record = createPluginRecord({ id });
    registry.plugins.push(record);
    return new PluginInstance(id, { record, registry });
  };
  const hook = owner("hook-fixture");
  const middleware = owner("middleware-fixture");
  const provider = owner("provider-fixture");
  const command = owner("command-fixture");
  const extension = owner("extension-fixture");
  const contextEngine = owner("context-engine-fixture");
  const dashboardBinding = owner("dashboard-binding-fixture");

  registry.typedHooks.push({ pluginId: hook.pluginId } as never);
  registry.agentToolResultMiddlewares.push({ pluginId: middleware.pluginId } as never);
  registry.modelCatalogProviders.push({ pluginId: provider.pluginId } as never);
  registry.commands.push({ pluginId: command.pluginId } as never);
  registry.sessionExtensions.push({ pluginId: extension.pluginId } as never);
  registry.contextEngines.set("fixture", { owner: `plugin:${contextEngine.pluginId}` } as never);
  registry.dashboardDataBindings.set("fixture", { pluginId: dashboardBinding.pluginId } as never);

  expect(collectRegistryInvocationInstances(registry)).toEqual(
    new Set([hook, middleware, provider, command, extension, contextEngine, dashboardBinding]),
  );
});
