import React, { useState, useEffect } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'

const STORAGE_KEY = 'atticRows'

// Magnus formula, Fahrenheit in / Fahrenheit out.
function dewPointF(tempF, rh) {
  if (!rh || rh <= 0) return NaN
  const tempC = (tempF - 32) * 5 / 9
  const a = 17.27, b = 237.7
  const alpha = Math.log(rh / 100) + (a * tempC) / (b + tempC)
  const dpC = (b * alpha) / (a - alpha)
  return dpC * 9 / 5 + 32
}

const SAMPLE = [
  { t: '6AM', temp: 76, rh: 70 },
  { t: '8AM', temp: 82, rh: 74 },
  { t: '10AM', temp: 95, rh: 60 },
  { t: '12PM', temp: 110, rh: 40 },
  { t: '2PM', temp: 117, rh: 33 },
  { t: '4PM', temp: 120, rh: 28 },
  { t: '6PM', temp: 115, rh: 32 },
  { t: '8PM', temp: 100, rh: 42 },
  { t: '10PM', temp: 90, rh: 52 },
  { t: '12AM', temp: 84, rh: 60 },
  { t: '2AM', temp: 80, rh: 66 },
  { t: '4AM', temp: 77, rh: 70 },
]

function statusFor(margin) {
  if (margin < 8) return { cls: 'risk', label: 'RISK', color: '#a3352b', bg: '#f8e2df' }
  if (margin < 15) return { cls: 'warn', label: 'WATCH', color: '#a06a1c', bg: '#f7ecd8' }
  return { cls: 'safe', label: 'SAFE', color: '#2f6b4f', bg: '#e3efe8' }
}

// Hand-rolled two-series line chart (attic temp vs dew point) as inline SVG,
// so we don't pull in a charting dependency.
function Chart({ rows }) {
  const pts = rows
    .map((r) => ({ t: r.t, temp: Number(r.temp), dp: dewPointF(Number(r.temp), Number(r.rh)) }))
    .filter((p) => Number.isFinite(p.temp) && Number.isFinite(p.dp))
  if (pts.length < 2) {
    return <div className="text-sm text-[var(--muted)]">Add at least two rows to draw the chart.</div>
  }

  const W = 700, H = 300
  const padL = 38, padR = 12, padT = 12, padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const vals = pts.flatMap((p) => [p.temp, p.dp])
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const span = hi - lo || 1
  lo -= span * 0.1; hi += span * 0.1

  const x = (i) => padL + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW)
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH

  const line = (key) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')

  // horizontal gridlines / y labels
  const ticks = 4
  const yTicks = Array.from({ length: ticks + 1 }, (_, k) => lo + (k / ticks) * (hi - lo))
  // thin x labels so they don't collide
  const step = Math.ceil(pts.length / 7)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Attic temp vs dew point over 24 hours">
      {yTicks.map((v, k) => (
        <g key={k}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{Math.round(v)}</text>
        </g>
      ))}
      {pts.map((p, i) => (i % step === 0 ? (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted)">{p.t}</text>
      ) : null))}
      {/* dew point (dashed red) */}
      <path d={line('dp')} fill="none" stroke="#a3352b" strokeWidth="2.5" strokeDasharray="5 3" />
      {/* attic temp (steel) */}
      <path d={line('temp')} fill="none" stroke="#3d5a73" strokeWidth="2.5" />
      {pts.map((p, i) => <circle key={'t' + i} cx={x(i)} cy={y(p.temp)} r="2.5" fill="#3d5a73" />)}
      {pts.map((p, i) => <circle key={'d' + i} cx={x(i)} cy={y(p.dp)} r="2.5" fill="#a3352b" />)}
    </svg>
  )
}

