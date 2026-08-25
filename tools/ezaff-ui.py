# -*- coding: utf-8 -*-
"""
Giao diện web để quản lý các cặp kênh YouTube → Facebook Page.

    python tools/ezaff-ui.py

Rồi mở http://127.0.0.1:8799 trên trình duyệt.

Chỉ dùng thư viện có sẵn của Python, không phải cài gì. Máy chủ chỉ nghe trên
127.0.0.1 nên không ai ngoài máy này vào được — quan trọng, vì trang có hiển
thị tên Page lấy từ token Facebook của bạn.

Sửa ở đây ghi thẳng vào tools/ezaff-jobs.json. Trình chạy theo dõi file đó và
tự áp dụng trong vài giây — chỉ kênh vừa sửa được chạy lại, các kênh khác không
bị gián đoạn.
"""
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests

THUMUC = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "ez", os.path.join(THUMUC, "ezaff-port-local.py"))
ez = importlib.util.module_from_spec(spec)
sys.modules["ez"] = ez
spec.loader.exec_module(ez)

CONG = 8799
_cache_pages = {"data": None}
_khoa = threading.Lock()


def danh_sach_page():
    with _khoa:
        if _cache_pages["data"] is None:
            _cache_pages["data"] = [
                {"id": p["id"], "ten": p["name"]}
                for p in ez.get_pages(ez.USER_ACCESS_TOKEN.strip())
            ]
        return _cache_pages["data"]


def tien_do(job):
    """Đếm đã đăng / còn lại cho một job, đọc từ sổ theo dõi + cache view."""
    sf = ez.STATE_FILE_FMT.format(page_id=job["page_id"])
    try:
        with open(sf, encoding="utf-8") as f:
            so = json.load(f)
    except Exception:
        so = {"posted": [], "cho_comment": {}}
    return {"da_dang": len(so.get("posted", [])),
            "no_comment": len(so.get("cho_comment", {}))}


LOG_FILE = os.path.join(THUMUC, "ezaff-run.log")
WRAPPER = os.path.join(THUMUC, "ezaff-chay-mai.cmd")


def _pid_song(pid):
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True, timeout=15).stdout
        return str(pid) in out
    except Exception:
        return False


def trang_thai():
    """Hệ thống có đang sống không, và nó vừa làm gì."""
    pid, dang_chay = None, False
    try:
        pid = int(open(ez.LOCK_FILE).read().strip())
        dang_chay = _pid_song(pid)
    except Exception:
        pass

    dong, giay_im = [], None
    try:
        giay_im = time.time() - os.path.getmtime(LOG_FILE)
        with open(LOG_FILE, encoding="utf-8", errors="ignore") as f:
            tat = [l.rstrip() for l in f if l.strip()
                   and "RequestsDependencyWarning" not in l
                   and "warnings.warn" not in l]
        dong = tat[-12:]
    except Exception:
        pass

    # "khoẻ" = tiến trình sống VÀ log còn nhúc nhích. Tải một video lớn có thể
    # im vài phút, nên lấy mốc 10 phút mới coi là đáng ngờ.
    if not dang_chay:
        suc_khoe, mo_ta = "dung", "Không chạy"
    elif giay_im is not None and giay_im > 600:
        suc_khoe, mo_ta = "nghi", f"Đang chạy nhưng log im {int(giay_im//60)} phút"
    else:
        suc_khoe, mo_ta = "khoe", "Đang chạy bình thường"

    return {"dang_chay": dang_chay, "pid": pid, "suc_khoe": suc_khoe,
            "mo_ta": mo_ta, "giay_im": int(giay_im) if giay_im else None,
            "log": dong}


def bat_dau():
    if trang_thai()["dang_chay"]:
        return {"ok": False, "loi": "Hệ thống đang chạy rồi."}
    if not os.path.exists(WRAPPER):
        return {"ok": False, "loi": f"Không thấy {WRAPPER}"}
    try:
        # Gọi THẲNG python, không qua trình bọc .cmd: cmd.exe đệm luồng chuyển
        # hướng nên log đóng băng hàng chục phút dù tiến trình vẫn chạy, khiến
        # đèn sức khoẻ báo động giả (gặp 2026-08-14). Vòng tự-bật-lại giờ nằm
        # ở chính giao diện (xem canh_giu bên dưới).
        co = 0x00000008 | 0x08000000        # DETACHED_PROCESS | CREATE_NO_WINDOW
        moi = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
        log = open(LOG_FILE, "ab")
        subprocess.Popen([sys.executable, "-u",
                          os.path.join(THUMUC, "ezaff-port-local.py")],
                         cwd=os.path.dirname(THUMUC), env=moi,
                         stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         creationflags=co, close_fds=True)
        log.close()
        time.sleep(6)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "loi": str(e)[:300]}


