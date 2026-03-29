const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')
const dgram = require('dgram')

// ── Game constants (ported from ShooterGame.jsx) ────────────────────────────
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
const C1 = '#00ccff'
const C2 = '#ff3333'

const GAME_MAPS = [
  {
    id:'desert',  name:'OLD DESERT',   desc:'Sandy ruins',
    bgColor:'#1f1200',
    obsColor:{ 3:'#005500', 2:'#008800', 1:'#00bb00' },
    trapColor:'#ff6600',
  },
  {
    id:'haunted', name:'HAUNTED HOUSE', desc:'Dark corridors',
    bgColor:'#000000',
    obsColor:{ 3:'#cc4400', 2:'#ee5500', 1:'#ff8800' },
    trapColor:'#ffee00',
  },
  {
    id:'battle',  name:'BATTLEFIELD',  desc:'Green trenches',
    bgColor:'#001400',
    obsColor:{ 3:'#888888', 2:'#bbbbbb', 1:'#ffffff' },
    trapColor:'#ffee00',
  },
]

// ── Game state (server is the game engine) ──────────────────────────────────
let gameState = null
let gameLoopId = null
let cooldowns = { p1: 0, p2: 0, p1k: 0, p2k: 0 }
let pendingMove = { p1: null, p2: null }

// ── Python Simulator UDP bridge ──────────────────────────────────────────────
// Read ports from the same config file Simulator.py uses (../matrix_sim_config.json)
let _simCfg = {}
try {
  _simCfg = JSON.parse(require('fs').readFileSync(
    path.join(__dirname, '..', 'matrix_sim_config.json'), 'utf8'
  ))
} catch {}
const SIM_TARGET_PORT = _simCfg.recv_port ?? 3002  // Simulator listens here  (we SEND frames)
const SIM_LISTEN_PORT = _simCfg.send_port ?? 3003  // Simulator sends here    (we LISTEN)

const simSock = dgram.createSocket('udp4')
simSock.bind(SIM_LISTEN_PORT, () => {
  console.log(`  UDP bridge: target=:${SIM_TARGET_PORT}  listen=:${SIM_LISTEN_PORT}`)
})
simSock.on('error', (err) => { console.log('  UDP socket error:', err.message) })

// Convert 16x32 hex-color grid → 1536-byte frame buffer (GRB channel-interleaved)
function gridToFrameBuffer(grid) {
  const buf = Buffer.alloc(64 * 24)  // LEDS_PER_CH(64) * 24 = 1536 bytes
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 16; x++) {
      let r = 0, g = 0, b = 0
      const c = grid[y]?.[x]
      if (c && typeof c === 'string' && c.length >= 7 && c[0] === '#') {
        r = parseInt(c.slice(1, 3), 16) || 0
        g = parseInt(c.slice(3, 5), 16) || 0
        b = parseInt(c.slice(5, 7), 16) || 0
      }
      const channel  = Math.floor(y / 4)
      const rowInCh  = y % 4
      const ledPos   = rowInCh * 16 + (rowInCh % 2 === 0 ? x : 15 - x)
      const offset   = ledPos * 24 + channel
      buf[offset]      = g   // c1 = G (simulator swaps to r=c2, g=c1)
      buf[offset +  8] = r   // c2 = R
      buf[offset + 16] = b   // c3 = B
    }
  }
  return buf
}

function makeSimPkt(cmdType, payload = Buffer.alloc(0), pktIdx = 0) {
  const hdr = Buffer.alloc(14)
  hdr[0] = 0x75
  hdr.writeUInt16BE(cmdType, 8)
  hdr.writeUInt16BE(pktIdx, 10)
  const pkt = Buffer.concat([hdr, payload, Buffer.alloc(2)])
  let sum = 0
  for (let i = 0; i < pkt.length - 1; i++) sum += pkt[i]
  pkt[pkt.length - 1] = sum & 0xFF
  return pkt
}

function sendFrameToSim(grid) {
  const fb = gridToFrameBuffer(grid)
  const pkts = [
    makeSimPkt(0x3344),                          // Start Frame
    makeSimPkt(0x8877, fb.slice(0, 984), 1),    // Data chunk 1
    makeSimPkt(0x8877, fb.slice(984),    2),    // Data chunk 2
    makeSimPkt(0x5566),                          // End Frame
  ]
  for (const p of pkts) {
    simSock.send(p, SIM_TARGET_PORT, '127.0.0.1', (err) => {
      if (err) console.log('  UDP send error:', err.message)
    })
  }
}

// Forward Simulator click triggers → display
simSock.on('message', (data) => {
  if (data.length >= 2 && data[0] === 0x88 && data[1] === 0x01) {
    const triggers = []
    for (let ch = 0; ch < 8; ch++) {
      const base = 2 + ch * 171
      if (base + 65 > data.length) continue
      for (let led = 0; led < 64; led++) {
        if (data[base + 1 + led] === 0xCC) {
          const row = Math.floor(led / 16)
          const x = row % 2 === 0 ? (led % 16) : (15 - led % 16)
          const y = ch * 4 + row
          triggers.push({ x, y })
        }
      }
    }
    // ── Shooter: tile triggers → player movement ──────────────────────────
    if (triggers.length > 0 && gameState && phase === 'playing') {
      for (const t of triggers) {
        const which = t.y >= 16 ? 'p1' : 'p2'
        const player = gameState[which]
        const rawDx = t.x - player.x
        const rawDy = t.y - player.y
        const dx = rawDx === 0 ? 0 : (rawDx > 0 ? 1 : -1)
        const dy = rawDy === 0 ? 0 : (rawDy > 0 ? 1 : -1)
        if (dx !== 0 || dy !== 0) {
          pendingMove[which] = { dx, dy }
          player.dir = { dx, dy }
        }
      }
    }

    // ── NeonBreach: tile triggers = active floor positions ──────────────
    if (nbPhase === 'nb_playing' && nbState) {
      nbState.activeTiles = triggers  // store all pressed tiles this frame
    }

    if (displayWs && displayWs.readyState === 1) {
      try { displayWs.send(JSON.stringify({ type: 'sim_triggers', triggers })) } catch {}
    }
  }
})

