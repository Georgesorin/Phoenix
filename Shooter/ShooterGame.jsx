import { useState, useEffect, useRef, useCallback } from 'react'

const W = 16, H = 32
const MAX_HP       = 3
const TICK_MS      = 80
const AMMO_MAX     = 16
const SHOOT_CD     = Math.round(1000 / TICK_MS)
const RELOAD_TICKS = Math.round(2500 / TICK_MS)
const INV_TICKS    = 6
const MOVE_EVERY   = 2
const MAX_OBS      = 8
const OBS_SPAWN_T  = Math.round(2000 / TICK_MS)
const MAX_BOUNCES  = 3
const KNIFE_RANGE  = 1
const KNIFE_CD     = Math.round(500  / TICK_MS)
const SAFE_TICKS   = Math.round(5000 / TICK_MS)
const COVER_TICKS  = Math.round(3000 / TICK_MS)
const VOTE_TICKS   = Math.round(10000 / TICK_MS)  // 10 s

const MAPS = [
  {
    id:'desert',  name:'OLD DESERT',   desc:'Sandy ruins',
    bgColor:'#1f1200',
    obsColor:{ 3:'#005500', 2:'#008800', 1:'#00bb00' },   // green barricades
    trapColor:'#ff6600',                                   // orange traps
  },
  {
    id:'haunted', name:'HAUNTED HOUSE', desc:'Dark corridors',
    bgColor:'#000000',
    obsColor:{ 3:'#cc4400', 2:'#ee5500', 1:'#ff8800' },   // orange barricades
    trapColor:'#ffee00',                                   // yellow traps
  },
  {
    id:'battle',  name:'BATTLEFIELD',  desc:'Green trenches',
    bgColor:'#001400',
    obsColor:{ 3:'#888888', 2:'#bbbbbb', 1:'#ffffff' },   // white barricades
    trapColor:'#ffee00',                                   // yellow traps
  },
]

// Fixed team colors — Blue = team 1 (P1), Red = team 2 (P2)
const C1 = '#00ccff'
const C2 = '#ff3333'

const P1K = { up:'ArrowUp', dn:'ArrowDown', lt:'ArrowLeft', rt:'ArrowRight', sh:'Space', kn:'KeyE' }
const P2K = { up:'KeyW',    dn:'KeyS',      lt:'KeyA',      rt:'KeyD',       sh:'KeyF',  kn:'KeyR' }

// ── Helpers ───────────────────────────────────────────────────────────────────
function initTraps() {
  const out = [], used = new Set()
  for (let i = 0; i < 3; i++) {
    for (let t = 0; t < 40; t++) {
      const x = Math.floor(Math.random() * W)
      const y = 7 + Math.floor(Math.random() * (H - 14))
      const k = `${x},${y}`
      if (used.has(k) || y > 25 || y < 6) continue
      used.add(k); out.push({ x, y }); break
    }
  }
  return out
}

function trySpawnObs(obstacles, p1, p2) {
  const used = new Set(obstacles.map(o => `${o.x},${o.y}`))
  for (let t = 0; t < 30; t++) {
    const x = Math.floor(Math.random() * W)
    const y = 5 + Math.floor(Math.random() * (H - 10))
    if (used.has(`${x},${y}`)) continue
    if (Math.max(Math.abs(x-p1.x), Math.abs(y-p1.y)) < 4) continue
    if (Math.max(Math.abs(x-p2.x), Math.abs(y-p2.y)) < 4) continue
    return { x, y, hp: 3 }
  }
  return null
}

function startPlaying(prev, mapIdx) {
  return {
    ...prev,
    phase:         'playing',
    map:           MAPS[mapIdx ?? 0],
    voteCountdown: 0,
    p1:        { x:4,  y:28, hp:MAX_HP, inv:0, ammo:AMMO_MAX, reload:0, coverTimer:0, knifeAnim:0 },
    p2:        { x:11, y:3,  hp:MAX_HP, inv:0, ammo:AMMO_MAX, reload:0, coverTimer:0, knifeAnim:0 },
    bullets:   [],
    obstacles: [],
    traps:     initTraps(),
    safeTimer: 0,
    spawnT:    0,
    winner:    null,
    tick:      0,
  }
}

