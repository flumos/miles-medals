#!/bin/zsh
# Deploy mit automatischem Versions-Bump (Cache-Busting + sichtbare Version im Footer).
set -e
cd "$(dirname "$0")/.."
CUR=$(grep -o 'appver">v[0-9]*' index.html | grep -o '[0-9]*')
NEXT=$((CUR + 1))
sed -i '' "s/?v=${CUR}/?v=${NEXT}/g" index.html src/app.js
sed -i '' "s/appver\">v${CUR}/appver\">v${NEXT}/" index.html
node test.mjs > /dev/null || { echo "TESTS ROT — Abbruch"; git checkout index.html src/app.js; exit 1; }
git add -A && git commit -m "v${NEXT}: $1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Pi2K1vzWfp4WVXa9TshdBc" && git push origin main
npx wrangler deploy
echo "Deployed v${NEXT}"
