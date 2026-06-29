import React, { useReducer, useEffect, useState, useRef } from 'react'
import { Eraser, Trash2, Coins, Sparkles, Lock } from 'lucide-react'
import {
  gardenReducer, initialGarden, key,
  PLOT_ROWS, PLOT_COLS, MAX_PLOTS, plotPrice,
  CATS, SPECIES, SPECIES_BY_ID, DECORATIONS,
  tileEmoji, growthStage, isHarvestable,
} from './gardenReducer'
import { hasSupabase } from './lib/supabase'
import { syncGardenDown, syncGardenUp } from './lib/sync'

const STORAGE_KEY = 'gardenState'

const coinLabel = (n) => (n === 0 ? 'Free' : `🪙 ${n}`)

export default function Garden({ darkMode }) {
  const [state, dispatch] = useReducer(gardenReducer, initialGarden)
  // Active tool: { type:'seed', id } | { type:'deco', kind } | { type:'erase' }
  const [tool, setTool] = useState({ type: 'seed', id: SPECIES.flowers[0].id })
  // Current selection in each category dropdown.
  const [picks, setPicks] = useState({
    flowers: SPECIES.flowers[0].id,
    plants: SPECIES.plants[0].id,
    bushes: SPECIES.bushes[0].id,
    trees: SPECIES.trees[0].id,
    deco: Object.keys(DECORATIONS)[0],
  })
  const [now, setNow] = useState(() => Date.now())
  const [loaded, setLoaded] = useState(false)
  const [flash, setFlash] = useState(null)

  useEffect(() => {
    const init = async () => {
      let local = null
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) local = JSON.parse(saved)
      } catch { /* ignore corrupt state */ }
      // Merge with Supabase (latest wins), then load into reducer.
      const merged = await syncGardenDown(local)
      if (merged) dispatch({ type: 'LOAD', state: merged })
      setLoaded(true)
    }
    init()
  }, [])

  // Persist locally + push to Supabase (debounced).
  const gardenPushRef = useRef(null)
  useEffect(() => {
    if (!loaded) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    if (!hasSupabase) return
    clearTimeout(gardenPushRef.current)
    gardenPushRef.current = setTimeout(() => syncGardenUp(state), 2000)
  }, [state, loaded])

  // Repaint periodically so timestamp-derived growth advances on screen.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20000)
    return () => clearInterval(id)
  }, [])

  const showFlash = (msg) => {
    setFlash(msg)
    setTimeout(() => setFlash((m) => (m === msg ? null : m)), 1600)
  }

  const handleTile = (plot, row, col) => {
    const tile = state.tiles[key(plot, row, col)]
    const ts = Date.now()
    setNow(ts)

    if (tool.type === 'erase') {
      if (tile) dispatch({ type: 'REMOVE', plot, row, col })
      return
    }

    // Empty tile: plant a seed or place a decoration.
    if (!tile) {
      if (tool.type === 'deco') {
        dispatch({ type: 'PLACE_DECORATION', plot, row, col, kind: tool.kind })
        return
      }
      const def = SPECIES_BY_ID[tool.id]
      if (!def) return
      if (state.coins < def.cost) {
        showFlash(`Not enough coins for ${def.name} (needs 🪙 ${def.cost})`)
        return
      }
      dispatch({ type: 'PLANT', plot, row, col, id: def.id, now: ts })
      return
    }

    // Occupied: harvest if a plant is ripe; otherwise leave it be.
    if (!tile.decoration && isHarvestable(tile, ts)) {
      const def = SPECIES_BY_ID[tile.id]
      dispatch({ type: 'HARVEST', plot, row, col, now: ts })
      if (def) showFlash(`Harvested ${def.name} — +🪙 ${def.value}`)
    }
  }

  const harvestAll = () => {
    const ts = Date.now()
    setNow(ts)
    dispatch({ type: 'HARVEST_ALL', now: ts })
  }

  const buyPlot = () => {
    const price = plotPrice(state.plots)
    if (price == null) return
    if (state.coins < price) { showFlash(`Need 🪙 ${price} for the next plot`); return }
    dispatch({ type: 'BUY_PLOT' })
  }

  const clearGarden = () => {
    if (window.confirm('Clear all plants? (You keep your coins and plots.)')) {
      dispatch({ type: 'CLEAR' })
    }
  }

  const pickSeed = (cat, id) => {
    setPicks((p) => ({ ...p, [cat]: id }))
    setTool({ type: 'seed', id })
  }
  const pickDeco = (kind) => {
    setPicks((p) => ({ ...p, deco: kind }))
    setTool({ type: 'deco', kind })
  }

  // How many ripe plants are waiting.
  const ripeCount = Object.values(state.tiles).filter((t) => isHarvestable(t, now)).length

  const cardBg = darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
  const subText = darkMode ? 'text-gray-400' : 'text-gray-500'
  const nextPlotPrice = plotPrice(state.plots)

  // Active-tool description for the banner.
  let activeLabel
  if (tool.type === 'erase') activeLabel = '🧺 Dig up — tap a tile to clear it'
  else if (tool.type === 'deco') activeLabel = `${DECORATIONS[tool.kind]?.emoji} ${DECORATIONS[tool.kind]?.label} — tap an empty tile`
  else {
    const d = SPECIES_BY_ID[tool.id]
    activeLabel = d ? `${d.emoji} ${d.name} (${coinLabel(d.cost)}) — tap an empty tile` : ''
  }

  return (
    <div className={`flex-1 overflow-y-auto ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
      <div className="max-w-md mx-auto p-4 space-y-4">

        {/* Coins + harvest-all */}
        <div className={`rounded-2xl border p-3 flex items-center justify-between ${cardBg}`}>
          <div className="flex items-center gap-2">
            <Coins size={20} className="text-yellow-500" />
            <span className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {state.coins.toLocaleString()}
            </span>
            <span className={`text-xs ${subText}`}>coins</span>
          </div>
          <button
            onClick={harvestAll}
            disabled={ripeCount === 0}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 ${
              ripeCount === 0
                ? darkMode ? 'bg-gray-700 text-gray-500' : 'bg-gray-100 text-gray-400'
                : 'bg-green-500 text-white hover:bg-green-600'
            }`}
          >
            <Sparkles size={16} /> Harvest all{ripeCount > 0 ? ` (${ripeCount})` : ''}
          </button>
        </div>

        {/* Plots */}
        {Array.from({ length: state.plots }).map((_, plot) => (
          <div
            key={plot}
            className={`rounded-2xl p-2 border ${darkMode ? 'bg-green-950/40 border-green-900' : 'bg-green-100 border-green-200'}`}
          >
            <div className={`text-[11px] font-semibold px-1 pb-1 ${darkMode ? 'text-green-300/70' : 'text-green-700/70'}`}>
              Plot {plot + 1}
            </div>
            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${PLOT_COLS}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: PLOT_ROWS }).map((_, row) =>
                Array.from({ length: PLOT_COLS }).map((__, col) => {
                  const tile = state.tiles[key(plot, row, col)]
                  const emoji = tileEmoji(tile, now)
                  const stage = growthStage(tile, now)
                  const ripe = stage === 'bloom'
                  const opacity = stage === 'seed' ? 'opacity-60' : stage === 'sprout' ? 'opacity-90' : 'opacity-100'
                  return (
                    <button
                      key={key(plot, row, col)}
                      onClick={() => handleTile(plot, row, col)}
                      aria-label={tile ? `plot ${plot + 1} tile ${row},${col}` : `empty tile`}
                      className={`aspect-square rounded-lg flex items-center justify-center text-2xl sm:text-3xl leading-none select-none transition-colors ${
                        ripe ? 'ring-2 ring-yellow-400 animate-pulse ' : ''
                      }${
                        darkMode ? 'bg-green-900/40 active:bg-green-800/60' : 'bg-green-200/70 active:bg-green-300'
                      }`}
                    >
                      <span className={opacity}>{emoji}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        ))}

        {/* Buy plot */}
        {state.plots < MAX_PLOTS && (
          <button
            onClick={buyPlot}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed text-sm font-medium ${
              state.coins >= nextPlotPrice
                ? darkMode ? 'border-green-700 text-green-300 hover:bg-green-900/30' : 'border-green-400 text-green-700 hover:bg-green-50'
                : darkMode ? 'border-gray-700 text-gray-500' : 'border-gray-300 text-gray-400'
            }`}
          >
            {state.coins >= nextPlotPrice ? '+' : <Lock size={14} />} Buy Plot {state.plots + 1} — 🪙 {nextPlotPrice.toLocaleString()}
          </button>
        )}

        {/* Active tool banner */}
        <div className={`rounded-xl px-3 py-2 text-sm ${darkMode ? 'bg-gray-800 text-gray-200' : 'bg-gray-100 text-gray-700'}`}>
          {flash ? <span className="font-medium text-yellow-600 dark:text-yellow-400">{flash}</span> : activeLabel}
        </div>

        {/* Seed shop */}
        <div className={`rounded-2xl border p-3 space-y-3 ${cardBg}`}>
          <div className={`text-xs font-semibold ${subText}`}>Seed shop — pick one, then tap an empty tile</div>
          {Object.keys(CATS).map((cat) => (
            <SeedDropdown
              key={cat}
              label={CATS[cat].label}
              cat={cat}
              species={SPECIES[cat]}
              value={picks[cat]}
              active={tool.type === 'seed' && SPECIES_BY_ID[tool.id]?.cat === cat}
              coins={state.coins}
              darkMode={darkMode}
              onPick={pickSeed}
            />
          ))}

          {/* Decorations */}
          <div>
            <div className={`text-xs font-medium mb-1 ${subText}`}>Decorations (free)</div>
            <select
              value={picks.deco}
              onChange={(e) => pickDeco(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg text-sm border ${
                tool.type === 'deco' ? 'ring-2 ring-blue-400 ' : ''
              }${darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
            >
              {Object.entries(DECORATIONS).map(([kind, def]) => (
                <option key={kind} value={kind}>{def.emoji} {def.label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setTool({ type: 'erase' })}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border ${
                tool.type === 'erase'
                  ? 'bg-red-500 text-white border-red-500'
                  : darkMode ? 'bg-gray-700 text-gray-200 border-gray-600' : 'bg-gray-100 text-gray-700 border-gray-200'
              }`}
            >
              <Eraser size={16} /> Dig up
            </button>
            <button
              onClick={clearGarden}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border ${
                darkMode ? 'bg-gray-700 text-gray-300 border-gray-600' : 'bg-gray-100 text-gray-600 border-gray-200'
              }`}
            >
              <Trash2 size={16} /> Clear plants
            </button>
          </div>

          <p className={`text-xs leading-relaxed ${subText}`}>
            Buy a seed, tap an empty tile to plant it, and wait while it grows
            🌰 → 🌱 → bloom. Tap a glowing ripe plant to harvest it for coins (or
            <span className="font-medium"> Harvest all</span>). 🌳 Trees & 🌿 bushes
            regrow after harvest; 🌼 flowers & 🥕 plants are replanted each time. Earn
            coins to buy pricier seeds and more plots.
          </p>
        </div>
      </div>
    </div>
  )
}

function SeedDropdown({ label, cat, species, value, active, coins, darkMode, onPick }) {
  return (
    <div>
      <div className={`text-xs font-medium mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
      <select
        value={value}
        onChange={(e) => onPick(cat, e.target.value)}
        className={`w-full px-3 py-2 rounded-lg text-sm border ${
          active ? 'ring-2 ring-blue-400 ' : ''
        }${darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
      >
        {species.map((s) => {
          const afford = s.cost === 0 || coins >= s.cost
          return (
            <option key={s.id} value={s.id}>
              {s.emoji} {s.name} — {s.cost === 0 ? 'Free' : `🪙 ${s.cost}`}{afford ? '' : ' 🔒'}
            </option>
          )
        })}
      </select>
    </div>
  )
}
