import { useCallback, useEffect, useRef, useState } from 'react'
import { Toast, type ToastData } from '../components/Toast'
import { BrandLockup } from '../components/BrandMark'
import { formatCount } from '../lib/format'

type Template = {
  id: string
  name: string
  content: string
  is_default: boolean
  created_at: number
}

type ShopeeAuthStatus = {
  signedIn: boolean
  message: string
}

export type SettingsTab = 'templates' | 'data' | 'about'

type Props = {
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBack: () => void
}

const TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'templates', label: 'Mẫu câu mời chào' },
  { key: 'data', label: 'Dữ liệu & sao lưu' },
  { key: 'about', label: 'Về ezaff' },
]

/** One-click insert chips above the content editor (mockup frame C). */
const VARIABLES = ['{ten}', '{gia}', '{shop}', '{danhgia}', '{link}'] as const

const SHOPEE_SIGNOUT_CONFIRM =
  'Xoá phiên đăng nhập Shopee trên máy này? Ứng dụng sẽ không còn dùng phiên của bạn để quét sản phẩm cho đến khi bạn đăng nhập lại.'

const NEW_TEMPLATE = {
  name: 'Mẫu mới',
  content: '🛒 {ten}\n💰 Giá chỉ {gia}\n\n👉 Mua tại: {link}',
}

