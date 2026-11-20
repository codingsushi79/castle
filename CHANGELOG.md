# Castle changelog

## 2.4.0-1

The first beta of Castle 2.4: coaches, opponents that play at their real rating, and Sheet2PGN.

### Coaches
- **Five coaches** (Coaches, in the sidebar) each teach two openings: the Italian Game, Scandinavian, Ruy Lopez, Queen's Gambit, London System, Caro-Kann, Sicilian Najdorf, King's Indian, French and English.
- **Learn** a chapter move by move, with the coach playing the other side and explaining both sides' moves; then **drill** it from memory until it's mastered, and **add it to your repertoire** in one click.
- **Play it:** the coach plays the course's lines against you and tells you the moment you leave them.
- **Coaches talk you through the game:** they explain their own moves, warn you about their threats, tell you when a move of yours was a mistake and what was better, and give **hints** (first which piece, then the move). You choose how strongly they play.

### Personalities
- **Seventeen opponents**, from Bea (400) to Yara (2450) and Titan at full strength: new are Bea, Theo, Sana, Felix, Lucia, Kofi, Mei, Rafael and Yara.
- **Ratings you can trust:** each opponent's strength was measured in games against Stockfish at known ratings, instead of being guessed. Before, the weakest opponents played far above their rating (Pip, at 800, played like a 1320).
- With only the bundled Wasabi engine, opponents reach about 2240; install Stockfish (Engines page) for the strongest ones. Castle picks whichever installed engine can play each rating.
- **Each has a style:** attackers prefer checks and pawn storms, grinders trade into endgames, beginners grab whatever they can.
- **They talk during the game**, each in their own way: about the opening, your mistakes and good moves, their own slips, and who's winning. Turn it off, or have it read aloud.
- The engine's **Limit playing strength** slider uses the same measured ratings.

### Sheet2PGN
- **Print a scoresheet** (Sheet2PGN, in the sidebar) where each move has a box to write it in and circles to fill in: the piece, and the file and rank of the square it went to.
- **Scan or photograph it** and get the game back as PGN. Castle replays the moves and checks every one is legal; when a circle is unclear, the rest of the game usually says which move it was, and anything left in doubt is shown beside your handwriting to check.
- **Works on a phone too:** Sheet2PGN is in the web version, so you can photograph the sheet at the board.
- Names typed before printing come back when you scan.

### Analysis
- **Player names:** when a game's PGN names its players, they're shown above and below the board, with their ratings and the clock at each move.

### Castle Online
- **Chat with your opponent even when relayed:** when your apps can't connect directly, chat now goes through Castle's server, like the moves, with the same filter as room chat. Before, chat was off in relayed games.
- **Material count:** each player's strip shows how much material they're ahead (+3 and so on), as in games against the computer.

### Fixes
- **Printing a scoresheet** no longer prints the Share menu over it.
- **C clears drawings** again after you've clicked a tab or switch beside the board, and now works on every board, not just Analysis.

## 2.3.1

Castle 2.3.1: Castle Online in your browser, live play that's faster and fairer, and a lot more to do with other people.

### Castle Online in your browser
- **Play from any browser** at castle-online.vercel.app/play: quick pairing, friends, tournaments, Castle TV, ranked puzzles and studies, on a computer or a phone.
- **Phone alerts:** link your phone by scanning a QR code (Play → Online → Ratings & transfer → Phone alerts) and get a notification for correspondence moves and challenges, even when Castle is closed.

### Play online
- **Instant updates:** moves, chat and challenges arrive the moment they happen.
- **Ratings per category:** bullet, blitz, rapid, classical, correspondence and each variant, each with its own leaderboard.
- **Correspondence:** 1 to 14 days per move, with the games following you to any computer your rating is on.
- **Swiss tournaments** (including a Daily Swiss every evening), **arena extras** (berserk, arena chat, a podium), **team battles** and **simuls**.
- **Bots:** play Pip, Nora, Viktor, Amara, Dmitri or Ingrid any time, even in the browser. Bot games are never rated.
- **Castle TV:** the top live game, with channels for each speed and variant, and a small window that keeps playing while you use the rest of Castle.
- **Takebacks** in casual games, private **notes** on any game, and **sharing**: a link, the PGN or an animated GIF.
- **Teams** with their own page and chat, and **profiles** for every player, with a page you can share.

### Your rating
- **Move it to another computer** with a short code, or link it to your Lichess account.

