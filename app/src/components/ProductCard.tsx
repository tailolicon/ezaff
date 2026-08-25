import {
  formatCount,
  formatPrice,
  formatRatingNumber,
  formatSoldSuffix,
  platformLabel,
  productImageSrc,
} from '../lib/format'
import {
  deriveProductState,
  groupChipStyle,
  missingFieldsHint,
} from '../lib/product'
import { CopyButton } from './CopyButton'
import type { TemplateOption } from './TemplatePicker'

/**
 * Card props intentionally exclude original_url so the affiliate link
 * cannot be rendered in the list/grid.
 */
export type ProductCardData = {
  id: string
  platform: string
  title: string | null
  image_url: string | null
  image_local: string | null
  price: number | null
  currency: string
  shop_name: string | null
  rating?: number | null
  rating_count?: number | null
  sold?: number | null
  note: string | null
  category: string | null
  scrape_status: string | null
  scrape_error: string | null
  copy_count: number
  groups: ProductGroupRef[]
  /** Optimistic row that has not been persisted yet. */
  pending?: boolean
}

type Props = {
  product: ProductCardData
  templates: TemplateOption[]
  rescraping?: boolean
  /** Highlight ring — product was just added in this session. */
  fresh?: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRescrape: (id: string) => void
  onPasteImage?: (id: string) => void
  onOpenProduct?: (id: string) => void
  onAssignGroup?: (id: string) => void
  pasteImageBusy?: boolean
  onCopied: (productName: string) => void
  onCopyError: (message: string) => void
  onCreateTemplate?: () => void
}

