import Foundation
import Observation

struct RatingPoint: Codable, Identifiable {
    var date: Date
    var rating: Int
    var id: Date { date }
}

struct ThemeStat: Codable {
    var attempts = 0
    var solved = 0
}

struct PuzzleStats: Codable {
    var ratingHistory: [RatingPoint] = []
    var themes: [String: ThemeStat] = [:]
    var rushScores: [Int] = []
    var dailySolved: [Int] = []
}

@Observable
final class PuzzleModel {
    enum Status { case loading, solving, wrong, solved, revealed, empty, rushOver }
    enum Mode: String, CaseIterable, Identifiable {
        case rated = "Rated", rush = "Rush", mistakes = "My Mistakes", daily = "Daily"
        var id: String { rawValue }
    }

    var status: Status = .loading
    var mode: Mode = .rated
    var puzzle: Puzzle?
    var position = Position.start
    var lastMove: Move?
    var hintSquare: Square?
    var userColor: PieceColor = .white
    var theme = "all" { didSet { if oldValue != theme, isLoaded, mode == .rated { next() } } }
    var playedSAN: [String] = []

    var rating: Int { didSet { UserDefaults.standard.set(rating, forKey: "puzzleRating") } }
    var solvedCount: Int { didSet { UserDefaults.standard.set(solvedCount, forKey: "puzzleSolved") } }
    var failedCount: Int { didSet { UserDefaults.standard.set(failedCount, forKey: "puzzleFailed") } }
    var streak = 0
    var lastDelta = 0

    // Rush: as many as possible before the clock or three misses end the run.
    var rushActive = false
    var rushScore = 0
    var rushStrikes = 0
    var rushRemaining = 0.0
    var rushMinutes = 3

    /// Positions from the user's own reviewed games.
    private(set) var mistakes: [Puzzle] = []
    private(set) var stats = PuzzleStats()

    @ObservationIgnored private(set) var all: [Puzzle] = []
    @ObservationIgnored private var step = 0
    @ObservationIgnored private var scored = false
    @ObservationIgnored private var seen: Set<String> = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var rushTimer: Timer?
    @ObservationIgnored private var rushLastTick = Date()
    private(set) var isLoaded = false
    private(set) var themes: [String] = []

    static let themeNames: [String: String] = [
        "all": "All themes", "mateIn1": "Mate in 1", "mateIn2": "Mate in 2", "mateIn3": "Mate in 3",
        "fork": "Fork", "pin": "Pin", "skewer": "Skewer", "discoveredAttack": "Discovered attack",
        "sacrifice": "Sacrifice", "deflection": "Deflection", "attraction": "Attraction",
        "backRankMate": "Back-rank mate", "hangingPiece": "Hanging piece", "trappedPiece": "Trapped piece",
        "endgame": "Endgame", "middlegame": "Middlegame", "opening": "Opening", "promotion": "Promotion",
        "kingsideAttack": "Kingside attack", "quietMove": "Quiet move", "zugzwang": "Zugzwang",
        "defensiveMove": "Defensive move", "rookEndgame": "Rook endgame", "pawnEndgame": "Pawn endgame",
        "smotheredMate": "Smothered mate", "doubleCheck": "Double check", "xRayAttack": "X-ray attack",
        "clearance": "Clearance", "intermezzo": "Intermezzo", "advancedPawn": "Advanced pawn",
        "mistake": "My mistakes",
    ]

    private static let folder: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Castle", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    private static let statsURL = folder.appendingPathComponent("PuzzleStats.json")
    private static let mistakesURL = folder.appendingPathComponent("Mistakes.json")

    init() {
        let d = UserDefaults.standard
        rating = d.object(forKey: "puzzleRating") as? Int ?? 1200
        solvedCount = d.integer(forKey: "puzzleSolved")
        failedCount = d.integer(forKey: "puzzleFailed")
        let decoder = JSONDecoder()
        if let data = try? Data(contentsOf: Self.statsURL), let s = try? decoder.decode(PuzzleStats.self, from: data) { stats = s }
        if let data = try? Data(contentsOf: Self.mistakesURL), let m = try? decoder.decode([Puzzle].self, from: data) { mistakes = m }
    }

    private func saveStats() {
        try? JSONEncoder().encode(stats).write(to: Self.statsURL, options: .atomic)
    }

