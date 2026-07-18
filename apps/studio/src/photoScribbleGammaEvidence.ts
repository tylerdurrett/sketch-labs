/** Benchmark-only source-curve calibration for Photo Scribble issue #336. */

import {
  applyToneContrast,
  applyToneGamma,
  createPhotoScribbleSchema,
  createPhotoScribbleSource,
  createRasterToneSource,
  createToneField,
  sampleEffectiveTone,
  sampleShadingMask,
  sampleToneField,
  type CoordinateSpace,
  type DecodedPixels,
  type Params,
  type ScribbleControls,
  type SketchEnvironment,
  type ToneSource,
} from "@harness/core";

import fixturesJson from "../../../packages/core/benchmarks/photo-scribble/fixtures.json";
import protocolJson from "../../../packages/core/benchmarks/photo-scribble/protocol.json";
import { resolveSketchEnvironment } from "./imageAssetResolver";
import { canonicalBrowserScribbleTargetHash } from "./photoScribbleEvidenceHash";
import { rasterizeToneReference } from "./toneReference";

export type MappingId = "current-0.5-to-2" | "candidate-0.25-to-4";

const CAPTURE_MAPPING_SLUGS: Readonly<Record<MappingId, string>> = {
  "current-0.5-to-2": "current-0-5-to-2",
  "candidate-0.25-to-4": "candidate-0-25-to-4",
};

interface Scenario {
  readonly scenarioId: string;
  readonly fixtureId: string;
  readonly params: Params & ScribbleControls;
}

interface Fixture {
  readonly fixtureId: string;
  readonly assetId: string;
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly categories: readonly string[];
}

interface Probe {
  readonly probeId: string;
  readonly sourcePixel: { readonly x: number; readonly y: number } | null;
  readonly framePoint: { readonly x: number; readonly y: number };
}

interface ProbeGroup {
  readonly scenarioId: string;
  readonly probes: readonly Probe[];
}

const protocol = protocolJson as unknown as {
  readonly frame: CoordinateSpace;
  readonly scenarios: readonly Scenario[];
  readonly measurement: {
    readonly toneSampling: {
      readonly gammaSweep: {
        readonly toneGammaValues: readonly number[];
        readonly fixedToneContrast: number;
      };
      readonly contrastSweep: {
        readonly toneContrastValues: readonly number[];
        readonly fixedToneGamma: number;
      };
      readonly scenarioProbes: readonly ProbeGroup[];
    };
  };
};

const fixtures = fixturesJson as unknown as {
  readonly fixtures: readonly Fixture[];
};

const QUANTILES = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1] as const;
const TONE_REFERENCE_SIZE = 512;
const RED_LUMINANCE = 0.2126;
const GREEN_LUMINANCE = 0.7152;
const BLUE_LUMINANCE = 0.0722;

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clampControl(value: number): number {
  return Number.isFinite(value) ? clampUnit(value) : 0.5;
}

