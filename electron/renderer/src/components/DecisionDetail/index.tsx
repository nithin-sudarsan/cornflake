import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  useGetDecisionById,
  useUpdateDecisionText,
  useDeleteDecision,
} from '../../hooks/useIPC'

interface DecisionDetailProps {
  decisionId: string
  onBack: () => void
  onDelete: () => void
  onMeetingSelect: (meetingId: string) => void
  onDecisionSelect: (id: string) => void
}

type DetailPayload = {
  decision: DecisionRecord
  meetingTitle: string | null
  speakerName: string | null
  parent: DecisionRecord | null
  children: DecisionRecord[]
} | null

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      margin: '24px 0 8px',
      fontSize: 11, fontWeight: 600,
      color: 'var(--color-text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
    }}>
      {children}
    </p>
  )
}

function ConfidenceBadge({ level }: { level: 'high' | 'medium' | 'low' | null }) {
  if (!level) return null
  const color =
    level === 'high'   ? '#30D158' :
    level === 'medium' ? '#F59E0B' :
                         'var(--color-text-muted)'
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, color,
      backgroundColor: 'var(--color-bg-deep)',
      border: `1px solid ${color}`,
      borderRadius: 4, padding: '2px 6px',
      textTransform: 'capitalize',
    }}>
      {level} confidence
    </span>
  )
}

export default function DecisionDetail({
  decisionId, onBack, onDelete, onMeetingSelect, onDecisionSelect,
}: DecisionDetailProps) {
  const [payload, setPayload] = useState<DetailPayload>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const getDecisionById   = useGetDecisionById()
  const updateDecisionTxt = useUpdateDecisionText()
  const deleteDecisionIPC = useDeleteDecision()

  useEffect(() => {
    setLoading(true)
    setEditing(false)
    getDecisionById(decisionId)
      .then(d => { setPayload(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [decisionId, getDecisionById])

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current?.focus(), 0)
  }, [editing])

  const startEdit = useCallback(() => {
    if (!payload) return
    setDraft(payload.decision.text)
    setEditing(true)
  }, [payload])

  const commitEdit = useCallback(async () => {
    if (!payload) return
    const next = draft.trim()
    setEditing(false)
    if (!next || next === payload.decision.text) return
    setPayload(p => p ? { ...p, decision: { ...p.decision, text: next } } : p)
    await updateDecisionTxt(payload.decision.id, next)
  }, [draft, payload, updateDecisionTxt])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const handleDelete = async () => {
    if (!payload) return
    if (!window.confirm('Delete this decision? This cannot be undone.')) return
    await deleteDecisionIPC(payload.decision.id)
    onDelete()
  }

  return (
    <main style={{
      flex: 1,
      backgroundColor: 'var(--color-bg-surface)',
      overflowY: 'auto',
      padding: '20px 24px',
    }}>
      <div style={{
        height: 28, marginTop: -20, marginLeft: -24, marginRight: -24,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties} />

      <button
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-muted)', fontSize: 13,
          padding: 0, marginBottom: 24, fontFamily: 'inherit',
        }}
      >
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</p>}
      {!loading && !payload && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Not found.</p>}

      {!loading && payload && (() => {
        const { decision, meetingTitle, speakerName, parent, children } = payload
        return (
          <>
            {/* Decision text — editable */}
            {editing ? (
              <textarea
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={handleKeyDown}
                rows={3}
                style={{
                  fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
                  backgroundColor: 'transparent',
                  border: 'none', borderBottom: '2px solid var(--color-text-muted)',
                  outline: 'none', width: '100%', fontFamily: 'inherit',
                  padding: '0 0 4px', resize: 'vertical',
                  lineHeight: 1.3,
                }}
              />
            ) : (
              <h1
                onClick={startEdit}
                title="Click to edit"
                style={{
                  fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
                  margin: '0 0 8px', cursor: 'text', lineHeight: 1.3,
                  userSelect: 'none',
                }}
              >
                {decision.text}
              </h1>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <ConfidenceBadge level={decision.extractionConfidence} />
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {new Date(decision.createdAt).toLocaleString()}
              </span>
            </div>

            {/* Trace */}
            <SectionHeader>Trace</SectionHeader>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, lineHeight: 1.7 }}>
              <li>
                <span style={{ color: 'var(--color-text-muted)' }}>From meeting: </span>
                {meetingTitle ? (
                  <a
                    onClick={() => onMeetingSelect(decision.meetingId)}
                    style={{
                      color: 'var(--color-text-primary)', cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    {meetingTitle}
                  </a>
                ) : (
                  <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                )}
              </li>
              <li>
                <span style={{ color: 'var(--color-text-muted)' }}>Decided by: </span>
                <span style={{ color: 'var(--color-text-primary)' }}>
                  {speakerName ?? 'unclear'}
                </span>
              </li>
            </ul>

            {/* Transcript quote */}
            {decision.transcriptQuote && (
              <>
                <SectionHeader>Transcript quote</SectionHeader>
                <blockquote style={{
                  margin: 0, padding: '12px 14px',
                  borderLeft: '3px solid var(--color-divider)',
                  backgroundColor: 'var(--color-bg-deep)',
                  borderRadius: '0 6px 6px 0',
                  color: 'var(--color-text-primary)',
                  fontSize: 13, lineHeight: 1.5,
                  fontStyle: 'italic',
                }}>
                  &ldquo;{decision.transcriptQuote}&rdquo;
                </blockquote>
              </>
            )}

            {/* Lineage — parent */}
            {parent && (
              <>
                <SectionHeader>Stems from</SectionHeader>
                <div
                  onClick={() => onDecisionSelect(parent.id)}
                  style={{
                    padding: '10px 12px',
                    backgroundColor: 'var(--color-bg-deep)',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13, color: 'var(--color-text-primary)',
                  }}
                >
                  {parent.text}
                </div>
              </>
            )}

            {/* Lineage — children */}
            {children.length > 0 && (
              <>
                <SectionHeader>Referenced by</SectionHeader>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {children.map(c => (
                    <li
                      key={c.id}
                      onClick={() => onDecisionSelect(c.id)}
                      style={{
                        padding: '10px 12px',
                        marginBottom: 6,
                        backgroundColor: 'var(--color-bg-deep)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 13, color: 'var(--color-text-primary)',
                      }}
                    >
                      {c.text}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* Delete */}
            <div style={{
              height: 1, backgroundColor: 'var(--color-divider)', margin: '32px 0 16px',
            }} />
            <button
              onClick={handleDelete}
              style={{
                fontSize: 13, color: '#f87171',
                background: 'none', border: 'none', padding: 0,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Delete decision
            </button>
          </>
        )
      })()}
    </main>
  )
}
