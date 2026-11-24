/* Личный профиль КП для Lampa. Настройки и снимок профиля хранятся на устройстве. */
(function () {
    'use strict';
    var app = window.Lampa;
    if (!app || !app.ContentRows || window.kpProfileInstalled) return;
    window.kpProfileInstalled = true;
    var source = 'kp_personal';
    var localServer = '';
    var script = document.currentScript;
    var origin = script && /^http:\/\/(?:192\.168\.|10\.|127\.|localhost[:/])/.test(script.src)
        ? new URL(script.src).origin : '';
    var loadedAt = 0, pending, generation = 0, snapshot, discovery, discoveryKey;
    var version = '', homeVersion = null, scoreView, lastInput = 0;
    var pollMs = 60000;
    var tmdb = app.Api.sources.tmdb;

    function endpoint() {
        return String(app.Storage.get('kp_profile_server', '') || localServer || origin).trim().replace(/\/+$/, '');
    }

    function valid(p) {
        return p && typeof p.updated === 'string' && Array.isArray(p.history) && Array.isArray(p.watchlist);
    }

    function profile() {
        var url = endpoint();
        if (!snapshot) {
            var saved = app.Storage.get('kp_profile_snapshot', {});
            if (saved.url === url && valid(saved.data)) {
                snapshot = saved.data;
                version = saved.version || '';
            }
        }
        if (!url || Date.now() - loadedAt < pollMs) return Promise.resolve(snapshot);
        if (pending) return pending;
        var current = generation;
        pending = new Promise(function (done) {
            var query = version ? '?version=' + encodeURIComponent(version) : '';
            $.ajax({url: url + '/profile.json' + query, dataType: 'json', timeout: 7000})
                .done(function (p, status, xhr) {
                    if (current !== generation || !valid(p)) return;
                    version = xhr.getResponseHeader('X-Profile-Version') || '';
                    snapshot = p;
                    try { app.Storage.set('kp_profile_snapshot', {url: url, data: p, version: version}); } catch (e) { /* memory cache */ }
                }).always(function () {
                    if (current === generation) {
                        loadedAt = Date.now();
                        pending = null;
                    }
                    done(snapshot);
                });
        });
        return pending;
    }

    function norm(s) {
        return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff]+/g, ' ').trim();
    }
    function candidates(k) {
        return [norm(k.title), norm(k.original)].filter(Boolean);
    }
    function matches(k, movie) {
        var year = String(movie.release_date || movie.first_air_date || '').slice(0, 4);
        if (!k.year || year !== String(k.year) || k.kind !== (movie.original_name || movie.name ? 'tv' : 'movie')) return false;
        var names = candidates(k);
        return [movie.title, movie.name, movie.original_title, movie.original_name].some(function (s) {
            return s && names.indexOf(norm(s)) !== -1;
        });
    }

    function get(method, query) {
        return new Promise(function (resolve, reject) { tmdb.get(method, query, resolve, reject); });
    }
    function resolveMovie(k) {
        function search(name) {
            return get('search/' + k.kind, {query: encodeURIComponent(name)}).then(function (data) {
                var exact = (data.results || []).filter(function (m) { return matches(k, m); });
                return exact.length === 1 ? exact[0] : null;
            });
        }
        return search(k.original || k.title).then(function (m) {
            return m || (!k.original || k.original === k.title ? null : search(k.title));
        });
    }
    function card(k) {
        var item = {id: k.kp, kinopoisk_id: k.kp, source: source, title: k.title,
            img: k.poster, poster: k.poster, kpEntry: k};
        var date = k.year ? k.year + '-01-01' : '';
        if (k.kind === 'tv') {
            item.name = k.title;
            item.original_name = k.original || k.title;
            item.first_air_date = date;
        } else {
            item.original_title = k.original || k.title;
            item.release_date = date;
        }
        return item;
    }

    var catalog = Object.create(tmdb);
    catalog.discovery = null;
    catalog.full = function (params, done, fail) {
        var k = params.card && params.card.kpEntry;
        if (!k && snapshot) k = snapshot.history.concat(snapshot.watchlist).find(function (x) { return String(x.kp) === String(params.id); });
        if (!k) return fail();
        resolveMovie(k).then(function (m) {
            if (!m) {
                app.Noty.show('Не найдено однозначного совпадения в TMDB: ' + k.title);
                return fail();
            }
            tmdb.full(Object.assign({}, params, {id: m.id, method: k.kind, source: 'tmdb', card: m}), function (d) {
                if (d.movie) d.movie.kinopoisk_id = k.kp;
                done(d);
            }, fail);
        }, fail);
    };

    function rankQueue(p) {
        var buckets = {}, seen = {};
        p.history.forEach(function (k) {
            seen[k.kp] = true;
            if (!k.vote) return;
            k.genres.forEach(function (g) {
                var b = buckets[g] || (buckets[g] = {sum: 0, n: 0});
                b.sum += k.vote - 6; b.n++;
            });
        });
        return p.watchlist.filter(function (k) { return !seen[k.kp]; }).map(function (k, index) {
            var score = k.genres.reduce(function (sum, g) {
                var b = buckets[g]; return sum + (b ? b.sum / (b.n + 5) : 0);
            }, 0) / Math.max(1, k.genres.length);
            return {k: k, score: score, index: index};
        }).sort(function (a, b) { return b.score - a.score || a.index - b.index; })
            .map(function (x) { return x.k; });
    }

    function discover(p) {
        var key = p.profile + '/' + p.updated;
        if (discovery && discoveryKey === key) return discovery;
        discoveryKey = key;
        var seeds = p.history.filter(function (k) { return k.vote >= 8; })
            .sort(function (a, b) { return b.vote - a.vote; }).slice(0, 4);
        var excluded = p.history.concat(p.watchlist), found = {}, success = 0;
        var job = Promise.all(seeds.map(function (k) {
            return resolveMovie(k).then(function (m) {
                if (m) return get(k.kind + '/' + m.id + '/recommendations', {}).then(function (data) {
                    success++;
                    (data.results || []).forEach(function (r, i) {
                        if (excluded.some(function (e) { return matches(e, r); })) return;
                        var id = k.kind + '/' + r.id;
                        r.source = 'tmdb';
                        var f = found[id] || (found[id] = {item: r, weight: 0});
                        f.weight += (k.vote - 5) / (1 + i / 10);
                    });
                });
            }).catch(function () { /* Another seed can still supply recommendations. */ });
        })).then(function () {
            if (!success && discovery === job) discovery = null;
            return Object.keys(found).map(function (id) { return found[id]; })
                .sort(function (a, b) { return b.weight - a.weight; }).map(function (f) { return f.item; });
        });
        discovery = job;
        return job;
    }

    var rows = [
        {id: 'watchlist', title: 'КП · Буду смотреть', items: function (p) { return p.watchlist.map(card); }},
        {id: 'pick', title: 'КП · Из моего списка по вкусу', items: function (p) { return rankQueue(p).map(card); }},
        {id: 'discover', title: 'КП · По моим высоким оценкам', items: discover},
        {id: 'history', title: 'КП · Оценки и просмотры', items: function (p) { return p.history.map(card); }}
    ];

    function content(row, page, done, onHome) {
        profile().then(function (p) {
            if (onHome) homeVersion = p ? p.updated : '';
            return p ? row.items(p) : [];
        }).then(function (all) {
            var start = (page - 1) * 20;
            done({title: row.title + ' (' + all.length + ')', source: source, url: row.id,
                page: page, total_pages: Math.ceil(all.length / 20),
                results: all.slice(start, start + 20), more: all.length > 20});
        }).catch(function () { done({results: []}); });
    }
    catalog.list = function (params, done, fail) {
        var row = rows.find(function (r) { return r.id === params.url; });
        if (!row) return fail();
        content(row, Number(params.page) || 1, done);
    };
    app.Api.sources[source] = catalog;
    rows.forEach(function (row, index) {
        app.ContentRows.add({name: 'kp_profile_' + row.id, title: row.title, screen: 'main', index: index,
            call: function () { return function (done) { content(row, 1, done, true); }; }});
    });

    app.Listener.follow('full', function (e) {
        if (e.type !== 'complite' || !e.data || !e.data.movie) return;
        var movie = e.data.movie, block = $('.full-start-new__rate-line:visible, .full-start__rate-line:visible').last();
        if (!block.length) block = $('.full-start-new__title:visible, .full-start__title:visible').last();
        var draw = function (p) {
            if (!block.length || !$.contains(document, block[0])) {
                if (scoreView === draw) scoreView = null;
                return;
            }
            if (!p || draw.revision === p.updated) return;
            draw.revision = p.updated;
            var k = p.history.find(function (x) { return String(x.kp) === String(movie.kinopoisk_id); });
            if (!k) {
                var hits = p.history.filter(function (x) { return matches(x, movie); });
                if (hits.length === 1) k = hits[0];
            }
            block.find('.kp-personal-score').remove();
            if (k) $('<span class="kp-personal-score"></span>').css({fontSize: '0.85em', marginLeft: '0.6em'})
                .text(k.vote ? 'Моя оценка КП: ' + k.vote + '/10' : 'Просмотрено на КП').appendTo(block);
        };
        scoreView = draw;
        profile().then(draw);
    });
    function refreshVisible() {
        if (document.hidden || !endpoint()) return;
        profile().then(function (p) {
            if (!p || document.hidden) return;
            if (scoreView) scoreView(p);
            if (homeVersion === null || homeVersion === p.updated || Date.now() - lastInput < 10000) return;
            var active = app.Activity.active();
            var controller = app.Controller.enabled();
            if (active && active.component === 'main' && controller && controller.name === 'content') {
                homeVersion = p.updated;
                app.Activity.replace();
            }
        });
    }
    ['keydown', 'pointerdown', 'touchstart'].forEach(function (name) {
        document.addEventListener(name, function () { lastInput = Date.now(); }, true);
    });
    window.setInterval(refreshVisible, pollMs);
    document.addEventListener('visibilitychange', refreshVisible);
    app.SettingsApi.addComponent({component: source, name: 'Мой Кинопоиск', icon: '<span>КП</span>'});
    app.SettingsApi.addParam({component: source,
        param: {name: 'kp_profile_server', type: 'input', default: localServer || origin},
        field: {name: 'Адрес сервера профиля', description: 'HTTP-адрес компьютера с profile_server.py'},
        onChange: function () {
            generation++; version = ''; homeVersion = null; loadedAt = 0; pending = null; snapshot = null; discovery = null;
            app.Noty.show('Откройте главную заново');
        }});
})();
