# Castle changelog

## 2.3.1-1

The first beta of Castle 2.3.1: more ways to play online, and a safer, faster Castle Online.

### Play online
- **Instant updates:** moves, chat and challenges now arrive over a live connection the moment they happen, instead of on the next check a second or two later.
- **Ratings per category:** separate ratings for bullet, blitz, rapid, classical, correspondence and each variant, with a leaderboard for each. Your current rating starts each speed off.
- **Correspondence:** games with 1 to 14 days per move. Castle tells you when it's your move, the Play icon shows how many games are waiting, and the games follow you to any computer your rating is on.
- **Swiss tournaments:** a set number of rounds; everyone plays every round against someone on the same score, with a bye when the numbers are odd. A Daily Swiss runs every evening, or make your own.
- **Arena extras:** **Berserk** halves your clock for a bonus point when you win, each arena has its own chat, and the top three get a podium.
- **Castle TV:** the live game between the highest-rated players, moving on to the next when it ends. Spectators get an engine evaluation that runs three moves behind, so players can't use it.
- **Share games:** copy a link anyone can open in a browser, copy or save the PGN, or save the game as an animated GIF.

### Your rating
- **Move it to another computer** with a short code, or link it to your Lichess account and get it back any time by signing in to Lichess (Play → Online → Ratings & transfer).

### Safety
- **Block** any player: they can't challenge you, join your games or be paired with you, and their chat is hidden.
- **Report** rude chat, cheating, offensive names or stalling. A player reported by several people can't chat for a day.
- Offensive names and words are filtered, and you can turn off chat with opponents or hide the spectators' room.

### Training
- **Opening prep after each game:** Castle checks the game against your repertoire and tells you where you, or your opponent, left it, with a one-click way to practise the line or add the new position.
- **Variant reviews:** with Fairy-Stockfish installed, variant games are reviewed too.

### Puzzles
- **Checked scores:** ranked rush and puzzle battles are now checked move by move by the server, which picks the puzzles and keeps the solutions, so every score on the leaderboard is real. Offline practice rush is still there.

### Behind the scenes
- The server's end-to-end tests now live in the repository and run on every change; a failing test stops a release.

## 2.3.0

Castle 2.3: a much bigger Castle Online.

### Play online
- **Variants online:** Chess960, Crazyhouse, Atomic, King of the Hill, Three-check, Antichess, Horde and Racing Kings, in quick pairing, private games, challenges and arenas.
- **Pairing by rating:** quick pairing looks for someone within 150 points of you, widens the search every few seconds, and after a minute takes anyone.
- **Arenas:** an Hourly Blitz (3+2) on the hour and an Hourly Bullet (1+0) at half past, or make your own. You're paired again the moment a game ends. A win is worth 2, a draw 1, and points double after two wins in a row. Pause or leave whenever you like.
- **Friends and challenges:** add opponents as friends from a game or the leaderboard, see who's online, and challenge them with any time control and variant. Challenges pop up wherever you are in Castle.
- **Reconnecting and abandoned games:** Castle shows when your connection drops and picks the game back up. If your opponent disappears for 30 seconds, you can claim the win, or call it a draw.
- **Premoves:** make your move while your opponent thinks. It plays the moment it becomes legal. Right-click to cancel it.
- **Move confirmation** (optional): check each move before it's sent.
- **Spectators:** a chat room for everyone watching, plus 👏 🔥 😮 😂 ♟️ 💀 reactions that float up over the board.
- **Review after every game:** your accuracy, blunders and mistakes as soon as the game ends, and your mistakes become puzzles under Puzzles → My mistakes.

### Puzzles
- **Puzzle battles:** race another player through the same puzzles. Each solve scores a point, three misses and you're out.
- **Rush leaderboard:** your best rush runs go on an online leaderboard.

### Everything else
- Board letters now sit in the corner of their squares, just like the numbers.
- **What's new:** this window appears after each update, and you can open it again from Settings → Updates.

## 2.3.0-1

The first beta of Castle 2.3, with everything listed under 2.3.0.

## 2.2.1

- Castle Online moved to the Play page: pick **Online** next to Engine, Personality and Human here.
- Quick pairing: find an opponent for a time control, or wait in the queue.
- Beta builds: switch Settings → Updates to the Beta channel to try new features early.
- Clearer messages when Castle Online can't be reached, with a Try again button.

## 2.2.0

- Castle Online: play other Castle users as a guest, with no account. Moves go directly between players, with a server that checks them, runs the clocks and keeps your rating sealed.
- Wasabi 2.1 is bundled for macOS, Windows and Linux.
- Analysis: knight arrows drawn as an L, engine arrows fade from best to weakest line, several engines pool their lines, and you can set up a position by placing pieces on the board.
- Board coordinates sit inside the edge squares. C clears drawings. The FICS login can be kept in the keychain.
