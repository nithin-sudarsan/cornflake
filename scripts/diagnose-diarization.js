// Diagnose diarization — logs exact query params + raw Deepgram response.
// Run via: ./node_modules/.bin/electron --no-sandbox scripts/diagnose-diarization.js <micPath> <sysPath>
// Or:      node scripts/diagnose-diarization.js <micPath> <sysPath>

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const fs = require('fs')
const https = require('https')

const [micPath, sysPath] = process.argv.slice(-2)
if (!micPath || !sysPath || micPath.startsWith('-')) {
  console.error('Usage: <electron|node> diagnose-diarization.js <micPath> <sysPath>')
  process.exit(1)
}

const apiKey = process.env.DEEPGRAM_API_KEY
if (!apiKey) { console.error('DEEPGRAM_API_KEY not set'); process.exit(1) }

function deepgramPost(label, audioBuffer, query) {
  return new Promise((resolve, reject) => {
    const fullPath = `/v1/listen?${query}`
    console.log(`\n[${label}] REQUEST`)
    console.log(`  URL:     https://api.deepgram.com${fullPath}`)
    console.log(`  Size:    ${audioBuffer.length} bytes`)
    console.log(`  Headers: Authorization: Token ${apiKey.substring(0,8)}...`)
    console.log(`           Content-Type: audio/wav`)

    const req = https.request({
      hostname: 'api.deepgram.com',
      path: fullPath,
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
        'Content-Length': audioBuffer.length,
      },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        console.log(`\n[${label}] RESPONSE status=${res.statusCode}`)

        if (res.statusCode !== 200) {
          console.error(`  ERROR: ${body}`)
          reject(new Error(`${res.statusCode}: ${body}`))
          return
        }

        const json = JSON.parse(body)
        resolve({ label, query, json })
      })
    })
    req.on('error', reject)
    req.write(audioBuffer)
    req.end()
  })
}

async function main() {
  const micBuf = fs.readFileSync(micPath)
  const sysBuf = fs.readFileSync(sysPath)
  console.log(`mic:  ${micPath} (${micBuf.length} bytes)`)
  console.log(`sys:  ${sysPath} (${sysBuf.length} bytes)`)

  const MIC_QUERY = 'model=nova-2&smart_format=true'
  const SYS_QUERY = 'model=nova-2&diarize=true&utterances=true&smart_format=true'

  const [micR, sysR] = await Promise.all([
    deepgramPost('MIC', micBuf, MIC_QUERY),
    deepgramPost('SYS', sysBuf, SYS_QUERY),
  ])

  // --- MIC analysis ---
  const micWords = micR.json.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
  const micTranscript = micR.json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  console.log('\n=== MIC: channels[0].alternatives[0] ===')
  console.log(`  transcript: "${micTranscript}"`)
  console.log(`  word count: ${micWords.length}`)
  if (micWords.length > 0) {
    console.log('  first word:', JSON.stringify(micWords[0]))
    console.log('  last word: ', JSON.stringify(micWords[micWords.length - 1]))
  }

  // --- SYS analysis ---
  const sysWords = sysR.json.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
  const sysUtterances = sysR.json.results?.utterances ?? []

  console.log('\n=== SYS: channels[0].alternatives[0].words (diarize word-level) ===')
  console.log(`  word count: ${sysWords.length}`)
  if (sysWords.length > 0) {
    const speakerNums = [...new Set(sysWords.map(w => w.speaker))]
    console.log(`  speakers in words: [${speakerNums.join(', ')}]`)
    console.log('  first 5 words:')
    sysWords.slice(0, 5).forEach(w =>
      console.log(`    speaker=${w.speaker} t=${w.start?.toFixed(2)}s "${w.word}"`)
    )
  }

  console.log('\n=== SYS: results.utterances (requires utterances=true) ===')
  console.log(`  utterance count: ${sysUtterances.length}`)
  if (sysUtterances.length > 0) {
    const speakerNums = [...new Set(sysUtterances.map(u => u.speaker))]
    console.log(`  speakers in utterances: [${speakerNums.join(', ')}]`)
    sysUtterances.forEach((u, i) =>
      console.log(`  [${i}] speaker=${u.speaker} ${u.start?.toFixed(2)}s–${u.end?.toFixed(2)}s: "${u.transcript}"`)
    )
  } else {
    console.log('  (empty — utterances=true may not have been received by Deepgram)')
    console.log('\n  Raw results keys:', Object.keys(sysR.json.results ?? {}))
  }

  // Check if speaker field is present on words at all
  if (sysWords.length > 0 && sysWords[0].speaker === undefined) {
    console.log('\n  ⚠ words[].speaker is UNDEFINED — diarize=true was not applied')
    console.log('  This means Deepgram did not receive the diarize param correctly.')
  }
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1) })
