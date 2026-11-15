import Foundation
import Observation

/// Plays on Lichess through its Board API with a personal access token.
@Observable
final class LichessModel {
    enum State { case signedOut, connecting, online }

    var state: State = .signedOut
    var username = ""
    var ratings: [(name: String, rating: Int, games: Int)] = []
    var errorText: String?
    var isSeeking = false

    var gameID: String?
    var game = Game()
    var myColor: PieceColor = .white
    var whiteName = "White"
    var blackName = "Black"
    var clocks: [PieceColor: Double] = [.white: 0, .black: 0]
    var hasClock = false
    var isPlaying = false
    var resultText: String?
    var premove: Move?
    var pendingMove: Move?
    var confirmMoves = UserDefaults.standard.bool(forKey: "lichessConfirmMoves") {
        didSet { UserDefaults.standard.set(confirmMoves, forKey: "lichessConfirmMoves") }
    }

    var onFinished: ((Game) -> Void)?

    @ObservationIgnored private var userID = ""
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var gameTask: Task<Void, Never>?
    @ObservationIgnored private var seekTask: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastTick = Date()

    private static let streaming: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 3600
        c.httpAdditionalHeaders = ["User-Agent": "Castle-macOS"]
        return URLSession(configuration: c)
    }()

    /// The saved token, also used for the Lichess opening explorer.
    static var token: String? {
        if !tokenLoaded {
            cachedToken = Keychain.get("lichessToken")
            tokenLoaded = true
        }
        return cachedToken
    }
    private static var cachedToken: String?
    private static var tokenLoaded = false

    var hasToken: Bool { Self.token != nil }

    init() {
        if hasToken { connect() }
    }

    // MARK: Account

    func signIn(token: String) {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Keychain.set("lichessToken", t)
        Self.cachedToken = t
        connect()
    }

    func signOut() {
        disconnect()
        Keychain.set("lichessToken", nil)
        Self.cachedToken = nil
        username = ""
        ratings = []
    }

    func disconnect() {
        eventTask?.cancel()
        gameTask?.cancel()
        seekTask?.cancel()
        timer?.invalidate()
        timer = nil
        isSeeking = false
        state = .signedOut
    }

    func connect() {
        guard let token = Self.token, state == .signedOut else { return }
        state = .connecting
        errorText = nil
        Task { @MainActor in
            do {
                let me = try await Net.json(Net.request(URL(string: "https://lichess.org/api/account")!, token: token))
                self.userID = me["id"] as? String ?? ""
                self.username = me["username"] as? String ?? self.userID
                let perfs = me["perfs"] as? [String: [String: Any]] ?? [:]
                self.ratings = ["bullet", "blitz", "rapid", "classical"].compactMap { key in
                    guard let p = perfs[key], let r = p["rating"] as? Int else { return nil }
                    return (key.capitalized, r, p["games"] as? Int ?? 0)
                }
                self.state = .online
                self.listenForEvents(token)
                self.timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
            } catch {
                self.errorText = error.localizedDescription
                self.state = .signedOut
            }
        }
    }

    private func lines(_ request: URLRequest, _ handle: @escaping ([String: Any]) -> Void) async {
        do {
            let (bytes, response) = try await Self.streaming.bytes(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                await MainActor.run { self.errorText = Net.Failure(status: http.statusCode).errorDescription }
                return
            }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8),
                      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
                await MainActor.run { handle(obj) }
            }
        } catch {}
    }

    private func listenForEvents(_ token: String) {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            let req = Net.request(URL(string: "https://lichess.org/api/stream/event")!, token: token)
            await self?.lines(req) { event in
                guard let self, event["type"] as? String == "gameStart", let g = event["game"] as? [String: Any],
                      let id = g["gameId"] as? String ?? g["id"] as? String else { return }
                if self.gameID != id || !self.isPlaying { self.open(id) }
            }
        }
    }

    // MARK: Games

    private func open(_ id: String) {
        guard let token = Self.token else { return }
        isSeeking = false
        seekTask?.cancel()
        gameID = id
        resultText = nil
        premove = nil
        pendingMove = nil
        gameTask?.cancel()
        gameTask = Task { [weak self] in
            let req = Net.request(URL(string: "https://lichess.org/api/board/game/stream/\(id)")!, token: token)
            await self?.lines(req) { self?.handleGame($0) }
        }
    }

    private func playerName(_ p: [String: Any]?) -> String {
        guard let p else { return "?" }
        if let level = p["aiLevel"] as? Int { return "Stockfish level \(level)" }
        let name = p["name"] as? String ?? "Anonymous"
        if let r = p["rating"] as? Int { return "\(name) (\(r))" }
        return name
    }

    private func handleGame(_ obj: [String: Any]) {
        switch obj["type"] as? String {
        case "gameFull":
            let white = obj["white"] as? [String: Any], black = obj["black"] as? [String: Any]
            whiteName = playerName(white)
            blackName = playerName(black)
            myColor = (black?["id"] as? String) == userID ? .black : .white
            var start = Position.start
            if let fen = obj["initialFen"] as? String, fen != "startpos", let p = Position(fen: fen) { start = p }
            let g = Game(start: start)
            g.tags["Event"] = "Lichess game"
            g.tags["Site"] = "https://lichess.org/\(gameID ?? "")"
            g.tags["White"] = whiteName
            g.tags["Black"] = blackName
            game = g
            hasClock = obj["clock"] != nil && !(obj["clock"] is NSNull)
            isPlaying = true
            if let state = obj["state"] as? [String: Any] { apply(state) }
        case "gameState":
            apply(obj)
        default:
            break
        }
    }

    private func apply(_ state: [String: Any]) {
        let moves = (state["moves"] as? String ?? "").split(separator: " ").map(String.init)
        game.toEnd()
        let known = game.mainline.count
        if moves.count < known {
            // A takeback: rebuild from the start.
            let g = Game(start: game.root.position)
            g.tags = game.tags
            game = g
        }
        for uci in moves.dropFirst(game.mainline.count) {
            guard let node = game.play(uci: uci) else { break }
            Sound.play(for: node)
        }
        clocks[.white] = Double(state["wtime"] as? Int ?? 0) / 1000
        clocks[.black] = Double(state["btime"] as? Int ?? 0) / 1000
        lastTick = Date()
        pendingMove = nil

        let status = state["status"] as? String ?? "started"
        if status != "started", status != "created" {
            guard isPlaying else { return }
            isPlaying = false
            premove = nil
            let winner = state["winner"] as? String
            game.result = winner == "white" ? "1-0" : winner == "black" ? "0-1" : (status == "aborted" ? "*" : "1/2-1/2")
            let reasons = ["mate": "Checkmate", "resign": "Resignation", "outoftime": "Time out", "draw": "Draw",
                           "stalemate": "Stalemate", "aborted": "Game aborted", "timeout": "Opponent left"]
            resultText = "\(reasons[status] ?? status.capitalized) · \(game.result)"
            game.tags["Termination"] = reasons[status] ?? status
            Sound.gameEnd()
            onFinished?(game)
            return
        }
        if game.position.turn == myColor, let queued = premove {
            premove = nil
            if let legal = game.position.legalMoves().first(where: { $0.from == queued.from && $0.to == queued.to
                && ($0.promotion == nil || $0.promotion == (queued.promotion ?? .queen)) }) {
                send(legal)
            }
        }
    }

    private func tick() {
        let now = Date()
        let dt = now.timeIntervalSince(lastTick)
        lastTick = now
        guard isPlaying, hasClock, game.mainline.count >= 2 else { return }
        let mover = game.lastMainlineNode.position.turn
        clocks[mover] = max(0, (clocks[mover] ?? 0) - dt)
    }

    var movableColor: PieceColor? {
        guard isPlaying, pendingMove == nil, game.current === game.lastMainlineNode,
              game.position.turn == myColor else { return nil }
        return myColor
    }

    var premoveColor: PieceColor? {
        isPlaying && game.current === game.lastMainlineNode && game.position.turn != myColor ? myColor : nil
    }

    var shownPosition: Position { pendingMove.map { game.position.applying($0) } ?? game.position }

    func play(_ move: Move) {
        guard movableColor != nil else { return }
        if confirmMoves { pendingMove = move } else { send(move) }
    }

    func confirmPending() {
        guard let m = pendingMove else { return }
        pendingMove = nil
        send(m)
    }

    private func send(_ move: Move) {
        guard let id = gameID, let token = Self.token else { return }
        let node = game.play(move)
        Sound.play(for: node)
        // Lichess expects the king's own destination for castling.
        var uci = move.uci
        if let parent = node.parent, parent.position.isCastling(move) {
            uci = Sq.name(move.from) + Sq.name(parent.position.castlingSquares(move).king)
        }
        Task { @MainActor in
            do {
                _ = try await Net.data(Net.request(URL(string: "https://lichess.org/api/board/game/\(id)/move/\(uci)")!,
                                                   method: "POST", token: token))
            } catch {
                self.errorText = "Lichess rejected the move: \(error.localizedDescription)"
                if self.game.lastMainlineNode === node { self.game.delete(node) }
            }
        }
    }

    private func post(_ path: String, form: [String: String]? = nil) {
        guard let token = Self.token else { return }
        Task { @MainActor in
            do {
                _ = try await Net.data(Net.request(URL(string: "https://lichess.org/api/\(path)")!, method: "POST",
                                                   token: token, form: form))
            } catch {
                self.errorText = error.localizedDescription
            }
        }
    }

    /// Joins the public pool. The Board API only allows rapid and slower pairings.
    func seek(minutes: Int, increment: Int, rated: Bool) {
        guard let token = Self.token, state == .online else { return }
        cancelSeek()
        isSeeking = true
        errorText = nil
        seekTask = Task { [weak self] in
            let req = Net.request(URL(string: "https://lichess.org/api/board/seek")!, method: "POST", token: token,
                                  form: ["rated": rated ? "true" : "false", "time": String(minutes),
                                         "increment": String(increment), "variant": "standard"])
            await self?.lines(req) { _ in }
            await MainActor.run { self?.isSeeking = false }
        }
    }

    func cancelSeek() {
        seekTask?.cancel()
        seekTask = nil
        isSeeking = false
    }

    func challengeComputer(level: Int, minutes: Int, increment: Int) {
        errorText = nil
        post("challenge/ai", form: ["level": String(level), "clock.limit": String(minutes * 60),
                                    "clock.increment": String(increment), "color": "random", "variant": "standard"])
    }

    func resign() { if let id = gameID { post("board/game/\(id)/resign") } }
    func abort() { if let id = gameID { post("board/game/\(id)/abort") } }
    func offerDraw() { if let id = gameID { post("board/game/\(id)/draw/yes") } }
}