// ── Game engine (ported from ShooterGame.jsx) ───────────────────────────────

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
    if (Math.max(Math.abs(x - p1.x), Math.abs(y - p1.y)) < 4) continue
    if (Math.max(Math.abs(x - p2.x), Math.abs(y - p2.y)) < 4) continue
    return { x, y, hp: 3 }
  }
  return null
}

function tryShoot(owner, sdx, sdy) {
  if (!gameState || phase !== 'playing' || gameState.safeTimer > 0) return
  const cdk = owner === 1 ? 'p1' : 'p2'
  if (cooldowns[cdk] > 0) return
  const pp = owner === 1 ? gameState.p1 : gameState.p2
  if (pp.reload > 0 || pp.ammo <= 0) return

  // Use explicit direction from phone if provided, otherwise player's facing dir
  const dx = (typeof sdx === 'number') ? sdx : pp.dir.dx
  const dy = (typeof sdy === 'number') ? sdy : pp.dir.dy
  if (dx === 0 && dy === 0) return

  cooldowns[cdk] = SHOOT_CD
  pp.ammo--
  if (pp.ammo === 0) pp.reload = RELOAD_TICKS

  const bx = pp.x + dx, by = pp.y + dy
  const oob = bx < 0 || bx >= W || by < 0 || by >= H
  const blocked = gameState.obstacles.some(o => o.x === bx && o.y === by)
  if (!oob && !blocked) {
    gameState.bullets.push({ x: bx, y: by, dx, dy, owner, bounces: 0 })
  }
}

function tryKnife(owner) {
  if (!gameState || phase !== 'playing' || gameState.safeTimer > 0) return
  const cdk = owner === 1 ? 'p1k' : 'p2k'
  if (cooldowns[cdk] > 0) return

  const atk = owner === 1 ? gameState.p1 : gameState.p2
  const def = owner === 1 ? gameState.p2 : gameState.p1
  if (Math.max(Math.abs(atk.x - def.x), Math.abs(atk.y - def.y)) > KNIFE_RANGE) return
  if (def.inv > 0) return

  cooldowns[cdk] = KNIFE_CD
  def.hp = Math.max(0, def.hp - 1)
  def.inv = INV_TICKS
  def.coverTimer = 0
  atk.knifeAnim = 6

  if (def.hp <= 0) {
    gameState.winner = owner
    handleGameOver(owner)
  } else {
    gameState.safeTimer = SAFE_TICKS
  }
}

function tickGame() {
  cooldowns.p1  = Math.max(0, cooldowns.p1  - 1)
  cooldowns.p2  = Math.max(0, cooldowns.p2  - 1)
  cooldowns.p1k = Math.max(0, cooldowns.p1k - 1)
  cooldowns.p2k = Math.max(0, cooldowns.p2k - 1)

  if (phase !== 'playing' || !gameState) return
  const gs = gameState
  gs.tick++

  // Safe timer
  if (gs.safeTimer > 0) gs.safeTimer--

  // Obstacle spawning
  if (gs.safeTimer === 0) {
    gs.spawnT++
    if (gs.obstacles.length < MAX_OBS && gs.spawnT >= OBS_SPAWN_T) {
      gs.spawnT = 0
      const o = trySpawnObs(gs.obstacles, gs.p1, gs.p2)
      if (o) gs.obstacles.push(o)
    }
  }

  // Movement from pendingMove (replaces keyboard input)
  if (gs.tick % MOVE_EVERY === 0) {
    const obsSet = new Set(gs.obstacles.map(o => `${o.x},${o.y}`))
    for (const which of ['p1', 'p2']) {
      const mv = pendingMove[which]
      if (!mv) continue
      const p = gs[which]
      let nx = p.x + mv.dx, ny = p.y + mv.dy
      nx = Math.max(0, Math.min(W - 1, nx))
      ny = Math.max(0, Math.min(H - 1, ny))
      if (obsSet.has(`${nx},${p.y}`)) nx = p.x
      if (obsSet.has(`${p.x},${ny}`)) ny = p.y
      p.x = nx; p.y = ny
    }
    pendingMove.p1 = null
    pendingMove.p2 = null
  }

  // Reload, invincibility, knife animation
  for (const p of [gs.p1, gs.p2]) {
    if (p.reload > 0) { p.reload--; if (p.reload === 0) p.ammo = AMMO_MAX }
    if (p.inv > 0) p.inv--
    if (p.knifeAnim > 0) p.knifeAnim--
  }

  // Cover timer (near obstacle too long = damage + trap)
  if (gs.safeTimer === 0) {
    const nearObs = p => gs.obstacles.some(o => Math.abs(o.x - p.x) <= 1 && Math.abs(o.y - p.y) <= 1)
    for (const p of [gs.p1, gs.p2]) {
      p.coverTimer = nearObs(p) ? p.coverTimer + 1 : 0
      if (p.coverTimer >= COVER_TICKS) {
        p.hp = Math.max(0, p.hp - 1)
        p.inv = INV_TICKS
        p.coverTimer = 0
        gs.traps.push({ x: p.x, y: p.y })
      }
    }
  }

  // Trap collision
  for (const p of [gs.p1, gs.p2]) {
    const ti = gs.traps.findIndex(t => t.x === p.x && t.y === p.y)
    if (ti >= 0 && p.inv === 0) {
      p.hp = Math.max(0, p.hp - 1)
      p.inv = INV_TICKS
      p.coverTimer = 0
      gs.traps.splice(ti, 1)
    }
  }

  // Bullet movement + wall bouncing
  const moved = []
  for (const b of gs.bullets) {
    let { x, y, dx, dy, owner, bounces } = b
    let nx = x + dx, ny = y + dy, bounced = false
    if (nx < 0)  { nx = 0;     dx =  Math.abs(dx); bounced = true }
    if (nx >= W) { nx = W - 1; dx = -Math.abs(dx); bounced = true }
    if (ny < 0)  { ny = 0;     dy =  Math.abs(dy); bounced = true }
    if (ny >= H) { ny = H - 1; dy = -Math.abs(dy); bounced = true }
    const nb = bounced ? bounces + 1 : bounces
    if (nb > MAX_BOUNCES) continue
    moved.push({ x: nx, y: ny, dx, dy, owner, bounces: nb })
  }

  // Bullet-obstacle collision
  const afterObs = []
  for (const b of moved) {
    const obs = gs.obstacles.find(o => o.x === b.x && o.y === b.y)
    if (obs) {
      obs.hp--
      if (obs.hp <= 0) {
        const idx = gs.obstacles.indexOf(obs)
        if (idx >= 0) gs.obstacles.splice(idx, 1)
      }
    } else {
      afterObs.push(b)
    }
  }

  // Bullet-player collision
  let anyDmg = false
  const aliveBullets = []
  if (gs.safeTimer === 0) {
    for (const b of afterObs) {
      let hit = false
      if (b.owner === 2 && b.x === gs.p1.x && b.y === gs.p1.y && gs.p1.inv === 0) {
        gs.p1.hp = Math.max(0, gs.p1.hp - 1); gs.p1.inv = INV_TICKS; gs.p1.coverTimer = 0
        hit = true; anyDmg = true
      }
      if (b.owner === 1 && b.x === gs.p2.x && b.y === gs.p2.y && gs.p2.inv === 0) {
        gs.p2.hp = Math.max(0, gs.p2.hp - 1); gs.p2.inv = INV_TICKS; gs.p2.coverTimer = 0
        hit = true; anyDmg = true
      }
      if (!hit) aliveBullets.push(b)
    }
  } else {
    aliveBullets.push(...afterObs)
  }
  gs.bullets = aliveBullets
  if (anyDmg && gs.p1.hp > 0 && gs.p2.hp > 0 && gs.safeTimer === 0) gs.safeTimer = SAFE_TICKS

  // Win condition
  let winner = null
  if (gs.p1.hp <= 0 && gs.p2.hp <= 0) winner = 0
  else if (gs.p1.hp <= 0) winner = 2
  else if (gs.p2.hp <= 0) winner = 1

  if (winner !== null) {
    gs.winner = winner
    handleGameOver(winner)
    return
  }

  renderFrame()
}

