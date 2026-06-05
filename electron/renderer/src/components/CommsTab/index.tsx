import React, { useCallback, useEffect, useState } from 'react'
import {
  type MeetingCommDetail,
  useSendComms,
  useUpdateCommMessage,
  useUpdateCommRecipient,
  useSetCommChannel,
  useOnCommsSent,
} from '../../hooks/useIPC'

export interface CommsSectionProps {
  meetingId: string
  comms: MeetingCommDetail[]
  onChanged?: () => void
}

const CHANNEL_OPTIONS: { value: MeetingCommDetail['deliveryChannel']; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'push', label: 'Push' },
  { value: 'both', label: 'Both' },
]

function CommCard({
  comm,
  onUpdate,
}: {
  comm: MeetingCommDetail
  onUpdate: () => void
}) {
  const [message, setMessage] = useState(comm.messageBody)
  const [email, setEmail] = useState(comm.recipientEmail ?? '')
  const [send, setSend] = useState(comm.send)
  const [channel, setChannel] = useState(comm.deliveryChannel)
  const [saving, setSaving] = useState(false)

  const updateMessage = useUpdateCommMessage()
  const updateRecipient = useUpdateCommRecipient()
  const setCommChannel = useSetCommChannel()

  useEffect(() => {
    setMessage(comm.messageBody)
    setEmail(comm.recipientEmail ?? '')
    setSend(comm.send)
    setChannel(comm.deliveryChannel)
  }, [comm])

  const persist = useCallback(async (patch: {
    messageBody?: string
    email?: string
    send?: boolean
    channel?: MeetingCommDetail['deliveryChannel']
  }) => {
    setSaving(true)
    try {
      if (patch.messageBody !== undefined) {
        await updateMessage({ commId: comm.id, messageBody: patch.messageBody })
      }
      if (patch.email !== undefined || patch.send !== undefined) {
        await updateRecipient({
          commId: comm.id,
          ...(patch.email !== undefined ? { email: patch.email || null } : {}),
          ...(patch.send !== undefined ? { send: patch.send } : {}),
        })
      }
      if (patch.channel !== undefined) {
        await setCommChannel({ commId: comm.id, channel: patch.channel })
      }
      onUpdate()
    } finally {
      setSaving(false)
    }
  }, [comm.id, onUpdate, setCommChannel, updateMessage, updateRecipient])

  const isSent = comm.sentAt != null
  const displayName = comm.recipientName ?? 'Participant'

  return (
    <div style={{
      padding: '14px 14px 12px',
      marginBottom: 10,
      backgroundColor: 'var(--color-bg-deep)',
      border: '1px solid var(--color-divider)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {displayName}
          </p>
          {isSent && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#059669' }}>
              Sent {new Date(comm.sentAt!).toLocaleString()}
            </p>
          )}
          {comm.sendError && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#f87171' }}>
              {comm.sendError}
            </p>
          )}
        </div>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--color-text-muted)', cursor: isSent ? 'default' : 'pointer',
        }}>
          <input
            type="checkbox"
            checked={send}
            disabled={isSent}
            onChange={e => {
              setSend(e.target.checked)
              persist({ send: e.target.checked }).catch(() => {})
            }}
          />
          Send
        </label>
      </div>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        Email
      </label>
      <input
        type="email"
        value={email}
        disabled={isSent}
        placeholder="name@company.com"
        onChange={e => setEmail(e.target.value)}
        onBlur={() => {
          if (email !== (comm.recipientEmail ?? '')) {
            persist({ email }).catch(() => {})
          }
        }}
        style={{
          width: '100%', boxSizing: 'border-box',
          marginBottom: 10, padding: '8px 10px',
          borderRadius: 6, border: '1px solid var(--color-divider)',
          backgroundColor: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit',
        }}
      />

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        Channel
      </label>
      <select
        value={channel}
        disabled={isSent}
        onChange={e => {
          const next = e.target.value as MeetingCommDetail['deliveryChannel']
          setChannel(next)
          persist({ channel: next }).catch(() => {})
        }}
        style={{
          width: '100%', boxSizing: 'border-box',
          marginBottom: 10, padding: '8px 10px',
          borderRadius: 6, border: '1px solid var(--color-divider)',
          backgroundColor: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit',
        }}
      >
        {CHANNEL_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        Message
      </label>
      <textarea
        value={message}
        disabled={isSent}
        rows={6}
        onChange={e => setMessage(e.target.value)}
        onBlur={() => {
          if (message !== comm.messageBody) {
            persist({ messageBody: message }).catch(() => {})
          }
        }}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '10px 10px',
          borderRadius: 6, border: '1px solid var(--color-divider)',
          backgroundColor: 'var(--color-bg-surface)',
          color: 'var(--color-text-primary)', fontSize: 13,
          lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit',
        }}
      />

      {saving && (
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--color-text-muted)' }}>Saving…</p>
      )}
    </div>
  )
}

export function CommsSection({ meetingId, comms, onChanged }: CommsSectionProps) {
  const sendComms = useSendComms()
  const onCommsSent = useOnCommsSent()
  const [sending, setSending] = useState(false)

  useEffect(() => {
    return onCommsSent(() => {
      onChanged?.()
    })
  }, [onCommsSent, onChanged])

  if (comms.length === 0) return null

  const pendingSend = comms.filter(c => c.send && !c.sentAt)
  const allSent = comms.every(c => !c.send || c.sentAt != null)

  async function handleSend() {
    setSending(true)
    try {
      await sendComms({ meetingId })
      onChanged?.()
    } catch (err) {
      console.error('[CommsSection] send failed:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <p style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px',
      }}>
        Notifications
      </p>
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
        Review each message before sending. Nothing goes out until you click send below.
      </p>

      {comms.map(comm => (
        <CommCard key={comm.id} comm={comm} onUpdate={() => onChanged?.()} />
      ))}

      {!allSent && pendingSend.length > 0 && (
        <button
          onClick={() => handleSend()}
          disabled={sending}
          style={{
            width: '100%', height: 40, marginTop: 4,
            borderRadius: 8, border: 'none',
            backgroundColor: '#059669', color: 'white',
            fontSize: 14, fontWeight: 600,
            cursor: sending ? 'default' : 'pointer',
            opacity: sending ? 0.7 : 1,
            fontFamily: 'inherit',
          }}
        >
          {sending ? 'Sending…' : `Send ${pendingSend.length} notification${pendingSend.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}

export default CommsSection
