#!/bin/bash
# Measures Folio against its performance budgets on macOS, using the `perf:`
# lines Folio writes to ~/Library/Logs/Folio/Folio.log.
#
#   scripts/measure-launch.sh [document.md] [other.md]
#
#   cold  Folio not running → `open -b` (what a Finder double-click does)
#         → the document's first render is on screen.      Budget: < 500 ms
#   warm  Folio running → open another document → rendered.  Budget: < 150 ms
#
# Tab switches and live reloads are logged by the app itself when it runs
# with FOLIO_PERF=1 (this script launches it that way); switch tabs or save
# the document a few times, then run `scripts/measure-launch.sh --report`.
#
# For clean cold runs set Settings ▸ General ▸ Restore windows to Never, so
# earlier windows aren't restored alongside the document.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE_ID=$(sed -n 's/.*"identifier": *"\([^"]*\)".*/\1/p' "$HERE/src-tauri/tauri.conf.json")
LOG="$HOME/Library/Logs/Folio/Folio.log"
RUNS=${RUNS:-5}
DOC=${1:-$HERE/e2e/fixtures/project/README.md}
OTHER=${2:-$HERE/e2e/fixtures/project/docs/guide.md}

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

median() { sort -n | awk '{ a[NR] = $1 } END { if (NR) print a[int((NR + 1) / 2)]; else print "n/a" }'; }

report() {
	[ -f "$LOG" ] || { echo "No log at $LOG"; exit 1; }
	for label in tab-switch reload-committed; do
		values=$(grep -o "perf: $label [0-9.]*ms" "$LOG" | tail -50 | sed -E 's/.* ([0-9.]+)ms/\1/')
		count=$(printf '%s\n' "$values" | grep -c . || true)
		printf '%-18s median %s ms over the last %s\n' "$label" "$(printf '%s\n' "$values" | median)" "$count"
	done
}

if [ "${1:-}" = "--report" ]; then
	report
	exit 0
fi

[ "$(uname)" = "Darwin" ] || { echo "measure-launch.sh runs on macOS."; exit 1; }
[ -f "$DOC" ] || { echo "No such document: $DOC"; exit 1; }
[ -n "$(mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" | head -1)" ] ||
	{ echo "Folio ($BUNDLE_ID) isn't installed."; exit 1; }

# Waits for the first log line after line $1 matching $2; prints its wall=.
wait_for() {
	local from=$1 pattern=$2 deadline=$(($(now_ms) + 10000))
	while [ "$(now_ms)" -lt "$deadline" ]; do
		local line
		line=$(tail -n +"$((from + 1))" "$LOG" 2>/dev/null | grep -m1 "$pattern" || true)
		if [ -n "$line" ]; then
			sed -E 's/.*wall=([0-9]+).*/\1/' <<<"$line"
			return 0
		fi
		sleep 0.01
	done
	echo "timeout"
	return 1
}

quit_folio() {
	osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
	while pgrep -x Folio >/dev/null; do sleep 0.05; done
	sleep 0.5
}

lines() { [ -f "$LOG" ] && wc -l <"$LOG" | tr -d ' ' || echo 0; }

cold=()
warm=()
for run in $(seq "$RUNS"); do
	quit_folio
	from=$(lines)
	start=$(now_ms)
	open -b "$BUNDLE_ID" --env FOLIO_PERF=1 "$DOC"
	shown=$(wait_for "$from" "perf: window-shown" || true)
	rendered=$(wait_for "$from" "perf: render-committed" || true)
	if [ "$shown" = timeout ] || [ "$rendered" = timeout ]; then
		echo "run $run: timed out"
		continue
	fi
	end=$((shown > rendered ? shown : rendered))
	cold+=($((end - start)))

	sleep 1
	from=$(lines)
	start=$(now_ms)
	open -b "$BUNDLE_ID" "$OTHER"
	rendered=$(wait_for "$from" "perf: render-committed" || true)
	[ "$rendered" = timeout ] || warm+=($((rendered - start)))
	# (bash 3.2, as shipped with macOS: no negative array indices)
	printf 'run %s: cold %s ms, warm %s ms\n' "$run" "${cold[${#cold[@]} - 1]}" "${warm[${#warm[@]} - 1]:-n/a}"
done

printf '\ncold  median %s ms   (budget < 500 ms)\n' "$(printf '%s\n' "${cold[@]}" | median)"
printf 'warm  median %s ms   (budget < 150 ms)\n' "$(printf '%s\n' "${warm[@]}" | median)"
echo
echo "Folio is still running with FOLIO_PERF=1: switch tabs and save the document,"
echo "then run: scripts/measure-launch.sh --report"
