use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pgn_reader::{BufferedReader, RawHeader, SanPlus, Skip, Visitor};
use rusqlite::{params, params_from_iter, Connection, ToSql};
use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{CastlingMode, Chess, EnPassantMode, Piece, Position, Square};
use tauri::{AppHandle, Emitter, State};

/// The game library: one row per game, plus an index of every position reached so
/// the opening explorer and position search are instant.
pub struct Database {
    conn: Mutex<Connection>,
    path: PathBuf,
}

use rayon::prelude::*;

fn connect(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY, white TEXT, black TEXT, result TEXT, date TEXT, event TEXT, site TEXT,
            eco TEXT, opening TEXT, white_elo INTEGER, black_elo INTEGER, plies INTEGER, variant TEXT,
            folder TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', moves_hash INTEGER,
            dedupe TEXT, pgn TEXT, added INTEGER);
         CREATE TABLE IF NOT EXISTS positions (hash INTEGER, game_id INTEGER, next TEXT);
         CREATE INDEX IF NOT EXISTS pos_hash ON positions(hash);
         CREATE INDEX IF NOT EXISTS pos_game ON positions(game_id);
         CREATE INDEX IF NOT EXISTS games_dedupe ON games(dedupe);
         CREATE INDEX IF NOT EXISTS games_white ON games(white);
         CREATE INDEX IF NOT EXISTS games_black ON games(black);
         CREATE INDEX IF NOT EXISTS games_folder ON games(folder);",
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(conn)
}

impl Database {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Ok(Self { conn: Mutex::new(connect(path)?), path: path.to_path_buf() })
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// MARK: Reading PGN

struct GameReader {
    headers: HashMap<String, String>,
    pos: Option<Chess>,
    positions: Vec<(i64, String)>,
    plies: u32,
    moves_hash: u64,
    max_ply: u32,
}

impl GameReader {
    fn new(max_ply: u32) -> Self {
        Self { headers: HashMap::new(), pos: None, positions: Vec::new(), plies: 0, moves_hash: 0xcbf29ce484222325, max_ply }
    }
}

fn hash_of(pos: &Chess) -> i64 {
    pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64
}

fn start_position(headers: &HashMap<String, String>) -> Option<Chess> {
    let variant = headers.get("Variant").map(|v| v.to_lowercase()).unwrap_or_default();
    if !(variant.is_empty() || variant == "standard" || variant == "chess" || variant == "from position") {
        return None;
    }
    match headers.get("FEN") {
        Some(fen) => Fen::from_ascii(fen.as_bytes()).ok()?.into_position(CastlingMode::Standard).ok(),
        None => Some(Chess::default()),
    }
}

impl Visitor for GameReader {
    type Result = ();

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        self.headers.insert(String::from_utf8_lossy(key).into_owned(), value.decode_utf8_lossy().into_owned());
    }

    fn end_headers(&mut self) -> Skip {
        self.pos = start_position(&self.headers);
        Skip(false)
    }

    fn san(&mut self, san_plus: SanPlus) {
        self.plies += 1;
        let text = san_plus.san.to_string();
        for b in text.bytes() {
            self.moves_hash ^= b as u64;
            self.moves_hash = self.moves_hash.wrapping_mul(0x100000001b3);
        }
        if let Some(pos) = self.pos.as_mut() {
            let hash = hash_of(pos);
            match san_plus.san.to_move(pos) {
                Ok(m) => {
                    if self.plies <= self.max_ply {
                        self.positions.push((hash, text));
                    }
                    pos.play_unchecked(&m);
                }
                Err(_) => self.pos = None,
            }
        }
    }

    fn begin_variation(&mut self) -> Skip {
        Skip(true)
    }

    fn end_game(&mut self) {
        if let Some(pos) = &self.pos {
            if self.plies < self.max_ply {
                self.positions.push((hash_of(pos), String::new()));
            }
        }
    }
}

