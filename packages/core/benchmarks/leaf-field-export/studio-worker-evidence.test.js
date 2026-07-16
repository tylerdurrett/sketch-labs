import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('Leaf Field real Studio Worker export evidence', () => {
  it('pins compact cold-export progress, parity, exact reuse, and cancellation', () => {
    const evidence = JSON.parse(
      readFileSync(
        new URL('./results/issue-302-browser-observations.json', import.meta.url),
        'utf8',
      ),
    )

    expect(evidence.issue).toBe(302)
    expect(evidence.warning).toMatch(/never pass\/fail limits or SLAs/)
    expect(evidence.input).toMatchObject({
      preset: 'busy-leaves-balls',
      identityKind: 'legacy-scene',
      source: { primitiveCount: 21666, pointCount: 2101122 },
    })
    expect(evidence.preview).toMatchObject({ status: 'success', derivationCount: 1 })
    expect(evidence.coldExport).toMatchObject({
      status: 'success',
      derivationCount: 1,
      matchesPreviewScene: true,
      compactStatus: {
        containsIdentity: false,
        containsSourceScene: false,
      },
    })
    expect(evidence.coldExport.compactStatus.messageCount).toBeGreaterThan(0)
    expect(evidence.coldExport.compactStatus.maxSerializedBytes).toBeLessThan(512)
    expect(evidence.coldExport.compactStatus.keySets).toEqual([
      ['jobKind', 'owner', 'jobId', 'type', 'snapshot'],
      ['type', 'jobKind', 'owner', 'jobId'],
    ])
    expect(evidence.coldExport.scene).toEqual(evidence.preview.scene)
    expect(evidence.warmExactReuse).toMatchObject({
      status: 'success',
      derivationCount: 0,
      matchesColdScene: true,
      messages: { finalizing: 1, complete: 1 },
    })
    expect(evidence.cancellation).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      compactStatus: {
        containsIdentity: false,
        containsSourceScene: false,
      },
      workerTerminatedCount: 1,
    })
  })
})
