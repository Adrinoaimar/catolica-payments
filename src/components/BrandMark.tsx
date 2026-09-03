interface BrandMarkProps { compact?: boolean }

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className={`brand-mark ${compact ? 'brand-mark--compact' : ''}`} aria-label="Grupo La Católica">
      <span className="brand-mark__seal">LC</span>
      {!compact && <span className="brand-mark__text"><strong>GRUPO LA</strong><b>CATÓLICA</b></span>}
    </div>
  )
}