fn read_game(text: &str, max_ply: u32) -> GameReader {
    let mut reader = GameReader::new(max_ply);
    let mut pgn = BufferedReader::new_cursor(text.as_bytes());
    let _ = pgn.read_game(&mut reader);
    reader
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Stores one game. Returns its row id, or None when it was skipped.
fn insert_game(conn: &Connection, text: &str, folder: &str, dedupe: bool, max_ply: u32) -> rusqlite::Result<Option<i64>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let game = read_game(text, max_ply);
    if game.headers.is_empty() && game.plies == 0 {
        return Ok(None);
    }
    let h = |k: &str| game.headers.get(k).cloned().unwrap_or_default();
    let white = h("White");
    let black = h("Black");
    let stamp = [h("UTCTime"), h("EndTime"), h("Round")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
    let key = format!("{}|{}|{}|{}|{}|{:x}", white, black, h("Date"), stamp, h("Result"), game.moves_hash);
    if dedupe {
        let exists: bool = conn.prepare_cached("SELECT 1 FROM games WHERE dedupe = ? LIMIT 1")?.exists(params![key])?;
        if exists {
            return Ok(None);
        }
    }
    let site = if h("Site").is_empty() { h("Link") } else { h("Site") };
    let result = if h("Result").is_empty() { "*".to_string() } else { h("Result") };
    conn.prepare_cached(
        "INSERT INTO games (white, black, result, date, event, site, eco, opening, white_elo, black_elo, plies, variant,
                            folder, moves_hash, dedupe, pgn, added)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )?
    .execute(params![
        white,
        black,
        result,
        h("Date"),
        h("Event"),
        site,
        h("ECO"),
        h("Opening"),
        h("WhiteElo").parse::<i64>().ok(),
        h("BlackElo").parse::<i64>().ok(),
        game.plies,
        h("Variant"),
        folder,
        game.moves_hash as i64,
        key,
        text,
        now()
    ])?;
    let id = conn.last_insert_rowid();
    let mut stmt = conn.prepare_cached("INSERT INTO positions (hash, game_id, next) VALUES (?,?,?)")?;
    for (hash, next) in &game.positions {
        stmt.execute(params![hash, id, next])?;
    }
    Ok(Some(id))
}

/// Reads games one at a time from a stream, so files of any size can be imported.
fn import_stream<R: BufRead>(
    conn: &mut Connection,
    mut reader: R,
    folder: &str,
    dedupe: bool,
    max_ply: u32,
    mut progress: impl FnMut(usize),
) -> Result<(usize, usize, Option<i64>), String> {
    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut first: Option<i64> = None;
    let mut current = String::new();
    let mut saw_moves = false;
    let mut line = Vec::new();
    let mut tx = conn.transaction().map_err(err)?;
    let mut in_batch = 0;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).map_err(err)?;
        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        let is_tag = trimmed.starts_with('[') && trimmed.ends_with(']');
        if n == 0 || (is_tag && saw_moves) {
            if !current.trim().is_empty() {
                match insert_game(&tx, &current, folder, dedupe, max_ply).map_err(err)? {
                    Some(id) => {
                        added += 1;
                        first.get_or_insert(id);
                    }
                    None => skipped += 1,
                }
                in_batch += 1;
                if in_batch >= 2000 {
                    tx.commit().map_err(err)?;
                    tx = conn.transaction().map_err(err)?;
                    in_batch = 0;
                    progress(added + skipped);
                }
            }
            current.clear();
            saw_moves = false;
        }
        if n == 0 {
            break;
        }
        if !is_tag && !trimmed.is_empty() && !trimmed.starts_with('%') {
            saw_moves = true;
        }
        current.push_str(&text);
    }
    tx.commit().map_err(err)?;
    Ok((added, skipped, first))
}

#[derive(Clone, Serialize)]
struct ImportProgress {
    count: usize,
    added: usize,
    skipped: usize,
    done: bool,
    error: Option<String>,
}

/// Imports a .pgn or .pgn.zst file in the background, reporting `import-progress` events.
#[tauri::command]
pub fn db_import(app: AppHandle, db: State<Database>, path: String, folder: String, dedupe: bool, max_ply: u32) {
    let db_path = db.path.clone();
    std::thread::spawn(move || {
        let run = || -> Result<(usize, usize), String> {
            let mut conn = connect(&db_path).map_err(err)?;
            let file = std::fs::File::open(&path).map_err(err)?;
            let progress = |count: usize| {
                let _ = app.emit("import-progress", ImportProgress { count, added: 0, skipped: 0, done: false, error: None });
            };
            let (added, skipped, _) = if path.ends_with(".zst") {
                let decoder = zstd::stream::read::Decoder::new(file).map_err(err)?;
                import_stream(&mut conn, BufReader::with_capacity(1 << 20, decoder), &folder, dedupe, max_ply, progress)?
            } else {
                import_stream(&mut conn, BufReader::with_capacity(1 << 20, file), &folder, dedupe, max_ply, progress)?
            };
            Ok((added, skipped))
        };
        let event = match run() {
            Ok((added, skipped)) => ImportProgress { count: added + skipped, added, skipped, done: true, error: None },
            Err(e) => ImportProgress { count: 0, added: 0, skipped: 0, done: true, error: Some(e) },
        };
        let _ = app.emit("import-progress", event);
    });
}

#[derive(Serialize)]
pub struct Imported {
    added: usize,
    skipped: usize,
    first: Option<i64>,
}

#[tauri::command]
pub fn db_import_text(db: State<Database>, text: String, folder: String, dedupe: bool) -> Result<Imported, String> {
    let mut conn = db.conn.lock().map_err(err)?;
    let (added, skipped, first) = import_stream(&mut conn, text.as_bytes(), &folder, dedupe, 600, |_| {})?;
    Ok(Imported { added, skipped, first })
}