export function ProductCard({
  product,
  templates,
  rescraping = false,
  fresh = false,
  onEdit,
  onDelete,
  onRescrape,
  onPasteImage,
  onOpenProduct,
  onAssignGroup,
  pasteImageBusy = false,
  onCopied,
  onCopyError,
  onCreateTemplate,
}: Props) {
  const pending = product.pending === true
  const title = product.title?.trim() || 'Chưa có tên'
  // Prefer remote CDN URL — bare Windows image_local paths break in the renderer
  const imageSrc = productImageSrc(product.image_local, product.image_url)
  const state = deriveProductState(product, rescraping || pending)
  const ratingText = formatRatingNumber(product.rating)
  const soldText = formatSoldSuffix(product.sold)

  const cardClass = [
    'pcard',
    state.tone === 'error' ? 'pcard--error' : '',
    state.tone === 'partial' ? 'pcard--warn' : '',
    fresh || pending ? 'pcard--fresh' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const priceMissing = product.price === null || product.price === undefined
  const linkOnlyCopy = state.tone === 'error' || !product.title?.trim()

  return (
    <article className={cardClass} data-product-id={product.id}>
      <div className="pcard__media">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={title}
            loading="lazy"
            className="pcard__img"
          />
        ) : (
          <span className="pcard__noimg">Không ảnh</span>
        )}
        <span className="pcard__platform">
          {platformLabel(product.platform)}
        </span>
        <span
          className={`pcard__status pcard__status--${state.tone}`}
          title={product.scrape_error ?? state.label}
        >
          {state.label}
        </span>
      </div>

      <div className="pcard__body">
        <div className="pcard__title" title={title}>
          {title}
        </div>
        <div
          className={
            priceMissing && !pending
              ? 'pcard__price pcard__price--missing'
              : 'pcard__price'
          }
        >
          {pending && priceMissing
            ? 'Đang lấy giá…'
            : formatPrice(product.price, product.currency)}
        </div>

        {state.tone === 'error' ? (
          <div className="pcard__meta pcard__meta--error">
            Không quét được trang sản phẩm
          </div>
        ) : (
          <div
            className={
              state.tone === 'partial' && !product.shop_name?.trim()
                ? 'pcard__meta pcard__meta--warn'
                : 'pcard__meta'
            }
          >
            <span className="pcard__shop">
              {product.shop_name?.trim() ||
                (state.tone === 'partial'
                  ? missingFieldsHint(product, state)
                  : '—')}
            </span>
            {(ratingText || soldText) && (
              <span className="pcard__stats">
                {ratingText && (
                  <span className="pcard__rating">
                    <span className="pcard__star" aria-hidden>
                      ★
                    </span>
                    {ratingText}
                  </span>
                )}
                {ratingText && soldText ? (
                  <span className="pcard__stats-sep">·</span>
                ) : null}
                {soldText && (
                  <span className="pcard__sold">{soldText}</span>
                )}
              </span>
            )}
          </div>
        )}

        <div className="pcard__tags">
          {/* No chip when ungrouped — a group is optional, not a missing field. */}
          {product.groups.slice(0, 1).map((g, i) => (
            <span key={g.id} className="chip" style={groupChipStyle(g.color, i)}>
              {g.name}
            </span>
          ))}
          {product.groups.length > 1 && (
            <span
              className="chip chip--muted"
              title={product.groups.map((g) => g.name).join(', ')}
            >
              +{product.groups.length - 1}
            </span>
          )}
          {pending ? (
            <span className="pcard__copies">vừa thêm</span>
          ) : (
            product.copy_count > 0 && (
              <span className="pcard__copies">
                {formatCount(product.copy_count)} copy
              </span>
            )
          )}
        </div>
      </div>

      <div className="pcard__footer">
        <CopyButton
          productId={product.id}
          templates={templates}
          busy={state.busy || pending}
          // A failed scrape has no price/shop, so the default template would
          // render half-empty — copy just the link instead.
          label={linkOnlyCopy ? 'Sao chép link' : 'Sao chép'}
          linkOnly={linkOnlyCopy}
          onCopied={onCopied}
          onError={onCopyError}
          onCreateTemplate={onCreateTemplate}
        />

        <div className="pcard__actions">
          {state.tone === 'error' ? (
            <>
              <button
                type="button"
                className="softbtn"
                onClick={() => onOpenProduct?.(product.id)}
                disabled={state.busy || pending || !onOpenProduct}
                title="Mở trang sản phẩm gốc"
              >
                Mở trang
              </button>
              <button
                type="button"
                className="softbtn softbtn--accent"
                onClick={() => onEdit(product.id)}
                disabled={state.busy || pending}
                title="Nhập thông tin sản phẩm bằng tay"
              >
                Nhập tay
              </button>
            </>
          ) : state.needsImage && onPasteImage && !pending ? (
            <>
              <button
                type="button"
                className="softbtn"
                onClick={() => onPasteImage(product.id)}
                disabled={pasteImageBusy || state.busy}
                title="Dán ảnh từ clipboard"
              >
                {pasteImageBusy ? 'Đang dán…' : 'Dán ảnh'}
              </button>
              <button
                type="button"
                className="softbtn"
                onClick={() => onEdit(product.id)}
                disabled={state.busy}
              >
                Sửa
              </button>
            </>
          ) : product.groups.length === 0 && onAssignGroup ? (
            <>
              <button
                type="button"
                className="softbtn"
                onClick={() => onEdit(product.id)}
                disabled={state.busy || pending}
              >
                Sửa
              </button>
              <button
                type="button"
                className="softbtn"
                onClick={() => onAssignGroup(product.id)}
                disabled={state.busy || pending}
                title="Gán sản phẩm vào nhóm"
              >
                Gán nhóm
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="softbtn"
                onClick={() => onEdit(product.id)}
                disabled={state.busy || pending}
              >
                Sửa
              </button>
              <button
                type="button"
                className="softbtn"
                onClick={() => onRescrape(product.id)}
                disabled={state.busy || pending}
                title="Quét lại thông tin sản phẩm"
              >
                {state.busy ? 'Đang quét…' : 'Quét lại'}
              </button>
            </>
          )}
          <button
            type="button"
            className="softbtn softbtn--danger"
            onClick={() => onDelete(product.id)}
            disabled={state.busy || pending}
          >
            Xoá
          </button>
        </div>
      </div>
    </article>
  )
}
