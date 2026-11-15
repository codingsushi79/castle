import Foundation
import Network
import Observation

struct FICSLine: Identifiable {
    enum Kind { case server, sent, system }
    let id = UUID()
    var text: String
    var kind: Kind
}

struct FICSSeek: Identifiable, Hashable {
    var id: Int
    var rating: String
    var name: String
    var time: Int
    var increment: Int
    var rated: Bool
    var type: String
}

struct FICSGame {
    var number = 0
    var white = ""
    var black = ""
    var relation = 0          // 1: my move, -1: opponent's move, 0: observing
    var whiteTime = 0.0
    var blackTime = 0.0
    var initialMinutes = 0
    var increment = 0
    var lastMoveSAN = ""
    var clockRunning = false
}

/// A client for the Free Internet Chess Server (freechess.org), speaking its
/// plain-text protocol with style 12 board updates.
@Observable
final class FICSModel {
    enum State: Equatable { case disconnected, connecting, loggingIn, online }

    var state: State = .disconnected
    var username = UserDefaults.standard.string(forKey: "ficsUser") ?? ""
    var asGuest = true
    var handle = ""
    var console: [FICSLine] = []
    var seeks: [FICSSeek] = []
    var game: FICSGame?
    var position = Position.start
    var lastMove: Move?
    var flipped = false
    var resultText: String?
    var errorText: String?
    /// A move queued to be played the moment the opponent has moved.
    var premove: Move?
    /// A move waiting for the player to confirm it.
    var pendingMove: Move?
    var confirmMoves = UserDefaults.standard.bool(forKey: "ficsConfirmMoves") {
        didSet { UserDefaults.standard.set(confirmMoves, forKey: "ficsConfirmMoves") }
    }

    /// Moves of the game being played or watched, for sending to analysis afterwards.
    @ObservationIgnored private(set) var record = Game()
    @ObservationIgnored private var connection: NWConnection?
    @ObservationIgnored private var buffer = ""
    @ObservationIgnored private var password = ""
    @ObservationIgnored private var sentUser = false
    @ObservationIgnored private var sentPassword = false
    @ObservationIgnored private var readingSeeks = false
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastTick = Date()

    var isPlaying: Bool { game.map { abs($0.relation) == 1 } ?? false }

    var movableColor: PieceColor? {
        guard let g = game, g.relation == 1, pendingMove == nil else { return nil }
        return position.turn
    }

    /// The colour the signed-in player has in the current game.
    var myColor: PieceColor? {
        guard let g = game, abs(g.relation) == 1 else { return nil }
        return g.relation == 1 ? position.turn : position.turn.opposite
    }

    /// The side that may queue a premove: mine, while the opponent is thinking.
    var premoveColor: PieceColor? {
        guard let g = game, g.relation == -1 else { return nil }
        return position.turn.opposite
    }

    /// The board to draw: with the unconfirmed move already made.
    var shownPosition: Position { pendingMove.map { position.applying($0) } ?? position }

    // MARK: Connection

