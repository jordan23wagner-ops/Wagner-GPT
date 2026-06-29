import React, { useReducer, useEffect, useState } from 'react'
import { Eraser, Trash2 } from 'lucide-react'
import {
  gardenReducer, initialGarden, key,
  GRID_COLS, GRID_ROWS, PLANTS, DECORATIONS,
  tileEmoji, growthStage, growthProgress,
} from './gardenReducer'

const STORAGE_KEY = 'gardenState'

// Tool is one of: { kind, decoration } for placing, or the string 'erase'.
const DEFAULT_TOOL = { kind: 'daisy', decoration: false }

export default function Garden({ darkMode }) {
  const [state, dispatch] = useReducer(gardenReducer, initialGarden)
  const [tool, setTool] = useState(DEFAULT_TOOL)
  const [now, setNow] = useState(() => Date.now())
  const [loaded, setLoaded] = useState(false)

  // Load saved garden once.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) dispatch({ type: 'LOAD', state: JSON.parse(saved) })
    } catch { /* ignore corrupt state */ }
    setLoaded(true)
  }, [])

  // Persist after every change (once initial load is done).
  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state, loaded])

  // Re-render periodically so timestamp-derived growth advances on screen.
  // The canonical state stays timestamp-based; this only nudges a repaint.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20000)
    return () => clearInterval(id)
  }, [])

  const isErase = tool === 'erase'

  const handleTile = (row, col) => {
    const k = key(row, col)
    const occupied = !!state.tiles[k]
    if (isErase) {
      if (occupied) dispatch({ type: 'REMOVE', row, col })
      return
    }
    if (!occupied) {
      setNow(Date.now())
      dispatch({ type: 'PLANT', row, col, kind: tool.kind, decoration: tool.decoration, now: Date.now() })
    }
  }

  const clearGarden = () => {
    if (window.confirm('Clear the whole garden and start fresh?')) {
      dispatch({ type: 'CLEAR' })
    }
  }

  const toolSelected = (kind, decoration) =>
    !isErase && tool.kind === kind && tool.decoration === decoration

  const cardBg = darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
  const subText = darkMode ? 'text-gray-400' : 'text-gray-500'

  return (
    <div className={`flex-1 overflow-y-auto ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
      <div className="max-w-md mx-auto p-4 space-y-4">

        {/* The plot */}
        <div className={`rounded-2xl p-2 border ${darkMode ? 'bg-green-950/40 border-green-900' : 'bg-green-100 border-green-200'}`}>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: GRID_ROWS }).map((_, row) =>
              Array.from({ length: GRID_COLS }).map((__, col) => {
                const tile = state.tiles[key(row, col)]
                const emoji = tileEmoji(tile, now)
                const stage = growthStage(tile, now)
                const opacity = stage === 'seed' ? 'opacity-60' : stage === 'sprout' ? 'opacity-90' : 'opacity-100'
                return (
                  <button
                    key={key(row, col)}
                    onClick={() => handleTile(row, col)}
                    aria-label={tile ? `tile ${row},${col} (${tile.kind})` : `empty tile ${row},${col}`}
                    className={`aspect-square rounded-lg flex items-center justify-center text-2xl sm:text-3xl leading-none select-none transition-colors ${
                      darkMode
                        ? 'bg-green-900/40 active:bg-green-800/60'
                        : 'bg-green-200/70 active:bg-green-300'
                    }`}
                  >
                    <span className={opacity}>{emoji}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Palette */}
        <div className={`rounded-2xl border p-3 space-y-3 ${cardBg}`}>
          <PaletteRow
            label="Plants"
            items={Object.entries(PLANTS)}
            decoration={false}
            darkMode={darkMode}
            isSelected={toolSelected}
            onPick={(kind) => setTool({ kind, decoration: false })}
          />
          <PaletteRow
            label="Decorations"
            items={Object.entries(DECORATIONS)}
            decoration={true}
            darkMode={darkMode}
            isSelected={toolSelected}
            onPick={(kind) => setTool({ kind, decoration: true })}
          />

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setTool('erase')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border ${
                isErase
                  ? 'bg-red-500 text-white border-red-500'
                  : darkMode
                    ? 'bg-gray-700 text-gray-200 border-gray-600'
                    : 'bg-gray-100 text-gray-700 border-gray-200'
              }`}
            >
              <Eraser size={16} /> Remove plant
            </button>
            <button
              onClick={clearGarden}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border ${
                darkMode ? 'bg-gray-700 text-gray-300 border-gray-600' : 'bg-gray-100 text-gray-600 border-gray-200'
              }`}
            >
              <Trash2 size={16} /> Clear
            </button>
          </div>

          <p className={`text-xs leading-relaxed ${subText}`}>
            Pick a plant or decoration, then tap a tile to place it. Plants grow over
            real time: 🌰 seed → 🌱 sprout → bloom (daisies are quickest, trees take a
            day). Decorations are permanent; use <span className="font-medium">Remove plant</span> to clear a plant.
          </p>
        </div>
      </div>
    </div>
  )
}

function PaletteRow({ label, items, decoration, darkMode, isSelected, onPick }) {
  return (
    <div>
      <div className={`text-xs font-semibold mb-1.5 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
      <div className="flex flex-wrap gap-2">
        {items.map(([kind, def]) => {
          const selected = isSelected(kind, decoration)
          return (
            <button
              key={kind}
              onClick={() => onPick(kind)}
              title={def.label}
              aria-label={def.label}
              className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl border-2 transition-colors ${
                selected
                  ? 'border-blue-500 ' + (darkMode ? 'bg-blue-500/20' : 'bg-blue-50')
                  : darkMode
                    ? 'border-gray-700 bg-gray-700/40 active:bg-gray-700'
                    : 'border-gray-200 bg-gray-50 active:bg-gray-100'
              }`}
            >
              {def.emoji}
            </button>
          )
        })}
      </div>
    </div>
  )
}