// MARK: Queries

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct Filter {
    text: Option<String>,
    player: Option<String>,
    color: Option<String>,
    result: Option<String>,
    folder: Option<String>,
    tag: Option<String>,
    eco: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    fen: Option<String>,
    event: Option<String>,
    ids: Option<Vec<i64>>,
    sort: Option<String>,
    desc: bool,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
pub struct Row {
    id: i64,
    white: String,
    black: String,
    result: String,
    date: String,
    event: String,
    eco: String,
    opening: String,
    white_elo: Option<i64>,
    black_elo: Option<i64>,
    plies: i64,
    folder: String,
    tags: Vec<String>,
    variant: String,
}

#[derive(Serialize)]
pub struct QueryResult {
    total: i64,
    rows: Vec<Row>,
}

fn fen_hash(fen: &str) -> Option<i64> {
    let pos: Chess = Fen::from_ascii(fen.as_bytes()).ok()?.into_position(CastlingMode::Standard).ok()?;
    Some(hash_of(&pos))
}

fn split_tags(tags: &str) -> Vec<String> {
    tags.split('|').filter(|t| !t.is_empty()).map(String::from).collect()
}

fn build_where(f: &Filter) -> (String, Vec<Box<dyn ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    let some = |s: &Option<String>| s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(t) = some(&f.text) {
        clauses.push("(white LIKE ?1 OR black LIKE ?1 OR event LIKE ?1 OR opening LIKE ?1 OR eco LIKE ?1 OR tags LIKE ?1 OR date LIKE ?1)".replace("?1", &format!("?{}", args.len() + 1)));
        args.push(Box::new(format!("%{}%", t)));
    }
    if let Some(p) = some(&f.player) {
        let n = args.len() + 1;
        let (as_white, as_black) = (format!("white = ?{} COLLATE NOCASE", n), format!("black = ?{} COLLATE NOCASE", n));
        let color = f.color.as_deref().unwrap_or("");
        let result = f.result.as_deref().unwrap_or("");
        let side = |white: bool| -> String {
            let who = if white { &as_white } else { &as_black };
            match result {
                "win" => format!("({} AND result = '{}')", who, if white { "1-0" } else { "0-1" }),
                "loss" => format!("({} AND result = '{}')", who, if white { "0-1" } else { "1-0" }),
                "draw" => format!("({} AND result = '1/2-1/2')", who),
                _ => format!("({})", who),
            }
        };
        clauses.push(match color {
            "white" => side(true),
            "black" => side(false),
            _ => format!("({} OR {})", side(true), side(false)),
        });
        args.push(Box::new(p));
    } else if let Some(r) = some(&f.result) {
        if ["1-0", "0-1", "1/2-1/2", "*"].contains(&r.as_str()) {
            clauses.push(format!("result = ?{}", args.len() + 1));
            args.push(Box::new(r));
        }
    }
    if let Some(folder) = &f.folder {
        clauses.push(format!("folder = ?{}", args.len() + 1));
        args.push(Box::new(folder.clone()));
    }
    if let Some(tag) = some(&f.tag) {
        clauses.push(format!("tags LIKE ?{}", args.len() + 1));
        args.push(Box::new(format!("%|{}|%", tag)));
    }
    if let Some(eco) = some(&f.eco) {
        clauses.push(format!("(eco LIKE ?{0} OR opening LIKE ?{1})", args.len() + 1, args.len() + 2));
        args.push(Box::new(format!("{}%", eco)));
        args.push(Box::new(format!("%{}%", eco)));
    }
    if let Some(d) = some(&f.date_from) {
        clauses.push(format!("date >= ?{}", args.len() + 1));
        args.push(Box::new(d));
    }
    if let Some(d) = some(&f.date_to) {
        clauses.push(format!("date <= ?{}", args.len() + 1));
        args.push(Box::new(format!("{}~", d)));
    }
    if let Some(fen) = some(&f.fen) {
        clauses.push(format!("id IN (SELECT game_id FROM positions WHERE hash = ?{})", args.len() + 1));
        args.push(Box::new(fen_hash(&fen).unwrap_or(0)));
    }
    if let Some(ev) = &f.event {
        clauses.push(format!("event = ?{}", args.len() + 1));
        args.push(Box::new(ev.clone()));
    }
    if let Some(ids) = &f.ids {
        let list: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
        clauses.push(format!("id IN ({})", if list.is_empty() { "-1".to_string() } else { list.join(",") }));
    }
    let sql = if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) };
    (sql, args)
}

