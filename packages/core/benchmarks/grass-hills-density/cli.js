import { pathToFileURL } from 'node:url'

import {
  CAMPAIGN_MODES,
  LONG_CAMPAIGN_CONFIRMATION,
} from './protocol.js'
import { runCampaign } from './runner.js'

export function parseCampaignArgs(argv) {
  let mode = 'smoke'
  let configPath
  let confirmation

  for (const argument of argv) {
    if (argument.startsWith('--mode=')) {
      mode = argument.slice('--mode='.length)
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length)
    } else if (argument === '--confirm-long-campaign') {
      confirmation = LONG_CAMPAIGN_CONFIRMATION
    } else {
      throw new Error(`unknown campaign argument ${argument}`)
    }
  }

  if (!CAMPAIGN_MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${CAMPAIGN_MODES.join(', ')}`)
  }
  if (!configPath) {
    throw new Error('--config=<benchmark config module> is required')
  }
  if (
    (mode === 'full' || mode === 'adopted') &&
    confirmation !== LONG_CAMPAIGN_CONFIRMATION
  ) {
    throw new Error(`${mode} requires --confirm-long-campaign`)
  }

  return { mode, configPath, confirmation }
}

export async function runCli(argv) {
  const { mode, configPath, confirmation } = parseCampaignArgs(argv)
  const configUrl = pathToFileURL(configPath).href
  const config = await import(configUrl)
  const jobs = config.jobs ?? config.default?.jobs
  const result = await runCampaign({ mode, jobs, confirmation })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
