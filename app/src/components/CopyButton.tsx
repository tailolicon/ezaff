import { useCallback, useState } from 'react'
import {
  LINK_ONLY_VALUE,
  NEW_TEMPLATE_VALUE,
  TemplatePicker,
  type TemplateOption,
} from './TemplatePicker'

type Props = {
  productId: string
  templates: TemplateOption[]
  busy?: boolean
  /** "Sao chép" or "Sao chép link" when the product has no name yet. */
  label?: string
  /** Main button copies the raw link instead of the default template. */
  linkOnly?: boolean
  onCopied: (productName: string) => void
  onError: (message: string) => void
  /** Opens the inline template editor — templates are made where they are used. */
  onCreateTemplate?: () => void
}

/**
 * Split copy control: body uses the default template; caret opens TemplatePicker.
 * Copy path goes through IPC only — UI never sees the affiliate URL.
 */
export function CopyButton({
  productId,
  templates,
  busy = false,
  label = 'Sao chép',
  linkOnly = false,
  onCopied,
  onError,
  onCreateTemplate,
}: Props) {
  const [open, setOpen] = useState(false)
  const [copying, setCopying] = useState(false)

  const runCopy = useCallback(
    async (templateId?: string | null) => {
      setCopying(true)
      setOpen(false)
      try {
        const input =
          templateId === undefined
            ? { productId }
            : templateId === LINK_ONLY_VALUE || templateId === null
              ? { productId, templateId: LINK_ONLY_VALUE }
              : { productId, templateId }

        const result = await window.ezaff.copy.product(input)
        if (!result.success) {
          onError(result.error)
          return
        }
        // Toast must name the PRODUCT, never the raw link
        onCopied(result.data.productName)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setCopying(false)
      }
    },
    [productId, onCopied, onError],
  )

  const disabled = busy || copying

  return (
    <div className="copybtn">
      <div className="copybtn__split">
        <button
          type="button"
          className="copybtn__main"
          disabled={disabled}
          onClick={() => void runCopy(linkOnly ? LINK_ONLY_VALUE : undefined)}
          title={
            linkOnly
              ? 'Sao chép link affiliate'
              : 'Sao chép với mẫu câu mặc định'
          }
        >
          {copying ? 'Đang chép…' : label}
        </button>
        <button
          type="button"
          className="copybtn__caret"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Chọn mẫu câu mời"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
        >
          ▾
        </button>
      </div>
      <TemplatePicker
        templates={templates}
        open={open}
        placement="up"
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          if (id === NEW_TEMPLATE_VALUE) {
            setOpen(false)
            onCreateTemplate?.()
            return
          }
          void runCopy(id)
        }}
      />
    </div>
  )
}
