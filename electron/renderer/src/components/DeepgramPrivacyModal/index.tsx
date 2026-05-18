import React, { useState, useEffect } from 'react'

const STORAGE_KEY = 'deepgram_privacy_ack'

export default function DeepgramPrivacyModal() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true)
    }
  }, [])

  function handleAck() {
    localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 16,
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          borderRadius: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          maxWidth: 360,
          width: '100%',
          padding: 24,
          border: '1px solid var(--color-divider)',
        }}
      >
        <h2
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--color-white)',
            marginBottom: 12,
            marginTop: 0,
          }}
        >
          Audio sent to Deepgram for transcription
        </h2>
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-text-primary)',
            lineHeight: 1.6,
            marginBottom: 12,
            marginTop: 0,
          }}
        >
          Cornflake sends your meeting audio to{' '}
          <strong style={{ color: 'var(--color-white)' }}>Deepgram</strong> for
          speech-to-text transcription. Audio is not retained beyond the session.
          All other processing happens locally on your Mac.
        </p>
        <p
          style={{
            fontSize: 11,
            color: 'var(--color-text-muted)',
            marginBottom: 20,
            marginTop: 0,
          }}
        >
          By continuing you acknowledge this. You can review Deepgram's data
          policy at deepgram.com/privacy.
        </p>
        <button
          onClick={handleAck}
          style={{
            width: '100%',
            height: 40,
            borderRadius: 10,
            border: '1px solid var(--color-divider)',
            backgroundColor: 'var(--color-bg-deep)',
            color: 'var(--color-white)',
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