function srgbByteToLinear(byte: number): number {
  const encoded = byte / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function decodedRawTone(pixels: Readonly<DecodedPixels>, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  return 1 - (
    RED_LUMINANCE * srgbByteToLinear(pixels.data[offset]!) +
    GREEN_LUMINANCE * srgbByteToLinear(pixels.data[offset + 1]!) +
    BLUE_LUMINANCE * srgbByteToLinear(pixels.data[offset + 2]!)
  );
}

function gammaExponent(mapping: MappingId, controlValue: number): number {
  const span = mapping === "current-0.5-to-2" ? 2 : 4;
  return 2 ** (span * (clampControl(controlValue) - 0.5));
}

function applyCandidateToneGamma(tone: number, controlValue: number): number {
  const boundedTone = clampUnit(tone);
  if (boundedTone === 0 || clampControl(controlValue) === 0.5) return boundedTone;
  return clampUnit(boundedTone ** gammaExponent("candidate-0.25-to-4", controlValue));
}

function adjustTone(
  tone: number,
  mapping: MappingId,
  gamma: number,
  contrast: number,
): number {
  const gammaAdjusted = mapping === "current-0.5-to-2"
    ? applyToneGamma(tone, gamma)
    : applyCandidateToneGamma(tone, gamma);
  return applyToneContrast(gammaAdjusted, contrast);
}

function candidateSource(
  pixels: Readonly<DecodedPixels>,
  frame: Readonly<CoordinateSpace>,
  gamma: number,
  contrast: number,
): ToneSource {
  const raster = createRasterToneSource(pixels, frame);
  return Object.freeze({
    toneField: createToneField((point) =>
      applyToneContrast(
        applyCandidateToneGamma(sampleToneField(raster.toneField, point), gamma),
        contrast,
      ),
    ),
    shadingMask: raster.shadingMask,
  });
}

function currentSource(
  scenario: Scenario,
  fixture: Fixture,
  environment: SketchEnvironment,
  gamma: number,
  contrast: number,
): ToneSource {
  const schema = createPhotoScribbleSchema(fixture.assetId);
  return createPhotoScribbleSource(
    { ...scenario.params, toneGamma: gamma, toneContrast: contrast },
    protocol.frame,
    schema,
    environment,
  );
}

function quantileRecord(
  sorted: Float64Array,
  transform: (value: number) => number = (value) => value,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const quantile of QUANTILES) {
    const index = Math.floor(quantile * Math.max(0, sorted.length - 1));
    values[String(quantile)] = sorted.length === 0 ? 0 : transform(sorted[index]!);
  }
  return values;
}

function summarizeAdjusted(
  sortedRawTone: Float64Array,
  mapping: MappingId,
  gamma: number,
  contrast: number,
) {
  let paperWhite = 0;
  let black = 0;
  let total = 0;
  for (const rawTone of sortedRawTone) {
    const adjusted = adjustTone(rawTone, mapping, gamma, contrast);
    if (adjusted === 0) paperWhite += 1;
    if (adjusted === 1) black += 1;
    total += adjusted;
  }
  return {
    sampleCount: sortedRawTone.length,
    paperWhitePixels: paperWhite,
    paperWhiteFraction: paperWhite / sortedRawTone.length,
    blackPixels: black,
    blackFraction: black / sortedRawTone.length,
    mean: total / sortedRawTone.length,
    quantiles: quantileRecord(
      sortedRawTone,
      (tone) => adjustTone(tone, mapping, gamma, contrast),
    ),
  };
}

function summarizeEffective(
  rawToneByPixel: Float64Array,
  permissionByPixel: Float64Array,
  mapping: MappingId,
  gamma: number,
  contrast: number,
) {
  const sorted = new Float64Array(rawToneByPixel.length);
  let paperWhite = 0;
  let black = 0;
  let total = 0;
  for (let index = 0; index < rawToneByPixel.length; index += 1) {
    const effective = adjustTone(rawToneByPixel[index]!, mapping, gamma, contrast) *
      permissionByPixel[index]!;
    sorted[index] = effective;
    if (effective === 0) paperWhite += 1;
    if (effective === 1) black += 1;
    total += effective;
  }
  sorted.sort();
  return {
    sampleCount: sorted.length,
    paperWhitePixels: paperWhite,
    paperWhiteFraction: paperWhite / sorted.length,
    blackPixels: black,
    blackFraction: black / sorted.length,
    mean: total / sorted.length,
    quantiles: quantileRecord(sorted),
  };
}

function summarizeToneReference(raster: ReturnType<typeof rasterizeToneReference>) {
  const sorted = new Float64Array(raster.width * raster.height);
  let paperWhite = 0;
  let black = 0;
  let total = 0;
  for (let pixel = 0; pixel < sorted.length; pixel += 1) {
    const gray = raster.data[pixel * 4]!;
    const effectiveTone = (255 - gray) / 255;
    sorted[pixel] = effectiveTone;
    if (gray === 255) paperWhite += 1;
    if (gray === 0) black += 1;
    total += effectiveTone;
  }
  sorted.sort();
  return {
    width: raster.width,
    height: raster.height,
    sampleCount: sorted.length,
    paperWhitePixels: paperWhite,
    paperWhiteFraction: paperWhite / sorted.length,
    blackPixels: black,
    blackFraction: black / sorted.length,
    mean: total / sorted.length,
    quantiles: quantileRecord(sorted),
  };
}

