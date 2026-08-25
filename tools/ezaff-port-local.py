# -*- coding: utf-8 -*-
"""
ezaff — port video YouTube → Facebook Page kèm link aff, CHẠY TRÊN MÁY BẠN.

Bản này thay cho notebook Colab. Lý do chuyển: Colab chạy trên IP trung tâm dữ
liệu nên YouTube chặn "Sign in to confirm you're not a bot" sau ~13 video, kể cả
khi đã nạp cookies. Máy bạn dùng IP nhà dân nên gần như không dính ngưỡng đó,
lại không bị Colab thu hồi máy giữa chừng.

    python tools/ezaff-port-local.py            # chạy thật
    python tools/ezaff-port-local.py --dry-run  # chỉ in ra, không đăng gì

Chạy lại bao nhiêu lần cũng được: script hỏi Facebook xem Page đã có title nào
rồi tự bỏ qua, nên dừng giữa chừng (Ctrl+C) rồi chạy tiếp là được.

⚠ File này chứa USER_ACCESS_TOKEN của bạn — đừng đưa cho ai, đừng commit lên git.
"""

import io
import os
import re
import csv
import sys
import json
import time
import random
import shutil
import argparse

import threading
from concurrent.futures import ThreadPoolExecutor

import requests
import yt_dlp

# Windows console mặc định cp1252, in tiếng Việt sẽ nổ UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Tự ghi log ra file, KHÔNG dựa vào chuyển hướng của cmd.exe.
# 2026-08-14: khi để cmd.exe chuyển hướng, log đóng băng hàng chục phút dù
# tiến trình chạy bình thường, làm đèn sức khoẻ báo động giả. Ghi thẳng ở đây
# và flush mỗi dòng thì log luôn đúng thực tế, dù chạy kiểu nào.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "ezaff-run.log")


class _GhiKep:
    """In ra màn hình VÀ ghi vào file, flush ngay từng dòng."""

    def __init__(self, goc, duong):
        self.goc = goc
        try:
            self.f = open(duong, "a", encoding="utf-8", errors="replace")
        except Exception:
            self.f = None

    def write(self, s):
        try:
            self.goc.write(s)
            self.goc.flush()
        except Exception:
            pass
        if self.f:
            self.f.write(s)
            self.f.flush()
        return len(s)

    def flush(self):
        for x in (self.goc, self.f):
            try:
                x and x.flush()
            except Exception:
                pass


sys.stdout = _GhiKep(sys.stdout, LOG_PATH)
sys.stderr = sys.stdout

# ══════════════════════════════ CẤU HÌNH ══════════════════════════════
# Đã bê nguyên từ notebook Colab sang, không phải nhập lại gì.

USER_ACCESS_TOKEN = "EAAZA59FaXvmQBSBzCtsSfSDvtTZBzTJdv2LekwmaMsellcZAnGnrQYn2TVZBie9rqlFQJuYYigOYuHIZB87rDXgWZA4rH20XWqVc4RAt5vtSBVVjfe3n0LCDktA6PS3JW3ZAN4yaXtMkYNZBJR3ARLBHxTKfHXDxXmLdhO7k5iZCP1B6XGfQdgNwAH92w3nPgPiJs"
APP_ID = "1822940192030308"

# Danh sách job nằm ở FILE RIÊNG để giao diện web sửa được mà không đụng code:
#     tools/ezaff-jobs.json
# Bảng dưới đây chỉ là giá trị khởi tạo cho lần chạy đầu — sau đó file JSON là
# nguồn duy nhất. Mở giao diện bằng:  python tools/ezaff-ui.py
JOBS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "ezaff-jobs.json")

#   view_toi_thieu : 0 = lấy hết. Lượt xem KHÔNG có trong danh sách nhanh nên
#                    phải hỏi từng video (~1,9s), kết quả được cache lại.
#   song_song      : số video của RIÊNG job này được upload cùng lúc.
CONG_VIEC_MAC_DINH = [
    {"ten": "Kẻ trộm review", "page_id": "1162976383575019",
     "kenh": "https://www.youtube.com/@Celesreview",
     "view_toi_thieu": 10000, "song_song": 2},

    {"ten": "Mạn Kịch AI", "page_id": "1256373850891074",
     "kenh": "https://www.youtube.com/channel/UC0XyDJMC7uhOd9VTRdP6Gzw",
     "view_toi_thieu": 10000, "song_song": 3},

    {"ten": "Xưởng Phim AI", "page_id": "1161775520362027",
     "kenh": "https://www.youtube.com/@thuangaireview",
     "view_toi_thieu": 50000, "song_song": 3},
]


def load_jobs():
    """Đọc danh sách job từ JSON; lần đầu chưa có thì tạo từ bảng mặc định."""
    try:
        with open(JOBS_FILE, encoding="utf-8") as f:
            ds = json.load(f)
        return [j for j in ds if j.get("kenh") and j.get("page_id")
                and j.get("bat", True)]
    except FileNotFoundError:
        save_jobs(CONG_VIEC_MAC_DINH)
        return list(CONG_VIEC_MAC_DINH)
    except Exception as e:
        sys.exit(f"Hỏng file {JOBS_FILE}: {e}")


def save_jobs(ds):
    tmp = JOBS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ds, f, ensure_ascii=False, indent=2)
    os.replace(tmp, JOBS_FILE)

# Trần số lượt TẢI YouTube cùng lúc (dùng chung cho mọi job). Upload thì chạy
# thoải mái theo song_song, nhưng tải nhiều quá dễ bị YouTube gắn cờ bot.
TAI_CUNG_LUC = 2

# Kho link aff dùng chung — đã có sẵn trong repo, không cần upload đi đâu nữa.
AFF_POOL_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "ezaff-owner-links.csv")
AFF_POOL_COLUMN = ""          # để trống = tự dò cột có chữ link/url
AFF_MAPPING_CSV = ""          # CSV ánh xạ tay từng video (tuỳ chọn)