export default function Attic() {
  const [rows, setRows] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch { /* ignore corrupt state */ }
    return SAMPLE
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)) } catch { /* quota */ }
  }, [rows])

  const update = (i, field, value) => {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, [field]: value } : r)))
  }
  const addRow = () => setRows((rs) => [...rs, { t: '', temp: 80, rh: 60 }])
  const deleteRow = (i) => setRows((rs) => rs.filter((_, k) => k !== i))

  // Derived summary.
  const computed = rows.map((r) => {
    const temp = Number(r.temp)
    const dp = dewPointF(temp, Number(r.rh))
    return { ...r, dp, margin: Number.isFinite(dp) ? temp - dp : NaN }
  })
  const valid = computed.filter((c) => Number.isFinite(c.margin))
  let tightest = null, avgDp = null
  if (valid.length) {
    tightest = valid.reduce((m, c) => (c.margin < m.margin ? c : m), valid[0])
    avgDp = valid.reduce((a, c) => a + c.dp, 0) / valid.length
  }
  const tightSt = tightest ? statusFor(tightest.margin) : null

  const Gauge = ({ label, children }) => (
    <div className="flex-1 min-w-[130px] rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-medium">{label}</div>
      <div className="text-2xl font-bold mt-1 text-[var(--text)] tabular-nums">{children}</div>
    </div>
  )

  const Tag = ({ st }) => (
    <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded" style={{ color: st.color, background: st.bg }}>{st.label}</span>
  )

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
      <div className="max-w-2xl mx-auto p-4 space-y-5 text-[var(--text)]">
        <header>
          <div className="text-[11px] uppercase tracking-widest text-[var(--muted)] mb-1">Condensation risk / dew point margin</div>
          <h1 className="text-2xl font-bold leading-tight">Attic Dew Point Margin</h1>
          <p className="text-sm text-[var(--muted)] mt-2 leading-relaxed">
            Dew point depends on both temperature and humidity — the QuietCool app tracks them separately,
            so the real condensation risk is hidden between the two charts. Enter your hourly temp + RH to
            see how close attic air sits to its dew point through the day.
          </p>
        </header>

        {/* Gauges */}
        {tightest && (
          <div className="flex gap-2.5 flex-wrap">
            <Gauge label="Tightest margin">
              {tightest.margin.toFixed(1)}°<span className="text-sm font-medium text-[var(--muted)]"> at {tightest.t || '—'}</span>
            </Gauge>
            <Gauge label="Status at tightest"><Tag st={tightSt} /></Gauge>
            <Gauge label="Avg dew point">{avgDp.toFixed(1)}°<span className="text-sm font-medium text-[var(--muted)]"> F</span></Gauge>
          </div>
        )}

        {/* Table */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-xs uppercase tracking-wider text-[var(--muted)] font-semibold mb-3">Hourly readings</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="text-left font-medium pb-2 pr-2">Time</th>
                  <th className="text-left font-medium pb-2 pr-2">°F</th>
                  <th className="text-left font-medium pb-2 pr-2">RH%</th>
                  <th className="text-left font-medium pb-2 pr-2">Dew</th>
                  <th className="text-left font-medium pb-2 pr-2">Margin</th>
                  <th className="text-left font-medium pb-2 pr-2">Status</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {computed.map((c, i) => {
                  const st = Number.isFinite(c.margin) ? statusFor(c.margin) : null
                  return (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="py-1.5 pr-2">
                        <input value={c.t} onChange={(e) => update(i, 't', e.target.value)}
                          className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[var(--text)]" />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input type="number" inputMode="decimal" value={c.temp} onChange={(e) => update(i, 'temp', e.target.value)}
                          className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[var(--text)] tabular-nums" />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input type="number" inputMode="decimal" value={c.rh} onChange={(e) => update(i, 'rh', e.target.value)}
                          className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-[var(--text)] tabular-nums" />
                      </td>
                      <td className="py-1.5 pr-2 font-semibold tabular-nums">{Number.isFinite(c.dp) ? `${c.dp.toFixed(1)}°` : '—'}</td>
                      <td className="py-1.5 pr-2 font-semibold tabular-nums">{Number.isFinite(c.margin) ? `${c.margin.toFixed(1)}°` : '—'}</td>
                      <td className="py-1.5 pr-2">{st ? <Tag st={st} /> : '—'}</td>
                      <td className="py-1.5">
                        <button onClick={() => deleteRow(i)} className="text-red-500 hover:opacity-70 p-1" aria-label="Delete row"><X size={15} /></button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 flex-wrap mt-3">
            <button onClick={addRow} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-2)]">
              <Plus size={15} /> Add row
            </button>
            <button onClick={() => setRows(SAMPLE)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-2)]">
              <RotateCcw size={15} /> Reset to sample
            </button>
          </div>
          <p className="text-xs text-[var(--muted)] mt-3 pt-3 border-t border-[var(--border)] leading-relaxed">
            <b className="text-[var(--text)]">Margin</b> = attic air temp − dew point: the buffer before condensation
            forms on air-temperature surfaces. Cold surfaces (AC ducts, coil lines) sit below ambient, so risk
            starts before margin hits zero. <b className="text-[var(--text)]">Safe</b> ≥ 15° · <b className="text-[var(--text)]">Watch</b> 8–15° · <b className="text-[var(--text)]">Risk</b> &lt; 8°.
          </p>
        </div>

        {/* Chart */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-xs uppercase tracking-wider text-[var(--muted)] font-semibold mb-3">Temp vs. dew point, 24hr</h2>
          <Chart rows={rows} />
          <div className="flex gap-4 justify-center mt-2 text-xs text-[var(--muted)]">
            <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: '#3d5a73' }} /> Attic temp</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: '#a3352b' }} /> Dew point</span>
          </div>
        </div>

        <p className="text-[11px] text-center text-[var(--muted)] pb-2">Magnus formula, °F in/out · your rows are saved on this device.</p>
      </div>
    </div>
  )
}
