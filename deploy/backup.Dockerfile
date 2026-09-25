# Nightly SQLite backup sidecar: sqlite3 baked in (no apk at runtime) and run as the engine's uid, not root.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache sqlite && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
# .backup is safe on a live WAL database.
CMD ["/bin/sh", "-c", "mkdir -p /data/backups; while true; do for db in /data/bees-*.sqlite; do [ -f \"$db\" ] || continue; n=$(basename \"$db\" .sqlite); sqlite3 \"$db\" \".backup /data/backups/$n-$(date -u +%F).sqlite\"; done; find /data/backups -name '*.sqlite' -mtime +7 -delete; sleep 86400; done"]
