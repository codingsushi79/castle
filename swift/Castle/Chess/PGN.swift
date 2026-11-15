import Foundation

/// One game in a PGN file, kept as raw text until it is opened.
struct PGNEntry: Identifiable, Hashable {
    let id = UUID()
    var tags: [String: String]
    var text: String

    var white: String { tags["White"] ?? "?" }
    var black: String { tags["Black"] ?? "?" }
    var result: String { tags["Result"] ?? "*" }
    var date: String { tags["Date"] ?? "" }
    var event: String { tags["Event"] ?? "" }
    var opening: String { tags["Opening"] ?? tags["ECO"] ?? "" }
}

enum PGN {
    // MARK: Reading

    static func split(_ text: String) -> [PGNEntry] {
        var entries: [PGNEntry] = []
        var lines: [Substring] = []
        var tags: [String: String] = [:]
        var sawMoves = false

        func flush() {
            let body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty { entries.append(PGNEntry(tags: tags, text: body)) }
            lines = []
            tags = [:]
            sawMoves = false
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("["), trimmed.hasSuffix("]"), let tag = parseTag(trimmed) {
                if sawMoves { flush() }
                tags[tag.0] = tag.1
            } else if !trimmed.isEmpty {
                sawMoves = true
            }
            lines.append(line)
        }
        flush()
        return entries
    }

    private static func parseTag(_ line: String) -> (String, String)? {
        let inner = line.dropFirst().dropLast()
        guard let space = inner.firstIndex(of: " ") else { return nil }
        let name = String(inner[..<space])
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
        var value = inner[inner.index(after: space)...].trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("\"") { value.removeFirst() }
        if value.hasSuffix("\"") { value.removeLast() }
        value = value.replacingOccurrences(of: "\\\"", with: "\"")
        return (name, value)
    }

    static func parseGame(_ text: String) -> Game? {
        split(text).first.map(parse)
    }

    static func parse(_ entry: PGNEntry) -> Game {
        var start = Position.start
        if let fen = entry.tags["FEN"], let p = Position(fen: fen) { start = p }
        if let v = entry.tags["Variant"]?.lowercased(), v.contains("960") || v.contains("fischer") { start.chess960 = true }
        let game = Game(start: start)
        game.tags = entry.tags
        if game.tags["Result"] == nil { game.tags["Result"] = "*" }

        // Movetext is everything that is not a tag line.
        let body = entry.text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { line in
                let t = line.trimmingCharacters(in: .whitespaces)
                return !(t.hasPrefix("[") && t.hasSuffix("]") && parseTag(t) != nil) && !t.hasPrefix("%")
            }
            .joined(separator: "\n")
        let chars = Array(body)
        var i = 0
        var cursor = game.root
        var stack: [GameNode] = []

        func attach(comment raw: String) {
            var text = raw
            // Pull out embedded commands such as [%clk 0:05:00] and [%eval 0.31].
            while let open = text.range(of: "[%"), let close = text.range(of: "]", range: open.upperBound..<text.endIndex) {
                let command = text[open.upperBound..<close.lowerBound].split(separator: " ", maxSplits: 1)
                if command.count == 2 {
                    let value = String(command[1])
                    if command[0] == "clk" { cursor.clock = value }
                    if command[0] == "csl" || command[0] == "cal" {
                        for item in value.split(separator: ",") {
                            let t = item.trimmingCharacters(in: .whitespaces)
                            guard let tint = BoardShape.Tint(rawValue: String(t.prefix(1))),
                                  let from = Sq.parse(String(t.dropFirst().prefix(2))) else { continue }
                            let to = t.count >= 5 ? Sq.parse(String(t.dropFirst(3).prefix(2))) ?? from : from
                            cursor.shapes.append(BoardShape(from: from, to: to, tint: tint))
                        }
                    }
                    if command[0] == "eval" {
                        if value.hasPrefix("#"), let n = Int(value.dropFirst()) {
                            cursor.eval = .mate(n)
                        } else if let v = Double(value) {
                            cursor.eval = .cp(Int((v * 100).rounded()))
                        }
                    }
                }
                text.removeSubrange(open.lowerBound..<close.upperBound)
            }
            let clean = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            guard !clean.isEmpty else { return }
            cursor.comment = cursor.comment.isEmpty ? clean : cursor.comment + " " + clean
        }

        parsing: while i < chars.count {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            switch c {
            case "{":
                var j = i + 1
                while j < chars.count, chars[j] != "}" { j += 1 }
                attach(comment: String(chars[(i + 1)..<min(j, chars.count)]))
                i = j + 1
            case ";":
                var j = i + 1
                while j < chars.count, chars[j] != "\n" { j += 1 }
                attach(comment: String(chars[(i + 1)..<j]))
                i = j
            case "(":
                stack.append(cursor)
                if let p = cursor.parent { cursor = p }
                i += 1
            case ")":
                if let top = stack.popLast() { cursor = top }
                i += 1
            case "$":
                var j = i + 1
                while j < chars.count, chars[j].isNumber { j += 1 }
                if let n = Int(String(chars[(i + 1)..<j])), n <= 6 { cursor.nag = n }
                i = j
            case "*":
                if stack.isEmpty { break parsing }
                i += 1
            default:
                var j = i
                while j < chars.count, !chars[j].isWhitespace, !"{}();".contains(chars[j]) { j += 1 }
                var token = String(chars[i..<j])
                i = j
                if ["1-0", "0-1", "1/2-1/2", "½-½"].contains(token) {
                    if stack.isEmpty { break parsing }
                    continue
                }
                // Strip a leading move number such as "12." or "12...".
                if let first = token.first, first.isNumber, !token.hasPrefix("0-0") {
                    let rest = token.drop { $0.isNumber }
                    guard rest.hasPrefix(".") else { continue }
                    token = String(rest.drop { $0 == "." })
                }
                if token.isEmpty { continue }
                var nag: Int? = nil
                for (suffix, value) in [("!!", 3), ("??", 4), ("!?", 5), ("?!", 6), ("!", 1), ("?", 2)] where token.hasSuffix(suffix) {
                    nag = value
                    token.removeLast(suffix.count)
                    break
                }
                guard let move = cursor.position.move(san: token) else { break parsing }
                if let existing = cursor.children.first(where: { $0.move == move }) {
                    cursor = existing
                } else {
                    cursor = game.append(move, after: cursor)
                }
                if let nag { cursor.nag = nag }
            }
        }
        game.touch()
        return game
    }

