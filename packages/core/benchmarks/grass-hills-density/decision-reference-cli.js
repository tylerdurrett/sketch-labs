import { writeDecisionReference } from './decision-reference.js'

const out = process.argv.find((item) => item.startsWith('--out='))?.slice(6)
if (!out) throw new Error('--out=<directory> is required')
console.log(JSON.stringify(writeDecisionReference(out), null, 2))
