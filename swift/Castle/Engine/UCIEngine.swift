import Foundation

struct UCIOption: Identifiable, Hashable {
    enum Kind: String { case spin, check, combo, button, string }
    var id: String { name }
    var name: String
    var kind: Kind
    var defaultValue: String
    var min: Int?
    var max: Int?
    var choices: [String] = []
}

/// One principal variation reported by an engine. The score is from the point of
/// view of the side to move in the searched position.
struct EngineLine: Identifiable, Hashable {
    var id: Int { multipv }
    var multipv = 1
    var depth = 0
    var seldepth = 0
    var score: EngineScore = .cp(0)
    var nodes = 0
    var nps = 0
    var timeMs = 0
    var pv: [String] = []
}

struct SearchJob {
    var position: String            // full "position …" command
    var go: String                  // full "go …" command
    var multiPV = 1
    var chess960 = false
    var onInfo: (EngineLine) -> Void = { _ in }
    var onBestMove: (String?) -> Void = { _ in }
}

/// A UCI engine running as a child process. All methods and callbacks are on the
/// main thread.
final class UCIEngine {
    enum State { case stopped, starting, idle, searching, stopping }

    let path: String
    private(set) var state: State = .stopped
    private(set) var name = ""
    private(set) var author = ""
    private(set) var options: [UCIOption] = []
    /// Options applied once the engine has identified itself.
    var settings: [String: String] = [:]
    var onReady: (() -> Void)?
    var onExit: (() -> Void)?

    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var current: SearchJob?
    private var pending: SearchJob?
    private var currentMultiPV = 1
    private var currentChess960 = false

    init(path: String) {
        self.path = path
    }

    deinit { quit() }

    var isRunning: Bool { state != .stopped }