    private func saveMistakes() {
        try? JSONEncoder().encode(mistakes).write(to: Self.mistakesURL, options: .atomic)
    }

    func load() {
        guard !isLoaded else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let list = Puzzle.loadBundled()
            DispatchQueue.main.async {
                self.all = list
                self.themes = ["all"] + Self.themeNames.keys.filter { $0 != "all" && $0 != "mistake" }
                    .sorted { (Self.themeNames[$0] ?? $0) < (Self.themeNames[$1] ?? $1) }
                self.isLoaded = true
                if self.mode == .daily { self.startDaily() } else { self.next() }
            }
        }
    }

    var total: Int { all.count }
    var daily: Puzzle? { DailyPuzzle.pick(from: all) }
    var dailySolved: Bool { stats.dailySolved.contains(DailyPuzzle.dayNumber()) }
    var rushBest: Int { stats.rushScores.max() ?? 0 }

    /// Consecutive days, ending today or yesterday, on which the daily puzzle was solved.
    var dailyStreak: Int {
        let days = Set(stats.dailySolved)
        var day = DailyPuzzle.dayNumber()
        if !days.contains(day) { day -= 1 }
        var n = 0
        while days.contains(day) { n += 1; day -= 1 }
        return n
    }

    func markDailySolved() {
        let today = DailyPuzzle.dayNumber()
        guard !stats.dailySolved.contains(today) else { return }
        stats.dailySolved.append(today)
        saveStats()
    }

    // MARK: Modes

    func setMode(_ new: Mode) {
        guard new != mode || status == .rushOver else { return }
        endRush(record: false)
        mode = new
        switch new {
        case .rated, .mistakes: next()
        case .daily: startDaily()
        case .rush:
            generation += 1
            puzzle = nil
            status = .rushOver
            rushScore = 0
            rushStrikes = 0
        }
    }

    func startDaily() {
        mode = .daily
        guard isLoaded, let p = daily else { return }
        start(p)
    }

    func startRush() {
        mode = .rush
        rushScore = 0
        rushStrikes = 0
        rushRemaining = Double(rushMinutes * 60)
        rushActive = true
        rushLastTick = Date()
        rushTimer?.invalidate()
        rushTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, self.rushActive else { return }
            let now = Date()
            self.rushRemaining = max(0, self.rushRemaining - now.timeIntervalSince(self.rushLastTick))
            self.rushLastTick = now
            if self.rushRemaining <= 0 { self.endRush(record: true) }
        }
        next()
    }

    private func endRush(record: Bool) {
        rushTimer?.invalidate()
        rushTimer = nil
        guard rushActive else { return }
        rushActive = false
        generation += 1
        status = .rushOver
        if record {
            stats.rushScores.append(rushScore)
            saveStats()
            Sound.gameEnd()
        }
    }

    /// Adds positions from a reviewed game; returns how many were new.
    @discardableResult
    func addMistakes(_ new: [Puzzle]) -> Int {
        let known = Set(mistakes.map(\.id))
        let fresh = new.filter { !known.contains($0.id) }
        mistakes.insert(contentsOf: fresh, at: 0)
        saveMistakes()
        return fresh.count
    }

    // MARK: Flow

    func next() {
        guard isLoaded else { return }
        switch mode {
        case .daily:
            startDaily()
        case .mistakes:
            let pool = mistakes.filter { !seen.contains($0.id) }
            if pool.isEmpty { seen.subtract(mistakes.map(\.id)) }
            guard let pick = pool.first ?? mistakes.first else {
                generation += 1
                puzzle = nil
                status = .empty
                return
            }
            start(pick)
        case .rush:
            guard rushActive else { return }
            let target = 600 + rushScore * 70
            let pool = all.filter { abs($0.rating - target) <= 120 && !seen.contains($0.id) && $0.moves.count <= 6 }
            if let pick = pool.randomElement() ?? all.randomElement() { start(pick) }
        case .rated:
            let pool = all.filter { (theme == "all" || $0.themes.contains(theme)) && !seen.contains($0.id) }
            var window = 75
            var candidates: [Puzzle] = []
            while candidates.isEmpty, window <= 3200 {
                candidates = pool.filter { abs($0.rating - rating) <= window }
                window *= 2
            }
            guard let pick = candidates.randomElement() ?? pool.randomElement() ?? all.randomElement() else { return }
            if pool.count < 5 { seen.removeAll() }
            start(pick)
        }
    }

    func retry() {
        if let p = puzzle { start(p, rescore: false) }
    }

    private func start(_ p: Puzzle, rescore: Bool = true) {
        guard let base = Position(fen: p.fen) else { return }
        generation += 1
        let token = generation
        puzzle = p
        seen.insert(p.id)
        position = base
        lastMove = nil
        hintSquare = nil
        playedSAN = []
        step = 0
        if rescore { scored = false; lastDelta = 0 }
        userColor = base.turn.opposite
        status = .solving
        DispatchQueue.main.asyncAfter(deadline: .now() + (mode == .rush ? 0.3 : 0.55)) {
            guard token == self.generation else { return }
            self.playScripted()
        }
    }

    private func playScripted() {
        guard let p = puzzle, step < p.moves.count, let m = position.move(uci: p.moves[step]) else { return }
        playedSAN.append(position.san(m))
        let capture = position.isCapture(m)
        position.apply(m)
        lastMove = m
        step += 1
        Sound.move(capture: capture)
    }

    var canMove: Bool { status == .solving && step > 0 && position.turn == userColor }

    func attempt(_ move: Move) {
        guard canMove, let p = puzzle, step < p.moves.count else { return }
        let expected = p.moves[step]
        let after = position.applying(move)
        // Any checkmate is as good as the listed one.
        guard move.uci == expected || after.isCheckmate else {
            wrong()
            return
        }
        hintSquare = nil
        playedSAN.append(position.san(move))
        let capture = position.isCapture(move)
        position = after
        lastMove = move
        step += 1
        Sound.move(capture: capture)
        if step >= p.moves.count || after.isCheckmate {
            finish()
            return
        }
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + (mode == .rush ? 0.25 : 0.45)) {
            guard token == self.generation else { return }
            self.playScripted()
            if self.step >= p.moves.count { self.finish() }
        }
    }

    private func wrong() {
        score(solved: false)
        status = .wrong
        Sound.error()
        let token = generation
        if mode == .rush {
            rushStrikes += 1
            if rushStrikes >= 3 {
                endRush(record: true)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                guard token == self.generation else { return }
                self.next()
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            guard token == self.generation, self.status == .wrong else { return }
            self.status = .solving
        }
    }

    func hint() {
        guard canMove, mode != .rush, let p = puzzle, step < p.moves.count, let m = Move(uci: p.moves[step]) else { return }
        score(solved: false)
        hintSquare = m.from
    }

    func reveal() {
        guard mode != .rush, let p = puzzle, status == .solving || status == .wrong else { return }
        score(solved: false)
        status = .revealed
        hintSquare = nil
        let token = generation
        func playNext() {
            guard token == generation, step < p.moves.count else { return }
            playScripted()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { playNext() }
        }
        playNext()
    }

    private func finish() {
        let firstTry = !scored
        score(solved: true)
        status = .solved
        Sound.success()
        guard let p = puzzle else { return }
        switch mode {
        case .daily:
            markDailySolved()
        case .mistakes where firstTry:
            mistakes.removeAll { $0.id == p.id }
            saveMistakes()
        case .rush:
            rushScore += 1
            let token = generation
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard token == self.generation else { return }
                self.next()
            }
        default:
            break
        }
    }

    /// Counts the first outcome of a puzzle only; later tries are free.
    private func score(solved: Bool) {
        guard !scored, let p = puzzle else { return }
        scored = true
        for theme in p.themes {
            stats.themes[theme, default: ThemeStat()].attempts += 1
            if solved { stats.themes[theme, default: ThemeStat()].solved += 1 }
        }
        if mode == .rated {
            let expected = 1 / (1 + pow(10, Double(p.rating - rating) / 400))
            lastDelta = Int((32 * ((solved ? 1 : 0) - expected)).rounded())
            rating = max(400, rating + lastDelta)
            stats.ratingHistory.append(RatingPoint(date: Date(), rating: rating))
            if stats.ratingHistory.count > 2000 { stats.ratingHistory.removeFirst(stats.ratingHistory.count - 2000) }
        }
        if solved {
            solvedCount += 1
            streak += 1
        } else {
            failedCount += 1
            streak = 0
        }
        saveStats()
    }
}