function renderFrame() {
  if (!gameState) return
  const gs = gameState
  const map = gs.map
  const mapBg     = map?.bgColor   ?? '#0a0a0a'
  const trapColor = map?.trapColor ?? '#ff00aa'
  const obsColor  = map?.obsColor  ?? MAPS[0].obsColor

  const grid = Array.from({ length: H }, () => Array(W).fill(mapBg))
  for (const o of gs.obstacles) grid[o.y][o.x] = obsColor[o.hp] ?? obsColor[3]
  for (const t of gs.traps)     grid[t.y][t.x] = trapColor
  for (const b of gs.bullets) {
    if (b.y >= 0 && b.y < H && b.x >= 0 && b.x < W)
      grid[b.y][b.x] = b.owner === 1 ? '#ffe000' : '#ff8000'
  }
  const p1vis = gs.p1.inv === 0 || gs.tick % 2 === 0
  const p2vis = gs.p2.inv === 0 || gs.tick % 2 === 0
  if (gs.p1.hp > 0 && p1vis) grid[gs.p1.y][gs.p1.x] = gs.p1.knifeAnim > 0 ? '#ffffff' : C1
  if (gs.p2.hp > 0 && p2vis) grid[gs.p2.y][gs.p2.x] = gs.p2.knifeAnim > 0 ? '#ffffff' : C2

  sendFrameToSim(grid)
  if (displayWs?.readyState === 1) {
    displayWs.send(JSON.stringify({ type: 'sim_frame', grid }))
  }
}

function startGameLoop(mapIdx) {
  stopGameLoop()
  gameState = {
    p1: { x: 4, y: 28, hp: MAX_HP, inv: 0, ammo: AMMO_MAX, reload: 0, coverTimer: 0, knifeAnim: 0, dir: { dx: 0, dy: -1 } },
    p2: { x: 11, y: 3, hp: MAX_HP, inv: 0, ammo: AMMO_MAX, reload: 0, coverTimer: 0, knifeAnim: 0, dir: { dx: 0, dy: 1 } },
    bullets: [],
    obstacles: [],
    traps: initTraps(),
    map: MAPS[mapIdx ?? 0],
    tick: 0,
    safeTimer: 0,
    spawnT: 0,
    winner: null,
  }
  cooldowns = { p1: 0, p2: 0, p1k: 0, p2k: 0 }
  pendingMove = { p1: null, p2: null }
  gameLoopId = setInterval(tickGame, TICK_MS)
  console.log(`  Game loop started (map: ${MAPS[mapIdx ?? 0].id}, tick: ${TICK_MS}ms)`)
}

function stopGameLoop() {
  if (gameLoopId !== null) {
    clearInterval(gameLoopId)
    gameLoopId = null
  }
}

function handleGameOver(winner) {
  renderFrame()
  stopGameLoop()
  const label = winner === 0 ? 'DRAW' : winner === 1 ? 'BLUE' : 'RED'
  console.log(`  Game over — winner: ${label}`)
  phase = 'gameover'
  broadcastAll({ type: 'game_phase', phase: 'gameover', winner })
  setTimeout(() => { gameState = null; resetToLobby() }, 4000)
}

// ── Express + WebSocket ─────────────────────────────────────────────────────
const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

app.use(express.static(path.join(__dirname, 'public')))

// Serve game controller pages from their respective folders
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'Shooter', 'controller.html')))
app.get('/shooter', (req, res) => res.sendFile(path.join(__dirname, '..', 'Shooter', 'controller.html')))
app.get('/musical-chairs', (req, res) => res.sendFile(path.join(__dirname, '..', 'MusicalChairs', 'controller.html')))
app.get('/neon-breach', (req, res) => res.sendFile(path.join(__dirname, '..', 'NeonBreach', 'controller.html')))

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return 'localhost'
}

// ── Client tracking ────────────────────────────────────────────────────────
const clients = new Set()
let displayWs = null
const teams    = { 1: new Set(), 2: new Set() }  // team -> Set of ws
const wsInfo   = new Map()                        // ws -> { team, name }
const mcPlayers = new Map()                       // ws -> { id, name, color }

