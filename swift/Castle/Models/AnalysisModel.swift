import Foundation
import Observation

/// A line shown in the analysis panel, with the score from White's point of view.
struct AnalysisLine: Identifiable, Hashable {
    var id: Int { rank }
    var rank: Int
    var depth: Int
    var score: EngineScore
    var san: String
    var firstMove: String
    var nodes: Int
    var nps: Int
}

struct ReviewSummary {
    var accuracy: [PieceColor: Double] = [:]
    var inaccuracies: [PieceColor: Int] = [.white: 0, .black: 0]
    var mistakes: [PieceColor: Int] = [.white: 0, .black: 0]
    var blunders: [PieceColor: Int] = [.white: 0, .black: 0]
}

/// One engine taking part in the analysis. Several can run side by side.
@Observable
final class EngineSlot: Identifiable {
    let id = UUID()
    var engineID: String
    var name: String
    var lines: [AnalysisLine] = []
    @ObservationIgnored var engine: UCIEngine?

    init(engineID: String, name: String) {
        self.engineID = engineID
        self.name = name
    }
}

@Observable
final class AnalysisModel: Identifiable {
    let id = UUID()
    var game = Game()
    var flipped = false
    var isRunning = false
    var multiPV = 3
    var slots: [EngineSlot]
    /// Shows what the side that just moved would do with another move in a row.
    var threatMode = false { didSet { if oldValue != threatMode { refresh(force: true) } } }
    var threatUnavailable = false

    var isReviewing = false
    var reviewProgress = 0.0
    var summary: ReviewSummary?

    @ObservationIgnored private let catalog: EngineCatalog
    @ObservationIgnored private var reviewEngine: UCIEngine?
    @ObservationIgnored private var analysedNode: UUID?

    init(catalog: EngineCatalog, game: Game? = nil) {
        self.catalog = catalog
        let entry = catalog.resolve(nil)
        slots = [EngineSlot(engineID: entry?.id ?? catalog.defaultID, name: entry?.name ?? "Engine")]
        if let game {
            self.game = game
            if game.mainline.contains(where: { $0.eval != nil }) { summarise() }
        }
    }

    var engineID: String { slots[0].engineID }
    var engineName: String { slots[0].name }
    var lines: [AnalysisLine] { slots[0].lines }

    /// A short name for the tab holding this board.
    var title: String {
        let _ = game.revision
        guard !game.mainline.isEmpty else { return game.root.position == .start ? "New board" : "Position" }
        let w = game.tags["White"] ?? "White", b = game.tags["Black"] ?? "Black"
        if w == "White", b == "Black" { return "Analysis" }
        return "\(w.split(separator: ",").first ?? "White") – \(b.split(separator: ",").first ?? "Black")"
    }

    /// Evaluation of the position on the board, from the live engine or a stored review.
    var currentScore: EngineScore? {
        if isRunning, !threatMode, let best = lines.first { return best.score }
        return game.current.eval
    }

    // MARK: Loading

    func load(_ newGame: Game) {
        stopReview()
        game = newGame
        summary = nil
        for slot in slots { slot.lines = [] }
        if game.mainline.contains(where: { $0.eval != nil }) { summarise() }
        refresh(force: true)
    }

    func newGame(from position: Position = .start) {
        load(Game(start: position))
    }

    // MARK: Live analysis

    func toggle() {
        isRunning.toggle()
        if isRunning {
            refresh(force: true)
        } else {
            for slot in slots { slot.engine?.stop() }
        }
    }

    /// Changes the engine in a slot (the first one by default).
    func selectEngine(_ id: String, in slot: EngineSlot? = nil) {
        let slot = slot ?? slots[0]
        guard id != slot.engineID else { return }
        slot.engineID = id
        slot.name = catalog.entry(id)?.name ?? "Engine"
        slot.engine?.quit()
        slot.engine = nil
        slot.lines = []
        if isRunning { refresh(force: true) }
    }

    func addEngine(_ id: String) {
        guard slots.count < 4, let entry = catalog.entry(id), entry.isAvailable else { return }
        slots.append(EngineSlot(engineID: id, name: entry.name))
        if isRunning { refresh(force: true) }
    }

    func remove(_ slot: EngineSlot) {
        guard slots.count > 1 else { return }
        slot.engine?.quit()
        slot.engine = nil
        slots.removeAll { $0 === slot }
    }

    func shutdown() {
        for slot in slots {
            slot.engine?.quit()
            slot.engine = nil
        }
        stopReview()
        isRunning = false
    }

