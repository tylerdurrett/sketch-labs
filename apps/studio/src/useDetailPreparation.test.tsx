// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  type PreparedImageDetailAnalysis,
} from "@harness/core";

import type { DetailPreparationResult } from "./detailCoordinator";
import {
  createDetailPreparationIdentity,
  type DetailPreparationIdentity,
} from "./detailPreparationProtocol";
import {
  useDetailPreparation,
  type DetailPreparationCoordinator,
  type UseDetailPreparationResult,
} from "./useDetailPreparation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function identity(imageAssetId: string): DetailPreparationIdentity {
  return createDetailPreparationIdentity({
    imageAssetId,
    analysisDefinitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
  });
}

const firstIdentity = identity("pinecone-4330aa0314f7");
const secondIdentity = identity("doggo-2c7b56f9257e");

function prepared(value = 0.5): PreparedImageDetailAnalysis {
  return {
    definitionId: IMAGE_DETAIL_ANALYSIS_DEFINITION_ID,
    sourceWidth: 1,
    sourceHeight: 1,
    gridWidth: 1,
    gridHeight: 1,
    data: new Float64Array([value]),
  };
}

interface StartedJob {
  readonly identity: DetailPreparationIdentity;
  readonly resolve: (result: DetailPreparationResult) => void;
  readonly reject: (error: unknown) => void;
}

class FakeCoordinator implements DetailPreparationCoordinator {
  readonly starts: StartedJob[] = [];
  cancelCount = 0;
  disposeCount = 0;

  start(identity: DetailPreparationIdentity): Promise<DetailPreparationResult> {
    return new Promise((resolve, reject) => {
      this.starts.push({ identity, resolve, reject });
    });
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.cancel();
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: UseDetailPreparationResult | null = null;

function Probe({ coordinator }: { readonly coordinator: FakeCoordinator }) {
  latest = useDetailPreparation({
    coordinatorFactory: () => coordinator,
  });
  return null;
}

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

function succeed(job: StartedJob, value = prepared(), jobId = 1): void {
  job.resolve({
    status: "success",
    jobId,
    identity: job.identity,
    prepared: value,
  });
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useDetailPreparation", () => {
  it("does not launch analysis merely because the hook exists", () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);

    expect(coordinator.starts).toHaveLength(0);
    expect(latest!.session.requestedIdentity).toBeNull();
  });

  it("launches only an explicit request and reuses it across non-identity changes", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);

