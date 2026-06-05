import React, { useEffect, useRef, useState } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'
import { select } from 'd3-selection'
import { zoom, type D3ZoomEvent } from 'd3-zoom'
import { useGetAllDecisions } from '../../hooks/useIPC'

interface DecisionsGraphProps {
  onDecisionSelect: (id: string) => void
  onBack: () => void
  dataVersion?: number
}

// A graph node is a single decision in the cluster. d3-force mutates x/y/vx/vy
// in place during the simulation tick.
interface GraphNode extends SimulationNodeDatum {
  id: string
  text: string
  confidence: 'high' | 'medium' | 'low' | null
}

// Edges are parent → child decision links. d3-force resolves the source/target
// strings to GraphNode refs before the first tick.
type GraphLink = SimulationLinkDatum<GraphNode>

// Node color = confidence. Greys out low so the eye lands on real decisions
// first; mirrors the list view's dimming.
function colorForConfidence(c: GraphNode['confidence']): string {
  if (c === 'high')   return '#A78BFA'   // violet — matches sidebar icon
  if (c === 'medium') return '#7C6CB5'
  if (c === 'low')    return '#4B4570'
  return '#7C6CB5'                       // unknown defaults to medium tone
}

// Radius shrinks for low-confidence so high ones pop visually.
function radiusForConfidence(c: GraphNode['confidence']): number {
  if (c === 'high')   return 7
  if (c === 'medium') return 6
  if (c === 'low')    return 4
  return 6
}

