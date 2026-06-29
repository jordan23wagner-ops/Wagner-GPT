// Cozy garden — pure state + derived growth.
//
// Design (per project handoff): immutable state, pure reducer, and growth derived
// from `plantedAt` timestamps at render time rather than a running timer. Nothing
// about a plant's stage is stored, so reloading the page restores exact progress.
// No currency, no economy, no fail states — just planting and decorating.

export const GRID_COLS = 6
export const GRID_ROWS = 8

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Plants reach full bloom after `growMs`. A sprout shows at 1/3 of that time.
export const PLANTS = {
  daisy:     { emoji: '🌼', label: 'Daisy',     growMs: 30 * MIN },  // ~30 min
  tulip:     { emoji: '🌷', label: 'Tulip',     growMs: 2 * HOUR },  // ~2 hr
  sunflower: { emoji: '🌻', label: 'Sunflower', growMs: 6 * HOUR },  // ~6 hr
  tree:      { emoji: '🌳', label: 'Tree',      growMs: 24 * HOUR }, // ~24 hr
}

// Decorations are placed instantly and are permanent (cannot be removed).
export const DECORATIONS = {
  fence:    { emoji: '🪵', label: 'Fence' },
  bench:    { emoji: '🪑', label: 'Bench' },
  fountain: { emoji: '⛲', label: 'Fountain' },
  lantern:  { emoji: '🏮', label: 'Lantern' },
  pot:      { emoji: '🪴', label: 'Pot' },
  stone:    { emoji: '🪨', label: 'Stepping stone' },
}

export const SEED_EMOJI = '🌰'
export const SPROUT_EMOJI = '🌱'

export const key = (row, col) => `${row}-${col}`

export const initialGarden = { tiles: {} }

// A tile is either:
//   plant      -> { decoration: false, kind, plantedAt }
//   decoration -> { decoration: true,  kind }
export function gardenReducer(state, action) {
  switch (action.type) {
    case 'LOAD':
      return action.state && action.state.tiles ? action.state : state

    case 'PLANT': {
      const k = key(action.row, action.col)
      if (state.tiles[k]) return state // occupied -> no-op
      const tile = action.decoration
        ? { decoration: true, kind: action.kind }
        : { decoration: false, kind: action.kind, plantedAt: action.now ?? Date.now() }
      return { ...state, tiles: { ...state.tiles, [k]: tile } }
    }

    case 'REMOVE': {
      const k = key(action.row, action.col)
      const tile = state.tiles[k]
      if (!tile || tile.decoration) return state // decorations are permanent
      const tiles = { ...state.tiles }
      delete tiles[k]
      return { ...state, tiles }
    }

    case 'CLEAR':
      return initialGarden

    default:
      return state
  }
}

// Derived stage for a plant tile: 'seed' | 'sprout' | 'bloom' (null for decorations).
export function growthStage(tile, now) {
  if (!tile || tile.decoration) return null
  const def = PLANTS[tile.kind]
  if (!def) return 'bloom'
  const elapsed = now - tile.plantedAt
  if (elapsed >= def.growMs) return 'bloom'
  if (elapsed >= def.growMs / 3) return 'sprout'
  return 'seed'
}

// Emoji to render for a tile at time `now`.
export function tileEmoji(tile, now) {
  if (!tile) return ''
  if (tile.decoration) return (DECORATIONS[tile.kind] || {}).emoji || ''
  const stage = growthStage(tile, now)
  if (stage === 'sprout') return SPROUT_EMOJI
  if (stage === 'seed') return SEED_EMOJI
  return (PLANTS[tile.kind] || {}).emoji || ''
}

// 0..1 growth progress for a plant (1 for decorations / bloomed plants).
export function growthProgress(tile, now) {
  if (!tile || tile.decoration) return 1
  const def = PLANTS[tile.kind]
  if (!def) return 1
  return Math.min(1, Math.max(0, (now - tile.plantedAt) / def.growMs))
}
