# Castika StreamLevel

![Meters on Companion buttons: one meter spanning four buttons, and single buttons showing a normal level, clipping, the program mix, a muted source, a source with a filter switched on, a source with no reading, and buttons watching one side of the fader only](docs/meters.png)

Display OBS Studio audio levels directly on Bitfocus Companion buttons. One glance tells a broadcaster that program audio is alive, not clipping, unmuted, not faded down, and routed to the track the stream sends. The last three look perfectly healthy in the OBS mixer and reach nobody watching.

## Requirements

- OBS Studio 28 or later with its WebSocket server enabled. That server is obs-websocket 5, built into OBS from 28 onward, and it listens on port 4455 by default.
- Bitfocus Companion 5.

## Installation

1. Download `castika-streamlevel-<version>.tgz` from this repository's Releases page.
2. In Companion, open Modules, choose Import module package, and select that file.

Connection setup, placing a meter on a button and reading one are in `companion/HELP.md`, which Companion shows as the connection's own help. They are not repeated here.

## Building from source

Only a developer needs this. It requires yarn 4 and Node 22 or later:

    ./build.sh

The build runs outside the source folder so nothing is left behind in it, and brings back two files: the finished `.tgz` and an updated `yarn.lock`. The `.tgz` is a release asset and is not committed.

## Project structure

- `src/source.js`: the contract an audio source answers, with the edge cases that are easy to get wrong.
- `src/sources/obs.js`: the OBS adapter, holding the inputs, the routing, the filters, the stream's track and the mix.
- `src/sources/obswebsocket.js`: the transport under it, the obs-websocket 5 protocol and nothing more.
- `src/draw.js`: the picture, from the bars and the fader to the colors, the scales and the layout across buttons.
- `src/ballistics.js`: how a meter moves, with the OBS mixer's own constants.
- `src/group.js`: which buttons belong to one meter.
- `src/png.js`: a hand written PNG encoder, which keeps the module to a single dependency.
- `src/main.js`: the Companion wiring, from the settings and the feedback to the presets, the upgrade scripts and the repaint loop.
- `src/entry.mjs`: what Companion imports, and the one reason it is ES.
- `companion/manifest.json`: what Companion reads before any of it runs. Its `version` and its `runtime.apiVersion` are both overwritten as the package is built, so the version is raised in `package.json` alone.

Adding a second audio source means a new file under `src/sources/` rather than a change to the drawing. It is not free: the connection settings in `src/main.js` name OBS field by field, so a second source needs its own fields there too.

## What the module cannot know

OBS reports a level for every active input and publishes none for the final mix, because it has no master bus to meter. `PGM-MIX` is therefore an estimate rather than a reading: a root sum of squares over the inputs that feed the track the stream sends. Membership is exact, since the stream's track and each input's routing can both be read, and the values summed are past the fader and the mute. Only the arithmetic approximates, because adding signals that way assumes they are unrelated, and phase can carry a real peak about three decibels either way.

Where a request for an input's mute, fader or audio track fails, the module carries on with unmuted, unity gain, and the stream's own track, and nothing on the button says so.

## License and problems

MIT. See LICENSE. Open an issue on this repository to report a problem.
