import React from 'react'
import logoUrl from '../../assets/logo.png'

// Shown after login while the initial pullFromCloud() is in flight.
// App.tsx delays mounting this by 300ms so fast pulls never flash it.
export default function SyncLoadingScreen() {
  return (
    <div
      style={{
        width:           '100vw',
        height:          '100vh',
        // Transparent so the window vibrancy ('hud') shows through, matching
        // the glassy sidebar.
        backgroundColor: 'transparent',
        display:         'flex',
        flexDirection:   'column',
        alignItems:      'center',
        justifyContent:  'center',
        gap:             22,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <img
        src={logoUrl}
        alt="Cornflake"
        style={{
          width:  96,
          height: 96,
          // Crisp rendering on retina — the source is 266×266 so it scales down nicely.
          imageRendering: 'auto',
        }}
        draggable={false}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Spinner />
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          Syncing your data…
        </span>
      </div>

      <style>{`
        @keyframes cornflake-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

function Spinner() {
  return (
    <div
      style={{
        width:        14,
        height:       14,
        borderRadius: '50%',
        border:       '2px solid var(--color-divider)',
        borderTopColor: 'var(--color-text-primary)',
        animation:    'cornflake-spin 0.8s linear infinite',
      }}
    />
  )
}
