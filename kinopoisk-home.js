(function () {
    'use strict';

    if (!window.Lampa || !Lampa.ContentRows || window.kinopoiskHomeRegistered) return;

    Lampa.ContentRows.add({
        name: 'kinopoisk_watchlist_home',
        title: 'Кинопоиск · Буду смотреть',
        screen: 'main',
        index: 0,
        call: function () {
            return function (done) {
                var films = Lampa.Storage.get('kinopoisk_movies', []);
                if (!Array.isArray(films) || !films.length) return done();

                done({
                    title: 'Кинопоиск · Буду смотреть',
                    source: 'tmdb',
                    results: films.slice(),
                    page: 1,
                    total_pages: 1
                });
            };
        }
    });
    window.kinopoiskHomeRegistered = true;
})();
