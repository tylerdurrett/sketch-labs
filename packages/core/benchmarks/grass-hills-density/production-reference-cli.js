import { writeProductionReference } from './production-reference.js'

const out = process.argv.find((item) => item.startsWith('--out='))?.slice(6)
if (!out) throw new Error('--out=<directory> is required')
console.log(JSON.stringify(writeProductionReference(out), null, 2))