// ── NeonBreach state ────────────────────────────────────────────────────────
// No per-player tracking — game uses floor tile triggers as input.
// Tiles pressed = people standing there. Charge zones detect presence,
// boss laser checks if anyone is standing in the firing column.
let nbState   = null
let nbPhase   = 'nb_lobby'
let nbLoopId  = null
const NB_HP          = 3           // shared team HP
const NB_INV_TICKS   = Math.round(1500 / TICK_MS)
const NB_CHARGE_FULL = Math.round(2000 / TICK_MS)   // ~2.0s full charge
const NB_LASER_TICKS = Math.round(800  / TICK_MS)   // laser visible 0.8s
const NB_TRACK_TICKS = Math.round(3000 / TICK_MS)   // green tracking 3s
const NB_LOCK_TICKS  = Math.round(1500 / TICK_MS)   // orange lock 1.5s
const NB_FIRE_TICKS  = Math.round(500  / TICK_MS)   // red fire 0.5s
const NB_COOL_TICKS  = Math.round(2000 / TICK_MS)   // cooldown 2s
const NB_LAVA_CYCLE  = Math.round(5000 / TICK_MS)
const NB_VOTE_TIME   = 10000

function broadcastNb(obj) {
  const str = JSON.stringify(obj)
  for (const c of clients) {
    if (c.readyState === 1) c.send(str)
  }
}

function initNbRoom(roomNum) {
  const isFinal = roomNum >= 3
  const bossHp = 30 + roomNum * 15

  // Spawn 2-3 charge zones spread across the floor
  const zones = []
  const numZones = 2 + (nbState?.buffs?.includes('more_zones') ? 1 : 0)
  const spacing = Math.floor(14 / numZones)
  for (let z = 0; z < numZones; z++) {
    const zx = 1 + z * spacing + Math.floor(Math.random() * Math.max(1, spacing - 2))
    const zy = 26 + Math.floor(Math.random() * 4)
    zones.push({ x: zx, y: zy, chargeLevel: 0 })
  }

  let safeZones = []
  if (isFinal) {
    safeZones = [
      { x: 1,  y: 27 },
      { x: 7,  y: 28 },
      { x: 13, y: 27 },
    ]
  }

  nbState = {
    room: roomNum,
    boss: {
      x: 4, y: 0, w: 8, h: 3,
      hp: bossHp, maxHp: bossHp,
      phase: 'idle', phaseTimer: Math.round(2000 / TICK_MS),
      targetCol: 8,
      lockedCol: null,
      moveDir: 1, moveTimer: 0,
    },
    teamHp: nbState ? nbState.teamHp : NB_HP,
    inv: 0,
    chargeZones: zones,
    playerLasers: [],       // {col, width, timer}
    activeTiles: [],        // [{x,y}] — set by simulator triggers each frame
    safeZones,
    isFinal,
    lavaActive: false,
    lavaTimer: NB_LAVA_CYCLE,
    tick: 0,
    buffs: nbState?.buffs || [],
    voteTimer: null,
    lootOptions: [],
    votes: {},
    voteParticipants: new Set(),
  }
}