COMMENT_COUNT = 3
COMMENT_TEMPLATES = """\
Sản phẩm mình đang dùng, để link cho ai cần: {link}
Link mua hàng đây nha mọi người: {link}
Ưng cái nào thì lấy nha: {link}
Đang có giá tốt, mọi người tham khảo: {link}
Mình để link bên dưới nha: {link}
Ai hỏi mua ở đâu thì đây: {link}
Săn sale giúp mình với: {link}
Xem thêm tại đây: {link}
Link shop mình hay ghé: {link}
Có ưu đãi nè, ai cần thì lấy: {link}
Mình gửi link tham khảo nha: {link}
Đừng bỏ lỡ ưu đãi này: {link}
Mọi người ấn giúp mình 1 cái để mình có động lực làm thêm video nha: {link}
Xin mọi người ủng hộ mình bằng cách bấm vào đây nha 🙏: {link}
Nhờ mọi người ấn vào link ủng hộ kênh với ạ: {link}
Ủng hộ mình xíu nha, chỉ cần bấm vào link này thôi: {link}
Nếu thấy video hay thì ủng hộ mình bằng cách bấm link này nha: {link}
Mọi người bấm vào giúp mình để kênh phát triển hơn nha 🙏: {link}
Mọi người thương mình thì ghé qua link này giúp mình nha: {link}
Mình mất công tìm được deal này, ấn vào ủng hộ mình nha: {link}
Cảm ơn mọi người đã ủng hộ, đây là link nha: {link}
Cái này mình dùng thấy quá đã, để lại link cho ai cần: {link}
Mình để link ở đây, ai cần cứ lấy nha: {link}"""

# Facebook KHÔNG hiển thị trường title ở feed — tên video lẫn link aff đều phải
# nằm trong mô tả thì người xem mới thấy.
DESC_INCLUDE_TITLE = True
DESC_AFF_TEMPLATE = "👉 Link sản phẩm trong video: {link}"
DESC_AFF_POSITION = "đầu"     # đầu | cuối | không chèn

RANDOM_TITLE_LINK = True
RANDOM_SEED = "ezaff"         # giữ nguyên để chạy lại ra đúng bộ link cũ
TITLE_SEP = " | "

DELAY_SEC = 60                # nghỉ giữa 2 lượt tải
COMMENT_DELAY_SEC = 8
OLDEST_FIRST = True

# Vì sao đo được và vì sao chạy song song:
# 2026-08-11: truyền byte lên Facebook đạt 11,85 MB/s (gần hết đường truyền),
# nhưng tốc độ thực tế chỉ 0,5 MB/s — tức ~96% thời gian là NGỒI CHỜ Facebook
# xử lý phía họ, không phải truyền dữ liệu. Vậy nên chờ nhiều video cùng lúc.
# Cũng vì thế KHÔNG nên giảm chất lượng: Facebook xử lý theo thời lượng video
# chứ không theo dung lượng, nén nhỏ lại chỉ xấu đi mà không nhanh hơn.
# Số luồng của từng job khai trong tools/ezaff-jobs.json.

# Gửi kèm thumbnail của YouTube khi đăng?
# ĐO ĐƯỢC 2026-08-11: gửi kèm thumbnail LUÔN hỏng với [ma loi 6000] — 100% số
# video, cả trên Colab lẫn máy này — rồi phải upload lại từ đầu. Mất trắng ~3,5
# phút MỖI video (đo trên video 401 MB: 3m24s vứt đi + 10m15s làm lại).
# Facebook tự sinh thumbnail từ video nên tắt đi không mất gì.
GUI_THUMBNAIL = False

# Cookies YouTube — BẮT BUỘC. Đã kiểm chứng 2026-08-11: YouTube chặn tải
# "Sign in to confirm you're not a bot" kể cả từ IP nhà dân, không chỉ Colab.
# Khâu liệt kê kênh thì không cần cookies, chỉ khâu TẢI mới cần.
#
# Khi file này hết hạn (thường sau vài tuần, hoặc khi bạn đăng xuất YouTube):
# mở youtube.com đã đăng nhập → tiện ích "Get cookies.txt LOCALLY" → nút Export
# (định dạng Netscape) → thay đường dẫn bên dưới bằng file mới.
COOKIES_PATH = r"C:\Users\Tailolicon\Downloads\26cab455-db7d-4e16-be28-c1eacd7f516b.txt"

# Cách thay thế: đọc thẳng cookie từ trình duyệt. Trên Windows, Chrome đời mới
# dùng App-Bound Encryption nên cách này hay thất bại — chỉ dùng khi file trên hỏng.
COOKIES_FROM_BROWSER = ""

# Thư mục làm việc tạm. Video tải về được XOÁ NGAY sau khi đăng xong từng cái,
# nên chỗ chiếm tối đa = SONG_SONG × dung lượng video lớn nhất (~2,4 GB ở kênh này).
#
# 2026-08-11: để trên ổ E: thì suýt chết vì E: chỉ còn 6,6 GB trống (ổ đầy vì
# dữ liệu khác của máy, không phải do script). Chuyển sang D: còn 22,8 GB.
# Đổi đường dẫn này nếu ổ D: cũng hết chỗ.
TMP = r"D:\ezaff-tmp"

# Cần ít nhất chừng này chỗ trống mới dám chạy, tránh tải giữa chừng thì đầy ổ.
CHO_TRONG_TOI_THIEU_GB = 8

# Dừng sớm nếu YouTube chặn liên tiếp, khỏi chạy không công.
CHAN_TOI_DA = 5

# Sổ theo dõi video đã đăng, ghi theo video_id của YouTube.
# Vì sao không dựa vào title: kênh này có 5 nhóm video TRÙNG TITLE y hệt nhau
# (một nhóm tới 7 video). Dedup theo title sẽ bỏ sót 14 video. video_id là duy nhất.
_THUMUC = os.path.dirname(os.path.abspath(__file__))
STATE_FILE_FMT = os.path.join(_THUMUC, ".ezaff-posted-{page_id}.json")

# Cache lượt xem dùng chung cho mọi job — hỏi một lần rồi thôi.
VIEW_CACHE = os.path.join(_THUMUC, ".ezaff-views.json")

KHO_LINK = []            # kho link aff, nạp một lần trong main()
VIEW_CACHE_DATA = {}

# Khoá chống chạy hai tiến trình cùng lúc.
# 2026-08-11: từng chạy --dry-run song song với tiến trình thật, hai bên dùng
# chung file sổ trên → 2 video bị đăng comment TRÙNG (6 thay vì 3).
LOCK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ezaff.lock")

# ══════════════════════════════════════════════════════════════════════

GRAPH = "https://graph.facebook.com/v25.0"