### Learning
- **Studies:** analysis in chapters, kept online, to share or edit together.
- **Lessons** on checkmates, tactics and endgames (Puzzles → Learn), with worked examples and practice puzzles.
- **Puzzle storm:** three minutes on one clock, with its own leaderboard.
- **What you should have played** after each review, **your stats** by category and colour, **opening prep** after each game, and a **Castle Online explorer** in Analysis.

### Fairness and safety
- **Block** and **report** players, a word filter for names and chat, and a moderation page for the server's administrator.

### Updating and reliability
- **Updates download in the background** and install on **Restart to update**; you see what's in an update before installing it.
- **No more keychain prompts after updates**, and one Castle in the Dock after restarting.
- **Keep Castle in the menu bar** so move alerts and challenges arrive with the window closed.
- **Optional error reports**, and release notes that display properly.

## 2.3.1-3

The third beta of Castle 2.3.1.

### Castle Online in your browser
- **Play from any browser** at castle-online.vercel.app/play: quick pairing, friends, tournaments, Castle TV, ranked puzzles and studies, on a computer or a phone. Engines, your game library and training stay in the app.
- **Phone alerts:** link your phone (Play → Online → Ratings & transfer → Phone alerts) by scanning a QR code, and get a notification for correspondence moves and challenges even when Castle is closed.

### Play
- **Bots:** play Pip, Nora, Viktor, Amara, Dmitri or Ingrid any time, even when nobody else is online. They run on the server, so they work in the browser too. Bot games are never rated.
- **Simuls:** host a simultaneous exhibition and play everyone at once, or join one and take on the host.
- **Teams:** each team now has a page with members' ratings, its battle history and a private team chat.
- **Profiles:** click a player's name to see their ratings, trophies from arenas and Swiss tournaments, and recent games. Every profile also has a page you can share.

### Learning
- **Studies:** analysis in chapters, kept online. Share the view link so others can follow along, or the edit link to work on it together, with changes showing up as they're made.
- **Lessons:** short guided lessons on checkmates, tactics and endgames (Puzzles → Learn), each with worked examples and practice puzzles.
- **Castle Online explorer:** see what people play on Castle Online from any position (Analysis → Explorer → Castle Online).

### Reliability
- **Error reports (optional):** when something goes wrong, Castle can send the error so it can be fixed. You're asked once, and can change it in Settings.
- **Release notes display properly:** headings, lists, bold, links and code in update notes are now formatted instead of shown as raw text.

## 2.3.1-2

The second beta of Castle 2.3.1.

### Updating
- **Updates download in the background** and install when you click **Restart to update** (in the status bar or Settings), so restarting is quick. Castle also checks every few hours while it's open.
- **One Castle in the Dock:** after an update, Castle now restarts through macOS properly instead of leaving a second icon behind.
- **No more keychain prompts after updates:** your Lichess sign-in and saved FICS password are now kept in a way that survives updates. macOS may ask one last time.
- **What's in an update** is shown before you install it.
- If macOS is running Castle from a temporary copy (because it wasn't moved out of Downloads or the disk image), Castle says so: drag it to Applications to let it update.

### Play online
- **Takebacks** in casual games: ask, and your opponent can allow or refuse.
- **Notes** on any game you play: plans and ideas, saved as you type, visible only to you.
- **Teams and team battles:** make or join a team with a code, see who's online, and take on other teams in a team-battle arena where each team's best players' points count.
- **Castle TV channels:** bullet, blitz, rapid, classical and each variant, and TV keeps playing in a small window while you use the rest of Castle.
- **Keep Castle in the menu bar** (Settings → Updates) so move alerts and challenges arrive even with the window closed.

### Learning
- **What you should have played:** after the review, step through your mistakes on the board, with the better move in green and yours in red.
- **Your stats:** rating graphs for each category, how you score with White and Black, how your games end, and your most-played openings (Play → Online → Stats).

### Puzzles
- **Puzzle storm:** three minutes on one clock; misses cost ten seconds, runs of solves earn time. Checked by the server, with its own leaderboard.

### Fairness and safety
- Names like "Knights" were wrongly turned into "Guest" by the word filter; that's fixed.
- A moderation page lets the server's administrator see reports, spot players whose opponents' reviews show engine-like accuracy, and suspend accounts. Suspended players are told why and until when.

### Faster live updates
- Changes are now announced by the database itself, so moves and chat reach everyone even sooner, with less load on the server.

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
