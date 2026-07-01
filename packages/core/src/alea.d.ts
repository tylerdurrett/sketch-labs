/**
 * Type declaration for the `alea` package, which ships no TypeScript types.
 * Alea is a seedable PRNG by Johannes Baagøe.
 */
declare module 'alea' {
  interface AleaPRNG {
    (): number
    exportState(): [number, number, number, number]
    importState(state: [number, number, number, number]): AleaPRNG
  }

  function alea(...seeds: (string | number)[]): AleaPRNG
  export default alea
}
