import Foundation

enum PieceColor: Int, Hashable, Codable {
    case white, black

    var opposite: PieceColor { self == .white ? .black : .white }
    var name: String { self == .white ? "White" : "Black" }
}

enum PieceKind: Int, Hashable, CaseIterable {
    case pawn, knight, bishop, rook, queen, king

    var letter: Character {
        switch self {
        case .pawn: return "P"
        case .knight: return "N"
        case .bishop: return "B"
        case .rook: return "R"
        case .queen: return "Q"
        case .king: return "K"
        }
    }

    init?(letter: Character) {
        switch letter {
        case "P", "p": self = .pawn
        case "N", "n": self = .knight
        case "B", "b": self = .bishop
        case "R", "r": self = .rook
        case "Q", "q": self = .queen
        case "K", "k": self = .king
        default: return nil
        }
    }

    var value: Int {
        switch self {
        case .pawn: return 1
        case .knight, .bishop: return 3
        case .rook: return 5
        case .queen: return 9
        case .king: return 0
        }
    }
}

struct Piece: Hashable {
    var color: PieceColor
    var kind: PieceKind

    var fenChar: Character {
        color == .white ? kind.letter : Character(kind.letter.lowercased())
    }

    init(color: PieceColor, kind: PieceKind) {
        self.color = color
        self.kind = kind
    }

    init?(fenChar: Character) {
        guard let kind = PieceKind(letter: fenChar) else { return nil }
        self.kind = kind
        self.color = fenChar.isUppercase ? .white : .black
    }

    /// Name of the image in the asset catalog, e.g. "wK".
    var assetName: String { (color == .white ? "w" : "b") + String(kind.letter) }
}

/// 0 = a1, 7 = h1, 56 = a8, 63 = h8.
typealias Square = Int

enum Sq {
    static func file(_ s: Square) -> Int { s & 7 }
    static func rank(_ s: Square) -> Int { s >> 3 }
    static func make(file: Int, rank: Int) -> Square { rank * 8 + file }

    static func name(_ s: Square) -> String {
        let files = Array("abcdefgh")
        return "\(files[s & 7])\((s >> 3) + 1)"
    }

    static func parse(_ text: String) -> Square? {
        let chars = Array(text.utf8)
        guard chars.count == 2 else { return nil }
        let f = Int(chars[0]) - 97, r = Int(chars[1]) - 49
        guard (0..<8).contains(f), (0..<8).contains(r) else { return nil }
        return r * 8 + f
    }

    static func isLight(_ s: Square) -> Bool { ((s & 7) + (s >> 3)) % 2 == 1 }
}

struct Move: Hashable {
    let from: Square
    let to: Square
    var promotion: PieceKind? = nil

    var uci: String {
        Sq.name(from) + Sq.name(to) + (promotion.map { String($0.letter).lowercased() } ?? "")
    }

    init(from: Square, to: Square, promotion: PieceKind? = nil) {
        self.from = from
        self.to = to
        self.promotion = promotion
    }

    init?(uci: String) {
        guard uci.count >= 4,
              let from = Sq.parse(String(uci.prefix(2))),
              let to = Sq.parse(String(uci.dropFirst(2).prefix(2))) else { return nil }
        self.from = from
        self.to = to
        if uci.count >= 5, let k = PieceKind(letter: uci[uci.index(uci.startIndex, offsetBy: 4)]) {
            self.promotion = k
        }
    }
}

struct CastlingRights: OptionSet, Hashable {
    let rawValue: Int
    static let whiteKing = CastlingRights(rawValue: 1)
    static let whiteQueen = CastlingRights(rawValue: 2)
    static let blackKing = CastlingRights(rawValue: 4)
    static let blackQueen = CastlingRights(rawValue: 8)
    static let all: CastlingRights = [.whiteKing, .whiteQueen, .blackKing, .blackQueen]
}

/// An engine evaluation, always stored from White's point of view.
enum EngineScore: Hashable {
    case cp(Int)
    case mate(Int)   // positive: White mates in n; negative: Black mates in n

    var negated: EngineScore {
        switch self {
        case .cp(let v): return .cp(-v)
        case .mate(let n): return .mate(-n)
        }
    }

    /// White's winning chances, 0...100.
    var winPercent: Double {
        switch self {
        case .cp(let v):
            let c = Double(max(-2000, min(2000, v)))
            return 50 + 50 * (2 / (1 + exp(-0.00368208 * c)) - 1)
        case .mate(let n):
            return n > 0 ? 100 : 0
        }
    }

    var display: String {
        switch self {
        case .cp(let v):
            if abs(v) >= 90000 { return v > 0 ? "1-0" : "0-1" }
            return String(format: "%+.2f", Double(v) / 100)
        case .mate(let n):
            return n > 0 ? "#\(n)" : "#-\(-n)"
        }
    }

    var short: String {
        switch self {
        case .cp(let v):
            if abs(v) >= 90000 { return "#" }
            return String(format: "%.1f", abs(Double(v)) / 100)
        case .mate(let n):
            return "M\(abs(n))"
        }
    }
}

enum GameOutcome: Equatable {
    case checkmate(winner: PieceColor)
    case stalemate
    case insufficientMaterial
    case fiftyMoves
    case repetition
    case resignation(winner: PieceColor)
    case timeout(winner: PieceColor)
    case drawAgreed

    var result: String {
        switch self {
        case .checkmate(let w), .resignation(let w), .timeout(let w):
            return w == .white ? "1-0" : "0-1"
        default:
            return "1/2-1/2"
        }
    }

    var summary: String {
        switch self {
        case .checkmate(let w): return "\(w.name) wins by checkmate"
        case .stalemate: return "Draw by stalemate"
        case .insufficientMaterial: return "Draw by insufficient material"
        case .fiftyMoves: return "Draw by the fifty-move rule"
        case .repetition: return "Draw by threefold repetition"
        case .resignation(let w): return "\(w.name) wins by resignation"
        case .timeout(let w): return "\(w.name) wins on time"
        case .drawAgreed: return "Draw agreed"
        }
    }
}

/// An arrow or circle drawn on the board. A circle has the same start and end.
struct BoardShape: Hashable {
    enum Tint: String, CaseIterable { case green = "G", red = "R", blue = "B", yellow = "Y" }
    var from: Square
    var to: Square
    var tint: Tint = .green

    var isCircle: Bool { from == to }
}

extension String {
    /// FNV-1a: the same value on every launch, unlike `hashValue`.
    var stableHash: UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for b in utf8 {
            h ^= UInt64(b)
            h = h &* 0x100000001b3
        }
        return h
    }
}
