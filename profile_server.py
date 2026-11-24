"""Read public Kinopoisk list pages and serve a private snapshot to Lampa."""
import argparse
import datetime as dt
import http.cookiejar
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener

SECTIONS = {"watchlist": "planned-to-watch", "history": "voted-watched"}
ROOT = Path(__file__).resolve().parent


def parse_page(html, section, offset):
    marker = "window.Ya.__ssr_initial_data = "
    if marker not in html:
        raise ValueError("КП не вернул публичный список. Проверьте доступность профиля.")
    state = json.JSONDecoder().raw_decode(html.split(marker, 1)[1].lstrip())[0]["apolloState"]
    profile = next(v for k, v in state.items() if k.startswith("UserProfile:"))
    needed = "PLANNED_TO_WATCH" if section == "watchlist" else "WATCHED"
    page = next(v for k, v in profile["userData"].items()
                if k.startswith("movieReactions:") and needed in k and "items" in v)
    if page["offset"] != offset:
        raise ValueError("КП вернул другую страницу.")
    cards = []
    for item in page["items"]:
        movie = state[item["movie"]["__ref"]]
        title = movie["title"]
        reactions = next(v for k, v in item.items() if k.startswith("reactions"))
        vote = next((r["value"] for r in reactions if r["__typename"] == "Vote"), None)
        years = movie.get("releaseYears") or []
        year = movie.get("productionYear") or (years[0].get("start") if years else None)
        img = (movie.get("poster") or {}).get("avatarsUrl", "")
        if img.startswith("//"):
            img = "https:" + img
        cards.append(dict(kp=movie["id"], kind="movie" if movie["__typename"] == "Film" else "tv",
                          title=title.get("russian") or title.get("original") or str(movie["id"]),
                          original=title.get("original"), year=year, vote=vote,
                          poster=(img + "/268x402") if img else "",
                          genres=[state[g["__ref"]]["name"] for g in movie.get("genres", [])]))
    return cards, page["total"], page["limit"]


def download(alias, section, opener, previous=None):
    records = {}
    page_number = 1
    while True:
        url = f"https://www.kinopoisk.ru/user/{alias}/movies/{SECTIONS[section]}/?page={page_number}"
        for attempt in range(3):
            try:
                with opener.open(Request(url), timeout=20) as reply:
                    html = reply.read().decode("utf-8")
                cards, total, limit = parse_page(html, section, len(records))
                break
            except HTTPError as exc:
                if exc.code < 500 or attempt == 2:
                    raise
            except (OSError, ValueError, StopIteration, KeyError):
                if attempt == 2:
                    raise
            time.sleep(2 ** attempt)
        if page_number == 1:
            expected = total
            if (previous is not None and total == len(previous)
                    and [(c["kp"], c["vote"]) for c in cards]
                    == [(c["kp"], c["vote"]) for c in previous[:len(cards)]]):
                return previous
        if expected != total or len(cards) != min(limit, total - len(records)):
            raise ValueError("Размер списка изменился во время загрузки.")
        for card in cards:
            if card["kp"] in records:
                raise ValueError("Страница содержит повтор. Предыдущая копия сохранена.")
            records[card["kp"]] = card
        if len(records) == expected:
            print(section, len(records), flush=True)
            return list(records.values())
        if not cards:
            raise ValueError("КП вернул неполную страницу.")
        page_number += 1
        time.sleep(0.2)


def sync(args, full=True):
    try:
        previous = json.loads(args.cache.read_bytes())
    except (FileNotFoundError, ValueError):
        previous = {}
    if previous.get("profile") != args.profile:
        previous = {}
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
    profile = {key: download(args.profile, key, opener, None if full else previous.get(key))
               for key in SECTIONS}
    if all(profile[key] == previous.get(key) for key in SECTIONS):
        return False
    profile.update(profile=args.profile, updated=dt.datetime.now(dt.timezone.utc).isoformat())
    data = json.dumps(profile, ensure_ascii=False, separators=(",", ":")).encode()
    args.cache.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.cache.parent, delete=False) as temp:
        try:
            temp.write(data)
            temp.close()
            os.replace(temp.name, args.cache)
        finally:
            Path(temp.name).unlink(missing_ok=True)
    return True


def refresh_loop(args):
    last_full = None
    while True:
        full = last_full is None or time.monotonic() - last_full >= 6 * 3600
        try:
            changed = sync(args, full=full)
            if full:
                last_full = time.monotonic()
            print(dt.datetime.now().isoformat(timespec="seconds"),
                  "Списки обновлены" if changed else "Списки проверены, изменений нет", flush=True)
        except Exception as exc:
            print("Ошибка обновления:", type(exc).__name__, str(exc), flush=True)
        time.sleep(args.interval * 60)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", help="Числовой ID или публичный псевдоним КП")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--tv", help="IP телевизора с доступом к личным спискам")
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--sync-only", action="store_true")
    parser.add_argument("--interval", type=int, default=5, metavar="MINUTES",
                        help="Минут между проверками профиля (по умолчанию 5)")
    args = parser.parse_args()
    if args.interval < 1:
        parser.error("--interval должен быть не меньше одной минуты")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", args.profile) or args.profile in (".", ".."):
        parser.error("Некорректный ID профиля")
    args.cache = args.cache or Path("cache") / (args.profile + ".json")
    if args.sync_only:
        sync(args)
        return
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if self.client_address[0] not in {args.bind, args.tv, "127.0.0.1"}:
                return self.send_error(403)
            if path == "/kp.js":
                code = (ROOT / "profile.js").read_text(encoding="utf-8")
                origin = json.dumps(f"http://{args.bind}:{args.port}")
                data = code.replace("var localServer = '';", f"var localServer = {origin};").encode()
                mime = "application/javascript"
            elif path == "/profile.json":
                if not args.cache.exists():
                    return self.send_error(503, "Profile has not finished loading")
                with args.cache.open("rb") as stream:
                    version = str(os.fstat(stream.fileno()).st_mtime_ns)
                    if parse_qs(urlsplit(self.path).query).get("version") == [version]:
                        self.send_response(204)
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()
                        return
                    data = stream.read()
                mime = "application/json"
            else:
                return self.send_error(404)
            self.send_response(200)
            if path == "/profile.json":
                self.send_header("X-Profile-Version", version)
                self.send_header("Access-Control-Expose-Headers", "X-Profile-Version")
            self.send_header("Content-Type", mime + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

    with ThreadingHTTPServer((args.bind, args.port), Handler) as server:
        threading.Thread(target=refresh_loop, args=(args,), daemon=True).start()
        server.serve_forever()


if __name__ == "__main__":
    main()
