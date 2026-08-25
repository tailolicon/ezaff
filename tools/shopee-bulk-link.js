/**
 * ezaff — thu link affiliate hàng loạt từ dashboard Shopee Affiliate.
 *
 * Dán cả file vào Console của Chrome trên tab đang mở:
 *   https://affiliate.shopee.vn/offer/product_offer
 *
 * ĐỪNG copy bằng `cat file | clip.exe` — clip.exe đọc byte UTF-8 theo bảng mã
 * OEM nên 276 từ khoá tiếng Việt biến thành rác ("áo thun nữ" → "├ío thun nß╗»")
 * và tìm chẳng ra gì. Dùng PowerShell:
 *   Get-Content -Raw -Encoding UTF8 tools\shopee-bulk-link.js | Set-Clipboard
 * hoặc mở thẳng file rồi Ctrl+A Ctrl+C.
 *
 *   ezHarvest.sweep()        → quét TOÀN BỘ (danh sách gốc + ~276 từ khoá)
 *   ezHarvest.sweep({allSorts:true})  → vét thêm 4 kiểu sắp xếp nữa (chậm gấp 5, chỉ thêm ~6%)
 *   ezHarvest.sweep({keywords:['nồi chiên','tai nghe']})  → chỉ vài từ khoá
 *   ezHarvest.stop()         → dừng (an toàn, chạy lại là tiếp)
 *   ezHarvest.state()        → đã thu bao nhiêu, còn bao nhiêu nguồn
 *   ezHarvest.dump()         → tải JSON  (định dạng bulk put của Cloudflare KV)
 *   ezHarvest.dumpCsv()      → tải CSV   (key,url)
 *   ezHarvest.reset()        → xoá sạch tiến độ
 *
 * ── Cách hoạt động ────────────────────────────────────────────────────────
 * Không bấm UI. Gọi thẳng 3 endpoint mà chính trang này dùng, với đúng
 * cookie phiên đang đăng nhập:
 *
 *   1. GET  /api/v3/offer/product/list
 *           ?list_type&keyword&sort_type&page_offset&page_limit&client_type
 *      → { data: { list[], total_count } }      page_limit trần 50
 *
 *   2. POST /api/v3/offer/batch_product_links
 *      { affiliate_short_link: true, list: [ …10 trường… ], sub_ids: [5 chuỗi rỗng] }
 *      → { code: 0, data: { result: "<link file CSV>" } }    tối đa 100 món
 *      Đây đúng là thứ nút "Lấy link hàng loạt" gọi, chỉ khác là ta không
 *      phải tick 100 ô rồi lật trang bằng tay.
 *
 *   3. GET  <link CSV> → cột "Link ưu đãi" là link affiliate cần lấy
 *
 * ── VÌ SAO PHẢI QUÉT THEO TỪ KHOÁ ─────────────────────────────────────────
 * `total_count` của MỌI danh sách đều là **500** — trần cứng của Shopee, không
 * phải lỗi script (offset 490 trả 10 món cuối, offset 500 trả rỗng). Bấm "chọn
 * tất cả" rồi lật hết trang cũng chỉ ra đúng 500 link.
 *
 * Trục duy nhất phá được trần đó là `keyword`. Số đo thật:
 *   • danh sách gốc                → 500 link
 *   • + từ khoá "nồi chiên không dầu" → +500 link, gần như không trùng
 *   • + từ khoá "son môi"             → +499 link, gần như không trùng
 *   → 3 nguồn = 1.499 link duy nhất.
 * `sort_type` thì KHÔNG phá được: nó chỉ xếp lại đúng 500 món đó. Đo trên
 * danh sách gốc, chạy thêm sort 2 chỉ ra thêm 31 link mới. Vì vậy mặc định
 * chỉ quét 1 sort; bật `{allSorts:true}` nếu muốn vét nốt vài phần trăm đó.
 * (is_xtra, cat_id, shop_type, list_type đã thử — API bỏ qua hết.)
 *
 * Kho từ khoá mặc định có ~276 từ phủ các ngành hàng Shopee VN
 * → ~277 nguồn × 500 ≈ 138k lượt, thực thu thường 100k–130k link duy nhất.
 * Muốn nhiều hơn thì chỉ việc thêm từ khoá vào KEYWORDS.
 *
 * ── CHỐNG BOT — ĐỌC TRƯỚC KHI CHẠY ────────────────────────────────────────
 * Shopee có tường "Xác nhận để tiếp tục" (captcha kéo mảnh ghép). Bắn nhanh
 * ~10 request liên tiếp là dính, và khi dính thì **cả tab bị đá sang trang
 * captcha**, script chết theo (dữ liệu đã thu vẫn còn nguyên trong IndexedDB).
 *
 * Nên nhịp mặc định dưới đây cố tình chậm: ~1 request / 2 giây, mỗi nguồn
 * ~1 phút. Quét hết ~277 nguồn mất khoảng 4–5 tiếng. Đừng giảm GAP xuống.
 * Script tự nhận biết khi bị chặn và ngủ 15 phút rồi thử lại; dính 2 lần liên
 * tiếp thì nó dừng hẳn và bảo bạn vào tab giải captcha bằng tay.
 *
 * Nếu tab đã bị đá sang trang captcha: tự kéo mảnh ghép, quay lại
 * /offer/product_offer, dán lại file này rồi `ezHarvest.sweep()` — chạy tiếp
 * từ đúng chỗ dở.
 *
 * ── LƯU Ý VẬN HÀNH ────────────────────────────────────────────────────────
 * Cứ để tab chạy nền, tiến độ ghi vào IndexedDB sau mỗi lô 100 món; đóng tab /
 * mất mạng rồi mở lại chạy `sweep()` là đi tiếp. Đừng đăng xuất Shopee giữa
 * chừng, và đừng mở thêm tab nào cùng bắn API song song.
 */
