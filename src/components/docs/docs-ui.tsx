import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import { DOCS_PAGES } from '@/components/docs/docs-pages'

// Native pixel size of each file in public/docs, so the page keeps its height while images load.
const SHOTS = {
  'connect-bch': [980, 520],
  'connect-evm': [980, 1390],
  'connect-wizardconnect': [840, 1120],
  'exchange-deposit': [1200, 1578],
  'form-forward': [1140, 1130],
  'form-reverse': [1140, 1430],
  'picker-from': [1140, 1050],
  'picker-to': [1140, 1130],
  'progress-bridging': [1320, 880],
  'progress-ready': [1320, 1500],
  'progress-swapping': [1320, 780],
  'receipt-bch': [1320, 1270],
  'receipt-pusd': [1320, 1270],
  'reverse-progress': [1320, 720],
  'reverse-receipt': [1320, 1270],
  'router-selector': [1140, 298],
  settings: [730, 500],
  toasts: [760, 640]
} as const

export type ShotName = keyof typeof SHOTS

// Widest the picture is drawn, in CSS pixels.
const SIZES = { sm: 400, md: 520, lg: 680 }

export function Shot({ name, alt, caption, size = 'md' }: { name: ShotName; alt: string; caption?: ReactNode; size?: keyof typeof SIZES }) {
  const [width, height] = SHOTS[name]
  return (
    <figure className="docs-shot" style={{ '--shot': `${SIZES[size]}px` } as CSSProperties}>
      <img src={`/docs/${name}.webp`} alt={alt} width={width} height={height} loading="lazy" decoding="async" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

export function Callout({ kind = 'note', title, children }: { kind?: 'note' | 'tip' | 'warning'; title?: string; children: ReactNode }) {
  return (
    <aside className={`docs-callout docs-callout-${kind}`} role="note">
      <strong>{title ?? { note: 'Note', tip: 'Tip', warning: 'Be careful' }[kind]}</strong>
      <div>{children}</div>
    </aside>
  )
}

export const Steps = ({ children }: { children: ReactNode }) => <ol className="docs-steps">{children}</ol>

export const Step = ({ title, children }: { title: string; children: ReactNode }) => (
  <li>
    <h3>{title}</h3>
    {children}
  </li>
)

export const Cards = ({ children }: { children: ReactNode }) => <div className="docs-cards">{children}</div>

export const CardGroup = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="docs-card-group">
    <h3 className="docs-card-group-title">{title}</h3>
    <Cards>{children}</Cards>
  </section>
)

export const Card = ({ href, title, children, eyebrow }: { href: string; title: string; children: ReactNode; eyebrow?: string }) => (
  <Link href={href} className="docs-card">
    {eyebrow && <span className="docs-card-eyebrow">{eyebrow}</span>}
    <strong>{title}</strong>
    <span>{children}</span>
  </Link>
)

export function DocsArticle({ href, title, lead, children }: { href: string; title: string; lead?: ReactNode; children: ReactNode }) {
  const index = DOCS_PAGES.findIndex(page => page.href === href)
  const prev = DOCS_PAGES[index - 1]
  const next = DOCS_PAGES[index + 1]
  return (
    <article className="docs-article">
      <h1>{title}</h1>
      {lead && <p className="docs-lead">{lead}</p>}
      {children}
      <nav className="docs-pager" aria-label="Pagination">
        {prev ? (
          <Link href={prev.href} rel="prev">
            <span>Previous</span>
            {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={next.href} rel="next" className="docs-pager-next">
            <span>Next</span>
            {next.title}
          </Link>
        )}
      </nav>
    </article>
  )
}
