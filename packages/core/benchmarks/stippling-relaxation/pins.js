// Source-controlled smoke pins. The full matrix writes the same invariant shape
// into raw evidence; these two preregistered cases additionally fail immediately
// when ordered output, termination, work, or diagnostics drift between commits.
export const PREREGISTERED_PINS = Object.freeze({
  'flat:density=1:relaxation=0': Object.freeze({
    orderedChecksum: '77ce372a6bf4bef6de4c036a21df7f6417c8d28d779784a350d2522711308a70',
    termination: 'completed',
    work: Object.freeze({
      placementAttempts: 1_578,
      refinementAttempts: 5_200,
      voronoi: null,
      relocationAccepted: 0,
    }),
    diagnostics: Object.freeze({
      termination: 'completed',
      distributionError: 1.7460937499999913,
      relaxation: null,
    }),
  }),
  'ramp:density=100:relaxation=0.5': Object.freeze({
    orderedChecksum: 'b0a34300c7f7e945eb317594ab8c0a47da32caf06d21cac74645a45eed54b31d',
    termination: 'completed',
    work: Object.freeze({
      placementAttempts: 159_490,
      refinementAttempts: 400_000,
      voronoi: Object.freeze({
        sampleCount: 40_000,
        assignedSampleCount: 40_000,
        distanceEvaluationCount: 403_463,
        seedLookupCount: 616_177,
        indexBuildOperationCount: 3_932_254,
      }),
      relocationAccepted: 31_116,
    }),
    diagnostics: Object.freeze({
      termination: 'completed',
      distributionError: 0.3751682499999885,
      relaxation: Object.freeze({
        objective: 7.280224586497679e-7,
        requestedWorkUnits: 480_000,
        completedWorkUnits: 360_000,
        iterationsCompleted: 3,
        relocationsAccepted: 36_871,
      }),
    }),
  }),
})
