#!/bin/sh
# Runs once inside the sandbox: system libs + node modules + Chromium.
# The sandbox image is Ubuntu (apt-get), and this script lives in the agent dir, so cd to where it is.
cd "$(dirname "$0")" || exit 1
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/browsers"
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -y
# Install one by one so a package name that differs on this Ubuntu release does not abort the rest.
for p in libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libasound2t64 libxkbcommon0 \
  libxcb1 libx11-6 libxext6 libxfixes3 libcairo2 fontconfig fonts-noto-cjk fonts-liberation; do
  sudo apt-get install -y --no-install-recommends "$p" || echo "SKIP $p"
done
sudo ldconfig
npm install --no-audit --no-fund playwright-core ws || exit 1
npx playwright-core install chromium || exit 1
touch .ready
echo SETUP_DONE
