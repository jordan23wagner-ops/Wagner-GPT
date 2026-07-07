// companyData.js — company signals for the Jobs tab: Fortune 500 membership and a recent-layoffs
// flag. Both are curated, normalized, and intentionally simple (company names across job boards are
// fuzzy, so matching errs toward well-known names). Extend the lists freely.
//
// ⚠ The LAYOFFS list is a point-in-time snapshot (2022–2025) — it WILL go stale. Prune/extend it,
// or later wire it to a live source. It's a heads-up flag, not authoritative.

function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(incorporated|inc|corporation|corp|company|co|llc|ltd|plc|holdings|group|the|technologies|technology|systems|international|worldwide|global|usa|us|na)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Curated Fortune 500 (2023–2024 highlights across sectors) — not exhaustive; add as needed.
const FORTUNE500_NAMES = [
  'Walmart', 'Amazon', 'Apple', 'UnitedHealth', 'Berkshire Hathaway', 'CVS Health', 'ExxonMobil',
  'Alphabet', 'McKesson', 'Cencora', 'Costco', 'JPMorgan Chase', 'Microsoft', 'Cardinal Health',
  'Chevron', 'Cigna', 'Ford Motor', 'Bank of America', 'General Motors', 'Elevance Health',
  'Citigroup', 'Centene', 'Home Depot', 'Marathon Petroleum', 'Kroger', 'Phillips 66', 'Fannie Mae',
  'Walgreens', 'Valero Energy', 'Meta', 'Verizon', 'AT&T', 'Comcast', 'Wells Fargo', 'Goldman Sachs',
  'Morgan Stanley', 'Target', 'Humana', 'State Farm', 'Tesla', 'Dell', 'Intel', 'IBM', 'Boeing',
  'Lockheed Martin', 'RTX', 'Raytheon', 'General Electric', 'Johnson & Johnson', 'Procter & Gamble',
  'PepsiCo', 'Coca-Cola', 'Pfizer', 'Merck', 'AbbVie', 'Nvidia', 'Oracle', 'Cisco', 'Salesforce',
  'Qualcomm', 'Broadcom', 'Accenture', 'Nike', 'Starbucks', 'Walt Disney', 'Netflix', 'PayPal',
  'Visa', 'Mastercard', 'American Express', 'Capital One', 'US Bancorp', 'PNC', 'Truist',
  'Charter Communications', 'Deere', 'Caterpillar', '3M', 'Honeywell', 'Abbott Laboratories',
  'Medtronic', 'Thermo Fisher Scientific', 'Danaher', 'Eli Lilly', 'Bristol Myers Squibb', 'Amgen',
  'Gilead Sciences', 'HP', 'Hewlett Packard Enterprise', 'Texas Instruments', 'Micron',
  'Applied Materials', 'Adobe', 'ServiceNow', 'Uber', 'FedEx', 'UPS', 'American Airlines',
  'Delta Air Lines', 'United Airlines', 'Southwest Airlines', 'General Dynamics', 'Northrop Grumman',
  'ConocoPhillips', 'Occidental Petroleum', 'Duke Energy', 'NextEra Energy', 'Exelon', 'Dow',
  'DuPont', 'Archer Daniels Midland', 'Tyson Foods', 'Mondelez', 'Kraft Heinz', 'General Mills',
  'Kimberly-Clark', 'Colgate-Palmolive', 'Best Buy', 'Lowe\'s', 'TJX', 'Dollar General',
  'Dollar Tree', 'Nordstrom', 'Macy\'s', 'Ross Stores', 'AutoZone', 'O\'Reilly Automotive', 'Sysco',
  'Publix', 'Albertsons', 'Nucor', 'Freeport-McMoRan', 'International Paper', 'Emerson Electric',
  'Illinois Tool Works', 'Parker Hannifin', 'Stanley Black & Decker', 'Whirlpool', 'PPG Industries',
  'Sherwin-Williams', 'Air Products', 'Linde', 'Corteva', 'Waste Management', 'Republic Services',
  'Marriott', 'Hilton', 'MetLife', 'Prudential Financial', 'AIG', 'Aflac', 'Allstate', 'Progressive',
  'Travelers', 'Chubb', 'BlackRock', 'Charles Schwab', 'Nationwide', 'Liberty Mutual', 'Cummins',
  'PACCAR', 'Aptiv', 'BorgWarner', 'Lear', 'Halliburton', 'Schlumberger', 'Baker Hughes',
  'Kinder Morgan', 'Williams', 'Sempra', 'Dominion Energy', 'Southern Company',
  'American Electric Power', 'Consolidated Edison', 'Ecolab', 'Ball', 'Newmont', 'Alcoa',
  'Steel Dynamics', 'Cleveland-Cliffs', 'Lennar', 'D.R. Horton', 'PulteGroup', 'CarMax',
  'Booking Holdings', 'eBay', 'SAP', 'Siemens', 'Deloitte', 'PwC', 'KPMG', 'Ernst & Young',
]
const FORTUNE500 = new Set(FORTUNE500_NAMES.map(normalizeCompany))

