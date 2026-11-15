import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// White wins, draws and Black wins as one segmented bar.
struct ResultBar: View {
    let white: Int
    let draws: Int
    let black: Int

    var body: some View {
        let total = max(1, white + draws + black)
        GeometryReader { geo in
            HStack(spacing: 0) {
                segment(white, total, Color(white: 0.96), .black, geo.size.width)
                segment(draws, total, Color(white: 0.55), .white, geo.size.width)
                segment(black, total, Color(white: 0.14), .white, geo.size.width)
            }
        }
        .frame(height: 16)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(.black.opacity(0.15)))
    }

    private func segment(_ n: Int, _ total: Int, _ fill: Color, _ ink: Color, _ width: CGFloat) -> some View {
        let share = Double(n) / Double(total)
        return fill
            .frame(width: width * share)
            .overlay {
                if share >= 0.16 {
                    Text("\(Int((share * 100).rounded()))%")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(ink)
                }
            }
    }
}

/// What was played from the position on the board, in the library or on Lichess.
struct ExplorerPanel: View {
    @Environment(AppModel.self) private var app
    let model: AnalysisModel
    @AppStorage("explorerSource") private var sourceName = ExplorerSource.library.rawValue
    @State private var remote: ExplorerResult?
    @State private var error: String?
    @State private var loading = false

    private var source: ExplorerSource { ExplorerSource(rawValue: sourceName) ?? .library }

