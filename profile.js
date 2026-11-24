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
        if (!tmdb.external_imdb_id) return Promise.resolve('');
        var resolved = movie.source === source && movie.kpEntry ? resolveMovie(movie.kpEntry) : Promise.resolve(movie);
        return resolved.then(function (m) {
            if (!m || !Number(m.id)) return '';
            return new Promise(function (done) {
                tmdb.external_imdb_id({type: m.name || m.original_name ? 'tv' : 'movie', id: m.id}, done);
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
        var imdb = Number(movie.imdb_rating) || (cached && cached.value);
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
            badge.classList.add('kp-home-score');
            var label = (personal || score === 10) ? String(score) : score.toFixed(1);
            if (badge.textContent !== label) badge.textContent = label;
            badge.title = personal ? 'Моя оценка на Кинопоиске' : audience ? 'Рейтинг зрителей Кинопоиска' : 'Рейтинг IMDb';
            badge.classList.toggle('kp-mine', !!personal);
        } else if ((!cached || cached.until <= Date.now()) && (tmdb.external_imdb_id || movie.imdb_id)) {
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
        if (e.component !== 'main' && e.component !== 'kp_personal_tab' && e.component !== 'recomend' && !row) return;
        homePage = {root: root, row: row, tab: e.component === 'kp_personal_tab' || e.object.source === source};
        root.classList.add('kp-home-cards');
        if (window.IntersectionObserver) posterObserver = new window.IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
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
            preview.layer.remove();
        }
    }
    function cardPresentation(movie, root) {
        stopPreview();
        var hero = root.querySelector('.full-start-new, .full-start');
        if (!hero) return;
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
            var backdrop = root.querySelector('img.full-start__background');
            var background = backdrop ? backdrop.parentNode : document.querySelector('.background');
            if (!background) return;
            var layer = preview.layer = document.createElement('div');
            layer.className = 'kp-preview-layer ' + (backdrop ? 'full-start__background' : 'kp-preview-screen');
            var video = preview.video = document.createElement('video');
            video.muted = video.defaultMuted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            layer.setAttribute('aria-hidden', 'true');
            layer.appendChild(video);
            background.insertBefore(layer, backdrop || null);
            function stop() { if (activePreview === preview) stopPreview(); }
            video.onended = video.onerror = stop;
            video.onplaying = function () {
                if (!current()) return stop();
                window.clearTimeout(preview.timer);
                layer.classList.add('is-playing');
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
        style.textContent = [
            '.kp-personal-reaction-line{display:flex;align-items:flex-start;flex-wrap:wrap;margin:-.5em -.5em 1em}',
            '.kp-personal-reaction-line .full-start-new__reactions,.kp-personal-reaction-line .full-start__reactions{margin:0}',
            '.kp-personal-score.reaction{box-sizing:border-box;display:inline-flex;justify-content:center;height:2.6em;white-space:nowrap;color:white}',
            '.kp-personal-reaction-line>.kp-personal-score{margin:.5em}',
            '.kp-personal-score.focus{box-shadow:0 0 0 .13em currentColor}',
            '.full-start-new__rate-line>.rate--kp,.full-start__rate-line>.rate--kp{order:-4}',
            '.full-start-new__rate-line>.rate--imdb,.full-start__rate-line>.rate--imdb{order:-3}',
            '.full-start-new__rate-line>.rate--tmdb,.full-start__rate-line>.rate--tmdb{order:-2}',
            '.full-start-new__rate-line>.rate--critics,.full-start__rate-line>.rate--critics{order:-1}',
            '.kp-preview-layer{overflow:hidden;pointer-events:none;opacity:0;transition:opacity .55s ease}',
            '.kp-preview-screen{position:absolute;top:0;bottom:0;left:0;right:0}',
            '.kp-preview-layer.is-playing{opacity:.75}.kp-preview-layer.is-playing+img.full-start__background{opacity:0}',
            '.kp-preview-layer video{display:block;width:100%;height:100%;object-fit:cover}',
            '.kp-preview-layer:after{content:"";position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(90deg,rgba(14,17,27,.65),transparent 75%),linear-gradient(0deg,rgba(14,17,27,.72),transparent 60%),rgba(0,0,0,.32)}',
            '.card__view>.card__marker--viewed,.full-start-new__poster>.card__marker--viewed,.full-start__poster>.card__marker--viewed,.kp-watched-overlay{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;border-radius:1em;background:rgba(0,0,0,.42);z-index:1;pointer-events:none}',
            '.card__marker.card__marker--viewed:before,.kp-watched-overlay:before{content:"";display:block;width:1.8em;height:1.8em;margin:0;border:0;border-radius:0;background:transparent center/contain no-repeat url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 28 29%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272.7%27%3E%3Ccircle cx=%2714%27 cy=%2714.5%27 r=%2713%27/%3E%3Cpath d=%27m8 14.5 4 4 8-8%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E")}',
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
            var label = $('<span class="reaction__count"></span>').text(value ? 'КП ' + value : 'Оценить на КП');
            label.appendTo(badge);
            if (value) badge.css({backgroundColor: value >= 7 ? '#278543' : value >= 5 ? '#65666b' : '#bb4146'});
            badge.on('hover:enter', function () {
                function rate(id) {
                    movie.kinopoisk_id = id;
                    withAccess(function (token) { chooseVote(movie, id, k, token); });
                }
                var id = movie.kinopoisk_id || (k && k.kp);
                if (id) rate(id); else identifyMovie(movie, rate);
            });
            var reactions = cardRoot && cardRoot.querySelector && cardRoot.querySelector('.full-start-new__reactions, .full-start__reactions');
            if (reactions) {
                if (!reactions.parentNode.classList.contains('kp-personal-reaction-line'))
                    $(reactions).wrap('<div class="kp-personal-reaction-line"></div>');
                badge.attr('title', value ? 'Моя оценка на Кинопоиске' : watched ? 'Просмотрено на КП · поставить оценку' : 'Поставить оценку на Кинопоиске').insertBefore(reactions);
            } else badge.appendTo(block);
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
