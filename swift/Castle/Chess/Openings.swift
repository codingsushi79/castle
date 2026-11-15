import Foundation
import Observation

struct Opening: Hashable {
    let eco: String
    let name: String
}

/// Named opening lines, looked up by position so transpositions are recognised.
@Observable
final class OpeningBook {
    private(set) var isLoaded = false
    @ObservationIgnored private var byPosition: [String: Opening] = [:]
    /// Short named lines (as UCI moves) used to start engine matches from varied positions.
    @ObservationIgnored private(set) var startingLines: [(name: String, moves: [String])] = []

    func load() {
        guard let url = Bundle.main.url(forResource: "openings", withExtension: "tsv") else { return }
        DispatchQueue.global(qos: .utility).async {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
            var table: [String: Opening] = [:]
            var lines: [(name: String, moves: [String])] = []
            for line in text.split(separator: "\n").dropFirst() {
                let cols = line.split(separator: "\t")
                guard cols.count == 3 else { continue }
                var p = Position.start
                var ok = true
                var ucis: [String] = []
                for token in cols[2].split(separator: " ") where !token.hasSuffix(".") {
                    guard let m = p.move(san: String(token)) else { ok = false; break }
                    ucis.append(m.uci)
                    p.apply(m)
                }
                if ok {
                    table[p.epd] = Opening(eco: String(cols[0]), name: String(cols[1]))
                    if ucis.count >= 4, ucis.count <= 8 { lines.append((String(cols[1]), ucis)) }
                }
            }
            DispatchQueue.main.async {
                self.byPosition = table
                self.startingLines = lines
                self.isLoaded = true
            }
        }
    }

    /// The deepest named position on the way to a node.
    func opening(for node: GameNode) -> Opening? {
        guard isLoaded else { return nil }
        var n: GameNode? = node
        while let x = n {
            if x.position.ply <= 40, let o = byPosition[x.position.epd] { return o }
            n = x.parent
        }
        return nil
    }
}
