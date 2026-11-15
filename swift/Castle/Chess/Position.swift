import Foundation

struct Position: Hashable {
    var board: [Piece?] = Array(repeating: nil, count: 64)
    var turn: PieceColor = .white
    var castling: CastlingRights = []
    var epSquare: Square? = nil
    var halfmoveClock = 0
    var fullmoveNumber = 1
    /// Chess960: castling is written as the king capturing its own rook.
    var chess960 = false
    /// Files of the rooks that may still castle (shared by both sides).
    var kRook = 7
    var qRook = 0

    static let startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    static let start = Position(fen: startFEN)!

    init() {}

    // MARK: FEN

    init?(fen: String) {
        let parts = fen.split(separator: " ", omittingEmptySubsequences: true)
        guard let placement = parts.first else { return nil }
        var rank = 7, file = 0
        for ch in placement {
            if ch == "/" {
                rank -= 1
                file = 0
                if rank < 0 { return nil }
            } else if let n = ch.wholeNumberValue {
                file += n
            } else if let p = Piece(fenChar: ch) {
                guard file < 8 else { return nil }
                board[rank * 8 + file] = p
                file += 1
            } else {
                return nil
            }
        }
        guard rank == 0 else { return nil }
        if parts.count > 1 { turn = parts[1] == "b" ? .black : .white }
        if parts.count > 2 {
            for ch in parts[2] {
                switch ch {
                case "K": castling.insert(.whiteKing)
                case "Q": castling.insert(.whiteQueen)
                case "k": castling.insert(.blackKing)
                case "q": castling.insert(.blackQueen)
                default:
                    // Shredder-FEN names the rook's file instead.
                    guard ch.isLetter, let a = ch.lowercased().first?.asciiValue, a >= 97, a <= 104 else { break }
                    let white = ch.isUppercase
                    guard let k = kingSquare(white ? .white : .black) else { break }
                    let file = Int(a) - 97
                    if file > (k & 7) {
                        castling.insert(white ? .whiteKing : .blackKing)
                        kRook = file
                    } else {
                        castling.insert(white ? .whiteQueen : .blackQueen)
                        qRook = file
                    }
                    chess960 = true
                }
            }
            normaliseCastling()
        }
        if parts.count > 3, let s = Sq.parse(String(parts[3])) {
            // Keep the en passant square only when a capture is actually possible,
            // so equal positions always compare equal.
            let pawnRank = turn == .white ? 4 : 3
            let f = s & 7
            for df in [-1, 1] where (0..<8).contains(f + df) {
                if board[pawnRank * 8 + f + df] == Piece(color: turn, kind: .pawn) { epSquare = s }
            }
        }
        if parts.count > 4 { halfmoveClock = Int(parts[4]) ?? 0 }
        if parts.count > 5 { fullmoveNumber = max(1, Int(parts[5]) ?? 1) }
        guard kingSquare(.white) != nil, kingSquare(.black) != nil else { return nil }
    }

    /// Drops castling rights that have no king and rook behind them, and switches to
    /// Chess960 rules when the pieces are not on their classical squares.
    private mutating func normaliseCastling() {
        for color in [PieceColor.white, .black] {
            let base = color == .white ? 0 : 56
            let sides: [(CastlingRights, Bool)] = color == .white ? [(.whiteKing, true), (.whiteQueen, false)]
                                                                  : [(.blackKing, true), (.blackQueen, false)]
            let rook = Piece(color: color, kind: .rook)
            guard let k = kingSquare(color), k >> 3 == base >> 3 else {
                for (right, _) in sides { castling.remove(right) }
                continue
            }
            let kf = k & 7
            for (right, kingSide) in sides where castling.contains(right) {
                let file = kingSide ? kRook : qRook
                let onRightSide = kingSide ? file > kf : file < kf
                if onRightSide, board[base + file] == rook {
                    if kf != 4 || file != (kingSide ? 7 : 0) { chess960 = true }
                    continue
                }
                let candidates = kingSide ? Array(stride(from: 7, to: kf, by: -1)) : Array(0..<kf)
                if let found = candidates.first(where: { board[base + $0] == rook }) {
                    if kingSide { kRook = found } else { qRook = found }
                    chess960 = true
                } else {
                    castling.remove(right)
                }
            }
        }
    }

