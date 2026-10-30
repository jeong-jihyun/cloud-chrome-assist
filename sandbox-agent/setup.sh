#!/bin/sh
# Runs once inside the sandbox: system libs + node modules + Chromium.
cd /vercel/sandbox/agent || exit 1
export PLAYWRIGHT_BROWSERS_PATH=/vercel/sandbox/agent/browsers
sudo dnf install -y --skip-broken nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm \
  libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib libxkbcommon libxcb \
  libX11-xcb libX11 libXext libXcursor libXfixes libXi libXrender libXtst gtk3 cairo-gobject \
  fontconfig freetype google-noto-sans-cjk-ttc-fonts liberation-fonts
sudo ldconfig
npm install --no-audit --no-fund playwright-core ws || exit 1
npx playwright-core install chromium || exit 1
touch .ready
echo SETUP_DONE