function tickNeonBreach() {
  if (!nbState) return
  if (nbPhase !== 'nb_playing' && !nbPhase.includes('vote') && nbPhase !== 'nb_loot_chosen' && nbPhase !== 'nb_next_room') return

  const st = nbState
  st.tick++

  const tiles = st.activeTiles || []
  const tileSet = new Set(tiles.map(t => `${t.x},${t.y}`))
  const hasTile = (x, y) => tileSet.has(`${x},${y}`)

  // ── Voting Phases ────────────────────────────────────────────────────────
  if (nbPhase === 'nb_loot_vote' || nbPhase === 'nb_dir_vote' || nbPhase === 'nb_loot_chosen' || nbPhase === 'nb_next_room') {
    if (nbPhase === 'nb_loot_vote' || nbPhase === 'nb_dir_vote') {
      let resolved = false
      for (const z of st.voteZones) {
        let tilesOn = 0
        for (let dy = 0; dy < z.h; dy++) for (let dx = 0; dx < z.w; dx++) {
          if (hasTile(z.x + dx, z.y + dy)) tilesOn++
        }
        if (tilesOn > 0) {
          z.chargeLevel += 1.5 * tilesOn
          if (z.chargeLevel >= NB_CHARGE_FULL) {
            resolved = true
            if (nbPhase === 'nb_loot_vote') {
              nbState.votes['physical'] = z.optionIdx
              resolveNbLootVote()
            } else {
              nbState.votes['physical'] = z.dir
              resolveNbDirVote()
            }
            break
          }
        } else {
          z.chargeLevel = Math.max(0, z.chargeLevel - 0.8)
        }
      }
    }
    renderNbVoteFrame()
    return
  }

  // ── Invincibility countdown ──────────────────────────────────────────────
  if (st.inv > 0) st.inv--

  // ── Charge zones: check if any tile overlaps each zone ───────────────────
  const chargeSpeed = st.buffs.includes('rapid_charge') ? 1.3 : 1
  for (const z of st.chargeZones) {
    // Count how many tiles are on this zone (more people = faster charge)
    let tilesOn = 0
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (hasTile(z.x + dx, z.y + dy)) tilesOn++
    }
    if (tilesOn > 0) {
      z.chargeLevel += chargeSpeed * tilesOn
      if (z.chargeLevel >= NB_CHARGE_FULL) {
        // Fire laser upward from zone center continuously!
        const laserW = st.buffs.includes('thick_beam') ? 3 : 2
        st.playerLasers.push({ col: z.x, width: laserW, timer: 2, isContinuous: true })
        z.chargeLevel = NB_CHARGE_FULL // Keep fully charged
      }
    } else {
      // Slow decay when nobody is standing on it
      z.chargeLevel = Math.max(0, z.chargeLevel - 0.3)
    }
  }

  // ── Player lasers → boss damage ──────────────────────────────────────────
  st.playerLasers = st.playerLasers.filter(l => {
    l.timer--
    if (l.isContinuous) {
      // Continuous damage (1 damage every 5 ticks to avoid instakill)
      if (l.timer === 1 && st.tick % 5 === 0) {
        for (let dx = 0; dx < l.width; dx++) {
          const lx = l.col + dx
          if (lx >= st.boss.x && lx < st.boss.x + st.boss.w) {
            st.boss.hp = Math.max(0, st.boss.hp - 1)
            break
          }
        }
      }
    } else if (l.timer === NB_LASER_TICKS - 1) {  // damage on first tick for normal lasers
      for (let dx = 0; dx < l.width; dx++) {
        const lx = l.col + dx
        if (lx >= st.boss.x && lx < st.boss.x + st.boss.w) {
          st.boss.hp = Math.max(0, st.boss.hp - 1)
          break
        }
      }
    }
    return l.timer > 0
  })

  // ── Boss AI ──────────────────────────────────────────────────────────────
  const boss = st.boss
  boss.phaseTimer--

  // Boss sway movement
  boss.moveTimer++
  if (boss.moveTimer >= Math.round(600 / TICK_MS)) {
    boss.moveTimer = 0
    boss.x += boss.moveDir
    if (boss.x <= 0 || boss.x + boss.w >= W) boss.moveDir *= -1
    boss.x = Math.max(0, Math.min(W - boss.w, boss.x))
  }

  if (boss.phaseTimer <= 0) {
    switch (boss.phase) {
      case 'idle':
        boss.phase = 'tracking'
        boss.phaseTimer = NB_TRACK_TICKS
        // Pick a random active tile column to target
        if (tiles.length > 0) {
          boss.targetCol = tiles[Math.floor(Math.random() * tiles.length)].x
        } else {
          boss.targetCol = Math.floor(Math.random() * W)
        }
        break
      case 'tracking':
        boss.phase = 'lockon'
        boss.phaseTimer = NB_LOCK_TICKS
        boss.lockedCol = boss.targetCol
        break
      case 'lockon':
        boss.phase = 'firing'
        boss.phaseTimer = NB_FIRE_TICKS
        break
      case 'firing':
        boss.phase = 'cooldown'
        boss.phaseTimer = NB_COOL_TICKS
        boss.lockedCol = null
        
        // Randomize blue squares (charge zones) positions after attack
        const numZones = st.chargeZones.length
        const spacing = Math.floor(14 / numZones)
        for (let z = 0; z < numZones; z++) {
          st.chargeZones[z].x = 1 + z * spacing + Math.floor(Math.random() * Math.max(1, spacing - 2))
          st.chargeZones[z].y = 26 + Math.floor(Math.random() * 4)
          st.chargeZones[z].chargeLevel = 0
        }
        break
      case 'cooldown':
        boss.phase = 'idle'
        boss.phaseTimer = Math.round(2000 / TICK_MS)
        break
    }
  }

  // Tracking: follow the nearest active tile
  if (boss.phase === 'tracking' && tiles.length > 0) {
    let closest = tiles[0]
    for (const t of tiles) {
      if (Math.abs(t.x - boss.targetCol) < Math.abs(closest.x - boss.targetCol)) closest = t
    }
    if (closest.x > boss.targetCol) boss.targetCol = Math.min(W - 1, boss.targetCol + 1)
    else if (closest.x < boss.targetCol) boss.targetCol = Math.max(0, boss.targetCol - 1)
  }

  // Firing: check if any active tile is in the locked column
  if (boss.phase === 'firing' && boss.lockedCol !== null && st.inv === 0) {
    const hit = tiles.some(t => t.x === boss.lockedCol || t.x === boss.lockedCol + 1)
    if (hit) {
      st.teamHp--
      st.inv = NB_INV_TICKS
    }
  }

  // ── Final boss: lava mechanic ────────────────────────────────────────────
  if (st.isFinal) {
    st.lavaTimer--
    if (st.lavaTimer <= 0) {
      st.lavaActive = !st.lavaActive
      st.lavaTimer = st.lavaActive ? Math.round(4000 / TICK_MS) : NB_LAVA_CYCLE
      if (st.lavaActive) {
        st.safeZones = [
          { x: 1 + Math.floor(Math.random() * 4),  y: 26 + Math.floor(Math.random() * 3) },
          { x: 6 + Math.floor(Math.random() * 4),  y: 26 + Math.floor(Math.random() * 3) },
          { x: 11 + Math.floor(Math.random() * 4), y: 26 + Math.floor(Math.random() * 3) },
        ]
      }
    }
    if (st.lavaActive && st.inv === 0 && st.tick % Math.round(1000 / TICK_MS) === 0) {
      // Check if any active tile is NOT on a safe zone
      const onLava = tiles.some(t => {
        return !st.safeZones.some(z =>
          t.x >= z.x && t.x < z.x + 2 && t.y >= z.y && t.y < z.y + 2
        )
      })
      if (onLava) {
        st.teamHp--
        st.inv = NB_INV_TICKS
      }
    }
  }

  // ── Check boss death ─────────────────────────────────────────────────────
  if (boss.hp <= 0) {
    stopNbLoop()
    if (st.isFinal) {
      nbPhase = 'nb_victory'
      broadcastNb({ type: 'nb_phase', phase: 'nb_victory' })
      renderNbFrame()
      setTimeout(resetNbToLobby, 6000)
    } else {
      startNbLootVote()
    }
    return
  }

  // ── Check team dead ──────────────────────────────────────────────────────
  if (st.teamHp <= 0) {
    stopNbLoop()
    nbPhase = 'nb_gameover'
    broadcastNb({ type: 'nb_phase', phase: 'nb_gameover', room: st.room })
    renderNbFrame()
    setTimeout(resetNbToLobby, 4000)
    return
  }

  // (Do not clear activeTiles here. Simulator/Hardware sends full state on changes)

  renderNbFrame()
}

