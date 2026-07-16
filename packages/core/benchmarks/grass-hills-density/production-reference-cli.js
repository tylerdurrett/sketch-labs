import { writeProductionReference } from './production-reference.js'

const out = process.argv.find((item) => item.startsWith('--out='))?.slice(6)
if (!out) throw new Error('--out=<directory> is required')
const fullCeilingOut = process.argv
  .find((item) => item.startsWith('--full-50k-out='))
  ?.slice(15)
const unknown = process.argv
  .slice(2)
  .filter(
    (item) => !item.startsWith('--out=') && !item.startsWith('--full-50k-out='),
  )
if (unknown.length > 0) throw new Error(`unknown argument ${unknown[0]}`)
console.log(
  JSON.stringify(writeProductionReference(out, { fullCeilingOut }), null, 2),
)
