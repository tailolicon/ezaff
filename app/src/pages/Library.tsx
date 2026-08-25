import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AddLinkModal } from '../components/AddLinkModal'
import {
  AppSidebar,
  type LibraryView,
  type SidebarGroup,
} from '../components/AppSidebar'
import { BulkBar } from '../components/BulkBar'
import {
  EditProductDialog,
  type EditableProduct,
  type EditProductPayload,
} from '../components/EditProductDialog'
import {
  countActiveFilters,
  EMPTY_FILTERS,
  FilterBar,
  type FilterState,
  type ViewMode,
} from '../components/FilterBar'
import {
  ImportPreview,
  type ImportPreviewData,
} from '../components/ImportPreview'
import { Menu, MenuItem } from '../components/Menu'
import { ProductGrid } from '../components/ProductGrid'
import { TemplateEditorDialog } from '../components/TemplateEditorDialog'
import type { ProductCardData } from '../components/ProductCard'
import { ProductList } from '../components/ProductList'
import {
  PageHead,
  PlatformChips,
  SearchRow,
  type PlatformCount,
} from '../components/StageHeader'
import { Toast, type ToastData } from '../components/Toast'
import type { TemplateOption } from '../components/TemplatePicker'
import { dragHasFiles, importablePathsFromDrop } from '../lib/fileDrop'
import { formatCount } from '../lib/format'
import { GROUP_COLORS, groupColor } from '../lib/product'

type Props = {
  onOpenSettings: (tab?: 'templates' | 'data' | 'about') => void
}

