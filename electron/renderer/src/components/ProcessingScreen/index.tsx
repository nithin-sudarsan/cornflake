import React, { useState, useEffect } from 'react'

const STAGES = [
  'Transcribing your meeting…',
  'Identifying speakers…',
  'Generating notes…',
]

// Each stage is shown for at least MIN_MS before advancing.
// If processing is slower than STAGE_MS per step the timer loops on the
// last stage, so it never goes blank.
const STAGE_MS     = 2200   // time shown per stage
const MIN_STAGE_MS = 800    // minimum display time (spec requirement)

export default function ProcessingScreen() {
  const [stageIndex, setStageIndex] = useState(0)
  const [visible, setVisible]       = useState(false)

  // Fade in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Advance through stages, dwelling on the last one
  useEffect(() => {
    if (stageIndex >= STAGES.length - 1) return
    const id = setTimeout(() => setStageIndex(i => i + 1), STAGE_MS)
    return () => clearTimeout(id)
  }, [stageIndex])

  // Keep MIN_STAGE_MS in sync with the requirement: STAGE_MS already exceeds it,
  // but if someone lowers STAGE_MS below 800 this note serves as the reminder.
  void MIN_STAGE_MS

  return (
    <main
      style={{
        flex: 1,
        backgroundColor: 'var(--color-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.2s ease',
        position: 'relative',
      }}
    >
      {/* Titlebar drag region */}
      <div
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 28,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      />

      {/* Pulse rings */}
      <div style={{ position: 'relative', width: 48, height: 48, marginBottom: 24 }}>
        <span style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: '2px solid var(--color-text-muted)',
          animation: 'processingPulse 1.6s ease-out infinite',
          opacity: 0,
        }} />
        <span style={{
          position: 'absolute', inset: 6, borderRadius: '50%',
          backgroundColor: 'var(--color-text-muted)',
          opacity: 0.25,
          animation: 'processingPulse 1.6s ease-out 0.4s infinite',
        }} />
        <span style={{
          position: 'absolute', inset: 14, borderRadius: '50%',
          backgroundColor: 'var(--color-text-muted)',
          opacity: 0.6,
        }} />
      </div>

      {/* Cycling stage message */}
      <p
        key={stageIndex}
        style={{
          fontSize: 14,
          color: 'var(--color-text-muted)',
          margin: 0,
          animation: 'processingFadeSlide 0.35s ease',
        }}
      >
        {STAGES[stageIndex]}
      </p>

      <style>{`
        @keyframes processingPulse {
          0%   { transform: scale(0.85); opacity: 0.6; }
          60%  { transform: scale(1.4);  opacity: 0; }
          100% { transform: scale(1.4);  opacity: 0; }
        }
        @keyframes processingFadeSlide {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </main>
  )
}