#[tauri::command]
pub fn db_query(db: State<Database>, filter: Filter) -> Result<QueryResult, String> {
    let conn = db.conn.lock().map_err(err)?;
    let (where_sql, args) = build_where(&filter);
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM games{}", where_sql), params_from_iter(args.iter().map(|a| a.as_ref())), |r| r.get(0))
        .map_err(err)?;
    let sort = match filter.sort.as_deref() {
        Some("white") => "white COLLATE NOCASE",
        Some("black") => "black COLLATE NOCASE",
        Some("result") => "result",
        Some("event") => "event COLLATE NOCASE",
        Some("eco") => "eco",
        Some("plies") => "plies",
        Some("date") => "date",
        _ => "id",
    };
    let sql = format!(
        "SELECT id, white, black, result, date, event, eco, opening, white_elo, black_elo, plies, folder, tags, variant
         FROM games{} ORDER BY {} {}, id DESC LIMIT {} OFFSET {}",
        where_sql,
        sort,
        if filter.desc { "DESC" } else { "ASC" },
        filter.limit.unwrap_or(500).clamp(1, 100_000),
        filter.offset.unwrap_or(0).max(0)
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter().map(|a| a.as_ref())), |r| {
            Ok(Row {
                id: r.get(0)?,
                white: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                black: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                result: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                date: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                event: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                eco: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                opening: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                white_elo: r.get(8)?,
                black_elo: r.get(9)?,
                plies: r.get::<_, Option<i64>>(10)?.unwrap_or(0),
                folder: r.get(11)?,
                tags: split_tags(&r.get::<_, String>(12)?),
                variant: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
            })
        })
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(QueryResult { total, rows })
}

#[tauri::command]
pub fn db_count(db: State<Database>) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(err)?;
    conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0)).map_err(err)
}

#[tauri::command]
pub fn db_get(db: State<Database>, id: i64) -> Result<String, String> {
    let conn = db.conn.lock().map_err(err)?;
    conn.query_row("SELECT pgn FROM games WHERE id = ?", params![id], |r| r.get(0)).map_err(err)
}

fn id_list(ids: &[i64]) -> String {
    ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
}

#[tauri::command]
pub fn db_delete(db: State<Database>, ids: Vec<i64>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(err)?;
    for chunk in ids.chunks(500) {
        let list = id_list(chunk);
        conn.execute_batch(&format!("DELETE FROM positions WHERE game_id IN ({0}); DELETE FROM games WHERE id IN ({0});", list))
            .map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ExplorerMove {
    san: String,
    white: i64,
    draws: i64,
    black: i64,
}

/// How games in the library continued from a position, optionally only the games
/// of one player with one colour.
#[tauri::command]
pub fn db_explorer(db: State<Database>, fen: String, player: Option<String>, color: Option<String>) -> Result<Vec<ExplorerMove>, String> {
    let Some(hash) = fen_hash(&fen) else { return Ok(Vec::new()) };
    let conn = db.conn.lock().map_err(err)?;
    let mut sql = "SELECT p.next, g.result, COUNT(*) FROM positions p JOIN games g ON g.id = p.game_id WHERE p.hash = ?1 AND p.next != ''".to_string();
    let name = player.unwrap_or_default();
    if !name.is_empty() {
        sql += match color.as_deref() {
            Some("white") => " AND g.white = ?2 COLLATE NOCASE",
            Some("black") => " AND g.black = ?2 COLLATE NOCASE",
            _ => " AND (g.white = ?2 COLLATE NOCASE OR g.black = ?2 COLLATE NOCASE)",
        };
    } else {
        sql += " AND ?2 = ''";
    }
    sql += " GROUP BY p.next, g.result";
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut moves: HashMap<String, ExplorerMove> = HashMap::new();
    let rows = stmt
        .query_map(params![hash, name], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, i64>(2)?)))
        .map_err(err)?;
    for row in rows.flatten() {
        let (san, result, n) = row;
        let entry = moves.entry(san.clone()).or_insert(ExplorerMove { san, white: 0, draws: 0, black: 0 });
        match result.as_str() {
            "1-0" => entry.white += n,
            "0-1" => entry.black += n,
            _ => entry.draws += n,
        }
    }
    let mut list: Vec<ExplorerMove> = moves.into_values().collect();
    list.sort_by(|a, b| (b.white + b.draws + b.black).cmp(&(a.white + a.draws + a.black)).then(a.san.cmp(&b.san)));
    Ok(list)
}

/// What a scan looks for in every position of every game.
enum Want {
    /// These pieces on these squares (other squares unconstrained).
    Pieces(Vec<(Square, Piece)>),
    /// Exactly this pawn placement for both sides.
    Pawns(u64, u64),
    /// Exactly these piece counts.
    Material([u8; 12]),
}

fn material_of(pos: &Chess) -> [u8; 12] {
    let mut m = [0u8; 12];
    for (_, piece) in pos.board().clone() {
        let i = piece.role as usize - 1 + if piece.color.is_white() { 0 } else { 6 };
        m[i] += 1;
    }
    m
}

fn matches(pos: &Chess, want: &Want) -> bool {
    match want {
        Want::Pieces(list) => list.iter().all(|(sq, p)| pos.board().piece_at(*sq) == Some(*p)),
        Want::Pawns(w, b) => {
            let pawns = pos.board().pawns();
            u64::from(pawns & pos.board().white()) == *w && u64::from(pawns & pos.board().black()) == *b
        }
        Want::Material(m) => material_of(pos) == *m,
    }
}