# (thời gian chờ kết nối, thời gian chờ phản hồi). Trước đây đặt timeout=3600
# cho cả hai — một cú chớp mạng cũng treo rồi mất trắng video.
TIMEOUT_NHANH = (15, 60)
TIMEOUT_UPLOAD = (15, 3600)


def _http(method, url, tries=4, **kw):
    """Gọi Graph API có thử lại.

    CHỈ thử lại khi lỗi ở tầng KẾT NỐI — lúc đó request chưa tới server nên
    không có nguy cơ đăng trùng. Read-timeout thì KHÔNG thử lại, vì Facebook
    có thể đã nhận và xử lý rồi.
    """
    kw.setdefault("timeout", TIMEOUT_NHANH)
    last = None
    for n in range(tries):
        try:
            return requests.request(method, url, **kw)
        except (requests.exceptions.ConnectTimeout,
                requests.exceptions.ConnectionError) as e:
            last = e
            if n == tries - 1:
                break
            cho = 5 * (2 ** n)
            log(f"    mạng trục trặc ({type(e).__name__}), thử lại sau {cho}s ...")
            time.sleep(cho)
    raise last


LOI_MANG = (requests.exceptions.ConnectionError,
            requests.exceptions.Timeout,
            requests.exceptions.ChunkedEncodingError)


def cho_mang_ve(toi_da_phut=30):
    """Chờ mạng có lại. Rớt mạng vài giây từng giết sạch 8 video đang upload
    (23:45 và 14:27 ngày 2026-08-11) — mỗi cái là hàng chục phút công."""
    t0 = time.time()
    while time.time() - t0 < toi_da_phut * 60:
        try:
            requests.head("https://graph.facebook.com/", timeout=(5, 10))
            return True
        except Exception:
            time.sleep(15)
    return False


def fb_error(r):
    try:
        e = r.json().get("error", {})
        return f"[ma loi {e.get('code')}] {e.get('message')}"
    except Exception:
        return (r.text or "")[:300]


def get_pages(user_token):
    pages, url = [], f"{GRAPH}/me/accounts"
    params = {"access_token": user_token, "fields": "id,name,access_token", "limit": 100}
    while url:
        r = _http("GET", url, params=params)
        params = None
        if r.status_code != 200:
            raise RuntimeError("Không lấy được danh sách Page: " + fb_error(r))
        d = r.json()
        pages += d.get("data", [])
        url = d.get("paging", {}).get("next")
    return pages


def chon_page(user_token, page_id):
    pages = get_pages(user_token)
    if not pages:
        raise RuntimeError("Token này không quản lý Page nào — kiểm tra quyền pages_show_list.")
    for p in pages:
        if p["id"] == str(page_id).strip():
            return p
    raise RuntimeError(f"Không tìm thấy Page id {page_id} trong các Page bạn quản lý.")


def kiem_tra_quyen(user_token):
    """Facebook trả lỗi (#200) đổ cho 'pages_read_user_content' khi thiếu
    'pages_manage_engagement' — thông báo đó sai, đừng đi thêm quyền kia."""
    try:
        r = _http("GET", f"{GRAPH}/me/permissions",
                  params={"access_token": user_token})
        if r.status_code != 200:
            return
        co = {p["permission"] for p in r.json().get("data", [])
              if p.get("status") == "granted"}
    except Exception:
        return
    thieu = {"pages_manage_posts", "pages_manage_engagement"} - co
    if not thieu:
        print("Token đủ quyền: đăng video + comment đều chạy được.")
        return
    if "pages_manage_engagement" in thieu:
        print("!! Token THIẾU 'pages_manage_engagement' — video sẽ đăng được nhưng "
              "MỌI COMMENT SẼ FAIL (lỗi #200).")
    if "pages_manage_posts" in thieu:
        print("!! Token THIẾU 'pages_manage_posts' — có thể không đăng được video.")
    print(f"   Quyền token đang có: {', '.join(sorted(co)) or '(không có)'}")


def titles_da_co(page):
    ts, url = set(), f"{GRAPH}/{page['id']}/videos"
    params = {"access_token": page["access_token"], "fields": "title", "limit": 100}
    while url:
        r = _http("GET", url, params=params)
        params = None
        if r.status_code != 200:
            break
        d = r.json()
        ts |= {v.get("title", "") for v in d.get("data", [])}
        url = d.get("paging", {}).get("next")
    ts.discard("")
    return ts


def load_aff(path):
    m = {}
    if not path or not os.path.exists(path):
        return m
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            vid = (row.get("video_id") or "").strip()
            if not vid:
                continue
            m[vid] = {
                "title_link": (row.get("title_link") or "").strip(),
                "comments": [(row.get(c) or "").strip()
                             for c in ("comment_1", "comment_2", "comment_3")
                             if (row.get(c) or "").strip()],
            }
    return m


def load_pool(path, column=""):
    """Kho link dùng chung: CSV (tự dò cột link) hoặc TXT mỗi dòng 1 link."""
    path = (path or "").strip()
    if not path:
        return []
    if not os.path.exists(path):
        print(f"  ! Không thấy file kho link: {path}")
        return []
    links = []
    if path.lower().endswith(".txt"):
        with open(path, encoding="utf-8-sig", errors="ignore") as f:
            links = [l.strip() for l in f if l.strip().startswith("http")]
    else:
        with open(path, newline="", encoding="utf-8-sig", errors="ignore") as f:
            rd = csv.DictReader(f)
            cols = [c for c in (rd.fieldnames or []) if c]
            col = (column or "").strip() or next(
                (c for c in cols if re.search(r"link|url", c, re.I)), "")
            for row in rd:
                v = (row.get(col) or "").strip() if col else ""
                if not v.startswith("http"):
                    v = next((str(x).strip() for x in row.values()
                              if str(x or "").strip().startswith("http")), "")
                if v.startswith("http"):
                    links.append(v)
    seen, out = set(), []
    for l in links:
        if l not in seen:
            seen.add(l)
            out.append(l)
    return out


def boc_link(pool, video_id, n, seed=""):
    """Bốc n link khác nhau — cố định theo video_id để chạy lại ra y hệt."""
    if not pool or n <= 0:
        return []
    return random.Random(f"{seed}:{video_id}").sample(pool, min(n, len(pool)))


def load_templates(raw):
    lines = [l.strip() for l in (raw or "").split("\n")]
    lines = [l for l in lines if l]
    return lines or ["{link}"]


