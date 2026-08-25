import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  hexToHsv,
  hsvToHex,
  isValidHexColor,
  LINE_COLOR_PALETTE,
  normalizeHexColor,
} from '../lib/line-color'
import styles from './LineColorPickerModal.module.css'

interface Props {
  lineName: string
  currentColor: string
  /** 같은 도시의 다른 노선이 이미 쓰고 있는 색 — 팔레트에서 미리 걸러내는 용도(참고용 힌트일 뿐, 실제 차단은 서버가 한다) */
  usedColors: string[]
  busy: boolean
  onClose: () => void
  onSave: (color: string) => Promise<void> | void
}

export default function LineColorPickerModal({ lineName, currentColor, usedColors, busy, onClose, onSave }: Props) {
  const initial = isValidHexColor(currentColor) ? normalizeHexColor(currentColor) : '#E9783C'
  const initialHsv = hexToHsv(initial)
  const [color, setColor] = useState(initial)
  const [hexText, setHexText] = useState(initial)
  const [hue, setHue] = useState(initialHsv.h)
  const [sat, setSat] = useState(initialHsv.s)
  const [val, setVal] = useState(initialHsv.v)
  const [saving, setSaving] = useState(false)
  const svRef = useRef<HTMLDivElement>(null)

  const usedSet = new Set(usedColors.map(normalizeHexColor))

  const applyHsv = (h: number, s: number, v: number) => {
    setHue(h)
    setSat(s)
    setVal(v)
    const next = hsvToHex(h, s, v)
    setColor(next)
    setHexText(next)
  }

  const applyHex = (hex: string) => {
    const normalized = normalizeHexColor(hex)
    setColor(normalized)
    setHexText(normalized)
    const hsv = hexToHsv(normalized)
    setHue(hsv.h)
    setSat(hsv.s)
    setVal(hsv.v)
  }

  const handleHexInputChange = (raw: string) => {
    const withHash = raw.startsWith('#') ? raw : `#${raw}`
    setHexText(withHash)
    if (isValidHexColor(withHash)) applyHex(withHash)
  }

  const updateFromPointer = (clientX: number, clientY: number) => {
    const rect = svRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const v = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    applyHsv(hue, s, v)
  }

  const handleSvPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event.clientX, event.clientY)
  }

  const handleSvPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return
    updateFromPointer(event.clientX, event.clientY)
  }

  const handleHueChange = (h: number) => applyHsv(h, sat, val)

  const validHex = isValidHexColor(hexText)
  const disabled = busy || saving || !validHex

  const handleSave = async () => {
    if (disabled) return
    setSaving(true)
    try {
      await onSave(normalizeHexColor(hexText))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.card} onClick={event => event.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.title}>{lineName} 색상 변경</div>
          <button className={styles.closeBtn} onClick={onClose} type="button" title="닫기">✕</button>
        </div>

        <div className={styles.previewRow}>
          <span className={styles.previewSwatch} style={{ background: color }} />
          <input
            className={`${styles.hexInput} ${!validHex ? styles.hexInputInvalid : ''}`}
            value={hexText}
            onChange={event => handleHexInputChange(event.target.value)}
            maxLength={7}
            spellCheck={false}
            aria-label="색상 코드"
            placeholder="#RRGGBB"
          />
        </div>

        <div
          ref={svRef}
          className={styles.svSquare}
          style={{
            background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(${hue}, 100%, 50%)`,
          }}
          onPointerDown={handleSvPointerDown}
          onPointerMove={handleSvPointerMove}
        >
          <div className={styles.svThumb} style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, background: color }} />
        </div>

        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={Math.round(hue)}
          className={styles.hueSlider}
          onChange={event => handleHueChange(Number(event.target.value))}
          aria-label="색조 선택"
        />

        <div className={styles.presetGrid}>
          {LINE_COLOR_PALETTE.map(preset => {
            const isUsed = usedSet.has(preset) && preset !== color
            const isActive = preset === color
            return (
              <button
                key={preset}
                type="button"
                className={`${styles.presetSwatch} ${isActive ? styles.presetSwatchActive : ''}`}
                style={{ background: preset }}
                disabled={isUsed}
                title={isUsed ? '이미 사용 중인 색상' : preset}
                onClick={() => applyHex(preset)}
              />
            )
          })}
        </div>

        <div className={styles.actionsRow}>
          <button className={styles.cancelBtn} type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button className={styles.saveBtn} type="button" onClick={() => void handleSave()} disabled={disabled}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
