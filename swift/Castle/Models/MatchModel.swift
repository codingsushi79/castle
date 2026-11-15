import Foundation
import Observation

struct MatchRecord: Identifiable {
    let id = UUID()
    var number: Int
    var white: String
    var black: String
    var result: String
    var opening: String
    var plies: Int
    var reason: String
    var aIsWhite: Bool
    var game: Game

    /// Points scored by engine A.
    var scoreA: Double {
        switch result {
        case "1-0": return aIsWhite ? 1 : 0
        case "0-1": return aIsWhite ? 0 : 1
        default: return 0.5
        }
    }
}

/// Plays a series of games between two engines and keeps the score.
@Observable
final class MatchModel {
    var engineA: String
    var engineB: String
    var games = 10
    var moveTimeMs = 200
    var useOpenings = true

    var isRunning = false
    var records: [MatchRecord] = []
    var game = Game()
    var aIsWhite = true
    var opening = ""
    var score: EngineScore?
    var depth = 0
    var nameA = ""
    var nameB = ""

    var onGameFinished: ((Game) -> Void)?

    @ObservationIgnored private let catalog: EngineCatalog
    @ObservationIgnored private let openings: OpeningBook
    @ObservationIgnored private var a: UCIEngine?
    @ObservationIgnored private var b: UCIEngine?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var line: (name: String, moves: [String])?
    @ObservationIgnored private var decisive = 0
    @ObservationIgnored private var quiet = 0

    init(catalog: EngineCatalog, openings: OpeningBook) {
        self.catalog = catalog
        self.openings = openings
        engineA = "wasabi"
        engineB = catalog.available.first { $0.id != "wasabi" }?.id ?? "wasabi"
    }

    var winsA: Int { records.filter { $0.scoreA == 1 }.count }
    var winsB: Int { records.filter { $0.scoreA == 0 }.count }
    var draws: Int { records.filter { $0.scoreA == 0.5 }.count }
    var pointsA: Double { records.reduce(0) { $0 + $1.scoreA } }

    /// Engine A's rating edge over engine B with a 95% margin, once it can be estimated.
    var elo: (diff: Double, margin: Double)? {
        let n = Double(records.count)
        guard n >= 2 else { return nil }
        let p = pointsA / n
        guard p > 0, p < 1 else { return nil }
        func toElo(_ x: Double) -> Double { -400 * log10(1 / min(0.999, max(0.001, x)) - 1) }
        let w = Double(winsA) / n, d = Double(draws) / n, l = Double(winsB) / n
        let variance = w * pow(1 - p, 2) + d * pow(0.5 - p, 2) + l * pow(p, 2)
        let sigma = sqrt(variance / n)
        return (toElo(p), (toElo(p + 1.96 * sigma) - toElo(p - 1.96 * sigma)) / 2)
    }

    func start() {
        stop()
        guard let ea = catalog.resolve(engineA), let eb = catalog.resolve(engineB),
              let pa = catalog.makeEngine(ea, threads: 1, hash: 64), let pb = catalog.makeEngine(eb, threads: 1, hash: 64) else { return }
        nameA = ea.name
        nameB = ea.id == eb.id ? eb.name + " (2)" : eb.name
        a = pa
        b = pb
        records = []
        isRunning = true
        generation += 1
        pa.start()
        pb.start()
        playGame(0)
    }

    func stop() {
        generation += 1
        a?.quit()
        b?.quit()
        a = nil
        b = nil
        isRunning = false
    }

    private func playGame(_ index: Int) {
        guard isRunning, index < games else {
            stop()
            Sound.gameEnd()
            return
        }
        aIsWhite = index % 2 == 0
        // Each opening is played twice, once with each colour.
        if index % 2 == 0 { line = useOpenings ? openings.startingLines.randomElement() : nil }
        let g = Game()
        for uci in line?.moves ?? [] { g.play(uci: uci) }
        opening = line?.name ?? "Starting position"
        g.tags["Event"] = "Engine match"
        g.tags["Round"] = String(index + 1)
        g.tags["White"] = aIsWhite ? nameA : nameB
        g.tags["Black"] = aIsWhite ? nameB : nameA
        if line != nil { g.tags["Opening"] = opening }
        game = g
        score = nil
        depth = 0
        decisive = 0
        quiet = 0
        a?.newGame()
        b?.newGame()
        step(index)
    }

    private func step(_ index: Int) {
        guard isRunning else { return }
        let node = game.current
        if let outcome = game.outcome(at: node) {
            finish(index, result: outcome.result, reason: outcome.summary)
            return
        }
        if node.position.ply >= 400 {
            finish(index, result: "1/2-1/2", reason: "Draw: game too long")
            return
        }
        // Stop early once the result is beyond doubt.
        if decisive >= 8, let s = score {
            finish(index, result: s.winPercent > 50 ? "1-0" : "0-1", reason: "Adjudicated: decisive advantage")
            return
        }
        if quiet >= 30, node.position.ply > 120 {
            finish(index, result: "1/2-1/2", reason: "Adjudicated: dead level")
            return
        }
        let whiteToMove = node.position.turn == .white
        guard let engine = (whiteToMove == aIsWhite) ? a : b else { return }
        let token = generation
        var latest: EngineLine?
        var job = SearchJob(position: game.positionCommand(for: node), go: "go movetime \(moveTimeMs)")
        job.onInfo = { info in if info.multipv == 1 { latest = info } }
        job.onBestMove = { [weak self] best in
            guard let self, token == self.generation, self.game.current === node else { return }
            guard let best, let move = node.position.move(uci: best) else {
                self.finish(index, result: whiteToMove ? "0-1" : "1-0", reason: "Engine failed to move")
                return
            }
            if let latest {
                let s = whiteToMove ? latest.score : latest.score.negated
                self.score = s
                self.depth = latest.depth
                let wp = s.winPercent
                self.decisive = (wp > 97 || wp < 3) ? self.decisive + 1 : 0
                self.quiet = abs(wp - 50) < 2 ? self.quiet + 1 : 0
            }
            let played = self.game.play(move)
            played.eval = self.score
            self.step(index)
        }
        engine.search(job)
    }

    private func finish(_ index: Int, result: String, reason: String) {
        game.result = result
        game.tags["Termination"] = reason
        records.append(MatchRecord(number: index + 1, white: game.tags["White"] ?? "", black: game.tags["Black"] ?? "",
                                   result: result, opening: opening, plies: game.mainline.count, reason: reason,
                                   aIsWhite: aIsWhite, game: game))
        onGameFinished?(game)
        let token = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            guard token == self.generation else { return }
            self.playGame(index + 1)
        }
    }
}