def title_goc(t, sep):
    """Bỏ phần ' | https://...' ở cuối để so trùng title cho đúng."""
    dau = re.escape((sep or "").strip())
    return re.sub(r"\s*" + dau + r"\s*https?://\S+\s*$", "", t or "").strip()


def build_title(orig, link, sep=" | "):
    orig = (orig or "").replace("\n", " ").strip()
    if not link:
        return orig[:255]
    tail = sep + link
    if len(tail) >= 255:
        return link[:255]
    return (orig[:255 - len(tail)]).rstrip() + tail


def build_desc(desc, link, tpl, pos, tieu_de=""):
    """Facebook KHÔNG hiển thị trường title ở feed — muốn người xem thấy tên
    video và link aff thì cả hai phải nằm trong mô tả."""
    desc = (desc or "").strip()
    aff = ""
    if link and tpl and pos != "không chèn":
        aff = tpl.replace("{link}", link) if "{link}" in tpl else f"{tpl} {link}".strip()
    khoi = []
    if tieu_de:
        khoi.append(tieu_de.replace("\n", " ").strip())
    if aff and pos == "đầu":
        khoi.append(aff)
    if desc:
        khoi.append(desc)
    if aff and pos == "cuối":
        khoi.append(aff)
    return "\n\n".join(khoi)[:60000]


def _ydl_cookies(opts):
    if COOKIES_PATH.strip():
        opts["cookiefile"] = COOKIES_PATH.strip()
    elif COOKIES_FROM_BROWSER.strip():
        opts["cookiesfrombrowser"] = (COOKIES_FROM_BROWSER.strip(),)
    return opts


def lay_danh_sach_video(channel_url):
    u = channel_url.strip().rstrip("/")
    if re.search(r"youtube\.com/(@[^/]+|channel/[^/]+|c/[^/]+|user/[^/]+)$", u):
        u += "/videos"
    opts = _ydl_cookies({"extract_flat": "in_playlist", "quiet": True,
                         "skip_download": True})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(u, download=False)
    flat = []
    for e in (info.get("entries") or []):
        if e and e.get("_type") == "playlist":
            flat += [x for x in (e.get("entries") or []) if x]
        elif e:
            flat.append(e)
    return [{"id": e["id"], "title": e.get("title") or "",
             "url": f"https://www.youtube.com/watch?v={e['id']}"}
            for e in flat if e.get("id")]