    // MARK: Writing

    static func write(_ game: Game) -> String {
        var out = ""
        var keys = Game.tagOrder.filter { game.tags[$0] != nil }
        keys += game.tags.keys.filter { !Game.tagOrder.contains($0) }.sorted()
        for k in keys {
            let v = (game.tags[k] ?? "").replacingOccurrences(of: "\"", with: "\\\"")
            out += "[\(k) \"\(v)\"]\n"
        }
        out += "\n"
        var tokens: [String] = []
        let rootNotes = game.root.shapeTags + (game.root.comment.isEmpty ? [] : [game.root.comment])
        if !rootNotes.isEmpty { tokens.append("{ " + rootNotes.joined(separator: " ") + " }") }
        writeLine(from: game.root, into: &tokens)
        tokens.append(game.result)

        var line = ""
        for t in tokens {
            if line.count + t.count + 1 > 80 {
                out += line + "\n"
                line = t
            } else {
                line += line.isEmpty ? t : " " + t
            }
        }
        out += line + "\n"
        return out
    }

    private static func moveTokens(_ node: GameNode, numbered: Bool) -> [String] {
        var out: [String] = []
        guard let parent = node.parent else { return out }
        if parent.position.turn == .white {
            out.append("\(parent.position.fullmoveNumber).")
        } else if numbered {
            out.append("\(parent.position.fullmoveNumber)...")
        }
        out.append(node.san + node.nagSymbol)
        var notes: [String] = []
        if let e = node.eval {
            switch e {
            case .cp(let v): notes.append(String(format: "[%%eval %.2f]", Double(v) / 100))
            case .mate(let n): notes.append("[%eval #\(n)]")
            }
        }
        if let c = node.clock { notes.append("[%clk \(c)]") }
        notes += node.shapeTags
        if !node.comment.isEmpty { notes.append(node.comment) }
        if !notes.isEmpty { out.append("{ " + notes.joined(separator: " ") + " }") }
        return out
    }

    private static func writeLine(from start: GameNode, into tokens: inout [String], numberFirst: Bool = true) {
        var parent = start
        var needNumber = numberFirst
        while let main = parent.children.first {
            let toks = Self.moveTokens(main, numbered: needNumber)
            tokens += toks
            needNumber = toks.contains { $0.hasPrefix("{") }
            for alt in parent.children.dropFirst() {
                tokens.append("(")
                tokens += Self.moveTokens(alt, numbered: true)
                writeLine(from: alt, into: &tokens, numberFirst: false)
                tokens.append(")")
                needNumber = true
            }
            parent = main
        }
    }
}
