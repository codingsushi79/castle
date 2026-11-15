import Foundation
import Observation

struct EngineEntry: Identifiable, Hashable, Codable {
    var id: String
    var name: String
    var summary: String
    var path: String?           // nil when the engine is not installed
    var isBundled = false
    var isCustom = false
    var installHint: String? = nil

    var isAvailable: Bool { path != nil }
}

/// The engines Castle knows about: Wasabi ships inside the app, the rest are found
/// on disk, and any other UCI engine can be added by hand.
@Observable
final class EngineCatalog {
    private(set) var engines: [EngineEntry] = []
    /// Engines being installed, with the latest line of progress.
    var installing: [String: String] = [:]
    var installError: [String: String] = [:]
    var optionsRevision = 0
    var defaultID: String {
        didSet { UserDefaults.standard.set(defaultID, forKey: "defaultEngine") }
    }

    private struct Known {
        let id: String, name: String, summary: String
        let binaries: [String]
        let hint: String?
    }

    private static let known: [Known] = [
        Known(id: "stockfish", name: "Stockfish", summary: "The strongest open-source engine. NNUE evaluation, alpha-beta search.",
              binaries: ["stockfish"], hint: "brew install stockfish"),
        Known(id: "lc0", name: "Leela Chess Zero", summary: "Neural network engine with Monte Carlo tree search.",
              binaries: ["lc0"], hint: "brew install lc0"),
        Known(id: "dragon", name: "Komodo Dragon", summary: "Commercial engine known for its positional, human-like style.",
              binaries: ["dragon", "komodo-dragon", "komodo"], hint: "Purchase from komodochess.com, then locate the binary"),
        Known(id: "berserk", name: "Berserk", summary: "Top-tier NNUE engine with an aggressive search.",
              binaries: ["berserk"], hint: nil),
        Known(id: "rubichess", name: "RubiChess", summary: "Strong NNUE engine by Andreas Matthies.",
              binaries: ["rubichess", "RubiChess"], hint: nil),
        Known(id: "caissa", name: "Caissa", summary: "Strong engine with a large custom neural network.",
              binaries: ["caissa"], hint: nil),
        Known(id: "ethereal", name: "Ethereal", summary: "Clean, influential alpha-beta engine by Andrew Grant.",
              binaries: ["ethereal", "Ethereal"], hint: nil),
        Known(id: "koivisto", name: "Koivisto", summary: "Fast NNUE engine with a tactical style.",
              binaries: ["koivisto", "Koivisto"], hint: nil),
        Known(id: "obsidian", name: "Obsidian", summary: "Very strong NNUE engine by Gabriele Lombardo.",
              binaries: ["obsidian", "Obsidian"], hint: nil),
        Known(id: "fairy-stockfish", name: "Fairy-Stockfish", summary: "Stockfish derivative that also plays chess variants.",
              binaries: ["fairy-stockfish"], hint: "brew install fairy-stockfish"),
    ]

