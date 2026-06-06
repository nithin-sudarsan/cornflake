// Quick test for the action router classifier.
// Run with: node scripts/test-action-router.js
// (No Electron / auth / network needed.)

const path = require('path')
const os = require('os')

// Load the compiled classifier directly
const { classifyTaskAction } = require(path.join(__dirname, '../dist/main/modules/action-router/index.js'))

const cases = [
  // EMAIL
  { title: 'Send a follow-up to James',                expected: 'EMAIL' },
  { title: 'Reach out to the design team',             expected: 'EMAIL' },
  { title: 'Email Sarah about the roadmap doc',        expected: 'EMAIL' },
  { title: 'Follow up with the client on pricing',     expected: 'EMAIL' },
  { title: 'Draft a message to the legal team',        expected: 'EMAIL' },
  // CLAUDE_CODE
  { title: 'Implement the auth change',                expected: 'CLAUDE_CODE' },
  { title: 'Fix the login bug on the signup page',     expected: 'CLAUDE_CODE' },
  { title: 'Refactor the payment service',             expected: 'CLAUDE_CODE' },
  { title: 'Write unit tests for the API module',      expected: 'CLAUDE_CODE' },
  { title: 'Deploy the new feature to staging',        expected: 'CLAUDE_CODE' },
  // CALENDAR
  { title: 'Schedule a follow-up meeting',             expected: 'CALENDAR' },
  { title: 'Book a sync with the infra team',          expected: 'CALENDAR' },
  { title: 'Set up a demo for next week',              expected: 'CALENDAR' },
  { title: 'Find a time for the design review',        expected: 'CALENDAR' },
  { title: 'Reschedule the onboarding call',           expected: 'CALENDAR' },
]

let passed = 0
let failed = 0

console.log('\nAction Router — classifier tests\n')

for (const { title, expected } of cases) {
  const got = classifyTaskAction(title)
  const ok = got === expected
  console.log(`  ${ok ? '✓' : '✗'} [${got.padEnd(12)}] "${title}"${ok ? '' : `  ← expected ${expected}`}`)
  ok ? passed++ : failed++
}

console.log(`\n${passed}/${cases.length} passed${failed > 0 ? `, ${failed} failed` : ''}`)

// Also show what the DB looks like if it exists
const dbPath = path.join(os.homedir(), 'Library/Application Support/Cornflake/cornflake.db')
try {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare(
    "SELECT title, action_type FROM tasks ORDER BY created_at DESC LIMIT 10"
  ).all()
  if (rows.length) {
    console.log('\nLast 10 tasks in DB:')
    for (const r of rows) {
      console.log(`  [${(r.action_type ?? 'null').padEnd(12)}] ${r.title}`)
    }
  }
  db.close()
} catch (_) {
  // DB doesn't exist yet or better-sqlite3 path issue — skip
}