function initState() {
  return {
    phase:      'lobby',
    ready:      { p1: false, p2: false },
    teamCounts: { p1: 0, p2: 0 },
    map:           MAPS[0],
    voteCountdown: VOTE_TICKS,
    p1: { x:4,  y:28, hp:MAX_HP, inv:0, ammo:AMMO_MAX, reload:0, coverTimer:0, knifeAnim:0 },
    p2: { x:11, y:3,  hp:MAX_HP, inv:0, ammo:AMMO_MAX, reload:0, coverTimer:0, knifeAnim:0 },
    bullets:   [],
    obstacles: [],
    traps:     initTraps(),
    safeTimer: 0,
    spawnT:    0,
    winner:    null,
    tick:      0,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ShooterGame() {
  const [state, setState] = useState(initState)
  const stateRef = useRef(state); stateRef.current = state
  const keysRef  = useRef(new Set())
  const cd       = useRef({ p1:0, p2:0, p1k:0, p2k:0 })
  const wsRef    = useRef(null)
  const musicRef = useRef(null)
  const pendingMove = useRef({ p1: null, p2: null })

  // ── Music ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase === 'playing') {
      if (musicRef.current) {
        musicRef.current.pause()
        musicRef.current.currentTime = 0
      }
      const audio = new Audio('/shooter.mp3')
      audio.loop = true
      audio.volume = 0.6
      audio.play().catch(e => console.log('Audio autoplay blocked', e))
      musicRef.current = audio
    } else {
      if (musicRef.current) {
        musicRef.current.pause()
      }
    }
  }, [state.phase])

  // ── Notify server when game ends ──────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'gameover') return
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return
    try { ws.send(JSON.stringify({ type: 'game_over', winner: state.winner })) } catch {}
  }, [state.phase, state.winner])

  // ── Knife ──────────────────────────────────────────────────────────────────
  const tryKnife = useCallback((owner) => {
    const s = stateRef.current
    if (s.phase !== 'playing' || s.safeTimer > 0) return
    const cdk = owner === 1 ? 'p1k' : 'p2k'
    if (cd.current[cdk] > 0) return
    setState(prev => {
      if (prev.phase !== 'playing' || prev.safeTimer > 0) return prev
      const atk = owner===1 ? prev.p1 : prev.p2
      const def = owner===1 ? prev.p2 : prev.p1
      if (Math.max(Math.abs(atk.x-def.x), Math.abs(atk.y-def.y)) > KNIFE_RANGE) return prev
      if (def.inv > 0) return prev
      cd.current[cdk] = KNIFE_CD
      const newHp  = Math.max(0, def.hp-1)
      const defUpd = { ...def, hp:newHp, inv:INV_TICKS, coverTimer:0 }
      const atkUpd = { ...atk, knifeAnim:6 }
      let phase='playing', winner=null
      if (newHp<=0) { phase='gameover'; winner=owner }
      const safe = (newHp>0 && atk.hp>0) ? SAFE_TICKS : 0
      return { ...prev, p1:owner===1?atkUpd:defUpd, p2:owner===2?atkUpd:defUpd, safeTimer:safe, phase, winner }
    })
  }, [])

  // ── Shoot ──────────────────────────────────────────────────────────────────
  const tryShoot = useCallback((owner, forceDx=null, forceDy=null) => {
    const s = stateRef.current
    if (s.phase !== 'playing' || s.safeTimer > 0) return
    const cdk = owner===1 ? 'p1' : 'p2'
    if (cd.current[cdk] > 0) return
    setState(prev => {
      if (prev.phase !== 'playing' || prev.safeTimer > 0) return prev
      const pp = owner===1 ? prev.p1 : prev.p2
      if (pp.reload>0 || pp.ammo<=0) return prev
      cd.current[cdk] = SHOOT_CD
      const keys=keysRef.current, lk=owner===1?P1K:P2K
      const dx = forceDx!==null ? forceDx : keys.has(lk.lt)?-1:keys.has(lk.rt)?1:0
      const dy = forceDy!==null ? forceDy : keys.has(lk.up)?-1:keys.has(lk.dn)?1:(owner===1?-1:1)
      if (dx===0 && dy===0) return prev
      const newAmmo = pp.ammo-1
      const updated = { ...pp, ammo:newAmmo, reload:newAmmo===0?RELOAD_TICKS:0 }
      const bx=pp.x+dx, by=pp.y+dy
      const oob     = bx<0||bx>=W||by<0||by>=H
      const blocked = prev.obstacles.some(o=>o.x===bx&&o.y===by)
      const bullets = oob||blocked ? prev.bullets
        : [...prev.bullets, { x:bx, y:by, dx, dy, owner, bounces:0 }]
      return owner===1 ? { ...prev, p1:updated, bullets } : { ...prev, p2:updated, bullets }
    })
  }, [])

  // ── Keyboard (game controls only) ─────────────────────────────────────────
  const processKey = useCallback((code, down) => {
    const phase = stateRef.current.phase
    if (phase === 'lobby' || phase === 'vote') return
    if (down) {
      if (keysRef.current.has(code)) return
      keysRef.current.add(code)
      if (code===P1K.sh) tryShoot(1)
      if (code===P2K.sh) tryShoot(2)
      if (code===P1K.kn) tryKnife(1)
      if (code===P2K.kn) tryKnife(2)
    } else {
      keysRef.current.delete(code)
    }
  }, [tryShoot, tryKnife])

  useEffect(() => {
    const prev = new Set(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'])
    const d = e => { if (prev.has(e.code)) e.preventDefault(); processKey(e.code, true) }
    const u = e => processKey(e.code, false)
    window.addEventListener('keydown', d)
    window.addEventListener('keyup',   u)
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u) }
  }, [processKey])

  // ── WebSocket relay ────────────────────────────────────────────────────────
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
            if (m.type === 'game_phase') {
              if (m.phase === 'lobby') {
                setState(prev => ({
                  ...initState(),
                  teamCounts: m.counts
                    ? { p1: m.counts.p1, p2: m.counts.p2 }
                    : prev.teamCounts,
                  ready: m.ready
                    ? { p1: m.ready.p1, p2: m.ready.p2 }
                    : { p1: false, p2: false },
                }))
              } else if (m.phase === 'vote') {
                setState(prev => ({
                  ...prev,
                  phase:         'vote',
                  voteCountdown: VOTE_TICKS,
                }))
              } else if (m.phase === 'playing') {
                setState(prev => startPlaying(prev, m.mapIdx))
              }
            } else if (m.type === 'shoot') {
              tryShoot(m.player, m.dx, m.dy)
              // Also queue movement so phone controls move the player on display
              const which = m.player === 1 ? 'p1' : 'p2'
              if (typeof m.dx === 'number' && typeof m.dy === 'number') {
                pendingMove.current[which] = { dx: m.dx, dy: m.dy }
              }
            } else if (m.type === 'knife') {
              tryKnife(m.player)
            } else if (m.type === 'keydown' || m.type === 'keyup') {
              processKey(m.code, m.type==='keydown')
            } else if (m.type === 'player_joined') {
              setState(prev => {
                const key = m.player === 1 ? 'p1' : 'p2'
                return { ...prev, teamCounts: { ...prev.teamCounts, [key]: m.count } }
              })
            } else if (m.type === 'player_left') {
              setState(prev => {
                const key = m.player === 1 ? 'p1' : 'p2'
                return { ...prev, teamCounts: { ...prev.teamCounts, [key]: m.count } }
              })
            }
          } catch {}
        }
        ws.onclose = () => { if(wsRef.current===ws) wsRef.current=null; if(alive) setTimeout(connect,2000) }
        ws.onerror = () => ws.close()
      } catch {}
    }
    connect()
    return () => { alive=false; ws?.close() }
  }, [processKey, tryShoot, tryKnife])

  // ── Sim frame emission (send grid to Python Simulator.py via server) ────────
  useEffect(() => {
    const { phase, p1, p2, bullets, obstacles, traps, map, tick } = state
    if (phase !== 'playing' && phase !== 'gameover') return
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return

    const mapBg     = map?.bgColor   ?? '#0a0a0a'
    const trapColor = map?.trapColor ?? '#ff00aa'
    const obsColor  = map?.obsColor  ?? MAPS[0].obsColor
    const grid = Array.from({length: H}, () => Array(W).fill(mapBg))

    for (const o of obstacles) grid[o.y][o.x] = obsColor[o.hp] ?? obsColor[3]
    for (const t of traps)     grid[t.y][t.x] = trapColor
    for (const b of bullets)
      if (b.y>=0&&b.y<H&&b.x>=0&&b.x<W)
        grid[b.y][b.x] = b.owner===1 ? '#ffe000' : '#ff8000'

    const p1vis = p1.inv===0 || tick%2===0
    const p2vis = p2.inv===0 || tick%2===0
    if (p1.hp>0&&p1vis) grid[p1.y][p1.x] = p1.knifeAnim>0 ? '#ffffff' : C1
    if (p2.hp>0&&p2vis) grid[p2.y][p2.x] = p2.knifeAnim>0 ? '#ffffff' : C2

    try { ws.send(JSON.stringify({ type: 'sim_frame', grid })) } catch {}
  }, [state])

  // ── Game tick ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      cd.current.p1  = Math.max(0, cd.current.p1  - 1)
      cd.current.p2  = Math.max(0, cd.current.p2  - 1)
      cd.current.p1k = Math.max(0, cd.current.p1k - 1)
      cd.current.p2k = Math.max(0, cd.current.p2k - 1)

      setState(prev => {
        if (prev.phase === 'lobby') return prev  // wait in lobby

        if (prev.phase === 'vote') {
          const voteCountdown = Math.max(0, prev.voteCountdown - 1)
          return { ...prev, voteCountdown }
        }

        if (prev.phase !== 'playing') return prev
        const keys = keysRef.current
        const tick = prev.tick + 1
        let { p1, p2, bullets, obstacles, traps, safeTimer, spawnT } = prev

        if (safeTimer > 0) safeTimer = Math.max(0, safeTimer-1)

        if (safeTimer === 0) {
          spawnT++
          if (obstacles.length < MAX_OBS && spawnT >= OBS_SPAWN_T) {
            spawnT = 0
            const o = trySpawnObs(obstacles, p1, p2)
            if (o) obstacles = [...obstacles, o]
          }
        }

        if (tick % MOVE_EVERY === 0) {
          const obsSet = new Set(obstacles.map(o=>`${o.x},${o.y}`))
          const mv = (p, k, pm) => {
            let nx=p.x, ny=p.y
            // Keyboard input
            if (keys.has(k.lt)) nx=Math.max(0,     nx-1)
            if (keys.has(k.rt)) nx=Math.min(W-1,   nx+1)
            if (keys.has(k.up)) ny=Math.max(0,     ny-1)
            if (keys.has(k.dn)) ny=Math.min(H-1,   ny+1)
            // Phone input (pendingMove)
            if (pm && nx===p.x && ny===p.y) {
              nx = Math.max(0, Math.min(W-1, p.x + pm.dx))
              ny = Math.max(0, Math.min(H-1, p.y + pm.dy))
            }
            if (obsSet.has(`${nx},${p.y}`)) nx=p.x
            if (obsSet.has(`${p.x},${ny}`)) ny=p.y
            return { ...p, x:nx, y:ny }
          }
          p1=mv(p1,P1K,pendingMove.current.p1); p2=mv(p2,P2K,pendingMove.current.p2)
          pendingMove.current.p1 = null
          pendingMove.current.p2 = null
        }

        if (p1.reload>0) { const r=p1.reload-1; p1={...p1,reload:r,ammo:r===0?AMMO_MAX:p1.ammo} }
        if (p2.reload>0) { const r=p2.reload-1; p2={...p2,reload:r,ammo:r===0?AMMO_MAX:p2.ammo} }
        if (p1.inv>0)       p1={...p1,inv:p1.inv-1}
        if (p2.inv>0)       p2={...p2,inv:p2.inv-1}
        if (p1.knifeAnim>0) p1={...p1,knifeAnim:p1.knifeAnim-1}
        if (p2.knifeAnim>0) p2={...p2,knifeAnim:p2.knifeAnim-1}

        if (safeTimer===0) {
          const nearObs = p => obstacles.some(o=>Math.abs(o.x-p.x)<=1&&Math.abs(o.y-p.y)<=1)
          p1={...p1,coverTimer:nearObs(p1)?p1.coverTimer+1:0}
          p2={...p2,coverTimer:nearObs(p2)?p2.coverTimer+1:0}
          if (p1.coverTimer>=COVER_TICKS) { p1={...p1,hp:Math.max(0,p1.hp-1),inv:INV_TICKS,coverTimer:0}; traps=[...traps,{x:p1.x,y:p1.y}] }
          if (p2.coverTimer>=COVER_TICKS) { p2={...p2,hp:Math.max(0,p2.hp-1),inv:INV_TICKS,coverTimer:0}; traps=[...traps,{x:p2.x,y:p2.y}] }
        }

        const p1ti=traps.findIndex(t=>t.x===p1.x&&t.y===p1.y)
        if (p1ti>=0&&p1.inv===0) { p1={...p1,hp:Math.max(0,p1.hp-1),inv:INV_TICKS,coverTimer:0}; traps=traps.filter((_,i)=>i!==p1ti) }
        const p2ti=traps.findIndex(t=>t.x===p2.x&&t.y===p2.y)
        if (p2ti>=0&&p2.inv===0) { p2={...p2,hp:Math.max(0,p2.hp-1),inv:INV_TICKS,coverTimer:0}; traps=traps.filter((_,i)=>i!==p2ti) }

        const moved=[]
        for (const b of bullets) {
          let {x,y,dx,dy,owner,bounces}=b
          let nx=x+dx,ny=y+dy,bounced=false
          if(nx<0)  {nx=0;    dx= Math.abs(dx);bounced=true}
          if(nx>=W) {nx=W-1;  dx=-Math.abs(dx);bounced=true}
          if(ny<0)  {ny=0;    dy= Math.abs(dy);bounced=true}
          if(ny>=H) {ny=H-1;  dy=-Math.abs(dy);bounced=true}
          const nb=bounced?bounces+1:bounces
          if(nb>MAX_BOUNCES) continue
          moved.push({x:nx,y:ny,dx,dy,owner,bounces:nb})
        }

        let updObs=obstacles.map(o=>({...o}))
        const afterObs=[]
        for (const b of moved) {
          const idx=updObs.findIndex(o=>o.x===b.x&&o.y===b.y)
          if(idx>=0){updObs[idx].hp--;if(updObs[idx].hp<=0)updObs.splice(idx,1)}
          else afterObs.push(b)
        }
        obstacles=updObs

        let p1hp=p1.hp,p2hp=p2.hp,p1inv=p1.inv,p2inv=p2.inv,anyDmg=false
        const aliveBullets=[]
        if (safeTimer===0) {
          for (const b of afterObs) {
            let hit=false
            if(b.owner===2&&b.x===p1.x&&b.y===p1.y&&p1inv===0){p1hp=Math.max(0,p1hp-1);p1inv=INV_TICKS;p1={...p1,coverTimer:0};hit=true;anyDmg=true}
            if(b.owner===1&&b.x===p2.x&&b.y===p2.y&&p2inv===0){p2hp=Math.max(0,p2hp-1);p2inv=INV_TICKS;p2={...p2,coverTimer:0};hit=true;anyDmg=true}
            if(!hit) aliveBullets.push(b)
          }
        } else { aliveBullets.push(...afterObs) }

        p1={...p1,hp:p1hp,inv:p1inv}
        p2={...p2,hp:p2hp,inv:p2inv}
        if(anyDmg&&p1hp>0&&p2hp>0&&safeTimer===0) safeTimer=SAFE_TICKS

        let phase='playing',winner=null
        if     (p1hp<=0&&p2hp<=0){phase='gameover';winner=0}
        else if(p1hp<=0)          {phase='gameover';winner=2}
        else if(p2hp<=0)          {phase='gameover';winner=1}

        return {...prev,phase,p1,p2,bullets:aliveBullets,obstacles,traps,safeTimer,spawnT,winner,tick}
      })
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  const { p1, p2, bullets, obstacles, traps, safeTimer, tick, phase,
          map, voteCountdown, ready, teamCounts } = state
  const c1 = C1, c2 = C2
  const mapBg    = map?.bgColor   ?? '#1a1a1a'
  const trapColor = map?.trapColor ?? '#ff00aa'
  const p1label  = teamCounts.p1 > 0 ? `BLUE ×${teamCounts.p1}` : 'BLUE'
  const p2label  = teamCounts.p2 > 0 ? `RED ×${teamCounts.p2}`  : 'RED'
  const obsColor = map?.obsColor ?? MAPS[0].obsColor
  const grid = Array.from({ length: H }, () => Array(W).fill(null))

  for (const o of obstacles) grid[o.y][o.x] = obsColor[o.hp] ?? obsColor[3]
  for (const t of traps)     grid[t.y][t.x] = trapColor
  for (const b of bullets)
    if (b.y>=0&&b.y<H&&b.x>=0&&b.x<W)
      grid[b.y][b.x] = b.owner===1 ? '#ffe000' : '#ff8000'

  const p1vis = p1.inv===0||tick%2===0
  const p2vis = p2.inv===0||tick%2===0
  if(p1.hp>0&&p1vis) grid[p1.y][p1.x]=p1.knifeAnim>0?'#ffffff':c1
  if(p2.hp>0&&p2vis) grid[p2.y][p2.x]=p2.knifeAnim>0?'#ffffff':c2

  const knifeInRange = phase==='playing' &&
    Math.max(Math.abs(p1.x-p2.x), Math.abs(p1.y-p2.y)) <= KNIFE_RANGE
  const safeSeconds  = (safeTimer*TICK_MS/1000).toFixed(1)
  const p1coverPct   = Math.min(1, p1.coverTimer/COVER_TICKS)
  const p2coverPct   = Math.min(1, p2.coverTimer/COVER_TICKS)

  const AmmoBar = ({ ammo, reload, color }) => (
    <div className="ammo-bar">
      {Array.from({ length:AMMO_MAX },(_,i) => (
        <div key={i} className="ammo-dot" style={{ background:i<ammo?color:'#1a1a1a' }} />
      ))}
      {reload>0 && (
        <div className="reload-bar">
          <div className="reload-fill" style={{ width:`${(1-reload/RELOAD_TICKS)*100}%`, background:color }} />
        </div>
      )}
    </div>
  )

  // ── Lobby screen ──────────────────────────────────────────────────────────
  if (phase === 'lobby') {
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          <div className="vote-title">WAITING ROOM</div>
          <div className="lobby-players">
            <div className={`lobby-player ${ready.p1 ? 'ready' : ''}`} style={{borderColor:teamCounts.p1>0?c1:undefined}}>
              <span style={{color:c1}}>🔵 {p1label}</span>
              <span className="lobby-status">
                {teamCounts.p1 > 0 ? (ready.p1 ? '✓ READY' : 'connected…') : 'waiting…'}
              </span>
            </div>
            <div className={`lobby-player ${ready.p2 ? 'ready' : ''}`} style={{borderColor:teamCounts.p2>0?c2:undefined}}>
              <span style={{color:c2}}>🔴 {p2label}</span>
              <span className="lobby-status">
                {teamCounts.p2 > 0 ? (ready.p2 ? '✓ READY' : 'connected…') : 'waiting…'}
              </span>
            </div>
          </div>
          <div className="vote-hints">
            {ready.p1 && ready.p2
              ? <span style={{color:'#00ff41'}} className="blink">STARTING VOTE…</span>
              : 'ready up on phone to start map vote'}
          </div>
        </div>
      </div>
    )
  }

  // ── Vote screen ───────────────────────────────────────────────────────────
  if (phase === 'vote') {
    const voteSeconds = Math.ceil(voteCountdown * TICK_MS / 1000)
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          <div className="vote-title">VOTE YOUR MAP</div>
          <div className={`vote-countdown${voteSeconds<=3?' blink':''}`}>{voteSeconds}s</div>
          <div className="map-cards">
            {MAPS.map((m) => (
              <div key={m.id} className="map-card">
                <div className="map-name">{m.name}</div>
                <div className="map-desc">{m.desc}</div>
                <div className="map-swatches">
                  <div className="map-swatch" style={{ background:m.bgColor }} />
                  {[3,2,1].map(hp=>(
                    <div key={hp} className="map-swatch" style={{ background:m.obsColor[hp] }} />
                  ))}
                  <div className="map-swatch" style={{ background:m.trapColor }} />
                </div>
              </div>
            ))}
          </div>
          <div className="vote-hints">vote on phone · most votes wins · tie = random</div>
        </div>
      </div>
    )
  }

  // ── Game screen ───────────────────────────────────────────────────────────
  return (
    <div className="shooter-wrap">
      {safeTimer>0 && (
        <div className="safe-banner">⏱ SAFE ZONE — {safeSeconds}s — REPOSITION</div>
      )}
      <div className="shooter-hud">
        <div className="hud-side">
          <span className="ptag" style={{color:c1}}>{p1label}</span>
          <div className="hearts">
            {Array.from({length:MAX_HP},(_,i)=>(
              <span key={i} style={{color:i<p1.hp?c1:'#1a1a1a'}}>♥</span>
            ))}
          </div>
          <AmmoBar ammo={p1.ammo} reload={p1.reload} color={c1} />
          {p1.reload>0 && <div className="reload-label" style={{color:c1}}>RELOADING</div>}
          {p1coverPct>0 && <div className="cover-bar-wrap"><div className="cover-bar-fill" style={{width:`${p1coverPct*100}%`}} /></div>}
          {p1coverPct>0.75 && <div className="cover-warn">MOVE! TRAP</div>}
          <div className="hint">↑↓←→ · SPACE fire · E knife</div>
        </div>

        <div className="hud-center">
          {phase==='gameover' && (
            <span className="phase-msg" style={{color:state.winner===1?c1:state.winner===2?c2:'#ffff00'}}>
              {state.winner===0?'DRAW!':state.winner===1?'🔵 BLUE WINS!':'🔴 RED WINS!'}
              <br/><small>returning to lobby…</small>
            </span>
          )}
          {phase==='playing'&&knifeInRange && (
            <span className="phase-msg blink" style={{color:'#ffffff',fontSize:12}}>⚔ KNIFE!</span>
          )}
        </div>

        <div className="hud-side" style={{alignItems:'flex-end'}}>
          <span className="ptag" style={{color:c2}}>{p2label}</span>
          <div className="hearts">
            {Array.from({length:MAX_HP},(_,i)=>(
              <span key={i} style={{color:i<p2.hp?c2:'#1a1a1a'}}>♥</span>
            ))}
          </div>
          <AmmoBar ammo={p2.ammo} reload={p2.reload} color={c2} />
          {p2.reload>0 && <div className="reload-label" style={{color:c2}}>RELOADING</div>}
          {p2coverPct>0 && <div className="cover-bar-wrap"><div className="cover-bar-fill" style={{width:`${p2coverPct*100}%`}} /></div>}
          {p2coverPct>0.75 && <div className="cover-warn">MOVE! TRAP</div>}
          <div className="hint">WASD · F fire · R knife</div>
        </div>
      </div>

      <div className={`matrix shooter-matrix${safeTimer>0?' safe-flash':''}`}>
        {grid.map((row,y)=>row.map((color,x)=>{
          const glow=(y===p1.y&&x===p1.x&&p1.hp>0&&p1vis)||(y===p2.y&&x===p2.x&&p2.hp>0&&p2vis)
          return (
            <div key={`${y}-${x}`} className="pixel" style={{
              background: color || mapBg,
              boxShadow: glow ? `0 0 5px 2px ${color}` : undefined,
            }}/>
          )
        }))}
      </div>

      <div className="game-legend">
        <span style={{color:trapColor}}>■</span> trap &nbsp;·&nbsp;
        3s near cover → trap -1hp &nbsp;·&nbsp; 5s safe after hit &nbsp;·&nbsp; E/R = knife
      </div>
    </div>
  )
}
