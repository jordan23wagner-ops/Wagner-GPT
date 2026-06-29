// Garden game — economy edition.
//
// Loop: buy a seed -> it grows seed -> sprout -> bloom over real time -> harvest a
// bloomed plant for coins -> buy pricier seeds and more plots. Growth is derived from
// `plantedAt` timestamps at render time (nothing about a stage is stored), so closing
// and reopening the app restores exact progress.
//
// Harvest model (per design): trees & bushes are PERENNIAL — harvesting pays out and
// resets them to regrow. Flowers & plants are CONSUMED — harvesting clears the tile and
// the seed must be rebought. No fail states: plants never wither; a bloom waits to be
// picked.

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Each plot is a 4x4 grid; you start owning one and buy more (stacked below).
export const PLOT_ROWS = 4
export const PLOT_COLS = 4
export const MAX_PLOTS = 9

// Price to buy the NEXT plot, indexed by how many you currently own (1..8).
const PLOT_PRICES = [0, 150, 400, 800, 1500, 2800, 5000, 9000, 16000]
export function plotPrice(ownedPlots) {
  return ownedPlots >= 1 && ownedPlots < MAX_PLOTS ? PLOT_PRICES[ownedPlots] : null
}

// Categories. Trees & bushes regrow after harvest; flowers & plants are replanted.
export const CATS = {
  flowers: { label: 'Flowers', renewable: false },
  plants:  { label: 'Plants', renewable: false },
  bushes:  { label: 'Bushes', renewable: true },
  trees:   { label: 'Trees', renewable: true },
}

// 10 real species per category, tier 0 (the starter) free, prices/values/grow-times
// rising together so fancier plants cost more, take longer, and pay more.
// Tuple: [id, name, emoji, costCoins, growMs, harvestValueCoins]
const RAW = {
  flowers: [
    ['daisy',        'Daisy',         '🌼',    0, 10 * MIN,   3],
    ['marigold',     'Marigold',      '🏵️',    5, 20 * MIN,  12],
    ['tulip',        'Tulip',         '🌷',   12, 30 * MIN,  28],
    ['lavender',     'Lavender',      '🪻',   25, 45 * MIN,  55],
    ['sunflower',    'Sunflower',     '🌻',   45,  1 * HOUR, 95],
    ['hibiscus',     'Hibiscus',      '🌺',   75, 90 * MIN, 150],
    ['cherryblossom','Cherry Blossom','🌸',  120,  2 * HOUR, 230],
    ['rose',         'Rose',          '🌹',  180,  3 * HOUR, 330],
    ['lotus',        'Lotus',         '🪷',  260,  4 * HOUR, 470],
    ['dahlia',       'Dahlia',        '💮',  400,  6 * HOUR, 700],
  ],
  plants: [
    ['lettuce',  'Lettuce',  '🥬',    0, 15 * MIN,   4],
    ['carrot',   'Carrot',   '🥕',    6, 30 * MIN,  14],
    ['onion',    'Onion',    '🧅',   14, 45 * MIN,  32],
    ['garlic',   'Garlic',   '🧄',   28,  1 * HOUR, 60],
    ['potato',   'Potato',   '🥔',   50, 90 * MIN, 105],
    ['tomato',   'Tomato',   '🍅',   80,  2 * HOUR, 165],
    ['pepper',   'Pepper',   '🫑',  125,  3 * HOUR, 245],
    ['corn',     'Corn',     '🌽',  190,  4 * HOUR, 360],
    ['eggplant', 'Eggplant', '🍆',  280,  6 * HOUR, 510],
    ['pumpkin',  'Pumpkin',  '🎃',  420,  8 * HOUR, 760],
  ],
  bushes: [
    ['boxwood',    'Boxwood',    '🌿',    0,  1 * HOUR,   4],
    ['holly',      'Holly',      '☘️',   15,  2 * HOUR,  16],
    ['blueberry',  'Blueberry',  '🫐',   35,  3 * HOUR,  34],
    ['raspberry',  'Raspberry',  '🍓',   70,  4 * HOUR,  62],
    ['currant',    'Currant',    '🍇',  120,  6 * HOUR, 105],
    ['gooseberry', 'Gooseberry', '🫐',  190,  8 * HOUR, 160],
    ['hydrangea',  'Hydrangea',  '🌸',  290, 10 * HOUR, 235],
    ['azalea',     'Azalea',     '🌺',  430, 12 * HOUR, 340],
    ['rosemary',   'Rosemary',   '🌿',  620, 16 * HOUR, 480],
    ['blackberry', 'Blackberry', '🫐',  900, 20 * HOUR, 690],
  ],
  trees: [
    ['maple',  'Maple',  '🍁',     0,  4 * HOUR,    6],
    ['almond', 'Almond', '🌰',    30,  6 * HOUR,   26],
    ['olive',  'Olive',  '🫒',    70,  8 * HOUR,   58],
    ['fig',    'Fig',    '🌳',   140, 12 * HOUR,  110],
    ['pear',   'Pear',   '🍐',   240, 16 * HOUR,  185],
    ['apple',  'Apple',  '🍎',   380, 20 * HOUR,  290],
    ['peach',  'Peach',  '🍑',   560, 24 * HOUR,  430],
    ['cherry', 'Cherry', '🍒',   820, 30 * HOUR,  620],
    ['orange', 'Orange', '🍊',  1200, 36 * HOUR,  880],
    ['lemon',  'Lemon',  '🍋',  1800, 48 * HOUR, 1300],
  ],
}