    private static var searchDirectories: [String] {
        let home = NSHomeDirectory()
        return ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/code/stockapi/engines/bin",
                "\(home)/Library/Application Support/Castle/Engines", "\(home)/.local/bin", "/usr/bin"]
    }

    init() {
        defaultID = UserDefaults.standard.string(forKey: "defaultEngine") ?? "wasabi"
        refresh()
    }

    func refresh() {
        let fm = FileManager.default
        var list: [EngineEntry] = []
        let overrides = UserDefaults.standard.dictionary(forKey: "enginePaths") as? [String: String] ?? [:]

        let wasabi = Bundle.main.resourceURL?.appendingPathComponent("wasabi-2.1").path
        list.append(EngineEntry(id: "wasabi", name: "Wasabi 2.1",
                                summary: "Castle's built-in engine. NNUE evaluation, runs with no setup.",
                                path: wasabi.flatMap { fm.isExecutableFile(atPath: $0) ? $0 : nil },
                                isBundled: true))

        for k in Self.known {
            var found: String? = nil
            if let o = overrides[k.id], fm.isExecutableFile(atPath: o) {
                found = o
            } else {
                search: for dir in Self.searchDirectories {
                    for bin in k.binaries where fm.isExecutableFile(atPath: "\(dir)/\(bin)") {
                        found = "\(dir)/\(bin)"
                        break search
                    }
                }
            }
            list.append(EngineEntry(id: k.id, name: k.name, summary: k.summary, path: found, installHint: k.hint))
        }

        if let data = UserDefaults.standard.data(forKey: "customEngines"),
           let custom = try? JSONDecoder().decode([EngineEntry].self, from: data) {
            list += custom.filter { $0.path.map(fm.isExecutableFile(atPath:)) ?? false }
        }
        engines = list
        if entry(defaultID)?.isAvailable != true { defaultID = "wasabi" }
    }

    var available: [EngineEntry] { engines.filter(\.isAvailable) }

    func entry(_ id: String) -> EngineEntry? { engines.first { $0.id == id } }

    /// The requested engine if installed, otherwise the default, otherwise Wasabi.
    func resolve(_ id: String?) -> EngineEntry? {
        if let id, let e = entry(id), e.isAvailable { return e }
        if let e = entry(defaultID), e.isAvailable { return e }
        return available.first
    }

    func locate(_ id: String, at path: String) {
        var overrides = UserDefaults.standard.dictionary(forKey: "enginePaths") as? [String: String] ?? [:]
        overrides[id] = path
        UserDefaults.standard.set(overrides, forKey: "enginePaths")
        refresh()
    }

    func addCustom(path: String, name: String) {
        var custom = customEngines()
        custom.append(EngineEntry(id: "custom-" + UUID().uuidString, name: name,
                                  summary: path, path: path, isCustom: true))
        saveCustom(custom)
    }

    func removeCustom(_ id: String) {
        saveCustom(customEngines().filter { $0.id != id })
    }

    private func customEngines() -> [EngineEntry] {
        guard let data = UserDefaults.standard.data(forKey: "customEngines") else { return [] }
        return (try? JSONDecoder().decode([EngineEntry].self, from: data)) ?? []
    }

    private func saveCustom(_ list: [EngineEntry]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: "customEngines")
        refresh()
    }

    /// Creates a process wrapper for an engine with the user's thread and hash settings
    /// and any options saved for that engine.
    func makeEngine(_ entry: EngineEntry, threads: Int? = nil, hash: Int? = nil) -> UCIEngine? {
        guard let path = entry.path else { return nil }
        let engine = UCIEngine(path: path)
        let d = UserDefaults.standard
        let savedThreads = d.integer(forKey: "engineThreads")
        let savedHash = d.integer(forKey: "engineHash")
        engine.settings["Threads"] = String(threads ?? (savedThreads > 0 ? savedThreads : max(1, ProcessInfo.processInfo.activeProcessorCount / 2)))
        engine.settings["Hash"] = String(hash ?? (savedHash > 0 ? savedHash : 256))
        for (k, v) in options(for: entry.id) where threads == nil || k.lowercased() != "threads" {
            engine.settings[k] = v
        }
        return engine
    }

    // MARK: Per-engine options

    func options(for id: String) -> [String: String] {
        UserDefaults.standard.dictionary(forKey: "engineOptions.\(id)") as? [String: String] ?? [:]
    }

    func setOption(_ name: String, to value: String?, for id: String) {
        var all = options(for: id)
        all[name] = value
        UserDefaults.standard.set(all, forKey: "engineOptions.\(id)")
        optionsRevision += 1
    }

    func resetOptions(for id: String) {
        UserDefaults.standard.removeObject(forKey: "engineOptions.\(id)")
        optionsRevision += 1
    }

    // MARK: Installing with Homebrew

    static let brewPath = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first {
        FileManager.default.isExecutableFile(atPath: $0)
    }

    /// The Homebrew formula for an engine, when there is one.
    func formula(for entry: EngineEntry) -> String? {
        guard let hint = entry.installHint, hint.hasPrefix("brew install ") else { return nil }
        return String(hint.dropFirst("brew install ".count))
    }

    func install(_ entry: EngineEntry) {
        guard installing[entry.id] == nil, let brew = Self.brewPath, let formula = formula(for: entry) else { return }
        installing[entry.id] = "Starting…"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: brew)
        proc.arguments = ["install", formula]
        var env = ProcessInfo.processInfo.environment
        env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        proc.environment = env
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            let last = text.split(separator: "\n").last.map(String.init) ?? ""
            DispatchQueue.main.async { if !last.isEmpty { self?.installing[entry.id] = last } }
        }
        proc.terminationHandler = { [weak self] p in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                self?.installing[entry.id] = nil
                self?.installError[entry.id] = p.terminationStatus == 0 ? nil : "Homebrew could not install \(formula)."
                self?.refresh()
            }
        }
        do { try proc.run() } catch {
            installing[entry.id] = nil
            installError[entry.id] = error.localizedDescription
        }
    }
}
