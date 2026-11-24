"""Personal discovery from deviations from the crowd, using GroupLens MovieLens."""
import csv
import io
import math
import re
import unicodedata
import zipfile
from collections import defaultdict
from statistics import mean
from urllib.request import urlopen

DATASET = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip"
MODEL_VERSION = 1


def normalize(title):
    title = re.sub(r"^(.+), (The|A|An)$", r"\2 \1", title, flags=re.I)
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKD", title).casefold()))


def recommend(profile, archive=None):
    if archive is None:
        with urlopen(DATASET, timeout=25) as response:
            archive = io.BytesIO(response.read())
    index = defaultdict(set)
    movies, users, samples = {}, defaultdict(dict), defaultdict(list)
    with zipfile.ZipFile(archive) as data:
        def read(name):
            with data.open("ml-latest-small/" + name + ".csv") as stream:
                yield from csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8"))

        links = {int(r["movieId"]): (int(r["tmdbId"]), "tt" + r["imdbId"])
                 for r in read("links") if r["tmdbId"] and r["imdbId"]}
        for row in read("movies"):
            match = re.fullmatch(r"(.+) \((\d{4})\)", row["title"])
            if not match:
                continue
            title, year = match.group(1), int(match.group(2))
            mid = int(row["movieId"])
            clean = re.sub(r"\s*\([^()]+\)", "", title).strip()
            movies[mid] = (re.sub(r"^(.+), (The|A|An)$", r"\2 \1", clean), year)
            for alias in [title, clean] + re.findall(r"\(([^()]+)\)", title):
                index[normalize(alias), year].add(mid)
        for row in read("ratings"):
            mid, value = int(row["movieId"]), float(row["rating"]) * 2
            users[int(row["userId"])][mid] = value
            samples[mid].append(value)

    excluded, known = set(), {}
    for film in profile["watchlist"] + profile["history"]:
        if film["kind"] != "movie" or not film.get("year"):
            continue
        names = [normalize(x) for x in (film.get("original"), film["title"]) if x]
        year = int(film["year"])
        exact = set().union(*(index[name, year] for name in names))
        nearby = set().union(*(index[name, y] for name in names for y in (year-1, year+1)))
        excluded.update(exact | nearby)
        match = exact or nearby
        if len(match) == 1 and film.get("vote") and film.get("kpAudience"):
            known[next(iter(match))] = film
    if len(known) < 8:
        return []

    crowd = {mid: mean(votes) for mid, votes in samples.items()}
    target = {mid: film["vote"] - film["kpAudience"] for mid, film in known.items()}
    target_bias = mean(target.values())
    peers = []
    for uid, votes in users.items():
        bias = mean(value - crowd[mid] for mid, value in votes.items())
        shared = sorted(votes.keys() & target.keys())
        if len(shared) < 8:
            continue
        ours = [target[mid] - target_bias for mid in shared]
        theirs = [votes[mid] - crowd[mid] - bias for mid in shared]
        scale = math.sqrt(sum(v*v for v in ours) * sum(v*v for v in theirs))
        if not scale:
            continue
        similarity = sum(a*b for a, b in zip(ours, theirs)) / scale
        if similarity <= 0:
            continue
        anchors = [(a*b, mid) for mid, a, b in zip(shared, ours, theirs)
                   if a > .5 and b > .5 and known[mid]["vote"] >= 8]
        if anchors:
            peers.append((similarity * len(shared)/(len(shared)+15), uid, bias, max(anchors)[1]))

    candidates = defaultdict(list)
    for weight, uid, bias, anchor in sorted(peers, reverse=True)[:60]:
        for mid, value in users[uid].items():
            if mid in movies and mid in links and mid not in excluded:
                candidates[mid].append((weight, value - crowd[mid] - bias, value, anchor))

    ranked = []
    for mid, votes in candidates.items():
        fans = [v for v in votes if v[1] > .5 and v[2] >= 8]
        if len(fans) < 4 or len(samples[mid]) < 12:
            continue
        mass = sum(v[0] for v in votes)
        lift = sum(w*d for w, d, _, _ in votes)/(mass+1.5)
        if lift <= 0 or crowd[mid]+lift < 6.5:
            continue
        anchors = defaultdict(float)
        for weight, delta, _, anchor in fans:
            anchors[anchor] += weight * delta
        film = known[max(anchors, key=anchors.get)]
        tmdb_id, imdb_id = links[mid]
        title, year = movies[mid]
        ranked.append((lift, mid, dict(id=tmdb_id, imdb=imdb_id, title=title, year=year,
                                      supporters=len(fans), anchor=film["title"], anchorVote=film["vote"])))
    return [record for _, _, record in sorted(ranked, key=lambda r: (-r[0], r[1]))[:70]]


def localize(records, profile, previous=()):
    """Resolve exact IMDb IDs as a batch; public KP scores are optional."""
    import json
    from concurrent.futures import ThreadPoolExecutor
    from urllib.parse import urlencode
    from urllib.request import Request
    from xml.etree import ElementTree

    def fetch(url, timeout):
        req = Request(url, headers={"User-Agent": "Lampa-KP-profile/1.0 (https://github.com/savitsky4sasha/lampa-kinopoisk-profile)"})
        with urlopen(req, timeout=timeout) as response:
            return response.read(2 * 1024 * 1024)

    if not records:
        return []
    old = {row["imdb"]: row for row in previous}
    lookup = defaultdict(list)
    ids = " ".join(json.dumps(row["imdb"]) for row in records)
    query = ('SELECT ?imdb ?label ?kp WHERE { VALUES ?imdb { '+ids+' } ?film wdt:P345 ?imdb. '
             'OPTIONAL { ?film wdt:P2603 ?kp } OPTIONAL { ?film rdfs:label ?label FILTER(LANG(?label)="ru") } }')
    payload = json.loads(fetch("https://query.wikidata.org/sparql?" + urlencode({"format":"json", "query":query}), 20))
    for hit in payload["results"]["bindings"]:
        lookup[hit["imdb"]["value"]].append(hit)
    excluded = {str(row["kp"]) for row in profile["history"] + profile["watchlist"]}
    selected = []
    for row in records:
        hits = lookup[row["imdb"]]
        matches = {hit["kp"]["value"] for hit in hits if hit.get("kp")}
        if matches & excluded:
            continue
        if len(matches) == 1:
            row["kp"] = next(iter(matches))
        labels = {hit["label"]["value"] for hit in hits if hit.get("label")}
        if len(labels) == 1:
            row["localTitle"] = next(iter(labels))
        selected.append(row)
        if len(selected) == 40:
            break

    def score(row):
        key = row.get("kp")
        if not key or not key.isdigit():
            return
        try:
            value = float(ElementTree.fromstring(fetch("https://rating.kinopoisk.ru/"+key+".xml", 6)).findtext("kp_rating"))
        except (OSError, ValueError, TypeError, ElementTree.ParseError):
            value = old.get(row["imdb"], {}).get("kpAudience") or 0
        if 0 < value <= 10:
            row["kpAudience"] = value
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(score, selected))
    return selected
