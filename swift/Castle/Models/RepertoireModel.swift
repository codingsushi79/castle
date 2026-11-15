import Foundation
import Observation

/// Spaced-repetition state for one repertoire position.
struct ReviewCard: Codable {
    var interval = 0.0          // days
    var ease = 2.3
    var reps = 0
    var lapses = 0
    var due = Date()
}

/// An opening repertoire for each colour, with a trainer that asks for the prepared
/// reply and schedules positions by how well they are remembered.
@Observable
final class RepertoireModel {
    enum TrainStatus { case idle, asking, correct, wrong, finished }

    var color: PieceColor = .white
    private(set) var white = Game()
    private(set) var black = Game()

    var isTraining = false
    var trainStatus: TrainStatus = .idle
    var trainNode: GameNode?
    var answer: Move?
    var sessionDone = 0
    var sessionTotal = 0
    var sessionMisses = 0
    private(set) var cards: [String: ReviewCard] = [:]

    @ObservationIgnored private var queue: [GameNode] = []
    @ObservationIgnored private var missed = false
    @ObservationIgnored private var token = 0

    private static let folder: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Castle", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private static func url(_ color: PieceColor) -> URL {
        folder.appendingPathComponent("Repertoire-\(color.name).pgn")
    }

    private static let cardsURL = folder.appendingPathComponent("RepertoireCards.json")

    init() {
        for c in [PieceColor.white, .black] {
            if let text = try? String(contentsOf: Self.url(c), encoding: .utf8), let g = PGN.parseGame(text) {
                g.toStart()
                if c == .white { white = g } else { black = g }
            }
        }
        white.tags["Event"] = "White repertoire"
        black.tags["Event"] = "Black repertoire"
        if let data = try? Data(contentsOf: Self.cardsURL),
           let c = try? JSONDecoder().decode([String: ReviewCard].self, from: data) { cards = c }
    }

    func game(for color: PieceColor) -> Game { color == .white ? white : black }
    var game: Game { game(for: color) }

    func save() {
        for c in [PieceColor.white, .black] {
            try? PGN.write(game(for: c)).write(to: Self.url(c), atomically: true, encoding: .utf8)
        }
    }

    private func saveCards() {
        try? JSONEncoder().encode(cards).write(to: Self.cardsURL, options: .atomic)
    }

    /// Merges every line of a game into the repertoire.
    func importLine(_ source: Game, color: PieceColor) {
        let target = game(for: color)
        func merge(_ from: GameNode, into: GameNode) {
            for child in from.children {
                guard let move = child.move else { continue }
                let next = into.children.first { $0.move == move } ?? target.append(move, after: into)
                if next.comment.isEmpty { next.comment = child.comment }
                merge(child, into: next)
            }
        }
        guard source.root.position == target.root.position else { return }
        merge(source.root, into: target.root)
        target.touch()
        save()
    }

    func clear(_ color: PieceColor) {
        let g = Game()
        g.tags["Event"] = "\(color.name) repertoire"
        if color == .white { white = g } else { black = g }
        save()
    }

    // MARK: Cards

    private func key(_ node: GameNode, _ color: PieceColor) -> String { "\(color.rawValue)|\(node.position.epd)" }

    /// Positions where it is the repertoire side's move and a reply has been prepared.
    func positions(for color: PieceColor) -> [GameNode] {
        var out: [GameNode] = []
        var seen = Set<String>()
        func walk(_ node: GameNode) {
            if node.position.turn == color, !node.children.isEmpty, seen.insert(node.position.epd).inserted {
                out.append(node)
            }
            node.children.forEach(walk)
        }
        walk(game(for: color).root)
        return out
    }

    func due(for color: PieceColor) -> [GameNode] {
        let now = Date()
        return positions(for: color).filter { (cards[key($0, color)]?.due ?? .distantPast) <= now }
    }

    func learned(for color: PieceColor) -> Int {
        positions(for: color).filter { (cards[key($0, color)]?.interval ?? 0) >= 7 }.count
    }

    /// Cards coming due on each of the next days, for the progress page.
    func forecast(days: Int = 14) -> [(day: Int, count: Int)] {
        let now = Date()
        var counts = [Int](repeating: 0, count: days)
        for c in [PieceColor.white, .black] {
            for node in positions(for: c) {
                let due = cards[key(node, c)]?.due ?? now
                let d = max(0, Int(ceil(due.timeIntervalSince(now) / 86400)))
                if d < days { counts[d] += 1 }
            }
        }
        return counts.enumerated().map { ($0.offset, $0.element) }
    }

    // MARK: Training

    func startTraining(limit: Int = 30) {
        queue = Array(due(for: color).shuffled().prefix(limit))
        sessionTotal = queue.count
        sessionDone = 0
        sessionMisses = 0
        isTraining = true
        advance()
    }

    func stopTraining() {
        token += 1
        isTraining = false
        trainStatus = .idle
        trainNode = nil
        answer = nil
    }

    private func advance() {
        token += 1
        answer = nil
        missed = false
        guard !queue.isEmpty else {
            trainNode = nil
            trainStatus = .finished
            Sound.gameEnd()
            return
        }
        trainNode = queue.removeFirst()
        trainStatus = .asking
    }

    /// The position shown to the trainee, including the move after a right answer.
    var trainPosition: Position {
        guard let node = trainNode else { return game.root.position }
        if let answer, trainStatus == .correct { return node.position.applying(answer) }
        return node.position
    }

    func attempt(_ move: Move) {
        guard trainStatus == .asking || trainStatus == .wrong, let node = trainNode else { return }
        guard node.children.contains(where: { $0.move == move }) else {
            if !missed {
                missed = true
                sessionMisses += 1
                grade(node, correct: false)
                queue.append(node)
            }
            trainStatus = .wrong
            Sound.error()
            return
        }
        if !missed { grade(node, correct: true) }
        if !missed { sessionDone += 1 }
        answer = move
        trainStatus = .correct
        Sound.move(capture: node.position.isCapture(move))
        let t = token
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            guard t == self.token else { return }
            self.advance()
        }
    }

    /// The prepared replies in the current training position.
    var expected: [String] { trainNode?.children.map(\.san) ?? [] }

    private func grade(_ node: GameNode, correct: Bool) {
        var card = cards[key(node, color)] ?? ReviewCard()
        if correct {
            card.reps += 1
            card.interval = card.reps == 1 ? 1 : card.reps == 2 ? 3 : (card.interval * card.ease).rounded()
            card.ease = min(3.0, card.ease + 0.05)
            card.due = Date().addingTimeInterval(card.interval * 86400)
        } else {
            card.reps = 0
            card.lapses += 1
            card.interval = 0
            card.ease = max(1.3, card.ease - 0.2)
            card.due = Date()
        }
        cards[key(node, color)] = card
        saveCards()
    }
}
