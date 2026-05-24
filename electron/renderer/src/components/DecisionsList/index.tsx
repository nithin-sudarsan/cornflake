import React, { useEffect, useState } from 'react'
import { useGetAllDecisions } from '../../hooks/useIPC'

interface DecisionsListProps {
  onDecisionSelect: (id: string) => void
  dataVersion?: number
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24)  return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30)   return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

// Three filled dots for high, two for medium, one for low, none for null.
function ConfidenceDots({ level }: { level: 'high' | 'medium' | 'low' | null }) {
  if (!level) return null
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1
  return (
    <span
      title={`Confidence: ${level}`}
      style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}
    >
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: 3,
            backgroundColor: i < filled
              ? 'var(--color-text-muted)'
              : 'var(--color-divider)',
          }}
        />
      ))}
    </span>
  )
}

export default function DecisionsList({ onDecisionSelect, dataVersion }: DecisionsListProps) {
  const [decisions, setDecisions] = useState<DecisionRecord[]>([])
  const [loading,   setLoading]   = useState(true)
  const getAllDecisions = useGetAllDecisions()

  useEffect(() => {
    setLoading(true)
    getAllDecisions()
      .then(d => { setDecisions(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [dataVersion, getAllDecisions])

  return (
    <main style={{
      flex: 1,
      backgroundColor: 'var(--color-bg-surface)',
      overflowY: 'auto',
      padding: '20px 24px',
    }}>
      {/* Titlebar drag region */}
      <div style={{
        height: 28, marginTop: -20, marginLeft: -24, marginRight: -24,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties} />

      <h1 style={{
        fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
        margin: '0 0 4px',
      }}>
        Decisions
      </h1>
      <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '0 0 20px' }}>
        Concrete commitments captured from your meetings
      </p>

      {loading && (
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</p>
      )}

      {!loading && decisions.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          No decisions yet. They&rsquo;ll appear here as meetings produce them.
        </p>
      )}

      {!loading && decisions.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {decisions.map(d => (
            <li
              key={d.id}
              onClick={() => onDecisionSelect(d.id)}
              style={{
                padding: '12px 14px',
                marginBottom: 8,
                borderRadius: 8,
                backgroundColor: 'var(--color-bg-deep)',
                border: '1px solid var(--color-divider)',
                cursor: 'pointer',
                // Low-confidence rows are dimmed so the eye lands on the
                // high-bar ones first.
                opacity: d.extractionConfidence === 'low' ? 0.55 : 1,
              }}
            >
              <p style={{
                margin: 0, fontSize: 14, lineHeight: 1.4,
                color: 'var(--color-text-primary)',
              }}>
                {d.text}
              </p>
              <div style={{
                marginTop: 6, display: 'flex', alignItems: 'center', gap: 10,
                fontSize: 11, color: 'var(--color-text-muted)',
              }}>
                <span>{formatRelativeTime(d.createdAt)}</span>
                <ConfidenceDots level={d.extractionConfidence} />
                {d.parentDecisionId && (
                  <span title="Stems from an earlier decision">↳ linked</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
