#!/bin/sh
# Fetch the engine repository at the PINNED commit into ./engine-checkout.
# The engine repo is READ-ONLY for this client: this script never modifies it
# (no branches, no commits — a detached checkout of the pin, verified).
set -e
PIN="06c92496f7051f15069663296ec51e88e170fe18"
URL="https://github.com/ansaribilal14/open-video-engine.git"
OUT="$(cd "$(dirname "$0")" && pwd)/engine-checkout"

if [ ! -d "$OUT/.git" ]; then
    git clone "$URL" "$OUT"
fi
cd "$OUT"
git fetch origin "$PIN" 2>/dev/null || git fetch origin
git checkout --detach "$PIN" 2>/dev/null
ACTUAL="$(git rev-parse HEAD)"
if [ "$ACTUAL" != "$PIN" ]; then
    echo "FATAL: engine checkout is $ACTUAL, expected $PIN" >&2
    exit 1
fi
echo "ENGINE-CHECKOUT-OK $ACTUAL"