export function photoScribbleGammaCaptureId(
  fixtureId: string,
  mapping: MappingId,
): string {
  return `gamma-${fixtureId}-${CAPTURE_MAPPING_SLUGS[mapping]}`;
}

function paintCapture(
  fixtureId: string,
  mapping: MappingId,
  raster: ReturnType<typeof rasterizeToneReference>,
): string {
  const captureId = photoScribbleGammaCaptureId(fixtureId, mapping);
  const root = document.querySelector<HTMLElement>("#gamma-captures");
  if (root === null) throw new Error("Gamma evidence capture root is missing");
  const figure = document.createElement("figure");
  figure.id = captureId;
  figure.dataset.fixtureId = fixtureId;
  figure.dataset.mappingId = mapping;
  const caption = document.createElement("figcaption");
  caption.textContent = `${fixtureId} — ${mapping}`;
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  canvas.setAttribute("aria-label", caption.textContent);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Tone-reference canvas context is unavailable");
  const imageData = context.createImageData(raster.width, raster.height);
  imageData.data.set(raster.data);
  context.putImageData(imageData, 0, 0);
  figure.append(caption, canvas);
  root.append(figure);
  return captureId;
}

function profileId(mapping: MappingId, gamma: number, contrast: number, authored: boolean): string {
  return authored
    ? `${mapping}--authored`
    : `${mapping}--gamma-${gamma}--contrast-${contrast}`;
}

function scribbleControls(params: Scenario["params"]): ScribbleControls {
  return {
    pathDensity: params.pathDensity,
    scribbleScale: params.scribbleScale,
    momentum: params.momentum,
    chaos: params.chaos,
    toneFidelity: params.toneFidelity,
  };
}