struct ScanReader<'a> {
    want: &'a Want,
    pos: Option<Chess>,
    found: bool,
    skip_first: u32,
    ply: u32,
}

impl ScanReader<'_> {
    fn check(&mut self) {
        if self.ply < self.skip_first {
            return;
        }
        if let Some(pos) = &self.pos {
            if matches(pos, self.want) {
                self.found = true;
            }
        }
    }
}

impl Visitor for ScanReader<'_> {
    type Result = ();

    fn begin_game(&mut self) {
        self.pos = Some(Chess::default());
        self.ply = 0;
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        if key == b"FEN" {
            self.pos = Fen::from_ascii(value.as_bytes()).ok().and_then(|f| f.into_position(CastlingMode::Standard).ok());
        }
    }

    fn end_headers(&mut self) -> Skip {
        self.check();
        Skip(self.found || self.pos.is_none())
    }

    fn san(&mut self, san_plus: SanPlus) {
        if self.found {
            return;
        }
        if let Some(pos) = self.pos.as_mut() {
            match san_plus.san.to_move(pos) {
                Ok(m) => pos.play_unchecked(&m),
                Err(_) => {
                    self.pos = None;
                    return;
                }
            }
        }
        self.ply += 1;
        self.check();
    }

    fn begin_variation(&mut self) -> Skip {
        Skip(true)
    }

    fn end_game(&mut self) {}
}

/// Replays every standard game on all cores and returns those that ever match.
fn scan(db: &Database, want: &Want, limit: usize, skip_first: u32, exclude: Option<i64>) -> Result<Vec<i64>, String> {
    let games: Vec<(i64, String)> = {
        let conn = db.conn.lock().map_err(err)?;
        let mut stmt = conn
            .prepare("SELECT id, pgn FROM games WHERE variant = '' OR variant IS NULL OR variant = 'Standard' ORDER BY id DESC")
            .map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.filter_map(|r| r.ok()).collect();
        rows
    };
    let mut hits: Vec<i64> = games
        .par_iter()
        .filter(|(id, _)| Some(*id) != exclude)
        .filter(|(_, pgn)| {
            let mut reader = ScanReader { want, pos: None, found: false, skip_first, ply: 0 };
            let _ = BufferedReader::new_cursor(pgn.as_bytes()).read_game(&mut reader);
            reader.found
        })
        .map(|(id, _)| *id)
        .collect();
    hits.sort_unstable_by(|a, b| b.cmp(a));
    hits.truncate(limit);
    Ok(hits)
}

/// Finds games in which every piece of the pattern stood on its square at the same
/// time. The pattern is 64 characters from a1 to h8, '.' for "anything".
#[tauri::command(async)]
pub fn db_pattern(db: State<Database>, pattern: String, limit: usize) -> Result<Vec<i64>, String> {
    let wanted: Vec<(Square, Piece)> = pattern
        .chars()
        .enumerate()
        .filter_map(|(i, c)| Piece::from_char(c).map(|p| (Square::new(i as u32), p)))
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    scan(&db, &Want::Pieces(wanted), limit, 0, None)
}

/// Games that reach the same pawn structure, or the same material, as a position.
#[tauri::command(async)]
pub fn db_similar(db: State<Database>, fen: String, mode: String, limit: usize, exclude: Option<i64>) -> Result<Vec<i64>, String> {
    let pos: Chess = Fen::from_ascii(fen.as_bytes()).map_err(err)?.into_position(CastlingMode::Standard).map_err(err)?;
    let want = if mode == "material" {
        Want::Material(material_of(&pos))
    } else {
        let pawns = pos.board().pawns();
        Want::Pawns(u64::from(pawns & pos.board().white()), u64::from(pawns & pos.board().black()))
    };
    // Ignore the first moves, where every game shares the starting structure.
    scan(&db, &want, limit, 10, exclude)
}

