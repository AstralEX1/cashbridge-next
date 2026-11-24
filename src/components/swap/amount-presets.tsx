'use client'

import { type CSSProperties, type FocusEvent, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PRESET_PERCENTS } from '@/lib/amount-presets'

// Longer than the last chip's delayed exit, so each chip finishes its animation before it unmounts.
const EXIT_MS = 340
const CHIPS = [...PRESET_PERCENTS, 100]

// Keeps the chips mounted while they play their exit after `open` turns false.
const useExit = (open: boolean) => {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])
  return { mounted, exiting }
}

// The chips show while the pointer is over the field or focus is inside it, and leave when both are gone.
export const useRevealOnHover = () => {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  return {
    revealed: hovered || focused,
    handlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }
    }
  }
}

// 25 / 50 / 75 % and MAX, staggered in on reveal and out in reverse order. Pressing one keeps the amount
// field focused, so the keyboard carries on where it was.
export const AmountPresets = ({
  revealed,
  inputId,
  onPercent,
  onMax
}: {
  revealed: boolean
  inputId: string
  onPercent: (percent: number) => void
  onMax: () => void
}) => {
  const t = useTranslations('bridge.form')
  const { mounted, exiting } = useExit(revealed)
  if (!mounted) return null
  return (
    <div className={`bridge-presets${exiting ? ' is-leaving' : ''}`}>
      {CHIPS.map((percent, index) => (
        <button
          key={percent}
          type="button"
          className="bridge-preset"
          disabled={exiting}
          style={{ '--bridge-preset-delay': `${(exiting ? CHIPS.length - 1 - index : index) * (exiting ? 40 : 50)}ms` } as CSSProperties}
          aria-label={percent === 100 ? t('presetMax') : t('presetPercent', { percent })}
          onMouseDown={event => event.preventDefault()}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            if (percent === 100) onMax()
            else onPercent(percent)
            document.getElementById(inputId)?.focus()
          }}
        >
          {percent === 100 ? t('max') : `${percent}%`}
        </button>
      ))}
    </div>
  )
}
