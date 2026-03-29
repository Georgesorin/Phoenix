import { useState, useEffect, useRef, useCallback } from 'react'

const W = 16, H = 32

export default function NeonBreachGame() {
  const [phase, setPhase] = useState('nb_lobby')
  const [grid, setGrid] = useState(() => Array.from({ length: H }, () => Array(W).fill('#050508')))
  const [bossInfo, setBossInfo] = useState({ hp: 100, maxHp: 100, phase: 'idle' })
  const [teamHp, setTeamHp] = useState(3)
  const [maxHp, setMaxHp] = useState(3)
  const [chargeZones, setChargeZones] = useState([])
  const [room, setRoom] = useState(0)
  const [isFinal, setIsFinal] = useState(false)
  const [lavaActive, setLavaActive] = useState(false)
  const [voteOptions, setVoteOptions] = useState([])
  const [voteTitle, setVoteTitle] = useState('')
  const [resultText, setResultText] = useState({ title: '', sub: '', color: '#cc00ff' })
  const [chosenLoot, setChosenLoot] = useState(null)
  const wsRef = useRef(null)
  const musicRef = useRef(null)

  // ── Music ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'nb_playing') {
      if (musicRef.current) {
        musicRef.current.pause()
        musicRef.current.currentTime = 0
      }
      const audio = new Audio('/boss_fight.mp3')
      audio.loop = true
      audio.volume = 0.5
      audio.play().catch(e => console.log('Audio autoplay blocked', e))
      musicRef.current = audio
    } else {
      if (musicRef.current) {
        musicRef.current.pause()
      }
    }
  }, [phase])

  const sendMsg = useCallback((obj) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
  }, [])

  // ── WebSocket ───────────────────────────────────────────────────────────────
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

            if (m.type === 'nb_phase') {
              setPhase(m.phase)
              if (m.room !== undefined) setRoom(m.room)
              if (m.isFinal !== undefined) setIsFinal(m.isFinal)
              if (m.phase === 'nb_loot_vote' && m.options) {
                setVoteTitle('CHOOSE UPGRADE')
                setVoteOptions(m.options)
              }
              if (m.phase === 'nb_loot_chosen' && m.chosen) {
                setChosenLoot(m.chosen)
                setTimeout(() => setChosenLoot(null), 2000)
              }
              if (m.phase === 'nb_dir_vote') {
                setVoteTitle('CHOOSE PATH')
                setVoteOptions([
                  { name: 'LEFT — FAST', desc: 'More attacks, less HP', color: '#ff4444' },
                  { name: 'FORWARD', desc: 'Balanced', color: '#ffff44' },
                  { name: 'RIGHT — TANK', desc: 'Fewer attacks, more HP', color: '#0088ff' },
                ])
              }
              if (m.phase === 'nb_next_room') {
                setResultText({ title: `ROOM ${(m.room || 0) + 1}`, sub: `heading ${m.dir}…`, color: '#cc00ff' })
              }
              if (m.phase === 'nb_gameover') {
                setResultText({ title: 'DEFEATED', sub: `reached room ${(m.room || 0) + 1}`, color: '#ff0000' })
              }
              if (m.phase === 'nb_victory') {
                setResultText({ title: 'VICTORY!', sub: 'all bosses defeated', color: '#00ff41' })
              }
            }

            if (m.type === 'nb_frame') {
              if (m.grid) setGrid(m.grid)
              if (m.boss) setBossInfo(m.boss)
              if (m.teamHp !== undefined) setTeamHp(m.teamHp)
              if (m.maxHp !== undefined) setMaxHp(m.maxHp)
              if (m.chargeZones) setChargeZones(m.chargeZones)
              if (m.room !== undefined) setRoom(m.room)
              if (m.isFinal !== undefined) setIsFinal(m.isFinal)
              if (m.lavaActive !== undefined) setLavaActive(m.lavaActive)
            }
          } catch {}
        }
        ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; if (alive) setTimeout(connect, 2000) }
        ws.onerror = () => ws.close()
      } catch {}
    }
    connect()
    return () => { alive = false; ws?.close() }
  }, [])

  const hpPct = bossInfo.maxHp > 0 ? bossInfo.hp / bossInfo.maxHp : 0
  const bossBarColor = hpPct > 0.6 ? '#cc00ff' : hpPct > 0.3 ? '#ff8800' : '#ff0000'

  // ── Lobby ────────────────────────────────────────────────────────────────────
  if (phase === 'nb_lobby') {
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          <div className="vote-title" style={{ color: '#cc00ff', fontSize: 28, letterSpacing: 6 }}>NEON BREACH</div>
          <div style={{ color: '#555', fontSize: 12, letterSpacing: 3, marginTop: 8 }}>COOPERATIVE BOSS FIGHT</div>
          <div style={{ color: '#666', fontSize: 11, marginTop: 16 }}>
            Players stand on the floor tiles to play
          </div>
          <button
            onClick={() => sendMsg({ type: 'nb_start' })}
            style={{
              marginTop: 24, padding: '16px 40px', borderRadius: 12,
              border: '2px solid #cc00ff', background: '#1a0028', color: '#cc00ff',
              fontFamily: 'inherit', fontSize: 16, fontWeight: 'bold', letterSpacing: 4,
              cursor: 'pointer',
            }}
          >
            START RAID
          </button>
        </div>
      </div>
    )
  }

  // ── Vote screens ─────────────────────────────────────────────────────────────
  if (phase === 'nb_loot_vote' || phase === 'nb_dir_vote') {
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          <div className="vote-title" style={{ color: '#cc00ff' }}>{voteTitle}</div>
          <div style={{ marginTop: 16, display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            {voteOptions.map((opt, i) => (
              <div key={i} style={{
                padding: '16px 20px', borderRadius: 12, border: `2px solid ${opt.color || '#cc00ff'}`,
                background: '#0a0a14', minWidth: 140, textAlign: 'center',
              }}>
                <div style={{ color: opt.color || '#cc00ff', fontWeight: 'bold', letterSpacing: 2, fontSize: 14 }}>{opt.name}</div>
                {opt.desc && <div style={{ color: '#555', fontSize: 11, marginTop: 4 }}>{opt.desc}</div>}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, color: '#444', fontSize: 11, letterSpacing: 2 }}>auto-resolves in 10s</div>
          {chosenLoot && (
            <div style={{ marginTop: 16, color: chosenLoot.color, fontSize: 16, fontWeight: 'bold', letterSpacing: 3 }}>
              CHOSEN: {chosenLoot.name}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (phase === 'nb_loot_chosen') {
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          {chosenLoot && (
            <div style={{ color: chosenLoot.color, fontSize: 20, fontWeight: 'bold', letterSpacing: 3 }}>
              {chosenLoot.name}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Result screens ──────────────────────────────────────────────────────────
  if (phase === 'nb_gameover' || phase === 'nb_victory' || phase === 'nb_next_room') {
    return (
      <div className="shooter-wrap">
        <div className="vote-screen">
          <div className="vote-title" style={{ color: resultText.color, fontSize: 28 }}>{resultText.title}</div>
          <div style={{ color: '#555', fontSize: 12, marginTop: 8 }}>{resultText.sub}</div>
        </div>
      </div>
    )
  }

  // ── Playing ──────────────────────────────────────────────────────────────────
  return (
    <div className="shooter-wrap">
      <div className="shooter-hud" style={{ justifyContent: 'center', gap: 16 }}>
        {/* Boss info */}
        <div style={{ flex: 1, maxWidth: 400 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ color: '#cc00ff', fontSize: 11, letterSpacing: 2 }}>
              BOSS {isFinal ? '(FINAL)' : `ROOM ${room + 1}`}
            </span>
            <span style={{ color: '#555', fontSize: 10 }}>{bossInfo.hp}/{bossInfo.maxHp}</span>
          </div>
          <div style={{ width: '100%', height: 8, background: '#1a0000', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${hpPct * 100}%`, height: '100%', background: bossBarColor, transition: 'width .1s' }} />
          </div>
          {bossInfo.phase === 'tracking' && (
            <div style={{ color: '#00ff00', fontSize: 10, textAlign: 'center', marginTop: 4, letterSpacing: 2 }}>TRACKING</div>
          )}
          {bossInfo.phase === 'lockon' && (
            <div className="blink" style={{ color: '#ff8800', fontSize: 10, textAlign: 'center', marginTop: 4, letterSpacing: 2 }}>LOCK ON!</div>
          )}
          {bossInfo.phase === 'firing' && (
            <div className="blink" style={{ color: '#ff0000', fontSize: 10, textAlign: 'center', marginTop: 4, letterSpacing: 2 }}>FIRE!!</div>
          )}
        </div>

        {/* Team HP */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#888', fontSize: 9, letterSpacing: 2, marginBottom: 2 }}>TEAM HP</div>
          <div style={{ fontSize: 18 }}>
            {Array.from({ length: maxHp }, (_, i) => (
              <span key={i} style={{ color: i < teamHp ? '#cc00ff' : '#1a1a1a' }}>{'\u2665'}</span>
            ))}
          </div>
        </div>

        {/* Charge indicators */}
        {chargeZones.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            {chargeZones.map((z, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ color: '#0088ff', fontSize: 8, letterSpacing: 1 }}>Z{i + 1}</div>
                <div style={{ width: 24, height: 4, background: '#001133', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, (z.chargeLevel / z.chargeFull) * 100)}%`,
                    height: '100%',
                    background: z.chargeLevel >= z.chargeFull ? '#ffee00' : '#0088ff',
                  }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lavaActive && (
        <div className="blink" style={{ color: '#ff4400', fontSize: 11, textAlign: 'center', letterSpacing: 3, padding: '4px 0' }}>
          LAVA — GET TO SAFE ZONES
        </div>
      )}

      <div className="matrix shooter-matrix">
        {grid.map((row, y) => row.map((color, x) => (
          <div key={`${y}-${x}`} className="pixel" style={{ background: color || '#050508' }} />
        )))}
      </div>

      <div className="game-legend">
        <span style={{ color: '#0088ff' }}>&#9632;</span> charge zone &nbsp;·&nbsp;
        <span style={{ color: '#00ff00' }}>|</span> tracking &nbsp;·&nbsp;
        <span style={{ color: '#ff8800' }}>|</span> locked &nbsp;·&nbsp;
        <span style={{ color: '#ff0000' }}>|</span> fire &nbsp;·&nbsp;
        stand on blue to charge laser
      </div>
    </div>
  )
}