#[tauri::command]
pub fn db_players(db: State<Database>) -> Result<Vec<(String, i64)>, String> {
    let conn = db.conn.lock().map_err(err)?;
    let mut stmt = conn
        .prepare(
            "SELECT name, COUNT(*) c FROM (SELECT white AS name FROM games UNION ALL SELECT black FROM games)
             WHERE name != '' AND name != '?' GROUP BY name ORDER BY c DESC, name LIMIT 500",
        )
        .map_err(err)?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[derive(Default, Serialize, Clone)]
pub struct Record {
    games: i64,
    wins: i64,
    draws: i64,
    losses: i64,
}

#[derive(Serialize)]
pub struct OpeningRecord {
    name: String,
    color: String,
    record: Record,
}

#[derive(Serialize)]
pub struct PlayerStats {
    white: Record,
    black: Record,
    openings: Vec<OpeningRecord>,
}

#[tauri::command]
pub fn db_player_stats(db: State<Database>, name: String) -> Result<PlayerStats, String> {
    let conn = db.conn.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT white, result, opening, eco FROM games WHERE white = ?1 COLLATE NOCASE OR black = ?1 COLLATE NOCASE")
        .map_err(err)?;
    let mut white = Record::default();
    let mut black = Record::default();
    let mut openings: HashMap<(String, bool), Record> = HashMap::new();
    let rows = stmt
        .query_map(params![name], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })
        .map_err(err)?;
    for (w, result, opening, eco) in rows.flatten() {
        let is_white = w.eq_ignore_ascii_case(&name);
        let won = (result == "1-0" && is_white) || (result == "0-1" && !is_white);
        let drawn = result == "1/2-1/2";
        let lost = !won && !drawn && result != "*";
        let bump = |r: &mut Record| {
            r.games += 1;
            r.wins += won as i64;
            r.draws += drawn as i64;
            r.losses += lost as i64;
        };
        bump(if is_white { &mut white } else { &mut black });
        let label = if !opening.is_empty() { opening.split(':').next().unwrap_or("").trim().to_string() } else if !eco.is_empty() { eco } else { "Unknown".into() };
        bump(openings.entry((label, is_white)).or_default());
    }
    let mut list: Vec<OpeningRecord> = openings
        .into_iter()
        .map(|((name, is_white), record)| OpeningRecord { name, color: if is_white { "white".into() } else { "black".into() }, record })
        .collect();
    list.sort_by(|a, b| b.record.games.cmp(&a.record.games).then(a.name.cmp(&b.name)));
    Ok(PlayerStats { white, black, openings: list })
}

#[derive(Serialize)]
pub struct Shelves {
    folders: Vec<(String, i64)>,
    tags: Vec<(String, i64)>,
}

#[tauri::command]
pub fn db_folders(db: State<Database>) -> Result<Shelves, String> {
    let conn = db.conn.lock().map_err(err)?;
    let mut stmt = conn.prepare("SELECT folder, COUNT(*) FROM games GROUP BY folder ORDER BY folder").map_err(err)?;
    let folders = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.filter_map(|r| r.ok()).collect();
    let mut stmt = conn.prepare("SELECT tags, COUNT(*) FROM games WHERE tags != '' GROUP BY tags").map_err(err)?;
    let mut counts: HashMap<String, i64> = HashMap::new();
    for (tags, n) in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(err)?.flatten() {
        for tag in split_tags(&tags) {
            *counts.entry(tag).or_default() += n;
        }
    }
    let mut tags: Vec<(String, i64)> = counts.into_iter().collect();
    tags.sort();
    Ok(Shelves { folders, tags })
}

#[tauri::command]
pub fn db_set_folder(db: State<Database>, ids: Vec<i64>, folder: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(err)?;
    for chunk in ids.chunks(500) {
        conn.execute(&format!("UPDATE games SET folder = ? WHERE id IN ({})", id_list(chunk)), params![folder]).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn db_set_tags(db: State<Database>, ids: Vec<i64>, add: Vec<String>, remove: Vec<String>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(err)?;
    for id in ids {
        let current: String = conn.query_row("SELECT tags FROM games WHERE id = ?", params![id], |r| r.get(0)).map_err(err)?;
        let mut tags = split_tags(&current);
        tags.retain(|t| !remove.contains(t));
        for t in &add {
            let t = t.trim().replace('|', "");
            if !t.is_empty() && !tags.contains(&t) {
                tags.push(t);
            }
        }
        let joined = if tags.is_empty() { String::new() } else { format!("|{}|", tags.join("|")) };
        conn.execute("UPDATE games SET tags = ? WHERE id = ?", params![joined, id]).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct DuplicateGroup {
    white: String,
    black: String,
    date: String,
    ids: Vec<i64>,
}

fn duplicate_groups(conn: &Connection) -> Result<Vec<DuplicateGroup>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT white, black, MIN(date), GROUP_CONCAT(id) FROM games WHERE plies > 0
             GROUP BY white, black, moves_hash HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 5000",
        )
        .map_err(err)?;
    let groups = stmt
        .query_map([], |r| {
            Ok(DuplicateGroup {
                white: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                black: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                date: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ids: r.get::<_, String>(3)?.split(',').filter_map(|s| s.parse().ok()).collect(),
            })
        })
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(groups)
}

#[tauri::command]
pub fn db_duplicates(db: State<Database>) -> Result<Vec<DuplicateGroup>, String> {
    let conn = db.conn.lock().map_err(err)?;
    duplicate_groups(&conn)
}

/// Keeps the most complete copy of each duplicated game, moves every tag onto it
/// and deletes the rest. Returns how many games were removed.
#[tauri::command]
pub fn db_merge_duplicates(db: State<Database>) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(err)?;
    let mut removed = 0;
    for group in duplicate_groups(&conn)? {
        let mut copies: Vec<(i64, i64, String, String)> = Vec::new();
        for id in &group.ids {
            if let Ok(row) = conn.query_row("SELECT id, LENGTH(pgn), tags, folder FROM games WHERE id = ?", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            }) {
                copies.push(row);
            }
        }
        copies.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let Some(keep) = copies.first().cloned() else { continue };
        let mut tags: Vec<String> = Vec::new();
        let mut folder = keep.3.clone();
        for c in &copies {
            for t in split_tags(&c.2) {
                if !tags.contains(&t) {
                    tags.push(t);
                }
            }
            if folder.is_empty() {
                folder = c.3.clone();
            }
        }
        let joined = if tags.is_empty() { String::new() } else { format!("|{}|", tags.join("|")) };
        conn.execute("UPDATE games SET tags = ?, folder = ? WHERE id = ?", params![joined, folder, keep.0]).map_err(err)?;
        let drop: Vec<i64> = copies.iter().skip(1).map(|c| c.0).collect();
        let list = id_list(&drop);
        conn.execute_batch(&format!("DELETE FROM positions WHERE game_id IN ({0}); DELETE FROM games WHERE id IN ({0});", list)).map_err(err)?;
        removed += drop.len();
    }
    Ok(removed)
}

