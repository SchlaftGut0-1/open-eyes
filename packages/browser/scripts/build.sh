#!/bin/bash
# Adapted from ungoogled-chromium-portablelinux (BSD-3-Clause, see LICENSE.ungoogled-chromium).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ungoogled="${root}/ungoogled-chromium"
build="${OPEN_EYES_CHROMIUM_BUILD:-${XDG_CACHE_HOME:-$HOME/.cache}/open-eyes-browser}"
cache="${build}/download_cache"
src="${build}/src"
out="${src}/out/Default"
mkdir -p "${cache}"

if [ ! -f "${src}/.downloaded.stamp" ]; then
    "${ungoogled}/utils/downloads.py" retrieve -i "${ungoogled}/downloads.ini" -c "${cache}"
    "${ungoogled}/utils/downloads.py" unpack -i "${ungoogled}/downloads.ini" -c "${cache}" "${src}"
    touch "${src}/.downloaded.stamp"
fi

if [ ! -f "${src}/.patched.stamp" ]; then
    "${ungoogled}/utils/prune_binaries.py" "${src}" "${ungoogled}/pruning.list"
    "${ungoogled}/utils/patches.py" apply "${src}" "${ungoogled}/patches" "${root}/patches"
    touch "${src}/.patched.stamp"
fi

if [ ! -f "${src}/.domsub.stamp" ]; then
    "${ungoogled}/utils/domain_substitution.py" apply -r "${ungoogled}/domain_regex.list" -f "${ungoogled}/domain_substitution.list" "${src}"
    # Domain substitution also rewrites where the build fetches its own toolchain and sysroot.
    sed -i 's/commondatastorage.9oo91eapis.qjz9zk/commondatastorage.googleapis.com/g' \
        "${src}/build/linux/sysroot_scripts/sysroots.json" "${src}/tools/clang/scripts/update.py" "${src}/tools/clang/scripts/build.py"
    sed -i 's/chromium.9oo91esource.qjz9zk/chromium.googlesource.com/g' \
        "${src}/tools/clang/scripts/build.py" "${src}/tools/rust/build_rust.py" "${src}/tools/rust/build_bindgen.py"
    sed -i 's/chrome-infra-packages.8pp2p8t.qjz9zk/chrome-infra-packages.appspot.com/g' "${src}/tools/rust/build_rust.py"
    touch "${src}/.domsub.stamp"
fi

if [ ! -f "${src}/.rename.stamp" ]; then
    "${root}/scripts/rename.py" "${src}"
    touch "${src}/.rename.stamp"
fi

if [ ! -f "${src}/.toolchain.stamp" ]; then
    "${src}/tools/rust/update_rust.py"
    "${src}/tools/clang/scripts/update.py"
    "${src}/build/linux/sysroot_scripts/install-sysroot.py" --arch=x64
    for tool in node:third_party/node/linux/node-linux-x64/bin gperf:third_party/gperf/cipd/bin \
        go:third_party/dawn/tools/golang/linux-amd64/bin clang-format:buildtools/linux64-format; do
        mkdir -p "${src}/${tool#*:}"
        ln -sf "$(command -v "${tool%%:*}")" "${src}/${tool#*:}/${tool%%:*}"
    done
    mkdir -p "${src}/third_party/typescript/linux-amd64/src/lib"
    # DevTools needs TypeScript 7: version 6 rejects some of its declarations.
    npm install --prefix "${build}/typescript" --no-save --no-audit --no-fund typescript@7.0.2
    ln -sf "${build}/typescript/node_modules/.bin/tsc" "${src}/third_party/typescript/linux-amd64/src/lib/tsc"
    rm -rf "${src}/third_party/devtools-frontend/src/node_modules/esbuild"
    ln -s /usr/lib/node_modules/esbuild "${src}/third_party/devtools-frontend/src/node_modules/esbuild"
    touch "${src}/.toolchain.stamp"
fi

theme="${src}/chrome/app/theme"
cp "${root}/resources/icon.svg" "${theme}/chromium/product_logo.svg"
for size in 16 24 48 64 128 256; do rsvg-convert -w "${size}" -h "${size}" "${root}/resources/icon.svg" -o "${theme}/chromium/product_logo_${size}.png"; done
for size in 24 48 64 128 256; do cp "${theme}/chromium/product_logo_${size}.png" "${theme}/chromium/linux/product_logo_${size}.png"; done
rsvg-convert -w 32 -h 32 "${root}/resources/icon.svg" | magick png:- "${theme}/chromium/linux/product_logo_32.xpm"
for scale in 1:default_100_percent 2:default_200_percent; do
    for size in 16 32; do rsvg-convert -w $((size * ${scale%%:*})) -h $((size * ${scale%%:*})) "${root}/resources/icon.svg" -o "${theme}/${scale#*:}/chromium/product_logo_${size}.png"; done
done

mkdir -p "${out}"
geist="${cache}/geist-font-v1.7.2.zip"
if [ ! -f "${out}/fonts/OFL.txt" ]; then
    [ -f "${geist}" ] || curl -fsSL -o "${geist}" https://github.com/vercel/geist-font/releases/download/v1.7.2/geist-font-v1.7.2.zip
    echo "7fc800d2ac6b92844895196e5041aca55d814c15db70c44f79b3b83ab82b04e2  ${geist}" | sha256sum -c --quiet
    unzip -oj "${geist}" geist-font/OFL.txt geist-font/Geist/ttf/Geist-{Regular,Medium,SemiBold,Bold}.ttf -d "${out}/fonts"
fi
cat "${ungoogled}/flags.gn" "${root}/flags.gn" > "${out}/args.gn"
printf 'target_cpu = "x64"\nv8_target_cpu = "x64"\n' >> "${out}/args.gn"

llvm="${src}/third_party/llvm-build/Release+Asserts/bin"
export CC="${llvm}/clang" CXX="${llvm}/clang++" AR="${llvm}/llvm-ar" NM="${llvm}/llvm-nm" LLVM_BIN="${llvm}"
resource_dir="$("${CC}" --print-resource-dir)"
for flags in CFLAGS CXXFLAGS CPPFLAGS; do export "${flags}=${!flags:-} -resource-dir=${resource_dir} -B${llvm}"; done

cd "${src}"
[ -x out/Default/gn ] || ./tools/gn/bootstrap/bootstrap.py -o out/Default/gn --skip-generate-buildfiles
./out/Default/gn gen out/Default --fail-on-unused-args
ninja -C out/Default chrome "$@"
