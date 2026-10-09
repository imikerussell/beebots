#!/bin/sh
# Writes two OKX Agent Trade Kit profiles: tiger, mochi, all on site "eea".
# They hold NO keys. The engine passes each bee's key from .env into that one CLI call's environment,
# which the kit gives precedence over the profile. So secrets live only in .env (hard rule 8).
# Safe to re-run: it only writes the file if it does not exist yet.
set -eu
dir="$HOME/.okx"
file="$dir/config.toml"
mkdir -p "$dir"
chmod 700 "$dir"
if [ -f "$file" ]; then
  echo "~/.okx/config.toml already exists; not touching it. Add [profiles.tiger], [profiles.mochi] with site = \"eea\" if missing."
  exit 0
fi
umask 077
cat > "$file" <<'EOF'
# Catfolio: one profile per cat. No keys here; they come from .env at call time.
[profiles.tiger]
site = "eea"

[profiles.mochi]
site = "eea"
EOF
echo "wrote ~/.okx/config.toml with profiles tiger, mochi (site eea, no keys)"