def tai_video(v, thumuc=None):
    """Tải vào thư mục riêng của từng video, để dọn file này không đụng file
    của video khác đang upload song song."""
    thumuc = thumuc or TMP
    os.makedirs(thumuc, exist_ok=True)
    opts = _ydl_cookies({
        "format": "bv*+ba/b", "merge_output_format": "mp4",
        "outtmpl": os.path.join(thumuc, "%(id)s.%(ext)s"),
        # Chỉ tải thumbnail khi thật sự dùng — xem ghi chú ở GUI_THUMBNAIL.
        "writethumbnail": GUI_THUMBNAIL,
        "postprocessors": ([{"key": "FFmpegThumbnailsConvertor", "format": "jpg"}]
                           if GUI_THUMBNAIL else []),
        "quiet": True, "no_warnings": True, "noprogress": True,
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(v["url"], download=True)
    mp4 = os.path.join(thumuc, f"{info['id']}.mp4")
    if not os.path.exists(mp4):
        for f in os.listdir(thumuc):
            if f.startswith(info["id"]) and f.rsplit(".", 1)[-1] in ("mp4", "mkv", "webm", "mov"):
                mp4 = os.path.join(thumuc, f)
                break
    if not os.path.exists(mp4):
        raise RuntimeError("yt-dlp không tải được file video.")
    thumb = os.path.join(thumuc, f"{info['id']}.jpg")
    return {"file": mp4, "thumb": thumb if os.path.exists(thumb) else None,
            "title": info.get("title") or v["title"],
            "desc": (info.get("description") or "")[:60000]}


def upload_resumable(file_path, user_token, app_id, so_lan=3):
    """KHÔNG CÒN DÙNG — giữ lại để tham khảo.
    Đo 2026-08-11: hỏng 16/16 lần với [ma loi 6000], lần nào cũng phải quay sang
    upload_chunked, tức là upload file hai lần. Đã bỏ khỏi luồng chạy chính."""
    size = os.path.getsize(file_path)
    r = _http("POST", f"{GRAPH}/{app_id}/uploads",
                      params={"file_name": os.path.basename(file_path), "file_length": size,
                              "file_type": "video/mp4", "access_token": user_token}, timeout=60)
    if r.status_code != 200:
        raise RuntimeError("Không mở được phiên upload: " + fb_error(r))
    session, offset, last_err = r.json()["id"], 0, None
    for _ in range(so_lan):
        try:
            with open(file_path, "rb") as f:
                f.seek(offset)
                r2 = requests.post(f"{GRAPH}/{session}",
                                   headers={"Authorization": f"OAuth {user_token}",
                                            "file_offset": str(offset)}, data=f, timeout=3600)
            if r2.status_code == 200 and "h" in r2.json():
                return r2.json()["h"]
            raise RuntimeError(fb_error(r2))
        except Exception as e:
            last_err = e
            g = _http("GET", f"{GRAPH}/{session}",
                      headers={"Authorization": f"OAuth {user_token}"})
            offset = int(g.json().get("file_offset", 0)) if g.status_code == 200 else 0
            print(f"    Upload gián đoạn, thử lại từ byte {offset} ...")
    raise RuntimeError(str(last_err))


def dang_len_page(page, handle, title, desc, thumb):
    data = {"access_token": page["access_token"], "title": title,
            "description": desc, "fbuploader_video_file_chunk": handle}
    if thumb and GUI_THUMBNAIL:
        try:
            with open(thumb, "rb") as tf:
                r = requests.post(f"{GRAPH}/{page['id']}/videos", data=data,
                                  files={"thumb": ("thumb.jpg", tf, "image/jpeg")},
                                  timeout=TIMEOUT_UPLOAD)
            if r.status_code == 200:
                return r.json().get("id")
            log("    Đăng kèm thumbnail lỗi (" + fb_error(r) + ") — thử lại không thumbnail ...")
        except requests.exceptions.RequestException as e:
            log(f"    Đăng kèm thumbnail lỗi mạng ({type(e).__name__}) — thử lại không thumbnail ...")
    r = _http("POST", f"{GRAPH}/{page['id']}/videos", data=data,
              timeout=TIMEOUT_UPLOAD)
    if r.status_code != 200:
        raise RuntimeError("Đăng video thất bại: " + fb_error(r))
    return r.json().get("id")


def upload_chunked(page, file_path, title, desc, thumb):
    """Đường upload DUY NHẤT hiện nay (đã bỏ resumable).

    Facebook tự quy định khoảng byte cần gửi qua start_offset/end_offset, nhưng
    với file lớn họ đòi một khối quá to rồi lại từ chối chính khối đó bằng
    [ma loi 1] "Please reduce the amount of data you're asking for".
    Nên ta tự đặt trần, và gặp lỗi đó thì giảm nửa rồi gửi lại đúng đoạn ấy.
    """
    size = os.path.getsize(file_path)
    ep, tk = f"{GRAPH}/{page['id']}/videos", page["access_token"]
    r = _http("POST", ep, data={"access_token": tk, "upload_phase": "start",
                                "file_size": size})
    if r.status_code != 200:
        raise RuntimeError("start: " + fb_error(r))
    d = r.json()
    sid, video_id = d["upload_session_id"], d.get("video_id")
    so, eo = int(d["start_offset"]), int(d["end_offset"])
    tran = 64 * 1024 * 1024              # trần mỗi lần gửi
    toi_thieu = 4 * 1024 * 1024
    with open(file_path, "rb") as f:
        hong_mang = 0
        while so != eo:
            n = min(eo - so, tran)
            f.seek(so)
            chunk = f.read(n)
            try:
                r = _http("POST", ep,
                          data={"access_token": tk, "upload_phase": "transfer",
                                "upload_session_id": sid, "start_offset": so},
                          files={"video_file_chunk": ("chunk.mp4", chunk, "video/mp4")},
                          timeout=TIMEOUT_UPLOAD, tries=1)
            except LOI_MANG as e:
                # Gửi lại ĐÚNG đoạn này là an toàn: Facebook theo dõi theo
                # start_offset, gửi trùng đoạn cũ không sinh video thừa.
                hong_mang += 1
                if hong_mang > 8:
                    raise RuntimeError(f"mạng hỏng liên tục khi gửi byte {so}: {e}")
                log(f"    Mạng đứt giữa chừng ({type(e).__name__}) — "
                    f"chờ mạng về rồi gửi lại từ byte {so:,} ...")
                cho_mang_ve()
                continue
            if r.status_code != 200:
                loi = fb_error(r)
                if "reduce the amount of data" in loi and tran > toi_thieu:
                    tran //= 2
                    log(f"    Facebook chê khối {n/1e6:.0f} MB — "
                        f"giảm còn {tran/1e6:.0f} MB rồi gửi lại ...")
                    continue             # gửi lại đúng đoạn này, khối nhỏ hơn
                raise RuntimeError("transfer: " + loi)
            d = r.json()
            so, eo = int(d["start_offset"]), int(d["end_offset"])
    fin = {"access_token": tk, "upload_phase": "finish", "upload_session_id": sid,
           "title": title, "description": desc}
    r = None
    if thumb and GUI_THUMBNAIL:
        try:
            with open(thumb, "rb") as tf:
                r = requests.post(ep, data=fin,
                                  files={"thumb": ("thumb.jpg", tf, "image/jpeg")},
                                  timeout=TIMEOUT_UPLOAD)
        except requests.exceptions.RequestException as e:
            log(f"    finish kèm thumbnail lỗi mạng ({type(e).__name__}) — thử không thumbnail ...")
    if r is None or r.status_code != 200:
        r = _http("POST", ep, data=fin, timeout=TIMEOUT_UPLOAD)
    if r.status_code != 200:
        raise RuntimeError("finish: " + fb_error(r))
    return video_id


def cho_video_ready(video_id, page_token, timeout=2700, interval=20):
    """900s là quá ngắn với kênh này — video 2 tiếng thì Facebook xử lý lâu hơn
    thế, và hết giờ là comment aff bị bỏ. Nâng lên 45 phút; quá hạn thì để lần
    chạy sau trả nốt chứ không vứt."""
    waited = 0
    while waited < timeout:
        r = _http("GET", f"{GRAPH}/{video_id}",
                  params={"access_token": page_token, "fields": "status"})
        if r.status_code == 200:
            st = (r.json().get("status") or {}).get("video_status")
            if st == "ready":
                return True
            if st == "error":
                return False
        time.sleep(interval)
        waited += interval
    return False


def post_comment(video_id, page_token, message):
    r = _http("POST", f"{GRAPH}/{video_id}/comments",
              data={"access_token": page_token, "message": message})
    if r.status_code != 200:
        raise RuntimeError(fb_error(r))
    return r.json().get("id")


def don_tmp():
    """Xoá sạch video đã tải — gọi sau MỖI video nên ổ đĩa không phình."""
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)


def log(msg="", **kw):
    """In kèm giờ để nhìn ra khâu nào đang ngốn thời gian."""
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", **kw)


def cho_trong_gb():
    try:
        return shutil.disk_usage(os.path.dirname(TMP) or TMP).free / 1e9
    except Exception:
        return 999.0


def cho_du_cho(nhan=""):
    """Chờ tới khi đủ chỗ trống. Các luồng đang upload xong sẽ tự trả lại chỗ."""
    lan = 0
    while cho_trong_gb() < CHO_TRONG_TOI_THIEU_GB:
        if lan == 0:
            log(f"  {nhan}⏸ Ổ đĩa chỉ còn {cho_trong_gb():.1f} GB — "
                f"chờ video đang upload xong để giải phóng chỗ ...")
        lan += 1
        if lan > 120:            # ~1 tiếng mà vẫn không có chỗ thì bó tay
            raise RuntimeError(f"Hết chỗ trống trên ổ chứa {TMP} "
                               f"(còn {cho_trong_gb():.1f} GB). Dọn bớt rồi chạy lại.")
        time.sleep(30)


def giu_khoa():
    """Chỉ cho một tiến trình ghi sổ tại một thời điểm.

    2026-08-14: bản cũ kiểm-tra-rồi-ghi (exists? -> đọc PID -> kiểm tra sống ->
    ghi) có khe hở đua — hai tiến trình khởi động cách nhau ~1 giây (trình bọc
    .cmd và canh_giu() của giao diện cùng bật lên) đều lọt qua kiểm tra trước
    khi bên nào kịp ghi, kết quả 2 tiến trình chạy song song thật, tải video
    gấp đôi dự tính, làm ổ đĩa cạn dù mỗi bên tự canh 8 GB.

    Sửa bằng O_CREAT|O_EXCL — tạo file chỉ thành công nếu nó CHƯA tồn tại,
    đây là một lệnh hệ điều hành duy nhất (atomic), không có khe hở giữa
    kiểm tra và ghi."""
    for lan in range(3):
        try:
            fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return
        except FileExistsError:
            try:
                pid = int(open(LOCK_FILE).read().strip())
            except Exception:
                pid = None
            con_song = False
            if pid:
                try:
                    out = os.popen(f'tasklist /FI "PID eq {pid}" /NH').read()
                    con_song = str(pid) in out
                except Exception:
                    con_song = True     # không chắc thì coi như còn sống cho an toàn
            if con_song:
                sys.exit(f"DỪNG: đã có một tiến trình ezaff đang chạy (PID {pid}).\n"
                         f"   Chạy hai cái cùng lúc sẽ đăng comment trùng và tải "
                         f"gấp đôi video, dễ làm cạn ổ đĩa.\n"
                         f"   Đóng cái kia trước, hoặc xoá {LOCK_FILE} nếu nó đã chết.")
            try:
                os.remove(LOCK_FILE)    # khoá mồ côi từ lần chạy bị kill
            except FileNotFoundError:
                pass                     # tiến trình khác vừa dọn trước rồi
            time.sleep(0.05 + 0.1 * lan)  # giãn thời điểm thử lại, giảm đụng độ
    sys.exit("DỪNG: không giữ được khoá sau nhiều lần thử — thử chạy lại.")


def nha_khoa():
    try:
        os.remove(LOCK_FILE)
    except Exception:
        pass


def load_state(state_file):
    try:
        with open(state_file, encoding="utf-8") as f:
            d = json.load(f)
        return set(d.get("posted", [])), d.get("cho_comment", {})
    except Exception:
        return set(), {}


def save_state(state_file, posted, cho_comment):
    """Ghi kiểu atomic để mất điện giữa chừng không hỏng sổ."""
    tmp = state_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"posted": sorted(posted), "cho_comment": cho_comment},
                  f, ensure_ascii=False, indent=1)
    os.replace(tmp, state_file)