function renderNbFrame() {
  if (!nbState) return
  const st = nbState
  const boss = st.boss
  const grid = Array.from({ length: H }, () => Array(W).fill('#050508'))

  // Boss sprite — color by HP percentage
  const hpPct = boss.hp / boss.maxHp
  const bossColor = hpPct > 0.6 ? '#cc00ff' : hpPct > 0.3 ? '#ff8800' : '#ff0000'
  for (let by = boss.y; by < boss.y + boss.h; by++) {
    for (let bx = boss.x; bx < boss.x + boss.w; bx++) {
      if (by >= 0 && by < H && bx >= 0 && bx < W) grid[by][bx] = bossColor
    }
  }

  // Boss HP bar (row 3)
  const hpBarLen = Math.round((boss.hp / boss.maxHp) * W)
  for (let x = 0; x < W; x++) {
    grid[3][x] = x < hpBarLen ? '#00ff41' : '#1a0000'
  }

  // Lava (final boss) — draw before charge zones so zones appear on top
  if (st.isFinal && st.lavaActive) {
    const pulse = st.tick % 3 === 0
    const lavaC = pulse ? '#ff2200' : '#cc1100'
    for (let y = 4; y < H; y++) {
      for (let x = 0; x < W; x++) grid[y][x] = lavaC
    }
    for (const z of st.safeZones) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const zy = z.y + dy, zx = z.x + dx
        if (zy < H && zx < W) grid[zy][zx] = '#00ff88'
      }
    }
  }

  // Charge zones (blue 2x2) — brightness by charge level
  for (const z of st.chargeZones) {
    const pct = z.chargeLevel / NB_CHARGE_FULL
    const bright = Math.round(0x22 + pct * (0xff - 0x22))
    const col = pct >= 1 ? '#ffffff' : `#00${bright.toString(16).padStart(2,'0')}ff`
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const zy = z.y + dy, zx = z.x + dx
      if (zy < H && zx < W) grid[zy][zx] = col
    }
  }

  // Boss laser column
  if (boss.phase === 'tracking' && boss.targetCol != null) {
    for (let y = boss.y + boss.h; y < H; y++) {
      const c1 = Math.min(boss.targetCol, W - 1)
      grid[y][c1] = '#003300'
      if (c1 + 1 < W) grid[y][c1 + 1] = '#003300'
    }
  }
  if (boss.phase === 'lockon' && boss.lockedCol != null) {
    for (let y = boss.y + boss.h; y < H; y++) {
      const c1 = Math.min(boss.lockedCol, W - 1)
      grid[y][c1] = '#663300'
      if (c1 + 1 < W) grid[y][c1 + 1] = '#663300'
    }
  }
  if (boss.phase === 'firing' && boss.lockedCol != null) {
    const pulse = st.tick % 2 === 0
    const c = pulse ? '#ff0000' : '#ff4400'
    for (let y = boss.y + boss.h; y < H; y++) {
      const c1 = Math.min(boss.lockedCol, W - 1)
      grid[y][c1] = c
      if (c1 + 1 < W) grid[y][c1 + 1] = c
    }
  }

  // Player lasers (yellow beams going up)
  for (const l of st.playerLasers) {
    const c = st.tick % 2 === 0 ? '#ffee00' : '#ffaa00'
    for (let y = 0; y < H; y++) {
      for (let dx = 0; dx < l.width; dx++) {
        const lx = l.col + dx
        if (lx >= 0 && lx < W) grid[y][lx] = c
      }
    }
  }

  // Active tiles (where people are standing) — faint white glow
  const tiles = st.activeTiles || []
  for (const t of tiles) {
    if (t.y < H && t.x < W) {
      // Don't overwrite lasers, just show a subtle indicator
      if (grid[t.y][t.x] === '#050508' || grid[t.y][t.x].startsWith('#00')) {
        grid[t.y][t.x] = '#222233'
      }
    }
  }

  sendFrameToSim(grid)
  if (displayWs?.readyState === 1) {
    displayWs.send(JSON.stringify({ type: 'nb_frame', grid,
      boss: { hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase },
      teamHp: st.teamHp, maxHp: NB_HP,
      chargeZones: st.chargeZones.map(z => ({ chargeLevel: z.chargeLevel, chargeFull: NB_CHARGE_FULL })),
      room: st.room, isFinal: st.isFinal, lavaActive: st.lavaActive,
    }))
  }
}

function renderNbVoteFrame() {
  if (!nbState) return
  const st = nbState
  const grid = Array.from({ length: H }, () => Array(W).fill('#050510'))

  if (st.voteZones) {
    for (const z of st.voteZones) {
      const pct = z.chargeLevel / NB_CHARGE_FULL
      for (let dy = 0; dy < z.h; dy++) {
        for (let dx = 0; dx < z.w; dx++) {
           const zy = z.y + dy, zx = z.x + dx
           if (zy < H && zx < W) {
               grid[zy][zx] = pct > 0.8 && (st.tick % 2 === 0) ? '#ffffff' : z.color
           }
        }
      }
    }
  }

  const tiles = st.activeTiles || []
  for (const t of tiles) {
    if (t.y < H && t.x < W) {
      if (grid[t.y][t.x] === '#050510') grid[t.y][t.x] = '#222233'
    }
  }

  sendFrameToSim(grid)
  if (displayWs?.readyState === 1) {
    displayWs.send(JSON.stringify({ type: 'nb_frame_vote', grid }))
  }
}

function startNbLoop() {
  stopNbLoop()
  nbLoopId = setInterval(tickNeonBreach, TICK_MS)
}

function stopNbLoop() {
  if (nbLoopId !== null) { clearInterval(nbLoopId); nbLoopId = null }
}

const LOOT_TABLE = [
  { id: 'rapid_charge', name: 'RAPID CHARGE', desc: '+30% charge speed', color: '#ffff00' },
  { id: 'thick_beam',   name: 'THICK BEAM',   desc: 'Laser 3 cols wide', color: '#ff8800' },
  { id: 'extra_life',   name: 'EXTRA LIFE',   desc: '+1 Team HP',        color: '#00ff88' },
  { id: 'more_zones',   name: 'MORE ZONES',   desc: '+1 charge zone',    color: '#0088ff' },
]

function startNbLootVote() {
  nbPhase = 'nb_loot_vote'
  const shuffled = [...LOOT_TABLE].sort(() => Math.random() - 0.5)
  nbState.lootOptions = shuffled.slice(0, 3)
  nbState.votes = {}
  nbState.voteParticipants = new Set()
  
  nbState.voteZones = [
    { x: 1,  y: 14, w: 3, h: 3, chargeLevel: 0, optionIdx: 0, color: nbState.lootOptions[0].color },
    { x: 6,  y: 14, w: 3, h: 3, chargeLevel: 0, optionIdx: 1, color: nbState.lootOptions[1].color },
    { x: 11, y: 14, w: 3, h: 3, chargeLevel: 0, optionIdx: 2, color: nbState.lootOptions[2].color }
  ]

  broadcastNb({ type: 'nb_phase', phase: 'nb_loot_vote', options: nbState.lootOptions })
  nbState.voteTimer = setTimeout(resolveNbLootVote, NB_VOTE_TIME)
  startNbLoop()
}

