import Foundation
import Observation

struct ChessAccount: Codable, Identifiable, Hashable {
    enum Site: String, Codable, CaseIterable, Identifiable {
        case lichess = "Lichess", chesscom = "Chess.com"
        var id: String { rawValue }
    }

    var site: Site
    var username: String
    var id: String { "\(site.rawValue)-\(username.lowercased())" }
}

struct AccountRating: Identifiable, Hashable {
    var id: String { label }
    var label: String
    var rating: Int
    var games: Int
}

/// Online accounts whose ratings are shown and whose games can be pulled into the library.
@Observable
final class AccountsModel {
    var accounts: [ChessAccount] = [] { didSet { persist() } }
    var ratings: [String: [AccountRating]] = [:]
    var status: [String: String] = [:]
    var busy: Set<String> = []

    @ObservationIgnored private let library: LibraryModel

    init(library: LibraryModel) {
        self.library = library
        if let data = UserDefaults.standard.data(forKey: "accounts"),
           let list = try? JSONDecoder().decode([ChessAccount].self, from: data) { accounts = list }
        for a in accounts { refresh(a) }
    }

    private func persist() {
        UserDefaults.standard.set(try? JSONEncoder().encode(accounts), forKey: "accounts")
    }

    func add(site: ChessAccount.Site, username: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else { return }
        let account = ChessAccount(site: site, username: name)
        guard !accounts.contains(where: { $0.id == account.id }) else { return }
        accounts.append(account)
        refresh(account)
    }

    func remove(_ account: ChessAccount) {
        accounts.removeAll { $0.id == account.id }
        ratings[account.id] = nil
        status[account.id] = nil
    }

    /// Games in the library played by this account.
    func gameCount(_ account: ChessAccount) -> Int {
        let name = account.username.lowercased()
        return library.entries.filter { $0.white.lowercased() == name || $0.black.lowercased() == name }.count
    }

    func refresh(_ account: ChessAccount) {
        Task { @MainActor in
            do {
                var list: [AccountRating] = []
                switch account.site {
                case .lichess:
                    let obj = try await Net.json(Net.request(URL(string: "https://lichess.org/api/user/\(account.username)")!))
                    let perfs = obj["perfs"] as? [String: [String: Any]] ?? [:]
                    for key in ["bullet", "blitz", "rapid", "classical", "puzzle"] {
                        if let p = perfs[key], let r = p["rating"] as? Int, let g = p["games"] as? Int, g > 0 {
                            list.append(AccountRating(label: key.capitalized, rating: r, games: g))
                        }
                    }
                case .chesscom:
                    let obj = try await Net.json(Net.request(URL(string: "https://api.chess.com/pub/player/\(account.username.lowercased())/stats")!))
                    for (key, label) in [("chess_bullet", "Bullet"), ("chess_blitz", "Blitz"), ("chess_rapid", "Rapid"), ("chess_daily", "Daily")] {
                        guard let p = obj[key] as? [String: Any], let last = p["last"] as? [String: Any],
                              let r = last["rating"] as? Int else { continue }
                        let rec = p["record"] as? [String: Any] ?? [:]
                        let games = (rec["win"] as? Int ?? 0) + (rec["loss"] as? Int ?? 0) + (rec["draw"] as? Int ?? 0)
                        list.append(AccountRating(label: label, rating: r, games: games))
                    }
                }
                self.ratings[account.id] = list
                if self.status[account.id]?.hasPrefix("Could not") ?? false { self.status[account.id] = nil }
            } catch {
                self.status[account.id] = "Could not load ratings: \(error.localizedDescription)"
            }
        }
    }

    /// Downloads the account's most recent games into the library, skipping ones already there.
    func download(_ account: ChessAccount, max: Int) {
        guard !busy.contains(account.id) else { return }
        busy.insert(account.id)
        status[account.id] = "Downloading…"
        Task { @MainActor in
            defer { self.busy.remove(account.id) }
            do {
                var pgn = ""
                switch account.site {
                case .lichess:
                    let url = Net.url("https://lichess.org/api/games/user/\(account.username)",
                                      ["max": String(max), "opening": "true", "clocks": "false", "evals": "false"])
                    pgn = String(data: try await Net.data(Net.request(url, token: LichessModel.token, accept: "application/x-chess-pgn")),
                                 encoding: .utf8) ?? ""
                case .chesscom:
                    let base = "https://api.chess.com/pub/player/\(account.username.lowercased())/games/archives"
                    let archives = (try await Net.json(Net.request(URL(string: base)!)))["archives"] as? [String] ?? []
                    var count = 0
                    for archive in archives.reversed() {
                        guard count < max, let url = URL(string: archive + "/pgn") else { break }
                        let text = String(data: try await Net.data(Net.request(url)), encoding: .utf8) ?? ""
                        count += text.components(separatedBy: "[Event ").count - 1
                        pgn += text + "\n\n"
                        self.status[account.id] = "Downloading… \(count) games"
                    }
                }
                let added = self.library.importText(pgn, dedupe: true)
                self.status[account.id] = added == 0 ? "Already up to date." : "Added \(added) new game\(added == 1 ? "" : "s")."
            } catch {
                self.status[account.id] = "Download failed: \(error.localizedDescription)"
            }
        }
    }
}