    act(() => latest!.request(firstIdentity));
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]!.identity).toBe(firstIdentity);

    succeed(coordinator.starts[0]!);
    await flush();
    expect(latest!.getPrepared(firstIdentity)).toBeDefined();

    // Tone, sensitivity, Seed, Composition Frame, and Page Frame never enter
    // the request API; their rerenders can only repeat this exact identity.
    act(() => latest!.request(identity("pinecone-4330aa0314f7")));
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.nextToken).toBe(2);
  });

  it("cancels obsolete work, queues latest, and ignores stale success and failure", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);

    act(() => latest!.request(firstIdentity));
    const stale = coordinator.starts[0]!;
    act(() => latest!.request(secondIdentity));

    expect(coordinator.cancelCount).toBe(1);
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity).toBe(secondIdentity);

    succeed(stale);
    await flush();
    expect(latest!.getPrepared(firstIdentity)).toBeUndefined();
    expect(latest!.session.active?.identity).toBe(secondIdentity);

    stale.reject(new Error("stale rejection"));
    await flush();
    expect(latest!.session.failure).toBeNull();

    succeed(coordinator.starts[1]!, prepared(0.75), 2);
    await flush();
    expect(latest!.getPrepared(secondIdentity)?.data[0]).toBe(0.75);
  });

  it("unrequests active work once and ignores its delayed completion", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);
    act(() => latest!.request(firstIdentity));
    const stale = coordinator.starts[0]!;

    act(() => latest!.unrequest());
    expect(coordinator.cancelCount).toBe(1);
    expect(latest!.session).toMatchObject({
      requestedIdentity: null,
      pending: null,
      active: null,
    });

    succeed(stale);
    await flush();
    expect(latest!.session.prepared).toBeNull();
    expect(coordinator.cancelCount).toBe(1);
  });

  it("clears a same-batch pending request before it can launch", () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);

    act(() => {
      latest!.request(firstIdentity);
      latest!.unrequest();
    });

    expect(coordinator.starts).toHaveLength(0);
    expect(coordinator.cancelCount).toBe(0);
    expect(latest!.session.requestedIdentity).toBeNull();
    expect(latest!.session.pending).toBeNull();
  });

  it("preserves and reuses an exact prepared record after unrequest", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);
    act(() => latest!.request(firstIdentity));
    succeed(coordinator.starts[0]!, prepared(0.75));
    await flush();

    const cached = latest!.session.prepared;
    act(() => latest!.unrequest());
    expect(latest!.session.prepared).toBe(cached);
    expect(latest!.getPrepared(firstIdentity)).toBeUndefined();

    act(() => latest!.request(identity("pinecone-4330aa0314f7")));
    expect(coordinator.starts).toHaveLength(1);
    expect(latest!.session.prepared).toBe(cached);
    expect(latest!.getPrepared(firstIdentity)?.data[0]).toBe(0.75);
  });

  it("reports bounded failure and retries the same identity explicitly", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);
    act(() => latest!.request(firstIdentity));

    coordinator.starts[0]!.resolve({
      status: "failure",
      jobId: 1,
      error: "x".repeat(600),
    });
    await flush();
    expect(latest!.session.failure?.error).toBe("x".repeat(500));
    expect(coordinator.starts).toHaveLength(1);

    act(() => latest!.retry());
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]!.identity).toBe(firstIdentity);
  });

  it("guards binding rejection by exact identity and makes it retryable", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);
    act(() => latest!.request(firstIdentity));
    succeed(coordinator.starts[0]!);
    await flush();

    const currentToken = latest!.session.prepared!.token;
    act(() =>
      latest!.rejectPrepared(
        currentToken,
        secondIdentity,
        "stale binding error",
      ),
    );
    expect(latest!.getPrepared(firstIdentity)).toBeDefined();

    act(() =>
      latest!.rejectPrepared(
        currentToken,
        firstIdentity,
        new Error("field binding failed"),
      ),
    );
    expect(latest!.getPrepared(firstIdentity)).toBeUndefined();
    expect(latest!.session.failure?.error).toBe("field binding failed");

    act(() => latest!.retry());
    expect(coordinator.starts).toHaveLength(2);
  });

  it("ignores delayed binding rejection after an A to B to A cycle", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);

    act(() => latest!.request(firstIdentity));
    succeed(coordinator.starts[0]!);
    await flush();
    const staleAToken = latest!.session.prepared!.token;

    act(() => latest!.request(secondIdentity));
    succeed(coordinator.starts[1]!, prepared(0.25), 2);
    await flush();
    act(() => latest!.request(firstIdentity));
    succeed(coordinator.starts[2]!, prepared(0.75), 3);
    await flush();

    expect(latest!.session.prepared).toMatchObject({
      token: 3,
      identity: firstIdentity,
    });
    act(() =>
      latest!.rejectPrepared(
        staleAToken,
        firstIdentity,
        "delayed token-one binding error",
      ),
    );
    expect(latest!.getPrepared(firstIdentity)?.data[0]).toBe(0.75);
    expect(latest!.session.failure).toBeNull();
  });

  it("disposes active ownership and ignores its delayed callback", async () => {
    const coordinator = new FakeCoordinator();
    mount(<Probe coordinator={coordinator} />);
    act(() => latest!.request(firstIdentity));
    const stale = coordinator.starts[0]!;

    act(() => root!.unmount());
    root = null;
    expect(coordinator.disposeCount).toBe(1);

    succeed(stale);
    await flush();
  });
});