;(() => {
  const DB_NAME = 'ezaff-harvest'
  const DB_VERSION = 1
  const STORE_LINKS = 'links'
  const STORE_META = 'meta'

  const LIST_URL = '/api/v3/offer/product/list'
  const BATCH_URL = '/api/v3/offer/batch_product_links'

  /** Trần cứng của từng endpoint — vượt là HTTP 400. */
  const LIST_PAGE_LIMIT = 50
  const BATCH_SIZE = 100
  /** Trần cứng của mỗi danh sách. Quét quá số này chỉ tốn request. */
  const LIST_CAP = 500

  /**
   * Nghỉ giữa các request. Đây là thứ giữ cho tường chống bot không bật —
   * đừng hạ xuống. ~1 request / 2 giây là ngưỡng đã chạy êm.
   */
  const LIST_GAP_MS = [1200, 2500]
  const BATCH_GAP_MS = [3000, 6000]
  /** Gặp lỗi thường thì lùi dần: 5s, 15s, 45s… tối đa 5 lần rồi bỏ nguồn đó. */
  const RETRY_MAX = 5
  const RETRY_BASE_MS = 5000
  /** Dính tường chống bot thì ngủ hẳn 15 phút. Lùi ít hơn là dính lại ngay. */
  const ANTIBOT_COOLDOWN_MS = 15 * 60 * 1000

  /**
   * Kiểu sắp xếp. 1 Liên quan · 2 Hoa hồng · 3 Bán chạy · 5 Giá tăng · 6 Giá giảm.
   * Chỉ xếp lại đúng 500 món của từ khoá, không mở thêm món mới (đo được:
   * sort thứ hai chỉ thêm ~6%). Mặc định dùng mỗi sort đầu.
   */
  const SORT_TYPES = ['1', '2', '3', '5', '6']

  /**
   * Kho từ khoá — phủ các ngành hàng chính của Shopee VN.
   * Thêm bớt thoải mái: mỗi từ khoá mới = tối đa 2.500 lượt món nữa.
   */
  const KEYWORDS = [
    // thời trang nữ
    'áo thun nữ', 'áo sơ mi nữ', 'áo khoác nữ', 'áo len nữ', 'áo hoodie nữ',
    'váy', 'đầm', 'chân váy', 'quần jean nữ', 'quần short nữ', 'quần âu nữ',
    'set đồ nữ', 'đồ bộ nữ', 'áo croptop', 'áo blazer', 'áo vest nữ',
    // thời trang nam
    'áo thun nam', 'áo sơ mi nam', 'áo polo nam', 'áo khoác nam', 'áo hoodie nam',
    'quần jean nam', 'quần short nam', 'quần tây nam', 'quần jogger', 'đồ bộ nam',
    'áo ba lỗ', 'áo tank top', 'quần lót nam', 'quần kaki nam',
    // giày dép & túi
    'giày thể thao', 'giày sneaker', 'giày cao gót', 'giày lười', 'giày sandal',
    'dép quai hậu', 'dép lê', 'giày boot', 'giày tây nam', 'giày búp bê',
    'túi xách nữ', 'balo', 'ví da nam', 'túi đeo chéo', 'vali kéo', 'túi tote',
    // phụ kiện
    'đồng hồ nam', 'đồng hồ nữ', 'kính mát', 'kính cận', 'thắt lưng nam',
    'mũ lưỡi trai', 'nón bucket', 'khăn choàng', 'vòng tay', 'dây chuyền',
    'bông tai', 'nhẫn bạc', 'kẹp tóc', 'băng đô', 'tất vớ',
    // mẹ & bé
    'đồ sơ sinh', 'bỉm tã', 'sữa bột', 'bình sữa', 'xe đẩy em bé',
    'ghế ăn dặm', 'đồ chơi trẻ em', 'quần áo trẻ em', 'giày trẻ em', 'nôi cũi',
    'khăn ướt', 'ti giả', 'máy hút sữa', 'địu em bé', 'bột ăn dặm',
    // sắc đẹp
    'son môi', 'kem chống nắng', 'sữa rửa mặt', 'serum', 'toner',
    'kem dưỡng ẩm', 'mặt nạ giấy', 'phấn phủ', 'kem nền', 'mascara',
    'chì kẻ mày', 'tẩy trang', 'nước hoa nữ', 'nước hoa nam', 'dầu gội',
    'dầu xả', 'sữa tắm', 'kem trị mụn', 'tẩy tế bào chết', 'xịt khoáng',
    'máy rửa mặt', 'máy triệt lông', 'sơn móng tay', 'thuốc nhuộm tóc', 'lăn khử mùi',
    // sức khoẻ
    'vitamin', 'thực phẩm chức năng', 'collagen', 'men vi sinh', 'khẩu trang',
    'máy đo huyết áp', 'nhiệt kế', 'băng gạc y tế', 'dụng cụ massage', 'gối massage',
    // điện thoại & phụ kiện
    'điện thoại', 'ốp lưng điện thoại', 'cường lực', 'sạc dự phòng', 'cáp sạc',
    'củ sạc nhanh', 'tai nghe bluetooth', 'tai nghe có dây', 'gậy chụp hình', 'giá đỡ điện thoại',
    'thẻ nhớ', 'apple watch', 'đồng hồ thông minh', 'airpods', 'sim data',
    // máy tính & laptop
    'laptop', 'chuột không dây', 'bàn phím cơ', 'tai nghe gaming', 'lót chuột',
    'ổ cứng di động', 'usb', 'hub type c', 'webcam', 'màn hình máy tính',
    'ram laptop', 'quạt tản nhiệt laptop', 'túi chống sốc laptop', 'giá đỡ laptop', 'ghế gaming',
    // điện tử
    'tivi', 'loa bluetooth', 'máy chiếu', 'camera an ninh', 'máy ảnh',
    'micro không dây', 'amply', 'loa kéo', 'đầu thu tv box', 'đèn livestream',
    // đồ gia dụng
    'nồi cơm điện', 'nồi chiên không dầu', 'bếp từ', 'ấm siêu tốc', 'máy xay sinh tố',
    'máy ép chậm', 'lò vi sóng', 'lò nướng', 'máy pha cà phê', 'bình giữ nhiệt',
    'chảo chống dính', 'bộ nồi', 'dao nhà bếp', 'thớt', 'hộp đựng thực phẩm',
    'máy hút bụi', 'robot hút bụi', 'máy lọc không khí', 'quạt điều hoà', 'quạt cây',
    'máy sấy tóc', 'bàn ủi', 'máy giặt mini', 'máy rửa chén', 'nồi áp suất',
    // nhà cửa & đời sống
    'chăn ga gối', 'ruột gối', 'rèm cửa', 'thảm trải sàn', 'móc treo tường',
    'kệ sách', 'bàn làm việc', 'ghế văn phòng', 'tủ nhựa', 'giá phơi đồ',
    'đèn ngủ', 'đèn led', 'đèn năng lượng mặt trời', 'gương trang điểm', 'sọt rác',
    'nước lau sàn', 'nước rửa chén', 'nước giặt', 'túi rác', 'cây lau nhà',
    'bình xịt côn trùng', 'sáp thơm phòng', 'khăn tắm', 'dép đi trong nhà', 'rổ nhựa',
    // bách hoá
    'mì tôm', 'bánh kẹo', 'cà phê', 'trà', 'sữa tươi',
    'nước ngọt', 'gạo', 'dầu ăn', 'nước mắm', 'hạt nêm',
    'đồ ăn vặt', 'hạt dinh dưỡng', 'yến mạch', 'ngũ cốc', 'đồ khô',
    'rong biển', 'bánh tráng', 'kẹo dẻo', 'sữa đặc', 'bột ngọt',
    // thể thao & du lịch
    'xe đạp', 'giày chạy bộ', 'thảm yoga', 'tạ tay', 'dây nhảy',
    'áo thể thao', 'quần legging', 'bóng đá', 'vợt cầu lông', 'đồ bơi',
    'lều cắm trại', 'bàn ghế xếp', 'bình nước thể thao', 'máy chạy bộ', 'găng tay tập gym',
    // ô tô & xe máy
    'mũ bảo hiểm', 'áo mưa', 'camera hành trình', 'bơm lốp', 'dầu nhớt xe máy',
    'phụ kiện ô tô', 'thảm lót sàn ô tô', 'giá đỡ điện thoại xe máy', 'khoá chống trộm', 'bọc vô lăng',
    // văn phòng phẩm & sở thích
    'bút bi', 'sổ tay', 'giấy note', 'máy tính casio', 'balo học sinh',
    'sách', 'truyện tranh', 'mô hình figure', 'lego', 'bộ cờ',
    'nhạc cụ', 'đàn guitar', 'màu vẽ', 'giấy vẽ', 'dụng cụ handmade',
    // thú cưng & khác
    'thức ăn cho chó', 'thức ăn cho mèo', 'cát vệ sinh mèo', 'chuồng chó', 'vòng cổ thú cưng',
    'cây cảnh mini', 'hạt giống', 'chậu trồng cây', 'phân bón', 'dụng cụ làm vườn',
    'máy khoan', 'bộ tua vít', 'băng keo', 'ổ cắm điện', 'bóng đèn',
  ]

  // ── tiện ích ───────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo)

  // ── kho lưu (IndexedDB — localStorage chết ở ~50k link) ────────────────

  let dbPromise = null
  function db() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(STORE_LINKS)) d.createObjectStore(STORE_LINKS)
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

  /** @returns {Promise<number>} số link mới thật sự thêm vào */
  async function putLinks(rows) {
    if (rows.length === 0) return 0
    const existing = await tx(STORE_LINKS, 'readonly', (s) => {
      const found = new Set()
      return Promise.all(
        rows.map(
          (r) =>
            new Promise((res) => {
              const q = s.getKey(r.key)
              q.onsuccess = () => {
                if (q.result !== undefined) found.add(r.key)
                res()
              }
              q.onerror = () => res()
            }),
        ),
      ).then(() => found)
    })
    const seen = await existing
    const fresh = rows.filter((r) => !seen.has(r.key))
    await tx(STORE_LINKS, 'readwrite', (s) => {
      for (const r of fresh) s.put(r.url, r.key)
    })
    return fresh.length
  }

  const countLinks = () =>
    tx(STORE_LINKS, 'readonly', (s) => {
      const q = s.count()
      return new Promise((res) => (q.onsuccess = () => res(q.result)))
    }).then((p) => p)

  const getMeta = (key) =>
    tx(STORE_META, 'readonly', (s) => {
      const q = s.get(key)
      return new Promise((res) => (q.onsuccess = () => res(q.result)))
    }).then((p) => p)

  const setMeta = (key, value) => tx(STORE_META, 'readwrite', (s) => s.put(value, key))

  async function allLinks() {
    const d = await db()
    return new Promise((resolve, reject) => {
      const out = []
      const t = d.transaction(STORE_LINKS, 'readonly')
      const cur = t.objectStore(STORE_LINKS).openCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c) return resolve(out)
        out.push({ key: c.key, value: c.value })
        c.continue()
      }
      cur.onerror = () => reject(cur.error)
    })
  }

  // ── rút link từ CSV ────────────────────────────────────────────────────

  const SHORTLINK = /https?:\/\/(?:s\.shopee\.vn|shope\.ee|shp\.ee)\/[A-Za-z0-9]+/
  /** Hai dạng link sản phẩm, giống hệt server/src/affiliateCsv.ts. */
  const ID_PATTERNS = [/\/product\/(\d+)\/(\d+)/, /-i\.(\d+)\.(\d+)/]

  function idsFromUrl(s) {
    for (const re of ID_PATTERNS) {
      const m = re.exec(s)
      if (m) return { shopId: m[1], itemId: m[2] }
    }
    return null
  }

  /**
   * Mỗi dòng CSV có cả link sản phẩm (chứa id) lẫn link ưu đãi (link aff).
   * Ghép hai thứ đó lại là ra đúng khoá KV mà Worker tra cứu. Quét theo dòng
   * vật lý vẫn đúng kể cả khi tên sản phẩm có xuống dòng, vì hai link luôn
   * nằm cuối cùng một dòng.
   */
  function extractCsv(text) {
    const out = []
    for (const line of text.split(/\r?\n/)) {
      const link = SHORTLINK.exec(line)
      const ids = idsFromUrl(line)
      if (link && ids) {
        out.push({ key: `owner:shopee:${ids.shopId}:${ids.itemId}`, url: link[0] })
      }
    }
    return out
  }

  // ── gọi API ────────────────────────────────────────────────────────────

  /** Dấu hiệu bị tường chống bot chặn — cần xử lý khác hẳn lỗi mạng thường. */
  class AntiBotError extends Error {
    constructor(where) {
      super(`tường chống bot chặn ở ${where}`)
      this.name = 'AntiBotError'
    }
  }

  /**
   * Khi bị chặn, Shopee không trả JSON: nó 302 sang /verify/traffic hoặc
   * /verify/captcha, hoặc trả về HTML. Bắt cả ba dạng, vì nếu cứ thử lại như
   * lỗi thường thì chỉ làm nó chặn nặng hơn.
   */
  async function getJson(url, init) {
    const res = await fetch(url, { credentials: 'include', ...init })
    const path = url.split('?')[0]
    if (/\/verify\/(traffic|captcha)/.test(res.url)) throw new AntiBotError(path)
    if (res.status === 403 || res.status === 429) throw new AntiBotError(path)
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new AntiBotError(path)
    }
  }

  /** @returns {Promise<{items: object[], total: number}>} */
  async function fetchList(source, offset) {
    const query = new URLSearchParams({
      list_type: '0',
      client_type: '1',
      sort_type: source.sort,
      page_offset: String(offset),
      page_limit: String(LIST_PAGE_LIMIT),
    })
    if (source.keyword) query.set('keyword', source.keyword)
    const json = await getJson(`${LIST_URL}?${query}`)
    return {
      items: json?.data?.list || [],
      total: Math.min(Number(json?.data?.total_count ?? 0), LIST_CAP),
    }
  }

  /**
   * Đúng 10 trường mà chính trang gửi lên — bắt được từ request thật của nó.
   * Thiếu trường thì API vẫn nhận nhưng CSV trả về sẽ khuyết cột.
   */
  function toBatchItem(it) {
    const c = it.batch_item_for_item_card_full || {}
    return {
      item_id: String(it.item_id ?? ''),
      item_name: String(c.name ?? ''),
      shop_name: String(c.shop_name ?? ''),
      long_link: String(it.long_link ?? ''),
      commission_rate: String(it.max_commission_rate ?? it.default_commission_rate ?? ''),
      price: Number(c.price ?? 0),
      sales: Number(c.historical_sold ?? c.sold ?? 0),
      product_link: String(it.product_link ?? ''),
      from_shop_id: String(c.shopid ?? ''),
      trace: String(it.trace ?? ''),
    }
  }

  /** Sinh link cho tối đa 100 món, trả về mảng { key, url }. */
  async function generateLinks(items) {
    const json = await getJson(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        affiliate_short_link: true,
        list: items.map(toBatchItem),
        // Để trống — ta cần link trần, không gắn tracking riêng.
        sub_ids: ['', '', '', '', ''],
      }),
    })
    if (json?.code !== 0) {
      throw new Error(`batch_product_links: ${json?.msg || 'code ' + json?.code}`)
    }
    const csvUrl = json?.data?.result
    if (typeof csvUrl !== 'string' || !/^https?:/i.test(csvUrl)) {
      throw new Error('không thấy link CSV trong phản hồi')
    }
    const res = await fetch(csvUrl, { credentials: 'include' })
    if (!res.ok) throw new Error(`tải CSV → HTTP ${res.status}`)
    return extractCsv(await res.text())
  }

  /**
   * Bọc retry cho mọi lời gọi mạng. Lỗi thường thì lùi dần; dính tường chống
   * bot thì ngủ hẳn 15 phút — và nếu ngủ dậy vẫn dính thì ném ra ngoài để
   * `sweep` dừng hẳn, vì lúc đó chỉ người thật giải captcha mới gỡ được.
   */
  async function withRetry(label, fn) {
    let antibotTrips = 0
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn()
      } catch (err) {
        if (err instanceof AntiBotError) {
          antibotTrips += 1
          if (antibotTrips >= 2) throw err
          console.warn(
            `[ezaff] ${label}: ${err.message}. Ngủ ${ANTIBOT_COOLDOWN_MS / 60000} phút rồi thử lại.` +
              ' Đừng đụng vào tab.',
          )
          await sleep(ANTIBOT_COOLDOWN_MS)
          continue
        }
        if (attempt >= RETRY_MAX - 1) throw err
        const wait = RETRY_BASE_MS * Math.pow(3, attempt)
        console.warn(`[ezaff] ${label} lỗi (${err.message}) — thử lại sau ${Math.round(wait / 1000)}s`)
        await sleep(wait)
      }
    }
  }

  // ── danh sách nguồn quét ───────────────────────────────────────────────

  const sourceId = (s) => `${s.keyword || '*'}|${s.sort}`

  /** Danh sách gốc (không từ khoá) đứng đầu, rồi tới kho từ khoá. */
  function buildSources({ allSorts = false, keywords = null } = {}) {
    const sorts = allSorts ? SORT_TYPES : [SORT_TYPES[0]]
    const words = [null, ...(keywords || KEYWORDS)]
    const out = []
    for (const keyword of words) {
      for (const sort of sorts) out.push({ keyword, sort })
    }
    return out
  }

  // ── vòng quét ──────────────────────────────────────────────────────────

  let running = false
  let stopRequested = false

  async function sweepSource(source) {
    const label = `«${source.keyword || 'Tất cả'}» sort ${source.sort}`
    const first = await withRetry(label, () => fetchList(source, 0))
    const total = first.total
    if (total === 0) return 0

    let pending = [...first.items]
    let offset = first.items.length
    let added = 0

    const flush = async (force) => {
      while (pending.length >= BATCH_SIZE || (force && pending.length > 0)) {
        const chunk = pending.splice(0, BATCH_SIZE)
        const links = await withRetry(label, () => generateLinks(chunk))
        added += await putLinks(links)
        await sleep(jitter(BATCH_GAP_MS))
      }
    }

    while (!stopRequested && offset < total) {
      const { items } = await withRetry(label, () => fetchList(source, offset))
      if (items.length === 0) break
      pending.push(...items)
      offset += items.length
      await flush(false)
      await sleep(jitter(LIST_GAP_MS))
    }
    if (!stopRequested) await flush(true)
    return added
  }

  async function sweep(opts = {}) {
    if (running) return console.warn('[ezaff] đang chạy rồi — ezHarvest.stop() nếu muốn dừng')
    running = true
    stopRequested = false

    const sources = buildSources(opts)
    const done = new Set((await getMeta('doneSources')) || [])
    const todo = sources.filter((s) => !done.has(sourceId(s)))
    const before = await countLinks()

    console.log(
      `[ezaff] ${todo.length}/${sources.length} nguồn cần quét · đang có ${before} link.` +
        (todo.length ? ' Cứ để tab chạy, ezHarvest.stop() để dừng.' : ''),
    )

    const t0 = performance.now()
    let index = 0
    try {
      for (const source of todo) {
        if (stopRequested) break
        index += 1
        const added = await sweepSource(source)
        if (stopRequested) break
        done.add(sourceId(source))
        await setMeta('doneSources', [...done])
        const totalNow = await countLinks()
        const per = (performance.now() - t0) / index
        const eta = Math.round(((todo.length - index) * per) / 60000)
        console.log(
          `[ezaff] ${index}/${todo.length} «${source.keyword || 'Tất cả'}» sort ${source.sort}` +
            ` — thêm ${added}, tổng ${totalNow} link · còn ~${eta} phút`,
        )
      }
    } catch (err) {
      if (err instanceof AntiBotError) {
        console.error(
          '[ezaff] DỪNG: Shopee bật tường chống bot và không tự gỡ sau 15 phút.\n' +
            '  1. Mở https://affiliate.shopee.vn/offer/product_offer, tự kéo mảnh ghép captcha.\n' +
            '  2. Dán lại file này vào Console.\n' +
            '  3. ezHarvest.sweep() — chạy tiếp từ đúng chỗ dở.',
        )
      } else {
        console.error('[ezaff] dừng vì lỗi:', err.message)
        console.error('[ezaff] Tiến độ đã lưu — chạy lại ezHarvest.sweep() là tiếp tục.')
      }
    } finally {
      running = false
      const now = await countLinks()
      console.log(`[ezaff] xong đợt này. ${before} → ${now} link. ezHarvest.dump() để tải về.`)
    }
  }

  // ── xuất file ──────────────────────────────────────────────────────────

  function download(blob, name) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  }

  async function dump() {
    const rows = await allLinks()
    if (rows.length === 0) return console.warn('[ezaff] chưa thu được link nào')
    download(
      new Blob([JSON.stringify(rows)], { type: 'application/json' }),
      `ezaff-owner-links-${rows.length}.json`,
    )
    console.log(`[ezaff] đã xuất ${rows.length} link.`)
    console.log('Đẩy lên KV:  npx wrangler kv bulk put <file> --binding=OWNER_KV --preview false')
    return rows.length
  }

  async function dumpCsv() {
    const rows = await allLinks()
    if (rows.length === 0) return console.warn('[ezaff] chưa thu được link nào')
    const body = ['key,url', ...rows.map((r) => `${r.key},${r.value}`)].join('\n')
    download(new Blob([body], { type: 'text/csv' }), `ezaff-owner-links-${rows.length}.csv`)
    console.log(`[ezaff] đã xuất ${rows.length} link ra CSV.`)
    return rows.length
  }

  window.ezHarvest = {
    sweep,
    dump,
    dumpCsv,
    stop: () => {
      stopRequested = true
      console.log('[ezaff] sẽ dừng sau bước hiện tại.')
    },
    state: async () => {
      const done = new Set((await getMeta('doneSources')) || [])
      const all = buildSources()
      return {
        links: await countLinks(),
        sourcesDone: done.size,
        sourcesTotal: all.length,
        running,
      }
    },
    links: allLinks,
    keywords: KEYWORDS,
    reset: async () => {
      await tx(STORE_LINKS, 'readwrite', (s) => s.clear())
      await tx(STORE_META, 'readwrite', (s) => s.clear())
      console.log('[ezaff] đã xoá tiến độ.')
    },
  }

  countLinks().then((n) =>
    console.log(
      `[ezaff] sẵn sàng — đã có ${n} link.\n` +
        '  ezHarvest.sweep()   quét toàn bộ (~4-5 tiếng, dừng/chạy lại thoải mái)\n' +
        '  ezHarvest.state() · ezHarvest.stop() · ezHarvest.dump() · ezHarvest.dumpCsv()\n' +
        '  Chạy chậm là cố ý — bắn nhanh là dính captcha, cả tab bị đá ra.',
    ),
  )
})()