#[tauri::command]
pub fn db_export(db: State<Database>, filter: Filter, path: String) -> Result<usize, String> {
    use std::io::Write;
    let conn = db.conn.lock().map_err(err)?;
    let (where_sql, args) = build_where(&filter);
    let mut stmt = conn.prepare(&format!("SELECT pgn FROM games{} ORDER BY id", where_sql)).map_err(err)?;
    let mut rows = stmt.query(params_from_iter(args.iter().map(|a| a.as_ref()))).map_err(err)?;
    let mut out = std::io::BufWriter::new(std::fs::File::create(&path).map_err(err)?);
    let mut count = 0;
    while let Some(row) = rows.next().map_err(err)? {
        let pgn: String = row.get(0).map_err(err)?;
        writeln!(out, "{}\n", pgn.trim()).map_err(err)?;
        count += 1;
    }
    Ok(count)
}

#[tauri::command]
pub fn db_update_pgn(db: State<Database>, id: i64, pgn: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(err)?;
    conn.execute("UPDATE games SET pgn = ? WHERE id = ?", params![pgn, id]).map_err(err)?;
    Ok(())
}

#[derive(Serialize)]
pub struct EventRow {
    event: String,
    site: String,
    first: String,
    last: String,
    games: i64,
    players: i64,
}

#[tauri::command]
pub fn db_events(db: State<Database>, text: Option<String>) -> Result<Vec<EventRow>, String> {
    let conn = db.conn.lock().map_err(err)?;
    events_query(&conn, text)
}

fn events_query(conn: &Connection, text: Option<String>) -> Result<Vec<EventRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT event, MAX(site), MIN(date), MAX(date), COUNT(*),
                    (SELECT COUNT(*) FROM (SELECT white AS p FROM games g2 WHERE g2.event = g.event UNION SELECT black FROM games g3 WHERE g3.event = g.event))
             FROM games g WHERE event != '' AND event LIKE ?1 GROUP BY event ORDER BY MAX(date) DESC, COUNT(*) DESC LIMIT 400",
        )
        .map_err(err)?;
    let pattern = format!("%{}%", text.unwrap_or_default());
    let rows = stmt
        .query_map(params![pattern], |r| {
            Ok(EventRow {
                event: r.get(0)?,
                site: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                first: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                last: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                games: r.get(4)?,
                players: r.get(5)?,
            })
        })
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Writes the whole library plus the app's saved state into one SQLite file.
#[tauri::command(async)]
pub fn db_backup(db: State<Database>, path: String, state: String) -> Result<(), String> {
    let _ = std::fs::remove_file(&path);
    {
        let conn = db.conn.lock().map_err(err)?;
        conn.execute("VACUUM INTO ?", params![path]).map_err(err)?;
    }
    let out = Connection::open(&path).map_err(err)?;
    out.execute_batch("CREATE TABLE castle_backup (version INTEGER, created INTEGER, state TEXT);").map_err(err)?;
    out.execute("INSERT INTO castle_backup VALUES (1, ?, ?)", params![now(), state]).map_err(err)?;
    Ok(())
}

/// Replaces the library with a backup and returns the saved state stored in it.
#[tauri::command(async)]
pub fn db_restore(db: State<Database>, path: String) -> Result<String, String> {
    let state: String = {
        let src = Connection::open(&path).map_err(err)?;
        src.query_row("SELECT state FROM castle_backup ORDER BY created DESC LIMIT 1", [], |r| r.get(0))
            .map_err(|_| "That file is not a Castle backup.".to_string())?
    };
    let mut conn = db.conn.lock().map_err(err)?;
    // Let go of the open database before overwriting it.
    *conn = Connection::open_in_memory().map_err(err)?;
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", db.path.display(), suffix));
    }
    std::fs::copy(&path, &db.path).map_err(err)?;
    let fresh = connect(&db.path).map_err(err)?;
    fresh.execute_batch("DROP TABLE IF EXISTS castle_backup;").map_err(err)?;
    *conn = fresh;
    Ok(state)
}