/** First line of a template, for the list preview. */
function oneLine(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

/**
 * Cài đặt — mẫu câu mời chào, dữ liệu & sao lưu, về ezaff.
 * Layout mirrors mockup frame C.
 */
export function Settings({ tab, onTabChange, onBack }: Props) {

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastData | null>(null)
  const [busy, setBusy] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  const [preview, setPreview] = useState<TemplatePreview | null>(null)

  const [shopeeStatus, setShopeeStatus] = useState<ShopeeAuthStatus | null>(
    null,
  )
  const [shopeeBusy, setShopeeBusy] = useState(false)
  const [dbPath, setDbPath] = useState<string | null>(null)

  const selected = templates.find((t) => t.id === selectedId) ?? null

  const refreshTemplates = useCallback(
    async (preferId?: string | null) => {
      const result = await window.ezaff.templates.list()
      if (!result.success) {
        setError(result.error)
        return
      }
      setTemplates(result.data)
      setError(null)
      setSelectedId((current) => {
        const wanted = preferId ?? current
        if (wanted && result.data.some((t) => t.id === wanted)) return wanted
        return (
          result.data.find((t) => t.is_default)?.id ?? result.data[0]?.id ?? null
        )
      })
    },
    [],
  )

  const refreshShopee = useCallback(async () => {
    const result = await window.ezaff.shopeeAuth.getStatus()
    if (result.success) {
      setShopeeStatus(result.data)
    } else {
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        await refreshTemplates()
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshTemplates])

  useEffect(() => {
    if (tab === 'data') {
      void refreshShopee()
      void window.ezaff.getDbStatus().then((r) => {
        if (r.success) setDbPath(r.data.path)
      })
    }
  }, [tab, refreshShopee])

  // Load the selected template into the editor
  useEffect(() => {
    if (!selected) {
      setDraftName('')
      setDraftContent('')
      setDirty(false)
      return
    }
    setDraftName(selected.name)
    setDraftContent(selected.content)
    setDirty(false)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- reload on switch only

  // Live preview, debounced
  useEffect(() => {
    if (!draftContent.trim()) {
      setPreview(null)
      return
    }
    const id = window.setTimeout(() => {
      void window.ezaff.templates
        .preview({ content: draftContent })
        .then((r) => {
          if (r.success) setPreview(r.data)
        })
    }, 250)
    return () => window.clearTimeout(id)
  }, [draftContent])

  function insertVariable(token: string): void {
    const el = contentRef.current
    if (!el) {
      setDraftContent((c) => c + token)
      setDirty(true)
      return
    }
    const start = el.selectionStart ?? draftContent.length
    const end = el.selectionEnd ?? draftContent.length
    const next =
      draftContent.slice(0, start) + token + draftContent.slice(end)
    setDraftContent(next)
    setDirty(true)
    window.setTimeout(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    }, 0)
  }

  async function handleCreate(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.templates.create({
        name: NEW_TEMPLATE.name,
        content: NEW_TEMPLATE.content,
      })
      if (!result.success) throw new Error(result.error)
      await refreshTemplates(result.data.id)
      setBanner('Đã tạo mẫu mới — sửa nội dung rồi bấm «Lưu mẫu».')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDuplicate(): Promise<void> {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.templates.create({
        name: `${draftName} (bản sao)`,
        content: draftContent,
      })
      if (!result.success) throw new Error(result.error)
      await refreshTemplates(result.data.id)
      setBanner('Đã nhân bản mẫu câu.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (!selected) return
    if (!draftName.trim()) {
      setError('Tên mẫu không được để trống')
      return
    }
    if (!draftContent.trim()) {
      setError('Nội dung mẫu không được để trống')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.templates.update({
        id: selected.id,
        name: draftName.trim(),
        content: draftContent,
      })
      if (!result.success) throw new Error(result.error)
      await refreshTemplates(selected.id)
      setDirty(false)
      setToast({ message: 'Đã lưu mẫu câu' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleSetDefault(): Promise<void> {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.templates.setDefault(selected.id)
      if (!result.success) throw new Error(result.error)
      await refreshTemplates(selected.id)
      setToast({ message: `«${result.data.name}» là mẫu mặc định` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!selected) return
    if (!window.confirm(`Bạn có chắc muốn xoá mẫu «${selected.name}»?`)) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.templates.delete(selected.id)
      if (!result.success) throw new Error(result.error)
      setSelectedId(null)
      await refreshTemplates(null)
      setBanner('Đã xoá mẫu câu.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleShopeeLogin(): Promise<void> {
    setShopeeBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.shopeeAuth.openLogin()
      if (!result.success) throw new Error(result.error)
      setShopeeStatus({
        signedIn: result.data.signedIn,
        message: result.data.message,
      })
      setBanner(
        result.data.signedIn
          ? 'Đã đăng nhập Shopee trên máy này. Quét sản phẩm sẽ dùng phiên này.'
          : 'Cửa sổ đăng nhập đã đóng. Trạng thái: chưa đăng nhập.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShopeeBusy(false)
      void refreshShopee()
    }
  }

  async function handleShopeeSignOut(): Promise<void> {
    if (!window.confirm(SHOPEE_SIGNOUT_CONFIRM)) return
    setShopeeBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.shopeeAuth.signOut()
      if (!result.success) throw new Error(result.error)
      setShopeeStatus({ signedIn: false, message: result.data.message })
      setBanner('Đã xoá phiên Shopee trên máy này.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShopeeBusy(false)
    }
  }

  async function handleExport(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.excel.export()
      if (!result.success) throw new Error(result.error)
      if (result.data.cancelled) return
      setBanner(
        `Đã xuất ${formatCount(result.data.result.count)} sản phẩm → ${result.data.result.path}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="settings">
        <div className="settings__bar">
          <button type="button" className="pill pill--sm" onClick={onBack}>
            ← Về thư viện
          </button>
          <h1 className="settings__title">Cài đặt</h1>
        </div>

        <div className="settings__tabs" role="tablist" aria-label="Mục cài đặt">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={
                tab === t.key
                  ? 'settings__tab settings__tab--active'
                  : 'settings__tab'
              }
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {banner && (
          <div className="banner banner-ok" role="status">
            <span className="banner__text">{banner}</span>
            <button
              type="button"
              className="banner__dismiss"
              onClick={() => setBanner(null)}
              aria-label="Đóng thông báo"
            >
              ✕
            </button>
          </div>
        )}

        {error && (
          <div className="banner banner-error" role="alert">
            <span className="banner__text">{error}</span>
            <button
              type="button"
              className="banner__dismiss"
              onClick={() => setError(null)}
              aria-label="Đóng lỗi"
            >
              ✕
            </button>
          </div>
        )}

        {tab === 'templates' && (
          <div className="settings__templates">
            <section className="card card--flush">
              <div className="card__header">
                <div>
                  <h2 className="card__title">Mẫu câu</h2>
                  <p className="card__subtitle">
                    {formatCount(templates.length)} mẫu · dùng khi nhấn Sao chép
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void handleCreate()}
                >
                  + Mẫu mới
                </button>
              </div>

              {loading ? (
                <p className="empty-note">Đang tải…</p>
              ) : templates.length === 0 ? (
                <p className="empty-note">
                  Chưa có mẫu nào. Bấm «+ Mẫu mới» để bắt đầu.
                </p>
              ) : (
                <ul className="tmpl-list">
                  {templates.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={
                          t.id === selectedId
                            ? 'tmpl-item tmpl-item--active'
                            : 'tmpl-item'
                        }
                        onClick={() => setSelectedId(t.id)}
                      >
                        <span className="tmpl-item__body">
                          <span className="tmpl-item__name">{t.name}</span>
                          <span className="tmpl-item__preview">
                            {oneLine(t.content)}
                          </span>
                        </span>
                        {t.is_default && (
                          <span className="tmpl-item__badge">Mặc định</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="settings__pane">
              <section className="card card--flush" style={{ flex: 1 }}>
                {selected ? (
                  <div className="tmpl-editor">
                    <div className="tmpl-editor__head">
                      <h2 className="card__title">Sửa mẫu — {selected.name}</h2>
                      <div className="button-row">
                        {!selected.is_default && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => void handleSetDefault()}
                          >
                            Đặt mặc định
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleDuplicate()}
                        >
                          Nhân bản
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void handleDelete()}
                        >
                          Xoá
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy || !dirty}
                          onClick={() => void handleSave()}
                        >
                          {busy ? 'Đang lưu…' : 'Lưu mẫu'}
                        </button>
                      </div>
                    </div>

                    <div className="field">
                      <label className="field-label" htmlFor="tmpl-name">
                        Tên mẫu
                      </label>
                      <input
                        id="tmpl-name"
                        className="input"
                        style={{ height: 36 }}
                        value={draftName}
                        disabled={busy}
                        onChange={(e) => {
                          setDraftName(e.target.value)
                          setDirty(true)
                        }}
                      />
                    </div>

                    <div className="field" style={{ flex: 1, minHeight: 0 }}>
                      <div className="tmpl-editor__head">
                        <span className="field-label">Nội dung</span>
                        <div className="tmpl-editor__vars">
                          {VARIABLES.map((v) => (
                            <button
                              key={v}
                              type="button"
                              className="var-chip"
                              title={`Chèn ${v}`}
                              disabled={busy}
                              onClick={() => insertVariable(v)}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                      <textarea
                        ref={contentRef}
                        className="tmpl-editor__content"
                        value={draftContent}
                        disabled={busy}
                        spellCheck={false}
                        aria-label="Nội dung mẫu câu"
                        onChange={(e) => {
                          setDraftContent(e.target.value)
                          setDirty(true)
                        }}
                      />
                    </div>

                    <div className="field">
                      <span className="field-label">
                        Xem trước
                        {preview?.productName
                          ? ` — ${preview.productName.toUpperCase()}`
                          : ''}
                      </span>
                      <div className="tmpl-preview">
                        {preview?.text || 'Nhập nội dung để xem trước…'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="empty-note">
                    Chọn một mẫu bên trái để sửa, hoặc tạo mẫu mới.
                  </p>
                )}
              </section>
            </div>
          </div>
        )}

        {tab === 'data' && (
          <div className="settings__pane">
            <section className="card card__pad">
              <h2 className="card__title">Sao lưu Excel</h2>
              <p className="settings__prose">
                File xuất chứa đầy đủ dữ liệu của bạn, kể cả link gốc — dùng để
                sao lưu hoặc chuyển sang máy khác. Khi nhập, ứng dụng luôn cho
                bạn xem trước và không ghi gì cho tới khi bạn xác nhận.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void handleExport()}
                >
                  Xuất toàn bộ thư viện
                </button>
                <button type="button" className="btn" onClick={onBack}>
                  Nhập Excel (ở thư viện)
                </button>
              </div>
            </section>

            <section className="card card__pad">
              <h2 className="card__title">Tài khoản Shopee (tuỳ chọn)</h2>
              <p className="settings__prose">
                Đăng nhập tài khoản Shopee <strong>của bạn</strong> giúp ứng dụng
                đọc được tên sản phẩm, giá và ảnh khi bạn thêm link. ezaff{' '}
                <strong>không bao giờ</strong> nhìn, lưu hay gửi mật khẩu / tên
                đăng nhập. Phiên chỉ lưu trên máy này.
              </p>
              <div className="status-line" role="status">
                <span
                  className={
                    shopeeStatus?.signedIn
                      ? 'status-line__dot status-line__dot--ok'
                      : 'status-line__dot'
                  }
                  aria-hidden
                />
                {shopeeStatus?.message ?? 'Đang kiểm tra phiên…'}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={shopeeBusy}
                  onClick={() => void handleShopeeLogin()}
                >
                  {shopeeBusy ? 'Đang mở…' : 'Đăng nhập Shopee'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={shopeeBusy}
                  onClick={() => void refreshShopee()}
                >
                  Làm mới trạng thái
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={shopeeBusy || !shopeeStatus?.signedIn}
                  onClick={() => void handleShopeeSignOut()}
                >
                  Đăng xuất / xoá phiên
                </button>
              </div>
            </section>

            <section className="card card__pad">
              <h2 className="card__title">Nơi lưu dữ liệu</h2>
              <dl className="meta-grid">
                <div>
                  <dt>Cơ sở dữ liệu</dt>
                  <dd className="mono">{dbPath ?? 'Đang đọc…'}</dd>
                </div>
                <div>
                  <dt>Ảnh sản phẩm</dt>
                  <dd className="mono">
                    {dbPath
                      ? dbPath.replace(/[^\\/]+$/, 'images')
                      : 'Đang đọc…'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        )}

        {tab === 'about' && (
          <div className="settings__pane">
            <section className="card card__pad">
              <div className="about-brand">
                <BrandLockup markSize={36} tagline />
              </div>
              <p className="settings__prose">
                Trình quản lý link affiliate cho thị trường Việt Nam. Lưu, phân
                loại và sao chép link nhanh với thư viện câu mời chào của riêng
                bạn.
              </p>
              <dl className="meta-grid">
                <div>
                  <dt>Phiên bản</dt>
                  <dd className="mono">{__APP_VERSION__}</dd>
                </div>
                <div>
                  <dt>Sàn hỗ trợ</dt>
                  <dd>Shopee, Lazada, Tiki, TikTok Shop, Sendo</dd>
                </div>
              </dl>
            </section>

            <section className="card card__pad">
              <h2 className="card__title">Quyền riêng tư</h2>
              <p className="settings__prose">
                • Toàn bộ sản phẩm và link của bạn nằm trên máy này (SQLite).
                <br />• Phiên đăng nhập Shopee (nếu có) chỉ lưu cục bộ, không
                rời khỏi máy.
                <br />• Không đồng bộ đám mây, không tài khoản người dùng ezaff.
                <br />• Mất mạng vẫn dùng được mọi chức năng trừ quét link mới.
              </p>
            </section>
          </div>
        )}
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  )
}
