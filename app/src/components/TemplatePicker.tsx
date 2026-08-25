import { Menu, MenuItem } from './Menu'

/** Special option: copy raw affiliate link only. */
export const LINK_ONLY_VALUE = '__link_only__'

/** Special option: open the editor instead of copying. */
export const NEW_TEMPLATE_VALUE = '__new_template__'

export type TemplateOption = {
  id: string
  name: string
  is_default?: boolean
}

type Props = {
  templates: TemplateOption[]
  open: boolean
  placement?: 'up' | 'down-left' | 'down-right'
  onSelect: (templateId: string | null) => void
  onClose: () => void
}

/**
 * Dropdown listing every template plus "Chỉ link (không câu mời)".
 * Rendered beside the copy button caret.
 */
export function TemplatePicker({
  templates,
  open,
  placement = 'up',
  onSelect,
  onClose,
}: Props) {
  return (
    <Menu
      open={open}
      placement={placement}
      label="Chọn mẫu câu mời"
      onClose={onClose}
    >
      {templates.map((t) => (
        <MenuItem
          key={t.id}
          onSelect={() => onSelect(t.id)}
          badge={t.is_default ? 'Mặc định' : undefined}
        >
          {t.name}
        </MenuItem>
      ))}
      <MenuItem separated onSelect={() => onSelect(LINK_ONLY_VALUE)}>
        Chỉ link (không câu mời)
      </MenuItem>
      <MenuItem onSelect={() => onSelect(NEW_TEMPLATE_VALUE)}>
        ＋ Tạo mẫu câu mới…
      </MenuItem>
    </Menu>
  )
}
