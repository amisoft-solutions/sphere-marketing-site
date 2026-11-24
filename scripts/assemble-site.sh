#!/bin/sh
# Copy the marketing site into a publish directory. worker/ is not included.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dest=${1:-"$root/_site"}
rm -rf "$dest"
mkdir -p "$dest/shared" "$dest/assets" "$dest/screenshots"
cp "$root/index.html" "$root/styles.css" "$root/main.js" "$root/config.js" "$root/demo-form.js" "$root/CNAME" "$dest/"
cp "$root/shared/demo-request-validate.js" "$dest/shared/"
cp -R "$root/assets/." "$dest/assets/"
cp -R "$root/screenshots/." "$dest/screenshots/"
: > "$dest/.nojekyll"
if [ -e "$dest/worker" ] || [ -e "$dest/wrangler.toml" ] || [ -e "$dest/.dev.vars" ] || [ -e "$dest/.dev.vars.example" ]; then
  echo "Refusing to publish worker files" >&2
  exit 1
fi
if [ ! -f "$dest/index.html" ] || [ ! -f "$dest/CNAME" ] || [ ! -f "$dest/shared/demo-request-validate.js" ]; then
  echo "Publish directory is missing marketing files" >&2
  exit 1
fi
echo "Assembled $dest"