def dung_lai():
    """Giết cả trình bọc lẫn tiến trình con — chỉ giết python thì trình bọc
    lại bật nó lên sau 60 giây.

    Dùng PowerShell chứ KHÔNG dùng wmic: Windows đời mới đã gỡ wmic, lệnh chạy
    im ru mà chẳng giết được gì (gặp 2026-08-14). Lọc theo tên file script nên
    không đụng vào chính giao diện (ezaff-ui).
    """
    ps = (
        "Get-CimInstance Win32_Process -Filter \"name='python.exe' or name='cmd.exe'\" |"
        " Where-Object { $_.CommandLine -match 'ezaff-chay-mai|ezaff-port-local' } |"
        " ForEach-Object { $_.ProcessId }"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=45).stdout
        pids = [d.strip() for d in out.splitlines() if d.strip().isdigit()]
        for pid in pids:
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"],
                           capture_output=True, timeout=20)
    except Exception as e:
        return {"ok": False, "loi": str(e)[:300]}
    try:
        os.remove(ez.LOCK_FILE)
    except Exception:
        pass
    if not pids:
        return {"ok": True, "giet": 0}
    time.sleep(2)
    if trang_thai()["dang_chay"]:
        return {"ok": False, "loi": "Đã gửi lệnh dừng nhưng tiến trình vẫn sống."}
    return {"ok": True, "giet": len(pids)}


def kiem_tra_kenh(url):
    """Thử liệt kê kênh để biết URL có dùng được không, và có bao nhiêu video."""
    try:
        vids = ez.lay_danh_sach_video(url)
    except Exception as e:
        return {"ok": False, "loi": str(e)[:200]}
    vc = {}
    try:
        with open(ez.VIEW_CACHE, encoding="utf-8") as f:
            vc = json.load(f)
    except Exception:
        pass
    biet = [v for v in vids if v["id"] in vc]
    return {"ok": True, "so_video": len(vids), "da_quet_view": len(biet)}


