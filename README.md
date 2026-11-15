# Castle

A desktop chess app: play engines, human-like opponents and people on Lichess and FICS; analyse with several engines at once; train with puzzles, a spaced-repetition repertoire, endgames against the tablebase and calculation drills; and keep a fast, searchable game database.

Built with [Tauri](https://tauri.app) (Rust) and React. The board is [chessground](https://github.com/lichess-org/chessground) and the rules are [chessops](https://github.com/niklasf/chessops).

## Download

Get the latest version from [Releases](../../releases/latest). Castle checks for updates by itself (Settings, Updates).

Castle uses any UCI engine you have installed: Stockfish, Leela Chess Zero, Fairy-Stockfish for variants, and others. The Engines page finds them and can install some with Homebrew.

## Building

```
npm install
npm run tauri dev        # run from source
scripts/build-mac.sh     # release build on macOS
```

Releases are built for macOS, Windows and Linux by the workflow in `.github/workflows/build.yml` when a `v*` tag is pushed.

## Licence

GPL-3.0, as required by chessground and chessops. Puzzles come from the Lichess puzzle database (CC0). Piece sets come from the Lichess project and keep their own licences.
