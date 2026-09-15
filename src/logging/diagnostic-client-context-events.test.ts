import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRuntimeConfig = vi.hoisted(() => ({ current: {} }));
const testStateDatabase = vi.hoisted(() => ({ db: {}, open: vi.fn() }));
const testAuditIdentity = vi.hoisted(() => ({ pseudonymizeExecutionIdentityRef: vi.fn() }));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testRuntimeConfig.current,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: testStateDatabase.open,
}));
vi.mock("../audit/audit-identity.js", () => ({
  pseudonymizeExecutionIdentityRef: testAuditIdentity.pseudonymizeExecutionIdentityRef,
}));

import { normalizeDiagnosticClientContext } from "../infra/diagnostic-client-context.js";
import {
  onDiagnosticEvent,
  onTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import {
  logMessageQueued,
  logSessionStateChange,
  setDiagnosticSessionClientContext,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const UPSTREAM = normalizeDiagnosticClientContext({
  schemaVersion: "agentweave.context.v1",
  agentId: "Conductor",
});
const SESSION_CORRELATION_ID = "hmac-sha256:v1:0123456789abcdef0123456789abcdef:abc";

type Capture = {
  /** Events seen by a normal (public) subscriber — never get privateData. */
  publicEvents: DiagnosticEventPayload[];
  /** Private attribution delivered per lifecycle event on the trusted channel. */
  trusted: Array<{ type: string; clientContext?: unknown; sessionCorrelationId?: unknown }>;
};

function capture(run: () => void): Capture {
  const publicEvents: DiagnosticEventPayload[] = [];
  const trusted: Capture["trusted"] = [];
  const stopPublic = onDiagnosticEvent((event) => {
    publicEvents.push(event);
  });
  const stopTrusted = onTrustedDiagnosticEvent((event, privateData: DiagnosticEventPrivateData) => {
    trusted.push({
      type: event.type,
      ...(privateData.clientContext ? { clientContext: privateData.clientContext } : {}),
      ...(privateData.sessionCorrelationId
        ? { sessionCorrelationId: privateData.sessionCorrelationId }
        : {}),
    });
  });
  try {
    run();
  } finally {
    stopTrusted();
    stopPublic();
  }
  return { publicEvents, trusted };
}

describe("clientContext propagation onto diagnostic events", () => {
  beforeEach(() => {
    testRuntimeConfig.current = {};
    testStateDatabase.open.mockReset().mockReturnValue({ db: testStateDatabase.db });
    testAuditIdentity.pseudonymizeExecutionIdentityRef
      .mockReset()
      .mockReturnValue(SESSION_CORRELATION_ID);
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticStateForTest();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("delivers seeded clientContext as privateData on session.state, never on the public payload", () => {
    const { publicEvents, trusted } = capture(() => {
      setDiagnosticSessionClientContext(
        { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" },
        UPSTREAM,
      );
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
    });

    // Trusted observer gets the bag.
    expect(trusted).toEqual([{ type: "session.state", clientContext: UPSTREAM }]);
    // Public observer still sees the lifecycle event, but with no clientContext.
    const publicState = publicEvents.find((event) => event.type === "session.state");
    expect(publicState).toBeDefined();
    expect((publicState as Record<string, unknown>).clientContext).toBeUndefined();
    expect(JSON.stringify(publicEvents)).not.toContain("Conductor");
  });

  it("lets a later message.queued inherit seeded clientContext on the trusted channel", () => {
    const { trusted } = capture(() => {
      // The gateway handler seeds context keyed by sessionKey before the run
      // emits anything. setActiveEmbeddedRun then emits session.state (with
      // sessionKey), and the queue path emits message.queued by sessionId only
      // — both inherit the seeded context from the shared session state.
      setDiagnosticSessionClientContext(
        { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" },
        UPSTREAM,
      );
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s1", source: "pi-embedded-runner" });
    });

    expect(trusted).toEqual([
      { type: "session.state", clientContext: UPSTREAM },
      { type: "message.queued", clientContext: UPSTREAM },
    ]);
  });

  it("clears stale clientContext when a later same-session run supplies none", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    const { trusted } = capture(() => {
      // First run seeds upstream context.
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      // Later run on the same (reused) diagnostic session has no context.
      setDiagnosticSessionClientContext(ref, undefined);
      logSessionStateChange({ ...ref, state: "processing" });
      logMessageQueued({ sessionId: "s1", source: "dispatch" });
    });

    for (const entry of trusted) {
      expect(entry.clientContext).toBeUndefined();
    }
  });

  it("clears stale clientContext when a later same-session run is out of bounds", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    // An oversized / invalid bag normalizes to undefined (whole-bag drop).
    const oversized = normalizeDiagnosticClientContext({ blob: "x".repeat(9000) });
    expect(oversized).toBeUndefined();

    const { trusted } = capture(() => {
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      setDiagnosticSessionClientContext(ref, oversized);
      logSessionStateChange({ ...ref, state: "processing" });
    });

    const stateEntry = trusted.find((entry) => entry.type === "session.state");
    expect(stateEntry).toBeDefined();
    expect(stateEntry?.clientContext).toBeUndefined();
  });

  it("omits clientContext for sessions without an upstream context", () => {
    const { publicEvents, trusted } = capture(() => {
      logSessionStateChange({
        sessionId: "s2",
        sessionKey: "agent:main:main",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s2", sessionKey: "agent:main:main", source: "dispatch" });
    });

    for (const entry of trusted) {
      expect(entry.clientContext).toBeUndefined();
    }
    for (const event of publicEvents) {
      expect((event as Record<string, unknown>).clientContext).toBeUndefined();
    }
  });

  it("delivers session correlation only through trusted lifecycle privateData", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    const { publicEvents, trusted } = capture(() => {
      testRuntimeConfig.current = { logging: { audit: { executionIdentity: true } } };
      logSessionStateChange({ ...ref, state: "processing" });
      logMessageQueued({ sessionId: "s1", source: "dispatch" });
    });

    expect(trusted).toEqual([
      {
        type: "session.state",
        sessionCorrelationId: SESSION_CORRELATION_ID,
      },
      {
        type: "message.queued",
        sessionCorrelationId: SESSION_CORRELATION_ID,
      },
    ]);
    expect(JSON.stringify(publicEvents)).not.toContain(SESSION_CORRELATION_ID);
    expect(testAuditIdentity.pseudonymizeExecutionIdentityRef).toHaveBeenNthCalledWith(1, {
      db: testStateDatabase.db,
      kind: "session",
      scope: "openclaw.diagnostics.session.v1",
      value: "s1",
    });
  });

  it("clears stale session correlation when execution identity collection is disabled", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    const { publicEvents, trusted } = capture(() => {
      testRuntimeConfig.current = { logging: { audit: { executionIdentity: true } } };
      logSessionStateChange({ ...ref, state: "processing" });
      testRuntimeConfig.current = { logging: { audit: { executionIdentity: false } } };
      logMessageQueued({ sessionId: "s1", source: "dispatch" });
    });

    expect(trusted).toEqual([
      { type: "session.state", sessionCorrelationId: SESSION_CORRELATION_ID },
      { type: "message.queued" },
    ]);
    expect(JSON.stringify(publicEvents)).not.toContain(SESSION_CORRELATION_ID);
  });

  it("fails open when the audit database cannot derive session correlation", () => {
    const { publicEvents, trusted } = capture(() => {
      testRuntimeConfig.current = { logging: { audit: { executionIdentity: true } } };
      testStateDatabase.open.mockImplementation(() => {
        throw new Error("audit database unavailable");
      });
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
    });

    expect(testAuditIdentity.pseudonymizeExecutionIdentityRef).not.toHaveBeenCalled();
    expect(trusted).toEqual([{ type: "session.state" }]);
    expect(publicEvents).toEqual([expect.objectContaining({ type: "session.state" })]);
    expect(JSON.stringify(publicEvents)).not.toContain(SESSION_CORRELATION_ID);
  });

  it("fails open when the audit key pseudonymization throws", () => {
    const { publicEvents, trusted } = capture(() => {
      testRuntimeConfig.current = { logging: { audit: { executionIdentity: true } } };
      testAuditIdentity.pseudonymizeExecutionIdentityRef.mockImplementation(() => {
        throw new Error("audit identity key unavailable");
      });
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
    });

    expect(testAuditIdentity.pseudonymizeExecutionIdentityRef).toHaveBeenCalledOnce();
    expect(trusted).toEqual([{ type: "session.state" }]);
    expect(publicEvents).toEqual([expect.objectContaining({ type: "session.state" })]);
    expect(JSON.stringify(publicEvents)).not.toContain(SESSION_CORRELATION_ID);
  });
});
