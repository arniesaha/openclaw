import { createDeferredCore } from "../shared/deferred.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import {
  getPluginInstance,
  getPluginValueInstance,
  pluginInvocationContext,
  type PluginInstanceHandle,
  type PluginInvocationBinding,
} from "./plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import { pluginArrays, pluginMaps } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";

/** Finite execution custody for one host-selected registry and its exact instances. */
export class PluginInvocationScope {
  private readonly bindings = new Map<PluginInstanceHandle, PluginInvocationBinding>();
  private readonly consumers = new Map<PluginInstanceHandle, PluginInstanceConsumer>();
  private closed = false;
  private readonly consumerKind: "work" | "custody";

  constructor(
    readonly registry: PluginRegistry,
    instances: Iterable<PluginInstanceHandle>,
    options: { retained?: boolean; parent?: PluginInvocationScope; kind?: "work" | "custody" } = {},
  ) {
    this.consumerKind = options.kind ?? "work";
    try {
      for (const instance of new Set(instances)) {
        if (options.retained) {
          const acquire = () =>
            instance.retainConsumer((run) => this.run(run), registry, this.consumerKind);
          const parent = options.parent?.consumer(instance);
          const consumer = parent ? parent.run(acquire) : acquire();
          this.consumers.set(instance, consumer);
          this.bindings.set(instance, consumer);
        } else {
          this.bindings.set(instance, {
            run: (run) => this.run(() => instance.runInRegistry(registry, run)),
            wrap: instance.createRegistryView(registry, (run) => this.run(run)),
          });
        }
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private consumer(instance: PluginInstanceHandle): PluginInstanceConsumer | undefined {
    this.assertOpen();
    return this.consumers.get(instance);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Plugin invocation scope is closed");
    }
  }

  lookup(instance: PluginInstanceHandle): PluginInvocationBinding | undefined {
    const binding = this.bindings.get(instance);
    if (binding) {
      this.assertOpen();
    }
    return binding;
  }

  run<T>(run: () => T): T {
    this.assertOpen();
    return pluginInvocationContext.run(this, run);
  }

  wrap<T>(value: T): T {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return value;
    }
    const instance = getPluginValueInstance(value);
    return instance ? (this.lookup(instance)?.wrap(value) ?? value) : value;
  }

  /** Transfer custody before revoking callbacks captured by ordinary engine operations. */
  beginCleanup(): { scope: PluginInvocationScope; release: () => Promise<void> } {
    this.assertOpen();
    const cleanup = new PluginInvocationScope(this.registry, this.bindings.keys());
    const finished = createDeferredCore();
    // Retirement may already await these exact consumers. Revoke their callbacks
    // now, but keep their physical completion until the cleanup owner drains.
    const closed = Promise.all(
      [...this.consumers].map(([instance, consumer]) =>
        consumer.close(() => {
          const teardown = pluginInstanceInvocation.getStore();
          if (!teardown) {
            throw new Error("Plugin consumer cleanup has no invocation");
          }
          // Transfer only the teardown token, never the closed operation scope or caller authority.
          const run = <T>(operation: () => T): T =>
            cleanup.run(() =>
              pluginInstanceInvocation.run(teardown, () => instance.runCleanup(operation)),
            );
          cleanup.bindings.set(instance, {
            run,
            wrap: instance.createRegistryView(this.registry, run),
          });
          return finished.promise;
        }),
      ),
    );
    void closed.catch(() => {});
    this.closed = true;
    return {
      scope: cleanup,
      release: async () => {
        cleanup.release();
        finished.resolve();
        await closed;
      },
    };
  }

  release(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const consumer of this.consumers.values()) {
      consumer.release();
    }
  }
}

/** Enumerate exact instances already represented by this finite registry view. */
export function collectRegistryInvocationInstances(
  registry: PluginRegistry,
): Set<PluginInstanceHandle> {
  const instances = new Set<PluginInstanceHandle>();
  // A registry record is physical custody, not proof that this finite agent turn
  // captured executable plugin behavior. Retaining every loaded record turns an
  // optional, context-gated tool into reload-blocking work for unrelated turns.
  // Every other registered contribution can escape its registry view, so retain
  // its exact owner. Optional tools acquire normal call admission only when
  // they are actually invoked.
  const records = new Map(registry.plugins.map((record) => [record.id, record]));
  const collect = (value: unknown, ownerPluginId?: string) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return;
    }
    const instance =
      getPluginValueInstance(value) ??
      getPluginInstance(value as import("./registry-types.js").PluginRecord);
    if (instance) {
      instances.add(instance);
      return;
    }
    const pluginId =
      ownerPluginId ??
      ("pluginId" in value && typeof value.pluginId === "string" ? value.pluginId : undefined);
    const record = pluginId && records.get(pluginId);
    const recordInstance = record && getPluginInstance(record);
    if (recordInstance) {
      instances.add(recordInstance);
    }
  };
  for (const key of pluginArrays) {
    const entries = registry[key];
    for (const entry of key === "tools" ? entries.filter(({ optional }) => !optional) : entries) {
      collect(entry);
    }
  }
  for (const key of pluginMaps) {
    for (const entry of registry[key].values()) {
      collect(entry);
    }
  }
  for (const entry of registry.contextEngines.values()) {
    collect(
      entry,
      entry.owner.startsWith("plugin:") ? entry.owner.slice("plugin:".length) : undefined,
    );
  }
  for (const entry of registry.compactionProviders) {
    collect(entry, entry.ownerPluginId);
  }
  for (const entry of registry.gatewayMethodDescriptors) {
    collect(entry, entry.owner.kind === "plugin" ? entry.owner.pluginId : undefined);
  }
  for (const entry of registry.httpRoutes) {
    collect(entry);
  }
  for (const entry of registry.channels) {
    collect(entry.borrowedRuntimeRecord);
  }
  for (const { host } of registry.decisionProviders) {
    collect(host.record);
  }
  return instances;
}
