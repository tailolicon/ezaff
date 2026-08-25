# -*- coding: utf-8 -*-
"""
Vá comment cho những video đã đăng nhưng THIẾU comment aff.

Vì sao cần: bản cũ của tra_comment() hết thời gian chờ Facebook xử lý là XOÁ
luôn khỏi sổ nợ, nên video đó mất link aff vĩnh viễn (xảy ra 2026-08-11 với
3946570165482778 và 1354740580169318). Lỗi gốc đã sửa, file này dọn hậu quả.

Chạy được nhiều lần, chỉ đụng vào video đang thiếu comment:

    python tools/ezaff-va-comment.py            # xem sẽ vá gì, không đăng
    python tools/ezaff-va-comment.py --that     # đăng comment thật
"""
import argparse
import importlib.util
import os
import sys
import time

import requests

spec = importlib.util.spec_from_file_location(
    "ez", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "ezaff-port-local.py"))
ez = importlib.util.module_from_spec(spec)
sys.modules["ez"] = ez
spec.loader.exec_module(ez)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--that", action="store_true", help="đăng comment thật")
    args = ap.parse_args()

    ez.KHO_LINK = ez.load_pool(ez.AFF_POOL_CSV, ez.AFF_POOL_COLUMN)
    if not ez.KHO_LINK:
        sys.exit("Không nạp được kho link.")
    tpls = ez.load_templates(ez.COMMENT_TEMPLATES)
    sep = ez.TITLE_SEP

    def bo_link(video_id):
        picks = ez.boc_link(ez.KHO_LINK, video_id, 1 + ez.COMMENT_COUNT, ez.RANDOM_SEED)
        tlink = picks.pop(0) if picks else ""
        rnd = __import__("random").Random(f"{ez.RANDOM_SEED}:tpl:{video_id}")
        cmts = []
        for l in picks:
            tpl = rnd.choice(tpls)
            cmts.append(tpl.replace("{link}", l) if "{link}" in tpl
                        else f"{tpl} {l}".strip())
        return tlink, cmts

    tong_thieu = tong_va = 0
    for job in ez.load_jobs():
        page = ez.chon_page(ez.USER_ACCESS_TOKEN.strip(), job["page_id"])
        print(f"\n=== {job['ten']} ===")

        # Bản đồ title đầy đủ -> video_id của YouTube, để suy ngược ra link.
        vids = ez.lay_danh_sach_video(job["kenh"])
        theo_title = {}
        for v in vids:
            tl, _ = bo_link(v["id"])
            theo_title[ez.build_title(v["title"], tl, sep)] = v["id"]

        url = f"{ez.GRAPH}/{page['id']}/videos"
        par = {"access_token": page["access_token"],
               "fields": "id,title,comments.limit(1){id}", "limit": 50}
        while url:
            r = requests.get(url, params=par, timeout=60).json()
            par = None
            for v in r.get("data", []):
                if v.get("comments", {}).get("data"):
                    continue                      # đã có comment rồi
                tong_thieu += 1
                vid_yt = theo_title.get(v.get("title", ""))
                if not vid_yt:
                    print(f"  ? {v['id']}: không dò ra video YouTube gốc "
                          f"({(v.get('title') or '')[:50]})")
                    continue
                _, cmts = bo_link(vid_yt)
                print(f"  {v['id']} thiếu comment -> {len(cmts)} link")
                if not args.that:
                    for c in cmts:
                        print(f"      {c}")
                    continue
                if ez.video_san_sang(v["id"], page["access_token"]) != "ready":
                    print("      Facebook chưa xử lý xong, để lần sau.")
                    continue
                for k, c in enumerate(cmts):
                    try:
                        ez.post_comment(v["id"], page["access_token"], c)
                        print(f"      ✔ {k+1}/{len(cmts)}")
                        tong_va += 1
                    except Exception as e:
                        print(f"      ✘ {k+1}: {e}")
                    time.sleep(ez.COMMENT_DELAY_SEC)
            url = r.get("paging", {}).get("next")

    print(f"\n===== {tong_thieu} video thiếu comment"
          + (f", đã vá {tong_va} comment =====" if args.that
             else " (chạy lại với --that để vá) ====="))


if __name__ == "__main__":
    main()