TRANG = """<!doctype html><html lang="vi"><head><meta charset="utf-8">
<title>ezaff — kênh &amp; Page</title>
<style>
 :root{--vien:#d8dbe0;--mo:#6b7280;--nen:#f7f8fa}
 *{box-sizing:border-box}
 body{font:15px/1.5 system-ui,Segoe UI,sans-serif;margin:0;background:var(--nen);color:#111}
 header{background:#fff;border-bottom:1px solid var(--vien);padding:14px 22px}
 h1{font-size:17px;margin:0}
 header p{margin:4px 0 0;color:var(--mo);font-size:13px}
 main{max-width:1100px;margin:22px auto;padding:0 16px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--vien);border-radius:8px;overflow:hidden}
 th,td{padding:9px 11px;text-align:left;border-bottom:1px solid var(--vien);vertical-align:middle}
 th{background:#f0f2f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#374151}
 tr:last-child td{border-bottom:none}
 input,select{font:inherit;padding:6px 8px;border:1px solid var(--vien);border-radius:6px;width:100%;background:#fff}
 input[type=number]{width:92px}
 button{font:inherit;padding:7px 14px;border:1px solid var(--vien);border-radius:6px;background:#fff;cursor:pointer}
 button:hover{background:#eef1f5}
 .chinh{background:#111;color:#fff;border-color:#111}
 .chinh:hover{background:#333}
 .xoa{color:#b42318;border-color:#f0c2bd}
 .xoa:hover{background:#fdf1f0}
 .thanh{display:flex;gap:9px;align-items:center;margin:16px 0}
 .mo{color:var(--mo);font-size:13px}
 .bao{padding:10px 13px;border-radius:7px;margin:13px 0;display:none;font-size:14px}
 .ok{background:#e9f7ef;border:1px solid #b7e3c8}
 .loi{background:#fdf1f0;border:1px solid #f0c2bd}
 td.hep{width:1%;white-space:nowrap}
 .bang-tt{background:#fff;border:1px solid var(--vien);border-radius:8px;padding:14px 16px;margin-bottom:18px}
 .hang-tt{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
 .den{width:11px;height:11px;border-radius:50%;flex:none}
 .khoe{background:#12a150;box-shadow:0 0 0 4px #12a15022}
 .nghi{background:#e5a50a;box-shadow:0 0 0 4px #e5a50a22}
 .dung{background:#b42318;box-shadow:0 0 0 4px #b4231822}
 .tt-chu{font-weight:600}
 .day{margin-left:auto;display:flex;gap:8px}
 pre.log{background:#12161c;color:#c9d4e2;border-radius:7px;padding:11px 13px;margin:12px 0 0;
         font:12px/1.55 Consolas,monospace;max-height:230px;overflow:auto;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<header>
  <h1>ezaff — kênh YouTube → Facebook Page</h1>
  <p>Sửa xong bấm <b>Lưu</b> là xong — trình chạy tự nhận trong vài giây. Chỉ kênh vừa sửa được khởi động lại, các kênh khác chạy tiếp không bị gián đoạn.</p>
</header>
<main>
  <div class="bang-tt">
    <div class="hang-tt">
      <span id="den" class="den dung"></span>
      <span class="tt-chu" id="tt-chu">đang kiểm tra ...</span>
      <span class="mo" id="tt-phu"></span>
      <span class="day">
        <button id="nut-bat" class="chinh" onclick="dieuKhien('batdau')">Bắt đầu</button>
        <button id="nut-lai" onclick="dieuKhien('khoidonglai')" title="Chỉ dùng khi hệ thống kẹt — cắt ngang mọi video đang upload">Khởi động lại toàn bộ</button>
        <button id="nut-dung" class="xoa" onclick="dieuKhien('dung')">Dừng</button>
      </span>
    </div>
    <pre class="log" id="log">—</pre>
  </div>
  <div id="bao" class="bao"></div>
  <table>
    <thead><tr>
      <th style="width:15%">Tên</th><th style="width:31%">Kênh YouTube</th>
      <th style="width:19%">Đăng lên Page</th><th class="hep">View tối thiểu</th>
      <th class="hep">Luồng</th><th class="hep">Bật</th>
      <th class="hep">Đã đăng</th><th class="hep"></th>
    </tr></thead>
    <tbody id="than"></tbody>
  </table>
  <div class="thanh">
    <button onclick="them()">+ Thêm kênh</button>
    <button class="chinh" onclick="luu()">Lưu</button>
    <button onclick="kiemTra()">Kiểm tra các kênh</button>
    <span class="mo" id="ghichu"></span>
  </div>
</main>
<script>
let PAGES = [], JOBS = [];

function baoTin(msg, loi) {
  const b = document.getElementById('bao');
  b.textContent = msg; b.className = 'bao ' + (loi ? 'loi' : 'ok');
  b.style.display = 'block';
  if (!loi) setTimeout(() => b.style.display = 'none', 4000);
}

function veBang() {
  document.getElementById('than').innerHTML = JOBS.map((j, i) => `
    <tr>
      <td><input value="${(j.ten||'').replace(/"/g,'&quot;')}" oninput="sua(${i},'ten',this.value)"></td>
      <td><input value="${j.kenh||''}" placeholder="https://www.youtube.com/@tenkenh"
                 oninput="sua(${i},'kenh',this.value)"></td>
      <td><select onchange="sua(${i},'page_id',this.value)">
            <option value="">— chọn Page —</option>
            ${PAGES.map(p => `<option value="${p.id}" ${p.id===j.page_id?'selected':''}>${p.ten}</option>`).join('')}
          </select></td>
      <td class="hep"><input type="number" min="0" step="1000" value="${j.view_toi_thieu||0}"
                 oninput="sua(${i},'view_toi_thieu',+this.value)"></td>
      <td class="hep"><input type="number" min="1" max="6" value="${j.song_song||2}"
                 oninput="sua(${i},'song_song',+this.value)"></td>
      <td class="hep" style="text-align:center">
          <input type="checkbox" style="width:auto" ${j.bat===false?'':'checked'}
                 onchange="sua(${i},'bat',this.checked)"></td>
      <td class="hep mo" id="td${i}">${j._da_dang ?? '–'}</td>
      <td class="hep"><button class="xoa" onclick="xoa(${i})">Xoá</button></td>
    </tr>`).join('');
}

function sua(i, k, v) { JOBS[i][k] = v; }
function them() { JOBS.push({ten:'', kenh:'', page_id:'', view_toi_thieu:10000, song_song:2, bat:true}); veBang(); }
function xoa(i) {
  if (JOBS[i].kenh && !confirm('Xoá "' + (JOBS[i].ten || JOBS[i].kenh) + '"?\\n\\nSổ theo dõi video đã đăng vẫn giữ nguyên, thêm lại là chạy tiếp.')) return;
  JOBS.splice(i, 1); veBang();
}

async function luu() {
  for (const j of JOBS) {
    if (!j.kenh || !j.page_id) { baoTin('Còn dòng chưa điền kênh hoặc chưa chọn Page.', true); return; }
  }
  const dup = JOBS.map(j => j.page_id).filter((v,i,a) => a.indexOf(v) !== i);
  if (dup.length) { baoTin('Hai kênh cùng đổ vào một Page — mỗi Page chỉ nên nhận một kênh.', true); return; }
  const r = await fetch('/api/jobs', {method:'POST', body: JSON.stringify(JOBS)});
  const d = await r.json();
  baoTin(d.ok ? 'Đã lưu ' + JOBS.length + ' kênh. Trình chạy sẽ tự áp dụng trong vài giây — không cần làm gì thêm.' : d.loi, !d.ok);
}

async function kiemTra() {
  document.getElementById('ghichu').textContent = 'đang kiểm tra ...';
  for (let i = 0; i < JOBS.length; i++) {
    if (!JOBS[i].kenh) continue;
    const r = await fetch('/api/kiemtra?url=' + encodeURIComponent(JOBS[i].kenh));
    const d = await r.json();
    document.getElementById('td' + i).textContent = d.ok
      ? `${JOBS[i]._da_dang ?? 0} / kênh có ${d.so_video}`
      : 'kênh hỏng';
    if (!d.ok) baoTin('Kênh "' + JOBS[i].kenh + '" không đọc được: ' + d.loi, true);
  }
  document.getElementById('ghichu').textContent = '';
}

async function capNhatTrangThai() {
  try {
    const t = await (await fetch('/api/trangthai')).json();
    document.getElementById('den').className = 'den ' + t.suc_khoe;
    document.getElementById('tt-chu').textContent = t.mo_ta;
    document.getElementById('tt-phu').textContent =
      (t.pid && t.dang_chay ? 'PID ' + t.pid : '') +
      (t.giay_im !== null && t.dang_chay
        ? '  ·  hoạt động gần nhất ' + (t.giay_im < 90
            ? t.giay_im + ' giây trước'
            : Math.round(t.giay_im / 60) + ' phút trước')
        : '');
    document.getElementById('log').textContent = t.log.length ? t.log.join('\\n') : '—';
    document.getElementById('nut-bat').disabled = t.dang_chay;
    document.getElementById('nut-dung').disabled = !t.dang_chay;
  } catch (e) { /* giao diện tắt rồi thì thôi */ }
}

async function dieuKhien(lenh) {
  const nut = event.target, cu = nut.textContent;
  nut.disabled = true; nut.textContent = 'đang xử lý ...';
  try {
    const d = await (await fetch('/api/' + lenh, {method:'POST'})).json();
    baoTin(d.ok ? 'Xong.' : d.loi, !d.ok);
  } catch (e) { baoTin('Lỗi: ' + e, true); }
  nut.textContent = cu;
  await capNhatTrangThai();
}

(async () => {
  const d = await (await fetch('/api/init')).json();
  PAGES = d.pages; JOBS = d.jobs;
  veBang();
  capNhatTrangThai();
  setInterval(capNhatTrangThai, 5000);
})();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _tra(self, ma, kieu, noi_dung):
        self.send_response(ma)
        self.send_header("Content-Type", kieu + "; charset=utf-8")
        self.send_header("Content-Length", str(len(noi_dung)))
        self.end_headers()
        self.wfile.write(noi_dung)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/":
            return self._tra(200, "text/html", TRANG.encode("utf-8"))
        if p.path == "/api/init":
            try:
                pages = danh_sach_page()
            except Exception as e:
                pages = []
                print("Không lấy được danh sách Page:", e)
            try:
                with open(ez.JOBS_FILE, encoding="utf-8") as f:
                    jobs = json.load(f)
            except Exception:
                jobs = list(ez.CONG_VIEC_MAC_DINH)
            for j in jobs:
                j["_da_dang"] = tien_do(j)["da_dang"]
            return self._tra(200, "application/json",
                             json.dumps({"pages": pages, "jobs": jobs},
                                        ensure_ascii=False).encode("utf-8"))
        if p.path == "/api/trangthai":
            return self._tra(200, "application/json",
                             json.dumps(trang_thai(), ensure_ascii=False).encode("utf-8"))
        if p.path == "/api/kiemtra":
            from urllib.parse import parse_qs
            url = (parse_qs(p.query).get("url") or [""])[0]
            kq = kiem_tra_kenh(url)
            return self._tra(200, "application/json",
                             json.dumps(kq, ensure_ascii=False).encode("utf-8"))
        return self._tra(404, "text/plain", b"khong co")

    def do_POST(self):
        duong = urlparse(self.path).path
        if duong in ("/api/batdau", "/api/dung", "/api/khoidonglai"):
            if duong == "/api/batdau":
                _tu_bat_lai["bat"] = True
                kq = bat_dau()
            elif duong == "/api/dung":
                _tu_bat_lai["bat"] = False    # bấm Dừng thì đừng tự bật lại
                kq = dung_lai()
            else:
                _tu_bat_lai["bat"] = True
                dung_lai()
                time.sleep(3)
                kq = bat_dau()
            return self._tra(200, "application/json",
                             json.dumps(kq, ensure_ascii=False).encode("utf-8"))
        if duong != "/api/jobs":
            return self._tra(404, "text/plain", b"khong co")
        n = int(self.headers.get("Content-Length") or 0)
        try:
            ds = json.loads(self.rfile.read(n).decode("utf-8"))
            sach = []
            for j in ds:
                sach.append({
                    "ten": (j.get("ten") or "").strip() or j.get("page_id", ""),
                    "page_id": str(j.get("page_id") or "").strip(),
                    "kenh": (j.get("kenh") or "").strip(),
                    "view_toi_thieu": max(0, int(j.get("view_toi_thieu") or 0)),
                    "song_song": min(6, max(1, int(j.get("song_song") or 2))),
                    "bat": bool(j.get("bat", True)),
                })
            ez.save_jobs(sach)
            kq = {"ok": True}
        except Exception as e:
            kq = {"ok": False, "loi": str(e)[:300]}
        return self._tra(200, "application/json",
                         json.dumps(kq, ensure_ascii=False).encode("utf-8"))

    def log_message(self, *a):
        pass                      # khỏi rác console


_tu_bat_lai = {"bat": True}


def canh_giu():
    """Tiến trình chết (mất mạng, máy ngủ dậy, lỗi lạ) thì bật lại sau 60 giây.

    Trước đây việc này do ezaff-chay-mai.cmd làm, nhưng cmd.exe đệm luồng
    chuyển hướng khiến log đóng băng. Đưa vào đây thì log ghi thẳng, mà vẫn
    giữ được tính tự phục hồi.
    """
    tung_chay = False
    while True:
        time.sleep(20)
        if not _tu_bat_lai["bat"]:
            tung_chay = False
            continue
        if trang_thai()["dang_chay"]:
            tung_chay = True
            continue
        if tung_chay:                     # từng chạy rồi mới chết -> bật lại
            print("[canh giữ] Tiến trình đã chết, bật lại ...")
            bat_dau()


def main():
    threading.Thread(target=canh_giu, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", CONG), Handler)
    dc = f"http://127.0.0.1:{CONG}"
    print(f"Giao diện ezaff đang chạy tại {dc}")
    print("Đóng cửa sổ này (hoặc Ctrl+C) để tắt.")
    try:
        webbrowser.open(dc)
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã tắt.")


if __name__ == "__main__":
    main()
