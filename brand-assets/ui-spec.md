# Cornflake UI Spec

## Typography
Font family: **Mona Sans** throughout — import via `@font-face` or CDN, fallback to `Inter, system-ui, sans-serif`.

| Role | Weight | Size (approx) |
|---|---|---|
| Section header ("Today", "Tomorrow", "Tue 19 May") | SemiBold (600) | 11px uppercase, letter-spacing: 0.08em |
| Event title | SemiBold (600) | 14px |
| Event meta (time · attendees) | Regular (400) | 12px |
| Button label ("Start listening") | SemiBold (600) | 14px |
| Sidebar list label | Regular (400) | 13px |
| Sidebar list label (active) | SemiBold (600) | 13px |
| Reminder task title | Regular (400) | 14px |
| Reminder task meta (date) | Regular (400) | 12px |
| Username | Regular (400) | 13px |

---

## Colours

These are the exact colours from Figma. No other colours should be used.

| Token | Hex | Opacity | Usage |
|---|---|---|---|
| `--color-text-primary` | `#C1CCDF` | 100% | Primary text — event titles, task titles, button labels |
| `--color-white` | `#FFFFFF` | 100% | Headings, active sidebar labels, high-emphasis text |
| `--color-black` | `#000000` | 100% | Reserved — use sparingly if at all |
| `--color-text-muted` | `#8A909B` | 100% | Secondary text — event meta, section headers, inactive labels |
| `--color-divider` | `#8A909B` | 60% | Separator lines between sections and date groups |
| `--color-bg-deep` | `#151515` | 100% | Deepest background — sidebar |
| `--color-bg-surface` | `#262626` | 100% | Surface background — main content area, right panel, cards |

### CSS custom properties

```css
:root {
  --color-text-primary: #C1CCDF;
  --color-white: #FFFFFF;
  --color-black: #000000;
  --color-text-muted: #8A909B;
  --color-divider: rgba(138, 144, 155, 0.6);
  --color-bg-deep: #151515;
  --color-bg-surface: #262626;
}
```

---

## Layout & Spacing

### Overall window
- Window size: ~1280 × 800px (resizable)
- Layout: 3-column — sidebar | main content | right panel
- Sidebar width: ~130px, background: `--color-bg-deep`
- Right panel width: ~290px, background: `--color-bg-surface`
- Main content: fills remaining width, background: `--color-bg-surface`

### Sidebar
- Padding: 16px horizontal, 12px top
- Item height: ~32px
- Item padding: 8px horizontal
- Icon size: 20px × 20px, border-radius: 5px
- Gap between icon and label: 8px
- Active item: `--color-white` text
- Bottom section (username): pinned to bottom, padding 16px

### Right panel
- Padding: 16px horizontal, 16px top
- "Start listening" button: full width, height 44px, border-radius 10px
- Divider below button: 1px `--color-divider`, margin-top 16px
- Section header: margin-top 16px, margin-bottom 8px
- Event row: padding 4px 0, flat list (no card)
- Event title: `--color-text-primary`, line-height 1.3
- Event meta: `--color-text-muted`, margin-top 2px
- Divider between date groups: 1px `--color-divider`, margin 12px 0
- Gap between events in same group: 12px

### Main content area
- Padding: 24px horizontal, 20px top
- Section title ("Reminders"): 22px, SemiBold, `--color-white`, margin-bottom 20px
- Task row: padding 10px 0, flex, align-items center
- Task circle: 20px × 20px, border 1.5px `--color-text-muted`, border-radius 50%, margin-right 12px
- Task title: `--color-text-primary`
- Task meta: `--color-text-muted`, margin-top 2px

---

## Component Notes

### "Start listening" button
- Background: `--color-bg-deep`
- Text: `--color-white`, SemiBold
- Border: 1px `--color-divider`
- Border-radius: 10px
- Hover: background lightens slightly toward `--color-bg-surface`

### Date section headers
- All caps, `--color-text-muted`
- Letter-spacing: 0.08em
- No background, no border

### Event rows (right panel)
- Flat — no card, no border
- Disabled state (>10 min away): opacity 0.4, cursor default
- Hover (enabled): subtle `--color-bg-deep` background tint

### Task rows (main content)
- Incomplete: grey stroke circle, transparent fill
- Completed: filled circle with white checkmark

### Dividers
- All dividers use `--color-divider` (i.e. `#8A909B` at 60% opacity)
- 1px height, full width of their container

### Menu bar tray label
- Format: `test e... · in 1h 19m`
- Event name truncated to ~6 chars with ellipsis
- Separator: ` · `
- Relative time: "in 45m", "in 2h 10m", "in 1d"
- Idle (no events): just "cornflake"
- Active recording: green dot + "cornflake"
