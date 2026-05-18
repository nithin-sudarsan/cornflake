// Simulates the SPEAKERS_LABEL IPC handler — called after user fills in SpeakerLabeller form.
// Reads the most recent test-labeller meeting and applies manual labels.
const path = require('path')
require('dotenv').config({ path: path.join(process.cwd(), '.env') })
const { app } = require('electron')
app.setName('cornflake')  // match the userData path used by npm start

app.whenReady().then(() => {
  const { initDatabase, closeDatabase } = require(path.join(process.cwd(), 'dist/main/modules/database'))
  const db = initDatabase()

  const meetingId  = '82d4aeac-a4c8-447b-b383-12bf0eb3eafa'
  const speakerA   = '5c6a9fae-4690-453a-9e0e-da78e2201195'
  const speakerB   = '2aec714c-cfd0-4604-953a-e3dfc2eb703f'

  console.log('BEFORE labelling:')
  db.getSpeakersByMeeting(meetingId).filter(s => !s.isSelf).forEach(s => {
    console.log('  deepgram_' + s.deepgramId + ': name=' + s.name + ' confidence=' + s.confidence)
  })
  console.log('  requires_manual_labelling:', db.getMeetingById(meetingId)?.requiresManualLabelling)

  // This mirrors exactly what the SPEAKERS_LABEL IPC handler does
  const resolutions = [
    { speakerId: speakerA, name: 'Jordan', email: 'jordan@example.com' },
    { speakerId: speakerB, name: 'Morgan', email: 'morgan@example.com' },
  ]
  db.bulkResolveSpeakers(resolutions)
  db.setMeetingRequiresLabelling(meetingId, false)

  console.log('\nAFTER labelling:')
  db.getSpeakersByMeeting(meetingId).filter(s => !s.isSelf).forEach(s => {
    console.log('  deepgram_' + s.deepgramId + ': name=' + s.name + ' confidence=' + s.confidence + ' email=' + s.email)
  })
  console.log('  requires_manual_labelling:', db.getMeetingById(meetingId)?.requiresManualLabelling)

  const spA = db.getSpeakersByMeeting(meetingId).find(s => s.id === speakerA)
  const spB = db.getSpeakersByMeeting(meetingId).find(s => s.id === speakerB)
  const met = db.getMeetingById(meetingId)

  // Assertions
  let pass = 0, fail = 0
  function ok(c, m) { if (c) { console.log('  ✓  '+m); pass++ } else { console.error('  ✗  '+m); fail++ } }

  console.log('\nAssertions:')
  ok(spA?.name === 'Jordan',   'Speaker A → Jordan')
  ok(spA?.confidence === 'manual', 'Speaker A confidence = manual')
  ok(spB?.name === 'Morgan',   'Speaker B → Morgan')
  ok(spB?.confidence === 'manual', 'Speaker B confidence = manual')
  ok(met?.requiresManualLabelling === false, 'requires_manual_labelling cleared')

  console.log('\n' + pass + ' passed / ' + fail + ' failed')

  // Cleanup test meeting
  const Database = require('better-sqlite3')
  const raw = new Database(path.join(app.getPath('userData'), 'cornflake.db'))
  raw.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId)
  raw.close()
  console.log('Test meeting cleaned up.')

  closeDatabase()
  process.exit(fail > 0 ? 1 : 0)
})
