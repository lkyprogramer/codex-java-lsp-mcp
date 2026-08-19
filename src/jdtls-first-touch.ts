// input: JDT startup, configuration, progress, document, and backend timings.
// output: A first-touch session trace with MEASURED/UNMEASURED/NOT_APPLICABLE fields.
// pos: Extracted from JdtlsSession so lifecycle code does not own telemetry recording.

export type TelemetryObservation<T> =
  | { status: "MEASURED"; value: T }
  | { status: "UNMEASURED"; reason: string }
  | { status: "NOT_APPLICABLE"; reason: string };

export type JdtFirstTouchExecution =
  | "new-process"
  | "joined-existing-start"
  | "reused-ready-session";

export type JdtFirstTouchOperationTrace = {
  id: number;
  method: string;
  callerMs: TelemetryObservation<number>;
  callerSettlement: TelemetryObservation<"COMPLETE" | "FAILED" | "CANCELLED" | "DEADLINE_EXCEEDED">;
  backendSettlement: TelemetryObservation<"fulfilled" | "rejected" | "pending">;
  backendSettlementAfterCallerMs: TelemetryObservation<number>;
  cancelSentMs: TelemetryObservation<number>;
  cancelAckMs: TelemetryObservation<number>;
};

export type JdtFirstTouchSessionTrace = {
  schemaVersion: "java-intelligence-v32-jdt-first-touch-session/v1";
  execution: JdtFirstTouchExecution;
  startup: {
    filesystemSetupMs: TelemetryObservation<number>;
    processSpawnCallMs: TelemetryObservation<number>;
    initializeRoundTripMs: TelemetryObservation<number>;
    configurationNotifySendMs: TelemetryObservation<number>;
    configurationAppliedMs: TelemetryObservation<number>;
    jdtlsPid: TelemetryObservation<number>;
  };
  configuration: {
    requests: number;
    responseBuildMs: TelemetryObservation<number>;
  };
  progress: {
    events: Array<{ atMs: number; kind: string; title?: string }>;
    projectImportMs: TelemetryObservation<number>;
  };
  document: {
    sourceReadMs: TelemetryObservation<number>;
    lruSynchronizeMs: TelemetryObservation<number>;
    syncAction: TelemetryObservation<"didOpen" | "didChange" | "reused">;
    serverAppliedMs: TelemetryObservation<number>;
  };
  gateway: {
    cacheHit: TelemetryObservation<boolean>;
    shared: TelemetryObservation<boolean>;
    backendRole: TelemetryObservation<"owner" | "joiner" | "cache">;
  };
  operations: JdtFirstTouchOperationTrace[];
};

export interface JdtFirstTouchTraceHandle {
  endAttempt(): void;
  snapshot(): JdtFirstTouchSessionTrace;
  close(): JdtFirstTouchSessionTrace;
}

type FirstTouchStartupPhase =
  | "filesystemSetupMs"
  | "processSpawnCallMs"
  | "initializeRoundTripMs"
  | "configurationNotifySendMs";

type MutableFirstTouchOperation = {
  id: number;
  method: string;
  startedAt: number;
  callerCompletedAt?: number;
  callerSettlement?: "COMPLETE" | "FAILED" | "CANCELLED" | "DEADLINE_EXCEEDED";
  backendSettledAt?: number;
  backendSettlement?: "fulfilled" | "rejected";
  cancelSentAt?: number;
};

export class JdtFirstTouchRecorder {
  private readonly startedAt = performance.now();
  private readonly startupPhases = new Map<FirstTouchStartupPhase, number>();
  private readonly progressEvents: Array<{ atMs: number; kind: string; title?: string }> = [];
  private readonly importProgressStarts = new Map<string, number>();
  private projectImportMs = 0;
  private configurationRequests = 0;
  private configurationResponseBuildMs = 0;
  private sourceReadMs = 0;
  private lruSynchronizeMs = 0;
  private readonly documentNotifications: string[] = [];
  private readonly operations = new Map<number, MutableFirstTouchOperation>();
  private nextOperationId = 1;
  private pid?: number;
  private sessionStopped = false;

