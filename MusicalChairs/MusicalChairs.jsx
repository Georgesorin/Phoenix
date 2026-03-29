import { useState, useEffect, useRef, useCallback } from 'react'

const W = 16, H = 32
const TICK_MS    = 80
const MOVE_EVERY = 2
const LAVA_TICKS = Math.round(3500  / TICK_MS)  // 3.5s still → lava death
const WARN_TICKS = Math.round(1800  / TICK_MS)  // 1.8s → blink warning
const RUSH_TICKS = Math.round(4000  / TICK_MS)  // 4s chair rush window
const ELIM_TICKS = Math.round(2500  / TICK_MS)  // show elimination pause
const MUSIC_MIN  = Math.round(7000  / TICK_MS)
const MUSIC_MAX  = Math.round(15000 / TICK_MS)

// ── Player definitions (keyboard-controlled, up to 5) ─────────────────────
const PLAYER_DEFS = [
  { id:'p1', name:'P1', color:'#ff4444', keys:{ up:'w',        down:'s',        left:'a',         right:'d'          } },
  { id:'p2', name:'P2', color:'#44ff44', keys:{ up:'ArrowUp',  down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight'  } },
  { id:'p3', name:'P3', color:'#4488ff', keys:{ up:'i',        down:'k',        left:'j',         right:'l'          } },
  { id:'p4', name:'P4', color:'#ffff44', keys:{ up:'t',        down:'g',        left:'f',         right:'h'          } },
  { id:'p5', name:'P5', color:'#ff44ff', keys:{ up:'8',        down:'2',        left:'4',         right:'6'          } },
]

// Flat key → { id, dir } lookup (built once at module level)
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
  {x:1,  y:1 },   // P1 top-left
  {x:14, y:30},   // P2 bottom-right
  {x:14, y:1 },   // P3 top-right
  {x:1,  y:30},   // P4 bottom-left
  {x:7,  y:15},   // P5 center
]

function placeChairs(count) {
  const cx = 7, cy = 15, rx = 5, ry = 11
  return Array.from({length: count}, (_, i) => {
    const a = (2 * Math.PI * i / count) - Math.PI / 2
    return {
      x: Math.max(1, Math.min(W - 2, Math.round(cx + rx * Math.cos(a)))),
      y: Math.max(1, Math.min(H - 2, Math.round(cy + ry * Math.sin(a)))),
      takenBy: null,
    }
  })
}

function initState() {
  return {
    phase:       'lobby',
    playerCount: 2,
    players:     {},
    chairs:      [],
    hearts:      0,
    winner:      null,
    musicTimer:  0,
    rushTimer:   0,
    elimTimer:   0,
    lavaPulse:   0,
    tick:        0,
  }
}

// ── 8-bit music via Web Audio lookahead scheduler ─────────────────────────
function createMusic() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return { start(){}, stop(){}, close(){} }
  let ctx
  try { ctx = new Ctx() } catch { return { start(){}, stop(){}, close(){} } }

  const BPM = 168, Q = 60 / BPM
  const SEQ = [
    [392,1],[440,1],[392,1],[330,1],
    [294,2],[392,2],
    [440,1],[392,1],[440,1],[494,1],
    [392,4],
    [330,1],[392,1],[440,1],[392,1],
    [294,2],[262,2],
    [330,1],[294,1],[330,1],[392,1],
    [440,4],
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
      gain.gain.linearRampToValueAtTime(0,    t + dur * 0.94)
      osc.start(t); osc.stop(t + dur)
      t += dur
    }
  }

  function schedule() {
    while (nextBarTime < ctx.currentTime + 0.5) {
      scheduleBar(nextBarTime)
      nextBarTime += loopDur
    }
  }

  return {
    start() {
      if (running) return
      running = true
      if (ctx.state === 'suspended') ctx.resume()
      nextBarTime = ctx.currentTime + 0.1
      schedule()
      timerId = setInterval(schedule, 150)
    },
    stop()  { running = false; clearInterval(timerId) },
    close() { this.stop(); try { ctx.close() } catch {} },
  }
}

