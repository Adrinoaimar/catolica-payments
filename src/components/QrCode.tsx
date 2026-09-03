import { useMemo } from 'react'
import { QrIcon } from './Icons'

interface QrCodeProps { value: string; size?: 'small' | 'large' }

// Deterministic visual QR for mock mode. Real providers can replace image URL from API response.
export function QrCode({ value, size = 'large' }: QrCodeProps) {
  const cells = useMemo(() => {
    const total = 25
    let seed = [...value].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7)
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
    const finder = (x: number, y: number, ox: number, oy: number) => {
      const dx = x - ox; const dy = y - oy
      return dx >= 0 && dx < 7 && dy >= 0 && dy < 7 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
    }
    return Array.from({ length: total * total }, (_, index) => {
      const x = index % total; const y = Math.floor(index / total)
      const marked = finder(x, y, 0, 0) || finder(x, y, total - 7, 0) || finder(x, y, 0, total - 7)
      const reserved = (x < 8 && y < 8) || (x >= total - 8 && y < 8) || (x < 8 && y >= total - 8)
      return marked || (!reserved && (next() % 100 > 47 || (x + y) % 7 === 0))
    })
  }, [value])
  return <div className={`qr-frame qr-frame--${size}`} aria-label={`Código QR para ${value}`}><div className="qr-brand-corner"><QrIcon size={size === 'large' ? 18 : 14} /></div><div className="qr-grid" style={{ gridTemplateColumns: 'repeat(25, 1fr)' }}>{cells.map((filled, index) => <span className={filled ? 'qr-cell qr-cell--filled' : 'qr-cell'} key={index} />)}</div></div>
}
