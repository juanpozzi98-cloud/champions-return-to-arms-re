#!/bin/sh
# Builds the browser version: Play! (https://github.com/jpd002/Play-, BSD 2-clause) at the
# commit tools/play-net was written against, with tools/play-net/play-net.patch (the
# changes this game needs in the emulator's core), play-web.patch (what a browser needs on
# top of that), perf.patch (less work per frame, on top of both: docs/issues/browser-perf.md),
# safari.patch (retains VU1 translated blocks when game graphics programs alternate),
# the sources in src/ and - for online play - the desktop application's network and online
# driver (tools/play-net/src: RtaNet, RtaOnline), compiled to WebAssembly with Emscripten.
#
#   brew install emscripten cmake ninja      # once
#   tools/play-web/build.sh                  # clone (first time), patch, configure, build
#   tools/play-web/serve.py                  # then open http://127.0.0.1:8973/
#
# Everything is put under local/ (ignored by the repository):
#   local/play-web-src     the Play! tree, patched (its own copy: not tools/play-net's)
#   local/play-web-build   the build
#   local/play-web-site    what the local server serves: Play.js, Play.wasm, the page,
#                          the patch file and the list of sections
# Run again after changing src/ or web/: it copies them in and rebuilds what changed.
# RTA_PLAY_SOURCE=<a Play! tree at the commit, untouched> makes the script copy that tree
# instead of cloning. -DPROFILE=ON in RTA_CMAKE_ARGS gives a build whose page can show
# the machine thread's time by zone (rta.zones()); -DRTA_WASM_EXCEPTIONS=ON (perf.patch's
# option, off unless asked for) compiles C++ exceptions as WebAssembly exceptions and
# needs an empty build directory.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
COMMIT=83700b2c31e593bc94e845b4b31b797be84dda59
SRC="${RTA_WEB_SOURCE:-$ROOT/local/play-web-src}"
BUILD="${RTA_WEB_BUILD:-$ROOT/local/play-web-build}"
SITE="${RTA_WEB_SITE:-$ROOT/local/play-web-site}"
JOBS="${RTA_BUILD_JOBS:-6}"

for tool in emcmake emcc cmake ninja patch; do
	command -v $tool >/dev/null 2>&1 || { echo "build.sh: $tool is not installed (brew install emscripten cmake ninja)" >&2; exit 1; }
done

if [ ! -f "$SRC/CMakeLists.txt" ]; then
	if [ -n "$RTA_PLAY_SOURCE" ]; then
		echo "build.sh: copying $RTA_PLAY_SOURCE to $SRC"
		mkdir -p "$SRC"
		rsync -a --exclude='.git' --exclude='node_modules' "$RTA_PLAY_SOURCE/" "$SRC/"
	else
		command -v git >/dev/null 2>&1 || { echo "build.sh: git is not installed" >&2; exit 1; }
		echo "build.sh: cloning Play! into $SRC"
		git clone --recurse-submodules https://github.com/jpd002/Play-.git "$SRC"
		git -C "$SRC" checkout --detach $COMMIT
		git -C "$SRC" submodule update --init --recursive
	fi
fi

# Each patch is applied once; a stamp file in the tree says that it is in.
apply() {
	name=$1
	file=$2
	stamp="$SRC/.rta-$name-applied"
	if [ -f "$stamp" ]; then
		if ! cmp -s "$stamp" "$file"; then
			echo "build.sh: $name.patch has changed since it was applied to $SRC." >&2
			echo "          Remove $SRC and run this script again." >&2
			exit 1
		fi
		return 0
	fi
	if (cd "$SRC" && patch -p1 -N --dry-run < "$file" >/dev/null 2>&1); then
		(cd "$SRC" && patch -p1 -N < "$file" >/dev/null)
		cp "$file" "$stamp"
		echo "build.sh: $name.patch applied"
	else
		echo "build.sh: $name.patch does not fit $SRC (not Play! at $COMMIT, or changed)." >&2
		exit 1
	fi
}
apply play-net "$HERE/../play-net/play-net.patch"
apply play-web "$HERE/play-web.patch"
apply perf "$HERE/perf.patch"
apply safari "$HERE/safari.patch"

# our sources: the front end, and for online play the desktop application's network and
# online driver as they are (only what has changed is copied, so that a second run
# compiles nothing again)
put() {
	cmp -s "$1" "$2" || cp "$1" "$2"
}
for f in RtaWeb.cpp RtaWebNet.cpp RtaWebNet.h RtaWebNetCore.cpp RtaWebSock.h; do
	put "$HERE/src/$f" "$SRC/Source/ui_js/$f"
