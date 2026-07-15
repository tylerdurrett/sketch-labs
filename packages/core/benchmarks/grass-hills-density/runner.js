import { execFile, fork } from 'node:child_process'

import {
  PROTOCOL_VERSION,
  censoredResult,
  validateCampaignRequest,
  workerRequest,
} from './protocol.js'

const WORKER_URL = new URL('./worker.js', import.meta.url)
const RSS_POLL_INTERVAL_MS = 100
const STDERR_LIMIT = 16_000
const OOM_PATTERN = /heap out of memory|allocation failed|out of memory/i

export async function runCampaign(request) {
  const campaign = validateCampaignRequest(request)
  const results = []

  // Deliberately serial: the limits are per candidate × fixture child, and a
  // parallel default would make a full campaign an aggregate-memory surprise.
  for (const job of campaign.jobs) {
    results.push(await runJob(job, campaign.mode, campaign.policy))
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    mode: campaign.mode,
    policy: campaign.policy,
    results,
  }
}

async function runJob(job, mode, policy) {
  return await new Promise((resolve) => {
    const started = performance.now()
    let stderr = ''
    let message
    let timedOut = false
    let exceededMemory = false
    let settled = false

    // Leave headroom for stacks, native allocations, and code within the hard
    // RSS ceiling enforced below.
    const oldSpaceMiB = Math.max(128, policy.memoryMiB - 128)
    const child = fork(WORKER_URL, [], {
      execArgv: ['--expose-gc', `--max-old-space-size=${oldSpaceMiB}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT)
    })
    child.on('message', (received) => {
      message = received
    })
    child.on('error', (error) => {
      stderr = `${stderr}\n${error.stack ?? error.message}`.slice(-STDERR_LIMIT)
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, policy.timeoutMs)
    timeout.unref()

    const rssMonitor = setInterval(async () => {
      const rssBytes = await readResidentBytes(child.pid)
      if (settled) return
      if (rssBytes !== null && rssBytes > policy.memoryMiB * 1_024 * 1_024) {
        exceededMemory = true
        child.kill('SIGKILL')
      }
    }, RSS_POLL_INTERVAL_MS)
    rssMonitor.unref()

    child.once('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearInterval(rssMonitor)
      const elapsedMs = performance.now() - started

      if (timedOut) {
        resolve(
          censoredResult({
            job,
            mode,
            policy,
            kind: 'timeout',
            reason: `child exceeded ${policy.timeoutMs} ms`,
            elapsedMs,
            exitCode,
            signal,
          }),
        )
        return
      }
      if (exceededMemory || OOM_PATTERN.test(stderr)) {
        resolve(
          censoredResult({
            job,
            mode,
            policy,
            kind: 'oom',
            reason: exceededMemory
              ? `child RSS exceeded ${policy.memoryMiB} MiB`
              : compactReason(stderr, 'child exhausted its memory allowance'),
            elapsedMs,
            exitCode,
            signal,
          }),
        )
        return
      }
      if (message?.type === 'worker-error') {
        resolve(
          censoredResult({
            job,
            mode,
            policy,
            kind: 'child-error',
            reason: message.reason,
            elapsedMs,
            exitCode,
            signal,
          }),
        )
        return
      }
      const reportedMaxRssBytes = resultMaxRssBytes(message)
      if (reportedMaxRssBytes > policy.memoryMiB * 1_024 * 1_024) {
        resolve(
          censoredResult({
            job,
            mode,
            policy,
            kind: 'oom',
            reason: `child maxRSS exceeded ${policy.memoryMiB} MiB`,
            elapsedMs,
            exitCode,
            signal,
          }),
        )
        return
      }
      if (
        message?.protocolVersion === PROTOCOL_VERSION &&
        message?.type === 'result' &&
        message?.status === 'ok' &&
        exitCode === 0
      ) {
        resolve(message)
        return
      }

      resolve(
        censoredResult({
          job,
          mode,
          policy,
          kind: 'child-error',
          reason: compactReason(
            stderr,
            `child exited without a valid result (code ${String(exitCode)}, signal ${String(signal)})`,
          ),
          elapsedMs,
          exitCode,
          signal,
        }),
      )
    })

    child.send(workerRequest(job, mode, policy), (error) => {
      if (!error || settled) return
      stderr = `${stderr}\n${error.stack ?? error.message}`.slice(-STDERR_LIMIT)
      child.kill('SIGKILL')
    })
  })
}

function readResidentBytes(pid) {
  if (!Number.isInteger(pid) || process.platform === 'win32') {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const rssKiB = Number(stdout.trim())
      resolve(Number.isFinite(rssKiB) ? rssKiB * 1_024 : null)
    })
  })
}

function compactReason(stderr, fallback) {
  const trimmed = stderr.trim()
  return trimmed === '' ? fallback : trimmed.slice(-4_000)
}

function resultMaxRssBytes(message) {
  if (message?.type !== 'result' || message?.status !== 'ok') return 0
  let maximum = 0
  for (const phase of Object.values(message.phases ?? {})) {
    for (const sample of phase?.samples ?? []) {
      maximum = Math.max(
        maximum,
        sample?.memory?.before?.maxRssBytes ?? 0,
        sample?.memory?.after?.maxRssBytes ?? 0,
      )
    }
  }
  return maximum
}
