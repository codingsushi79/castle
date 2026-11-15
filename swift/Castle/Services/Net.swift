import Foundation
import Security

/// Stores small secrets such as the Lichess token in the login keychain.
enum Keychain {
    private static let service = "app.castle.Castle"

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: key, kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ key: String, _ value: String?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }
}

enum Net {
    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.httpAdditionalHeaders = ["User-Agent": "Castle-macOS"]
        return URLSession(configuration: c)
    }()

    struct Failure: LocalizedError {
        var status: Int
        var errorDescription: String? {
            switch status {
            case 401: return "Not authorised. Check your Lichess token."
            case 404: return "Not found."
            case 429: return "Too many requests. Try again in a minute."
            default: return "The server answered with status \(status)."
            }
        }
    }

    static func request(_ url: URL, method: String = "GET", token: String? = nil, accept: String? = nil,
                        form: [String: String]? = nil) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let accept { r.setValue(accept, forHTTPHeaderField: "Accept") }
        if let form {
            var parts = URLComponents()
            parts.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
            r.httpBody = (parts.percentEncodedQuery ?? "").data(using: .utf8)
            r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    static func data(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure(status: status) }
        return data
    }

    static func json(_ request: URLRequest) async throws -> [String: Any] {
        let data = try await data(request)
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    static func url(_ base: String, _ query: [String: String] = [:]) -> URL {
        var c = URLComponents(string: base)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }
}

// MARK: Opening explorer

struct ExplorerMove: Identifiable, Hashable {
    var id: String { san }
    var san: String
    var white = 0
    var draws = 0
    var black = 0
    var averageRating: Int? = nil

    var total: Int { white + draws + black }
}

struct ExplorerResult: Hashable {
    var moves: [ExplorerMove] = []
    var total: Int { moves.reduce(0) { $0 + $1.total } }
}

enum ExplorerSource: String, CaseIterable, Identifiable {
    case library = "Library", lichess = "Lichess", masters = "Masters"
    var id: String { rawValue }
}

enum ExplorerService {
    private static var cache: [String: ExplorerResult] = [:]

    /// Lichess's opening explorer. It needs a signed-in account.
    static func fetch(_ source: ExplorerSource, fen: String, token: String) async throws -> ExplorerResult {
        let key = source.rawValue + fen
        if let hit = cache[key] { return hit }
        let base = source == .masters ? "https://explorer.lichess.ovh/masters" : "https://explorer.lichess.ovh/lichess"
        var query = ["fen": fen, "topGames": "0", "recentGames": "0", "moves": "14"]
        if source == .lichess { query["speeds"] = "blitz,rapid,classical"; query["ratings"] = "1600,1800,2000,2200,2500" }
        let obj = try await Net.json(Net.request(Net.url(base, query), token: token))
        var result = ExplorerResult()
        for m in obj["moves"] as? [[String: Any]] ?? [] {
            result.moves.append(ExplorerMove(san: m["san"] as? String ?? "", white: m["white"] as? Int ?? 0,
                                             draws: m["draws"] as? Int ?? 0, black: m["black"] as? Int ?? 0,
                                             averageRating: m["averageRating"] as? Int))
        }
        cache[key] = result
        return result
    }
}

// MARK: Endgame tablebase

struct TablebaseMove: Identifiable, Hashable {
    var id: String { san }
    var san: String
    var uci: String
    /// The result for the side making the move.
    var verdict: String
    var dtz: Int?
    var dtm: Int?
}

struct TablebaseResult: Hashable {
    var verdict: String
    var dtz: Int?
    var dtm: Int?
    var moves: [TablebaseMove]
}

enum TablebaseService {
    private static var cache: [String: TablebaseResult] = [:]

    static func verdictText(_ category: String) -> String {
        switch category {
        case "win": return "Win"
        case "loss": return "Loss"
        case "draw": return "Draw"
        case "cursed-win": return "Win, but drawn by the 50-move rule"
        case "blessed-loss": return "Loss, saved by the 50-move rule"
        case "maybe-win": return "Probably a win"
        case "maybe-loss": return "Probably a loss"
        default: return "Unknown"
        }
    }

    private static func flip(_ category: String) -> String {
        switch category {
        case "win": return "loss"
        case "loss": return "win"
        case "cursed-win": return "blessed-loss"
        case "blessed-loss": return "cursed-win"
        case "maybe-win": return "maybe-loss"
        case "maybe-loss": return "maybe-win"
        default: return category
        }
    }

    /// Perfect-play results for positions with seven pieces or fewer.
    static func fetch(fen: String) async throws -> TablebaseResult {
        if let hit = cache[fen] { return hit }
        let obj = try await Net.json(Net.request(Net.url("https://tablebase.lichess.ovh/standard", ["fen": fen])))
        var result = TablebaseResult(verdict: obj["category"] as? String ?? "unknown", dtz: obj["dtz"] as? Int,
                                     dtm: obj["dtm"] as? Int, moves: [])
        for m in obj["moves"] as? [[String: Any]] ?? [] {
            result.moves.append(TablebaseMove(san: m["san"] as? String ?? "", uci: m["uci"] as? String ?? "",
                                              verdict: flip(m["category"] as? String ?? "unknown"),
                                              dtz: (m["dtz"] as? Int).map { -$0 }, dtm: (m["dtm"] as? Int).map { -$0 }))
        }
        cache[fen] = result
        return result
    }
}
