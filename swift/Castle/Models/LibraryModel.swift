import CoreSpotlight
import Foundation
import Observation

struct MoveStat: Hashable {
    var white = 0, draws = 0, black = 0
}

struct PositionFilter: Equatable {
    var label: String
    var ids: Set<UUID>
}

extension PGNEntry {
    /// Identifies the game to Spotlight across launches.
    var spotlightID: String { "game-" + String(text.stableHash, radix: 36) }

    /// Two downloads of the same game produce the same key.
    var dedupeKey: String {
        [white, black, date, tags["UTCTime"] ?? tags["EndTime"] ?? tags["Round"] ?? "", tags["Site"] ?? tags["Link"] ?? "", result]
            .joined(separator: "|")
    }
}

/// The saved-games collection, kept as one PGN file in Application Support, with an
/// in-memory index of every position for the opening explorer and position search.
@Observable
final class LibraryModel {
    var entries: [PGNEntry] = []
    var isIndexing = false
    var indexRevision = 0
    var filter: PositionFilter?
    var isSearching = false

    @ObservationIgnored private var moveIndex: [UInt64: [String: MoveStat]] = [:]
    @ObservationIgnored private var gameIndex: [UInt64: [UUID]] = [:]
    @ObservationIgnored private var generation = 0

    @ObservationIgnored private let url: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Castle", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("Library.pgn")
    }()

    init() {
        if let text = try? String(contentsOf: url, encoding: .utf8) { entries = PGN.split(text) }
        reindex()
    }

    func add(_ game: Game) {
        let text = PGN.write(game)
        if let entry = PGN.split(text).first {
            entries.insert(entry, at: 0)
            changed()
        }
    }

    @discardableResult
    func importFile(_ file: URL) -> Int {
        guard let data = try? Data(contentsOf: file),
              let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { return 0 }
        return importText(text, dedupe: false)
    }

    /// Adds every game in a block of PGN. With `dedupe`, games already present are skipped.
    @discardableResult
    func importText(_ text: String, dedupe: Bool) -> Int {
        var new = PGN.split(text)
        if dedupe {
            var known = Set(entries.map(\.dedupeKey))
            new = new.filter { known.insert($0.dedupeKey).inserted }
        }
        guard !new.isEmpty else { return 0 }
        entries.insert(contentsOf: new, at: 0)
        changed()
        return new.count
    }

    func remove(_ ids: Set<PGNEntry.ID>) {
        entries.removeAll { ids.contains($0.id) }
        if let f = filter { filter = PositionFilter(label: f.label, ids: f.ids.subtracting(ids)) }
        changed()
    }

    private func changed() {
        let text = entries.map(\.text).joined(separator: "\n\n") + "\n"
        try? text.write(to: url, atomically: true, encoding: .utf8)
        reindex()
    }

    // MARK: Position index

    private func reindex() {
        generation += 1
        let token = generation
        let snapshot = entries
        isIndexing = true
        DispatchQueue.global(qos: .utility).async {
            var moves: [UInt64: [String: MoveStat]] = [:]
            var games: [UInt64: [UUID]] = [:]
            for entry in snapshot {
                let game = PGN.parse(entry)
                let result = entry.result
                var seen = Set<UInt64>()
                var node = game.root
                while true {
                    let key = node.position.epd.stableHash
                    if seen.insert(key).inserted { games[key, default: []].append(entry.id) }
                    guard let next = node.children.first else { break }
                    let san = next.san.trimmingCharacters(in: CharacterSet(charactersIn: "+#"))
                    var stat = moves[key]?[san] ?? MoveStat()
                    switch result {
                    case "1-0": stat.white += 1
                    case "0-1": stat.black += 1
                    case "1/2-1/2": stat.draws += 1
                    default: break
                    }
                    moves[key, default: [:]][san] = stat
                    node = next
                }
            }
            DispatchQueue.main.async {
                guard token == self.generation else { return }
                self.moveIndex = moves
                self.gameIndex = games
                self.isIndexing = false
                self.indexRevision += 1
            }
            Self.indexForSpotlight(snapshot)
        }
    }

    /// How the games in the library continued from a position.
    func explorer(for position: Position) -> ExplorerResult {
        let _ = indexRevision
        let stats = moveIndex[position.epd.stableHash] ?? [:]
        let moves = stats.map { ExplorerMove(san: $0.key, white: $0.value.white, draws: $0.value.draws, black: $0.value.black) }
            .sorted { ($0.total, $1.san) > ($1.total, $0.san) }
        return ExplorerResult(moves: moves)
    }

    func games(reaching position: Position) -> Set<UUID> {
        let _ = indexRevision
        return Set(gameIndex[position.epd.stableHash] ?? [])
    }

    func filterExact(_ position: Position) {
        filter = PositionFilter(label: "Exact position", ids: games(reaching: position))
    }

    /// Finds games in which every piece of the pattern stood on its square at the same time.
    func filterPartial(_ pattern: [Piece?]) {
        let wanted = pattern.enumerated().compactMap { i, p in p.map { (i, $0) } }
        guard !wanted.isEmpty else { return }
        let snapshot = entries
        isSearching = true
        DispatchQueue.global(qos: .userInitiated).async {
            var hits = Set<UUID>()
            for entry in snapshot {
                let game = PGN.parse(entry)
                var node: GameNode? = game.root
                while let n = node {
                    if wanted.allSatisfy({ n.position.board[$0.0] == $0.1 }) {
                        hits.insert(entry.id)
                        break
                    }
                    node = n.children.first
                }
            }
            DispatchQueue.main.async {
                self.isSearching = false
                self.filter = PositionFilter(label: "Pattern of \(wanted.count) piece\(wanted.count == 1 ? "" : "s")", ids: hits)
            }
        }
    }

    // MARK: Statistics

    struct PlayerRecord {
        var games = 0, wins = 0, draws = 0, losses = 0
        var score: Double { games == 0 ? 0 : (Double(wins) + Double(draws) / 2) / Double(games) }
    }

    var players: [(name: String, games: Int)] {
        var counts: [String: Int] = [:]
        for e in entries {
            counts[e.white, default: 0] += 1
            counts[e.black, default: 0] += 1
        }
        return counts.filter { $0.key != "?" }.map { ($0.key, $0.value) }.sorted { ($0.1, $1.0) > ($1.1, $0.0) }
    }

    /// Results for one player: overall, by colour, and by opening.
    func record(for player: String) -> (white: PlayerRecord, black: PlayerRecord, openings: [(name: String, record: PlayerRecord)]) {
        var white = PlayerRecord(), black = PlayerRecord()
        var byOpening: [String: PlayerRecord] = [:]
        for e in entries where e.white == player || e.black == player {
            let isWhite = e.white == player
            let won = (e.result == "1-0" && isWhite) || (e.result == "0-1" && !isWhite)
            let drawn = e.result == "1/2-1/2"
            let lost = !won && !drawn && e.result != "*"
            func bump(_ r: inout PlayerRecord) {
                r.games += 1
                if won { r.wins += 1 }
                if drawn { r.draws += 1 }
                if lost { r.losses += 1 }
            }
            if isWhite { bump(&white) } else { bump(&black) }
            let opening = (e.tags["Opening"] ?? e.tags["ECO"] ?? "Unknown").components(separatedBy: ":").first ?? "Unknown"
            bump(&byOpening[opening, default: PlayerRecord()])
        }
        let list = byOpening.map { ($0.key, $0.value) }.sorted { ($0.1.games, $1.0) > ($1.1.games, $0.0) }
        return (white, black, list)
    }

    // MARK: Spotlight

    private static func indexForSpotlight(_ entries: [PGNEntry]) {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        let items = entries.prefix(5000).map { e -> CSSearchableItem in
            let attrs = CSSearchableItemAttributeSet(contentType: .text)
            attrs.title = "\(e.white) – \(e.black)"
            attrs.contentDescription = [e.result, e.event, e.opening, e.date].filter { !$0.isEmpty }.joined(separator: " · ")
            attrs.keywords = ["chess", "PGN", e.white, e.black, e.opening]
            return CSSearchableItem(uniqueIdentifier: e.spotlightID, domainIdentifier: "games", attributeSet: attrs)
        }
        let index = CSSearchableIndex.default()
        index.deleteSearchableItems(withDomainIdentifiers: ["games"]) { _ in
            index.indexSearchableItems(Array(items)) { _ in }
        }
    }
}