// ── Component ─────────────────────────────────────────────────────────────
export default function MusicalChairs() {
  const [state, setState] = useState(initState)
  const stateRef = useRef(state); stateRef.current = state
  const keysRef  = useRef({})   // { playerId: Set<dir> }
  const wsRef    = useRef(null)
  const musicRef = useRef(null)
  const triggersRef = useRef([])

  // ── Music side-effects ────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase === 'music') {
      if (musicRef.current) {
        musicRef.current.pause()
        musicRef.current.currentTime = 0
      }
      const track = Math.random() < 0.5 ? '/bruno_uptown.mp3' : '/happy.mp3'
      const audio = new Audio(track)
      audio.loop = true
      audio.volume = 0.7
      audio.play().catch(e => console.log('Audio autoplay blocked', e))
      musicRef.current = audio
    } else {
      if (musicRef.current) {
        musicRef.current.pause()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // ── Keyboard input ────────────────────────────────────────────────────────
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
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup',   onUp)
    }
  }, [])

  // ── WebSocket (display_connect + sim_frame relay only) ────────────────────
  useEffect(() => {
    let ws, alive = true
    const connect = () => {
      if (!alive) return
      try {
        const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3001'
        ws = new WebSocket(wsUrl)
        wsRef.current = ws
        ws.onopen = () => {
          wsRef.current = ws
          try { ws.send(JSON.stringify({ type: 'display_connect' })) } catch {}
        }
        ws.onmessage = e => {
          try {
            const m = JSON.parse(e.data)
            if (m.type === 'sim_triggers') triggersRef.current = m.triggers
          } catch {}
        }
        ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; if (alive) setTimeout(connect, 2000) }
        ws.onerror = () => ws.close()
      } catch {}
    }
    connect()
    return () => { alive = false; ws?.close(); musicRef.current?.close() }
  }, [])

  // ── Sim frame emission (send grid to Python Simulator.py via server) ──────
  useEffect(() => {
    const { phase, players, chairs, lavaPulse, tick } = state
    if (phase === 'lobby') return
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return

    const lavaAlpha = phase === 'music' ? (lavaPulse < 12 ? 0.5 : 1.0) : 0
    const lavaBg = lavaAlpha > 0
      ? `#${Math.round(lavaAlpha * 28).toString(16).padStart(2,'0')}${Math.round(lavaAlpha * 4).toString(16).padStart(2,'0')}00`
      : null
    const chairColor = phase === 'chairrush' ? (tick % 6 < 3 ? '#ffffff' : '#999999') : '#777777'
    const grid = Array.from({length: H}, () => Array(W).fill(lavaBg))

    for (const c of chairs) {
      grid[c.y][c.x] = c.takenBy && players[c.takenBy] ? players[c.takenBy].color : chairColor
    }
    for (const p of Object.values(players)) {
      if (p.eliminated || p.y < 0 || p.y >= H || p.x < 0 || p.x >= W) continue
      const warn = p.stillTimer > WARN_TICKS && phase === 'music'
      if (!warn || tick % 6 < 3) grid[p.y][p.x] = p.color
    }

    try { ws.send(JSON.stringify({ type: 'sim_frame', grid })) } catch {}
  }, [state])

  // ── Start game ────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    const count = stateRef.current.playerCount
    if (count < 2) return
    const defs   = PLAYER_DEFS.slice(0, count)
    const chairs = placeChairs(count - 1)
    const mTimer = MUSIC_MIN + Math.floor(Math.random() * (MUSIC_MAX - MUSIC_MIN))
    const players = {}
    defs.forEach((def, i) => {
      const pos = SPAWN_POS[i % SPAWN_POS.length]
      players[def.id] = { ...def, x: pos.x, y: pos.y, stillTimer: 0, eliminated: false }
    })
    setState(prev => ({
      ...prev, phase: 'music', players, chairs,
      hearts: count, winner: null,
      musicTimer: mTimer, rushTimer: 0, elimTimer: 0, lavaPulse: 0, tick: 0,
    }))
  }, [])

  // ── Play again → back to lobby ────────────────────────────────────────────
  const playAgain = useCallback(() => {
    setState(prev => ({ ...initState(), playerCount: prev.playerCount }))
  }, [])

  // ── Game tick ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setState(prev => {
        if (prev.phase === 'lobby' || prev.phase === 'gameover') return prev
        const tick = prev.tick + 1
        const lavaPulse = (prev.lavaPulse + 1) % 24

        // ── Process Physical Triggers ──
        const activeTrigs = [...(triggersRef.current || [])]
        const physSnap = {}
        for (const [pid, p] of Object.entries(prev.players)) {
          if (p.eliminated || activeTrigs.length === 0) continue
          let bestD = Infinity, bestIdx = -1
          activeTrigs.forEach((t, i) => {
            const d = Math.abs(t.x - p.x) + Math.abs(t.y - p.y)
            if (d < bestD) { bestD = d; bestIdx = i }
          })
          if (bestD < 5 && bestIdx >= 0) {
            physSnap[pid] = activeTrigs[bestIdx]
            activeTrigs.splice(bestIdx, 1)
          }
        }

        // ── Music ───────────────────────────────────────────────────────
        if (prev.phase === 'music') {
          const musicTimer = prev.musicTimer - 1
          const players = {}
          let anyLavaElim = false

          for (const [pid, p] of Object.entries(prev.players)) {
            if (p.eliminated) { players[pid] = p; continue }
            let nx = p.x, ny = p.y
            if (physSnap[pid]) {
              nx = physSnap[pid].x
              ny = physSnap[pid].y
            } else if (tick % MOVE_EVERY === 0) {
              const dirs = keysRef.current[pid] || new Set()
              if (dirs.has('up'))    ny = Math.max(0, ny - 1)
              if (dirs.has('down'))  ny = Math.min(H - 1, ny + 1)
              if (dirs.has('left'))  nx = Math.max(0, nx - 1)
              if (dirs.has('right')) nx = Math.min(W - 1, nx + 1)
            }
            const moved = nx !== p.x || ny !== p.y
            const stillTimer = moved ? 0 : p.stillTimer + 1
            const lavaKill   = stillTimer >= LAVA_TICKS
            if (lavaKill) anyLavaElim = true
            players[pid] = { ...p, x: nx, y: ny, stillTimer, eliminated: lavaKill }
          }

          if (anyLavaElim) {
            const alive = Object.values(players).filter(p => !p.eliminated)
            if (alive.length <= 1) {
              return { ...prev, phase: 'gameover', players, winner: alive[0]?.id ?? null, lavaPulse, tick }
            }
          }

          if (musicTimer <= 0) {
            const alive = Object.values(players).filter(p => !p.eliminated)
            if (alive.length <= 1) {
              return { ...prev, phase: 'gameover', players, winner: alive[0]?.id ?? null, lavaPulse, tick }
            }
            return { ...prev, phase: 'chairrush', players, rushTimer: RUSH_TICKS, lavaPulse, tick }
          }

          return { ...prev, players, musicTimer, lavaPulse, tick }
        }

        // ── Chair Rush ──────────────────────────────────────────────────
        if (prev.phase === 'chairrush') {
          const rushTimer = prev.rushTimer - 1
          const players = {}
          for (const [pid, p] of Object.entries(prev.players)) {
            if (p.eliminated) { players[pid] = p; continue }
            let nx = p.x, ny = p.y
            if (physSnap[pid]) {
              nx = physSnap[pid].x
              ny = physSnap[pid].y
            } else if (tick % MOVE_EVERY === 0) {
              const dirs = keysRef.current[pid] || new Set()
              if (dirs.has('up'))    ny = Math.max(0, ny - 1)
              if (dirs.has('down'))  ny = Math.min(H - 1, ny + 1)
              if (dirs.has('left'))  nx = Math.max(0, nx - 1)
              if (dirs.has('right')) nx = Math.min(W - 1, nx + 1)
            }
            players[pid] = { ...p, x: nx, y: ny }
          }
          const chairs = prev.chairs.map(c => ({...c}))
          for (const p of Object.values(players)) {
            if (p.eliminated) continue
            const ci = chairs.findIndex(c => c.x === p.x && c.y === p.y && c.takenBy === null)
            if (ci >= 0) chairs[ci].takenBy = p.id
          }

          if (rushTimer <= 0) {
            const safe = new Set(chairs.filter(c => c.takenBy).map(c => c.takenBy))
            const updPlayers = {}
            Object.entries(players).forEach(([pid, p]) => {
              updPlayers[pid] = p.eliminated ? p : { ...p, eliminated: !safe.has(pid) }
            })
            const alive = Object.values(updPlayers).filter(p => !p.eliminated)
            if (alive.length <= 1) {
              return { ...prev, phase: 'gameover', players: updPlayers, chairs, winner: alive[0]?.id ?? null, tick }
            }
            return { ...prev, phase: 'elimination', players: updPlayers, chairs, hearts: alive.length, elimTimer: ELIM_TICKS, tick }
          }

          return { ...prev, phase: 'chairrush', players, chairs, rushTimer, lavaPulse, tick }
        }

        // ── Elimination pause → next round ──────────────────────────────
        if (prev.phase === 'elimination') {
          const elimTimer = prev.elimTimer - 1
          if (elimTimer <= 0) {
            const alive = Object.values(prev.players).filter(p => !p.eliminated)
            const newChairs = placeChairs(alive.length - 1)
            const mTimer = MUSIC_MIN + Math.floor(Math.random() * (MUSIC_MAX - MUSIC_MIN))
            const players = {}
            alive.forEach((p, i) => {
              const pos = SPAWN_POS[i % SPAWN_POS.length]
              players[p.id] = { ...p, x: pos.x, y: pos.y, stillTimer: 0 }
            })
            Object.values(prev.players).filter(p => p.eliminated).forEach(p => {
              players[p.id] = p
            })
            return { ...prev, phase: 'music', players, chairs: newChairs, musicTimer: mTimer, elimTimer: 0, lavaPulse: 0, tick }
          }
          return { ...prev, elimTimer, tick }
        }

        return prev
      })
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  const { phase, players, chairs, hearts, winner, musicTimer, rushTimer, elimTimer, lavaPulse, tick, playerCount } = state
  const playerList    = Object.values(players)
  const activePlayers = playerList.filter(p => !p.eliminated)
  const eliminated    = playerList.filter(p => p.eliminated)

  const lavaAlpha = phase === 'music' ? (lavaPulse < 12 ? 0.5 : 1.0) : 0
  const lavaBg    = lavaAlpha > 0
    ? `rgb(${Math.round(lavaAlpha * 28)}, ${Math.round(lavaAlpha * 4)}, 0)`
    : '#0a0a0a'
  const chairColor = phase === 'chairrush' ? (tick % 6 < 3 ? '#ffffff' : '#999999') : '#777777'

  const grid = Array.from({length: H}, () => Array(W).fill(null))
  for (const c of chairs) {
    grid[c.y][c.x] = c.takenBy && players[c.takenBy] ? players[c.takenBy].color : chairColor
  }
  const playerPixels = new Set()
  for (const p of playerList) {
    if (p.eliminated || p.y < 0 || p.y >= H || p.x < 0 || p.x >= W) continue
    const warning = p.stillTimer > WARN_TICKS && phase === 'music'
    const visible  = !warning || tick % 6 < 3
    if (visible) { grid[p.y][p.x] = p.color; playerPixels.add(`${p.x},${p.y}`) }
  }

  const musicSecs = Math.ceil(musicTimer * TICK_MS / 1000)
  const rushSecs  = Math.ceil(rushTimer  * TICK_MS / 1000)
  const elimSecs  = Math.ceil(elimTimer  * TICK_MS / 1000)

  // ── Lobby ──────────────────────────────────────────────────────────────
  if (phase === 'lobby') {
    const activeDefs = PLAYER_DEFS.slice(0, playerCount)
    return (
      <div className="mc-wrap">
        <div className="vote-screen">
          <div className="vote-title">MUSICAL CHAIRS</div>

          <div style={{display:'flex',alignItems:'center',gap:16,color:'#ccc',fontSize:14,letterSpacing:2}}>
            <button className="mc-count-btn"
              onClick={() => setState(p => ({...p, playerCount: Math.max(2, p.playerCount - 1)}))}
            >−</button>
            <span style={{color:'#00ff41',fontSize:22,fontWeight:'bold'}}>{playerCount}</span>
            <span style={{color:'#444'}}>PLAYERS</span>
            <button className="mc-count-btn"
              onClick={() => setState(p => ({...p, playerCount: Math.min(5, p.playerCount + 1)}))}
            >+</button>
          </div>

          <div className="mc-key-table">
            {activeDefs.map(def => (
              <div key={def.id} className="mc-key-row">
                <span className="mc-key-name" style={{color: def.color}}>{def.name}</span>
                <span className="mc-key-keys">
                  {fmtKey(def.keys.up)}&nbsp;
                  {fmtKey(def.keys.down)}&nbsp;
                  {fmtKey(def.keys.left)}&nbsp;
                  {fmtKey(def.keys.right)}
                </span>
              </div>
            ))}
          </div>

          <button className="mc-start-btn ready" onClick={startGame}>
            START GAME
          </button>
          <div className="vote-hints">keyboard controlled · no phones needed</div>
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
          <div className="vote-title" style={{color: winnerPlayer?.color || '#ffff44'}}>
            {winnerPlayer ? `${winnerPlayer.name} WINS!` : 'TIE GAME!'}
          </div>
          <div className="mc-player-list">
            {playerList.map(p => (
              <div key={p.id} className="mc-player-pill"
                style={{
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

  // ── Phase banner ───────────────────────────────────────────────────────
  let banner = null
  if (phase === 'music') {
    banner = (
      <div className="mc-banner music-banner">
        KEEP MOVING — {musicSecs}s &nbsp;<span className="mc-banner-sub">stand still = eliminated</span>
      </div>
    )
  } else if (phase === 'chairrush') {
    banner = <div className="mc-banner rush-banner blink">GRAB A CHAIR — {rushSecs}s</div>
  } else if (phase === 'elimination') {
    const names = eliminated.map(p => p.name).join(', ')
    banner = (
      <div className="mc-banner elim-banner">
        {names} ELIMINATED · next round in {elimSecs}s
      </div>
    )
  }

  // ── Active game screen ─────────────────────────────────────────────────
  return (
    <div className="mc-wrap">
      <div className="mc-hud">
        <div className="mc-hearts">
          {activePlayers.map(p => <span key={p.id} style={{color: p.color}}>♥</span>)}
          {eliminated.map(p => <span key={p.id} style={{color: '#222'}}>♥</span>)}
        </div>
        <div className="mc-players-hud">
          {playerList.map(p => (
            <span key={p.id} className={`mc-pip${p.eliminated ? ' elim' : ''}`}
              style={{color: p.eliminated ? '#333' : p.color}}>
              {p.name}
            </span>
          ))}
        </div>
      </div>

      {banner}

      <div className={`matrix mc-matrix${phase === 'chairrush' ? ' rush-flash' : ''}`}>
        {Array.from({length: H}, (_, y) =>
          Array.from({length: W}, (_, x) => {
            const color    = grid[y][x]
            const isPlayer = playerPixels.has(`${x},${y}`)
            return (
              <div key={`${y}-${x}`} className="pixel" style={{
                background: color || lavaBg,
                boxShadow: isPlayer && color ? `0 0 4px 1px ${color}88` : undefined,
              }} />
            )
          })
        )}
      </div>

      <div className="mc-legend">
        <span style={{color:'#666'}}>■</span> chair &nbsp;·&nbsp;
        {phase === 'music'     && <><span style={{color:'#ff6633'}}>floor is lava</span> · still = eliminated</>}
        {phase === 'chairrush' && <span style={{color:'#fff'}}>rush to a lit chair</span>}
        {phase === 'elimination' && <span style={{color:'#ff8800'}}>checking chairs…</span>}
      </div>
    </div>
  )
}
