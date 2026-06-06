import React, { useState } from 'react'

interface Props {
  onSubscriptionConfirmed: () => void
}

type State = 'idle' | 'opening' | 'awaiting_payment' | 'checking' | 'error'

export default function PaywallScreen({ onSubscriptionConfirmed }: Props) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleProceed() {
    setState('opening')
    setErrorMsg(null)
    try {
      const { url } = await window.electronAPI.createCheckoutSession()
      await window.electronAPI.openExternal(url)
      setState('awaiting_payment')
    } catch (err) {
      const msg = (err as Error).message ?? ''
      console.error('[PaywallScreen] createCheckoutSession failed:', msg)
      setErrorMsg(msg || 'Could not open checkout. Please try again.')
      setState('error')
    }
  }

  async function handleCheckAgain() {
    setState('checking')
    setErrorMsg(null)
    try {
      const { status } = await window.electronAPI.getSubscriptionStatus()
      const active = status === 'active' || status === 'trialing'
      if (active) {
        onSubscriptionConfirmed()
      } else {
        setErrorMsg('Payment not confirmed yet. Complete checkout in your browser, then try again.')
        setState('awaiting_payment')
      }
    } catch {
      setErrorMsg('Could not verify subscription. Please try again.')
      setState('awaiting_payment')
    }
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <div style={{ marginBottom: 8 }}>
        <span style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--color-white)',
          letterSpacing: '-0.02em',
        }}>
          cornflake
        </span>
      </div>

      <p style={{
        fontSize: 14,
        color: 'var(--color-text-muted)',
        marginBottom: 32,
        fontWeight: 400,
      }}>
        Your meetings, organised.
      </p>

      {/* Plan card */}
      <div
        style={{
          backgroundColor: 'var(--color-bg-surface)',
          border: '1px solid var(--color-divider)',
          borderRadius: 12,
          padding: '24px 28px',
          width: 280,
          marginBottom: 20,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {/* Free trial badge */}
        <div style={{
          display: 'inline-block',
          backgroundColor: 'rgba(74, 222, 128, 0.15)',
          color: '#4ade80',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          padding: '3px 8px',
          borderRadius: 4,
          marginBottom: 14,
        }}>
          First month free
        </div>

        <div style={{ marginBottom: 4 }}>
          <span style={{
            fontSize: 32,
            fontWeight: 700,
            color: 'var(--color-white)',
            letterSpacing: '-0.02em',
          }}>
            £10
          </span>
          <span style={{
            fontSize: 14,
            color: 'var(--color-text-muted)',
            marginLeft: 4,
          }}>
            / month
          </span>
        </div>

        <p style={{
          fontSize: 13,
          color: 'var(--color-text-muted)',
          margin: '0 0 20px',
          lineHeight: 1.5,
        }}>
          Try free for 30 days — no charge until your trial ends.
          Cancel anytime.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {[
            'Unlimited meeting recordings',
            'AI task & decision extraction',
            'Calendar & email integrations',
          ].map(feature => (
            <div key={feature} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#4ade80', fontSize: 14 }}>✓</span>
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{feature}</span>
            </div>
          ))}
        </div>

        {state !== 'awaiting_payment' && state !== 'checking' ? (
          <button
            onClick={handleProceed}
            disabled={state === 'opening'}
            style={{
              width: '100%',
              padding: '10px 0',
              backgroundColor: 'var(--color-white)',
              color: 'var(--color-bg-deep)',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: state === 'opening' ? 'default' : 'pointer',
              opacity: state === 'opening' ? 0.7 : 1,
              fontFamily: 'inherit',
            }}
          >
            {state === 'opening' ? 'Opening browser…' : 'Start free trial'}
          </button>
        ) : (
          <button
            onClick={handleCheckAgain}
            disabled={state === 'checking'}
            style={{
              width: '100%',
              padding: '10px 0',
              backgroundColor: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-divider)',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: state === 'checking' ? 'default' : 'pointer',
              opacity: state === 'checking' ? 0.7 : 1,
              fontFamily: 'inherit',
            }}
          >
            {state === 'checking' ? 'Checking…' : "I've subscribed"}
          </button>
        )}
      </div>

      {state === 'awaiting_payment' && (
        <p style={{
          fontSize: 12,
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          maxWidth: 260,
        }}>
          Complete checkout in your browser, then click above.
        </p>
      )}

      {errorMsg && (
        <p style={{
          marginTop: 8,
          fontSize: 12,
          color: '#f87171',
          textAlign: 'center',
          maxWidth: 260,
        }}>
          {errorMsg}
        </p>
      )}
    </div>
  )
}
