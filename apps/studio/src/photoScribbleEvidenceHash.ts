/** Browser implementation of the issue #336 canonical SHA-256 encodings. */

import type {
  CoordinateSpace,
  Scene,
  ScribbleControls,
  ScribbleDiagnostics,
  ToneSource,
} from "@harness/core";

import { createScribbleModel } from "../../../packages/core/src/scribbleStrategy/model";

import type { ScribbleComputeIdentity } from "./scribbleComputeProtocol";

const encoder = new TextEncoder();

class CanonicalBytes {
  private readonly chunks: Uint8Array[] = [];

  tag(value: string): void {
    const bytes = encoder.encode(value);
    this.uint32(bytes.byteLength);
    this.chunks.push(bytes);
  }

  byte(value: number): void {
    this.chunks.push(Uint8Array.of(value));
  }

  uint32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    this.chunks.push(bytes);
  }

  number(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    this.chunks.push(bytes);
  }

  optional<T>(value: T | undefined, write: (present: T) => void): void {
    this.byte(value === undefined ? 0 : 1);
    if (value !== undefined) write(value);
  }

  bytes(): Uint8Array {
    const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

interface CanonicalTargetModel {
  readonly lattice: {
    readonly frame: { readonly width: number; readonly height: number };
    readonly columns: number;
    readonly rows: number;
    readonly cellWidth: number;
    readonly cellHeight: number;
    readonly cellArea: number;
    readonly sampleCount: number;
  };
  samples(): readonly { readonly tone: number; readonly permission: number }[];
}

export function canonicalBrowserScribbleTargetHash(
  model: CanonicalTargetModel,
): Promise<string>;
export function canonicalBrowserScribbleTargetHash(
  source: ToneSource,
  frame: Readonly<CoordinateSpace>,
  controls: Readonly<ScribbleControls>,
): Promise<string>;

/** Browser SHA-256 mirror of the frozen Node target oracle. */
export async function canonicalBrowserScribbleTargetHash(
  sourceOrModel: ToneSource | CanonicalTargetModel,
  frame?: Readonly<CoordinateSpace>,
  controls?: Readonly<ScribbleControls>,
): Promise<string> {
  const model = frame === undefined || controls === undefined
    ? sourceOrModel as CanonicalTargetModel
    : createScribbleModel(sourceOrModel as ToneSource, frame, controls);
  const hash = new CanonicalBytes();
  const { lattice } = model;
  hash.tag("photo-scribble-target-v1");
  hash.tag("frame-width");
  hash.number(lattice.frame.width);
  hash.tag("frame-height");
  hash.number(lattice.frame.height);
  hash.tag("lattice-frame-width");
  hash.number(lattice.frame.width);
  hash.tag("lattice-frame-height");
  hash.number(lattice.frame.height);
  hash.tag("lattice-columns");
  hash.number(lattice.columns);
  hash.tag("lattice-rows");
  hash.number(lattice.rows);
  hash.tag("lattice-cell-width");
  hash.number(lattice.cellWidth);
  hash.tag("lattice-cell-height");
  hash.number(lattice.cellHeight);
  hash.tag("lattice-cell-area");
  hash.number(lattice.cellArea);
  hash.tag("lattice-sample-count");
  hash.number(lattice.sampleCount);
  hash.tag("row-major-tone-permission-effective-tone");
  const samples = model.samples();
  if (samples.length !== lattice.sampleCount) {
    throw new Error(
      `Scribble lattice declared ${lattice.sampleCount} samples, received ${samples.length}`,
    );
  }
  for (const sample of samples) {
    hash.number(sample.tone);
    hash.number(sample.permission);
    hash.number(sample.tone * sample.permission);
  }
  return digest(hash.bytes());
}

export async function canonicalBrowserSceneHash(scene: Scene): Promise<string> {
  const hash = new CanonicalBytes();
  hash.tag("scene-v1");
  hash.tag("space-width");
  hash.number(scene.space.width);
  hash.tag("space-height");
  hash.number(scene.space.height);
  hash.tag("background");
  hash.optional(scene.background, (background) => hash.tag(background.color));
  hash.tag("primitives");
  hash.uint32(scene.primitives.length);
  for (const primitive of scene.primitives) {
    hash.tag("primitive");
    hash.optional(primitive.closed, (closed) => hash.byte(closed ? 1 : 0));
    hash.optional(primitive.fill, (fill) => hash.tag(fill.color));
    hash.optional(primitive.stroke, (stroke) => {
      hash.tag(stroke.color);
      hash.number(stroke.width);
    });
    hash.optional(primitive.hiddenLineRole, (role) => hash.tag(role));
    hash.uint32(primitive.points.length);
    for (const point of primitive.points) {
      hash.number(point[0]);
      hash.number(point[1]);
    }
  }
  return digest(hash.bytes());
}

export async function canonicalBrowserDiagnosticsHash(
  diagnostics: ScribbleDiagnostics,
): Promise<string> {
  const hash = new CanonicalBytes();
  hash.tag("scribble-diagnostics-v1");
  hash.tag("termination");
  hash.tag(diagnostics.termination);
  hash.tag("residual-error");
  hash.number(diagnostics.residualError);
  hash.tag("path-length");
  hash.number(diagnostics.pathLength);
  hash.tag("polyline-count");
  hash.number(diagnostics.polylineCount);
  hash.tag("pen-lift-count");
  hash.number(diagnostics.penLiftCount);
  return digest(hash.bytes());
}

/** Hash every canonical product identity field, including ordered params. */
export async function canonicalScribbleIdentityHash(
  identity: ScribbleComputeIdentity,
): Promise<string> {
  const hash = new CanonicalBytes();
  hash.tag("scribble-compute-identity-v1");
  hash.tag(identity.sketchId);
  hash.uint32(identity.params.length);
  for (const entry of identity.params) {
    hash.tag(entry.key);
    if (typeof entry.value === "number") {
      hash.byte(0);
      hash.number(entry.value);
    } else {
      hash.byte(1);
      hash.tag(entry.value);
    }
  }
  if (typeof identity.seed === "number") {
    hash.byte(0);
    hash.number(identity.seed);
  } else {
    hash.byte(1);
    hash.tag(identity.seed);
  }
  hash.number(identity.compositionFrame.width);
  hash.number(identity.compositionFrame.height);
  return digest(hash.bytes());
}
