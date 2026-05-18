// Standalone test for the Deepgram transcription pipeline.
// Tests Deepgram API + utterance stitching without Electron or SQLite.
//
// Usage:
//   node scripts/test-transcription.js <micPath> <systemAudioPath>
//
// To find WAV files produced by the Module 4 capture test:
//   find /var/folders -name "cornflake_*.wav" 2>/dev/null | sort -r | head -4
//
// Example:
//   node scripts/test-transcription.js /tmp/cornflake_mic.wav /tmp/cornflake_sys.wav

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const fs = require('fs')
const https = require('https')

const [,, micPath, sysPath] = process.argv
if (!micPath || !sysPath) {
  console.error('Usage: node scripts/test-transcription.js <micPath> <systemAudioPath>')
  process.exit(1)
}

for (const p of [micPath, sysPath]) {
  if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(1) }
  console.log(`${path.basename(p)}: ${fs.statSync(p).size} bytes`)
}

const apiKey = process.env.DEEPGRAM_API_KEY
if (!apiKey) { console.error('DEEPGRAM_API_KEY not set'); process.exit(1) }

// Direct HTTPS call to Deepgram — avoids SDK fetch issues in Electron
function deepgramPost(audioBuffer, query) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.deepgram.com',
        path: `/v1/listen?${query}`,
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/wav',
          'Content-Length': audioBuffer.length,
        },
      },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`Deepgram ${res.statusCode}: ${body}`))
            return
          }
          resolve(JSON.parse(body))
        })
      }
    )
    req.on('error', reject)
    req.write(audioBuffer)
    req.end()
  })
}

async function main() {
  const [micBuf, sysBuf] = [fs.readFileSync(micPath), fs.readFileSync(sysPath)]
  console.log('\nSending audio to Deepgram...')

  const [micResp, sysResp] = await Promise.all([
    deepgramPost(micBuf, 'model=nova-2&smart_format=true'),
    deepgramPost(sysBuf, 'model=nova-2&diarize=true&utterances=true&smart_format=true'),
  ])

  // Mic
  const micWords = micResp.results?.channels?.[0]?.alternatives?.[0]?.words ?? []
  const micTranscript = micResp.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  console.log(`\nMic transcript (${micWords.length} words): "${micTranscript}"`)

  // Stitch mic into utterances (pause > 1s = new utterance)
  const MIC_PAUSE_MS = 1000
  const micUtterances = []
  let curTokens = [], curStart = 0, prevEnd = 0
  for (const w of micWords) {
    const token = w.punctuated_word ?? w.word ?? ''
    if (!token.trim()) continue
    const gapMs = (w.start - prevEnd) * 1000
    if (gapMs > MIC_PAUSE_MS && curTokens.length) {
      micUtterances.push({ speakerId: 'you', text: curTokens.join(' '), startMs: Math.round(curStart * 1000), endMs: Math.round(prevEnd * 1000) })
      curTokens = []; curStart = w.start
    }
    curTokens.push(token); prevEnd = w.end
  }
  if (curTokens.length) micUtterances.push({ speakerId: 'you', text: curTokens.join(' '), startMs: Math.round(curStart * 1000), endMs: Math.round(prevEnd * 1000) })

  // System audio
  const sysRaw = sysResp.results?.utterances ?? []
  console.log(`\nSystem audio utterances from Deepgram: ${sysRaw.length}`)
  const sysUtterances = sysRaw
    .filter(u => u.transcript?.trim())
    .map(u => ({ speakerId: `deepgram_${u.speaker ?? 0}`, text: u.transcript.trim(), startMs: Math.round(u.start * 1000), endMs: Math.round(u.end * 1000) }))

  // Merge
  const merged = [...micUtterances, ...sysUtterances].sort((a, b) => a.startMs - b.startMs)

  console.log(`\n=== Merged Transcript (${merged.length} utterances) ===`)
  for (const u of merged) {
    const ts = `${(u.startMs / 1000).toFixed(2)}s`
    console.log(`  [${u.speakerId.padEnd(12)}] ${ts.padStart(8)}  ${u.text}`)
  }

  const speakers = [...new Set(merged.map(u => u.speakerId))]
  console.log(`\nSpeakers detected: ${speakers.join(', ')}`)
  console.log(`Total: mic=${micUtterances.length}  sys=${sysUtterances.length}  merged=${merged.length}`)
}

main().catch(err => { console.error('Test failed:', err.message); process.exit(1) })
