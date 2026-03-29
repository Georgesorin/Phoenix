import { useState } from 'react'
import MatrixDraw from './MatrixDraw'
import ShooterGame from '../../Shooter/ShooterGame'
import MusicalChairs from '../../MusicalChairs/MusicalChairs'
import NeonBreachGame from '../../NeonBreach/NeonBreachGame'
import './App.css'

const MODES = [
  { id: 'draw',    label: '🎨 Draw' },
  { id: 'shooter', label: '🔫 Shooter' },
  { id: 'chairs',  label: '🪑 Musical Chairs' },
  { id: 'breach',  label: '⚡ Neon Breach' },
]

export default function App() {
  const [mode, setMode] = useState('shooter')

  return (
    <div className="app">
      <div className="mode-bar">
        {MODES.map(m => (
          <button
            key={m.id}
            className={`mode-btn ${mode === m.id ? 'active' : ''}`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'draw'    && <MatrixDraw />}
      {mode === 'shooter' && <ShooterGame />}
      {mode === 'chairs'  && <MusicalChairs />}
      {mode === 'breach'  && <NeonBreachGame />}
    </div>
  )
}
