import Foundation
import Observation

enum Opponent: String, CaseIterable, Identifiable {
    case engine = "Computer"
    case human = "Human on this Mac"
    var id: String { rawValue }
}

enum SideChoice: String, CaseIterable, Identifiable {
    case white = "White", black = "Black", random = "Random"
    var id: String { rawValue }
}

enum PlayVariant: String, CaseIterable, Identifiable {
    case standard = "Standard", chess960 = "Chess960"
    var id: String { rawValue }
}

struct TimeControl: Hashable, Identifiable {
    var minutes: Int
    var increment: Int
    var id: String { label }
    var label: String { minutes == 0 ? "No clock" : "\(minutes) + \(increment)" }
    var symbol: String {
        switch minutes {
        case 0: return "infinity"
        case 1...2: return "bolt.fill"
        case 3...9: return "flame.fill"
        case 10...29: return "hare.fill"
        default: return "tortoise.fill"
        }
    }

    static let presets = [TimeControl(minutes: 0, increment: 0), TimeControl(minutes: 1, increment: 0),
                          TimeControl(minutes: 3, increment: 2), TimeControl(minutes: 5, increment: 0),
                          TimeControl(minutes: 10, increment: 5), TimeControl(minutes: 15, increment: 10),
                          TimeControl(minutes: 30, increment: 0)]
}

@Observable
final class PlayModel {
    enum Phase { case setup, playing, finished }

    // Setup
    var opponent: Opponent = .engine
    var side: SideChoice = .white
    var engineID: String
    var timeControl = TimeControl(minutes: 10, increment: 5)
    var limitStrength = true
    var variant: PlayVariant = .standard
    /// A position to start from instead of the usual one ("play from here").
    var customStart: Position?
    var elo = 1500.0

    // Game
    var phase: Phase = .setup
    var game = Game()
    var humanColor: PieceColor = .white
    var outcome: GameOutcome?
    var clocks: [PieceColor: Double] = [.white: 0, .black: 0]
    var isThinking = false
    var engineName = ""
    var thinkingLine = ""

    var onFinished: ((Game) -> Void)?

    @ObservationIgnored private let catalog: EngineCatalog
    @ObservationIgnored private var engine: UCIEngine?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastTick = Date()

    init(catalog: EngineCatalog) {
        self.catalog = catalog
        engineID = catalog.defaultID
    }

    var hasClock: Bool { timeControl.minutes > 0 }
    var flipped: Bool { opponent == .engine && humanColor == .black }

    /// Which side the person at the board may move right now.
    var movableColor: PieceColor? {
        guard phase == .playing, game.current === game.lastMainlineNode else { return nil }
        if opponent == .human { return game.position.turn }
        return game.position.turn == humanColor && !isThinking ? humanColor : nil
    }

    func name(for color: PieceColor) -> String {
        if opponent == .human { return color.name }
        return color == humanColor ? "You" : engineName
    }

    // MARK: Flow

    func start() {
        engine?.quit()
        engine = nil
        game = Game(start: customStart ?? (variant == .chess960 ? .chess960(Int.random(in: 0..<960)) : .start))
        outcome = nil
        isThinking = false
        thinkingLine = ""
        switch side {
        case .white: humanColor = .white
        case .black: humanColor = .black
        case .random: humanColor = Bool.random() ? .white : .black
        }
        let seconds = Double(timeControl.minutes * 60)
        clocks = [.white: seconds, .black: seconds]
        game.tags["Event"] = opponent == .engine ? "Game against the computer" : "Over-the-board game"
        if hasClock { game.tags["TimeControl"] = "\(timeControl.minutes * 60)+\(timeControl.increment)" }

        if opponent == .engine {
            guard let entry = catalog.resolve(engineID), let e = catalog.makeEngine(entry) else { return }
            engineID = entry.id
            engineName = entry.name
            e.onReady = { [weak self, weak e] in
                guard let self, let e else { return }
                self.configureStrength(e)
                e.send("ucinewgame")
            }
            e.onExit = { [weak self] in self?.isThinking = false }
            engine = e
            e.start()
            game.tags["White"] = humanColor == .white ? NSFullUserName() : engineName
            game.tags["Black"] = humanColor == .black ? NSFullUserName() : engineName
        }
        phase = .playing
        lastTick = Date()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        if opponent == .engine, game.position.turn != humanColor { engineMove() }
    }