export default function DecisionsGraph({ onDecisionSelect, onBack, dataVersion }: DecisionsGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)
  const simRef       = useRef<Simulation<GraphNode, GraphLink> | null>(null)

  const [loading, setLoading]     = useState(true)
  const [count, setCount]         = useState(0)
  const [hovered, setHovered]     = useState<GraphNode | null>(null)
  // Cursor position for the hover tooltip — tracked in container-space so the
  // tooltip stays glued to the cursor while the user moves around the canvas.
  const [cursor, setCursor]       = useState<{ x: number; y: number } | null>(null)

  const getAllDecisions = useGetAllDecisions()

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void (async () => {
      const decisions = await getAllDecisions()
      if (cancelled) return

      const svg = svgRef.current
      const container = containerRef.current
      if (!svg || !container) return

      const rect = container.getBoundingClientRect()
      const width  = rect.width  || 800
      const height = rect.height || 600

      // Build node/edge model. Edges go child→parent so the parent gravitates
      // toward the cluster center; the visual is equivalent either way.
      const nodes: GraphNode[] = decisions.map(d => ({
        id: d.id, text: d.text, confidence: d.extractionConfidence,
      }))
      const links: GraphLink[] = decisions
        .filter(d => d.parentDecisionId)
        .map(d => ({ source: d.id, target: d.parentDecisionId! }))

      setCount(nodes.length)

      // Clear previous render. d3 wrappers around the same nodes set are fine
      // but when decisions count changes we want a fresh layout.
      svg.innerHTML = ''
      const root = select(svg)
        .attr('width', width)
        .attr('height', height)
        .attr('viewBox', `0 0 ${width} ${height}`)

      // Single <g> we apply pan/zoom transforms to. Everything else nests
      // inside so a transform on this element affects nodes + edges together.
      const viewport = root.append('g')

      // Lines first so circles render on top of them.
      const linkSel = viewport.append('g')
        .attr('stroke', 'rgba(255,255,255,0.18)')
        .attr('stroke-width', 1)
        .selectAll('line')
        .data(links)
        .join('line')

      const nodeSel = viewport.append('g')
        .selectAll<SVGCircleElement, GraphNode>('circle')
        .data(nodes)
        .join('circle')
        .attr('r',    d => radiusForConfidence(d.confidence))
        .attr('fill', d => colorForConfidence(d.confidence))
        .attr('stroke', 'rgba(255,255,255,0.4)')
        .attr('stroke-width', 0.5)
        .style('cursor', 'pointer')

      // Hover: track the focused node so the tooltip can render React-side
      // (clean styling, no fiddling with foreignObject).
      nodeSel
        .on('mouseenter', (_e, d) => setHovered(d))
        .on('mouseleave', () => setHovered(null))
        .on('click', (_e, d) => onDecisionSelect(d.id))

      // Pan + zoom on the SVG dispatches to the viewport <g>'s transform.
      const z = zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 4])
        .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
          viewport.attr('transform', event.transform.toString())
        })
      root.call(z)

      // Force simulation. Charge negative = repulsion; collide = no overlap;
      // link length controls visual spacing between parent and child.
      const sim = forceSimulation<GraphNode>(nodes)
        .force('charge',  forceManyBody().strength(-60))
        .force('center',  forceCenter(width / 2, height / 2))
        .force('collide', forceCollide<GraphNode>().radius(d => radiusForConfidence(d.confidence) + 4))
        .force('link',    forceLink<GraphNode, GraphLink>(links).id(d => d.id).distance(60).strength(0.5))
        .on('tick', () => {
          linkSel
            .attr('x1', d => (d.source as GraphNode).x ?? 0)
            .attr('y1', d => (d.source as GraphNode).y ?? 0)
            .attr('x2', d => (d.target as GraphNode).x ?? 0)
            .attr('y2', d => (d.target as GraphNode).y ?? 0)
          nodeSel
            .attr('cx', d => d.x ?? 0)
            .attr('cy', d => d.y ?? 0)
        })

      simRef.current = sim
      setLoading(false)
    })()

    return () => {
      cancelled = true
      simRef.current?.stop()
      simRef.current = null
    }
  }, [dataVersion, getAllDecisions, onDecisionSelect])

  // Stop the simulation after the layout settles so it doesn't keep burning
  // CPU. A 5-second cap is plenty for graphs up to a few hundred nodes.
  useEffect(() => {
    const t = setTimeout(() => simRef.current?.stop(), 5000)
    return () => clearTimeout(t)
  }, [count])

  return (
    <main style={{
      flex: 1,
      backgroundColor: 'var(--color-bg-surface)',
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Titlebar drag region */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        height: 28,
        WebkitAppRegion: 'drag',
        zIndex: 2,
      } as React.CSSProperties} />

      {/* Back — wrapped in a non-pointer-events container with the button itself
          re-enabling clicks, so the title block below can stay pointer-events:none
          while remaining a sibling. */}
      <button
        onClick={onBack}
        style={{
          position: 'absolute', top: 36, left: 24,
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-muted)', fontSize: 13,
          padding: 0, fontFamily: 'inherit',
          zIndex: 2,
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
      >
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
          <path d="M6 1L1 6L6 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Reminders
      </button>

      <div style={{
        position: 'absolute', top: 64, left: 24,
        fontSize: 22, fontWeight: 600, color: 'var(--color-white)',
        zIndex: 1, pointerEvents: 'none',
      }}>
        Decisions
        <div style={{
          fontSize: 12, fontWeight: 400, color: 'var(--color-text-muted)',
          marginTop: 2,
        }}>
          {loading ? 'Loading…' : `${count} decision${count === 1 ? '' : 's'} · scroll to zoom, drag to pan`}
        </div>
      </div>

      {!loading && count === 0 && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--color-text-muted)', fontSize: 13,
        }}>
          No decisions yet. They&rsquo;ll appear here as meetings produce them.
        </div>
      )}

      <div
        ref={containerRef}
        onMouseMove={e => {
          const rect = containerRef.current?.getBoundingClientRect()
          if (rect) setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <svg ref={svgRef} style={{ display: 'block', width: '100%', height: '100%' }} />

        {hovered && cursor && (
          <div style={{
            position: 'absolute',
            left: cursor.x + 12,
            top:  cursor.y + 12,
            maxWidth: 280,
            padding: '6px 10px',
            backgroundColor: 'var(--color-bg-deep)',
            border: '1px solid var(--color-divider)',
            borderRadius: 6,
            fontSize: 12, lineHeight: 1.4,
            color: 'var(--color-text-primary)',
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            zIndex: 3,
          }}>
            {hovered.text}
          </div>
        )}
      </div>
    </main>
  )
}
