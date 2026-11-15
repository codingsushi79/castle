import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

enum AppSection: String, CaseIterable, Identifiable {
    case play, lichess, fics, matches, analysis, puzzles, repertoire, progress, library, accounts, engines

    var id: String { rawValue }

    var title: String {
        switch self {
        case .play: return "Play"
        case .lichess: return "Lichess"
        case .fics: return "FICS"
        case .matches: return "Engine Matches"
        case .analysis: return "Analysis"
        case .puzzles: return "Puzzles"
        case .repertoire: return "Repertoire"
        case .progress: return "Progress"
        case .library: return "Library"
        case .accounts: return "Accounts"
        case .engines: return "Engines"
        }
    }

    var symbol: String {
        switch self {
        case .play: return "flag.checkered"
        case .lichess: return "bolt.horizontal.fill"
        case .fics: return "globe"
        case .matches: return "trophy.fill"
        case .analysis: return "waveform.path.ecg"
        case .puzzles: return "puzzlepiece.extension.fill"
        case .repertoire: return "book.fill"
        case .progress: return "chart.line.uptrend.xyaxis"
        case .library: return "books.vertical.fill"
        case .accounts: return "person.crop.circle.fill"
        case .engines: return "cpu.fill"
        }
    }
}

@Observable
final class AppModel {
    var section: AppSection = .play
    let catalog = EngineCatalog()
    let openings = OpeningBook()
    let library = LibraryModel()
    let puzzles = PuzzleModel()
    let fics = FICSModel()
    let lichess = LichessModel()
    let repertoire = RepertoireModel()
    let accounts: AccountsModel
    let matches: MatchModel
    let play: PlayModel

    /// Analysis boards open as tabs in the main window.
    var analyses: [AnalysisModel]
    var analysisIndex = 0
    /// Analysis boards moved out into their own windows.
    @ObservationIgnored var detached: [UUID: AnalysisModel] = [:]

    var analysis: AnalysisModel { analyses[min(analysisIndex, analyses.count - 1)] }

    init() {
        analyses = [AnalysisModel(catalog: catalog)]
        play = PlayModel(catalog: catalog)
        matches = MatchModel(catalog: catalog, openings: openings)
        accounts = AccountsModel(library: library)
        play.onFinished = { [weak self] game in
            if game.mainline.count >= 2 { self?.library.add(game) }
        }
        lichess.onFinished = { [weak self] game in
            if game.mainline.count >= 2 { self?.library.add(game) }
        }
        matches.onGameFinished = { [weak self] game in
            if UserDefaults.standard.bool(forKey: "saveMatchGames") { self?.library.add(game) }
        }
        openings.load()
        puzzles.load()
        #if DEBUG
        debugLaunch()
        #endif
    }