function resolveNbLootVote() {
  clearTimeout(nbState.voteTimer)
  const counts = [0, 0, 0]
  for (const v of Object.values(nbState.votes)) counts[v]++
  const maxV = Math.max(...counts)
  const tied = [0, 1, 2].filter(i => counts[i] === maxV)
  const winner = tied[Math.floor(Math.random() * tied.length)]
  const chosen = nbState.lootOptions[winner]

  if (chosen.id === 'extra_life') {
    nbState.teamHp = Math.min(nbState.teamHp + 1, NB_HP + 2)
  } else {
    nbState.buffs.push(chosen.id)
  }

  broadcastNb({ type: 'nb_phase', phase: 'nb_loot_chosen', chosen })
  setTimeout(startNbDirVote, 2000)
}

function startNbDirVote() {
  nbPhase = 'nb_dir_vote'
  nbState.votes = {}
  nbState.voteParticipants = new Set()

  nbState.voteZones = [
    { x: 1,  y: 14, w: 3, h: 3, chargeLevel: 0, dir: 'left',    color: '#ff4444' },
    { x: 6,  y: 14, w: 3, h: 3, chargeLevel: 0, dir: 'forward', color: '#ffff44' },
    { x: 11, y: 14, w: 3, h: 3, chargeLevel: 0, dir: 'right',   color: '#0088ff' }
  ]

  broadcastNb({ type: 'nb_phase', phase: 'nb_dir_vote' })
  nbState.voteTimer = setTimeout(resolveNbDirVote, NB_VOTE_TIME)
}

function resolveNbDirVote() {
  clearTimeout(nbState.voteTimer)
  const counts = { left: 0, forward: 0, right: 0 }
  for (const v of Object.values(nbState.votes)) counts[v] = (counts[v] || 0) + 1
  const maxV = Math.max(counts.left, counts.forward, counts.right)
  const tied = ['left', 'forward', 'right'].filter(d => counts[d] === maxV)
  const dir = tied[Math.floor(Math.random() * tied.length)]

  const nextRoom = nbState.room + 1
  broadcastNb({ type: 'nb_phase', phase: 'nb_next_room', dir, room: nextRoom })
  setTimeout(() => {
    initNbRoom(nextRoom)
    nbPhase = 'nb_playing'
    broadcastNb({ type: 'nb_phase', phase: 'nb_playing', room: nextRoom, isFinal: nextRoom >= 3 })
    // Loop continues running automatically since we didn't stop it!
  }, 3000)
}

function resetNbToLobby() {
  stopNbLoop()
  if (nbState?.voteTimer) clearTimeout(nbState.voteTimer)
  nbState = null
  nbPhase = 'nb_lobby'
  broadcastNb({ type: 'nb_phase', phase: 'nb_lobby' })
}

function joinTeam(ws, teamNum, name) {
  teams[teamNum].add(ws)
  wsInfo.set(ws, { team: teamNum, name })
}

function leaveTeam(ws) {
  const info = wsInfo.get(ws)
  if (!info) return null
  teams[info.team].delete(ws)
  wsInfo.delete(ws)
  return info.team
}

// ── Game phase state (server is source of truth for lobby/vote) ────────────
let phase      = 'lobby'
let currentMapIdx = 0
const teamReady = { 1: false, 2: false }
let mapVotes    = [0, 0, 0]
const mapVoteBy = { 1: null, 2: null }
let voteTimer   = null

const MAPS = GAME_MAPS  // full map objects with colors

function teamCounts() {
  return { p1: teams[1].size, p2: teams[2].size }
}

// Send to everyone (phones + display)
function broadcastAll(obj) {
  const str = JSON.stringify(obj)
  for (const c of clients) {
    if (c.readyState === 1) c.send(str)
  }
}

// Send only to phones (exclude display)
function broadcastPhones(obj) {
  const str = JSON.stringify(obj)
  for (const c of clients) {
    if (c !== displayWs && c.readyState === 1) c.send(str)
  }
}

// Send only to display
function sendDisplay(obj) {
  if (displayWs?.readyState === 1) displayWs.send(JSON.stringify(obj))
}

function sendLobbyPhase(target) {
  const msg = {
    type: 'game_phase', phase: 'lobby',
    ready:  { p1: teamReady[1], p2: teamReady[2] },
    counts: teamCounts(),
  }
  if (target) target.send(JSON.stringify(msg))
  else broadcastAll(msg)
}

function resolveVote() {
  clearTimeout(voteTimer); voteTimer = null
  const maxV = Math.max(...mapVotes)
  const tied = [0,1,2].filter(i => mapVotes[i] === maxV)
  const mapIdx = tied[Math.floor(Math.random() * tied.length)]
  phase = 'playing'
  currentMapIdx = mapIdx
  console.log(`  Map resolved: ${MAPS[mapIdx].id}`)
  broadcastAll({ type: 'game_phase', phase: 'playing', mapIdx })
  startGameLoop(mapIdx)
}

function startVote() {
  phase = 'vote'
  mapVotes = [0, 0, 0]
  mapVoteBy[1] = null
  mapVoteBy[2] = null
  broadcastAll({ type: 'game_phase', phase: 'vote', countdown: 10 })
  voteTimer = setTimeout(resolveVote, 10000)
}

function resetToLobby() {
  stopGameLoop()
  gameState = null
  clearTimeout(voteTimer); voteTimer = null
  phase = 'lobby'
  teamReady[1] = false
  teamReady[2] = false
  mapVotes = [0, 0, 0]
  mapVoteBy[1] = null
  mapVoteBy[2] = null
  sendLobbyPhase(null)  // broadcast to all
}

