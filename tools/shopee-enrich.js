/**
 * ezaff — bổ sung hoa hồng / giá / lượt bán cho đống link đã thu.
 *
 * `shopee-bulk-link.js` chỉ giữ lại {key, url} vì Worker chỉ cần chừng đó.
 * File này quét lại đúng bộ nguồn ấy nhưng CHỈ gọi endpoint danh sách — không
 * sinh link nữa — nên nhanh hơn hẳn (~10 request/nguồn thay vì 15, và không
 * phải tải CSV về). Xong thì ghép theo `owner:shopee:<shopId>:<itemId>`.
 *
 * Dán `shopee-bulk-link.js` TRƯỚC (để lấy kho từ khoá), rồi dán file này:
 *
 *   ezEnrich.sweep()      → quét metadata, ~1,5 tiếng
 *   ezEnrich.state()      → xem tiến độ
 *   ezEnrich.stop()       → dừng, chạy lại là tiếp
 *   ezEnrich.report()     → thống kê + xem thử 20 món hoa hồng cao nhất
 *   ezEnrich.csv()        → chuỗi CSV đã ghép sẵn với link (để POST ra đĩa)
 *
 * ── Ý NGHĨA CÁC TRƯỜNG (đã đối chiếu với giao diện) ───────────────────────
 *   default_commission_rate  → ĐÚNG con số "Tỉ lệ hoa hồng" trang web hiện.
 *                              Đây là thứ cần dùng.
 *   seller_commission_rate   → phần của người bán, luôn ≤ default. Không phải
 *                              tổng, đừng cộng vào.
 *   max_commission_rate      → luôn "0%" trên mọi món. Bỏ.
 *   price                    → đơn vị ×100.000 (4800000000 = 48.000₫).
 *
 * ── CẢNH BÁO VỀ "LỢI NHUẬN CAO" ──────────────────────────────────────────
 * Hoa hồng % cao không đồng nghĩa kiếm được nhiều. Tiền thực nhận mỗi đơn là
 * giá × %, nên món 53% giá 356k (≈189k/đơn) khác hẳn món 53% giá 15k
 * (≈8k/đơn). Cột `est_commission_vnd` bên dưới tính sẵn cho bạn.
 * Và cả hai đều vô nghĩa nếu món đó không ai mua — nên có thêm cột
 * `historical_sold` và `rating` để lọc.
 */