    var body: some View {
        let position = model.game.position
        let result = source == .library ? app.library.explorer(for: position) : remote
        VStack(alignment: .leading, spacing: 8) {
            Picker("Source", selection: $sourceName) {
                ForEach(ExplorerSource.allCases) { Text($0.rawValue).tag($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)

            if source != .library, LichessModel.token == nil {
                ContentUnavailableView {
                    Label("Sign In to Lichess", systemImage: "bolt.horizontal.fill")
                } description: {
                    Text("The Lichess and Masters explorers need a Lichess account.")
                } actions: {
                    Button("Open Lichess Page") { app.go(.lichess) }
                }
            } else if let error, source != .library {
                ContentUnavailableView("Explorer Unavailable", systemImage: "wifi.exclamationmark", description: Text(error))
            } else if let result, !result.moves.isEmpty {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(result.moves) { move in
                            Button {
                                if let m = position.move(san: move.san) {
                                    Sound.move(capture: position.isCapture(m))
                                    model.game.play(m)
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    Text(move.san)
                                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                                        .frame(width: 52, alignment: .leading)
                                    Text(move.total.formatted(.number.notation(.compactName)))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .frame(width: 44, alignment: .trailing)
                                    ResultBar(white: move.white, draws: move.draws, black: move.black)
                                }
                                .padding(.vertical, 3)
                                .padding(.horizontal, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(PressStyle(scale: 0.97))
                        }
                    }
                }
                .transition(.opacity)
                if source == .library {
                    let count = app.library.games(reaching: position).count
                    Button {
                        app.library.filterExact(position)
                        app.go(.library)
                    } label: {
                        Label("Show \(count) Game\(count == 1 ? "" : "s") in Library", systemImage: "books.vertical")
                            .frame(maxWidth: .infinity)
                    }
                    .controlSize(.small)
                }
            } else if loading || (source == .library && app.library.isIndexing) {
                VStack { ProgressView() }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("No Games Here", systemImage: "tray",
                                       description: Text(source == .library ? "No game in your library reached this position."
                                                                            : "This position has not been played."))
            }
        }
        .panel()
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: sourceName + position.epd) {
            guard source != .library, let token = LichessModel.token else { return }
            loading = true
            error = nil
            do {
                // Let quick stepping through a game settle before asking the server.
                try await Task.sleep(nanoseconds: 250_000_000)
                remote = try await ExplorerService.fetch(source, fen: position.fen, token: token)
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            loading = false
        }
        .animation(.easeOut(duration: 0.15), value: result)
    }
}

/// Perfect play from the endgame tablebases, for seven pieces or fewer.
struct TablebasePanel: View {
    let model: AnalysisModel
    @State private var result: TablebaseResult?
    @State private var error: String?

    var body: some View {
        let position = model.game.position
        VStack(alignment: .leading, spacing: 8) {
            if position.pieceCount > 7 {
                ContentUnavailableView("Too Many Pieces", systemImage: "square.grid.3x3.topleft.filled",
                                       description: Text("Tablebases cover positions with seven pieces or fewer. This one has \(position.pieceCount)."))
            } else if let error {
                ContentUnavailableView("Tablebase Unavailable", systemImage: "wifi.exclamationmark", description: Text(error))
            } else if let result {
                HStack {
                    Label(TablebaseService.verdictText(result.verdict), systemImage: icon(result.verdict))
                        .font(.headline)
                        .foregroundStyle(tint(result.verdict))
                    Spacer()
                    if let dtm = result.dtm { Text("Mate in \(abs(dtm) / 2 + abs(dtm) % 2)").font(.caption).foregroundStyle(.secondary) }
                }
                Text("\(position.turn.name) to move").font(.caption).foregroundStyle(.secondary)
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(result.moves) { move in
                            Button {
                                if let m = position.move(uci: move.uci) { model.game.play(m) }
                            } label: {
                                HStack {
                                    Text(move.san).font(.system(size: 13, weight: .semibold, design: .rounded))
                                        .frame(width: 60, alignment: .leading)
                                    Text(TablebaseService.verdictText(move.verdict).components(separatedBy: ",").first ?? "")
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(tint(move.verdict))
                                    Spacer()
                                    if let dtz = move.dtz {
                                        Text("DTZ \(abs(dtz))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                    }
                                    if let dtm = move.dtm {
                                        Text("DTM \(abs(dtm))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                            .frame(width: 58, alignment: .trailing)
                                    }
                                }
                                .padding(.vertical, 3)
                                .padding(.horizontal, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(PressStyle(scale: 0.97))
                        }
                    }
                }
            } else {
                VStack { ProgressView() }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .panel()
        .frame(maxHeight: .infinity, alignment: .top)
        .task(id: position.epd) {
            guard position.pieceCount <= 7 else { return }
            error = nil
            do {
                try await Task.sleep(nanoseconds: 200_000_000)
                result = try await TablebaseService.fetch(fen: position.fen)
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    private func tint(_ verdict: String) -> Color {
        verdict.contains("win") ? .green : verdict.contains("loss") ? .red : .secondary
    }

    private func icon(_ verdict: String) -> String {
        verdict.contains("win") ? "crown.fill" : verdict.contains("loss") ? "xmark.shield.fill" : "equal.circle.fill"
    }
}

/// Places pieces by hand, either to analyse a position or to describe a pattern to search for.
struct PositionEditorView: View {
    enum Purpose { case setup, pattern }

    let purpose: Purpose
    let onDone: (Position, [Piece?]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var board: [Piece?]
    @State private var turn: PieceColor
    @State private var rights: CastlingRights
    @State private var tool: Piece? = Piece(color: .white, kind: .pawn)
    @State private var flipped = false
    @State private var erasing = false
    @State private var fen = ""

    init(purpose: Purpose, initial: Position, onDone: @escaping (Position, [Piece?]) -> Void) {
        self.purpose = purpose
        self.onDone = onDone
        _board = State(initialValue: purpose == .pattern ? Array(repeating: nil, count: 64) : initial.board)
        _turn = State(initialValue: initial.turn)
        _rights = State(initialValue: initial.castling)
    }

    private var position: Position? {
        var p = Position()
        p.board = board
        p.turn = turn
        p.castling = rights
        guard let checked = Position(fen: p.fen), checked.isPlayable else { return nil }
        return checked
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(purpose == .setup ? "Set Up a Position" : "Search by Pattern").font(.title2.weight(.bold))
                Text(purpose == .setup ? "Pick a piece, then click or drag across squares. Click a piece again to remove it."
                                       : "Place only the pieces that matter. Games where they all stood on these squares at once are found.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 18) {
                editorBoard.frame(width: 400, height: 400)
                VStack(alignment: .leading, spacing: 14) {
                    palette
                    HStack {
                        Button("Start", systemImage: "arrow.counterclockwise") { withAnimation(.castleSnappy) { board = Position.start.board; rights = .all; turn = .white } }
                        Button("Clear", systemImage: "trash") { withAnimation(.castleSnappy) { board = Array(repeating: nil, count: 64); rights = [] } }
                        Button("Flip", systemImage: "arrow.up.arrow.down") { withAnimation(.castleSpring) { flipped.toggle() } }
                    }
                    .controlSize(.small)
                    if purpose == .setup {
                        Picker("To move", selection: $turn) {
                            Text("White").tag(PieceColor.white)
                            Text("Black").tag(PieceColor.black)
                        }
                        .pickerStyle(.segmented)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Castling").font(.subheadline.weight(.medium))
                            HStack {
                                right("White O-O", .whiteKing)
                                right("O-O-O", .whiteQueen)
                            }
                            HStack {
                                right("Black O-O", .blackKing)
                                right("O-O-O", .blackQueen)
                            }
                        }
                        TextField("Paste a FEN", text: $fen)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 11, design: .monospaced))
                            .onSubmit {
                                if let p = Position(fen: fen) {
                                    withAnimation(.castleSnappy) { board = p.board; turn = p.turn; rights = p.castling }
                                }
                            }
                        if position == nil {
                            Label("Needs one king each, no pawns on the back ranks, and the side that just moved not in check.",
                                  systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                                .transition(.opacity)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(width: 250)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(purpose == .setup ? "Analyse" : "Search Library") {
                    onDone(position ?? .start, board)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(purpose == .setup ? position == nil : board.allSatisfy { $0 == nil })
            }
        }
        .padding(22)
        .animation(.castleSpring, value: position == nil)
    }

    private func right(_ title: String, _ r: CastlingRights) -> some View {
        Toggle(title, isOn: Binding(get: { rights.contains(r) }, set: { if $0 { rights.insert(r) } else { rights.remove(r) } }))
            .toggleStyle(.checkbox)
    }

    private var palette: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach([PieceColor.white, .black], id: \.self) { color in
                HStack(spacing: 4) {
                    ForEach([PieceKind.king, .queen, .rook, .bishop, .knight, .pawn], id: \.self) { kind in
                        let piece = Piece(color: color, kind: kind)
                        Button {
                            tool = piece
                        } label: {
                            Image(piece.assetName).resizable().frame(width: 32, height: 32)
                                .padding(3)
                                .background(tool == piece ? AnyShapeStyle(Color.accentColor.opacity(0.35)) : AnyShapeStyle(.quaternary.opacity(0.6)),
                                            in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        }
                        .buttonStyle(PressStyle(scale: 0.85))
                    }
                }
            }
            Button {
                tool = nil
            } label: {
                Label("Eraser", systemImage: "eraser.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(tool == nil ? AnyShapeStyle(Color.accentColor.opacity(0.35)) : AnyShapeStyle(.quaternary.opacity(0.6)),
                                in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(PressStyle(scale: 0.95))
        }
    }

    private var shown: Position {
        var p = Position()
        p.board = board
        return p
    }

    private var editorBoard: some View {
        GeometryReader { geo in
            let sq = geo.size.width / 8
            BoardSnapshot(position: shown, flipped: flipped, theme: .current, coordinates: true, cornerRadius: 8)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let col = max(0, min(7, Int(value.location.x / sq))), row = max(0, min(7, Int(value.location.y / sq)))
                        let s = Sq.make(file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row)
                        if value.translation == .zero { erasing = tool == nil || board[s] == tool }
                        let wanted = erasing ? nil : tool
                        if board[s] != wanted { board[s] = wanted }
                    })
        }
        .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
    }
}

/// Renders boards to images and animated GIFs.
enum BoardExport {
    @MainActor
    static func image(_ position: Position, flipped: Bool, lastMove: Move?, side: CGFloat = 800) -> CGImage? {
        let view = BoardSnapshot(position: position, flipped: flipped, lastMove: lastMove, theme: .current,
                                 coordinates: true, cornerRadius: 0)
            .frame(width: side, height: side)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return renderer.cgImage
    }

    @MainActor @discardableResult
    static func copyImage(_ position: Position, flipped: Bool, lastMove: Move?) -> Bool {
        guard let cg = image(position, flipped: flipped, lastMove: lastMove) else { return false }
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.writeObjects([NSImage(cgImage: cg, size: NSSize(width: 800, height: 800))])
    }

    @MainActor
    static func saveImage(_ position: Position, flipped: Bool, lastMove: Move?) {
        guard let cg = image(position, flipped: flipped, lastMove: lastMove, side: 1200) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = "Position.png"
        guard panel.runModal() == .OK, let url = panel.url,
              let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cg, nil)
        CGImageDestinationFinalize(dest)
    }

    /// Writes the main line of a game as a looping GIF, one frame per move.
    @MainActor
    static func saveGIF(_ game: Game, flipped: Bool) -> Bool {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.gif]
        panel.nameFieldStringValue = "\(game.tags["White"] ?? "White") vs \(game.tags["Black"] ?? "Black").gif"
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        let nodes = [game.root] + game.mainline
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, nodes.count, nil) else { return false }
        CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        for (i, node) in nodes.enumerated() {
            guard let cg = image(node.position, flipped: flipped, lastMove: node.move, side: 480) else { continue }
            let delay = i == nodes.count - 1 ? 3.0 : 0.7
            CGImageDestinationAddImage(dest, cg, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay,
                                                                                   kCGImagePropertyGIFUnclampedDelayTime: delay]] as CFDictionary)
        }
        return CGImageDestinationFinalize(dest)
    }
}