    private func configureStrength(_ e: UCIEngine) {
        guard limitStrength else {
            e.setOption("UCI_LimitStrength", "false")
            e.setOption("Skill Level", e.option("Skill Level")?.defaultValue ?? "20")
            return
        }
        if e.hasOption("UCI_LimitStrength"), let opt = e.option("UCI_Elo") {
            let clamped = min(max(Int(elo), opt.min ?? 0), opt.max ?? 4000)
            e.setOption("UCI_LimitStrength", "true")
            e.setOption("UCI_Elo", String(clamped))
        } else if let opt = e.option("Skill Level") {
            let lo = Double(opt.min ?? 0), hi = Double(opt.max ?? 20)
            let t = min(1, max(0, (elo - 800) / 2000))
            e.setOption("Skill Level", String(Int(lo + (hi - lo) * t)))
        }
    }

    func humanMove(_ move: Move) {
        guard phase == .playing, movableColor != nil else { return }
        commit(move)
        if phase == .playing, opponent == .engine { engineMove() }
    }

    private func commit(_ move: Move) {
        let mover = game.position.turn
        game.toEnd()
        let node = game.play(move)
        if hasClock {
            clocks[mover, default: 0] += Double(timeControl.increment)
            node.clock = Self.clockTag(clocks[mover] ?? 0)
        }
        lastTick = Date()
        Sound.play(for: node)
        if let o = game.outcome(at: node) { finish(o) }
    }

    private func engineMove() {
        guard let engine, phase == .playing else { return }
        isThinking = true
        thinkingLine = ""
        let node = game.current
        var go = "go movetime 1200"
        if hasClock {
            // The computer is told it has a quarter of its real clock, so it keeps a brisk
            // pace instead of sitting on the opening moves.
            let engineColor = humanColor.opposite
            func ms(_ c: PieceColor) -> Int {
                Int((clocks[c] ?? 0) * 1000) / (c == engineColor ? 4 : 1)
            }
            let w = ms(.white), b = ms(.black)
            let inc = timeControl.increment * 1000 / 4
            go = "go wtime \(max(w, 50)) btime \(max(b, 50)) winc \(inc) binc \(inc)"
        }
        var job = SearchJob(position: game.positionCommand(for: node), go: go, chess960: game.isChess960)
        job.onInfo = { [weak self] info in
            guard let self, info.multipv == 1 else { return }
            self.thinkingLine = "Depth \(info.depth)"
        }
        job.onBestMove = { [weak self] best in
            guard let self, self.phase == .playing, self.game.lastMainlineNode === node else { return }
            self.isThinking = false
            if let best, let move = node.position.move(uci: best) {
                self.commit(move)
            } else if let fallback = node.position.legalMoves().randomElement() {
                self.commit(fallback)
            }
        }
        engine.search(job)
    }

    private func tick() {
        guard phase == .playing else { return }
        let now = Date()
        let elapsed = now.timeIntervalSince(lastTick)
        lastTick = now
        guard hasClock, game.lastMainlineNode.parent != nil else { return }
        let mover = game.lastMainlineNode.position.turn
        let remaining = max(0, (clocks[mover] ?? 0) - elapsed)
        clocks[mover] = remaining
        if remaining <= 0 { finish(.timeout(winner: mover.opposite)) }
    }

    func resign() {
        guard phase == .playing else { return }
        let loser = opponent == .engine ? humanColor : game.position.turn
        finish(.resignation(winner: loser.opposite))
    }

    func takeBack() {
        guard phase == .playing, !isThinking else { return }
        game.toEnd()
        let steps = opponent == .engine && game.position.turn == humanColor ? 2 : 1
        for _ in 0..<steps {
            let node = game.current
            guard node.parent != nil else { break }
            game.delete(node)
        }
    }

    private func finish(_ o: GameOutcome) {
        outcome = o
        phase = .finished
        isThinking = false
        timer?.invalidate()
        timer = nil
        engine?.quit()
        engine = nil
        game.result = o.result
        game.tags["Termination"] = o.summary
        Sound.gameEnd()
        onFinished?(game)
    }

    func backToSetup() {
        timer?.invalidate()
        engine?.quit()
        engine = nil
        phase = .setup
    }

    static func clockTag(_ seconds: Double) -> String {
        let s = Int(seconds)
        return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
    }

    static func clockText(_ seconds: Double) -> String {
        if seconds < 20 { return String(format: "0:%04.1f", seconds) }
        let s = Int(seconds.rounded(.up))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }
}