// Build the public catalog (per-category arrays) and a flat id -> def lookup.
export const SPECIES = {}
export const SPECIES_BY_ID = {}
for (const [cat, list] of Object.entries(RAW)) {
  SPECIES[cat] = list.map(([id, name, emoji, cost, growMs, value]) => {
    const def = { id, name, emoji, cost, growMs, value, cat, renewable: CATS[cat].renewable }
    SPECIES_BY_ID[id] = def
    return def
  })
}

// Cosmetic decorations — free, optional, no growth.
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

export const key = (plot, row, col) => `${plot}-${row}-${col}`

export const STATE_VERSION = 2
export const initialGarden = { version: STATE_VERSION, coins: 0, plots: 1, tiles: {} }

// A tile is either:
//   plant      -> { id, plantedAt }
//   decoration -> { decoration: true, kind }
export function gardenReducer(state, action) {
  switch (action.type) {
    case 'LOAD':
      // Only accept current-version saves; legacy cozy gardens reset to the new game.
      return action.state && action.state.version === STATE_VERSION ? action.state : state

    case 'PLANT': {
      const k = key(action.plot, action.row, action.col)
      if (state.tiles[k]) return state // occupied
      const def = SPECIES_BY_ID[action.id]
      if (!def || state.coins < def.cost) return state
      return {
        ...state,
        coins: state.coins - def.cost,
        tiles: { ...state.tiles, [k]: { id: action.id, plantedAt: action.now ?? Date.now() } },
      }
    }

    case 'PLACE_DECORATION': {
      const k = key(action.plot, action.row, action.col)
      if (state.tiles[k] || !DECORATIONS[action.kind]) return state
      return { ...state, tiles: { ...state.tiles, [k]: { decoration: true, kind: action.kind } } }
    }

    case 'HARVEST': {
      const k = key(action.plot, action.row, action.col)
      const tile = state.tiles[k]
      if (!tile || tile.decoration) return state
      const def = SPECIES_BY_ID[tile.id]
      const now = action.now ?? Date.now()
      if (!def || now - tile.plantedAt < def.growMs) return state // not ripe
      const tiles = { ...state.tiles }
      if (def.renewable) tiles[k] = { ...tile, plantedAt: now } // perennial: regrow
      else delete tiles[k] // annual: cleared, reseed
      return { ...state, coins: state.coins + def.value, tiles }
    }

    case 'HARVEST_ALL': {
      const now = action.now ?? Date.now()
      const tiles = { ...state.tiles }
      let earned = 0
      for (const [k, tile] of Object.entries(state.tiles)) {
        if (!tile || tile.decoration) continue
        const def = SPECIES_BY_ID[tile.id]
        if (!def || now - tile.plantedAt < def.growMs) continue
        earned += def.value
        if (def.renewable) tiles[k] = { ...tile, plantedAt: now }
        else delete tiles[k]
      }
      if (!earned) return state
      return { ...state, coins: state.coins + earned, tiles }
    }

    case 'REMOVE': {
      const k = key(action.plot, action.row, action.col)
      if (!state.tiles[k]) return state
      const tiles = { ...state.tiles }
      delete tiles[k]
      return { ...state, tiles }
    }

    case 'BUY_PLOT': {
      const price = plotPrice(state.plots)
      if (price == null || state.coins < price) return state
      return { ...state, coins: state.coins - price, plots: state.plots + 1 }
    }

    case 'CLEAR':
      // Reset the planted tiles but keep coins and purchased plots.
      return { ...state, tiles: {} }

    default:
      return state
  }
}

// Derived stage for a plant tile: 'seed' | 'sprout' | 'bloom' (null for decorations).
export function growthStage(tile, now) {
  if (!tile || tile.decoration) return null
  const def = SPECIES_BY_ID[tile.id]
  if (!def) return 'bloom'
  const elapsed = now - tile.plantedAt
  if (elapsed >= def.growMs) return 'bloom'
  if (elapsed >= def.growMs / 3) return 'sprout'
  return 'seed'
}

// Is this tile a fully grown plant ready to harvest?
export function isHarvestable(tile, now) {
  return growthStage(tile, now) === 'bloom'
}

// Emoji to render for a tile at time `now`.
export function tileEmoji(tile, now) {
  if (!tile) return ''
  if (tile.decoration) return (DECORATIONS[tile.kind] || {}).emoji || ''
  const stage = growthStage(tile, now)
  if (stage === 'sprout') return SPROUT_EMOJI
  if (stage === 'seed') return SEED_EMOJI
  return (SPECIES_BY_ID[tile.id] || {}).emoji || ''
}

// 0..1 growth progress for a plant (1 for decorations / bloomed plants).
export function growthProgress(tile, now) {
  if (!tile || tile.decoration) return 1
  const def = SPECIES_BY_ID[tile.id]
  if (!def) return 1
  return Math.min(1, Math.max(0, (now - tile.plantedAt) / def.growMs))
}
