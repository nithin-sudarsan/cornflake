// Shared HTTPS POST helper for LLM provider implementations.
// Uses native https to avoid issues with Electron's patched global fetch in main process.

import https from 'https'

export function httpsPost(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: object,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const options: https.RequestOptions = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    }

    const req = https.request(options, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
          return
        }
        resolve(text)
      })
    })

    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// Strip markdown code fences and extract the first JSON object or array from a string.
// LLMs sometimes wrap their output in ```json ... ``` even when asked not to.
export function parseJsonResponse<T>(text: string): T | null {
  let cleaned = text.trim()

  // Strip ```json ... ``` or ``` ... ``` fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

  // Try a clean parse first
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Find first { or [ and try to extract from there
    const objStart = cleaned.indexOf('{')
    const arrStart = cleaned.indexOf('[')
    const start = objStart === -1 ? arrStart
      : arrStart === -1 ? objStart
      : Math.min(objStart, arrStart)

    if (start === -1) return null

    const lastBrace = cleaned.lastIndexOf('}')
    const lastBracket = cleaned.lastIndexOf(']')
    const end = Math.max(lastBrace, lastBracket)

    if (end <= start) return null

    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T
    } catch {
      return null
    }
  }
}