/// Gives disk space back after many games were deleted.
#[tauri::command(async)]
pub fn db_compact(db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(err)?;
    conn.execute_batch("VACUUM;").map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAMES: &str = r#"[Event "Club Championship"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]
[WhiteElo "1800"]
[BlackElo "1700"]
[Date "2026.01.01"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0

[Event "Club Championship"]
[White "Bob"]
[Black "Carol"]
[Result "1/2-1/2"]
[Date "2026.01.02"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Bb7 10. d4 Re8 1/2-1/2

[Event "Casual"]
[White "Dave"]
[Black "Alice"]
[Result "0-1"]
[Date "2026.02.01"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. cxd5 Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 0-1
"#;

    fn fresh(name: &str) -> (Database, PathBuf) {
        let path = std::env::temp_dir().join(format!("castle-test-{}-{}.sqlite", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Database::open(&path).unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            import_stream(&mut conn, GAMES.as_bytes(), "", true, 600, |_| {}).unwrap();
        }
        (db, path)
    }

    fn count(db: &Database) -> i64 {
        db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn imports_and_dedupes() {
        let (db, _) = fresh("import");
        assert_eq!(count(&db), 3);
        let mut conn = db.conn.lock().unwrap();
        let (added, skipped, _) = import_stream(&mut conn, GAMES.as_bytes(), "", true, 600, |_| {}).unwrap();
        assert_eq!((added, skipped), (0, 3));
    }

    #[test]
    fn similar_pawn_structure_and_material() {
        let (db, _) = fresh("similar");
        // Position after 10. d4 in the first game: the second game has the same pawns.
        let fen = "r1bq1rk1/2pnbppp/p2p1n2/1p2p3/3PP3/1BP2N1P/PP3PP1/RNBQR1K1 b - - 0 10";
        let pawns = scan(&db, &Want::Pawns(
            { let p: Chess = Fen::from_ascii(fen.as_bytes()).unwrap().into_position(CastlingMode::Standard).unwrap(); u64::from(p.board().pawns() & p.board().white()) },
            { let p: Chess = Fen::from_ascii(fen.as_bytes()).unwrap().into_position(CastlingMode::Standard).unwrap(); u64::from(p.board().pawns() & p.board().black()) },
        ), 100, 10, None).unwrap();
        assert_eq!(pawns.len(), 2, "both Ruy Lopez games share the structure");
        let start: Chess = Chess::default();
        let all = scan(&db, &Want::Material(material_of(&start)), 100, 0, None).unwrap();
        assert_eq!(all.len(), 3, "every game starts with full material");
    }

    #[test]
    fn pattern_search() {
        let (db, _) = fresh("pattern");
        let wanted = vec![(Square::E5, Piece::from_char('p').unwrap()), (Square::E4, Piece::from_char('P').unwrap())];
        assert_eq!(scan(&db, &Want::Pieces(wanted), 100, 0, None).unwrap().len(), 2);
    }

    #[test]
    fn backup_and_restore() {
        let (db, _) = fresh("backup");
        let backup = std::env::temp_dir().join(format!("castle-test-backup-{}.castlebackup", std::process::id()));
        let _ = std::fs::remove_file(&backup);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("VACUUM INTO ?", params![backup.to_string_lossy()]).unwrap();
        }
        let out = Connection::open(&backup).unwrap();
        out.execute_batch("CREATE TABLE castle_backup (version INTEGER, created INTEGER, state TEXT);").unwrap();
        out.execute("INSERT INTO castle_backup VALUES (1, 1, '{\"castle.x\":\"1\"}')", []).unwrap();
        drop(out);
        db.conn.lock().unwrap().execute("DELETE FROM games", []).unwrap();
        assert_eq!(count(&db), 0);
        // Same steps as db_restore.
        let state: String = Connection::open(&backup).unwrap().query_row("SELECT state FROM castle_backup", [], |r| r.get(0)).unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            *conn = Connection::open_in_memory().unwrap();
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{}", db.path.display(), suffix));
            }
            std::fs::copy(&backup, &db.path).unwrap();
            let fresh = connect(&db.path).unwrap();
            fresh.execute_batch("DROP TABLE IF EXISTS castle_backup;").unwrap();
            *conn = fresh;
        }
        assert_eq!(state, "{\"castle.x\":\"1\"}");
        assert_eq!(count(&db), 3);
    }

    #[test]
    fn events_and_explorer() {
        let (db, _) = fresh("events");
        let conn = db.conn.lock().unwrap();
        let events = events_query(&conn, None).unwrap();
        assert_eq!(events.len(), 2);
        let club = events.iter().find(|e| e.event == "Club Championship").unwrap();
        assert_eq!((club.games, club.players), (2, 3));
        let hash = fen_hash("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let after_e4: i64 = conn.query_row("SELECT COUNT(*) FROM positions WHERE hash = ?", params![hash], |r| r.get(0)).unwrap();
        assert_eq!(after_e4, 2);
    }
}