function parseOptionalInt(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Days-back preset → epoch ms lower bound. */
function dateRangeStart(days: string): number | null {
  const n = Number(days)
  if (!days || !Number.isFinite(n) || n <= 0) return null
  return Date.now() - n * 24 * 60 * 60 * 1000
}

const EMPTY_COUNTS: ProductCounts = {
  total: 0,
  missing: 0,
  error: 0,
  ungrouped: 0,
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Optimistic placeholder shown the instant a link is added. */
function pendingCard(url: string, index: number): ProductCardData {
  let host = url
  try {
    host = new URL(url).host.replace(/^www\./, '')
  } catch {
    /* keep raw */
  }
  const platform = /shopee/i.test(url)
    ? 'shopee'
    : /lazada/i.test(url)
      ? 'lazada'
      : /tiktok/i.test(url)
        ? 'tiktok'
        : /tiki/i.test(url)
          ? 'tiki'
          : 'other'
  return {
    id: `pending-${index}-${url}`,
    platform,
    title: host,
    image_url: null,
    image_local: null,
    price: null,
    currency: 'VND',
    shop_name: null,
    rating: null,
    rating_count: null,
    sold: null,
    note: null,
    category: null,
    scrape_status: 'scraping',
    scrape_error: null,
    copy_count: 0,
    groups: [],
    pending: true,
  }
}

export function Library({ onOpenSettings }: Props) {
  const [products, setProducts] = useState<ProductListItem[]>([])
  // Template editor lives here so it can open from any card's copy button.
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  const [groups, setGroups] = useState<SidebarGroup[]>([])
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [counts, setCounts] = useState<ProductCounts>(EMPTY_COUNTS)
  const [categories, setCategories] = useState<string[]>([])
  const [categoryTree, setCategoryTree] = useState<CategoryNode[]>([])
  const [platformCounts, setPlatformCounts] = useState<PlatformCount[]>([])
  const [loading, setLoading] = useState(true)

  const [adding, setAdding] = useState(false)
  const [pendingCards, setPendingCards] = useState<ProductCardData[]>([])
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())

  const [saving, setSaving] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [rescrapingId, setRescrapingId] = useState<string | null>(null)
  const [pasteImageId, setPasteImageId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastData | null>(null)

  const [editing, setEditing] = useState<EditableProduct | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [productGroupIds, setProductGroupIds] = useState<string[]>([])

  const [addOpen, setAddOpen] = useState(false)
  const [addReason, setAddReason] = useState<string | undefined>(undefined)

  const [assignFor, setAssignFor] = useState<string | null>(null)

  const [importPreview, setImportPreview] = useState<ImportPreviewData | null>(
    null,
  )
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [excelOpen, setExcelOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  const [collapsed, setCollapsed] = useState(false)
  const [view, setView] = useState<ViewMode>('grid')
  const [libraryView, setLibraryView] = useState<LibraryView>('all')
  const [showFilters, setShowFilters] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedBucket, setSelectedBucket] = useState<ProductBucket | null>(
    null,
  )
  const [selectedCategoryPath, setSelectedCategoryPath] = useState<
    string | null
  >(null)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [debouncedQuery, setDebouncedQuery] = useState('')

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(filters.query)
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [filters.query])

  // Saved views drive sort + date window on top of the manual filters
  const effectiveSort: ProductSort =
    libraryView === 'most_used'
      ? 'most_used'
      : libraryView === 'recent'
        ? 'newest'
        : filters.sort

  const listFilter = useMemo<ListProductsFilter>(
    () => ({
      query: debouncedQuery,
      groupId: selectedGroupId,
      bucket: selectedBucket,
      categoryPath: selectedCategoryPath,
      platform: filters.platform || null,
      priceMin: parseOptionalInt(filters.priceMin),
      priceMax: parseOptionalInt(filters.priceMax),
      dateFrom:
        libraryView === 'recent'
          ? Date.now() - RECENT_WINDOW_MS
          : dateRangeStart(filters.dateRange),
      dateTo: null,
      sort: effectiveSort,
    }),
    [
      debouncedQuery,
      selectedGroupId,
      selectedBucket,
      selectedCategoryPath,
      filters.platform,
      filters.priceMin,
      filters.priceMax,
      filters.dateRange,
      effectiveSort,
      libraryView,
    ],
  )

  const refreshGroups = useCallback(async () => {
    const result = await window.ezaff.groups.list()
    if (!result.success) {
      setError(result.error)
      return
    }
    setGroups(result.data)
  }, [])

  const refreshTemplates = useCallback(async () => {
    const result = await window.ezaff.templates.list()
    if (!result.success) {
      setError(result.error)
      return
    }
    setTemplates(
      result.data.map((t) => ({
        id: t.id,
        name: t.name,
        is_default: t.is_default,
      })),
    )
  }, [])

  const refreshProducts = useCallback(async () => {
    const result = await window.ezaff.products.list(listFilter)
    if (!result.success) {
      setError(result.error)
      return
    }
    setProducts(result.data)
    setError(null)
  }, [listFilter])

  /** Counters, categories and platform tallies for the rail + chips. */
  const refreshMeta = useCallback(async () => {
    const [countsResult, categoriesResult, treeResult, allResult] =
      await Promise.all([
        window.ezaff.products.counts(),
        window.ezaff.products.categories(),
        window.ezaff.products.categoryTree(),
        window.ezaff.products.list({}),
      ])
    if (countsResult.success) setCounts(countsResult.data)
    if (categoriesResult.success) setCategories(categoriesResult.data)
    if (treeResult.success) setCategoryTree(treeResult.data)
    if (allResult.success) {
      const tally = new Map<string, number>()
      for (const p of allResult.data) {
        tally.set(p.platform, (tally.get(p.platform) ?? 0) + 1)
      }
      setPlatformCounts(
        [...tally.entries()]
          .map(([platform, count]) => ({ platform, count }))
          .sort((a, b) => b.count - a.count),
      )
      setMostUsedCount(allResult.data.filter((p) => p.copy_count > 0).length)
      const cutoff = Date.now() - RECENT_WINDOW_MS
      setRecentCount(allResult.data.filter((p) => p.created_at >= cutoff).length)
    }
  }, [])

  const [mostUsedCount, setMostUsedCount] = useState(0)
  const [recentCount, setRecentCount] = useState(0)

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshProducts(),
      refreshGroups(),
      refreshTemplates(),
      refreshMeta(),
    ])
  }, [refreshProducts, refreshGroups, refreshTemplates, refreshMeta])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        if (!window.ezaff) {
          throw new Error('API preload (window.ezaff) chưa sẵn sàng')
        }
        await Promise.all([
          refreshProducts(),
          refreshGroups(),
          refreshTemplates(),
          refreshMeta(),
        ])
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, [])

  useEffect(() => {
    if (loading) return
    void refreshProducts()
  }, [listFilter, loading, refreshProducts])

  // Imported products scrape one by one in the background — refresh as they land
  useEffect(() => {
    if (!window.ezaff?.excel?.onRescrapeProgress) return
    return window.ezaff.excel.onRescrapeProgress(({ done, total }) => {
      setBanner(
        done >= total
          ? `Đã quét xong ${formatCount(total)} sản phẩm vừa nhập.`
          : `Đang quét bổ sung ${done}/${total} sản phẩm…`,
      )
      void refreshProducts()
      if (done >= total) void refreshMeta()
    })
  }, [refreshProducts, refreshMeta])

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const visible = new Set(products.map((p) => p.id))
      const next = new Set<string>()
      for (const id of prev) if (visible.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [products])

  // ── Add links ──────────────────────────────────────────────────────────

  const runAdd = useCallback(
    async (urls: string[]): Promise<void> => {
      setAdding(true)
      setAddOpen(false)
      setError(null)
      setPendingCards(urls.map((u, i) => pendingCard(u, i)))

      const savedIds: string[] = []
      let duplicates = 0
      let failed = 0

      try {
        for (const url of urls) {
          const result = await window.ezaff.products.create({
            original_url: url,
          })
          if (result.success) {
            savedIds.push(result.data.id)
            if (result.data.scrape_status === 'error') failed += 1
          } else if (/trùng|canonical_key|đã tồn tại/i.test(result.error)) {
            duplicates += 1
          } else {
            failed += 1
            setError(result.error)
          }
          setPendingCards((prev) => prev.slice(1))
        }

        setFreshIds(new Set(savedIds))
        await refreshAll()

        const parts: string[] = []
        if (savedIds.length > 0) parts.push(`${savedIds.length} link`)
        if (duplicates > 0) parts.push(`bỏ qua ${duplicates} trùng`)
        if (failed > 0) parts.push(`${failed} cần nhập tay`)

        setToast({
          message:
            savedIds.length > 0
              ? `Đã thêm ${parts.join(' · ')}`
              : duplicates > 0
                ? `Tất cả ${duplicates} link đã có trong thư viện`
                : 'Không thêm được link nào',
          actionLabel: savedIds.length > 0 ? 'Hoàn tác' : undefined,
          onAction:
            savedIds.length > 0
              ? () => void undoAdd(savedIds)
              : undefined,
        })

        // Drop the highlight after a while so the grid settles
        window.setTimeout(() => setFreshIds(new Set()), 8000)
      } finally {
        setPendingCards([])
        setAdding(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- undoAdd is stable enough
    [refreshAll],
  )

  async function undoAdd(ids: string[]): Promise<void> {
    setError(null)
    const result = await window.ezaff.products.deleteMany(ids)
    if (!result.success) {
      setError(result.error)
      return
    }
    setFreshIds(new Set())
    setToast({ message: `Đã hoàn tác — gỡ ${formatCount(result.data.deleted)} link` })
    await refreshAll()
  }

  /**
   * "＋ Thêm link" — if the clipboard already holds supported links, add them
   * straight away; otherwise open the modal (mockup 2A behaviour).
   */
  async function handleAddClick(): Promise<void> {
    // Read via IPC: the main process has clipboard access without a permission
    // prompt, and only marketplace links come back to the renderer.
    let links: string[] = []
    try {
      const result = await window.ezaff.clipboard.readLinks()
      if (result.success) links = result.data
    } catch {
      links = []
    }

    if (links.length > 0) {
      void runAdd(links)
      return
    }
    setAddReason('Clipboard chưa có link hợp lệ — dán link vào đây')
    setAddOpen(true)
  }

  // ── Single-product actions ─────────────────────────────────────────────

  async function handleRescrape(id: string): Promise<void> {
    setRescrapingId(id)
    setError(null)
    try {
      const result = await window.ezaff.products.rescrape(id)
      if (!result.success) {
        setError(result.error)
        return
      }
      setToast({
        message:
          result.data.scrape_status === 'error'
            ? 'Quét lại thất bại — sản phẩm vẫn được giữ để nhập tay'
            : result.data.scrape_status === 'partial'
              ? `Quét lại một phần — ${result.data.scrape_error || 'thiếu thông tin'}`
              : 'Quét lại thành công',
      })
      await refreshAll()
    } finally {
      setRescrapingId(null)
    }
  }

  async function handlePasteImage(id: string): Promise<void> {
    setPasteImageId(id)
    setError(null)
    try {
      const result = await window.ezaff.products.pasteImage({ productId: id })
      if (!result.success) {
        setError(result.error)
        return
      }
      setToast({ message: 'Đã dán ảnh vào sản phẩm' })
      await refreshAll()
    } finally {
      setPasteImageId(null)
    }
  }

  async function handleOpenProduct(id: string): Promise<void> {
    setError(null)
    const result = await window.ezaff.products.get(id)
    if (!result.success || !result.data) {
      setError(result.success ? 'Không tìm thấy sản phẩm' : result.error)
      return
    }
    const openResult = await window.ezaff.products.openProductPage(
      result.data.original_url,
    )
    if (!openResult.success) {
      setError(openResult.error)
      return
    }
    if (!openResult.data.opened) {
      setError(openResult.data.message)
      return
    }
    setToast({ message: openResult.data.message })
  }

  async function handleCopyOne(id: string): Promise<void> {
    setError(null)
    const result = await window.ezaff.copy.product({ productId: id })
    if (!result.success) {
      setError(result.error)
      return
    }
    setToast({ message: `Đã sao chép «${result.data.productName}»` })
    await refreshProducts()
  }

  async function handleEdit(id: string): Promise<void> {
    setError(null)
    const [productResult, groupsResult] = await Promise.all([
      window.ezaff.products.get(id),
      window.ezaff.groups.listForProduct(id),
    ])
    if (!productResult.success) {
      setError(productResult.error)
      return
    }
    if (!productResult.data) {
      setError('Không tìm thấy sản phẩm')
      return
    }
    if (!groupsResult.success) {
      setError(groupsResult.error)
      return
    }
    setEditing({
      id: productResult.data.id,
      original_url: productResult.data.original_url,
      title: productResult.data.title,
      price: productResult.data.price,
      currency: productResult.data.currency,
      category: productResult.data.category,
      shop_name: productResult.data.shop_name,
      note: productResult.data.note,
      image_url: productResult.data.image_url,
      image_local: productResult.data.image_local,
      platform: productResult.data.platform,
      category_path: productResult.data.category_path,
      updated_at: productResult.data.updated_at,
    })
    setProductGroupIds(groupsResult.data.map((g) => g.id))
    setDialogOpen(true)
  }

  async function handleSave(
    payload: EditProductPayload,
    groupIds: string[],
  ): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await window.ezaff.products.update({
        id: payload.id,
        original_url: payload.original_url,
        title: payload.title,
        price: payload.price,
        category: payload.category,
        category_path: payload.category_path,
        shop_name: payload.shop_name,
        note: payload.note,
        image_url: payload.image_url,
        image_local: payload.image_local,
      })
      if (!result.success) throw new Error(result.error)
      const groupResult = await window.ezaff.groups.setProductGroups(
        payload.id,
        groupIds,
      )
      if (!groupResult.success) throw new Error(groupResult.error)
      setDialogOpen(false)
      setEditing(null)
      setToast({ message: 'Đã cập nhật sản phẩm' })
      await refreshAll()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    const target = products.find((p) => p.id === id)
    const label = target?.title?.trim() || 'sản phẩm này'
    if (!window.confirm(`Bạn có chắc muốn xoá «${label}»?`)) return

    setError(null)
    const result = await window.ezaff.products.delete(id)
    if (!result.success) {
      setError(result.error)
      return
    }
    setToast({ message: 'Đã xoá sản phẩm' })
    if (editing?.id === id) {
      setDialogOpen(false)
      setEditing(null)
    }
    await refreshAll()
  }

  // ── Groups ─────────────────────────────────────────────────────────────

  const createGroup = useCallback(
    async (name: string): Promise<string | null> => {
      const color = GROUP_COLORS[groups.length % GROUP_COLORS.length]
      const result = await window.ezaff.groups.create({ name, color })
      if (!result.success) throw new Error(result.error)
      await refreshGroups()
      return result.data.id
    },
    [groups.length, refreshGroups],
  )

  async function handleCreateGroup(name: string): Promise<void> {
    await createGroup(name)
    setToast({ message: `Đã tạo nhóm «${name}»` })
  }

  async function handleRenameGroup(id: string, name: string): Promise<void> {
    const result = await window.ezaff.groups.update({ id, name })
    if (!result.success) throw new Error(result.error)
    await refreshGroups()
  }

  async function handleDeleteGroup(id: string): Promise<void> {
    const result = await window.ezaff.groups.delete(id)
    if (!result.success) throw new Error(result.error)
    if (selectedGroupId === id) setSelectedGroupId(null)
    await refreshAll()
    setToast({ message: 'Đã xoá nhóm' })
  }

  /** Quick "Gán nhóm" from a card. */
  async function assignSingle(productId: string, groupId: string): Promise<void> {
    setAssignFor(null)
    setError(null)
    const result = await window.ezaff.groups.assign(productId, groupId)
    if (!result.success) {
      setError(result.error)
      return
    }
    const name = groups.find((g) => g.id === groupId)?.name ?? 'nhóm'
    setToast({ message: `Đã gán vào «${name}»` })
    await refreshAll()
  }

  // ── Bulk actions ───────────────────────────────────────────────────────

  const selectedList = useMemo(() => [...selectedIds], [selectedIds])

  function toggleRow(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible(): void {
    setSelectedIds((prev) => {
      const allSelected =
        products.length > 0 && products.every((p) => prev.has(p.id))
      return allSelected ? new Set() : new Set(products.map((p) => p.id))
    })
  }

  async function handleBulkAssign(groupId: string): Promise<void> {
    setBulkBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.groups.assignMany(selectedList, groupId)
      if (!result.success) {
        setError(result.error)
        return
      }
      const name = groups.find((g) => g.id === groupId)?.name ?? 'nhóm'
      setToast({
        message: `Đã gán ${formatCount(result.data.added)} sản phẩm vào «${name}»`,
      })
      await refreshAll()
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleBulkCopy(
    templateId: string | null | undefined,
  ): Promise<void> {
    setBulkBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.copy.products({
        productIds: selectedList,
        ...(templateId === undefined ? {} : { templateId }),
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      setToast({
        message:
          result.data.failed > 0
            ? `Đã sao chép ${formatCount(result.data.copied)} sản phẩm (${result.data.failed} lỗi)`
            : `Đã sao chép ${formatCount(result.data.copied)} sản phẩm`,
      })
      await refreshProducts()
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleBulkRescrape(): Promise<void> {
    const ids = selectedList
    setBulkBusy(true)
    setError(null)
    let fixed = 0
    let stillIncomplete = 0
    let failed = 0
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        setRescrapingId(id)
        setBanner(`Đang quét lại ${i + 1}/${ids.length}…`)
        try {
          const result = await window.ezaff.products.rescrape(id)
          if (!result.success) failed += 1
          else if (result.data.scrape_status === 'done') fixed += 1
          else stillIncomplete += 1
        } catch {
          failed += 1
        }
      }
      const parts: string[] = []
      if (fixed > 0) parts.push(`${fixed} đầy đủ`)
      if (stillIncomplete > 0) parts.push(`${stillIncomplete} vẫn thiếu`)
      if (failed > 0) parts.push(`${failed} lỗi`)
      setBanner(null)
      setToast({
        message: `Quét lại ${formatCount(ids.length)} sản phẩm: ${parts.join(', ')}`,
      })
      await refreshAll()
    } finally {
      setRescrapingId(null)
      setBulkBusy(false)
    }
  }

  async function handleBulkExport(): Promise<void> {
    setBulkBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.excel.export({
        productIds: selectedList,
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.data.cancelled) return
      const { count, path } = result.data.result
      setBanner(`Đã xuất ${formatCount(count)} sản phẩm đã chọn → ${path}`)
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleBulkDelete(): Promise<void> {
    const n = selectedList.length
    if (
      !window.confirm(
        `Xoá ${n} sản phẩm đã chọn? Thao tác này không thể hoàn tác.`,
      )
    ) {
      return
    }
    setBulkBusy(true)
    setError(null)
    try {
      const result = await window.ezaff.products.deleteMany(selectedList)
      if (!result.success) {
        setError(result.error)
        return
      }
      setSelectedIds(new Set())
      setToast({ message: `Đã xoá ${formatCount(result.data.deleted)} sản phẩm` })
      await refreshAll()
    } finally {
      setBulkBusy(false)
    }
  }

  // ── Excel ──────────────────────────────────────────────────────────────

  async function handleExport(): Promise<void> {
    setExcelOpen(false)
    setExporting(true)
    setError(null)
    try {
      const result = await window.ezaff.excel.export()
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.data.cancelled) return
      const { count, path } = result.data.result
      setBanner(`Đã xuất ${formatCount(count)} sản phẩm → ${path}`)
    } finally {
      setExporting(false)
    }
  }

  /** Open the import preview for a file the user dropped. */
  const previewDroppedFile = useCallback(
    async (filePath: string): Promise<void> => {
      setAddOpen(false)
      setError(null)
      try {
        const result = await window.ezaff.excel.previewImportPath(filePath)
        if (!result.success) {
          setError(result.error)
          return
        }
        if (result.data.cancelled) return
        const { preview } = result.data
        setImportPreview({
          filePath: preview.filePath,
          validCount: preview.validCount,
          duplicateCount: preview.duplicateCount,
          invalidCount: preview.invalidCount,
          totalDataRows: preview.totalDataRows,
          detection: preview.detection,
        })
        setImportOpen(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [],
  )

  const handleImportPick = useCallback(async (): Promise<void> => {
    setExcelOpen(false)
    setError(null)
    try {
      const result = await window.ezaff.excel.previewImport()
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.data.cancelled) return
      const { preview } = result.data
      setImportPreview({
        filePath: preview.filePath,
        validCount: preview.validCount,
        duplicateCount: preview.duplicateCount,
        invalidCount: preview.invalidCount,
        totalDataRows: preview.totalDataRows,
        detection: preview.detection,
      })
      setImportOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  async function handleImportConfirm(overwrite: boolean): Promise<void> {
    if (!importPreview) return
    setImporting(true)
    setError(null)
    try {
      const result = await window.ezaff.excel.confirmImport({
        filePath: importPreview.filePath,
        overwrite,
      })
      if (!result.success) throw new Error(result.error)
      const r = result.data
      const parts: string[] = []
      if (r.inserted > 0) parts.push(`thêm ${r.inserted}`)
      if (r.updated > 0) parts.push(`cập nhật ${r.updated}`)
      if (r.skippedDuplicates > 0) parts.push(`bỏ qua trùng ${r.skippedDuplicates}`)
      if (r.invalid > 0) parts.push(`lỗi ${r.invalid}`)
      let msg =
        parts.length > 0
          ? `Nhập xong: ${parts.join(', ')}.`
          : 'Nhập xong: không có dòng nào được ghi.'
      if (r.errorFilePath) msg += ` File lỗi: ${r.errorFilePath}`
      if (r.rescrapeQueued > 0) {
        msg += ` Đang quét bổ sung ${r.rescrapeQueued} sản phẩm thiếu tên/ảnh.`
      }
      setBanner(msg)
      setImportOpen(false)
      setImportPreview(null)
      await refreshAll()
    } finally {
      setImporting(false)
    }
  }

  // ── Derived view state ─────────────────────────────────────────────────

  const activeGroup = groups.find((g) => g.id === selectedGroupId) ?? null
  const bucketLabel =
    selectedBucket === 'missing'
      ? 'Thiếu thông tin'
      : selectedBucket === 'error'
        ? 'Lỗi quét'
        : selectedBucket === 'ungrouped'
          ? 'Chưa gán nhóm'
          : null

  const title = activeGroup
    ? activeGroup.name
    : bucketLabel
      ? bucketLabel
      : selectedCategoryPath
        ? (selectedCategoryPath.split(' > ').pop() ?? 'Danh mục')
        : libraryView === 'most_used'
          ? 'Hay dùng nhất'
          : libraryView === 'recent'
            ? 'Mới thêm'
            : 'Thư viện của bạn'

  const pendingTotal = counts.missing + counts.error

  const subtitle = loading
    ? 'Đang tải…'
    : selectedCategoryPath
      ? selectedCategoryPath
      : pendingTotal > 0
        ? `Bạn có ${formatCount(counts.total)} link · ${formatCount(pendingTotal)} link cần bổ sung thông tin.`
        : `Bạn có ${formatCount(counts.total)} link, tất cả đã đủ thông tin.`

  const activeFilterCount = countActiveFilters(filters)

  const gridProducts: ProductCardData[] = [...pendingCards, ...products]

  return (
    <>
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        groups={groups}
        counts={counts}
        categories={categoryTree}
        view={libraryView}
        selectedGroupId={selectedGroupId}
        selectedBucket={selectedBucket}
        selectedCategoryPath={selectedCategoryPath}
        mostUsedCount={mostUsedCount}
        recentCount={recentCount}
        busy={bulkBusy}
        onSelectView={setLibraryView}
        onSelectGroup={setSelectedGroupId}
        onSelectBucket={setSelectedBucket}
        onSelectCategory={setSelectedCategoryPath}
        onCreateGroup={handleCreateGroup}
        onRenameGroup={handleRenameGroup}
        onDeleteGroup={handleDeleteGroup}
        onOpenExcel={() => setExcelOpen((v) => !v)}
      />

      <div
        className={dropActive ? 'stage stage--dropping' : 'stage'}
        onDragOver={(e) => {
          if (!dragHasFiles(e.nativeEvent)) return
          e.preventDefault()
          setDropActive(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDropActive(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropActive(false)
          const paths = importablePathsFromDrop(e.nativeEvent)
          if (paths[0]) {
            void previewDroppedFile(paths[0])
          } else if (dragHasFiles(e.nativeEvent)) {
            setError('Chỉ nhận file .csv hoặc .xlsx.')
          }
        }}
      >
        {dropActive && (
          <div className="dropveil" aria-hidden>
            <div className="dropveil__box">
              Thả file .csv / .xlsx để nhập sản phẩm
            </div>
          </div>
        )}

        <SearchRow
          query={filters.query}
          onQueryChange={(query) => setFilters({ ...filters, query })}
          onOpenSettings={() => onOpenSettings()}
        />

        <PageHead
          title={title}
          subtitle={subtitle}
          sort={effectiveSort}
          onSortChange={(sort) => {
            setLibraryView('all')
            setFilters({ ...filters, sort })
          }}
          addBusy={adding}
          onAdd={() => void handleAddClick()}
        />

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

        {excelOpen && (
          <div className="banner banner-ok" role="group">
            <span className="banner__text">
              Sao lưu và khôi phục thư viện bằng file Excel.
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={exporting || importing}
              onClick={() => void handleImportPick()}
            >
              Nhập Excel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={exporting || importing}
              onClick={() => void handleExport()}
            >
              {exporting ? 'Đang xuất…' : 'Xuất Excel'}
            </button>
            <button
              type="button"
              className="banner__dismiss"
              onClick={() => setExcelOpen(false)}
              aria-label="Đóng"
            >
              ✕
            </button>
          </div>
        )}

        <PlatformChips
          platforms={platformCounts}
          selected={filters.platform}
          onSelect={(platform) => setFilters({ ...filters, platform })}
          activeFilterCount={activeFilterCount}
          filtersOpen={showFilters}
          onToggleFilters={() => setShowFilters((v) => !v)}
        />

        {showFilters && (
          <FilterBar
            filters={filters}
            view={view}
            shown={products.length}
            total={counts.total}
            onChange={setFilters}
            onClear={() => {
              setFilters(EMPTY_FILTERS)
              setDebouncedQuery('')
            }}
            onViewChange={setView}
          />
        )}

        {selectedIds.size > 0 && (
          <BulkBar
            selectedCount={selectedIds.size}
            filteredCount={products.length}
            groups={groups}
            templates={templates}
            busy={bulkBusy}
            onSelectAll={() =>
              setSelectedIds(new Set(products.map((p) => p.id)))
            }
            onAssignGroup={(id) => void handleBulkAssign(id)}
            onCopyAll={(templateId) => void handleBulkCopy(templateId)}
            onRescrape={() => void handleBulkRescrape()}
            onExport={() => void handleBulkExport()}
            onDelete={() => void handleBulkDelete()}
          />
        )}

        <div className="results">
          {loading ? (
            <div className="product-grid product-grid--empty">
              <p>Đang tải danh sách sản phẩm…</p>
            </div>
          ) : view === 'grid' ? (
            <ProductGrid
              onCreateTemplate={() => setTemplateEditorOpen(true)}
              products={gridProducts}
              templates={templates}
              rescrapingId={rescrapingId}
              pasteImageId={pasteImageId}
              freshIds={freshIds}
              emptyMessage={
                activeFilterCount > 0 || selectedGroupId || selectedBucket
                  ? 'Không có sản phẩm nào khớp bộ lọc hiện tại.'
                  : 'Chưa có sản phẩm nào. Bấm «＋ Thêm link» để bắt đầu.'
              }
              onEdit={(id) => void handleEdit(id)}
              onDelete={(id) => void handleDelete(id)}
              onRescrape={(id) => void handleRescrape(id)}
              onPasteImage={(id) => void handlePasteImage(id)}
              onOpenProduct={(id) => void handleOpenProduct(id)}
              onAssignGroup={groups.length > 0 ? setAssignFor : undefined}
              onCopied={(productName) => {
                setToast({ message: `Đã sao chép «${productName}»` })
                void refreshProducts()
              }}
              onCopyError={(message) => setError(message)}
            />
          ) : (
            <ProductList
              products={products}
              totalCount={
                activeFilterCount > 0 || selectedGroupId || selectedBucket
                  ? products.length
                  : counts.total
              }
              selectedIds={selectedIds}
              rescrapingId={rescrapingId}
              pasteImageId={pasteImageId}
              onToggle={toggleRow}
              onToggleAll={toggleAllVisible}
              onEdit={(id) => void handleEdit(id)}
              onDelete={(id) => void handleDelete(id)}
              onRescrape={(id) => void handleRescrape(id)}
              onPasteImage={(id) => void handlePasteImage(id)}
              onOpenProduct={(id) => void handleOpenProduct(id)}
              onCopy={(id) => void handleCopyOne(id)}
            />
          )}
        </div>
      </div>

      {/* Quick group picker from a card's "Gán nhóm" */}
      {assignFor && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setAssignFor(null)}
        >
          <div
            className="modal"
            style={{ width: 360 }}
            role="dialog"
            aria-label="Chọn nhóm"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <div className="modal__title">Gán nhóm</div>
              <button
                type="button"
                className="modal__close"
                onClick={() => setAssignFor(null)}
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>
            <div className="modal__body">
              <div className="rail__list">
                {groups.map((g, i) => (
                  <button
                    key={g.id}
                    type="button"
                    className="rail__item rail__item--tight"
                    onClick={() => void assignSingle(assignFor, g.id)}
                  >
                    <span
                      className="rail__dot"
                      style={{ background: groupColor(g.color, i) }}
                      aria-hidden
                    />
                    <span className="rail__label">{g.name}</span>
                    <span className="rail__count">
                      {formatCount(g.product_count)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <AddLinkModal
        open={addOpen}
        busy={adding}
        reason={addReason}
        onCancel={() => setAddOpen(false)}
        onSubmit={(urls) => void runAdd(urls)}
        onFileDropped={(filePath) => void previewDroppedFile(filePath)}
        onPickFile={() => void handleImportPick()}
      />

      <TemplateEditorDialog
        open={templateEditorOpen}
        onClose={() => setTemplateEditorOpen(false)}
        onSaved={() => {
          void refreshTemplates()
          setBanner('Đã lưu mẫu câu mới.')
        }}
        onError={(message) => setBanner(message)}
      />

      <EditProductDialog
        product={editing}
        open={dialogOpen}
        busy={saving}
        allGroups={groups}
        selectedGroupIds={productGroupIds}
        categorySuggestions={categories}
        onCreateGroup={createGroup}
        onClose={() => {
          if (!saving) {
            setDialogOpen(false)
            setEditing(null)
          }
        }}
        onSave={handleSave}
      />

      <ImportPreview
        preview={importPreview}
        open={importOpen}
        busy={importing}
        onPickAnother={() => void handleImportPick()}
        onCancel={() => {
          setImportOpen(false)
          setImportPreview(null)
        }}
        onConfirm={handleImportConfirm}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  )
}

/** Re-exported so the settings page can reuse the same menu primitives. */
export { Menu, MenuItem }
