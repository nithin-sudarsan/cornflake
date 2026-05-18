// Manual test: requires Screen Recording permission to be granted in System Settings.
// Run with: node swift/test-capture.js
// (Not electron — raw Node.js, useful for quick sanity checks of the .node API surface)

const path = require('path')
const addon = require(path.join(__dirname, 'build/Release/cornflake_capture.node'))

console.log('addon exports:', Object.keys(addon))

addon.startCapture((err) => {
  if (err) {
    console.error('startCapture error:', err)
    process.exit(1)
  }
  console.log('capture started — recording for 10 seconds...')
  setTimeout(() => {
    addon.stopCapture((stopErr, result) => {
      if (stopErr) {
        console.error('stopCapture error:', stopErr)
        process.exit(1)
      }
      console.log('capture stopped')
      console.log('systemAudioPath:', result.systemAudioPath)
      console.log('micPath:        ', result.micPath)

      const fs = require('fs')
      const sysSize = fs.statSync(result.systemAudioPath).size
      const micSize = fs.statSync(result.micPath).size
      console.log(`system audio WAV: ${sysSize} bytes`)
      console.log(`mic WAV:          ${micSize} bytes`)

      // Minimal WAV header check
      const buf = Buffer.alloc(4)
      const fd = fs.openSync(result.systemAudioPath, 'r')
      fs.readSync(fd, buf, 0, 4, 0)
      fs.closeSync(fd)
      console.log('WAV magic:', buf.toString('ascii'), buf.toString('ascii') === 'RIFF' ? '✓' : '✗')
    })
  }, 10000)
})
