/**
 * Localhost callback server for OAuth — RFC 8252 (OAuth 2.0 for Native Apps).
 *
 * Instead of redirecting to cornflake:// (which leaves the browser tab spinning),
 * the WorkOS auth URL uses http://127.0.0.1:PORT/callback as the redirect URI.
 * The server responds immediately with a styled success page, so the browser
 * tab resolves cleanly and the user sees "You can close this tab."
 *
 * Prerequisites (one-time setup):
 *   In the WorkOS dashboard → Redirects, add:  http://127.0.0.1
 *   WorkOS follows RFC 8252 §7.3 which allows any loopback port.
 */

import http from 'http'

// ---------------------------------------------------------------------------
// Success / error pages
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Signed in to Cornflake</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      display:flex;align-items:center;justify-content:center;
      min-height:100vh;background:#151515;color:#C1CCDF;
    }
    .card{text-align:center;padding:2rem}
    h1{font-size:1.5rem;font-weight:700;color:#fff;margin-bottom:.5rem}
    p{font-size:.9rem;color:#8A909B}
  </style>
</head>
<body>
  <div class="card">
    <h1>&#10003;&nbsp;Signed in to Cornflake</h1>
    <p>You can close this tab and return to the app.</p>
  </div>
  <script>
    // Close if the tab was opened programmatically; otherwise it's a no-op.
    setTimeout(function(){ try{window.close()}catch(e){} }, 1200)
  </script>
</body>
</html>`

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sign-in failed</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      display:flex;align-items:center;justify-content:center;
      min-height:100vh;background:#151515;color:#C1CCDF;
    }
    .card{text-align:center;padding:2rem}
    h1{font-size:1.5rem;font-weight:700;color:#f87171;margin-bottom:.5rem}
    p{font-size:.9rem;color:#8A909B}
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign-in failed</h1>
    <p>${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let _server: http.Server | null = null

export function stopCallbackServer(): void {
  if (_server) {
    _server.close()
    _server = null
  }
}

/**
 * Start a one-shot HTTP server on a fixed loopback port.
 * Handles exactly one /callback request, then shuts down.
 *
 * WorkOS requires exact redirect URI registration, so a fixed port is used.
 * Register  http://127.0.0.1:PORT/callback  in the WorkOS dashboard.
 * Set  WORKOS_CALLBACK_PORT=PORT  in .env (default: 52069).
 */
async function stopCallbackServerAsync(): Promise<void> {
  if (!_server) return
  const srv = _server
  _server = null
  await new Promise<void>(resolve => srv.close(() => resolve()))
}

export async function startCallbackServer(
  port: number,
  onCode: (code: string) => Promise<void>
): Promise<void> {
  // Await the previous server's close — synchronous tear-down doesn't release
  // the port until in-flight connections drain, which is the cause of EADDRINUSE
  // on the second sign-in attempt in the same app session.
  await stopCallbackServerAsync()

  _server = http.createServer((req, res) => {
    if (!req.url) return

    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }

    const code  = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    stopCallbackServer()  // one-shot: close before responding

    if (error) {
      const desc = url.searchParams.get('error_description') ?? error
      console.error('[auth] OAuth error from WorkOS:', error, desc)
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(errorHtml(`Authentication failed: ${desc}`))
      return
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(errorHtml('No authorization code received.'))
      return
    }

    // Respond to the browser FIRST — tab resolves, no more spinner
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(SUCCESS_HTML)

    // Exchange code for tokens asynchronously (non-blocking for browser)
    onCode(code).catch(err =>
      console.error('[auth] code exchange failed after successful browser response:', err)
    )
  })

  await listenWithRetry(_server!, port)

  console.log(`[auth] callback server ready on http://127.0.0.1:${port}`)
}

/**
 * Try to bind the server; if EADDRINUSE, wait briefly and retry up to 5 times.
 * Covers the case where a zombie listener from the previous Electron process
 * is still holding the port for a few hundred ms after quit.
 */
async function listenWithRetry(srv: http.Server, port: number, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          srv.off('error', onError)
          reject(err)
        }
        srv.once('error', onError)
        srv.listen(port, '127.0.0.1', () => {
          srv.off('error', onError)
          resolve()
        })
      })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE' || i === attempts - 1) {
        if (code === 'EADDRINUSE') {
          throw new Error(
            `Port ${port} is still in use after ${attempts} retries. ` +
            `Another process may be bound to it — set a different WORKOS_CALLBACK_PORT ` +
            `and register http://127.0.0.1:PORT/callback in the WorkOS dashboard.`
          )
        }
        throw err
      }
      console.warn(`[auth] callback port ${port} busy (attempt ${i + 1}/${attempts}) — retrying in 200ms`)
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`
}
