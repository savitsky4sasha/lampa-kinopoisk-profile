# -*- coding: utf-8 -*-
"""Read public Kinopoisk pages on a computer or directly on a webOS television."""
from __future__ import print_function
import argparse
from collections import OrderedDict
from contextlib import closing
import datetime as dt
import errno
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

try:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn
    from urllib.parse import parse_qs, urlsplit
    from urllib.request import HTTPCookieProcessor, Request, build_opener
    from urllib.error import HTTPError
    from http.cookiejar import CookieJar
except ImportError:  # Python 2.7 on older webOS televisions
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer
    from SocketServer import ThreadingMixIn
    from urlparse import parse_qs, urlsplit
    from urllib2 import HTTPCookieProcessor, Request, build_opener, HTTPError
    from cookielib import CookieJar


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SECTIONS = {"watchlist": "planned-to-watch", "history": "voted-watched"}
ROOT = os.path.dirname(os.path.abspath(__file__))


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
        audience = (movie.get("rating") or {}).get("kinopoisk") or {}
        years = movie.get("releaseYears") or []
        year = movie.get("productionYear") or (years[0].get("start") if years else None)
        img = (movie.get("poster") or {}).get("avatarsUrl", "")
        if img.startswith("//"):
            img = "https:" + img
        cards.append(dict(kp=movie["id"], kind="movie" if movie["__typename"] == "Film" else "tv",
                          title=title.get("russian") or title.get("original") or str(movie["id"]),
                          original=title.get("original"), year=year, vote=vote,
                          kpAudience=audience.get("value") if audience.get("isActive") else None,
                          poster=(img + "/268x402") if img else "",
                          genres=[state[g["__ref"]]["name"] for g in movie.get("genres", [])]))
    return cards, page["total"], page["limit"]


def download(alias, section, opener, previous=None):
    records = OrderedDict()
    page_number = 1
    while True:
        url = "https://www.kinopoisk.ru/user/{}/movies/{}/?page={}".format(alias, SECTIONS[section], page_number)
        for attempt in range(3):
            try:
                html = opener(url)
                cards, total, limit = parse_page(html, section, len(records))
                break
            except HTTPError as exc:
                if exc.code < 500 or attempt == 2:
                    raise
            except (IOError, OSError, ValueError, StopIteration, KeyError, subprocess.CalledProcessError):
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
            print(section, len(records))
            return list(records.values())
        if not cards:
            raise ValueError("КП вернул неполную страницу.")
        page_number += 1
        time.sleep(0.2)


def sync(args, full=True):
    try:
        with open(args.cache, "rb") as cached:
            previous = json.load(cached)
    except IOError as exc:
        if exc.errno != errno.ENOENT:
            raise
        previous = {}
    except ValueError:
        previous = {}
    if previous.get("profile") != args.profile:
        previous = {}

    session = build_opener(HTTPCookieProcessor(CookieJar()))
    with tempfile.NamedTemporaryFile() as guest_cookies:
        def read_page(url):
            if args.curl:
                # Use the television's TLS stack and an ephemeral public guest session.
                cmd = ["curl", "--fail", "--silent", "--show-error", "--location",
                       "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "8",
                       "--connect-timeout", "8", "--max-time", "25",
                       "-b", guest_cookies.name, "-c", guest_cookies.name, url]
                return subprocess.check_output(cmd).decode("utf-8")
            with closing(session.open(Request(url), timeout=20)) as reply:
                return reply.read().decode("utf-8")

        profile = {key: download(args.profile, key, read_page, None if full else previous.get(key))
                   for key in SECTIONS}
    if sys.version_info >= (3, 6) and os.path.isfile(os.path.join(ROOT, "recommendations.py")):
        import recommendations
        inputs = [[r["kp"], r.get("vote"), r.get("kpAudience"), r.get("original"), r["title"], r.get("year")]
                  for r in profile["history"]] + [r["kp"] for r in profile["watchlist"]]
        revision = str(recommendations.MODEL_VERSION) + ":" + hashlib.sha256(json.dumps(inputs).encode("utf-8")).hexdigest()
        profile["contrarian"] = previous.get("contrarian", [])
        profile["modelRevision"] = previous.get("modelRevision", "")
        if revision != profile["modelRevision"]:
            try:
                picks = recommendations.recommend(profile)
                profile["contrarian"] = recommendations.localize(picks, profile, profile["contrarian"])
                profile["modelRevision"] = revision
            except Exception as exc:
                print("MovieLens:", type(exc).__name__, str(exc), file=sys.stderr)
    if all(value == previous.get(key) for key, value in profile.items()):
        return False
    profile.update(profile=args.profile, updated=dt.datetime.utcnow().isoformat() + "Z")
    data = json.dumps(profile, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    directory = os.path.dirname(os.path.abspath(args.cache))
    if not os.path.isdir(directory):
        os.makedirs(directory)
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temp:
        try:
            temp.write(data)
            temp.close()
            os.rename(temp.name, args.cache)
        finally:
            if os.path.exists(temp.name):
                os.unlink(temp.name)
    return True


def refresh_loop(args):
    clock = getattr(time, "monotonic", time.time)
    last_full = None
    while True:
        full = last_full is None or clock() - last_full >= 6 * 3600
        try:
            changed = sync(args, full=full)
            if full:
                last_full = clock()
            print(dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
                  "Списки обновлены" if changed else "Списки проверены, изменений нет")
        except Exception as exc:
            print("Ошибка обновления:", type(exc).__name__, str(exc))
        time.sleep(args.interval * 60)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", help="Числовой ID или публичный псевдоним КП")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--tv", help="IP телевизора с доступом к личным спискам")
    parser.add_argument("--cache")
    parser.add_argument("--curl", action="store_true", help="Use system curl to fetch Kinopoisk")
    parser.add_argument("--run-as", help="Switch to this local system account before serving")
    parser.add_argument("--sync-only", action="store_true")
    parser.add_argument("--interval", type=int, default=5, metavar="MINUTES",
                        help="Минут между проверками профиля (по умолчанию 5)")
    args = parser.parse_args()
    if args.interval < 1:
        parser.error("--interval должен быть не меньше одной минуты")
    if not re.match(r"^[a-zA-Z0-9_.-]+\Z", args.profile) or args.profile in (".", ".."):
        parser.error("Некорректный ID профиля")
    args.cache = args.cache or os.path.join("cache", args.profile + ".json")
    if args.run_as:
        import pwd
        user = pwd.getpwnam(args.run_as)
        if os.getuid() == 0:
            os.setgroups([])
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)
        elif os.getuid() != user.pw_uid:
            parser.error("Cannot switch to the requested local user")
    if args.sync_only:
        sync(args)
        return
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            if self.client_address[0] not in {args.bind, args.tv, "127.0.0.1"}:
                return self.send_error(403)
            if path == "/kp.js":
                with io.open(os.path.join(ROOT, "profile.js"), encoding="utf-8") as script:
                    code = script.read()
                origin = json.dumps("http://{}:{}".format(args.bind, args.port))
                data = code.replace("var localServer = '';", "var localServer = " + origin + ";").encode("utf-8")
                mime = "application/javascript"
            elif path == "/profile.json":
                if not os.path.isfile(args.cache):
                    return self.send_error(503, "Profile has not finished loading")
                with open(args.cache, "rb") as stream:
                    stat = os.fstat(stream.fileno())
                    version = "{}-{}".format(stat.st_ino, stat.st_mtime)
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

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    worker = threading.Thread(target=refresh_loop, args=(args,))
    worker.daemon = True
    worker.start()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