    func connect(password: String) {
        guard state == .disconnected else { return }
        self.password = password
        UserDefaults.standard.set(username, forKey: "ficsUser")
        errorText = nil
        console = []
        seeks = []
        game = nil
        resultText = nil
        buffer = ""
        sentUser = false
        sentPassword = false
        state = .connecting
        log("Connecting to freechess.org…", .system)
        let conn = NWConnection(host: "freechess.org", port: 5000, using: .tcp)
        connection = conn
        conn.stateUpdateHandler = { [weak self] st in
            DispatchQueue.main.async {
                guard let self, self.connection === conn else { return }
                switch st {
                case .ready:
                    self.state = .loggingIn
                    self.receive(on: conn)
                case .failed(let err):
                    self.errorText = err.localizedDescription
                    self.disconnect()
                case .waiting(let err):
                    self.errorText = "Can't reach freechess.org: \(err.localizedDescription)"
                    self.disconnect()
                default:
                    break
                }
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
    }

    func disconnect() {
        if state == .online { sendRaw("quit") }
        connection?.cancel()
        connection = nil
        timer?.invalidate()
        timer = nil
        password = ""
        if state != .disconnected { log("Disconnected.", .system) }
        state = .disconnected
    }

    private func receive(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            DispatchQueue.main.async {
                guard let self, self.connection === conn else { return }
                if let data, !data.isEmpty { self.ingest(data) }
                if done || error != nil {
                    self.disconnect()
                } else {
                    self.receive(on: conn)
                }
            }
        }
    }

    private func sendRaw(_ text: String) {
        connection?.send(content: (text + "\n").data(using: .isoLatin1), completion: .contentProcessed { _ in })
    }

    /// Sends a command typed by the user or triggered from the interface.
    func send(_ command: String) {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, state == .online else { return }
        log(text, .sent)
        sendRaw(text)
    }

    private func log(_ text: String, _ kind: FICSLine.Kind) {
        console.append(FICSLine(text: text, kind: kind))
        if console.count > 600 { console.removeFirst(console.count - 600) }
    }

    // MARK: Parsing

    private func ingest(_ data: Data) {
        // Drop telnet negotiation sequences (IAC + command [+ option]).
        var bytes: [UInt8] = []
        var i = data.startIndex
        while i < data.endIndex {
            let b = data[i]
            if b == 255 {
                let cmd = i + 1 < data.endIndex ? data[i + 1] : 0
                i += (251...254).contains(cmd) ? 3 : 2
                continue
            }
            if b != 13, b != 7, b != 0 { bytes.append(b) }
            i += 1
        }
        buffer += String(bytes: bytes, encoding: .isoLatin1) ?? ""
        while let nl = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<nl])
            buffer.removeSubrange(...nl)
            handle(line: line)
        }
        handlePrompt()
    }

    /// Login prompts arrive without a trailing newline.
    private func handlePrompt() {
        guard state == .loggingIn else {
            if buffer.hasPrefix("fics% ") { buffer.removeFirst(6) }
            return
        }
        let tail = buffer.lowercased()
        if tail.contains("login:"), !sentUser {
            sentUser = true
            buffer = ""
            sendRaw(asGuest || username.isEmpty ? "guest" : username)
        } else if tail.contains("press return to enter the server") {
            buffer = ""
            sendRaw("")
        } else if tail.contains("password:"), !sentPassword {
            sentPassword = true
            buffer = ""
            sendRaw(password)
            password = ""
        } else if tail.contains("login:"), sentUser {
            errorText = "FICS did not accept that login."
            disconnect()
        }
    }

    private func handle(line raw: String) {
        var line = raw
        while line.hasPrefix("fics% ") { line.removeFirst(6) }
        if line.hasPrefix("<12> ") {
            parseStyle12(line)
            return
        }
        if state == .loggingIn {
            if line.contains("**** Starting FICS session as ") {
                let name = line.replacingOccurrences(of: "**** Starting FICS session as ", with: "")
                    .replacingOccurrences(of: " ****", with: "")
                handle = name.components(separatedBy: "(").first?.trimmingCharacters(in: .whitespaces) ?? name
                state = .online
                sendRaw("set style 12")
                sendRaw("set interface Castle for macOS")
                sendRaw("set bell 0")
                sendRaw("set seek 0")
                refreshSeeks()
                timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
            } else if line.lowercased().contains("invalid password") {
                errorText = "Invalid password."
            } else if line.lowercased().contains("press return to enter the server") {
                sendRaw("")
                return
            }
        }
        if parseSeek(line) { return }
        if line.hasPrefix("{Game ") || line.hasPrefix("\n{Game ") { parseGameEvent(line) }
        if line.contains("ads displayed.") || line.contains("ad displayed.") { return }
        if !line.trimmingCharacters(in: .whitespaces).isEmpty { log(line, .server) }
    }

    // Lines of the `sought` listing look like:
    //   12 1650 SomePlayer          5   0 rated   blitz      [white]  0-9999
    private func parseSeek(_ line: String) -> Bool {
        let f = line.split(separator: " ", omittingEmptySubsequences: true)
        guard f.count >= 7, let id = Int(f[0]), let time = Int(f[3]), let inc = Int(f[4]),
              f[5] == "rated" || f[5] == "unrated" else { return false }
        if !readingSeeks {
            readingSeeks = true
            seeks = []
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.readingSeeks = false }
        }
        let seek = FICSSeek(id: id, rating: String(f[1]), name: String(f[2]), time: time, increment: inc,
                            rated: f[5] == "rated", type: String(f[6]))
        if !seeks.contains(where: { $0.id == id }) { seeks.append(seek) }
        return true
    }

    func refreshSeeks() {
        guard state == .online else { return }
        sendRaw("sought")
    }

    private func parseGameEvent(_ line: String) {
        // {Game 12 (white vs. black) white resigns} 0-1
        guard let close = line.firstIndex(of: "}") else { return }
        let result = line[line.index(after: close)...].trimmingCharacters(in: .whitespaces)
        guard ["1-0", "0-1", "1/2-1/2", "*"].contains(result) else { return }
        let inner = line[..<close]
        if let paren = inner.lastIndex(of: ")") {
            let reason = inner[inner.index(after: paren)...].trimmingCharacters(in: .whitespaces)
            resultText = "\(reason) · \(result)"
        }
        record.result = result
        game?.clockRunning = false
        game?.relation = 0
        Sound.gameEnd()
        refreshSeeks()
    }

    private func parseStyle12(_ line: String) {
        let f = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard f.count >= 31 else { return }
        var p = Position()
        for row in 0..<8 {
            let rank = 7 - row
            for (file, ch) in f[1 + row].enumerated() where file < 8 {
                p.board[rank * 8 + file] = Piece(fenChar: ch)
            }
        }
        p.turn = f[9] == "B" ? .black : .white
        if f[11] == "1" { p.castling.insert(.whiteKing) }
        if f[12] == "1" { p.castling.insert(.whiteQueen) }
        if f[13] == "1" { p.castling.insert(.blackKing) }
        if f[14] == "1" { p.castling.insert(.blackQueen) }
        if let epFile = Int(f[10]), epFile >= 0 {
            p.epSquare = Sq.make(file: epFile, rank: p.turn == .white ? 5 : 2)
        }
        p.halfmoveClock = Int(f[15]) ?? 0
        p.fullmoveNumber = Int(f[26]) ?? 1

        var g = FICSGame()
        g.number = Int(f[16]) ?? 0
        g.white = f[17]
        g.black = f[18]
        g.relation = Int(f[19]) ?? 0
        g.initialMinutes = Int(f[20]) ?? 0
        g.increment = Int(f[21]) ?? 0
        g.whiteTime = Double(f[24]) ?? 0
        g.blackTime = Double(f[25]) ?? 0
        g.lastMoveSAN = f[29] == "none" ? "" : f[29]
        g.clockRunning = abs(g.relation) <= 1 && (p.fullmoveNumber > 1 || p.turn == .black) && g.initialMinutes > 0

        let isNewGame = game?.number != g.number || f[27] == "none"
        if isNewGame {
            record = Game(start: p)
            record.tags["Event"] = "FICS game"
            record.tags["Site"] = "freechess.org"
            record.tags["White"] = g.white
            record.tags["Black"] = g.black
            resultText = nil
            lastMove = nil
            flipped = f[30] == "1"
        } else if !g.lastMoveSAN.isEmpty {
            record.toEnd()
            if let m = record.position.move(san: g.lastMoveSAN) {
                let capture = record.position.isCapture(m)
                lastMove = m
                record.play(m)
                Sound.move(capture: capture)
            }
        }
        position = p
        game = g
        lastTick = Date()
        pendingMove = nil
        if g.relation == 1, let queued = premove {
            premove = nil
            if let legal = p.legalMoves().first(where: { $0.from == queued.from && $0.to == queued.to
                && ($0.promotion == nil || $0.promotion == (queued.promotion ?? .queen)) }) {
                commit(legal)
            }
        } else if g.relation != -1 {
            premove = nil
        }
    }

    private func tick() {
        let now = Date()
        let dt = now.timeIntervalSince(lastTick)
        lastTick = now
        guard var g = game, g.clockRunning else { return }
        if position.turn == .white {
            g.whiteTime = max(0, g.whiteTime - dt)
        } else {
            g.blackTime = max(0, g.blackTime - dt)
        }
        game = g
    }

    // MARK: Actions

    func play(_ move: Move) {
        guard movableColor != nil else { return }
        if confirmMoves {
            pendingMove = move
        } else {
            commit(move)
        }
    }

    func confirmPending() {
        guard let m = pendingMove else { return }
        pendingMove = nil
        commit(m)
    }

    private func commit(_ move: Move) {
        // Show the move right away; the server's board update confirms it.
        let capture = position.isCapture(move)
        position.apply(move)
        lastMove = move
        game?.relation = -1
        Sound.move(capture: capture)
        sendRaw(move.uci.count == 5 ? "\(move.uci.prefix(4))=\(move.uci.suffix(1))" : move.uci)
    }

    func seek(minutes: Int, increment: Int, rated: Bool) {
        send("seek \(minutes) \(increment) \(rated ? "rated" : "unrated")")
    }

    func accept(_ seek: FICSSeek) {
        send("play \(seek.id)")
    }
}