async function fixtureEvidence(scenario: Scenario, fixture: Fixture) {
  const schema = createPhotoScribbleSchema(fixture.assetId);
  const environment = await resolveSketchEnvironment(schema, scenario.params);
  const pixels = environment.imageAssets(fixture.assetId);
  if (pixels === undefined) throw new Error(`Resolved fixture ${fixture.fixtureId} disappeared`);
  const rawToneByPixel = new Float64Array(pixels.width * pixels.height);
  const permissionByPixel = new Float64Array(pixels.width * pixels.height);
  const opaqueTone: number[] = [];
  let partialPermission = 0;
  let zeroPermission = 0;

  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const index = y * pixels.width + x;
      const rawTone = decodedRawTone(pixels, index);
      const permission = pixels.data[index * 4 + 3]! / 255;
      rawToneByPixel[index] = rawTone;
      permissionByPixel[index] = permission;
      if (permission === 1) opaqueTone.push(rawTone);
      else if (permission === 0) zeroPermission += 1;
      else partialPermission += 1;
    }
  }
  const sortedOpaqueTone = Float64Array.from(opaqueTone).sort();
  const profiles = [];
  const captureIds: Record<string, string> = {};
  const probeGroup = protocol.measurement.toneSampling.scenarioProbes.find(
    (group) => group.scenarioId === scenario.scenarioId,
  );
  if (probeGroup === undefined) throw new Error(`Missing probes for ${scenario.scenarioId}`);

  for (const mapping of ["current-0.5-to-2", "candidate-0.25-to-4"] as const) {
    const profileControls = [
      ...protocol.measurement.toneSampling.gammaSweep.toneGammaValues.flatMap((gamma) =>
        protocol.measurement.toneSampling.contrastSweep.toneContrastValues.map((contrast) => ({
          gamma,
          contrast,
          authored: false,
        })),
      ),
      {
        gamma: Number(scenario.params.toneGamma),
        contrast: Number(scenario.params.toneContrast),
        authored: true,
      },
    ];
    for (const controls of profileControls) {
      const source = mapping === "current-0.5-to-2"
        ? currentSource(
            scenario,
            fixture,
            environment,
            controls.gamma,
            controls.contrast,
          )
        : candidateSource(pixels, protocol.frame, controls.gamma, controls.contrast);
      const id = profileId(mapping, controls.gamma, controls.contrast, controls.authored);
      const probes = probeGroup.probes.map((probe) => ({
        probeId: probe.probeId,
        sourcePixel: probe.sourcePixel,
        framePoint: probe.framePoint,
        tone: sampleToneField(source.toneField, [probe.framePoint.x, probe.framePoint.y]),
        permission: sampleShadingMask(source.shadingMask, [probe.framePoint.x, probe.framePoint.y]),
        effectiveTone: sampleEffectiveTone(source, [probe.framePoint.x, probe.framePoint.y]),
      }));
      const targetHash = await canonicalBrowserScribbleTargetHash(
        source,
        protocol.frame,
        scribbleControls(scenario.params),
      );
      let toneReference = null;
      if (controls.authored) {
        const raster = rasterizeToneReference(
          source,
          protocol.frame,
          TONE_REFERENCE_SIZE,
          TONE_REFERENCE_SIZE,
        );
        toneReference = summarizeToneReference(raster);
        captureIds[mapping] = paintCapture(fixture.fixtureId, mapping, raster);
      }
      profiles.push({
        profileId: id,
        mapping,
        exponent: gammaExponent(mapping, controls.gamma),
        toneGamma: controls.gamma,
        toneContrast: controls.contrast,
        authored: controls.authored,
        targetHash,
        probes,
        adjustedOpaqueTone: summarizeAdjusted(
          sortedOpaqueTone,
          mapping,
          controls.gamma,
          controls.contrast,
        ),
        effectiveToneOverAllDecodedPixels: summarizeEffective(
          rawToneByPixel,
          permissionByPixel,
          mapping,
          controls.gamma,
          controls.contrast,
        ),
        toneReference,
      });
    }
  }

  const centeredCurrent = profiles.find(
    (profile) => profile.profileId === "current-0.5-to-2--gamma-0.5--contrast-0.5",
  )!;
  const centeredCandidate = profiles.find(
    (profile) => profile.profileId === "candidate-0.25-to-4--gamma-0.5--contrast-0.5",
  )!;
  const zeroProbeIds = new Set(
    probeGroup.probes.filter((probe) => probe.sourcePixel === null || probe.probeId.includes("transparent-zero"))
      .map((probe) => probe.probeId),
  );
  const adjustmentProfiles = profiles.filter((profile) => !profile.authored);
  const gammaProfiles = adjustmentProfiles.filter(
    (profile) =>
      profile.toneContrast === protocol.measurement.toneSampling.gammaSweep.fixedToneContrast,
  );
  const contrastProfiles = adjustmentProfiles.filter(
    (profile) =>
      profile.toneGamma === protocol.measurement.toneSampling.contrastSweep.fixedToneGamma,
  );

  return {
    fixtureId: fixture.fixtureId,
    scenarioId: scenario.scenarioId,
    assetId: fixture.assetId,
    categories: fixture.categories,
    dimensions: { width: pixels.width, height: pixels.height },
    adapterDistribution: {
      decodedPixelCount: pixels.width * pixels.height,
      fullyOpaque: sortedOpaqueTone.length,
      partialPermission,
      zeroPermission,
      rawOpaqueTone: {
        sampleCount: sortedOpaqueTone.length,
        quantiles: quantileRecord(sortedOpaqueTone),
      },
    },
    invariants: {
      normalizedControlRangePreserved: profiles.every(
        (profile) => profile.toneGamma >= 0 && profile.toneGamma <= 1 &&
          profile.toneContrast >= 0 && profile.toneContrast <= 1,
      ),
      exactCenteredIdentity:
        centeredCurrent.targetHash === centeredCandidate.targetHash &&
        centeredCurrent.probes.every((probe, index) =>
          probe.tone === centeredCandidate.probes[index]!.tone &&
          probe.permission === centeredCandidate.probes[index]!.permission &&
          probe.effectiveTone === centeredCandidate.probes[index]!.effectiveTone,
        ),
      centeredTargetHash: centeredCurrent.targetHash,
      exactZeroToneAndPermission: adjustmentProfiles.every((profile) =>
        profile.probes.filter((probe) => zeroProbeIds.has(probe.probeId)).every(
          (probe) => probe.permission === 0 && probe.effectiveTone === 0,
        ),
      ),
      gammaSweepMonotonicAtNonzeroProbes: [
        "current-0.5-to-2",
        "candidate-0.25-to-4",
      ].every((mapping) => {
        const sweep = gammaProfiles
          .filter((profile) => profile.mapping === mapping)
          .sort((left, right) => left.toneGamma - right.toneGamma);
        return sweep[0]!.probes.every((probe, probeIndex) =>
          probe.effectiveTone === 0 ||
          (sweep[0]!.probes[probeIndex]!.effectiveTone > sweep[1]!.probes[probeIndex]!.effectiveTone &&
            sweep[1]!.probes[probeIndex]!.effectiveTone > sweep[2]!.probes[probeIndex]!.effectiveTone),
        );
      }),
      contrastSweepMonotonicAtNonzeroProbes: [
        "current-0.5-to-2",
        "candidate-0.25-to-4",
      ].every((mapping) => {
        const sweep = contrastProfiles
          .filter((profile) => profile.mapping === mapping)
          .sort((left, right) => left.toneContrast - right.toneContrast);
        return sweep[0]!.probes.every((probe, probeIndex) => {
          const rawTone = centeredCurrent.probes[probeIndex]!.tone;
          if (probe.effectiveTone === 0 || rawTone === 0.5) return true;
          const [low, centered, high] = sweep.map(
            (profile) => profile.probes[probeIndex]!.effectiveTone,
          );
          return rawTone < 0.5
            ? low! > centered! && centered! > high!
            : low! < centered! && centered! < high!;
        });
      }),
      gammaBeforeContrast: profiles.every((profile) =>
        profile.probes.every((probe, probeIndex) =>
          probe.tone === adjustTone(
            centeredCurrent.probes[probeIndex]!.tone,
            profile.mapping,
            profile.toneGamma,
            profile.toneContrast,
          ),
        ),
      ),
      contrastMappingChanged: contrastProfiles.some((profile) => {
        const counterpart = contrastProfiles.find(
          (candidate) =>
            candidate.mapping !== profile.mapping &&
            candidate.toneGamma === profile.toneGamma &&
            candidate.toneContrast === profile.toneContrast,
        );
        return counterpart === undefined || counterpart.targetHash !== profile.targetHash;
      }),
      levelsControlAdded: false,
    },
    captureIds,
    profiles,
  };
}

