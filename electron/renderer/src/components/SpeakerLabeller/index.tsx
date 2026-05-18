// SpeakerLabeller — pre-review interstitial shown when Cornflake could not auto-identify
// all meeting speakers. The user labels each "Speaker A/B/C" with a name (and optional
// email) before the review screen renders.

import React, { useState, useCallback } from 'react'
import type { UnresolvedSpeaker, SpeakerResolution } from '../../hooks/useIPC'
import { useLabelSpeakers, useUpdateProfiles } from '../../hooks/useIPC'

interface SpeakerEntry {
  speakerId:  string
  label:      string   // "Speaker A"
  name:       string
  email:      string
}

interface SpeakerLabellerProps {
  meetingId:           string
  unresolvedSpeakers:  UnresolvedSpeaker[]
  onComplete:          () => void
}

export default function SpeakerLabeller({ meetingId, unresolvedSpeakers, onComplete }: SpeakerLabellerProps) {
  const [entries, setEntries] = useState<SpeakerEntry[]>(
    unresolvedSpeakers.map(s => ({
      speakerId: s.id,
      label:     s.label,
      name:      '',
      email:     '',
    }))
  )
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const labelSpeakers  = useLabelSpeakers()
  const updateProfiles = useUpdateProfiles()

  const setField = useCallback((idx: number, field: 'name' | 'email', value: string) => {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e))
  }, [])

  const allNamed = entries.every(e => e.name.trim().length > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!allNamed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const resolutions: SpeakerResolution[] = entries.map(e => ({
        speakerId: e.speakerId,
        name:      e.name.trim(),
        email:     e.email.trim() || undefined,
      }))

      await labelSpeakers(meetingId, resolutions)
      // Profile update is async / best-effort — don't block the user on it
      updateProfiles(meetingId, resolutions).catch(() => {})
      onComplete()
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  const overlayStyle: React.CSSProperties = {
    position:        'fixed',
    inset:           0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          1000,
  }

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--color-bg-surface)',
    borderRadius:    14,
    padding:         '28px 32px',
    width:           420,
    maxWidth:        'calc(100vw - 40px)',
    boxShadow:       '0 8px 40px rgba(0,0,0,0.4)',
  }

  const headingStyle: React.CSSProperties = {
    margin:       0,
    fontSize:     17,
    fontWeight:   700,
    color:        'var(--color-text-primary)',
    marginBottom: 6,
  }

  const subStyle: React.CSSProperties = {
    margin:       '0 0 24px',
    fontSize:     13,
    color:        'var(--color-text-muted)',
    lineHeight:   1.5,
  }

  const labelChipStyle: React.CSSProperties = {
    display:         'inline-block',
    fontSize:        11,
    fontWeight:      700,
    color:           '#d97706',
    backgroundColor: 'rgba(217, 119, 6, 0.12)',
    borderRadius:    99,
    padding:         '2px 8px',
    marginBottom:    8,
  }

  const inputStyle: React.CSSProperties = {
    width:           '100%',
    boxSizing:       'border-box',
    padding:         '8px 12px',
    borderRadius:    8,
    border:          '1px solid var(--color-divider)',
    backgroundColor: 'var(--color-bg-deep)',
    color:           'var(--color-text-primary)',
    fontSize:        13,
    fontFamily:      'inherit',
    outline:         'none',
  }

  const speakerBlockStyle: React.CSSProperties = {
    marginBottom: 20,
    paddingBottom: 20,
    borderBottom: '1px solid var(--color-divider)',
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 10,
    marginTop: 8,
  }

  const btnPrimaryStyle: React.CSSProperties = {
    width:           '100%',
    height:          44,
    borderRadius:    10,
    border:          'none',
    backgroundColor: '#d97706',
    color:           '#fff',
    fontSize:        14,
    fontWeight:      700,
    fontFamily:      'inherit',
    cursor:          allNamed && !submitting ? 'pointer' : 'not-allowed',
    opacity:         allNamed && !submitting ? 1 : 0.5,
    marginTop:       8,
    transition:      'opacity 0.15s',
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={overlayStyle}>
      <form style={cardStyle} onSubmit={handleSubmit}>
        <h2 style={headingStyle}>Who was in this meeting?</h2>
        <p style={subStyle}>
          Cornflake couldn't identify {entries.length === 1 ? 'one speaker' : `${entries.length} speakers`} automatically.
          Add {entries.length === 1 ? 'their name' : 'their names'} to assign tasks correctly.
        </p>

        {entries.map((entry, idx) => (
          <div
            key={entry.speakerId}
            style={idx === entries.length - 1 ? { ...speakerBlockStyle, borderBottom: 'none', marginBottom: 0 } : speakerBlockStyle}
          >
            <span style={labelChipStyle}>{entry.label}</span>

            <div style={rowStyle}>
              <input
                style={{ ...inputStyle, flex: 2 }}
                type="text"
                placeholder="Name *"
                value={entry.name}
                onChange={ev => setField(idx, 'name', ev.target.value)}
                required
                autoFocus={idx === 0}
              />
              <input
                style={{ ...inputStyle, flex: 3 }}
                type="email"
                placeholder="Email (optional)"
                value={entry.email}
                onChange={ev => setField(idx, 'email', ev.target.value)}
              />
            </div>
          </div>
        ))}

        {error && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: '#f87171' }}>{error}</p>
        )}

        <button type="submit" style={btnPrimaryStyle} disabled={!allNamed || submitting}>
          {submitting ? 'Saving…' : 'Continue to review'}
        </button>
      </form>
    </div>
  )
}
