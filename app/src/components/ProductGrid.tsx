import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react'
import { ProductCard, type ProductCardData } from './ProductCard'
import type { TemplateOption } from './TemplatePicker'

type Props = {
  products: ProductCardData[]
  templates: TemplateOption[]
  rescrapingId?: string | null
  pasteImageId?: string | null
  /** Ids added in this session — drawn with a highlight ring. */
  freshIds?: Set<string>
  emptyMessage?: string
  onAssignGroup?: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRescrape: (id: string) => void
  onPasteImage?: (id: string) => void
  onOpenProduct?: (id: string) => void
  onCopied: (productName: string) => void
  onCreateTemplate?: () => void
  onCopyError: (message: string) => void
}

const GAP = 14
/** 4 columns at the mockup's 1440px width; degrades gracefully below that. */
const MIN_CARD_WIDTH = 250
/**
 * Mockup 2A says grid-auto-rows:272px, but its own card content measures
 * 328px (media 112 + body 123 + footer 93) — at 272 the group chip and copy
 * count are clipped off every card. Sized to fit instead.
 */
const CARD_HEIGHT = 328
const OVERSCAN_ROWS = 2

/**
 * Windowed product grid — only mounts visible rows so 5.000 items stay smooth.
 * Affiliate links are never part of ProductCardData.
 */
export function ProductGrid({
  products,
  templates,
  rescrapingId = null,
  pasteImageId = null,
  freshIds,
  emptyMessage = 'Chưa có sản phẩm nào. Bấm «＋ Thêm link» để bắt đầu.',
  onAssignGroup,
  onEdit,
  onDelete,
  onRescrape,
  onPasteImage,
  onOpenProduct,
  onCopied,
  onCreateTemplate,
  onCopyError,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const [viewportWidth, setViewportWidth] = useState(800)

  const isEmpty = products.length === 0

  // Layout effect so the first measure happens after commit but before paint —
  // an early 0-width reading would collapse the grid to a single column.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return

    const measure = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 0) setViewportWidth(w)
      if (h > 0) setViewportHeight(h)
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isEmpty])

  const columnCount = useMemo(() => {
    const usable = Math.max(viewportWidth - GAP, MIN_CARD_WIDTH)
    return Math.max(1, Math.floor((usable + GAP) / (MIN_CARD_WIDTH + GAP)))
  }, [viewportWidth])

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  if (isEmpty) {
    return (
      <div className="product-grid product-grid--empty">
        <p>{emptyMessage}</p>
      </div>
    )
  }

  const rowCount = Math.ceil(products.length / columnCount) || 0
  const rowHeight = CARD_HEIGHT + GAP
  const totalHeight = Math.max(0, rowCount * rowHeight - GAP)

  const startRow = Math.max(
    0,
    Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS,
  )
  const endRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS,
  )

  const visibleRows: number[] = []
  for (let r = startRow; r <= endRow; r++) {
    if (r >= 0 && r < rowCount) visibleRows.push(r)
  }

  return (
    <div
      ref={parentRef}
      className="product-grid"
      onScroll={onScroll}
      role="list"
      aria-label="Danh sách sản phẩm"
    >
      <div
        className="product-grid__spacer"
        style={{ height: totalHeight, position: 'relative' }}
      >
        {visibleRows.map((rowIndex) => {
          const start = rowIndex * columnCount
          const rowItems = products.slice(start, start + columnCount)
          return (
            <div
              key={rowIndex}
              role="presentation"
              style={{
                position: 'absolute',
                top: rowIndex * rowHeight,
                left: 0,
                right: 0,
                height: CARD_HEIGHT,
                display: 'grid',
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                gap: GAP,
              }}
            >
              {rowItems.map((product) => (
                <div key={product.id} role="listitem" style={{ minWidth: 0 }}>
                  <ProductCard
                    product={product}
                    templates={templates}
                    rescraping={rescrapingId === product.id}
                    fresh={freshIds?.has(product.id) === true}
                    pasteImageBusy={pasteImageId === product.id}
                    onAssignGroup={onAssignGroup}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onRescrape={onRescrape}
                    onPasteImage={onPasteImage}
                    onOpenProduct={onOpenProduct}
                    onCopied={onCopied}
                    onCreateTemplate={onCreateTemplate}
                    onCopyError={onCopyError}
                  />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
