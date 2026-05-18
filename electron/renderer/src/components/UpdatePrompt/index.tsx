import React, { useEffect, useState } from 'react'

interface DownloadedPayload {
  version:      string
  releaseDate?: string
  releaseName?: string
}

export default function UpdatePrompt() {
  const [info, setInfo] = useState<DownloadedPayload | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.electronAPI.onUpdateDownloaded((payload: unknown) => {
      setInfo(payload as DownloadedPayload)
      setDismissed(false)  // un-dismiss when a newer version lands
    })
    return () => window.electronAPI.removeAllListeners('update:downloaded')
  }, [])

  if (!info || dismissed) return null

  return (
    <div
      style={{
        position:        'fixed',
        bottom:          20,
        right:           20,
        zIndex:          1000,
        maxWidth:        320,
        padding:         '14px 16px',
        backgroundColor: 'var(--color-bg-surface)',
        border:          '1px solid var(--color-divider)',
        borderRadius:    8,
        boxShadow:       '0 8px 24px rgba(0,0,0,0.35)',
        fontFamily:      'inherit',
      }}
    >
      <div style={{
        fontSize:   13,
        fontWeight: 600,
        color:      'var(--color-text-primary)',
        marginBottom: 4,
      }}>
        Update ready
      </div>
      <div style={{
        fontSize: 12,
        color:    'var(--color-text-muted)',
        marginBottom: 12,
      }}>
        Cornflake {info.version} is ready to install. Restart to apply.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setDismissed(true)}
          style={{
            background:   'transparent',
            border:       '1px solid var(--color-divider)',
            color:        'var(--color-text-muted)',
            borderRadius: 4,
            padding:      '5px 12px',
            fontSize:     12,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}
        >
          Later
        </button>
        <button
          onClick={() => window.electronAPI.installUpdate()}
          style={{
            background:   'var(--color-accent, #4c8bf5)',
            border:       'none',
            color:        '#fff',
            borderRadius: 4,
            padding:      '5px 12px',
            fontSize:     12,
            fontWeight:   600,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}
        >
          Restart now
        </button>
      </div>
    </div>
  )
}
