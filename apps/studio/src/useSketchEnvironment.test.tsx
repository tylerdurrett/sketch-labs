// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ParamSchema,
  Params,
  SketchEnvironment,
} from "@harness/core";

import {
  useSketchEnvironment,
  type SketchEnvironmentResolver,
  type UseSketchEnvironmentResult,
} from "./useSketchEnvironment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const A = "alpha-000000000001";
const B = "beta-000000000002";
const C = "gamma-000000000003";
const assetSchema = {
  source: { kind: "image-asset", default: A },
  amount: { kind: "number", min: 0, max: 10, default: 1 },
} satisfies ParamSchema;

interface ResolutionCall {
  readonly params: Params;
  readonly signal: AbortSignal;
  readonly resolve: (environment: SketchEnvironment) => void;
  readonly reject: (error: unknown) => void;
}

function controlledResolver(): {
  readonly calls: ResolutionCall[];
  readonly resolver: SketchEnvironmentResolver;
} {
  const calls: ResolutionCall[] = [];
  return {
    calls,
    resolver: vi.fn((_schema, params, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ params, signal, resolve, reject });
      }),
    ),
  };
}

function environment(id: string): SketchEnvironment {
  const pixels = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([1, 2, 3, 255]),
  };
  return { imageAssets: (requested) => (requested === id ? pixels : undefined) };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: UseSketchEnvironmentResult | null = null;

function Probe({
  schema = assetSchema,
  params,
  resolver,
}: {
  readonly schema?: ParamSchema;
  readonly params: Params;
  readonly resolver: SketchEnvironmentResolver;
}) {
  latest = useSketchEnvironment({ schema, params, resolver });
  return null;
}

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function render(node: ReactNode): void {
  act(() => root!.render(node));
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useSketchEnvironment", () => {
  it("gates A immediately on B, aborts A, and ignores its stale completion", async () => {
    const controlled = controlledResolver();
    mount(
      <Probe
        params={{ source: A, amount: 1 }}
        resolver={controlled.resolver}
      />,
    );
    expect(latest).toMatchObject({ requiredIds: [A], ready: false });

    render(
      <Probe
        params={{ source: B, amount: 1 }}
        resolver={controlled.resolver}
      />,
    );
    expect(controlled.calls[0]!.signal.aborted).toBe(true);
    expect(latest).toMatchObject({ requiredIds: [B], ready: false });
    expect(latest!.environment).toBeUndefined();

    await settle(() => controlled.calls[0]!.resolve(environment(A)));
    expect(latest).toMatchObject({ requiredIds: [B], ready: false });

    const matching = environment(B);
    await settle(() => controlled.calls[1]!.resolve(matching));
    expect(latest).toMatchObject({ requiredIds: [B], ready: true });
    expect(latest!.environment).toBe(matching);
  });

  it("retires rapid A to B to C resolution and commits only C", async () => {
    const controlled = controlledResolver();
    mount(<Probe params={{ source: A }} resolver={controlled.resolver} />);
    render(<Probe params={{ source: B }} resolver={controlled.resolver} />);
    render(<Probe params={{ source: C }} resolver={controlled.resolver} />);

    expect(controlled.calls).toHaveLength(3);
    expect(controlled.calls[0]!.signal.aborted).toBe(true);
    expect(controlled.calls[1]!.signal.aborted).toBe(true);
    expect(controlled.calls[2]!.signal.aborted).toBe(false);

    await settle(() => controlled.calls[1]!.resolve(environment(B)));
    await settle(() => controlled.calls[0]!.resolve(environment(A)));
    expect(latest).toMatchObject({ requiredIds: [C], ready: false });

    const matching = environment(C);
    await settle(() => controlled.calls[2]!.resolve(matching));
    expect(latest!.environment).toBe(matching);
    expect(latest!.ready).toBe(true);
  });

  it("retains a resolved environment across same-key parameter edits", async () => {
    const controlled = controlledResolver();
    mount(
      <Probe
        params={{ source: A, amount: 1 }}
        resolver={controlled.resolver}
      />,
    );
    const resolved = environment(A);
    await settle(() => controlled.calls[0]!.resolve(resolved));

    render(
      <Probe
        params={{ source: A, amount: 9 }}
        resolver={controlled.resolver}
      />,
    );
    expect(controlled.calls).toHaveLength(1);
    expect(latest!.ready).toBe(true);
    expect(latest!.environment).toBe(resolved);
  });

  it("does not revive an old A environment after switching away and back", async () => {
    const controlled = controlledResolver();
    mount(<Probe params={{ source: A }} resolver={controlled.resolver} />);
    await settle(() => controlled.calls[0]!.resolve(environment(A)));
    expect(latest!.ready).toBe(true);

    render(<Probe params={{ source: B }} resolver={controlled.resolver} />);
    render(<Probe params={{ source: A }} resolver={controlled.resolver} />);
    expect(controlled.calls).toHaveLength(3);
    expect(latest).toMatchObject({ requiredIds: [A], ready: false });
    expect(latest!.environment).toBeUndefined();
  });

  it("fails a nonconforming opaque string without substitution", async () => {
    const controlled = controlledResolver();
    const invalid = "unresolved://not-an-asset-id";
    mount(<Probe params={{ source: invalid }} resolver={controlled.resolver} />);
    expect(controlled.calls[0]!.params.source).toBe(invalid);

    const failure = new Error("Image Asset ID is invalid");
    await settle(() => controlled.calls[0]!.reject(failure));
    expect(latest).toMatchObject({
      requiredIds: [invalid],
      ready: false,
      error: failure,
    });
    expect(latest!.environment).toBeUndefined();
  });

  it("makes asset-free sketches ready synchronously without resolving", () => {
    const controlled = controlledResolver();
    const schema = {
      amount: { kind: "number", min: 0, max: 10, default: 1 },
    } satisfies ParamSchema;
    mount(
      <Probe
        schema={schema}
        params={{ amount: 4 }}
        resolver={controlled.resolver}
      />,
    );

    expect(controlled.calls).toHaveLength(0);
    expect(latest).toMatchObject({ requiredIds: [], ready: true, error: null });
    expect(latest!.environment).toBeUndefined();
  });
});
