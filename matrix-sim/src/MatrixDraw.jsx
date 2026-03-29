import { useState, useCallback, useRef, useEffect } from 'react'

// Hardware dimensions — matches Controller.py: BOARD_WIDTH=16, BOARD_HEIGHT=32
const W = 16  // x: 0–15
const H = 32  // y: 0–31

function makeGrid() {
  return Array.from({ length: H }, () => Array(W).fill(null))
}

// Zig-zag mapping — matches set_led() in Controller.py
function hwIndex(x, y) {
  const channel = Math.floor(y / 4)
  const rowInChannel = y % 4
  const ledIndex = rowInChannel % 2 === 0
    ? rowInChannel * 16 + x
    : rowInChannel * 16 + (15 - x)
  return { channel, ledIndex }
}

const PRESETS = [
  '#ff0000', '#ff7700', '#ffff00', '#00ff00',
  '#00ffff', '#0080ff', '#8000ff', '#ff00ff',
  '#ffffff', '#00ff41',
]

export default function App() {
  const [grid, setGrid] = useState(makeGrid)
  const [activeColor, setActiveColor] = useState('#00ff41')
  const [tool, setTool] = useState('draw')
  const [player, setPlayer] = useState({ x: 8, y: 16 })
  const [showPlayer, setShowPlayer] = useState(true)
  const [showZigzag, setShowZigzag] = useState(false)
  const [hovered, setHovered] = useState(null)
  const isPainting = useRef(false)

  // Keyboard movement — x/y matches hardware coordinate system
  useEffect(() => {
    const onKey = e => {
      if (!showPlayer) return
      const moves = {
        ArrowUp: [0, -1], ArrowDown: [0, 1],
        ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
      }
      const delta = moves[e.key]
      if (!delta) return
      e.preventDefault()
      setPlayer(prev => ({
        x: Math.max(0, Math.min(W - 1, prev.x + delta[0])),
        y: Math.max(0, Math.min(H - 1, prev.y + delta[1])),
      }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showPlayer])

  const paint = useCallback((x, y) => {
    setGrid(prev => {
      const next = prev.map(row => [...row])
      next[y][x] = tool === 'erase' ? null : activeColor
      return next
    })
  }, [activeColor, tool])

  const fill = useCallback((x, y, currentGrid) => {
    const target = currentGrid[y][x]
    const replacement = tool === 'erase' ? null : activeColor
    if (target === replacement) return
    const next = currentGrid.map(row => [...row])
    const stack = [[x, y]]
    while (stack.length) {
      const [cx, cy] = stack.pop()
      if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue
      if (next[cy][cx] !== target) continue
      next[cy][cx] = replacement
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
    }
    setGrid(next)
  }, [activeColor, tool])

  const handleMouseDown = (x, y) => {
    isPainting.current = true
    if (tool === 'fill') fill(x, y, grid)
    else paint(x, y)
  }

  const handleMouseEnter = (x, y) => {
    if (!isPainting.current || tool === 'fill') return
    paint(x, y)
  }

  const handleMouseUp = () => { isPainting.current = false }

  const playerHW = hwIndex(player.x, player.y)
  const hovHW = hovered ? hwIndex(hovered.x, hovered.y) : null

  return (
    <div className="app" onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <header className="toolbar">
        <h1>Matrix <span className="dim">16 × 32</span></h1>

        <div className="tools">
          {[['draw', '✏️'], ['erase', '🧹'], ['fill', '🪣']].map(([t, icon]) => (
            <button
              key={t}
              className={`tool-btn ${tool === t ? 'active' : ''}`}
              onClick={() => setTool(t)}
            >
              {icon} {t}
            </button>
          ))}
        </div>

        <div className="swatches">
          {PRESETS.map(c => (
            <button
              key={c}
              className={`swatch ${activeColor === c && tool !== 'erase' ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => { setActiveColor(c); setTool('draw') }}
            />
          ))}
          <input
            type="color"
            value={activeColor}
            onChange={e => { setActiveColor(e.target.value); setTool('draw') }}
            title="Custom color"
            className="color-picker"
          />
        </div>

        <div className="divider" />

        <button
          className={`tool-btn ${showZigzag ? 'active' : ''}`}
          onClick={() => setShowZigzag(v => !v)}
          title="Highlight mirrored (odd) rows in each channel group"
        >
          〰️ Zig-Zag
        </button>

        <div className="divider" />

        <div className="player-controls">
          <button
            className={`tool-btn ${showPlayer ? 'active' : ''}`}
            onClick={() => setShowPlayer(v => !v)}
          >
            🎮 Player
          </button>
          {showPlayer && (
            <span className="pos-display">
              x<strong>{player.x}</strong> y<strong>{player.y}</strong>
              <span className="hw-info"> ch<strong>{playerHW.channel}</strong> led<strong>{playerHW.ledIndex}</strong></span>
            </span>
          )}
        </div>

        {hovered && (
          <>
            <div className="divider" />
            <span className="pos-display hover-info">
              hover x<strong>{hovered.x}</strong> y<strong>{hovered.y}</strong>
              <span className="hw-info"> ch<strong>{hovHW.channel}</strong> led<strong>{hovHW.ledIndex}</strong></span>
            </span>
          </>
        )}

        <button className="clear-btn" onClick={() => setGrid(makeGrid())}>Clear</button>
      </header>

      <main>
        <div
          className="matrix"
          onDragStart={e => e.preventDefault()}
        >
          {grid.map((row, y) =>
            row.map((color, x) => {
              const isPlayer = showPlayer && player.x === x && player.y === y
              // Zig-zag: odd row within channel group = mirrored wiring
              const isMirroredRow = showZigzag && (y % 4) % 2 === 1
              return (
                <div
                  key={`${y}-${x}`}
                  className={`pixel${isPlayer ? ' player' : ''}${isMirroredRow ? ' zigzag' : ''}`}
                  style={!isPlayer && color ? { background: color } : undefined}
                  onMouseDown={() => handleMouseDown(x, y)}
                  onMouseEnter={() => { handleMouseEnter(x, y); setHovered({ x, y }) }}
                  onMouseLeave={() => setHovered(null)}
                />
              )
            })
          )}
        </div>
        <div className="axis-label x-label">x: 0 → 15</div>
        <div className="axis-label y-label">y: 0 → 31</div>
      </main>
    </div>
  )
}