done
for f in RtaNet.cpp RtaNet.h RtaOnline.cpp RtaOnline.h; do
	put "$HERE/../play-net/src/$f" "$SRC/Source/ui_js/$f"
done
put "$HERE/src/GlStateShadow.h" "$SRC/Source/gs/GSH_OpenGL/GlStateShadow.h"

if [ ! -f "$BUILD/build.ninja" ]; then
	mkdir -p "$BUILD"
	(cd "$BUILD" && emcmake cmake "$SRC" -G Ninja -DCMAKE_BUILD_TYPE=Release \
		-DBUILD_TESTS=OFF -DBUILD_PLAY=ON -DBUILD_PSFPLAYER=OFF -DUSE_QT=OFF $RTA_CMAKE_ARGS)
fi
cmake --build "$BUILD" --target Play -j "$JOBS"

mkdir -p "$SITE"
cp "$BUILD/Source/ui_js/Play.js" "$BUILD/Source/ui_js/Play.wasm" "$SITE/"
cp "$HERE/web/"* "$SITE/"
cp "$ROOT/patches/SLUS-20973_4028A55F.pnach" "$SITE/"
# the sections applied by default: the same list as the desktop application's
grep -v '^#' "$HERE/../play-net/sections-suggested.txt" > "$SITE/sections.txt"

# whose work this is: the licences of Play!, of the libraries it is built with and of the
# Emscripten runtime that is linked in
LICENCES="$SITE/licences"
mkdir -p "$LICENCES"
rm -f "$LICENCES"/*-*
cp "$SRC/License.txt" "$LICENCES/Play-LICENSE.txt"
for dir in "$SRC"/deps/* "$SRC"/deps/Dependencies/*; do
	[ -d "$dir" ] || continue
	case "$(basename "$dir")" in
	AltKit|SDWebImage|iCade-iOS|glew*|boost*) continue ;; # not part of this build
	esac
	for file in "$dir"/LICENSE* "$dir"/License* "$dir"/COPYING* "$dir"/LICENCE*; do
		[ -f "$file" ] || continue
		name="$(basename "$dir")-$(basename "$file")"
		cp "$file" "$LICENCES/${name%.txt}.txt"
	done
done
EMROOT=$(em-config EMSCRIPTEN_ROOT 2>/dev/null || true)
if [ -n "$EMROOT" ]; then
	# a Homebrew install keeps the licence one directory above the root
	for dir in "$EMROOT" "$EMROOT/.."; do
		[ -f "$dir/LICENSE" ] && cp "$dir/LICENSE" "$LICENCES/Emscripten-LICENSE.txt" && break
	done
	[ -f "$EMROOT/system/lib/mimalloc/LICENSE" ] && cp "$EMROOT/system/lib/mimalloc/LICENSE" "$LICENCES/mimalloc-LICENSE.txt"
fi
[ -f "$LICENCES/Emscripten-LICENSE.txt" ] || echo "build.sh: warning: Emscripten's licence was not found; the site's licences folder is incomplete" >&2
cat > "$LICENCES/README.txt" <<NOTE
This page runs the Play! PlayStation 2 emulator (https://github.com/jpd002/Play-), by
Jean-Philip Desjardins and contributors, under the BSD 2-clause licence
(Play-LICENSE.txt), compiled to WebAssembly with Emscripten, with changes by the
Champions RE project for playing Champions: Return to Arms. The changes are patches
and source files published in that project (tools/play-net/play-net.patch,
tools/play-web: play-web.patch, perf.patch, safari.patch, src/, web/); Play! was taken at commit
$COMMIT.

It is not an official product of the Play! project, of Sony Computer Entertainment, of
Sony Online Entertainment, of Snowblind Studios, of Daybreak Game Company or of anyone
else. It contains no PlayStation 2 BIOS and nothing of the game: the player supplies
their own disc image, which is read on their own computer and not uploaded.

The other files in this folder are the licences of the libraries Play! is built with
and of the Emscripten runtime (its C and C++ libraries and the mimalloc allocator) that
is part of Play.wasm and Play.js.
NOTE

echo "build.sh: built. Serve it with  tools/play-web/serve.py  and open http://127.0.0.1:8973/"
