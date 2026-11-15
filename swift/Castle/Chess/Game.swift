import Foundation
import Observation

final class GameNode: Identifiable {
    let id = UUID()
    weak var parent: GameNode?
    var children: [GameNode] = []
    let move: Move?
    let san: String
    let position: Position
    var comment = ""
    var nag: Int? = nil
    var eval: EngineScore? = nil
    var bestMove: String? = nil
    var clock: String? = nil
    var shapes: [BoardShape] = []

    init(position: Position, move: Move? = nil, san: String = "", parent: GameNode? = nil) {
        self.position = position
        self.move = move
        self.san = san
        self.parent = parent
    }

    var isMainline: Bool {
        var n = self
        while let p = n.parent {
            if p.children.first !== n { return false }
            n = p
        }
        return true
    }

    /// "12." or "12…" for the move that led to this node.
    var moveNumberLabel: String {
        guard let parent else { return "" }
        let n = parent.position.fullmoveNumber
        return parent.position.turn == .white ? "\(n)." : "\(n)…"
    }

    /// The `[%csl …]` and `[%cal …]` commands that store the drawn shapes.
    var shapeTags: [String] {
        let circles = shapes.filter(\.isCircle).map { $0.tint.rawValue + Sq.name($0.from) }
        let arrows = shapes.filter { !$0.isCircle }.map { $0.tint.rawValue + Sq.name($0.from) + Sq.name($0.to) }
        var out: [String] = []
        if !circles.isEmpty { out.append("[%csl \(circles.joined(separator: ","))]") }
        if !arrows.isEmpty { out.append("[%cal \(arrows.joined(separator: ","))]") }
        return out
    }

    func toggle(_ shape: BoardShape) {
        if let i = shapes.firstIndex(where: { $0.from == shape.from && $0.to == shape.to }) {
            let same = shapes[i].tint == shape.tint
            shapes.remove(at: i)
            if same { return }
        }
        shapes.append(shape)
    }

    var nagSymbol: String {
        switch nag {
        case 1: return "!"
        case 2: return "?"
        case 3: return "!!"
        case 4: return "??"
        case 5: return "!?"
        case 6: return "?!"
        default: return ""
        }
    }
}

@Observable
final class Game: Identifiable {
    let id = UUID()
    var tags: [String: String] = [:]
    private(set) var root: GameNode
    var current: GameNode
    /// Bumped whenever the tree (moves, comments, evaluations) changes.
    var revision = 0

    static let tagOrder = ["Event", "Site", "Date", "Round", "White", "Black", "Result"]

    init(start: Position = .start) {
        let node = GameNode(position: start)
        root = node
        current = node
        tags = ["Event": "Casual game", "Site": "Castle", "Date": Game.today(), "Round": "-",
                "White": "White", "Black": "Black", "Result": "*"]
        if start != .start {
            tags["SetUp"] = "1"
            tags["FEN"] = start.fen
        }
        if start.chess960 { tags["Variant"] = "Chess960" }
    }

    static func today() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy.MM.dd"
        return f.string(from: Date())
    }

    var position: Position { current.position }
    var isChess960: Bool { root.position.chess960 }

    func touch() { revision &+= 1 }

    // MARK: Editing

    /// Plays a move from the current node. Follows an existing branch when there is
    /// one, otherwise adds a new one.
    @discardableResult
    func play(_ move: Move) -> GameNode {
        if let existing = current.children.first(where: { $0.move == move }) {
            current = existing
            return existing
        }
        let node = GameNode(position: current.position.applying(move), move: move,
                            san: current.position.san(move), parent: current)
        current.children.append(node)
        current = node
        touch()
        return node
    }

    @discardableResult
    func play(uci: String) -> GameNode? {
        guard let m = current.position.move(uci: uci) else { return nil }
        return play(m)
    }

    /// Appends a node without moving `current`; used while parsing.
    func append(_ move: Move, after parent: GameNode) -> GameNode {
        let node = GameNode(position: parent.position.applying(move), move: move,
                            san: parent.position.san(move), parent: parent)
        parent.children.append(node)
        return node
    }

    func delete(_ node: GameNode) {
        guard let parent = node.parent else { return }
        var n: GameNode? = current
        while let x = n {
            if x === node { current = parent; break }
            n = x.parent
        }
        parent.children.removeAll { $0 === node }
        touch()
    }

    func promote(_ node: GameNode) {
        var n = node
        while let p = n.parent {
            if let i = p.children.firstIndex(where: { $0 === n }), i > 0 {
                p.children.remove(at: i)
                p.children.insert(n, at: 0)
                break
            }
            n = p
        }
        touch()
    }

    // MARK: Navigation

    func back() { if let p = current.parent { current = p } }
    func forward() { if let c = current.children.first { current = c } }
    func toStart() { current = root }
    func toEnd() { while let c = current.children.first { current = c } }
    func go(to node: GameNode) { current = node }

    var mainline: [GameNode] {
        var out: [GameNode] = []
        var n = root
        while let c = n.children.first {
            out.append(c)
            n = c
        }
        return out
    }

    var lastMainlineNode: GameNode { mainline.last ?? root }

    func path(to node: GameNode) -> [GameNode] {
        var out: [GameNode] = []
        var n: GameNode? = node
        while let x = n, x.parent != nil {
            out.append(x)
            n = x.parent
        }
        return out.reversed()
    }

    /// The UCI `position` command describing the route to a node.
    func positionCommand(for node: GameNode) -> String {
        let moves = path(to: node).compactMap { $0.move?.uci }
        var cmd = root.position == .start ? "position startpos" : "position fen \(root.position.fen)"
        if !moves.isEmpty { cmd += " moves " + moves.joined(separator: " ") }
        return cmd
    }

    // MARK: Rules

    func outcome(at node: GameNode) -> GameOutcome? {
        let p = node.position
        if p.legalMoves().isEmpty {
            return p.inCheck ? .checkmate(winner: p.turn.opposite) : .stalemate
        }
        if p.hasInsufficientMaterial { return .insufficientMaterial }
        if p.halfmoveClock >= 100 { return .fiftyMoves }
        var seen = 1
        let key = p.epd
        var n = node.parent
        while let x = n {
            if x.position.epd == key { seen += 1 }
            n = x.parent
        }
        return seen >= 3 ? .repetition : nil
    }

    var result: String {
        get { tags["Result"] ?? "*" }
        set { tags["Result"] = newValue; touch() }
    }

    func copy() -> Game { PGN.parseGame(PGN.write(self)) ?? Game() }
}
