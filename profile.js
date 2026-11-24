/* Личный профиль КП для Lampa. Настройки и снимок профиля хранятся на устройстве. */
(function () {
    'use strict';
    var app = window.Lampa;
    if (!app || !app.ContentRows || window.kpProfileInstalled) return;
    window.kpProfileInstalled = true;
    var source = 'kp_personal';
    var kpIcon = "<svg width=\"36\" height=\"36\" viewBox=\"0 0 239 239\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\" xml:space=\"preserve\"><path fill=\"currentColor\" d=\"M215 121.415l-99.297-6.644 90.943 36.334a106.416 106.416 0 0 0 8.354-29.69z\" /><path fill=\"currentColor\" d=\"M194.608 171.609C174.933 197.942 143.441 215 107.948 215 48.33 215 0 166.871 0 107.5 0 48.13 48.33 0 107.948 0c35.559 0 67.102 17.122 86.77 43.539l-90.181 48.07L162.57 32.25h-32.169L90.892 86.862V32.25H64.77v150.5h26.123v-54.524l39.509 54.524h32.169l-56.526-57.493 88.564 46.352z\" /><path d=\"M206.646 63.895l-90.308 36.076L215 93.583a106.396 106.396 0 0 0-8.354-29.688z\" fill=\"currentColor\"/></svg>";
    var localServer = '';
    var script = document.currentScript;
    var origin = script && /^http:\/\/(?:192\.168\.|10\.|127\.|localhost[:/])/.test(script.src)
        ? new URL(script.src).origin : '';
    var cloud = !localServer && !origin;
    var cloudFeed = 'https://raw.githubusercontent.com/savitsky4sasha/lampa-kinopoisk-profile/main/feed';
    var loadedAt = 0, pending, generation = 0, snapshot, discovery, discoveryKey;
    var version = '', homeVersion = null, scoreView, lastInput = 0;
    var pollMs = 60000;
    var tmdb = app.Api.sources.tmdb;

    function endpoint() {
        if (cloud) return cloudFeed;
        if (localServer === 'http://127.0.0.1:8766') return localServer;
        return String(app.Storage.get('kp_profile_server', '') || localServer || origin || 'http://127.0.0.1:8766').trim().replace(/\/+$/, '');
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
                    if (cloud && snapshot && p.updated === snapshot.updated) return;
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

    var genreIds = {
        'драма': [18], 'комедия': [35], 'криминал': [80], 'детектив': [9648],
        'триллер': [53], 'ужасы': [27], 'фантастика': [878, 10765],
        'фэнтези': [14, 10765], 'боевик': [28, 10759], 'приключения': [12, 10759],
        'мультфильм': [16], 'аниме': [16], 'семейный': [10751], 'мелодрама': [10749],
        'документальный': [99], 'вестерн': [37], 'военный': [10752, 10768],
        'история': [36], 'музыка': [10402]
    };
    function taste(p) {
        var rated = p.history.filter(function (x) { return x.vote > 0; });
        var mean = rated.reduce(function (sum, x) { return sum + x.vote; }, 0) / (rated.length || 1);
        var sums = {}, counts = {};
        rated.forEach(function (x) {
            var ids = {};
            x.genres.forEach(function (g) { (genreIds[g] || []).forEach(function (id) { ids[id] = true; }); });
            Object.keys(ids).forEach(function (id) {
                sums[id] = (sums[id] || 0) + x.vote - mean;
                counts[id] = (counts[id] || 0) + 1;
            });
        });
        return function (ids) {
            return ids.reduce(function (a, id) { return a + (sums[id] || 0) / ((counts[id] || 0) + 6); }, 0) / (ids.length || 1);
        };
    }

    function pickSeeds(rated, limit) {
        var used = {}, pool = rated.slice(), selected = [];
        while (selected.length < limit && pool.length) {
            var best = 0, high = -Infinity;
            pool.forEach(function (k, i) {
                var penalty = k.genres.reduce(function (s, g) { return s + (used[g] || 0); }, 0) / (k.genres.length || 1);
                var score = k.vote - 0.85 * penalty - 0.3 * (used[k.kind] || 0);
                if (score > high) { high = score; best = i; }
            });
            var k = pool.splice(best, 1)[0];
            k.genres.concat(k.kind).forEach(function (key) { used[key] = (used[key] || 0) + 1; });
            selected.push(k);
        }
        return selected;
    }

    function discover(p) {
        var filter = enabled('kp_personal_language_filter');
        var key = p.profile + '/' + p.updated + '/' + filter;
        if (discovery && discoveryKey === key) return discovery;
        discoveryKey = key;
        var loved = p.history.filter(function (k) { return k.vote >= 8; });
        if (!loved.length) loved = p.history.filter(function (k) { return k.vote === 7; });
        var seeds = pickSeeds(loved, 8);
        var disliked = p.history.filter(function (k) { return k.vote && k.vote <= 4; })
            .sort(function (a, b) { return a.vote - b.vote; }).slice(0, 2);
        var blocked = {}, found = {}, opposed = {}, affinity = taste(p), success = 0;
        p.history.concat(p.watchlist).forEach(function (k) {
            candidates(k).forEach(function (name) { if (name) blocked[k.kind + '/' + k.year + '/' + name] = true; });
        });

        function neighbors(k, negative) {
            return resolveMovie(k).then(function (m) {
                if (!m) return;
                var route = k.kind + '/' + m.id;
                return get(route + '/recommendations', {}).then(function (data) {
                    return (data.results || []).length ? data : get(route + '/similar', {});
                }).then(function (data) {
                    if (!negative) success++;
                    (data.results || []).forEach(function (r, i) {
                        if (!r.id || (filter && ['ru', 'ko', 'zh', 'cn'].indexOf(r.original_language) >= 0)) return;
                        var id = k.kind + '/' + r.id;
                        if (negative) { opposed[id] = (opposed[id] || 0) + (6 - k.vote) / (1 + i / 10); return; }
                        var year = String(r.release_date || r.first_air_date || '').slice(0, 4);
                        if ([r.title, r.name, r.original_name, r.original_title].some(function (name) {
                            return name && blocked[k.kind + '/' + year + '/' + norm(name)];
                        })) return;
                        var f = found[id] || (found[id] = {item: r, weight: 0, best: 0});
                        var weight = (k.vote - 5) / (1 + i / 10);
                        f.weight += weight;
                        if (weight > f.best) { f.best = weight; f.reason = k; }
                    });
                });
            }).catch(function () {});
        }
        // Limit simultaneous TMDB lookups on older televisions.
        var work = seeds.map(function (k) { return {k: k, negative: false}; })
            .concat(disliked.map(function (k) { return {k: k, negative: true}; }));
        function worker() {
            var task = work.shift();
            return task ? neighbors(task.k, task.negative).then(worker) : Promise.resolve();
        }
        var job = Promise.all([worker(), worker(), worker()]).then(function () {
            if (!success && discovery === job) discovery = null;
            return Object.keys(found).map(function (id) {
                var rec = found[id];
                rec.weight += 2 * affinity(rec.item.genre_ids || []) - (opposed[id] || 0);
                return rec;
            }).sort(function (a, b) { return b.weight - a.weight || a.item.id - b.item.id; })
                .map(function (f) {
                    return Object.assign({}, f.item, {source: 'tmdb',
                        kpReason: 'Похож на «' + f.reason.title + '» — твоя оценка ' + f.reason.vote + '/10'});
                });
        });
        discovery = job;
        return job;
    }

    function rewatch(p) {
        // Rotate a stable ordering every Monday (UTC). Pagination keeps the same order.
        var week = Math.floor((Date.now() - 345600000) / 604800000);
        var favorites = p.history.filter(function (k) { return k.vote >= 9; });
        function key(k) {
            var n = (Number(k.kp) ^ week) >>> 0;
            n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
            n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
            return (n ^ (n >>> 16)) >>> 0;
        }
        return favorites.sort(function (a, b) { return key(a) - key(b) || a.kp - b.kp; }).map(card);
    }

    function againstConsensus(p) {
        var excluded = {};
        p.history.concat(p.watchlist).forEach(function (k) { excluded[k.kp] = true; });
        return (p.contrarian || []).filter(function (r) { return !r.kp || !excluded[r.kp]; }).map(function (r) {
            var poster = r.kp ? 'https://st.kp.yandex.net/images/film_iphone/iphone360_' + r.kp + '.jpg'
                : 'https://images.metahub.space/poster/medium/' + r.imdb + '/img';
            return {id: r.id, imdb_id: r.imdb, kinopoisk_id: r.kp, kp_rating: r.kpAudience,
                source: 'tmdb', title: r.localTitle || r.title, original_title: r.title,
                release_date: r.year + '-01-01', img: poster, poster: poster,
                kpReason: 'Зрители со схожим вкусом оценили этот фильм выше среднего. Одно из совпадений — «' +
                    r.anchor + '», твоя оценка ' + r.anchorVote + '/10.'};
        });
    }
    var rows = [
        {id: 'watchlist', title: 'КП · Буду смотреть', items: function (p) { return p.watchlist.map(card); }},
        {id: 'pick', title: 'КП · Из моего списка по вкусу', items: function (p) { return rankQueue(p).map(card); }},
        {id: 'discover', title: 'КП · По моим высоким оценкам', items: discover},
        {id: 'contrarian', title: 'КП · Вопреки рейтингу', items: againstConsensus},
        {id: 'rewatch', title: 'КП · Пересмотреть любимое', items: rewatch},
        {id: 'history', title: 'КП · Оценки и просмотры', items: function (p) { return p.history.map(card); }}
    ];

    function content(row, page, done, onHome) {
        profile().then(function (p) {
            if (onHome) homeVersion = p ? p.updated : '';
            return p ? row.items(p) : [];
        }).then(function (all) {
            var start = (page - 1) * 20;
            done({title: row.title, source: source, url: row.id,
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
    var homeCallbacks = [];
    var homeOrder = ['watchlist', 'discover', 'pick', 'contrarian', 'rewatch'];
    homeOrder.forEach(function (id, index) {
        var row = rows.find(function (entry) { return entry.id === id; });
        function load(done) { content(row, 1, done, true); }
        homeCallbacks.push(load);
        app.ContentRows.add({name: 'kp_profile_' + row.id, title: row.title, screen: 'main', index: index,
            call: function () { return load; }});
    });
    var collectRows = app.ContentRows.call;
    function unseenInLampa(media, p) {
        return app.Recomends.get(media).filter(function (movie) {
            var entry = movieEntry(movie, p);
            if (p && entry && p.history.indexOf(entry) >= 0) return false;
            if (currentVote(movie.kinopoisk_id || (entry && entry.kp), entry)) return false;
            return !(app.Favorite && app.Favorite.check(movie).viewed);
        });
    }
    function nativeRecommendationTitle() {
        return app.Lang ? app.Lang.translate('title_recomend_watch') : 'Рекомендуем посмотреть';
    }
    function filterRecommendationRow(callback, media) {
        return function (done) {
            var args = Array.prototype.slice.call(arguments);
            if (typeof done !== 'function') return callback.apply(this, args);
            args[0] = function (row) {
                if (!row || !row.results || row.title !== nativeRecommendationTitle()) return done.apply(this, arguments);
                profile().then(function (p) {
                    var all = unseenInLampa(media, p);
                    var available = {};
                    all.forEach(function (movie) { available[movie.id] = true; });
                    var results = row.results.concat(all).filter(function (movie) {
                        if (!available[movie.id]) return false;
                        delete available[movie.id];
                        return true;
                    });
                    done(Object.assign({}, row, {results: results.slice(0, 20), total_pages: Math.ceil(all.length / 20)}));
                });
            };
            return callback.apply(this, args);
        };
    }
    if (app.Recomends && app.Recomends.page && app.Recomends.get) {
        app.Recomends.page = function (params, done, empty) {
            profile().then(function (p) {
                var all = unseenInLampa(params.media || 'movie', p);
                var page = Number(params.page) || 1;
                var results = all.slice((page - 1) * 20, page * 20);
                if (!results.length) return empty({status: 404});
                done({title: nativeRecommendationTitle(), total_pages: Math.ceil(all.length / 20), page: page, results: results});
            });
        };
    }
    if (collectRows) app.ContentRows.call = function (screen, params, calls) {
        var existing = calls.slice();
        var result = collectRows.apply(this, arguments);
        if (app.Recomends && app.Recomends.get && (screen === 'main' || screen === 'category')) {
            calls.forEach(function (callback, i) {
                if (typeof callback === 'function' && existing.indexOf(callback) < 0 && homeCallbacks.indexOf(callback) < 0)
                    calls[i] = filterRecommendationRow(callback, screen === 'main' ? 'movie' : params.url);
            });
        }
        if (screen === 'main') {
            // Move only enabled profile rows. Keep the relative order of all other rows.
            homeCallbacks.slice().reverse().forEach(function (callback) {
                var index = calls.indexOf(callback);
                if (index >= 0) calls.unshift(calls.splice(index, 1)[0]);
            });
        }
        return result;
    };

    catalog.main = function (params, done, empty) {
        var parts = rows.map(function (row) {
            return function (next) { content(row, 1, next, true); };
        });
        function load(next, end) { app.Api.partNext(parts, rows.length, next, end); }
        load(done, empty);
        return load;
    };

    function addProfileMenu() {
        if ($('.kp-personal-menu').length) return;
        var component = 'main';
        if (app.Component && app.Component.get('main')) {
            component = 'kp_personal_tab';
            app.Component.add(component, app.Component.get('main'));
        }
        function openTab() {
            app.Activity.push({title: 'Кинопоиск', component: component, source: source, page: 1});
        }
        if (app.Menu && app.Menu.addButton) {
            app.Menu.addButton(kpIcon, 'Кинопоиск', openTab).addClass('kp-personal-menu');
        } else {
            var button = $('<li class="menu__item selector kp-personal-menu"><div class="menu__ico"></div><div class="menu__text">Кинопоиск</div></li>');
            button.find('.menu__ico').html(kpIcon);
            button.on('hover:enter', openTab).appendTo($('.menu .menu__list').first());
        }
    }
    function hideOldMenu() {
        $('.menu .menu__item:not(.kp-personal-menu)').each(function () {
            var item = $(this);
            if (item.find('.menu__text').text().trim() === 'Кинопоиск' &&
                item.find('svg[viewBox="0 0 239 239"]').length) item.hide();
        });
    }
    function installProfileMenu() {
        addProfileMenu();
        if (window.setTimeout) window.setTimeout(hideOldMenu, 0);
    }
    if (window.appready) installProfileMenu();
    else app.Listener.follow('app', function (e) { if (e.type === 'ready') installProfileMenu(); });

    function movieEntry(movie, p) {
        if (!p) return null;
        var items = p.history.concat(p.watchlist);
        if (movie.kinopoisk_id) return items.find(function (k) { return String(k.kp) === String(movie.kinopoisk_id); });
        var hits = items.filter(function (k) { return matches(k, movie); });
        if (hits.length && hits.every(function (k) { return k.kp === hits[0].kp; })) return hits[0];
        return null;
    }

    function goToKP(url) {
        var tab = window.open(url, '_blank');
        if (tab) { try { tab.opener = null; } catch (ignore) {} }
        else window.location.assign(url);
    }

    function menu(title, items, action) {
        var controller = app.Controller.enabled();
        var previous = controller && controller.name || 'full_start';
        app.Select.show({title: title, items: items, onBack: function () { app.Controller.toggle(previous); },
            onSelect: function (choice) { app.Controller.toggle(previous); action(choice); }});
    }

    var accessGateway = 'https://script.google.com/macros/s/AKfycbyW-G0Kicxj6N_cqb-yCzYNXFL4uxKSRi7B51qrNYsVa1wmuVr4adZ8tOHpGvNXtoWS/exec';
    var loginModule = 'https://cdn.jsdelivr.net/gh/and7ey/lampa@68fd637b0a75e69fc64e32f81419fe96856a1e97/kinopoisk.js';
    var authLoaded = false, authLoading = false, writing = {}, confirmed = {};

    function accountSettings() {
        function openSettings() { app.Settings.create('kinopoisk'); }
        if (authLoaded || $('div[data-name="kinopoisk_auth"]').length ||
            (window.lampa_settings && window.lampa_settings.kinopoisk && $('.menu__item').filter(function () {
                return !$(this).hasClass('kp-personal-menu') && $(this).find('.menu__text').text() === 'Кинопоиск';
            }).length)) return openSettings();
        if (authLoading) return;
        authLoading = true;
        app.Utils.putScriptAsync([loginModule], function () { authLoading = false; }, function () {
            app.Noty.show('Модуль входа недоступен. Попробуйте ещё раз.');
        }, function () {
            authLoaded = true;
            openSettings();
            hideOldMenu();
        });
    }

    function withAccess(action) {
        var run = function () {
            var token = app.Storage.get('kinopoisk_access_token', '');
            var expiry = Number(app.Storage.get('kinopoisk_token_expires', 0));
            if (!token || (expiry && expiry <= Date.now())) { accountSettings(); return; }
            action(token);
        };
        if (enabled('kp_personal_auth_allowed')) { run(); return; }
        var who = app.Storage.get('kinopoisk_email', '');
        menu('Подключить действия Кинопоиска' + (who ? ' · ' + who : ''), [
            {title: 'Разрешить', subtitle: 'Для действий в КП токен Яндекса будет передан Google Apps Script автора and7ey.', allow: true},
            {title: 'Отмена'}
        ], function (item) {
            if (item.allow) { app.Storage.set('kp_personal_auth_allowed', true); run(); }
        });
    }

    function kpCall(method, id, token, rating) {
        var data = {method: method, movie: id};
        if (token) data.oauth = token;
        if (rating) data.rate = rating;
        return new Promise(function (ok, fail) {
            $.ajax({url: accessGateway, data: data, dataType: 'json', timeout: 20000,
                referrerPolicy: 'no-referrer'}).done(function (reply) {
                    var result = reply && reply.data && reply.data.movie;
                    if (result) ok(result); else fail(new Error('КП отклонил запрос. Проверьте вход в аккаунт.'));
                }).fail(function () { fail(new Error('Не получен ответ КП. Проверьте результат перед повтором.')); });
        });
    }

    function mirrorVote(movie, value) {
        var method = movie.name || movie.original_name ? 'tv' : 'movie';
        var key = method + '_' + movie.id;
        var type = value <= 4 ? 'shit' : value <= 7 ? 'nice' : 'fire';
        var mine = app.Storage.get('mine_reactions', {});
        if ((mine[key] || []).indexOf(type) !== -1) return Promise.resolve();
        return new Promise(function (ok, fail) {
            app.Api.sources.cub.reactionsAdd({method: method, id: movie.id, type: type}, function () {
                var current = app.Storage.get('mine_reactions', {});
                var added = current[key] || (current[key] = []);
                if (added.indexOf(type) < 0) added.push(type);
                app.Storage.set('mine_reactions', current);
                ok();
            }, fail);
        });
    }

    function vote(movie, id, value, token) {
        if (writing[id]) return;
        writing[id] = true;
        var method = value ? 'set' : 'remove';
        kpCall(value ? 'setVote' : 'removeVote', id, token, value).then(function (result) {
            if (!result.vote || !result.vote[method] || result.vote[method].status !== 'SUCCESS')
                throw new Error('КП не подтвердил изменение оценки.');
            confirmed[id] = {value: value, time: Date.now()};
            scheduleHome();
            if (scoreView) { scoreView.revision = null; scoreView(snapshot); }
            app.Noty.show(value ? 'Оценка на КП: ' + value + '/10' : 'Оценка удалена на КП');
            var extra = [];
            if (value && enabled('kp_personal_remove_later')) {
                extra.push(kpCall('setWatchLater', id, token).then(function (r) {
                    if (!r.plannedToWatch || !r.plannedToWatch.remove || r.plannedToWatch.remove.status !== 'SUCCESS')
                        throw new Error();
                }).catch(function () { app.Noty.show('Не удалось подтвердить удаление из «Буду смотреть»'); }));
            }
            if (value && enabled('kp_personal_mirror_vote'))
                extra.push(mirrorVote(movie, value).catch(function () { app.Noty.show('Не удалось добавить реакцию Lampa'); }));
            return Promise.all(extra);
        }).catch(function (err) { app.Noty.show(err.message); }).then(function () { delete writing[id]; });
    }

    function currentVote(id, entry) {
        var change = confirmed[id];
        var value = entry && entry.vote || 0;
        if (change && (change.value === value || Date.now() - change.time > 3600000)) delete confirmed[id];
        return confirmed[id] ? confirmed[id].value : value;
    }

    function chooseVote(movie, id, entry, token) {
        var score = currentVote(id, entry);
        var choices = [];
        for (var i = 10; i >= 1; i--) choices.push({title: String(i), value: i, selected: i === score});
        choices.push({title: 'Удалить оценку', value: 0});
        menu('Моя оценка на КП', choices, function (item) { vote(movie, id, item.value, token); });
    }

    var trailersCache = {};
    function trailers(id) {
        var cached = trailersCache[id];
        if (cached && Date.now() - cached.time < 180000) return cached.promise;
        var promise = kpCall('getTrailers', id).then(function (result) {
            var items = result.trailers && result.trailers.items || [];
            return items.map(function (item) {
                var url = String(item.streamUrl || '').replace(/^\/\//, 'https://');
                return {title: item.title || 'Трейлер', url: url, hls_type: 'native'};
            }).filter(function (clip) { return /^https?:\/\//i.test(clip.url); });
        }).catch(function (err) { delete trailersCache[id]; throw err; });
        trailersCache[id] = {time: Date.now(), promise: promise};
        return promise;
    }

    function extras(id, type, token) {
        if (type === 'trailers') {
            trailers(id).then(function (clips) {
                if (!clips.length) return app.Noty.show('На КП пока нет доступных трейлеров');
                menu('Трейлеры Кинопоиска', clips, function (clip) {
                    app.Player.play(clip);
                    if (app.Player.playlist) app.Player.playlist(clips);
                });
            }).catch(function () { app.Noty.show('Не удалось загрузить трейлеры КП'); });
            return;
        }
        kpCall('getTrivias', id, token).then(function (result) {
            var items = result.trivias && result.trivias.items || [];
            var body = $('<div class="about"></div>');
            items.forEach(function (f) {
                if (f.text) $('<p></p>').text(String(f.text).replace(/<[^>]*>/g, '')).appendTo(body);
            });
            if (!body.children().length) return app.Noty.show('На КП пока нет фактов');
            var ctrl = app.Controller.enabled();
            app.Modal.open({title: 'Факты Кинопоиска', html: body, size: 'large',
                onBack: function () { app.Modal.close(); app.Controller.toggle(ctrl && ctrl.name || 'full_start'); }});
        }).catch(function (err) { app.Noty.show(err.message); });
    }

    function showMovieActions(movie, entry, id, base) {
        menu('Кинопоиск', [
            {title: 'Оценить на КП', key: 'vote'},
            {title: 'Факты', key: 'trivias'},
            {title: 'Трейлеры', key: 'trailers'},
            {title: 'Открыть на сайте КП', key: 'site'}
        ], function (item) {
            if (item.key === 'site') { goToKP(base); return; }
            if (item.key === 'trailers') return extras(id, 'trailers');
            withAccess(function (token) {
                if (item.key === 'vote') chooseVote(movie, id, entry, token);
                else extras(id, item.key, token);
            });
        });
    }

    var resolvedIds = {};
    function identifyMovie(movie, onId, silent) {
        var tv = Boolean(movie.name || movie.original_name);
        var key = (tv ? 'tv/' : 'movie/') + movie.id;
        if (resolvedIds[key]) return onId(resolvedIds[key]);
        function remember(id) { resolvedIds[key] = id; onId(id); }
        function choose() {
            if (silent) return onId(null);
            menu('Совпадение с КП не найдено', [
                {title: 'Найти фильм на сайте КП', search: true},
                {title: 'Указать ссылку или ID фильма'}
            ], function (item) {
                if (item.search) {
                    goToKP('https://www.kinopoisk.ru/index.php?kp_query=' + encodeURIComponent(movie.title || movie.name || ''));
                } else {
                    app.Input.edit({title: 'Ссылка или числовой ID КП', value: '', free: true, nosave: true}, function (val) {
                        var match = /^\s*(?:https?:\/\/(?:www\.)?kinopoisk\.ru\/(?:film|series)\/)?(\d+)\/?\s*$/i.exec(val || '');
                        if (match) remember(match[1]); else if (val) app.Noty.show('Нужен ID или ссылка на фильм в КП');
                    });
                }
            });
        }
        if (!/^\d+$/.test(String(movie.id))) return choose();
        var query = 'SELECT DISTINCT ?kp WHERE { ?work wdt:' + (tv ? 'P4983' : 'P4947') +
            ' "' + movie.id + '"; wdt:P2603 ?kp. } LIMIT 2';
        if (!silent) app.Noty.show('Ищу фильм по ID TMDB…');
        $.ajax({url: 'https://query.wikidata.org/sparql', data: {query: query, format: 'json'},
            dataType: 'json', timeout: 6500}).done(function (r) {
                var ids = r && r.results && r.results.bindings || [];
                if (ids.length === 1 && /^\d+$/.test(ids[0].kp.value)) remember(ids[0].kp.value);
                else choose();
            }).fail(choose);
    }

    function actionsButton(e) {
        var movie = e.data.movie;
        var holder = e.object && e.object.activity && e.object.activity.render();
        if (!holder) return;
        var buttons = holder.find('.full-start-new__buttons, .full-start__buttons').first();
        if (!buttons.length || buttons.find('.kp-personal-actions').length) return;
        var button = $('<div class="full-start__button selector kp-personal-actions">' + kpIcon + '<span>Кинопоиск</span></div>');
        function withId(action) {
            var entry = movieEntry(movie, snapshot);
            var id = movie.kinopoisk_id || (entry && entry.kp);
            function openActions(kpId) {
                if (!$.contains(document, buttons[0])) return;
                movie.kinopoisk_id = kpId;
                var base = 'https://www.kinopoisk.ru/' + (movie.name || movie.original_name ? 'series/' : 'film/') + kpId + '/';
                action(kpId, entry, base);
            }
            if (id && /^\d+$/.test(String(id))) openActions(id);
            else identifyMovie(movie, openActions);
        }
        button.on('hover:enter', function () {
            withId(function (id, entry, base) { showMovieActions(movie, entry, id, base); });
        }).appendTo(buttons);
        var sources = holder.find('.buttons--container').first();
        if (!sources.length) return;
        var trailer = $('<div class="full-start__button selector kp-trailer-source"><svg><use xlink:href="#sprite-trailer"></use></svg><span>Трейлеры КП</span></div>');
        trailer.on('hover:enter', function () {
            app.Controller.toggle('content');
            withId(function (id) { extras(id, 'trailers'); });
        });
        var youtube = sources.find('.view--trailer').first();
        if (youtube.length) trailer.insertAfter(youtube);
        else trailer.appendTo(sources);
    }

    function watchedPoster(poster, seen) {
        var overlay = poster.querySelector('.kp-watched-overlay');
        poster.classList.toggle('kp-profile-seen', seen);
        if (seen && !overlay) {
            overlay = document.createElement('span');
            overlay.className = 'kp-watched-overlay';
            overlay.setAttribute('role', 'img');
            overlay.setAttribute('aria-label', 'Просмотрено');
            poster.appendChild(overlay);
        } else if (!seen && overlay) overlay.remove();
    }

    var descriptions = {
        watchlist: 'Всё, что ты отложил на Кинопоиске, в порядке твоего списка.',
        pick: 'Непросмотренное из «Буду смотреть». Выше — жанры, которым ты чаще ставишь хорошие оценки.',
        discover: 'Фильмы и сериалы, похожие на твои любимые. Уже просмотренное и отложенное пропускаем.',
        contrarian: 'Фильмы, которые особенно понравились зрителям с похожими на твои расхождениями со средним рейтингом.',
        rewatch: 'Уже просмотренные фильмы и сериалы, которым ты поставил 9 или 10. Порядок меняется по понедельникам.',
        history: 'Всё, что ты оценил или отметил просмотренным на Кинопоиске.'
    };
    var homePage = null, homeObserver, homeProfile, homeMatches = {}, homeTimer;
    var posterObserver, posterQueue = [], posterRunning = 0, posterRatings = {};
    function imdbId(movie) {
        var existing = movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id);
        if (/^tt\d+$/.test(existing || '')) return Promise.resolve(existing);
        if (!tmdb.external_imdb_id && !tmdb.get) return Promise.resolve('');
        var resolved = movie.source === source && movie.kpEntry ? resolveMovie(movie.kpEntry) : Promise.resolve(movie);
        return resolved.then(function (m) {
            if (!m || !Number(m.id)) return '';
            return new Promise(function (done) {
                var type = m.name || m.original_name ? 'tv' : 'movie';
                if (tmdb.external_imdb_id) tmdb.external_imdb_id({type: type, id: m.id}, done);
                else tmdb.get(type + '/' + m.id + '/external_ids', {}, function (data) {
                    done(data && data.imdb_id || '');
                }, function () { done(''); });
            });
        });
    }
    function imdbScore(id, kind) {
        if (!/^tt\d+$/.test(id || '')) return Promise.resolve(0);
        return new Promise(function (done) {
            $.ajax({url: 'https://v3-cinemeta.strem.io/meta/' + kind + '/' + id + '.json', dataType: 'json', timeout: 6500})
                .done(function (r) { done(r.meta && r.meta.id === id ? Number(r.meta.imdbRating) || 0 : 0); })
                .fail(function () { done(0); });
        });
    }
    var criticCache = {};
    function criticScore(id) {
        if (criticCache[id] && criticCache[id].expires > Date.now()) return criticCache[id].result;
        var query = 'SELECT ?score ?date WHERE { ?film wdt:P345 "' + id + '"; p:P444 ?s. ' +
            '?s ps:P444 ?score; pq:P447 wd:Q105584; pq:P459 wd:Q108403393. ' +
            'OPTIONAL { ?s pq:P585 ?date } } ORDER BY DESC(?date) LIMIT 1';
        var item = criticCache[id] = {expires: Date.now() + 600000};
        item.result = new Promise(function (done) {
            $.ajax({url: 'https://query.wikidata.org/sparql', data: {format: 'json', query: query}, dataType: 'json', timeout: 8000})
                .done(function (data) {
                    var row = data && data.results && data.results.bindings && data.results.bindings[0];
                    var value = row && row.score && row.score.value.trim();
                    if (!/^(?:100|[0-9]{1,2})[%]$/.test(value)) return done(null);
                    item.expires = Date.now() + 86400000;
                    done({value: value, date: row.date && row.date.value.slice(0, 10)});
                }).fail(function () { done(null); });
        });
        return item.result;
    }
    function posterKey(m) {
        return [m.source || 'tmdb', m.original_name || m.name ? 'series' : 'movie', m.id].join('/');
    }
    function loadPosterScores() {
        while (posterRunning < 3 && posterQueue.length) {
            var node = posterQueue.shift();
            if (!homePage || !homePage.root.contains(node) || !node.classList.contains('kp-no-score')) continue;
            var movie = node.card_data, key = posterKey(movie);
            if (posterRatings[key] && posterRatings[key].until > Date.now()) continue;
            posterRunning++;
            posterRatings[key] = {value: 0, until: Infinity};
            (function (m, cacheKey) {
                imdbId(m).then(function (id) { return imdbScore(id, m.original_name || m.name ? 'series' : 'movie'); })
                    .catch(function () { return 0; }).then(function (v) {
                        posterRatings[cacheKey] = {value: v, until: Date.now() + (v ? 86400000 : 600000)};
                        posterRunning--;
                        scheduleHome();
                        loadPosterScores();
                    });
            })(movie, key);
        }
    }
    function queuePoster(node) {
        if (posterQueue.indexOf(node) < 0) posterQueue.push(node);
        loadPosterScores();
    }
    function drawHomeCard(node) {
        var movie = node.card_data;
        var poster = node.querySelector('.card__view');
        if (!movie || !poster || !(movie.title || movie.name)) return;
        node.classList.add('kp-home-film');
        if (homeProfile !== snapshot) { homeMatches = {}; homeProfile = snapshot; }
        var key = JSON.stringify([movie.source, movie.kinopoisk_id, movie.id, movie.title || movie.name,
            movie.original_title || movie.original_name, movie.first_air_date || movie.release_date]);
        if (!Object.prototype.hasOwnProperty.call(homeMatches, key)) homeMatches[key] = movieEntry(movie, snapshot);
        var entry = homeMatches[key] || movie.kpEntry;
        var personal = currentVote(movie.kinopoisk_id || (entry && entry.kp), entry);
        var audience = Number(entry && entry.kpAudience) || Number(movie.kp_rating) || Number(movie.ratingKinopoisk);
        var cached = posterRatings[posterKey(movie)];
        var kpId = movie.kinopoisk_id || (entry && entry.kp);
        var imported = snapshot && snapshot.imdbByKp && snapshot.imdbByKp[kpId];
        var imdb = Number(movie.imdb_rating) || Number(movie.ratingImdb) || Number(imported) || (cached && cached.value);
        var score = personal || audience || imdb;
        var badge = poster.querySelector('.card__vote');
        var hasScore = score > 0 && score <= 10;
        node.classList.toggle('kp-no-score', !hasScore);
        if (hasScore) {
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'card__vote';
                poster.appendChild(badge);
            }
            badge.classList.remove('hide');
            badge.classList.add('kp-home-score');
            var label = (personal || score === 10) ? String(score) : score.toFixed(1);
            if (badge.textContent !== label) badge.textContent = label;
            badge.title = personal ? 'Моя оценка на Кинопоиске' : audience ? 'Рейтинг зрителей Кинопоиска' : 'Рейтинг IMDb';
            badge.classList.toggle('kp-mine', !!personal);
        } else if ((!cached || cached.until <= Date.now()) && (tmdb.external_imdb_id || tmdb.get || movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id))) {
            if (posterObserver) posterObserver.observe(node);
            else queuePoster(node);
        }
        watchedPoster(poster, !!personal || !!(snapshot && entry && snapshot.history.indexOf(entry) >= 0));
    }
    function drawHome() {
        if (!homePage) return;
        var root = homePage.root;
        Array.prototype.forEach.call(root.querySelectorAll('.card'), drawHomeCard);
        if (homePage.row) {
            var first = root.querySelector('.card');
            if (first && !root.querySelector('.kp-grid-description')) {
                var desc = document.createElement('div');
                desc.className = 'kp-row-description kp-grid-description';
                desc.textContent = descriptions[homePage.row.id];
                first.parentNode.parentNode.insertBefore(desc, first.parentNode);
            }
        } else if (homePage.tab) {
            Array.prototype.forEach.call(root.querySelectorAll('.items-line__title'), function (heading) {
                var row = rows.find(function (r) { return r.title === heading.textContent.trim(); });
                var head = heading.parentNode;
                if (!row || head.parentNode.querySelector('.kp-row-description')) return;
                var desc = document.createElement('div');
                desc.className = 'kp-row-description';
                desc.textContent = descriptions[row.id];
                head.parentNode.insertBefore(desc, head.nextSibling);
            });
        }
    }
    function scheduleHome() {
        if (!homePage || homeTimer) return;
        homeTimer = window.setTimeout(function () { homeTimer = null; drawHome(); }, 25);
    }
    function homeActivity(e) {
        if (!window.MutationObserver || !e.object || !e.object.activity) return;
        if (e.type !== 'start' && e.type !== 'archive' && e.type !== 'destroy') return;
        var root = e.object.activity.render()[0];
        if (!root || !root.querySelector) return;
        if (homePage && (e.type === 'start' || root === homePage.root)) {
            homeObserver.disconnect();
            if (posterObserver) posterObserver.disconnect();
            posterQueue.length = 0;
            homePage = null;
        }
        if (e.type !== 'start') return;
        var row = e.component === 'category_full' && e.object.source === source &&
            rows.find(function (r) { return r.id === e.object.url || r.title === e.object.title; });
        if (e.component !== 'main' && e.component !== 'kp_personal_tab' && e.component !== 'recomend' &&
            e.component !== 'category' && e.component !== 'category_full') return;
        homePage = {root: root, row: row, tab: e.component === 'kp_personal_tab' || e.object.source === source};
        root.classList.add('kp-home-cards');
        if (window.IntersectionObserver) posterObserver = new window.IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting || entry.intersectionRatio > 0) {
                    posterObserver.unobserve(entry.target);
                    queuePoster(entry.target);
                }
            });
        });
        homeObserver = new window.MutationObserver(function (changes) {
            if (changes.some(function (change) {
                return Array.prototype.some.call(change.addedNodes, function (el) {
                    return el.nodeType === 1 && (el.matches('.card,.items-line') || el.querySelector('.card,.items-line'));
                });
            })) scheduleHome();
        });
        homeObserver.observe(root, {childList: true, subtree: true});
        drawHome();
        profile().then(scheduleHome);
    }

    var activePreview = null;
    function stopPreview() {
        if (!activePreview) return;
        var preview = activePreview;
        activePreview = null;
        window.clearTimeout(preview.timer);
        if (preview.hls) preview.hls.destroy();
        if (preview.video) {
            preview.video.onplaying = preview.video.onerror = preview.video.onended = null;
            preview.video.pause();
            preview.video.removeAttribute('src');
            preview.video.load();
            if (preview.layer.parentNode) preview.layer.parentNode.classList.remove('kp-trailer-playing');
            preview.layer.remove();
        }
    }
    function arrangeFilmMetadata(hero, movie) {
        var head = hero.querySelector('.full-start-new__head');
        var details = hero.querySelector('.full-start-new__details');
        if (!head) return;
        var anchor = hero.querySelector('.full-start-new__tagline') || hero.querySelector('.full-start-new__title');
        if (!details) return;

        var year = head.querySelector('span:first-child');
        var date = String(movie.release_date || movie.first_air_date || '');
        if (year && /^\d{4}$/.test(year.textContent.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(date) && !movie.kpEntry) {
            var release = new Date(date + 'T12:00:00Z');
            if (!isNaN(release.getTime())) year.textContent = release.toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).replace(/\s*г\.$/, '');
        }
        var country = year && year.nextSibling;
        if (country && country.nodeType === 3)
            country.nodeValue = country.nodeValue.replace(/^, /, ' • ').replace(/ [|] /g, ', ');

        var parts = Array.prototype.slice.call(details.children).filter(function (item) {
            return !item.classList.contains('full-start-new__split');
        });
        var duration = Number(movie.runtime) > 0 && parts.find(function (item) {
            return /^\d{1,3}:\d{2}$/.test(item.textContent.trim());
        });
        var genres = (movie.genres || []).slice(0, 5).map(function (g) { return g.name; }).filter(Boolean);
        var genreList = genres.length && parts.find(function (item) {
            return item.textContent.trim().toLowerCase() === genres.join(' | ').toLowerCase();
        });
        function move(item, text) {
            if (!item) return;
            var next = item.nextElementSibling, prev = item.previousElementSibling;
            if (next && next.classList.contains('full-start-new__split')) next.remove();
            else if (prev && prev.classList.contains('full-start-new__split')) prev.remove();
            if (head.textContent.trim()) head.appendChild(document.createTextNode(' • '));
            if (text) item.textContent = text;
            head.appendChild(item);
            head.classList.remove('hide');
        }
        if (genreList) move(genreList, genreList.textContent.split(' | ').slice(0, 2).join(', '));
        move(duration);
        var specs = hero.querySelector('.kp-film-specs');
        if (!specs) {
            specs = document.createElement('div');
            specs.className = 'kp-film-specs';
        }
        if (anchor && anchor.parentNode === head.parentNode && anchor.nextElementSibling !== specs)
            head.parentNode.insertBefore(specs, anchor.nextSibling);
        if (specs.parentNode !== head.parentNode) head.parentNode.insertBefore(specs, head);
        if (specs.nextElementSibling !== head) head.parentNode.insertBefore(head, specs.nextSibling);
        var tags = hero.querySelectorAll('.full-start-new__rate-line > .full-start__pg, .full-start-new__rate-line > .full-start__status');
        Array.prototype.forEach.call(tags, function (tag) {
            if (!tag.classList.contains('hide') && tag.textContent.trim()) {
                if (tag.classList.contains('full-start__status') && tag.textContent.trim() === 'Выпущенный') tag.textContent = 'Выпущен';
                specs.appendChild(tag);
            }
        });
        return specs;
    }
    function kinoPubResolution(item) {
        var best = 0;
        function inspect(video) {
            (video.files || []).forEach(function (file) {
                if (!file || !file.url || !Object.keys(file.url).length) return;
                var quality = String(file.quality || file.q || '').toLowerCase();
                var height = /^(?:4k|uhd)$/.test(quality) ? 2160 : parseInt(quality, 10);
                if ([2160, 1440, 1080, 720, 576, 480, 360, 240].indexOf(height) !== -1)
                    best = Math.max(best, height);
            });
        }
        (item.videos || []).forEach(inspect);
        (item.seasons || []).forEach(function (season) { (season.episodes || []).forEach(inspect); });
        return best === 2160 ? '4K' : best ? best + 'p' : '';
    }
    function loadKinoPubQuality(movie, imdb, current, specs) {
        if (!specs || !window.online_kp_plugin || !current()) return;
        var token = app.Storage.get('kp_token', '');
        var title = movie.title || movie.name || movie.original_title || movie.original_name;
        if (!token || !title) return;
        function get(path) {
            return $.ajax({url: 'https://api.service-kp.com/v1/items/' + path, dataType: 'json',
                headers: {Authorization: 'Bearer ' + token}, timeout: 6500});
        }
        var serial = !!(movie.name || movie.first_air_date || movie.number_of_seasons);
        var year = String(movie.release_date || movie.first_air_date || '').slice(0, 4);
        var names = [title, movie.original_name, movie.original_title].filter(Boolean).map(function (n) {
            return n.trim().toLowerCase();
        });
        get('search?field=title&perpage=50&type=' + (serial ? 'serial' : 'movie') + '&q=' + encodeURIComponent(title)).done(function (result) {
            if (!current()) return;
            var items = result.items || [];
            var id = Number(String(imdb || '').replace(/^tt/, ''));
            var kp = Number(movie.kinopoisk_id || (movie.kpEntry && movie.kpEntry.kp));
            var match = items.find(function (item) {
                return (id && Number(item.imdb) === id) || (kp && Number(item.kinopoisk) === kp);
            });
            if (!match) {
                var exact = items.filter(function (item) {
                    if ((id && Number(item.imdb) && id !== Number(item.imdb)) ||
                        (kp && Number(item.kinopoisk) && kp !== Number(item.kinopoisk))) return false;
                    return year && String(item.year) === year && String(item.title || '').split(' / ').some(function (n) {
                        return names.indexOf(n.trim().toLowerCase()) !== -1;
                    });
                });
                if (exact.length === 1) match = exact[0];
            }
            if (!match || !Number(match.id)) return;
            get(String(Number(match.id))).done(function (result) {
                if (!current() || !result.item) return;
                var label = kinoPubResolution(result.item);
                if (!label) return;
                var quality = document.createElement('span');
                quality.className = 'kp-film-quality';
                quality.textContent = label;
                quality.title = 'Максимальное доступное качество на Кинопабе';
                specs.insertBefore(quality, specs.firstChild);
            });
        });
    }
    function watchRatings(line) {
        if (!line || line.kpRatingObserver) return;
        function update() {
            var fields = line.querySelectorAll('.rate--kp:not(.hide), .rate--imdb:not(.hide)');
            var publicKp = null;
            var preferred = false;
            Array.prototype.forEach.call(fields, function (field) {
                var value = Number((field.firstElementChild || field).textContent.trim().replace(',', '.'));
                if (!(value > 0 && value <= 10)) return;
                preferred = true;
                if (field.classList.contains('rate--kp')) publicKp = field;
            });
            var personal = line.querySelector('.kp-personal-score[data-voted]');
            if (personal && personal.parentNode !== (publicKp || line)) {
                if (publicKp) publicKp.appendChild(personal);
                else line.insertBefore(personal, line.firstChild);
            }
            if (line.classList.contains('kp-preferred-ratings') !== preferred)
                line.classList.toggle('kp-preferred-ratings', preferred);
        }
        update();
        if (window.MutationObserver) {
            line.kpRatingObserver = new MutationObserver(update);
            line.kpRatingObserver.observe(line, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class']});
        }
    }
    function cardPresentation(movie, root) {
        stopPreview();
        var hero = root.querySelector('.full-start-new, .full-start');
        if (!hero) return;
        var description = root.querySelector('.full-descr');
        var descriptionRow = description && description.closest('.items-line');
        if (descriptionRow) descriptionRow.classList.add('kp-description-row');
        var specs = arrangeFilmMetadata(hero, movie);
        var previousQuality = specs && specs.querySelector('.kp-film-quality');
        if (previousQuality) previousQuality.remove();
        watchRatings(hero.querySelector('.full-start-new__rate-line, .full-start__rate-line'));
        var playIcon = hero.querySelector('.button--play > svg');
        var poster = hero.querySelector('.full-start-new__poster, .full-start__poster');
        if (poster && playIcon) {
            var icon = window.getComputedStyle(playIcon);
            var em = parseFloat(window.getComputedStyle(poster).fontSize);
            if (em > 0 && parseFloat(icon.width) > 0 && parseFloat(icon.height) > 0) {
                poster.style.setProperty('--kp-check-width', parseFloat(icon.width) / em + 'em');
                poster.style.setProperty('--kp-check-height', parseFloat(icon.height) / em + 'em');
            }
        }
        var preview = activePreview = {root: root};
        function current() { return activePreview === preview && document.documentElement.contains(root); }
        function showRating(type, value) {
            var number = parseFloat(value);
            var field = root.querySelector('.rate--' + type);
            if (!field || !field.firstElementChild || !(number > 0 && number <= 10)) return;
            field.firstElementChild.textContent = number.toFixed(1);
            if (type === 'kp' && field.children[1]) field.children[1].textContent = 'КП';
            field.classList.remove('hide');
        }
        var kind = movie.name || movie.original_name ? 'tv' : 'movie';
        if (Number(movie.imdb_rating) > 0) showRating('imdb', movie.imdb_rating);
        var oldCritics = root.querySelector('.rate--critics');
        if (oldCritics) oldCritics.remove();
        imdbId(movie).then(function (id) {
            loadKinoPubQuality(movie, id, current, specs);
            if (!/^tt[0-9]+$/.test(id) || !current()) return;
            if (!Number(movie.imdb_rating)) imdbScore(id, kind === 'tv' ? 'series' : 'movie').then(function (score) {
                if (current()) showRating('imdb', score);
            });
            criticScore(id).then(function (score) {
                var tmdbField = root.querySelector('.rate--tmdb');
                if (!current() || !score || !tmdbField || tmdbField.children.length < 2) return;
                var field = tmdbField.cloneNode(true);
                field.classList.remove('rate--tmdb', 'hide');
                field.classList.add('rate--critics');
                field.children[0].textContent = score.value;
                field.children[1].classList.remove('source--name');
                field.children[1].textContent = 'Критики';
                field.title = 'Rotten Tomatoes · доля положительных рецензий' + (score.date ? ' · ' + score.date : '');
                tmdbField.parentNode.insertBefore(field, tmdbField.nextSibling);
            });
        }).catch(function () {});

        function playBackground(url) {
            if (!current() || document.hidden || (app.Player.opened && app.Player.opened())) return;
            if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) return;
            var layer = preview.layer = document.createElement('div');
            layer.className = 'kp-preview-layer';
            var video = preview.video = document.createElement('video');
            video.muted = video.defaultMuted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            layer.setAttribute('aria-hidden', 'true');
            var frame = document.createElement('div');
            frame.className = 'kp-preview-frame';
            frame.appendChild(video);
            layer.appendChild(frame);
            hero.insertBefore(layer, hero.firstChild);
            function stop() { if (activePreview === preview) stopPreview(); }
            video.onended = video.onerror = stop;
            video.onplaying = function () {
                if (!current()) return stop();
                window.clearTimeout(preview.timer);
                layer.classList.add('is-playing');
                hero.classList.add('kp-trailer-playing');
            };
            function play() {
                var started = video.play();
                if (started && started.catch) started.catch(stop);
            }
            preview.timer = window.setTimeout(stop, 16000);
            if (/\.m3u8(?:\?|$)/i.test(url) && !video.canPlayType('application/vnd.apple.mpegurl')) {
                if (!window.Hls || !window.Hls.isSupported()) return stop();
                var hls = preview.hls = new window.Hls();
                hls.on(window.Hls.Events.MANIFEST_PARSED, play);
                hls.on(window.Hls.Events.ERROR, function (_, e) { if (e.fatal) stop(); });
                hls.loadSource(url);
                hls.attachMedia(video);
            } else { video.src = url; play(); }
        }
        profile().then(function (p) {
            if (!current()) return;
            var entry = movieEntry(movie, p);
            var audience = Number(movie.kp_rating) || (entry && entry.kpAudience);
            showRating('kp', audience);
            function useId(id) {
                if (!id || !current()) return;
                resolvedIds[kind + '/' + movie.id] = id;
                if (!audience && app.Reguest) {
                    var request = new app.Reguest();
                    request.timeout(4500);
                    request.native('https://rating.kinopoisk.ru/' + id + '.xml', function (xml) {
                        var data = typeof xml === 'string' ? new DOMParser().parseFromString(xml, 'text/xml') : xml;
                        if (!data || !data.querySelector) return;
                        ['kp', 'imdb'].forEach(function (name) {
                            var node = data.querySelector(name + '_rating');
                            if (node) showRating(name, node.textContent);
                        });
                    }, function () {}, false, {dataType: 'text'});
                }
                if (String(app.Storage.get('kp_personal_backdrop', true)) !== 'true' || document.hidden ||
                    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
                preview.timer = window.setTimeout(function () {
                    if (!current()) return;
                    trailers(id).then(function (clips) { if (clips.length) playBackground(clips[0].url); }).catch(function () {});
                }, 950);
            }
            var id = movie.kinopoisk_id || (entry && entry.kp);
            if (id) useId(id); else identifyMovie(movie, useId, true);
        });
    }

    if (document.head) {
        var style = document.createElement('style');
        var detailTags = ['.full-start-new__rate-line', '.full-start__rate-line'].reduce(function (selectors, line) {
            return selectors.concat(['.full-start__rate', '.full-start__pg', '.full-start__status'].map(function (tag) {
                return line + '>' + tag;
            }));
        }, []);
        var posterTags = ['.card__type', '.card__quality', '.card__vote.kp-home-score', '.card__new-episode>div'].map(function (tag) {
            return '.kp-home-cards .card ' + tag;
        }).join(',');
        style.textContent = [
            '.menu .menu__item[data-action="feed"],.kp-description-row>.items-line__head{display:none}',
            '.full-start-new{padding-bottom:1.6em}.kp-description-row .full-descr__text{line-height:1.48}',
            '@font-face {font-family: "KP Inter";font-style: normal;font-display: swap;font-weight: 100 900;src: url(https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.8/files/inter-latin-wght-normal.woff2) format("woff2");unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}',
            '@font-face {font-family: "KP Inter";font-style: normal;font-display: swap;font-weight: 100 900;src: url(https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.8/files/inter-cyrillic-wght-normal.woff2) format("woff2");unicode-range: U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116;}',
            'html body,body button,body input,body select,body textarea{font-family:-apple-system,BlinkMacSystemFont,"KP Inter",system-ui,Arial,sans-serif}',
            '.full-start-new .full-start-new__head,.kp-description-row .full-descr__info-name{font-size:.86em;font-weight:400;line-height:1.4;color:#aab0b3;letter-spacing:normal}',
            '.full-start-new .full-start-new__head>span{color:inherit}',
            '.kp-film-specs{display:flex;align-items:center;flex-wrap:wrap;color:#aab0b3;font-size:.86em;margin:0 0 .75em}.kp-film-specs:empty{display:none}.kp-film-specs>span,.kp-film-specs>.full-start__pg,.kp-film-specs>.full-start__status{display:inline-flex;align-items:center;box-sizing:border-box;padding:.08em .36em;margin:0 .45em 0 0;border:1px solid currentColor;border-radius:.14em;background:transparent;color:inherit;font-size:.85em;font-weight:500;line-height:1.25;white-space:nowrap}',
            '.full-start-new,.full-start{position:relative;isolation:isolate}.full-start-new__body{position:relative}',
            '@media(min-width:481px){.full-start-new .full-start-new__body{align-items:stretch}.full-start-new__body>.full-start-new__left{width:13.5em;max-width:26%;margin-right:2.25em}.full-start-new__body>.full-start-new__right{display:flex;flex-direction:column;min-width:0}.full-start-new .full-start-new__right>.full-start-new__buttons{margin-top:auto;padding-top:.75em}}',
            '.full-start-new .full-start-new__title{font-weight:700}',
            '.full-start-new .full-start-new__tagline{font-weight:400}',
            '.full-start-new .full-start-new__rate-line{font-size:1em}',
            detailTags.join(',') + ',' + posterTags + '{box-sizing:border-box;min-height:2.1em;min-width:2.1em;padding:.27em .74em;border:0;border-radius:5em;background:rgba(0,0,0,.35);color:#fff;font-size:1em;font-weight:500;line-height:1.2;font-variant-numeric:tabular-nums;align-items:center;justify-content:center}',
            detailTags.map(function (sel) { return sel + ':not(.hide)'; }).join(',') + '{display:inline-flex;flex:0 0 auto}',
            posterTags + '{display:inline-flex;min-height:1.95em;min-width:1.95em;font-size:.92em;padding:.22em .63em;font-weight:600;z-index:2}',
            '.kp-home-cards .card .card__type{top:.4em;left:.4em;right:auto;bottom:auto}.kp-home-cards .card .card__quality{bottom:.4em;left:.4em;right:auto}.kp-home-cards .card .card__vote.kp-home-score{bottom:.4em;right:.4em;left:auto}',
            '.full-start__rate-line>.full-start__rate>div,.full-start-new__rate-line>.full-start__rate>div{flex:0 0 auto;width:auto;height:auto;background:transparent;padding:0;font:inherit;color:inherit}',
            '.full-start__rate-line>.full-start__rate>div+div,.full-start-new__rate-line>.full-start__rate>div+div{margin-left:.4em}',
            '.card__title,.items-line__title,.settings__title,.modal__title,.selectbox__title{font-weight:600;letter-spacing:-.012em}',
            '.full-start-new .full-start-new__right{min-width:0;--kp-chip-gap:.55em}',
            '.full-start-new .full-start-new__head{line-height:1.4;margin:0 0 1.15em}',
            '.full-start-new .full-start-new__title{line-height:1.12;letter-spacing:-.018em;margin:0 0 .12em}',
            '.full-start-new .full-start-new__tagline{font-size:22px;line-height:1.4;max-width:40em;margin:0 0 .78em;color:rgba(255,255,255,.88)}',
            '.full-start-new .full-start-new__rate-line{flex-wrap:wrap;gap:0;padding-top:0;margin:0}',
            '.full-start-new .full-start-new__rate-line>*{margin:0 var(--kp-chip-gap,.55em) var(--kp-chip-gap,.55em) 0!important;white-space:nowrap}',
            '.full-start-new .full-start-new__details{line-height:1.35;min-height:0;margin:-.22em -.35em .85em}',
            '.full-start-new .full-start-new__details>*{margin:.22em .35em}',
            '.full-start-new .full-start-new__details:empty,.full-start-new .full-start-new__head:empty{display:none}',
            '.full-start-new .full-start-new__buttons>.full-start__button{margin-right:.6em}',
            '@media(max-width:700px){.full-start-new .full-start-new__right{max-width:100%}}',
            '.full-start-new__rate-line,.full-start__rate-line{align-items:center}.kp-preferred-ratings>.rate--tmdb{display:none!important}',
            '.full-start-new .full-start-new__reactions,.full-start .full-start__reactions{display:flex;align-items:center;flex-wrap:wrap;gap:0;margin:0 0 .55em;min-height:0}',
            '.full-start-new__reactions>div,.full-start__reactions>div{padding:0;margin:0 var(--kp-chip-gap,.55em) var(--kp-chip-gap,.55em) 0}',
            '.full-start-new__reactions .reaction,.full-start__reactions .reaction,.kp-personal-score.reaction{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:2.1em;min-height:2.1em;padding:.27em .74em;border-radius:5em;background-color:rgba(0,0,0,.35);color:#fff;font-size:1em;font-weight:500;line-height:1.2;white-space:nowrap}',
            '.full-start-new__reactions .reaction--voted,.full-start__reactions .reaction--voted{background-color:rgba(255,255,255,.3)}',
            '.full-start-new__reactions .reaction__icon,.full-start__reactions .reaction__icon{width:1.15em;height:1.15em;margin-right:.4em}.full-start-new__reactions .reaction__count,.full-start__reactions .reaction__count,.kp-personal-score .reaction__count{padding:0;font:inherit}',
            '.kp-personal-score.reaction{order:-5;cursor:pointer}.kp-personal-score.focus,.kp-personal-score:focus-visible{outline:2px solid white;outline-offset:2px}',
            '.kp-personal-score[data-voted]{background-color:#278543}.full-start-new__rate-line>.kp-personal-score[data-voted]:before,.full-start__rate-line>.kp-personal-score[data-voted]:before{content:"КП";margin-right:.35em}',
            '.full-start__rate.rate--kp:has(>.kp-personal-score){padding-left:.25em}.full-start__rate.rate--kp>.kp-personal-score{order:-1;flex:none;width:1.55em;height:1.55em;min-width:0;min-height:0;border:0;border-radius:50%;padding:0;margin:0 .45em 0 0;background:#278543;color:white;font:inherit;font-weight:650;line-height:1}',
            '.full-start-new__rate-line>.rate--kp,.full-start__rate-line>.rate--kp{order:-4}',
            '.full-start-new__rate-line>.rate--imdb,.full-start__rate-line>.rate--imdb{order:-3}',
            '.full-start-new__rate-line>.rate--tmdb,.full-start__rate-line>.rate--tmdb{order:-2}',
            '.full-start-new__rate-line>.rate--critics,.full-start__rate-line>.rate--critics{order:-1}',
            '.full-start-new.kp-trailer-playing,.full-start.kp-trailer-playing{background:linear-gradient(to bottom,transparent,#101416 22%,#101416 70%,transparent)}',
            '.kp-preview-layer{position:absolute;z-index:-1;top:0;right:0;bottom:0;width:58%;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .45s ease;-webkit-mask-image:linear-gradient(to right,transparent,#000 64%);mask-image:linear-gradient(to right,transparent,#000 64%)}',
            '.kp-preview-frame{position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 22%,#000 70%,transparent);mask-image:linear-gradient(to bottom,transparent,#000 22%,#000 70%,transparent)}.kp-preview-layer.is-playing{opacity:1}.kp-preview-layer video{position:absolute;left:0;top:-25%;width:100%;height:145%;object-fit:cover;object-position:center 50%}',
            '.kp-preview-frame:after{content:"";position:absolute;inset:0;top:0;left:0;right:0;bottom:0;background:linear-gradient(to right,#101416,rgba(0,0,0,.68) 34%,rgba(0,0,0,.24) 78%)}',
            '@media (min-width:601px) and (max-width:960px){.kp-preview-layer{width:45%}.kp-preview-frame:after{background:linear-gradient(to right,#101416,rgba(0,0,0,.74) 55%,rgba(0,0,0,.54))}}',
            '.card__view>.card__marker--viewed,.full-start-new__poster>.card__marker--viewed,.full-start__poster>.card__marker--viewed,.kp-watched-overlay{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;border-radius:1em;background:rgba(0,0,0,.42);z-index:1;pointer-events:none}',
            '.card__marker.card__marker--viewed:before,.kp-watched-overlay:before{content:"";display:block;width:1.95em;height:1.95em;width:var(--kp-check-width,1.95em);height:var(--kp-check-height,1.95em);margin:0;border:0;border-radius:0;background:transparent center/contain no-repeat url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 28 29%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.7%27%3E%3Ccircle cx=%2714%27 cy=%2714.5%27 r=%2713%27/%3E%3Cpath d=%27m8 14.5 4 4 8-8%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E")}',
            '.card__marker--viewed>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}',
            '.kp-profile-seen>.card__marker--viewed{display:none}.card__view>.card__vote,.card__view>.card__icons{z-index:2}',
            '.kp-home-cards .kp-no-score .card__vote,.kp-profile-seen .card__icon.icon--history{display:none}',
            '.kp-home-cards .card__view>.card__vote.kp-mine{background-color:#278543!important}.kp-row-description{font-size:1em;font-weight:400;line-height:1.35;opacity:.72;margin:.25em 0 1em}',
            '.items-line__head+.kp-row-description{margin-left:1.5em;margin-right:1.5em}',
            '.kp-row-description.kp-grid-description{margin:0 1.5em 1em}'
        ].join('');
        document.head.appendChild(style);
    }
    app.Listener.follow('activity', function (e) {
        homeActivity(e);
        if (!activePreview || (e.type !== 'archive' && e.type !== 'destroy')) return;
        var node = e.object && e.object.activity && e.object.activity.render()[0];
        if (!node || node === activePreview.root || node.contains(activePreview.root)) stopPreview();
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopPreview(); });
    if (app.Player && app.Player.listener) app.Player.listener.follow('create', stopPreview);

    app.Listener.follow('full', function (e) {
        if (e.type !== 'complite' || !e.data || !e.data.movie) return;
        actionsButton(e);
        var holder = e.object && e.object.activity && e.object.activity.render();
        var cardRoot = holder && holder[0];
        if (cardRoot && cardRoot.querySelector) cardPresentation(e.data.movie, cardRoot);
        var selected = e.object && (e.object.card || (e.object.params && e.object.params.card));
        if (selected && selected.kpReason && e.object.activity) {
            var heading = e.object.activity.render().find('.full-start-new__title, .full-start__title').first();
            if (heading.length && !heading.parent().find('.kp-personal-reason').length)
                $('<div class="kp-personal-reason"></div>').css({fontSize: '0.85em', opacity: 0.8})
                    .text(selected.kpReason).insertAfter(heading);
        }
        var movie = e.data.movie, block = $('.full-start-new__rate-line:visible, .full-start__rate-line:visible').last();
        if (!block.length) block = $('.full-start-new__title:visible, .full-start__title:visible').last();
        var draw = function (p) {
            if (!block.length || !$.contains(document, block[0])) {
                if (scoreView === draw) scoreView = null;
                return;
            }
            if (p && draw.revision === p.updated) return;
            draw.revision = p && p.updated;
            var k = movieEntry(movie, p);
            var watched = k && p.history.indexOf(k) >= 0;
            var poster = cardRoot && cardRoot.querySelector && cardRoot.querySelector('.full-start-new__poster, .full-start__poster');
            if (poster) watchedPoster(poster, !!watched || !!currentVote(movie.kinopoisk_id || (k && k.kp), k));
            var publicScore = Number(k && k.kpAudience) || Number(movie.kp_rating);
            if (publicScore > 0 && publicScore <= 10 && block[0].querySelector) {
                var field = block[0].querySelector('.rate--kp');
                if (!field) {
                    var template = block[0].querySelector('.rate--tmdb');
                    if (template) {
                        field = template.cloneNode(true);
                        field.classList.remove('rate--tmdb');
                        field.classList.add('rate--kp');
                        var imdb = block[0].querySelector('.rate--imdb') || template;
                        imdb.parentNode.insertBefore(field, imdb.nextSibling);
                    }
                }
                if (field && field.children.length >= 2) {
                    field.children[0].textContent = publicScore.toFixed(1);
                    field.children[1].textContent = 'КП';
                    field.classList.remove('hide');
                }
            }
            var value = currentVote(movie.kinopoisk_id || (k && k.kp), k);
            var surface = holder || block;
            surface.find('.kp-personal-score').remove();
            var badge = $('<span class="reaction kp-personal-score selector"></span>');
            var label = $('<span class="reaction__count"></span>').text(value ? String(value) : 'Оценить на КП');
            label.appendTo(badge);
            if (value) badge.attr('data-voted', 'true');
            badge.on('hover:enter', function () {
                function rate(id) {
                    movie.kinopoisk_id = id;
                    withAccess(function (token) { chooseVote(movie, id, k, token); });
                }
                var id = movie.kinopoisk_id || (k && k.kp);
                if (id) rate(id); else identifyMovie(movie, rate);
            });
            var hint = value ? 'Моя оценка на Кинопоиске: ' + value + '. Изменить' : 'Поставить оценку на Кинопоиске';
            badge.attr('title', hint).attr('aria-label', hint).attr('role', 'button').prependTo(block);
            if (app.Controller && app.Controller.collectionAppend && app.Controller.enabled().name === 'full_start')
                app.Controller.collectionAppend(badge);

        };
        scoreView = draw;
        profile().then(draw);
    });
    function enabled(name) {
        return String(app.Storage.get(name, false)) === 'true';
    }

    var viewedJob = false;
    function viewedEnabled() {
        return String(app.Storage.get('kp_personal_viewed', true)) === 'true';
    }
    function viewedLedgerKey(p) {
        var permit = app.Account && app.Account.Permit;
        var account = permit && permit.account;
        var target = permit && permit.sync ? account && account.profile && account.profile.id : 'local';
        return target ? 'kp_personal_viewed_v1_' + p.profile + '_' + target : '';
    }
    function importViewed(p) {
        if (!p || !app.Favorite || viewedJob || document.hidden || !viewedEnabled()) return;
        var key = viewedLedgerKey(p);
        if (!key) return;
        var ledger = app.Storage.get(key, {});
        var now = Date.now();
        var queue = p.history.filter(function (entry) {
            return ledger[entry.kp] !== 'done' && !(ledger[entry.kp] > now);
        });
        function active() {
            return !document.hidden && viewedEnabled() && key === viewedLedgerKey(p) && snapshot === p;
        }
        function next() {
            if (!active() || !queue.length) { viewedJob = false; return; }
            var entry = queue.shift();
            resolveMovie(entry).then(function (movie) {
                if (!active()) return;
                var retry = Date.now() + 86400000;
                if (movie) {
                    var marks = app.Favorite.check(movie);
                    // Keep an explicit Lampa status such as "watching" or "dropped".
                    if (!marks.viewed && !marks.look && !marks.continued && !marks.scheduled && !marks.thrown) {
                        movie.source = 'tmdb';
                        movie.kinopoisk_id = entry.kp;
                        app.Favorite.add('viewed', movie);
                        marks = app.Favorite.check(movie);
                        retry = Date.now() + 600000;
                    }
                    if (marks.viewed) retry = 'done';
                }
                ledger[entry.kp] = retry;
                app.Storage.set(key, ledger);
            }).catch(function () {
                ledger[entry.kp] = Date.now() + 600000;
            }).then(function () { window.setTimeout(next, 1500); });
        }
        viewedJob = true;
        next();
    }

    var futureJob = false, futureChecked = '';
    function importFuture(p) {
        if (!p || !enabled('kp_personal_future') || futureJob) return;
        var today = new Date().toISOString().slice(0, 10);
        var revision = p.profile + '/' + p.updated + '/' + today;
        if (futureChecked === revision) return;
        var queue = p.watchlist.filter(function (k) { return !k.year || Number(k.year) >= Number(today.slice(0, 4)); });
        var imported = app.Storage.get('kp_personal_future_added', {});
        var failed = false;
        futureJob = true;
        function next() {
            if (!enabled('kp_personal_future') || !queue.length) {
                futureJob = false;
                if (!failed && !queue.length) futureChecked = revision;
                return;
            }
            var k = queue.shift();
            if (imported[k.kp]) return next();
            resolveMovie(k).then(function (movie) {
                if (!movie || !enabled('kp_personal_future')) return;
                var date = movie.release_date || movie.first_air_date;
                if (!date || date <= today) return;
                if (!app.Favorite.check(movie).wath) {
                    movie.source = 'tmdb';
                    app.Favorite.add('wath', movie);
                }
                imported[k.kp] = true;
                app.Storage.set('kp_personal_future_added', imported);
            }).catch(function () { failed = true; }).then(function () { window.setTimeout(next, 900); });
        }
        next();
    }

    function setting(name, label, description, change, defaultValue) {
        app.SettingsApi.addParam({component: source, param: {name: name, type: 'trigger', default: !!defaultValue},
            field: {name: label, description: description}, onChange: change || function () {}});
    }

    function refreshVisible() {
        if (document.hidden || !endpoint()) return;
        profile().then(function (p) {
            if (!p || document.hidden) return;
            if (homePage && homeProfile !== p) scheduleHome();
            importViewed(p);
            importFuture(p);
            if (scoreView) scoreView(p);
            if (homeVersion === null || homeVersion === p.updated || Date.now() - lastInput < 10000) return;
            var active = app.Activity.active();
            var controller = app.Controller.enabled();
            if (active && (active.component === 'main' || active.component === 'kp_personal_tab') && controller && controller.name === 'content') {
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
    app.SettingsApi.addComponent({component: source, name: 'Мой Кинопоиск', icon: kpIcon});
    setting('kp_personal_viewed', 'Просмотрено из Кинопоиска', 'В фоне отмечать в Lampa оценённые и просмотренные тайтлы из КП. У сериала отмечается только карточка целиком.', function () {
        if (viewedEnabled()) profile().then(importViewed);
    }, true);
    if (window.appready) profile().then(importViewed);
    else app.Listener.follow('app', function (e) { if (e.type === 'ready') profile().then(importViewed); });
    setting('kp_personal_backdrop', 'Трейлер КП на фоне', 'Запускать трейлер без звука поверх фона карточки.', function () {
        if (String(app.Storage.get('kp_personal_backdrop', true)) !== 'true') stopPreview();
    }, true);
    setting('kp_personal_future', 'Будущие релизы в «Позже»', 'Добавлять из «Буду смотреть» фильмы и сериалы с предстоящей датой выхода в TMDB.', function () {
        if (enabled('kp_personal_future')) profile().then(importFuture);
    });
    setting('kp_personal_language_filter', 'Фильтр языка рекомендаций TMDB', 'Скрывать фильмы и сериалы с русским, корейским и китайским языком оригинала в ряду «По моим высоким оценкам».', function () {
        discovery = null;
        var active = app.Activity.active();
        if (active && active.component === 'main') app.Activity.replace();
    });
    setting('kp_personal_mirror_vote', 'Дублировать новые оценки в реакциях Lampa', 'Добавлять реакцию после успешной записи оценки с этого устройства.');
    setting('kp_personal_remove_later', 'Убирать из «Буду смотреть» после оценки', 'Снимать фильм с очереди КП после успешной записи оценки с пульта.');
    app.SettingsApi.addParam({component: source, param: {type: 'button', name: 'kp_personal_signin'},
        field: {name: 'Аккаунт для оценок', description: 'Вход через модуль and7ey и управление текущей сессией Яндекса.'},
        onChange: function () { withAccess(accountSettings); }});
    function retireLegacy() {
        if (!app.Plugins || !app.Plugins.get || !app.Plugins.remove) return;
        if (Object.keys(app.Storage.get('kinopoisk_my_ratings_postponed', {})).length) {
            app.Noty.show('В прежнем плагине есть неотправленные оценки. Дождитесь их отправки.');
            return;
        }
        var legacy = app.Plugins.get().filter(function (plugin) {
            try {
                var url = new URL(plugin.url, window.location.href);
                return (url.hostname === 'and7ey.github.io' && /^\/lampa\/kinopoisk(?:_rating)?\.js$/.test(url.pathname)) ||
                    (url.hostname === 'cdn.jsdelivr.net' && /^\/gh\/and7ey\/lampa(?:@[^/]+)?\/kinopoisk(?:_rating)?\.js$/.test(url.pathname));
            } catch (err) { return false; }
        });
        legacy.forEach(function (plugin) { app.Plugins.remove(plugin); });
        app.Noty.show(legacy.length ? 'Прежний плагин удалён с устройства. Перезапустите Lampa.' : 'Локальных копий and7ey нет. Установки CUB видны в разделе расширений.');
    }
    app.SettingsApi.addParam({component: source, param: {type: 'button', name: 'kp_personal_retire'},
        field: {name: 'Убрать прежний плагин КП', description: 'Удалить локальные расширения Кинопоиск и Кинопоиск Рейтинги от and7ey.'},
        onChange: retireLegacy});
    if (cloud) return;
    app.SettingsApi.addParam({component: source,
        param: {name: 'kp_profile_server', type: 'input', default: localServer || origin},
        field: {name: 'Адрес сервера профиля', description: 'HTTP-адрес компьютера с profile_server.py'},
        onChange: function () {
            generation++; version = ''; homeVersion = null; loadedAt = 0; pending = null; snapshot = null; discovery = null;
            app.Noty.show('Откройте главную заново');
        }});
})();
