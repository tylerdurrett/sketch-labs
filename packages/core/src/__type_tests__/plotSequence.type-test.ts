import type {
  PlotSequenceDeclaration as ExportedPlotSequenceDeclaration,
  Scene,
  SketchBase,
} from '../index'
import type {
  PlotSequenceDeclaration,
  PlotStageGenerator,
  PlotStageGeneratorInput,
} from '../plotSequence'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false

type Expect<Value extends true> = Value

/** Compile-only assertions for the public Plot Sequence type contract. */
export type PlotSequenceTypeAssertions = [
  Expect<
    Equal<ExportedPlotSequenceDeclaration, PlotSequenceDeclaration>
  >,
  Expect<
    Equal<
      Parameters<PlotStageGenerator>,
      [input: Readonly<PlotStageGeneratorInput>]
    >
  >,
  Expect<Equal<ReturnType<PlotStageGenerator>, Scene>>,
  Expect<
    Equal<
      keyof PlotStageGeneratorInput,
      'params' | 'seed' | 't' | 'frame' | 'environment'
    >
  >,
  Expect<
    Equal<
      {} extends Pick<SketchBase, 'plotSequence'> ? true : false,
      true
    >
  >,
]