def video_san_sang(video_id, page_token):
    """Hỏi 1 phát, không đứng chờ."""
    try:
        r = _http("GET", f"{GRAPH}/{video_id}",
                  params={"access_token": page_token, "fields": "status"}, tries=2)
        if r.status_code != 200:
            return None
        return (r.json().get("status") or {}).get("video_status")
    except Exception:
        return None


def tra_comment(page, cho_comment, cho_doi=False):
    """Trả nợ comment cho những video Facebook đã xử lý xong.

    Trước đây script đứng chờ Facebook transcode ngay sau khi đăng — với video
    dài 20–120 phút thì mất vài phút NGỒI KHÔNG mỗi video. Giờ đăng xong là đi
    làm video kế tiếp, comment trả sau khi tiện.
    """
    for fb_id in list(cho_comment.keys()):
        st = video_san_sang(fb_id, page["access_token"])
        if st != "ready":
            if st == "error":
                log(f"  ✘ {fb_id}: Facebook báo lỗi xử lý video, bỏ comment.")
                cho_comment.pop(fb_id, None)
                continue
            if cho_doi:
                cho_video_ready(fb_id, page["access_token"])
                if video_san_sang(fb_id, page["access_token"]) != "ready":
                    # KHÔNG xoá khỏi sổ. Video kênh này dài tới 2 tiếng, Facebook
                    # xử lý lâu hơn thời gian chờ là chuyện thường — bỏ đi là mất
                    # link aff vĩnh viễn, đúng thứ cả script sinh ra để làm.
                    log(f"  … {fb_id}: Facebook chưa xử lý xong, để lần chạy sau trả.")
                    continue
            else:
                continue          # chưa xong thì để lượt sau
        cmts = cho_comment.pop(fb_id, [])
        for k, link in enumerate(cmts):
            try:
                cid = post_comment(fb_id, page["access_token"], link)
                log(f"    ✔ comment {k+1}/{len(cmts)} cho {fb_id} (id {cid})")
            except Exception as ce:
                log(f"    ✘ comment {k+1} cho {fb_id} lỗi: {ce}")
            if k < len(cmts) - 1 and COMMENT_DELAY_SEC > 0:
                time.sleep(COMMENT_DELAY_SEC)


def load_views():
    try:
        with open(VIEW_CACHE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_views(cache):
    tmp = VIEW_CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.replace(tmp, VIEW_CACHE)


def lay_view(video_id, khoa):
    """Lượt xem KHÔNG có trong danh sách nhanh của yt-dlp, phải hỏi từng video
    (~1,9s). Cache lại để lần chạy sau khỏi hỏi.

    Khoá CHỈ bao quanh lúc đọc/ghi cache, KHÔNG bao quanh lời gọi mạng — nếu
    ôm khoá suốt 1,9s thì 3 job phải xếp hàng chờ nhau, 1752 video thành gần
    1 tiếng nghẽn.
    """
    with khoa:
        if video_id in VIEW_CACHE_DATA:
            return VIEW_CACHE_DATA[video_id]

    opts = _ydl_cookies({"quiet": True, "skip_download": True, "no_warnings": True})
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=False)
        v = int(info.get("view_count") or 0)
    except Exception:
        v = -1                      # -1 = hỏi hỏng, lần sau hỏi lại

    with khoa:
        VIEW_CACHE_DATA[video_id] = v
        if len(VIEW_CACHE_DATA) % 20 == 0:   # ghi theo mẻ, khỏi đụng đĩa liên tục
            save_views(VIEW_CACHE_DATA)
    return v