    func hasOption(_ name: String) -> Bool {
        options.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    func option(_ name: String) -> UCIOption? {
        options.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    // MARK: Lifecycle

    func start() {
        guard state == .stopped else { return }
        let url = URL(fileURLWithPath: path)
        let proc = Process()
        proc.executableURL = url
        // Engines look for their network files next to the real binary.
        proc.currentDirectoryURL = url.resolvingSymlinksInPath().deletingLastPathComponent()
        let stdin = Pipe(), stdout = Pipe()
        proc.standardInput = stdin
        proc.standardOutput = stdout
        proc.standardError = FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            DispatchQueue.main.async { self?.receive(data) }
        }
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.didExit() }
        }
        do {
            try proc.run()
        } catch {
            didExit()
            return
        }
        process = proc
        input = stdin.fileHandleForWriting
        state = .starting
        send("uci")
    }

    func quit() {
        guard let proc = process else { return }
        process = nil
        send("quit")
        input = nil
        let p = proc
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            if p.isRunning { p.terminate() }
        }
        state = .stopped
        current = nil
        pending = nil
    }

    private func didExit() {
        guard process != nil || state == .starting else { return }
        process = nil
        input = nil
        state = .stopped
        let job = current
        current = nil
        pending = nil
        job?.onBestMove(nil)
        onExit?()
    }

    func send(_ command: String) {
        guard let input, let data = (command + "\n").data(using: .utf8) else { return }
        try? input.write(contentsOf: data)
    }

    func setOption(_ name: String, _ value: String) {
        guard let opt = option(name) else { return }
        if opt.kind == .button {
            send("setoption name \(opt.name)")
        } else {
            send("setoption name \(opt.name) value \(value)")
        }
    }

    // MARK: Searching

    /// Starts a search, replacing any search already running.
    func search(_ job: SearchJob) {
        pending = job
        switch state {
        case .stopped:
            start()
        case .idle:
            startPending()
        case .searching:
            send("stop")
            state = .stopping
        case .starting, .stopping:
            break
        }
    }

    /// Cancels the running search; its best move is discarded.
    func stop() {
        pending = nil
        if state == .searching {
            send("stop")
            state = .stopping
        }
    }

    func newGame() {
        if state == .idle { send("ucinewgame") }
    }

    private func startPending() {
        guard let job = pending, state == .idle else { return }
        pending = nil
        current = job
        if job.multiPV != currentMultiPV, hasOption("MultiPV") {
            setOption("MultiPV", String(job.multiPV))
            currentMultiPV = job.multiPV
        }
        if job.chess960 != currentChess960, hasOption("UCI_Chess960") {
            setOption("UCI_Chess960", job.chess960 ? "true" : "false")
            currentChess960 = job.chess960
        }
        send(job.position)
        send(job.go)
        state = .searching
    }

    // MARK: Output

    private func receive(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 10) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let line = String(data: lineData, encoding: .utf8) ?? String(data: lineData, encoding: .isoLatin1) {
                handle(line.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    private func handle(_ line: String) {
        if line.hasPrefix("info ") {
            guard state == .searching, let job = current, let parsed = Self.parseInfo(line) else { return }
            job.onInfo(parsed)
        } else if line.hasPrefix("bestmove") {
            let parts = line.split(separator: " ")
            let move = parts.count > 1 && parts[1] != "(none)" && parts[1] != "0000" ? String(parts[1]) : nil
            let job = current
            let wasSearching = state == .searching
            current = nil
            if state == .searching || state == .stopping { state = .idle }
            if wasSearching { job?.onBestMove(move) }
            startPending()
        } else if line.hasPrefix("id name ") {
            name = String(line.dropFirst(8))
        } else if line.hasPrefix("id author ") {
            author = String(line.dropFirst(10))
        } else if line.hasPrefix("option name ") {
            if let opt = Self.parseOption(line) { options.append(opt) }
        } else if line == "uciok" {
            for (k, v) in settings { setOption(k, v) }
            send("isready")
        } else if line == "readyok" {
            if state == .starting {
                state = .idle
                onReady?()
                startPending()
            }
        }
    }

    static func parseOption(_ line: String) -> UCIOption? {
        let words = line.split(separator: " ").map(String.init)
        guard let typeIndex = words.firstIndex(of: "type"), typeIndex > 2, typeIndex + 1 < words.count,
              let kind = UCIOption.Kind(rawValue: words[typeIndex + 1]) else { return nil }
        var opt = UCIOption(name: words[2..<typeIndex].joined(separator: " "), kind: kind, defaultValue: "")
        var i = typeIndex + 2
        while i < words.count {
            let key = words[i]
            var value: [String] = []
            i += 1
            while i < words.count, !["default", "min", "max", "var"].contains(words[i]) {
                value.append(words[i])
                i += 1
            }
            let text = value.joined(separator: " ")
            switch key {
            case "default": opt.defaultValue = text
            case "min": opt.min = Int(text)
            case "max": opt.max = Int(text)
            case "var": opt.choices.append(text)
            default: break
            }
        }
        return opt
    }

    static func parseInfo(_ line: String) -> EngineLine? {
        let words = line.split(separator: " ")
        var info = EngineLine()
        var hasScore = false
        var i = 1
        while i < words.count {
            let key = words[i]
            func next() -> Int { i + 1 < words.count ? Int(words[i + 1]) ?? 0 : 0 }
            switch key {
            case "depth": info.depth = next(); i += 2
            case "seldepth": info.seldepth = next(); i += 2
            case "multipv": info.multipv = max(1, next()); i += 2
            case "nodes": info.nodes = next(); i += 2
            case "nps": info.nps = next(); i += 2
            case "time": info.timeMs = next(); i += 2
            case "score":
                guard i + 2 < words.count else { return nil }
                let value = Int(words[i + 2]) ?? 0
                info.score = words[i + 1] == "mate" ? .mate(value) : .cp(value)
                hasScore = true
                i += 3
                if i < words.count, words[i] == "lowerbound" || words[i] == "upperbound" { return nil }
            case "pv":
                info.pv = words[(i + 1)...].map(String.init)
                i = words.count
            case "string":
                return nil
            default:
                i += 1
            }
        }
        return hasScore && !info.pv.isEmpty ? info : nil
    }
}
