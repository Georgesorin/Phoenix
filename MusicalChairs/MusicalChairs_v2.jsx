import { useState, useEffect, useRef, useCallback } from 'react'

const W = 16, H = 32
const TICK_MS    = 80
const MOVE_EVERY = 2
const RUSH_TICKS = Math.round(5000  / TICK_MS)
const ELIM_TICKS = Math.round(2500  / TICK_MS)
const MUSIC_MIN  = Math.round(8000  / TICK_MS)
const MUSIC_MAX  = Math.round(16000 / TICK_MS)
const PLAYER_HP  = 3
const INV_TICKS  = Math.round(1500  / TICK_MS)   // 1.5s invincibility after damage

const UNSAFE_COL     = '#550000'   // red floor
const SAFE_COL       = '#003300'   // dark green path
const SPAWN_COL      = '#00aa00'   // bright green spawn
const CHAIR_COL      = '#888888'   // grey chair
const CHAIR_RUSH_COL = '#ffffff'   // white chair during rush

// ── Player definitions ────────────────────────────────────────────────────────
const PLAYER_DEFS = [
  { id:'p1', name:'P1', color:'#ff4444', keys:{ up:'w',        down:'s',        left:'a',         right:'d'          } },
  { id:'p2', name:'P2', color:'#44ff44', keys:{ up:'ArrowUp',  down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight'  } },
  { id:'p3', name:'P3', color:'#4488ff', keys:{ up:'i',        down:'k',        left:'j',         right:'l'          } },
  { id:'p4', name:'P4', color:'#ffff44', keys:{ up:'t',        down:'g',        left:'f',         right:'h'          } },
  { id:'p5', name:'P5', color:'#ff44ff', keys:{ up:'8',        down:'2',        left:'4',         right:'6'          } },
]

const KEY_MAP = {}
PLAYER_DEFS.forEach(def => {
  Object.entries(def.keys).forEach(([dir, key]) => {
    KEY_MAP[key] = { id: def.id, dir }
    if (key !== key.toLowerCase()) KEY_MAP[key.toLowerCase()] = { id: def.id, dir }
  })
})

function fmtKey(k) {
  const m = { ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→' }
  return m[k] ?? k.toUpperCase()
}

const SPAWN_POS = [
  { x:1,  y:1  },
  { x:14, y:30 },
  { x:14, y:1  },
  { x:1,  y:30 },
  { x:7,  y:15 },
]

// ── Place chairs at random positions ─────────────────────────────────────────
function placeChairsRandom(count, spawns) {
  const chairs   = []
  const occupied = new Set(spawns.map(s => `${s.x},${s.y}`))

  for (let c = 0; c < count; c++) {
    let placed = false
    for (let attempt = 0; attempt < 300; attempt++) {
      const x = 2 + Math.floor(Math.random() * (W - 4))
      const y = 4 + Math.floor(Math.random() * (H - 8))
      const key = `${x},${y}`
      let tooClose = false
      for (const ch of chairs) {
        if (Math.abs(ch.x - x) + Math.abs(ch.y - y) < 5) { tooClose = true; break }
      }
      if (tooClose || occupied.has(key)) continue
      occupied.add(key)
      chairs.push({ x, y, takenBy: null })
      placed = true
      break
    }
    if (!placed) chairs.push({ x: 2 + (c * 4) % (W - 4), y: Math.floor(H / 2) + c * 2, takenBy: null })
  }
  return chairs
}

// ── Generate safe squares: spawn → path → chair border ───────────────────────
function generateSafeSet(chairs, spawns) {
  const safe = new Set()

  // Spawn positions always safe
  for (const s of spawns) safe.add(`${s.x},${s.y}`)

  for (const c of chairs) {
    // Chair cell itself
    safe.add(`${c.x},${c.y}`)

    // Incomplete rectangle border (±2 radius, ~40% of border cells safe)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue  // skip interior
        if (Math.random() < 0.40) {
          const nx = Math.max(0, Math.min(W - 1, c.x + dx))
          const ny = Math.max(0, Math.min(H - 1, c.y + dy))
          safe.add(`${nx},${ny}`)
        }
      }
    }
  }

  // Random winding path from each spawn to the nearest chair
  for (let i = 0; i < spawns.length; i++) {
    const spawn = spawns[i]
    let nearestChair = chairs[0]
    let minDist = Infinity
    for (const c of chairs) {
      const d = Math.abs(c.x - spawn.x) + Math.abs(c.y - spawn.y)
      if (d < minDist) { minDist = d; nearestChair = c }
    }
    if (!nearestChair) continue

    let px = spawn.x, py = spawn.y
    const target = nearestChair
    let steps = 0
    const maxSteps = (W + H) * 4

    while ((Math.abs(px - target.x) + Math.abs(py - target.y)) > 0 && steps < maxSteps) {
      safe.add(`${px},${py}`)
      const dx = target.x - px
      const dy = target.y - py
      const r = Math.random()
      if (r < 0.65) {
        // Move toward target
        if (dx !== 0 && (dy === 0 || Math.random() < 0.5)) {
          px = Math.max(0, Math.min(W - 1, px + Math.sign(dx)))
        } else if (dy !== 0) {
          py = Math.max(0, Math.min(H - 1, py + Math.sign(dy)))
        }
      } else {
        // Random meander
        if (Math.random() < 0.5) px = Math.max(0, Math.min(W - 1, px + (Math.random() < 0.5 ? 1 : -1)))
        else                      py = Math.max(0, Math.min(H - 1, py + (Math.random() < 0.5 ? 1 : -1)))
      }
      steps++
    }
    safe.add(`${target.x},${target.y}`)
  }

  return safe
}

function initState() {
  return {
    phase:       'lobby',
    playerCount: 2,
    players:     {},
    chairs:      [],
    spawnPos:    [],
    winner:      null,
    musicTimer:  0,
    rushTimer:   0,
    elimTimer:   0,
    tick:        0,
  }
}

// ── 8-bit music ───────────────────────────────────────────────────────────────
function createMusic() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return { start(){}, stop(){}, close(){} }
  let ctx
  try { ctx = new Ctx() } catch { return { start(){}, stop(){}, close(){} } }

  const BPM = 168, Q = 60 / BPM
  const SEQ = [
    [392,1],[440,1],[392,1],[330,1],[294,2],[392,2],
    [440,1],[392,1],[440,1],[494,1],[392,4],
    [330,1],[392,1],[440,1],[392,1],[294,2],[262,2],
    [330,1],[294,1],[330,1],[392,1],[440,4],
  ]
  const loopDur = SEQ.reduce((s, [,b]) => s + b * Q, 0)
  let running = false, nextBarTime = 0, timerId = null

  function scheduleBar(t0) {
    let t = t0
    for (const [freq, beats] of SEQ) {
      const dur = beats * Q
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'; osc.frequency.value = freq
      osc.connect(gain); gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0.055, t)
      gain.gain.linearRampToValueAtTime(0.04, t + dur * 0.82)
      gain.gain.linearRampToValueAtTime(0, t + dur * 0.94)
      osc.start(t); osc.stop(t + dur)
      t += dur
    }
  }
  function schedule() {
    while (nextBarTime < ctx.currentTime + 0.5) { scheduleBar(nextBarTime); nextBarTime += loopDur }
  }
  return {
    start() { if (running) return; running = true; if (ctx.state==='suspended') ctx.resume(); nextBarTime = ctx.currentTime + 0.1; schedule(); timerId = setInterval(schedule, 150) },
    stop()  { running = false; clearInterval(timerId) },
    close() { this.stop(); try { ctx.close() } catch {} },
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MusicalChairs() {
  const [state, setState] = useState(initState)
  const stateRef    = useRef(state); stateRef.current = state
  const keysRef     = useRef({})
  const wsRef       = useRef(null)
  const musicRef    = useRef(null)
  const safeSetRef  = useRef(new Set())
  const startGameRef = useRef(null)  // set below, used by WS handler

  // ── Music ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase === 'music') {
      if (musicRef.current) musicRef.current.close()
      musicRef.current = createMusic()
      musicRef.current.start()
    } else {
      musicRef.current?.stop()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // ── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const prevented = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])
    const onDown = e => {
      const mapped = KEY_MAP[e.key] ?? KEY_MAP[e.key.toLowerCase()]
      if (!mapped) return
      if (prevented.has(e.key)) e.preventDefault()
      if (!keysRef.current[mapped.id]) keysRef.current[mapped.id] = new Set()
      keysRef.current[mapped.id].add(mapped.dir)
    }
    const onUp = e => {
      const mapped = KEY_MAP[e.key] ?? KEY_MAP[e.key.toLowerCase()]
      if (!mapped) return
      keysRef.current[mapped.id]?.delete(mapped.dir)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup',   onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [])

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let ws, alive = true
    const connect = () => {
      if (!alive) return
      try {
        const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3001'
        ws = new WebSocket(wsUrl)
        wsRef.current = ws
        ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'display_connect' })) } catch {} }
        ws.onmessage = e => {
          try {
            const m = JSON.parse(e.data)
            if (m.type === 'mc_start') startGameRef.current?.(m.count)
          } catch {}
        }
        ws.onclose = () => { wsRef.current = null; if (alive) setTimeout(connect, 2000) }
        ws.onerror = () => ws.close()
      } catch {}
    }
    connect()
    return () => { alive = false; ws?.close(); musicRef.current?.close() }
  }, [])

  // ── Sim frame ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const { phase, players, chairs, spawnPos, tick } = state
    if (phase === 'lobby') return
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return

    const safe = safeSetRef.current
    const grid = Array.from({ length: H }, () => Array(W).fill(UNSAFE_COL))

    // Safe path
    for (const key of safe) {
      const [x, y] = key.split(',').map(Number)
      grid[y][x] = SAFE_COL
    }
    // Spawn positions (brighter)
    for (const s of spawnPos) {
      if (s.y >= 0 && s.y < H && s.x >= 0 && s.x < W) grid[s.y][s.x] = SPAWN_COL
    }
    // Chairs
    const cCol = phase === 'chairrush' ? (tick % 6 < 3 ? CHAIR_RUSH_COL : '#999999') : CHAIR_COL
    for (const c of chairs) {
      grid[c.y][c.x] = c.takenBy && players[c.takenBy] ? players[c.takenBy].color : cCol
    }
    // Players (blink when invincible)
    for (const p of Object.values(players)) {
      if (p.eliminated || p.y < 0 || p.y >= H || p.x < 0 || p.x >= W) continue
      if (p.invTicks > 0 && tick % 4 < 2) continue
      grid[p.y][p.x] = p.color
    }

    try { ws.send(JSON.stringify({ type: 'sim_frame', grid })) } catch {}
  }, [state])

  // ── Start game (also callable with explicit count from phone host) ──────────
  const startGame = useCallback((countOverride) => {
    const count = typeof countOverride === 'number' ? Math.min(5, Math.max(2, countOverride)) : stateRef.current.playerCount
    if (count < 2) return
    const defs   = PLAYER_DEFS.slice(0, count)
    const spawns = SPAWN_POS.slice(0, count)
    const chairs = placeChairsRandom(count - 1, spawns)
    safeSetRef.current = generateSafeSet(chairs, spawns)

    const mTimer = MUSIC_MIN + Math.floor(Math.random() * (MUSIC_MAX - MUSIC_MIN))
    const players = {}
    defs.forEach((def, i) => {
      const pos = spawns[i]
      players[def.id] = { ...def, x: pos.x, y: pos.y, hp: PLAYER_HP, invTicks: 0, eliminated: false }
    })
    setState(prev => ({
      ...prev, phase: 'music', playerCount: count, players, chairs, spawnPos: spawns,
      winner: null, musicTimer: mTimer, rushTimer: 0, elimTimer: 0, tick: 0,
    }))
  }, [])
  startGameRef.current = startGame  // keep ref in sync

  const playAgain = useCallback(() => {
    setState(prev => ({ ...initState(), playerCount: prev.playerCount }))
  }, [])

  // ── Game tick ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setState(prev => {
        if (prev.phase === 'lobby' || prev.phase === 'gameover') return prev
        const tick = prev.tick + 1
        const safe = safeSetRef.current

        function moveAndDamage(p) {
          if (p.eliminated) return p
          let nx = p.x, ny = p.y
          if (tick % MOVE_EVERY === 0) {
            const dirs = keysRef.current[p.id] || new Set()
            if (dirs.has('up'))    ny = Math.max(0, ny - 1)
            if (dirs.has('down'))  ny = Math.min(H - 1, ny + 1)
            if (dirs.has('left'))  nx = Math.max(0, nx - 1)
            if (dirs.has('right')) nx = Math.min(W - 1, nx + 1)
          }
          let { hp, invTicks } = p
          invTicks = Math.max(0, invTicks - 1)
          const moved = nx !== p.x || ny !== p.y
          if (moved && !safe.has(`${nx},${ny}`) && invTicks === 0) {
            hp -= 1
            invTicks = INV_TICKS
          }
          return { ...p, x: nx, y: ny, hp, invTicks, eliminated: hp <= 0 }
        }

        // ── Music ──────────────────────────────────────────────────────────
        if (prev.phase === 'music') {
          const musicTimer = prev.musicTimer - 1
          const players = {}
          for (const [pid, p] of Object.entries(prev.players)) players[pid] = moveAndDamage(p)

          const alive = Object.values(players).filter(p => !p.eliminated)
          if (alive.length <= 1) return { ...prev, phase: 'gameover', players, winner: alive[0]?.id ?? null, tick }
          if (musicTimer <= 0)   return { ...prev, phase: 'chairrush', players, rushTimer: RUSH_TICKS, musicTimer: 0, tick }
          return { ...prev, players, musicTimer, tick }
        }

        // ── Chair Rush ─────────────────────────────────────────────────────
        if (prev.phase === 'chairrush') {
          const rushTimer = prev.rushTimer - 1
          const players = {}
          for (const [pid, p] of Object.entries(prev.players)) players[pid] = moveAndDamage(p)

          const chairs = prev.chairs.map(c => ({ ...c }))
          for (const p of Object.values(players)) {
            if (p.eliminated) continue
            const ci = chairs.findIndex(c => c.x === p.x && c.y === p.y && c.takenBy === null)
            if (ci >= 0) chairs[ci].takenBy = p.id
          }

          if (rushTimer <= 0) {
            const seated = new Set(chairs.filter(c => c.takenBy).map(c => c.takenBy))
            const updPlayers = {}
            for (const [pid, p] of Object.entries(players)) {
              updPlayers[pid] = p.eliminated ? p : { ...p, eliminated: !seated.has(pid) }
            }
            const alive = Object.values(updPlayers).filter(p => !p.eliminated)
            if (alive.length <= 1) return { ...prev, phase: 'gameover', players: updPlayers, chairs, winner: alive[0]?.id ?? null, tick }
            return { ...prev, phase: 'elimination', players: updPlayers, chairs, elimTimer: ELIM_TICKS, tick }
          }

          const alive = Object.values(players).filter(p => !p.eliminated)
          if (alive.length <= 1) return { ...prev, phase: 'gameover', players, chairs, winner: alive[0]?.id ?? null, tick }
          return { ...prev, phase: 'chairrush', players, chairs, rushTimer, tick }
        }

        // ── Elimination pause → next round ─────────────────────────────────
        if (prev.phase === 'elimination') {
          const elimTimer = prev.elimTimer - 1
          if (elimTimer <= 0) {
            const alive = Object.values(prev.players).filter(p => !p.eliminated)
            const spawns = SPAWN_POS.slice(0, alive.length)
            const newChairs = placeChairsRandom(alive.length - 1, spawns)
            safeSetRef.current = generateSafeSet(newChairs, spawns)
            const mTimer = MUSIC_MIN + Math.floor(Math.random() * (MUSIC_MAX - MUSIC_MIN))
            const players = {}
            alive.forEach((p, i) => {
              const pos = spawns[i]
              players[p.id] = { ...p, x: pos.x, y: pos.y, hp: PLAYER_HP, invTicks: 0 }
            })
            Object.values(prev.players).filter(p => p.eliminated).forEach(p => { players[p.id] = p })
            return { ...prev, phase: 'music', players, chairs: newChairs, spawnPos: spawns, musicTimer: mTimer, elimTimer: 0, tick }
          }
          return { ...prev, elimTimer, tick }
        }

        return prev
      })
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  const { phase, players, chairs, spawnPos, winner, musicTimer, rushTimer, elimTimer, tick, playerCount } = state
  const playerList    = Object.values(players)
  const activePlayers = playerList.filter(p => !p.eliminated)
  const eliminated    = playerList.filter(p => p.eliminated)

  // ── Lobby ──────────────────────────────────────────────────────────────
  if (phase === 'lobby') {
    const activeDefs = PLAYER_DEFS.slice(0, playerCount)
    return (
      <div className="mc-wrap">
        <div className="vote-screen">
          <div className="vote-title">MUSICAL CHAIRS</div>
          <div style={{ display:'flex', alignItems:'center', gap:16, color:'#ccc', fontSize:14, letterSpacing:2 }}>
            <button className="mc-count-btn" onClick={() => setState(p => ({ ...p, playerCount: Math.max(2, p.playerCount - 1) }))}>−</button>
            <span style={{ color:'#00ff41', fontSize:22, fontWeight:'bold' }}>{playerCount}</span>
            <span style={{ color:'#444' }}>PLAYERS</span>
            <button className="mc-count-btn" onClick={() => setState(p => ({ ...p, playerCount: Math.min(5, p.playerCount + 1) }))}>+</button>
          </div>
          <div className="mc-key-table">
            {activeDefs.map(def => (
              <div key={def.id} className="mc-key-row">
                <span className="mc-key-name" style={{ color: def.color }}>{def.name}</span>
                <span className="mc-key-keys">
                  {fmtKey(def.keys.up)}&nbsp;{fmtKey(def.keys.down)}&nbsp;{fmtKey(def.keys.left)}&nbsp;{fmtKey(def.keys.right)}
                </span>
              </div>
            ))}
          </div>
          <button className="mc-start-btn ready" onClick={startGame}>START GAME</button>
          <div className="vote-hints">avoid red floor · follow the green path · grab a chair</div>
        </div>
      </div>
    )
  }

  // ── Game Over ──────────────────────────────────────────────────────────
  if (phase === 'gameover') {
    const winnerPlayer = winner ? players[winner] : null
    return (
      <div className="mc-wrap">
        <div className="vote-screen">
          <div className="vote-title" style={{ color: winnerPlayer?.color || '#ffff44' }}>
            {winnerPlayer ? `${winnerPlayer.name} WINS!` : 'TIE GAME!'}
          </div>
          <div className="mc-player-list">
            {playerList.map(p => (
              <div key={p.id} className="mc-player-pill" style={{
                background: p.color + (p.id === winner ? '33' : '0a'),
                borderColor: p.id === winner ? p.color : '#222',
                color: p.id === winner ? p.color : '#444',
              }}>
                {p.id === winner ? '★ ' : ''}{p.name}
              </div>
            ))}
          </div>
          <button className="mc-start-btn ready" onClick={playAgain}>PLAY AGAIN</button>
        </div>
      </div>
    )
  }

  // ── Build render grid ─────────────────────────────────────────────────
  const safe = safeSetRef.current
  const grid = Array.from({ length: H }, () => Array(W).fill(null))
  // Unsafe floor
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grid[y][x] = UNSAFE_COL
  // Safe path
  for (const key of safe) { const [x, y] = key.split(',').map(Number); grid[y][x] = SAFE_COL }
  // Spawn
  for (const s of spawnPos) { if (s.y >= 0 && s.y < H && s.x >= 0 && s.x < W) grid[s.y][s.x] = SPAWN_COL }
  // Chairs
  const cCol = phase === 'chairrush' ? (tick % 6 < 3 ? CHAIR_RUSH_COL : '#999999') : CHAIR_COL
  for (const c of chairs) grid[c.y][c.x] = c.takenBy && players[c.takenBy] ? players[c.takenBy].color : cCol
  // Players
  const playerPixels = new Set()
  for (const p of playerList) {
    if (p.eliminated || p.y < 0 || p.y >= H || p.x < 0 || p.x >= W) continue
    if (p.invTicks > 0 && tick % 4 < 2) continue
    grid[p.y][p.x] = p.color
    playerPixels.add(`${p.x},${p.y}`)
  }

  // ── Banner ────────────────────────────────────────────────────────────
  const musicSecs = Math.ceil(musicTimer * TICK_MS / 1000)
  const rushSecs  = Math.ceil(rushTimer  * TICK_MS / 1000)
  const elimSecs  = Math.ceil(elimTimer  * TICK_MS / 1000)
  let banner = null
  if (phase === 'music') {
    banner = <div className="mc-banner music-banner">MUSIC PLAYING — {musicSecs}s &nbsp;<span className="mc-banner-sub">red floor = lose a heart</span></div>
  } else if (phase === 'chairrush') {
    banner = <div className="mc-banner rush-banner blink">GRAB A CHAIR — {rushSecs}s</div>
  } else if (phase === 'elimination') {
    const names = eliminated.map(p => p.name).join(', ')
    banner = <div className="mc-banner elim-banner">{names} ELIMINATED · next round in {elimSecs}s</div>
  }

  return (
    <div className="mc-wrap">
      <div className="mc-hud">
        <div className="mc-players-hud">
          {playerList.map(p => (
            <span key={p.id} style={{ display:'inline-flex', alignItems:'center', gap:2, marginRight:8, opacity: p.eliminated ? 0.3 : 1 }}>
              <span style={{ color: p.color, fontSize:11 }}>{p.name}</span>
              {Array.from({ length: PLAYER_HP }, (_, i) => (
                <span key={i} style={{ color: i < p.hp ? p.color : '#333', fontSize:10 }}>♥</span>
              ))}
            </span>
          ))}
        </div>
      </div>

      {banner}

      <div className={`matrix mc-matrix${phase === 'chairrush' ? ' rush-flash' : ''}`}>
        {Array.from({ length: H }, (_, y) =>
          Array.from({ length: W }, (_, x) => {
            const color    = grid[y][x]
            const isPlayer = playerPixels.has(`${x},${y}`)
            return (
              <div key={`${y}-${x}`} className="pixel" style={{
                background: color,
                boxShadow: isPlayer && color ? `0 0 4px 1px ${color}88` : undefined,
              }} />
            )
          })
        )}
      </div>

      <div className="mc-legend">
        <span style={{ color: SPAWN_COL }}>■</span> start &nbsp;·&nbsp;
        <span style={{ color: SAFE_COL }}>■</span> safe path &nbsp;·&nbsp;
        <span style={{ color: CHAIR_COL }}>■</span> chair &nbsp;·&nbsp;
        <span style={{ color: UNSAFE_COL }}>■</span> danger
      </div>
    </div>
  )
}