// normalized alias -> normalized canonical
const ALIASES = {
  'google': 'alphabet', 'youtube': 'alphabet', 'facebook': 'meta', 'instagram': 'meta',
  'aws': 'amazon', 'amazon web services': 'amazon', 'raytheon technologies': 'rtx',
  'jp morgan': 'jpmorgan chase', 'chase': 'jpmorgan chase', 'ey': 'ernst and young',
}

// Recent notable layoffs (snapshot). Keys are normalized company names.
const LAYOFFS = {
  'amazon': '~27,000 cut across 2022–2024',
  'meta': '~21,000 cut in 2022–2023',
  'alphabet': '~12,000 in 2023, further cuts 2024',
  'microsoft': '~10,000 in 2023 + 2024 cuts',
  'salesforce': '~8,000 in 2023, ~1,000 in 2024',
  'intel': '~15,000 (~15%) announced 2024',
  'cisco': '~10,000 across 2024',
  'dell': '~13,000 across 2023–2024',
  'ibm': 'ongoing cuts 2023–2024',
  'hp': '~4,000–6,000 through 2025',
  'hewlett packard enterprise': '~2,500 announced 2024',
  'paypal': '~2,500 across 2023–2024',
  'sap': '~8,000 restructuring 2024',
  'ups': '~12,000 in 2024',
  'nike': '~1,600 in 2024',
  'tesla': '~14,000 (~10%) in 2024',
  'boeing': '~17,000 (~10%) announced 2024',
  'citigroup': '~20,000 announced through 2026',
  'dow': '~2,000 in 2024',
  'general motors': 'salaried buyouts + cuts 2023–2024',
  'ford motor': 'white-collar cuts 2024',
  'ebay': '~1,000 in 2024',
  'block': 'workforce cap + cuts 2024',
  'goldman sachs': 'periodic cuts 2023–2024',
  'spotify': '~2,300 in 2023',
}

function resolve(company) {
  const n = normalizeCompany(company)
  return ALIASES[n] || n
}
function lookup(dict, isMap, company) {
  const n = resolve(company)
  if (!n) return isMap ? null : false
  if (Object.prototype.hasOwnProperty.call(dict, n) || (dict instanceof Set && dict.has(n))) {
    return isMap ? dict[n] : true
  }
  // prefix match so "amazon <x>" hits "amazon" (only for names >= 4 chars to avoid noise)
  const keys = dict instanceof Set ? Array.from(dict) : Object.keys(dict)
  for (const k of keys) {
    if (k.length >= 4 && (n === k || n.startsWith(k + ' '))) return isMap ? dict[k] : true
  }
  return isMap ? null : false
}

export function isFortune500(company) { return lookup(FORTUNE500, false, company) }
export function layoffFlag(company) { return lookup(LAYOFFS, true, company) }
