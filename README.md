# Castle

A desktop chess app: play engines, personalities with measured ratings, coaches who teach openings and talk you through the game, and people on Lichess and FICS; analyse with several engines at once; train with puzzles, a spaced-repetition repertoire, endgames against the tablebase and calculation drills; and keep a fast, searchable game database.

Built with [Tauri](https://tauri.app) (Rust) and React. The board is [chessground](https://github.com/lichess-org/chessground) and the rules are [chessops](https://github.com/niklasf/chessops).

## Download

Get the latest version from [Releases](../../releases/latest). Castle checks for updates by itself (Settings, Updates). To try new features early, set the update channel there to Beta; beta builds are listed as pre-releases.

Castle comes with its own engine, Wasabi 2.1, and also uses any UCI engine you have installed: Stockfish, Leela Chess Zero, Fairy-Stockfish for variants, and others. The Engines page finds them and can install some with Homebrew.

## Personalities, coaches and Sheet2PGN

Personalities (400 to 2450, plus Titan at full strength) and coaches play through a strength model in `src/lib/strength.ts`: the engine searches several candidate moves and the opponent picks among them the way a player of that rating would. The rating each level plays at is measured, not guessed, by `scripts/calibrate-strength.mjs`, which plays the model against Stockfish limited to known ratings (and, below Stockfish's lowest, against levels already measured), separately for Stockfish and the bundled Wasabi.

Coaches teach the openings in `src/lib/courses.ts`, then play you in them; during games a second engine watches so opponents can comment on the moves (`src/lib/coach.ts`, `src/lib/voices.ts`).

Sheet2PGN (`src/lib/sheet`) prints a scoresheet with circles to fill in for each move (the piece, and the file and rank it moved to), then reads a scan or phone photo of it with plain image processing and replays the game, using legality to settle anything unclear.

## Castle Online

Play other Castle users from the Play page (opponent: Online) with no account: everyone is a guest. Quick pairing finds someone near your rating (kept per speed and per variant) in standard chess or any of eight variants, live or by correspondence; you can also play friends by code or challenge, join arenas and Swiss tournaments, race through checked puzzle battles, watch Castle TV with a spectator chat, and share games as links, PGN or GIFs. The same online play runs in a browser at https://castle-online.vercel.app/play (built with `npm run build:web` into `server/public/play`, which the server serves as static files). Moves go directly between the two players, and the small server in `server/` (Vercel, Postgres) checks them, keeps the clocks, stores games for watching, and seals each guest's rating so it can't be edited.

## Building

```
npm install
npm run tauri dev        # run from source
scripts/build-mac.sh     # release build on macOS
```

Releases are built for macOS, Windows and Linux by the workflow in `.github/workflows/build.yml` when a `v*` tag is pushed. A version with a numeric suffix (for example `2.3.0-1`) is published as a beta.

The Online server deploys from `server/` (the Vercel project's Root Directory is `server`) and sets up its own database tables on first use. Its tests run against an in-process Postgres: `cd server && npm test` for the server, `npm run test:client` for the app's online code against it, and `npm run test:app` for the app's own logic (personalities, courses, commentary, and Sheet2PGN on drawn photographs of a filled-in sheet). CI runs them on every push, and before every release. What changed in each version is in `CHANGELOG.md`, which Castle also shows after an update.

## Licence

GPL-3.0, as required by chessground and chessops. Puzzles come from the Lichess puzzle database (CC0). Piece sets come from the Lichess project and keep their own licences.
