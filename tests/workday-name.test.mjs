import assert from 'node:assert'
import { workdayFallbackName } from '../api/jobs.js'

const cases = [
  ['ffive', 'f5jobs', 'Ffive'],              // normal tenant, not a wd-code -> slugName(tenant) as before
  ['nb', 'nbcareers', 'Nb'],
  ['wd1', 'arbor', 'Arbor'],                 // corrupted tenant -> real site slug recovered
  ['wd5', 'kyndrylprofessionalcareers', 'Kyndrylprofessionalcareers'],
  ['wd12', 'external', null],                // corrupted tenant, generic site -> unrecoverable
  ['wd3', 'careers', null],
  ['wd1', '', null],
]
for (const [tenant, site, expected] of cases) {
  const got = workdayFallbackName(tenant, site)
  assert.strictEqual(got, expected, `workdayFallbackName(${tenant}, ${site}) = ${got}, want ${expected}`)
}
console.log('ALL ASSERTIONS PASSED')
