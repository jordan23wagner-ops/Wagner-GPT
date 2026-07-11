import assert from 'node:assert'
import { ghostJobRisk } from '../src/lib/ghostJob.js'

const DAY = 86400000
const now = Date.now()
const ageInfo = (days, textOverride) => ({ ts: now - days * DAY, text: textOverride || `${days}d ago`, stale: days > 30 })
const NORMAL_DESC = 'We are looking for an experienced professional to join our growing team and help us deliver great products to customers worldwide. ' +
  'You will collaborate closely with engineering, design, and product stakeholders to plan and execute initiatives from discovery through launch.'

const cases = [
  // [title, description, ageInfo, salInfo, expectedLevel (null/'medium'/'high')]
  ['Senior Project Manager', NORMAL_DESC, ageInfo(5), { text: '$120k', listed: true }, null], // fresh, salaried, normal — no flag
  ['Senior Project Manager', NORMAL_DESC, ageInfo(45), { text: '$120k', listed: true }, null], // moderately stale alone isn't enough
  ['Senior Project Manager', NORMAL_DESC, ageInfo(100), null, 'medium'], // very stale + no salary
  ['Always Hiring - General Application', 'short text', ageInfo(5), { text: '$100k', listed: true }, 'medium'], // evergreen + thin desc
  ['Immediate Hire! Apply Now!', 'short', ageInfo(5), null, 'medium'], // urgency + no salary + thin desc
  ['Always Hiring - Talent Pool', 'short', ageInfo(200), null, 'high'], // evergreen + very stale + no salary + thin desc
  ['Software Engineer', NORMAL_DESC, ageInfo(5), null, null], // missing salary alone isn't enough
]

for (const [title, description, age, salInfo, expectedLevel] of cases) {
  const got = ghostJobRisk({ title, description }, age, salInfo)
  const gotLevel = got ? got.level : null
  assert.strictEqual(gotLevel, expectedLevel, `ghostJobRisk("${title}") = ${gotLevel}, want ${expectedLevel} (reasons: ${got ? got.reasons.join('; ') : 'none'})`)
}
console.log('ALL ASSERTIONS PASSED')