export async function runPhotoScribbleGammaEvidence() {
  const captureRoot = document.querySelector<HTMLElement>("#gamma-captures");
  if (captureRoot === null) throw new Error("Gamma evidence capture root is missing");
  captureRoot.replaceChildren();
  const fixtureResults = [];
  for (const fixture of fixtures.fixtures) {
    const scenario = protocol.scenarios.find(
      (candidate) =>
        candidate.fixtureId === fixture.fixtureId &&
        candidate.scenarioId.endsWith("-control"),
    );
    if (scenario === undefined) throw new Error(`Missing control scenario for ${fixture.fixtureId}`);
    fixtureResults.push(await fixtureEvidence(scenario, fixture));
  }
  return {
    schemaVersion: 1,
    issue: 336,
    scope: "source-only-gamma-calibration",
    generatedAt: new Date().toISOString(),
    mappingComparison: {
      current: { exponentRange: [0.5, 2], normalizedControlRange: [0, 1], identity: 0.5 },
      candidate: { exponentRange: [0.25, 4], normalizedControlRange: [0, 1], identity: 0.5 },
      contrastRangeUnchanged: [0.15, 1.85],
      authoredOrder: "gamma-before-contrast",
      levelsControl: "not-added",
    },
    quantileRule: "nearest lower rank floor(q * (n - 1)) over every decoded sample in the named population",
    toneReference: {
      renderer: "apps/studio/src/toneReference.ts rasterizeToneReference",
      width: TONE_REFERENCE_SIZE,
      height: TONE_REFERENCE_SIZE,
      pixelCenterSampling: true,
    },
    fixtures: fixtureResults,
  };
}