;(() => {
  const DB_NAME = 'ezaff-meta'
  const STORE = 'items'
  const STORE_META = 'meta'
  const LIST_URL = '/api/v3/offer/product/list'
  const LIST_PAGE_LIMIT = 50
  const LIST_CAP = 500

  /** Cùng nhịp với shopee-bulk-link.js — đừng hạ xuống, captcha đang rình. */
  const LIST_GAP_MS = [1200, 2500]
  const RETRY_MAX = 5
  const RETRY_BASE_MS = 5000
  const ANTIBOT_COOLDOWN_MS = 15 * 60 * 1000

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo)

  // ── kho lưu ────────────────────────────────────────────────────────────

  let dbPromise = null
  function db() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE)
        if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbPromise
  }

  function tx(store, mode, fn) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction(store, mode)
          const out = fn(t.objectStore(store))
          t.oncomplete = () => resolve(out)
          t.onerror = () => reject(t.error)
          t.onabort = () => reject(t.error)
        }),
    )
  }

  const putItems = (rows) => tx(STORE, 'readwrite', (s) => { for (const r of rows) s.put(r, r.key) })
  const countItems = () => tx(STORE, 'readonly', (s) => { const q = s.count(); return new Promise((res) => (q.onsuccess = () => res(q.result))) })
  const getMeta = (k) => tx(STORE_META, 'readonly', (s) => { const q = s.get(k); return new Promise((res) => (q.onsuccess = () => res(q.result))) })
  const setMeta = (k, v) => tx(STORE_META, 'readwrite', (s) => s.put(v, k))

  async function allItems() {
    const d = await db()
    return new Promise((resolve, reject) => {
      const out = []
      const cur = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c) return resolve(out)
        out.push(c.value)
        c.continue()
      }
      cur.onerror = () => reject(cur.error)
    })
  }

  // ── gọi API ────────────────────────────────────────────────────────────

  class AntiBotError extends Error {
    constructor() {
      super('tường chống bot chặn')
      this.name = 'AntiBotError'
    }
  }

  async function fetchList(source, offset) {
    const query = new URLSearchParams({
      list_type: '0',
      client_type: '1',
      sort_type: source.sort,
      page_offset: String(offset),
      page_limit: String(LIST_PAGE_LIMIT),
    })
    if (source.keyword) query.set('keyword', source.keyword)
    const res = await fetch(`${LIST_URL}?${query}`, { credentials: 'include' })
    if (/\/verify\/(traffic|captcha)/.test(res.url) || res.status === 403 || res.status === 429) {
      throw new AntiBotError()
    }
    if (!res.ok) throw new Error(`product/list → HTTP ${res.status}`)
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new AntiBotError()
    }
    return {
      items: json?.data?.list || [],
      total: Math.min(Number(json?.data?.total_count ?? 0), LIST_CAP),
    }
  }

  /** "12%" → 12. Trả 0 nếu rỗng. */
  const pct = (s) => parseFloat(String(s || '').replace('%', '')) || 0

  function toRow(it) {
    const c = it.batch_item_for_item_card_full || {}
    const priceVnd = Math.round(Number(c.price ?? 0) / 100000)
    const rate = pct(it.default_commission_rate)
    return {
      key: `owner:shopee:${c.shopid}:${it.item_id}`,
      name: String(c.name ?? ''),
      shop_name: String(c.shop_name ?? ''),
      price_vnd: priceVnd,
      commission_pct: rate,
      seller_commission_pct: pct(it.seller_commission_rate),
      // Tiền hoa hồng ước tính cho MỘT đơn ở mức giá hiện tại.
      est_commission_vnd: Math.round((priceVnd * rate) / 100),
      historical_sold: Number(c.historical_sold ?? c.sold ?? 0),
      rating: Number(c.item_rating?.rating_star ?? 0),
    }
  }

  async function withRetry(label, fn) {
    let trips = 0
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn()
      } catch (err) {
        if (err instanceof AntiBotError) {
          trips += 1
          if (trips >= 2) throw err
          console.warn(`[ezaff] ${label}: bị chặn, ngủ 15 phút. Đừng đụng vào tab.`)
          await sleep(ANTIBOT_COOLDOWN_MS)
          continue
        }
        if (attempt >= RETRY_MAX - 1) throw err
        await sleep(RETRY_BASE_MS * Math.pow(3, attempt))
      }
    }
  }

  // ── vòng quét ──────────────────────────────────────────────────────────

  const SORT = '1'
  const sourceId = (s) => `${s.keyword || '*'}|${s.sort}`

  function buildSources(keywords) {
    const words = [null, ...keywords]
    return words.map((keyword) => ({ keyword, sort: SORT }))
  }

  function resolveKeywords(opts) {
    const kw = opts.keywords || window.EZ_KEYWORDS || window.ezHarvest?.keywords
    if (!kw || !kw.length) {
      throw new Error('không có kho từ khoá — dán shopee-bulk-link.js trước, hoặc truyền {keywords:[...]}')
    }
    return kw
  }

  let running = false
  let stopRequested = false

  async function sweep(opts = {}) {
    if (running) return console.warn('[ezaff] đang chạy rồi')
    running = true
    stopRequested = false

    const sources = buildSources(resolveKeywords(opts))
    const done = new Set((await getMeta('doneSources')) || [])
    const todo = sources.filter((s) => !done.has(sourceId(s)))
    const before = await countItems()
    console.log(`[ezaff] metadata: ${todo.length}/${sources.length} nguồn cần quét · đang có ${before} món.`)

    const t0 = performance.now()
    let index = 0
    try {
      for (const source of todo) {
        if (stopRequested) break
        index += 1
        const label = `«${source.keyword || 'Tất cả'}»`
        const first = await withRetry(label, () => fetchList(source, 0))
        let offset = 0
        let batch = first.items
        while (!stopRequested && batch.length > 0 && offset < first.total) {
          await putItems(batch.map(toRow))
          offset += batch.length
          if (offset >= first.total) break
          await sleep(jitter(LIST_GAP_MS))
          batch = (await withRetry(label, () => fetchList(source, offset))).items
        }
        if (stopRequested) break
        done.add(sourceId(source))
        await setMeta('doneSources', [...done])
        const per = (performance.now() - t0) / index
        console.log(
          `[ezaff] ${index}/${todo.length} ${label} — tổng ${await countItems()} món` +
            ` · còn ~${Math.round(((todo.length - index) * per) / 60000)} phút`,
        )
        await sleep(jitter(LIST_GAP_MS))
      }
    } catch (err) {
      console.error(
        err instanceof AntiBotError
          ? '[ezaff] DỪNG: bị chặn, vào tab giải captcha rồi chạy lại ezEnrich.sweep().'
          : `[ezaff] dừng vì lỗi: ${err.message}`,
      )
    } finally {
      running = false
      console.log(`[ezaff] xong đợt này. ${before} → ${await countItems()} món.`)
    }
  }

  // ── ghép với link đã thu & xuất ────────────────────────────────────────

  /** Đọc {key,url} từ DB của shopee-bulk-link.js. */
  async function harvestedLinks() {
    const d = await new Promise((res, rej) => {
      const q = indexedDB.open('ezaff-harvest', 1)
      q.onsuccess = () => res(q.result)
      q.onerror = () => rej(q.error)
    })
    return new Promise((resolve, reject) => {
      const map = new Map()
      const cur = d.transaction('links', 'readonly').objectStore('links').openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c) return resolve(map)
        map.set(c.key, c.value)
        c.continue()
      }
      cur.onerror = () => reject(cur.error)
    })
  }

  const esc = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s))

  const COLUMNS = [
    'key', 'url', 'commission_pct', 'est_commission_vnd', 'price_vnd',
    'historical_sold', 'rating', 'shop_name', 'name',
  ]

  /** Chỉ xuất những món CÓ link — link mới là thứ dùng được. */
  async function joined() {
    const links = await harvestedLinks()
    const items = await allItems()
    const out = []
    for (const it of items) {
      const url = links.get(it.key)
      if (url) out.push({ ...it, url })
    }
    out.sort((a, b) => b.est_commission_vnd - a.est_commission_vnd)
    return { rows: out, totalLinks: links.size, totalItems: items.length }
  }

  async function csv() {
    const { rows } = await joined()
    return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => esc(r[c] ?? '')).join(','))].join('\n')
  }

  async function report() {
    const { rows, totalLinks, totalItems } = await joined()
    const withRate = rows.filter((r) => r.commission_pct > 0)
    console.log(
      `[ezaff] ${rows.length}/${totalLinks} link đã có metadata (${totalItems} món quét được).\n` +
        `  có hoa hồng > 0: ${withRate.length}\n` +
        `  hoa hồng trung bình: ${(withRate.reduce((n, r) => n + r.commission_pct, 0) / (withRate.length || 1)).toFixed(1)}%`,
    )
    console.table(
      rows.slice(0, 20).map((r) => ({
        'HH %': r.commission_pct,
        'HH/đơn (₫)': r.est_commission_vnd.toLocaleString('vi-VN'),
        'Giá (₫)': r.price_vnd.toLocaleString('vi-VN'),
        'Đã bán': r.historical_sold,
        Sao: r.rating.toFixed(1),
        'Sản phẩm': r.name.slice(0, 45),
      })),
    )
    return { linksWithMeta: rows.length, totalLinks }
  }

  window.ezEnrich = {
    sweep,
    csv,
    report,
    joined,
    stop: () => {
      stopRequested = true
      console.log('[ezaff] sẽ dừng sau bước hiện tại.')
    },
    state: async () => ({
      items: await countItems(),
      sourcesDone: new Set((await getMeta('doneSources')) || []).size,
      running,
    }),
    reset: async () => {
      await tx(STORE, 'readwrite', (s) => s.clear())
      await tx(STORE_META, 'readwrite', (s) => s.clear())
      console.log('[ezaff] đã xoá tiến độ metadata.')
    },
  }

  countItems().then((n) => console.log(`[ezaff] ezEnrich sẵn sàng — đã có ${n} món. Chạy ezEnrich.sweep()`))
})()
