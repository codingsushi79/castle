import Foundation

struct Puzzle: Identifiable, Hashable, Codable {
    let id: String
    let fen: String
    let moves: [String]      // the opponent's setup move, then the solution
    let rating: Int
    let themes: [String]
    var source: String? = nil

    static func parse(tsv text: String) -> [Puzzle] {
        var list: [Puzzle] = []
        for line in text.split(separator: "\n") {
            let c = line.split(separator: "\t")
            guard c.count >= 5, let rating = Int(c[3]) else { continue }
            list.append(Puzzle(id: String(c[0]), fen: String(c[1]),
                               moves: c[2].split(separator: " ").map(String.init),
                               rating: rating, themes: c[4].split(separator: " ").map(String.init)))
        }
        return list
    }

    static func loadBundled(_ bundle: Bundle = .main) -> [Puzzle] {
        guard let url = bundle.url(forResource: "puzzles", withExtension: "tsv"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(tsv: text)
    }

    /// The position the solver sees, after the opponent's setup move.
    var shown: (position: Position, lastMove: Move)? {
        guard var p = Position(fen: fen), let first = moves.first, let m = p.move(uci: first) else { return nil }
        p.apply(m)
        return (p, m)
    }

    var solution: [String] { Array(moves.dropFirst()) }
}

/// The same puzzle for everyone on a given day: short and not too hard.
enum DailyPuzzle {
    static func dayNumber(_ date: Date = Date()) -> Int {
        Int(date.timeIntervalSince1970 / 86400 + Double(TimeZone.current.secondsFromGMT(for: date)) / 86400)
    }

    static func pick(from all: [Puzzle], on date: Date = Date()) -> Puzzle? {
        let pool = all.filter { $0.rating >= 1000 && $0.rating <= 1900 && $0.moves.count <= 6 }
        guard !pool.isEmpty else { return all.first }
        // A fixed multiplier spreads consecutive days across the list.
        return pool[(dayNumber(date) &* 2654435761) % pool.count]
    }
}