// ── WebSocket connections ──────────────────────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws)
  console.log(`+ connected (${clients.size} total)`)

  ws.on('message', raw => {
    const str = raw.toString()
    let m
    try { m = JSON.parse(str) } catch { return }

    // ── Display registration ─────────────────────────────────────────────
    if (m.type === 'display_connect') {
      displayWs = ws
      console.log('  display registered')
      // Sync current phase to display so it works even if it connects mid-game
      if (phase === 'lobby')   sendLobbyPhase(ws)
      else if (phase === 'vote')    ws.send(JSON.stringify({ type: 'game_phase', phase: 'vote', countdown: 10 }))
      else if (phase === 'playing') ws.send(JSON.stringify({ type: 'game_phase', phase: 'playing', mapIdx: currentMapIdx }))
      return
    }

    // ── Phone joins a team ───────────────────────────────────────────────
    if (m.type === 'hello') {
      const teamNum = m.team === 2 ? 2 : 1
      joinTeam(ws, teamNum, m.name || 'Player')
      const count = teams[teamNum].size
      console.log(`  Team ${teamNum} joined: "${m.name}" (${count} on team)`)

      // Tell phone which team it got and send current phase
      ws.send(JSON.stringify({ type: 'assigned', player: teamNum }))

      // Notify display of new team member
      sendDisplay({ type: 'player_joined', player: teamNum, name: m.name, count })

      // Send current phase to the new phone
      if (phase === 'lobby') {
        ws.send(JSON.stringify({
          type: 'game_phase', phase: 'lobby',
          ready:  { p1: teamReady[1], p2: teamReady[2] },
          counts: teamCounts(),
        }))
      } else if (phase === 'vote') {
        ws.send(JSON.stringify({ type: 'game_phase', phase: 'vote', countdown: 10 }))
      } else if (phase === 'playing') {
        ws.send(JSON.stringify({ type: 'game_phase', phase: 'playing' }))
      }
      return
    }

    // ── Ready up (server manages this) ──────────────────────────────────
    if (m.type === 'ready_up') {
      if (phase !== 'lobby') return
      const teamNum = m.player
      if (teamReady[teamNum]) return  // already ready
      teamReady[teamNum] = true
      console.log(`  Team ${teamNum} ready  (${teamReady[1] ? '✓' : '·'} ${teamReady[2] ? '✓' : '·'})`)
      if (teamReady[1] && teamReady[2]) {
        startVote()
      } else {
        // Broadcast updated lobby state so all clients see ready status
        sendLobbyPhase(null)
      }
      return
    }

    // ── Map vote (server manages this) ──────────────────────────────────
    if (m.type === 'vote_map') {
      if (phase !== 'vote') return
      const teamNum = m.player
      if (mapVoteBy[teamNum] !== null) return  // already voted
      mapVoteBy[teamNum] = m.mapIdx
      mapVotes[m.mapIdx]++
      console.log(`  Team ${teamNum} voted: map ${m.mapIdx}`)
      if (mapVoteBy[1] !== null && mapVoteBy[2] !== null) resolveVote()
      return
    }

    // ── Phone shoots (server handles game logic) ─────────────────────────
    if (m.type === 'shoot') {
      if (phase === 'playing' && gameState) tryShoot(m.player, m.dx, m.dy)
      // Also relay to display so its local game engine stays in sync
      sendDisplay(m)
      return
    }

    // ── Phone knifes ────────────────────────────────────────────────────
    if (m.type === 'knife') {
      if (phase === 'playing' && gameState) tryKnife(m.player)
      sendDisplay(m)
      return
    }

    // ── Musical Chairs: player join ──────────────────────────────────────
    if (m.type === 'mc_join') {
      const id = randomUUID()
      const info = { id, name: m.name || 'Player', color: m.color || '#ff4444' }
      mcPlayers.set(ws, info)
      ws.send(JSON.stringify({ type: 'mc_assigned', id }))
      sendDisplay({ type: 'mc_player_joined', id, name: info.name, color: info.color })
      console.log(`  MC player joined: "${info.name}" (${mcPlayers.size} total)`)
      return
    }

    // ── Musical Chairs: key input (add player id before relay) ───────────
    if (m.type === 'mc_key') {
      const info = mcPlayers.get(ws)
      if (!info) return
      sendDisplay({ type: 'mc_key', id: info.id, dir: m.dir, down: m.down })
      return
    }

    // ── NeonBreach: start game (from display or any client) ────────────
    if (m.type === 'nb_start') {
      if (nbPhase !== 'nb_lobby') return
      nbPhase = 'nb_playing'
      initNbRoom(0)
      broadcastNb({ type: 'nb_phase', phase: 'nb_playing', room: 0, isFinal: false })
      startNbLoop()
      console.log('  NB game started')
      return
    }

    // ── NeonBreach: loot vote (from display — tile-based voting) ─────────
    if (m.type === 'nb_vote_loot') {
      if (nbPhase !== 'nb_loot_vote' || !nbState) return
      const voterId = m.voterId || randomUUID()
      nbState.votes[voterId] = m.choice
      return
    }

    // ── NeonBreach: direction vote ───────────────────────────────────────
    if (m.type === 'nb_vote_dir') {
      if (nbPhase !== 'nb_dir_vote' || !nbState) return
      const voterId = m.voterId || randomUUID()
      nbState.votes[voterId] = m.choice
      return
    }

    // ── Direct Simulation Frame from Display ─────────────────────────────
    if (m.type === 'sim_frame') {
      if (m.grid) sendFrameToSim(m.grid)
      return
    }

    // ── Everything else: relay between display and phones ────────────────
    for (const c of clients) {
      if (c !== ws && c.readyState === 1) c.send(str)
    }
  })

  ws.on('close', () => {
    const team = leaveTeam(ws)
    if (displayWs === ws) displayWs = null

    // MC player disconnect
    const mcInfo = mcPlayers.get(ws)
    if (mcInfo) {
      mcPlayers.delete(ws)
      sendDisplay({ type: 'mc_player_left', id: mcInfo.id })
      console.log(`  MC player left: "${mcInfo.name}" (${mcPlayers.size} remaining)`)
    }

    clients.delete(ws)
    console.log(`- disconnected (${clients.size} total)`)

    if (team !== null) {
      const count = teams[team].size
      console.log(`  Team ${team} now has ${count} players`)
      sendDisplay({ type: 'player_left', player: team, count })

      // If a team goes empty during lobby, clear their ready state
      if (count === 0 && phase === 'lobby') {
        teamReady[team] = false
        sendLobbyPhase(null)
      }
      // If a team goes empty during vote/playing, reset to lobby
      if (count === 0 && (phase === 'vote' || phase === 'playing')) {
        console.log(`  Team ${team} empty — resetting to lobby`)
        resetToLobby()
      }
    }
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP()
  console.log(`\n  Game relay server ready`)
  console.log(`  Display  → http://localhost:${PORT}`)
  console.log(`  Phone    → http://${ip}:${PORT}\n`)
})