  constructor(readonly execution: JdtFirstTouchExecution) {}

  recordStartupPhase(name: FirstTouchStartupPhase, elapsedMs: number): void {
    this.startupPhases.set(name, (this.startupPhases.get(name) ?? 0) + elapsedMs);
  }

  recordPid(pid: number | undefined): void {
    if (pid !== undefined) this.pid = pid;
  }

  recordConfigurationRequest(elapsedMs: number): void {
    this.configurationRequests += 1;
    this.configurationResponseBuildMs += elapsedMs;
  }

  recordProgress(params: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }): void {
    const token = String(params.token ?? "unknown");
    const kind = params.value?.kind ?? "report";
    const title = [params.value?.title, params.value?.message].filter(Boolean).join(": ") || undefined;
    const at = performance.now();
    this.progressEvents.push({ atMs: roundedMs(at - this.startedAt), kind, title });
    const isImportProgress = /(?:import|project|workspace|build)/i.test(title ?? "")
      || this.importProgressStarts.has(token);
    if (!isImportProgress) return;
    if (kind === "begin") {
      this.importProgressStarts.set(token, at);
    } else if (kind === "end") {
      const startedAt = this.importProgressStarts.get(token);
      if (startedAt !== undefined) this.projectImportMs += Math.max(0, at - startedAt);
      this.importProgressStarts.delete(token);
    }
  }

  recordDocumentRead(elapsedMs: number): void {
    this.sourceReadMs += elapsedMs;
  }

  documentNotificationCount(): number {
    return this.documentNotifications.length;
  }

  recordDocumentNotification(method: string): void {
    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
      this.documentNotifications.push(method);
    }
  }

  recordDocumentSync(elapsedMs: number): void {
    this.lruSynchronizeMs += elapsedMs;
  }

  beginOperation(method: string): number {
    const id = this.nextOperationId++;
    this.operations.set(id, { id, method, startedAt: performance.now() });
    return id;
  }

  recordCallerSettlement(
    id: number,
    settlement: MutableFirstTouchOperation["callerSettlement"]
  ): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.callerCompletedAt = performance.now();
    operation.callerSettlement = settlement;
  }

  recordBackendSettlement(id: number, settlement: "fulfilled" | "rejected"): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.backendSettledAt = performance.now();
    operation.backendSettlement = settlement;
  }

  recordCancelSent(id: number): void {
    const operation = this.operations.get(id);
    if (!operation || operation.cancelSentAt !== undefined) return;
    operation.cancelSentAt = performance.now();
  }

  markSessionStopped(): void {
    this.sessionStopped = true;
  }

  snapshot(): JdtFirstTouchSessionTrace {
    const startupObservation = (name: FirstTouchStartupPhase): TelemetryObservation<number> => {
      const value = this.startupPhases.get(name);
      if (value !== undefined) return measured(roundedMs(value));
      if (this.execution === "reused-ready-session") {
        return notApplicable("the attempt reused an already READY JDT session");
      }
      return unmeasured(`${name} was not observed before the trace snapshot`);
    };
    const actions = this.documentNotifications;
    const syncAction: TelemetryObservation<"didOpen" | "didChange" | "reused"> = actions.includes("textDocument/didOpen")
      ? measured("didOpen")
      : actions.includes("textDocument/didChange")
        ? measured("didChange")
        : this.lruSynchronizeMs > 0
          ? measured("reused")
          : unmeasured("no document synchronization phase was observed");
    return {
      schemaVersion: "java-intelligence-v32-jdt-first-touch-session/v1",
      execution: this.execution,
      startup: {
        filesystemSetupMs: startupObservation("filesystemSetupMs"),
        processSpawnCallMs: startupObservation("processSpawnCallMs"),
        initializeRoundTripMs: startupObservation("initializeRoundTripMs"),
        configurationNotifySendMs: startupObservation("configurationNotifySendMs"),
        configurationAppliedMs: unmeasured("LSP configuration notifications have no server acknowledgement"),
        jdtlsPid: this.pid !== undefined
          ? measured(this.pid)
          : this.execution === "reused-ready-session"
            ? notApplicable("the reused session pid was not sampled by this attempt")
            : unmeasured("the JDT child pid was unavailable")
      },
      configuration: {
        requests: this.configurationRequests,
        responseBuildMs: this.configurationRequests > 0
          ? measured(roundedMs(this.configurationResponseBuildMs))
          : unmeasured("JDT did not issue workspace/configuration during this attempt")
      },
      progress: {
        events: this.progressEvents.map(event => ({ ...event })),
        projectImportMs: this.projectImportMs > 0
          ? measured(roundedMs(this.projectImportMs))
          : unmeasured("no complete project-import progress begin/end span was observed")
      },
      document: {
        sourceReadMs: this.sourceReadMs > 0
          ? measured(roundedMs(this.sourceReadMs))
          : unmeasured("no source read was observed"),
        lruSynchronizeMs: this.lruSynchronizeMs > 0
          ? measured(roundedMs(this.lruSynchronizeMs))
          : unmeasured("no document LRU synchronization was observed"),
        syncAction,
        serverAppliedMs: unmeasured("didOpen/didChange notifications have no server acknowledgement")
      },
      gateway: {
        cacheHit: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway"),
        shared: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway"),
        backendRole: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway")
      },
      operations: [...this.operations.values()].map(operation => this.operationSnapshot(operation))
    };
  }

  private operationSnapshot(operation: MutableFirstTouchOperation): JdtFirstTouchOperationTrace {
    const callerMs = operation.callerCompletedAt === undefined
      ? unmeasured("caller had not settled at snapshot")
      : measured(roundedMs(operation.callerCompletedAt - operation.startedAt));
    const backendSettlement = operation.backendSettlement === undefined
      ? measured<"fulfilled" | "rejected" | "pending">("pending")
      : measured<"fulfilled" | "rejected" | "pending">(operation.backendSettlement);
    let backendSettlementAfterCallerMs: TelemetryObservation<number>;
    if (operation.callerCompletedAt === undefined) {
      backendSettlementAfterCallerMs = unmeasured("caller had not settled at snapshot");
    } else if (operation.backendSettledAt !== undefined) {
      backendSettlementAfterCallerMs = measured(roundedMs(Math.max(0, operation.backendSettledAt - operation.callerCompletedAt)));
    } else {
      backendSettlementAfterCallerMs = unmeasured(this.sessionStopped
        ? "backend did not settle before benchmark session stop"
        : "backend was still pending at snapshot");
    }
    const cancelSentMs = operation.cancelSentAt === undefined
      ? notApplicable<number>("the caller did not request cancellation")
      : measured(roundedMs(operation.cancelSentAt - operation.startedAt));
    return {
      id: operation.id,
      method: operation.method,
      callerMs,
      callerSettlement: operation.callerSettlement
        ? measured(operation.callerSettlement)
        : unmeasured("caller settlement was not observed"),
      backendSettlement,
      backendSettlementAfterCallerMs,
      cancelSentMs,
      cancelAckMs: operation.cancelSentAt === undefined
        ? notApplicable("the caller did not request cancellation")
        : unmeasured("LSP cancellation has no acknowledgement")
    };
  }
}

function measured<T>(value: T): TelemetryObservation<T> {
  return { status: "MEASURED", value };
}

function unmeasured<T = never>(reason: string): TelemetryObservation<T> {
  return { status: "UNMEASURED", reason };
}

function notApplicable<T = never>(reason: string): TelemetryObservation<T> {
  return { status: "NOT_APPLICABLE", reason };
}

function roundedMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}
