#!/bin/sh
# Installer for an already managed webOS Homebrew TV.
set -eu
dest=/var/lib/webosbrew/kp-personal
boot=/var/lib/webosbrew/init.d/45-kp-personal
case "${1-}" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Usage: sh webos-install.sh PROFILE' >&2; exit 2;; esac
[ "$(id -u)" = 0 ] && [ -d /var/lib/webosbrew/init.d ] || { echo 'Existing webOS Homebrew administration required.' >&2; exit 1; }
command -v curl >/dev/null
if command -v python3 >/dev/null; then py=$(command -v python3); else py=$(command -v python); fi
"$py" -c 'import sys, pwd, ssl; assert sys.version_info >= (2,7); pwd.getpwnam("nobody")'
here=$(CDPATH= cd "$(dirname "$0")" && pwd)
"$py" "$here/profile_server.py" --help >/dev/null
test -s "$here/profile.js"
mkdir -p "$dest/data"
chmod 755 "$dest"
chown nobody "$dest/data"
chmod 700 "$dest/data"
for name in profile.js profile_server.py recommendations.py; do
    if [ "$name" = recommendations.py ] && [ ! -f "$here/$name" ]; then continue; fi
    cp "$here/$name" "$dest/$name.new"
    chmod 644 "$dest/$name.new"
    mv "$dest/$name.new" "$dest/$name"
done
printf '%s\n' "$1" > "$dest/profile.new"
chmod 644 "$dest/profile.new"
mv "$dest/profile.new" "$dest/profile"
cat > "$dest/start.new" <<'BOOT'
#!/bin/sh
set -eu
cd /var/lib/webosbrew/kp-personal
if command -v python3 >/dev/null; then py=$(command -v python3); else py=$(command -v python); fi
profile=$(cat profile)
"$py" -u profile_server.py "$profile" --curl --run-as nobody --bind 127.0.0.1 --port 8766 --cache "data/$profile.json" </dev/null >/dev/null 2>&1 &
BOOT
chmod 755 "$dest/start.new"
mv "$dest/start.new" "$boot"
if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:8766/kp.js >/dev/null 2>&1; then
    echo 'Files updated. Restart the TV to load the new service.'
else
    "$boot"
    sleep 2
    curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:8766/kp.js >/dev/null
    echo 'Ready. Lampa plugin URL: http://127.0.0.1:8766/kp.js'
fi