    /// Restarts the search when the board position has changed.
    func refresh(force: Bool = false) {
        guard isRunning else { return }
        let node = game.current
        guard force || analysedNode != node.id else { return }
        analysedNode = node.id
        for slot in slots { slot.lines = [] }
        threatUnavailable = false

        var position = node.position
        var command = game.positionCommand(for: node)
        if threatMode {
            guard let passed = node.position.passed else {
                threatUnavailable = true
                for slot in slots { slot.engine?.stop() }
                return
            }
            position = passed
            command = "position fen \(passed.fen)"
        }
        if position.legalMoves().isEmpty {
            for slot in slots { slot.engine?.stop() }
            return
        }
        let threat = threatMode
        let threads = slots.count > 1 ? max(1, ProcessInfo.processInfo.activeProcessorCount / (slots.count + 1)) : nil
        for (index, slot) in slots.enumerated() {
            if slot.engine == nil {
                guard let entry = catalog.resolve(slot.engineID), let e = catalog.makeEngine(entry, threads: threads) else { continue }
                slot.engineID = entry.id
                slot.name = entry.name
                e.onReady = { [weak slot, weak e] in
                    if let n = e?.name, !n.isEmpty { slot?.name = n }
                }
                e.onExit = { [weak self, weak slot] in
                    slot?.engine = nil
                    slot?.lines = []
                    if self?.slots.allSatisfy({ $0.engine == nil }) ?? false { self?.isRunning = false }
                }
                slot.engine = e
            }
            var job = SearchJob(position: command, go: "go infinite", multiPV: multiPV, chess960: position.chess960)
            job.onInfo = { [weak self, weak slot] info in
                guard let self, let slot, self.game.current === node, self.threatMode == threat else { return }
                let score = position.turn == .white ? info.score : info.score.negated
                let line = AnalysisLine(rank: info.multipv, depth: info.depth, score: score,
                                        san: position.sanLine(info.pv), firstMove: info.pv.first ?? "",
                                        nodes: info.nodes, nps: info.nps)
                if let i = slot.lines.firstIndex(where: { $0.rank == line.rank }) {
                    slot.lines[i] = line
                } else {
                    slot.lines.append(line)
                    slot.lines.sort { $0.rank < $1.rank }
                }
                if index == 0, !threat, info.multipv == 1, info.depth >= 12 {
                    node.eval = score
                    node.bestMove = info.pv.first
                }
            }
            slot.engine?.search(job)
        }
        if slots.allSatisfy({ $0.engine == nil }) { isRunning = false }
    }

    // MARK: Game review

    func startReview(moveTimeMs: Int = 350) {
        guard !isReviewing, let entry = catalog.resolve(engineID), let e = catalog.makeEngine(entry) else { return }
        let nodes = [game.root] + game.mainline
        guard nodes.count > 1 else { return }
        isReviewing = true
        reviewProgress = 0
        summary = nil
        reviewEngine = e
        e.onExit = { [weak self] in self?.isReviewing = false }
        reviewStep(nodes: nodes, index: 0, moveTimeMs: moveTimeMs)
    }

    func stopReview() {
        reviewEngine?.quit()
        reviewEngine = nil
        isReviewing = false
    }

    private func reviewStep(nodes: [GameNode], index: Int, moveTimeMs: Int) {
        guard isReviewing, let e = reviewEngine else { return }
        guard index < nodes.count else {
            stopReview()
            summarise()
            game.touch()
            return
        }
        let node = nodes[index]
        let position = node.position
        let advance = { [weak self] in
            guard let self else { return }
            self.reviewProgress = Double(index + 1) / Double(nodes.count)
            self.reviewStep(nodes: nodes, index: index + 1, moveTimeMs: moveTimeMs)
        }
        if position.legalMoves().isEmpty {
            node.eval = position.inCheck ? .cp(position.turn == .white ? -100000 : 100000) : .cp(0)
            advance()
            return
        }
        var last: EngineLine?
        var job = SearchJob(position: game.positionCommand(for: node), go: "go movetime \(moveTimeMs)",
                            chess960: position.chess960)
        job.onInfo = { info in if info.multipv == 1 { last = info } }
        job.onBestMove = { best in
            if let last {
                node.eval = position.turn == .white ? last.score : last.score.negated
                node.bestMove = last.pv.first ?? best
            }
            advance()
        }
        e.search(job)
    }

    /// Grades every mainline move from the stored evaluations.
    func summarise() {
        var result = ReviewSummary()
        var accuracies: [PieceColor: [Double]] = [.white: [], .black: []]
        for node in game.mainline {
            guard let parent = node.parent, let before = parent.eval, let after = node.eval else { continue }
            let mover = parent.position.turn
            let wpBefore = mover == .white ? before.winPercent : 100 - before.winPercent
            let wpAfter = mover == .white ? after.winPercent : 100 - after.winPercent
            let loss = max(0, wpBefore - wpAfter)
            accuracies[mover]?.append(max(0, min(100, 103.1668 * exp(-0.04354 * loss) - 3.1669)))
            let playedBest = parent.bestMove == node.move?.uci
            if playedBest || loss < 5 {
                if let n = node.nag, [2, 4, 6].contains(n) { node.nag = nil }
            } else if loss >= 20 {
                node.nag = 4
                result.blunders[mover, default: 0] += 1
            } else if loss >= 10 {
                node.nag = 2
                result.mistakes[mover, default: 0] += 1
            } else {
                node.nag = 6
                result.inaccuracies[mover, default: 0] += 1
            }
        }
        for color in [PieceColor.white, .black] {
            if let list = accuracies[color], !list.isEmpty {
                result.accuracy[color] = list.reduce(0, +) / Double(list.count)
            }
        }
        summary = result.accuracy.isEmpty ? nil : result
    }

    /// Every mistake and blunder of the reviewed game as a "find the better move" puzzle.
    func mistakePuzzles(for color: PieceColor? = nil) -> [Puzzle] {
        var out: [Puzzle] = []
        let label = "\(game.tags["White"] ?? "White") – \(game.tags["Black"] ?? "Black")"
        for node in game.mainline {
            guard let nag = node.nag, nag == 2 || nag == 4,
                  let before = node.parent, let setup = before.parent, let lead = before.move,
                  let best = before.bestMove, best != node.move?.uci,
                  before.position.move(uci: best) != nil else { continue }
            if let color, before.position.turn != color { continue }
            out.append(Puzzle(id: "m-" + String(before.position.epd.stableHash, radix: 36),
                              fen: setup.position.fen, moves: [lead.uci, best],
                              rating: nag == 4 ? 1400 : 1700, themes: ["mistake"], source: label))
        }
        return out
    }
}