    #if DEBUG
    /// `-startSection analysis -demo YES` opens a page in a lively state for checking the UI.
    private func debugLaunch() {
        let d = UserDefaults.standard
        if let raw = d.string(forKey: "startSection"), let s = AppSection(rawValue: raw) { section = s }
        guard d.bool(forKey: "demo") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [self] in
            switch section {
            case .analysis:
                let pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Nb4 9. O-O c6 10. d4 Qf6 11. Qe2 Bd6 12. dxe5 Bxe5 13. f4 Bd4+ 14. Kh1 Kd6 15. Nxd5 cxd5 16. Bb5 1-0"
                if let g = PGN.parseGame(pgn) { analysis.load(g) }
                analysis.game.go(to: analysis.game.mainline[9])
                analysis.game.current.shapes = [BoardShape(from: 28, to: 28, tint: .red), BoardShape(from: 21, to: 53, tint: .green)]
                if let second = d.string(forKey: "demoEngine") { analysis.addEngine(second) }
                analysis.toggle()
                analysis.startReview(moveTimeMs: 120)
                if d.bool(forKey: "demoTab") {
                    newTab(game: PGN.parseGame("[FEN \"8/8/4k3/8/8/4K3/4P3/8 w - - 0 1\"]\n\n1. Kd4 *"))
                }
            case .play:
                play.side = .black
                play.engineID = d.string(forKey: "demoEngine") ?? "wasabi"
                if d.bool(forKey: "demo960") { play.variant = .chess960 }
                play.start()
            case .matches:
                matches.engineB = d.string(forKey: "demoEngine") ?? "stockfish"
                matches.games = 4
                matches.moveTimeMs = 60
                matches.start()
            case .repertoire:
                if repertoire.game(for: .white).mainline.isEmpty {
                    repertoire.importLine(PGN.parseGame("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O) 4. Ba4 Nf6 5. O-O *")!, color: .white)
                }
                if d.bool(forKey: "demoTrain") { repertoire.startTraining() }
            default: break
            }
        }
    }
    #endif

    func go(_ target: AppSection) {
        withAnimation(.snappy(duration: 0.35)) { section = target }
    }

    // MARK: Analysis tabs

    @discardableResult
    func newTab(game: Game? = nil) -> AnalysisModel {
        let model = AnalysisModel(catalog: catalog, game: game)
        analyses.append(model)
        analysisIndex = analyses.count - 1
        return model
    }

    func closeTab(_ id: UUID) {
        guard let i = analyses.firstIndex(where: { $0.id == id }) else { return }
        analyses[i].shutdown()
        if analyses.count == 1 {
            analyses = [AnalysisModel(catalog: catalog)]
            analysisIndex = 0
            return
        }
        analyses.remove(at: i)
        if analysisIndex >= i { analysisIndex = max(0, analysisIndex - 1) }
    }

    /// Moves a tab out of the main window; the caller opens the window for the returned id.
    func detach(_ id: UUID) -> UUID? {
        guard let i = analyses.firstIndex(where: { $0.id == id }) else { return nil }
        let model = analyses[i]
        detached[id] = model
        if analyses.count == 1 {
            analyses = [AnalysisModel(catalog: catalog)]
            analysisIndex = 0
        } else {
            analyses.remove(at: i)
            if analysisIndex >= i { analysisIndex = max(0, analysisIndex - 1) }
        }
        return id
    }

    func analyse(_ game: Game) {
        let copy = game.copy()
        copy.toStart()
        open(copy)
    }

    func analyse(position: Position) {
        open(Game(start: position))
    }

    /// Uses the current tab when it is an untouched board, otherwise opens a new one.
    private func open(_ game: Game) {
        if analysis.game.mainline.isEmpty, analysis.game.root.position == .start {
            analysis.load(game)
        } else {
            newTab(game: game)
        }
        go(.analysis)
    }

    func playFromHere(_ position: Position) {
        play.backToSetup()
        play.customStart = position
        go(.play)
    }

    // MARK: Files and pasteboard

    func openPGNPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "pgn") ?? .plainText, .plainText]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        open(url)
    }

    func open(_ url: URL) {
        if url.scheme == "castle" {
            if url.host == "daily" { go(.puzzles); puzzles.startDaily() }
            return
        }
        let count = library.importFile(url)
        if count == 1, let entry = library.entries.first {
            analyse(PGN.parse(entry))
        } else if count > 0 {
            go(.library)
        }
    }

    /// Opens the library game a Spotlight result points at.
    func openSpotlight(_ identifier: String) {
        guard let entry = library.entries.first(where: { $0.spotlightID == identifier }) else { return }
        analyse(PGN.parse(entry))
    }

    func savePGNPanel() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "pgn") ?? .plainText]
        let g = analysis.game
        panel.nameFieldStringValue = "\(g.tags["White"] ?? "White") vs \(g.tags["Black"] ?? "Black").pgn"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? PGN.write(g).write(to: url, atomically: true, encoding: .utf8)
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// Loads a FEN or PGN from the clipboard into the analysis board.
    func paste() {
        guard let text = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
        if let position = Position(fen: text), text.contains("/") {
            analyse(position: position)
        } else if let game = PGN.parseGame(text), !game.mainline.isEmpty {
            game.toStart()
            open(game)
        } else {
            NSSound.beep()
        }
    }

    func shutdown() {
        for a in analyses { a.shutdown() }
        for a in detached.values { a.shutdown() }
        play.backToSetup()
        matches.stop()
        fics.disconnect()
        lichess.disconnect()
    }
}

enum Sound {
    private static var enabled: Bool {
        UserDefaults.standard.object(forKey: "soundEnabled") as? Bool ?? true
    }

    private static func play(_ name: String, volume: Float = 0.5) {
        guard enabled, let s = NSSound(named: name)?.copy() as? NSSound else { return }
        s.volume = volume
        s.play()
    }

    static func move(capture: Bool) { play(capture ? "Pop" : "Tink", volume: capture ? 0.6 : 0.8) }
    static func play(for node: GameNode) {
        guard let parent = node.parent, let m = node.move else { return }
        move(capture: parent.position.isCapture(m))
    }
    static func success() { play("Glass", volume: 0.35) }
    static func error() { play("Basso", volume: 0.3) }
    static func gameEnd() { play("Hero", volume: 0.3) }
}