def chay_mot_job(job, khoa_chung, tai_cung_luc, dry, dung=None):
    """Một cặp kênh YouTube → Facebook Page. Mỗi job chạy trong luồng riêng."""
    ten = job["ten"]
    nguong = job.get("view_toi_thieu", 0)
    state_file = STATE_FILE_FMT.format(page_id=job["page_id"])

    def nhat_ky(msg, **kw):
        log(f"[{ten}] {msg}", **kw)

    try:
        page = chon_page(USER_ACCESS_TOKEN.strip(), job["page_id"])
    except Exception as e:
        nhat_ky(f"✘ Không mở được Page: {e}")
        return
    nhat_ky(f"Page: {page['name']} (id {page['id']})")

    da_co = titles_da_co(page)
    posted, cho_comment = load_state(state_file)
    nhat_ky(f"Page có {len(da_co)} video | sổ theo dõi {len(posted)} video")

    if cho_comment and not dry:
        nhat_ky(f"Trả {len(cho_comment)} video còn nợ comment từ lần trước ...")
        tra_comment(page, cho_comment, cho_doi=True)
        save_state(state_file, posted, cho_comment)

    vids = lay_danh_sach_video(job["kenh"])
    if OLDEST_FIRST:
        vids.reverse()
    nhat_ky(f"Kênh có {len(vids)} video" + (f", lọc >= {nguong:,} view" if nguong else ""))

    khoa_job = threading.Lock()
    cho_phep = threading.Semaphore(job.get("song_song", 2))
    dem = {"ok": 0, "bo_qua": 0, "loi": 0, "chan": 0}

    def ghi_nhan(v, t):
        with khoa_job:
            da_co.add(t)
            posted.add(v["id"])
            save_state(state_file, posted, cho_comment)

    def day_len_facebook(v, d, tlink, cmts, title, desc_post, thumuc, stt):
        try:
            mb = os.path.getsize(d["file"]) / 1e6
            nhat_ky(f"  [{stt}] {mb:.0f} MB — đang upload ...", flush=True)
            t0 = time.time()
            # Chỉ dùng chunked. Bỏ hẳn resumable: đo 2026-08-11 thấy nó hỏng
            # 16/16 lần với [ma loi 6000] rồi vẫn phải upload lại bằng chunked,
            # nên bước đó chỉ tổ tốn thời gian gấp đôi.
            fb_id = upload_chunked(page, d["file"], title, desc_post, d["thumb"])
            with khoa_job:
                if cmts and fb_id:
                    cho_comment[str(fb_id)] = cmts
                dem["ok"] += 1
            ghi_nhan(v, title)
            nhat_ky(f"  [{stt}] ✔ ĐÃ ĐĂNG (fb id: {fb_id}) sau {time.time()-t0:.0f}s"
                    + (f"  | nợ {len(cmts)} comment" if cmts else ""))
        except Exception as e:
            with khoa_job:
                dem["loi"] += 1
            nhat_ky(f"  [{stt}] ✘ Lỗi: {e}")
        finally:
            shutil.rmtree(thumuc, ignore_errors=True)
            cho_phep.release()

    tpls = load_templates(COMMENT_TEMPLATES)
    sep = TITLE_SEP
    aff = load_aff(AFF_MAPPING_CSV.strip())

    def lay_bo_link(video_id):
        a = aff.get(video_id, {})
        tlink = (a.get("title_link") or "")
        manual = [c for c in (a.get("comments") or []) if c]
        can_title = RANDOM_TITLE_LINK and not tlink
        thieu = (1 if can_title else 0) + max(0, COMMENT_COUNT - len(manual))
        picks = boc_link(KHO_LINK, video_id, thieu, RANDOM_SEED)
        if can_title and picks:
            tlink = picks.pop(0)
        rnd = random.Random(f"{RANDOM_SEED}:tpl:{video_id}")
        tu_dong = []
        for l in picks:
            tpl = rnd.choice(tpls)
            tu_dong.append(tpl.replace("{link}", l) if "{link}" in tpl
                           else f"{tpl} {l}".strip())
        return tlink, (manual + tu_dong)[:max(0, COMMENT_COUNT)]

    # Dựng sổ lần đầu từ những video đã có sẵn trên Page.
    if not posted:
        for v in vids:
            tl, _ = lay_bo_link(v["id"])
            if build_title(v["title"], tl, sep) in da_co:
                posted.add(v["id"])
        if posted:
            save_state(state_file, posted, cho_comment)
            nhat_ky(f"Dựng sổ lần đầu: {len(posted)} video đã có trên Page.")

    tho = ThreadPoolExecutor(max_workers=job.get("song_song", 2))
    try:
        for i, v in enumerate(vids):
            if dung is not None and dung.is_set():
                nhat_ky("Nhận lệnh dừng — chờ video đang upload xong rồi thoát.")
                break
            if v["id"] in posted:
                dem["bo_qua"] += 1
                continue

            if nguong > 0:
                sv = lay_view(v["id"], khoa_chung)
                if sv < 0:
                    nhat_ky(f"[{i+1}/{len(vids)}] ? không lấy được view, bỏ qua lượt này")
                    continue
                if sv < nguong:
                    dem["bo_qua"] += 1
                    continue
                ghi_view = f"  ({sv:,} view)"
            else:
                ghi_view = ""

            tlink, cmts = lay_bo_link(v["id"])
            title_dukien = build_title(v["title"], tlink, sep)

            if dry:
                nhat_ky(f"[{i+1}/{len(vids)}] {title_dukien}{ghi_view}")
                dem["ok"] += 1
                continue

            cho_phep.acquire()
            nhat_ky(f"[{i+1}/{len(vids)}] {title_dukien}{ghi_view}", flush=True)
            thumuc = os.path.join(TMP, f"{job['page_id']}_{v['id']}")
            try:
                cho_du_cho()
                with tai_cung_luc:          # hạn chế số lượt tải YouTube cùng lúc
                    nhat_ky("  - Đang tải từ YouTube ...", flush=True)
                    d = tai_video(v, thumuc)
                title = build_title(d["title"], tlink, sep)
                if title in da_co:
                    dem["bo_qua"] += 1
                    shutil.rmtree(thumuc, ignore_errors=True)
                    cho_phep.release()
                    continue
                desc_post = build_desc(d["desc"], tlink, DESC_AFF_TEMPLATE,
                                       DESC_AFF_POSITION,
                                       d["title"] if DESC_INCLUDE_TITLE else "")
                dem["chan"] = 0
                tho.submit(day_len_facebook, v, d, tlink, cmts, title, desc_post,
                           thumuc, i + 1)
            except Exception as e:
                dem["loi"] += 1
                nhat_ky(f"  ✘ Lỗi tải: {e}")
                shutil.rmtree(thumuc, ignore_errors=True)
                cho_phep.release()
                if "not a bot" in str(e) or "Sign in to confirm" in str(e):
                    dem["chan"] += 1
                    if dem["chan"] >= CHAN_TOI_DA:
                        nhat_ky(f"!! YouTube chặn {dem['chan']} video liên tiếp — dừng job này.")
                        nhat_ky("   Xuất cookies.txt mới rồi điền vào COOKIES_PATH.")
                        break
                else:
                    dem["chan"] = 0

            if cho_comment and not dry:
                tra_comment(page, cho_comment)
                with khoa_job:
                    save_state(state_file, posted, cho_comment)
            if DELAY_SEC > 0:
                time.sleep(DELAY_SEC)
    finally:
        nhat_ky("Chờ các video đang upload hoàn tất ...")
        tho.shutdown(wait=True)

    if cho_comment and not dry:
        nhat_ky(f"Trả nốt {len(cho_comment)} video còn nợ comment ...")
        tra_comment(page, cho_comment, cho_doi=True)
        save_state(state_file, posted, cho_comment)

    with khoa_chung:
        save_views(VIEW_CACHE_DATA)      # ghi nốt phần cache còn dở
    nhat_ky(f"XONG: {dem['ok']} đã đăng | {dem['bo_qua']} bỏ qua | {dem['loi']} lỗi")