    /// One of the 960 Fischer random starting positions (518 is the classical one).
    static func chess960(_ index: Int) -> Position {
        var n = ((index % 960) + 960) % 960
        var back = [Character?](repeating: nil, count: 8)
        back[(n % 4) * 2 + 1] = "b"; n /= 4
        back[(n % 4) * 2] = "b"; n /= 4
        func place(_ c: Character, at nth: Int) {
            let empties = back.indices.filter { back[$0] == nil }
            back[empties[nth]] = c
        }
        place("q", at: n % 6); n /= 6
        let knights = [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)][n]
        let empties = back.indices.filter { back[$0] == nil }
        back[empties[knights.0]] = "n"
        back[empties[knights.1]] = "n"
        place("r", at: 0); place("k", at: 0); place("r", at: 0)
        let row = String(back.map { $0 ?? "1" })
        var p = Position(fen: "\(row)/pppppppp/8/8/8/8/PPPPPPPP/\(row.uppercased()) w KQkq - 0 1") ?? .start
        p.chess960 = true
        return p
    }

    /// Placement, side to move, castling and en passant: identifies a position for
    /// repetition and opening lookup.
    var epd: String {
        var s = ""
        for rank in stride(from: 7, through: 0, by: -1) {
            var empty = 0
            for file in 0..<8 {
                if let p = board[rank * 8 + file] {
                    if empty > 0 { s += String(empty); empty = 0 }
                    s.append(p.fenChar)
                } else {
                    empty += 1
                }
            }
            if empty > 0 { s += String(empty) }
            if rank > 0 { s += "/" }
        }
        s += turn == .white ? " w " : " b "
        var c = ""
        if castling.contains(.whiteKing) { c += "K" }
        if castling.contains(.whiteQueen) { c += "Q" }
        if castling.contains(.blackKing) { c += "k" }
        if castling.contains(.blackQueen) { c += "q" }
        s += c.isEmpty ? "-" : c
        s += " " + (epSquare.map(Sq.name) ?? "-")
        return s
    }

    var fen: String { "\(epd) \(halfmoveClock) \(fullmoveNumber)" }

    /// Half-moves played since the starting position of a standard game.
    var ply: Int { (fullmoveNumber - 1) * 2 + (turn == .black ? 1 : 0) }

    // MARK: Attacks

    private static let knightSteps = [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)]
    private static let kingSteps = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    private static let diagSteps = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    private static let lineSteps = [(1, 0), (0, 1), (-1, 0), (0, -1)]

    func kingSquare(_ color: PieceColor) -> Square? {
        let king = Piece(color: color, kind: .king)
        return board.firstIndex(of: king)
    }

    func isAttacked(_ sq: Square, by c: PieceColor) -> Bool {
        let f = sq & 7, r = sq >> 3
        let pr = c == .white ? r - 1 : r + 1
        if (0..<8).contains(pr) {
            let pawn = Piece(color: c, kind: .pawn)
            if f > 0, board[pr * 8 + f - 1] == pawn { return true }
            if f < 7, board[pr * 8 + f + 1] == pawn { return true }
        }
        let knight = Piece(color: c, kind: .knight)
        for (df, dr) in Self.knightSteps {
            let nf = f + df, nr = r + dr
            if nf >= 0, nf < 8, nr >= 0, nr < 8, board[nr * 8 + nf] == knight { return true }
        }
        let king = Piece(color: c, kind: .king)
        for (df, dr) in Self.kingSteps {
            let nf = f + df, nr = r + dr
            if nf >= 0, nf < 8, nr >= 0, nr < 8, board[nr * 8 + nf] == king { return true }
        }
        for (df, dr) in Self.diagSteps {
            var nf = f + df, nr = r + dr
            while nf >= 0, nf < 8, nr >= 0, nr < 8 {
                if let p = board[nr * 8 + nf] {
                    if p.color == c, p.kind == .bishop || p.kind == .queen { return true }
                    break
                }
                nf += df; nr += dr
            }
        }
        for (df, dr) in Self.lineSteps {
            var nf = f + df, nr = r + dr
            while nf >= 0, nf < 8, nr >= 0, nr < 8 {
                if let p = board[nr * 8 + nf] {
                    if p.color == c, p.kind == .rook || p.kind == .queen { return true }
                    break
                }
                nf += df; nr += dr
            }
        }
        return false
    }

    var inCheck: Bool {
        guard let k = kingSquare(turn) else { return false }
        return isAttacked(k, by: turn.opposite)
    }

    // MARK: Move generation

    private func pseudoMoves() -> [Move] {
        var out: [Move] = []
        out.reserveCapacity(48)
        for sq in 0..<64 {
            guard let p = board[sq], p.color == turn else { continue }
            let f = sq & 7, r = sq >> 3
            switch p.kind {
            case .pawn:
                let dir = turn == .white ? 1 : -1
                let startRank = turn == .white ? 1 : 6
                let promoRank = turn == .white ? 7 : 0
                let r1 = r + dir
                guard (0..<8).contains(r1) else { continue }
                func add(_ to: Square) {
                    if r1 == promoRank {
                        for k in [PieceKind.queen, .knight, .rook, .bishop] {
                            out.append(Move(from: sq, to: to, promotion: k))
                        }
                    } else {
                        out.append(Move(from: sq, to: to))
                    }
                }
                let fwd = r1 * 8 + f
                if board[fwd] == nil {
                    add(fwd)
                    if r == startRank {
                        let two = (r + 2 * dir) * 8 + f
                        if board[two] == nil { out.append(Move(from: sq, to: two)) }
                    }
                }
                for df in [-1, 1] {
                    let nf = f + df
                    guard nf >= 0, nf < 8 else { continue }
                    let to = r1 * 8 + nf
                    if let t = board[to] {
                        if t.color != turn { add(to) }
                    } else if to == epSquare {
                        out.append(Move(from: sq, to: to))
                    }
                }
            case .knight, .king:
                let steps = p.kind == .knight ? Self.knightSteps : Self.kingSteps
                for (df, dr) in steps {
                    let nf = f + df, nr = r + dr
                    guard nf >= 0, nf < 8, nr >= 0, nr < 8 else { continue }
                    let to = nr * 8 + nf
                    if board[to]?.color != turn { out.append(Move(from: sq, to: to)) }
                }
                if p.kind == .king { addCastling(from: sq, into: &out) }
            case .bishop, .rook, .queen:
                var steps: [(Int, Int)] = []
                if p.kind != .rook { steps += Self.diagSteps }
                if p.kind != .bishop { steps += Self.lineSteps }
                for (df, dr) in steps {
                    var nf = f + df, nr = r + dr
                    while nf >= 0, nf < 8, nr >= 0, nr < 8 {
                        let to = nr * 8 + nf
                        if let t = board[to] {
                            if t.color != turn { out.append(Move(from: sq, to: to)) }
                            break
                        }
                        out.append(Move(from: sq, to: to))
                        nf += df; nr += dr
                    }
                }
            }
        }
        return out
    }

    private func addCastling(from sq: Square, into out: inout [Move]) {
        let base = turn == .white ? 0 : 56
        guard sq >> 3 == base >> 3 else { return }
        if !chess960, sq != base + 4 { return }
        let enemy = turn.opposite
        let rook = Piece(color: turn, kind: .rook)
        for kingSide in [true, false] {
            let right: CastlingRights = turn == .white ? (kingSide ? .whiteKing : .whiteQueen)
                                                       : (kingSide ? .blackKing : .blackQueen)
            guard castling.contains(right) else { continue }
            let rookSq = base + (kingSide ? kRook : qRook)
            guard board[rookSq] == rook else { continue }
            let kingTo = base + (kingSide ? 6 : 2), rookTo = base + (kingSide ? 5 : 3)
            var clear = true
            for s in min(sq, rookSq, kingTo, rookTo)...max(sq, rookSq, kingTo, rookTo)
            where s != sq && s != rookSq && board[s] != nil { clear = false }
            for s in min(sq, kingTo)...max(sq, kingTo) where isAttacked(s, by: enemy) { clear = false }
            if clear { out.append(Move(from: sq, to: chess960 ? rookSq : kingTo)) }
        }
    }

    func legalMoves() -> [Move] {
        let mover = turn
        return pseudoMoves().filter { m in
            var p = self
            p.apply(m)
            guard let k = p.kingSquare(mover) else { return false }
            return !p.isAttacked(k, by: p.turn)
        }
    }

    func isLegal(_ m: Move) -> Bool { legalMoves().contains(m) }

    func isCapture(_ m: Move) -> Bool {
        if isCastling(m) { return false }
        if board[m.to] != nil { return true }
        return board[m.from]?.kind == .pawn && m.to == epSquare && (m.from & 7) != (m.to & 7)
    }

    func isCastling(_ m: Move) -> Bool {
        guard let king = board[m.from], king.kind == .king else { return false }
        if chess960 { return board[m.to] == Piece(color: king.color, kind: .rook) }
        return abs((m.to & 7) - (m.from & 7)) == 2
    }

    func castlesKingside(_ m: Move) -> Bool {
        chess960 ? (m.to & 7) > (m.from & 7) : (m.to & 7) == 6
    }

    /// Where the king and rook end up after a castling move.
    func castlingSquares(_ m: Move) -> (king: Square, rook: Square, rookFrom: Square) {
        let base = (m.from >> 3) * 8
        let kingSide = castlesKingside(m)
        return (base + (kingSide ? 6 : 2), base + (kingSide ? 5 : 3),
                chess960 ? m.to : base + (kingSide ? 7 : 0))
    }

    /// Plays a move without checking legality.
    mutating func apply(_ m: Move) {
        guard let piece = board[m.from] else { return }
        let castle = isCastling(m)
        var capture = board[m.to] != nil && !castle
        if castle {
            let sq = castlingSquares(m)
            let rook = board[sq.rookFrom]
            board[m.from] = nil
            board[sq.rookFrom] = nil
            board[sq.king] = piece
            board[sq.rook] = rook
        } else {
            board[m.from] = nil
            if piece.kind == .pawn, m.to == epSquare, !capture, (m.from & 7) != (m.to & 7) {
                board[(m.from >> 3) * 8 + (m.to & 7)] = nil
                capture = true
            }
            board[m.to] = m.promotion.map { Piece(color: piece.color, kind: $0) } ?? piece
        }

        if piece.kind == .king {
            castling.subtract(piece.color == .white ? [.whiteKing, .whiteQueen] : [.blackKing, .blackQueen])
        }
        for s in [m.from, m.to] {
            if s == kRook { castling.remove(.whiteKing) }
            if s == qRook { castling.remove(.whiteQueen) }
            if s == 56 + kRook { castling.remove(.blackKing) }
            if s == 56 + qRook { castling.remove(.blackQueen) }
        }

        epSquare = nil
        if piece.kind == .pawn, abs(m.to - m.from) == 16 {
            let enemyPawn = Piece(color: piece.color.opposite, kind: .pawn)
            let tf = m.to & 7, tr = m.to >> 3
            if (tf > 0 && board[tr * 8 + tf - 1] == enemyPawn) || (tf < 7 && board[tr * 8 + tf + 1] == enemyPawn) {
                epSquare = (m.from + m.to) / 2
            }
        }
        halfmoveClock = (piece.kind == .pawn || capture) ? 0 : halfmoveClock + 1
        if turn == .black { fullmoveNumber += 1 }
        turn = turn.opposite
    }

    func applying(_ m: Move) -> Position {
        var p = self
        p.apply(m)
        return p
    }

    // MARK: Status

    var isCheckmate: Bool { inCheck && legalMoves().isEmpty }
    var isStalemate: Bool { !inCheck && legalMoves().isEmpty }

    var hasInsufficientMaterial: Bool {
        var minors: [(Piece, Square)] = []
        for sq in 0..<64 {
            guard let p = board[sq] else { continue }
            switch p.kind {
            case .pawn, .rook, .queen: return false
            case .knight, .bishop: minors.append((p, sq))
            case .king: break
            }
        }
        if minors.count <= 1 { return true }
        if minors.allSatisfy({ $0.0.kind == .bishop }) {
            let shade = Sq.isLight(minors[0].1)
            return minors.allSatisfy { Sq.isLight($0.1) == shade }
        }
        return false
    }

    /// Material balance in pawns from White's point of view.
    var materialBalance: Int {
        board.reduce(0) { sum, p in
            guard let p else { return sum }
            return sum + (p.color == .white ? p.kind.value : -p.kind.value)
        }
    }

    var pieceCount: Int { board.reduce(0) { $0 + ($1 == nil ? 0 : 1) } }

    /// The same position with the other side to move, or nil when that is illegal.
    var passed: Position? {
        guard !inCheck else { return nil }
        var p = self
        p.turn = turn.opposite
        p.epSquare = nil
        return p
    }

    /// Whether this could occur in a game: one king each and the side that just moved
    /// is not left in check.
    var isPlayable: Bool {
        guard board.filter({ $0 == Piece(color: .white, kind: .king) }).count == 1,
              board.filter({ $0 == Piece(color: .black, kind: .king) }).count == 1,
              let k = kingSquare(turn.opposite), !isAttacked(k, by: turn) else { return false }
        for s in Array(0..<8) + Array(56..<64) where board[s]?.kind == .pawn { return false }
        return true
    }

    // MARK: Notation

    func san(_ m: Move) -> String {
        guard let piece = board[m.from] else { return m.uci }
        var s = ""
        if isCastling(m) {
            s = castlesKingside(m) ? "O-O" : "O-O-O"
        } else {
            let capture = isCapture(m)
            if piece.kind == .pawn {
                if capture { s.append(Sq.name(m.from).first!) }
            } else {
                s.append(piece.kind.letter)
                let rivals = legalMoves().filter {
                    $0.to == m.to && $0.from != m.from && board[$0.from] == piece
                }
                if !rivals.isEmpty {
                    let name = Sq.name(m.from)
                    if !rivals.contains(where: { ($0.from & 7) == (m.from & 7) }) {
                        s.append(name.first!)
                    } else if !rivals.contains(where: { ($0.from >> 3) == (m.from >> 3) }) {
                        s.append(name.last!)
                    } else {
                        s += name
                    }
                }
            }
            if capture { s += "x" }
            s += Sq.name(m.to)
            if let promo = m.promotion { s += "=\(promo.letter)" }
        }
        let next = applying(m)
        if next.inCheck { s += next.legalMoves().isEmpty ? "#" : "+" }
        return s
    }

    func move(san text: String) -> Move? {
        var t = text.trimmingCharacters(in: CharacterSet(charactersIn: "+#!? \t"))
        t = t.replacingOccurrences(of: "e.p.", with: "")
        guard !t.isEmpty else { return nil }
        let legal = legalMoves()
        let castle = t.replacingOccurrences(of: "0", with: "O")
        if castle == "O-O" || castle == "O-O-O" {
            return legal.first { isCastling($0) && castlesKingside($0) == (castle == "O-O") }
        }
        var chars = Array(t)
        var promotion: PieceKind? = nil
        if let eq = chars.firstIndex(of: "=") {
            if eq + 1 < chars.count { promotion = PieceKind(letter: chars[eq + 1]) }
            chars = Array(chars[..<eq])
        } else if let last = chars.last, last.isLetter, last.isUppercase, chars.count > 2 {
            promotion = PieceKind(letter: last)
            chars.removeLast()
        }
        var kind = PieceKind.pawn
        if let first = chars.first, first.isUppercase, let k = PieceKind(letter: first) {
            kind = k
            chars.removeFirst()
        }
        chars.removeAll { $0 == "x" || $0 == "-" || $0 == ":" }
        guard chars.count >= 2, let to = Sq.parse(String(chars.suffix(2))) else { return nil }
        var fromFile: Int? = nil, fromRank: Int? = nil
        for c in chars.dropLast(2) {
            if let a = c.asciiValue {
                if a >= 97, a <= 104 { fromFile = Int(a) - 97 }
                if a >= 49, a <= 56 { fromRank = Int(a) - 49 }
            }
        }
        let matches = legal.filter { m in
            m.to == to && board[m.from]?.kind == kind && m.promotion == promotion
                && (fromFile == nil || (m.from & 7) == fromFile)
                && (fromRank == nil || (m.from >> 3) == fromRank)
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Resolves a UCI string against the legal moves. Also accepts the king-takes-rook
    /// castling form some engines emit.
    func move(uci text: String) -> Move? {
        guard let raw = Move(uci: text) else { return nil }
        let legal = legalMoves()
        if legal.contains(raw) { return raw }
        if board[raw.from]?.kind == .king,
           chess960 || board[raw.to] == Piece(color: turn, kind: .rook) || abs((raw.to & 7) - (raw.from & 7)) == 2 {
            let kingSide = (raw.to & 7) > (raw.from & 7)
            return legal.first { isCastling($0) && castlesKingside($0) == kingSide }
        }
        return nil
    }

    /// Converts a line of UCI moves into numbered SAN text.
    func sanLine(_ uciMoves: [String], limit: Int = 14) -> String {
        var p = self
        var parts: [String] = []
        for (i, u) in uciMoves.prefix(limit).enumerated() {
            guard let m = p.move(uci: u) else { break }
            if p.turn == .white {
                parts.append("\(p.fullmoveNumber).")
            } else if i == 0 {
                parts.append("\(p.fullmoveNumber)…")
            }
            parts.append(p.san(m))
            p.apply(m)
        }
        return parts.joined(separator: " ")
    }
}