def main():
    global KHO_LINK, VIEW_CACHE_DATA

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ in ra, không tải và không đăng")
    ap.add_argument("--job", default="", help="chỉ chạy job có tên chứa chuỗi này")
    args = ap.parse_args()
    dry = args.dry_run

    assert USER_ACCESS_TOKEN.strip() and APP_ID.strip()
    if not dry:
        giu_khoa()
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP, exist_ok=True)

    print("== Kiểm tra token ==")
    kiem_tra_quyen(USER_ACCESS_TOKEN.strip())

    KHO_LINK = load_pool(AFF_POOL_CSV, AFF_POOL_COLUMN)
    if AFF_POOL_CSV.strip() and not KHO_LINK:
        sys.exit("DỪNG: khai báo AFF_POOL_CSV nhưng không nạp được link nào.\n"
                 "   Không đăng gì cả — tránh đăng hàng loạt video KHÔNG có link aff.")
    print(f"Kho link chung: {len(KHO_LINK)} link")
    VIEW_CACHE_DATA = load_views()
    if VIEW_CACHE_DATA:
        print(f"Cache lượt xem: {len(VIEW_CACHE_DATA)} video đã biết")
    print(f"Thư mục tạm: {TMP} (còn trống {cho_trong_gb():.1f} GB)")

    khoa_chung = threading.Lock()          # bảo vệ cache lượt xem
    tai_cung_luc = threading.Semaphore(TAI_CUNG_LUC)

    def loc(ds):
        return {j["page_id"]: j for j in ds
                if not args.job or args.job.lower() in j["ten"].lower()}

    def van_de(a, b):
        """Job có gì đổi đủ để phải chạy lại không (đổi tên thì không tính)."""
        k = ("kenh", "view_toi_thieu", "song_song")
        return any(a.get(x) != b.get(x) for x in k)

    dang = {}                    # page_id -> {"job", "dung", "luong", "xong_luc"}
    lan_quet_lai = 6 * 3600      # job đã xong thì thỉnh thoảng quét lại kênh
    if dry:
        for j in loc(load_jobs()).values():
            chay_mot_job(j, khoa_chung, tai_cung_luc, True)
        return

    print("\n== Đang theo dõi tools/ezaff-jobs.json — Lưu là áp dụng ngay, "
          "không cần khởi động lại ==\n")
    try:
        while True:
            moi = loc(load_jobs())

            # 1) Ghi nhận job vừa kết thúc.
            for r in dang.values():
                if r["luong"] and not r["luong"].is_alive():
                    r["luong"] = None
                    r["xong_luc"] = time.time()

            # 2) Job bị gỡ / tắt / đổi cấu hình -> bảo nó dừng êm.
            #    Chỉ job ĐÓ dừng, các job khác chạy tiếp không bị đụng.
            for pid, r in list(dang.items()):
                if not r["luong"]:
                    if pid not in moi:
                        dang.pop(pid, None)      # đã gỡ và đã dừng xong
                    continue
                if pid not in moi:
                    print(f"[quản lý] '{r['job']['ten']}' bị gỡ — cho dừng êm.")
                    r["dung"].set()
                elif van_de(r["job"], moi[pid]):
                    print(f"[quản lý] '{moi[pid]['ten']}' đổi cấu hình — "
                          "dừng êm rồi chạy lại theo cấu hình mới.")
                    r["dung"].set()

            # 3) Khởi động job cần chạy.
            for pid, j in moi.items():
                r = dang.get(pid)
                if r and r["luong"]:
                    continue                     # đang chạy, để yên
                if r and not van_de(r["job"], j) and r["xong_luc"] \
                        and time.time() - r["xong_luc"] < lan_quet_lai:
                    continue                     # đã xong, chưa tới giờ quét lại
                ly_do = ("mới" if not r else
                         "đổi cấu hình" if van_de(r["job"], j) else "quét lại")
                dung = threading.Event()
                t = threading.Thread(target=chay_mot_job,
                                     args=(j, khoa_chung, tai_cung_luc, False, dung),
                                     name=j["ten"], daemon=False)
                dang[pid] = {"job": dict(j), "dung": dung, "luong": t, "xong_luc": None}
                print(f"[quản lý] Chạy '{j['ten']}' ({ly_do}) ← {j['kenh']}"
                      + (f"  (>= {j['view_toi_thieu']:,} view)"
                         if j.get("view_toi_thieu") else ""))
                t.start()

            time.sleep(5)
    except KeyboardInterrupt:
        print("\nĐang dừng — chờ các video đang upload hoàn tất ...")
        for r in dang.values():
            r["dung"].set()
        for r in dang.values():
            if r["luong"]:
                r["luong"].join()
        shutil.rmtree(TMP, ignore_errors=True)
        print("Đã dừng gọn gàng.")


if __name__ == "__main__":
    try:
        main()
    finally:
        nha_khoa()
