import SwiftUI

/// The Analysis page of the main window: a strip of tabs above the selected board.
struct AnalysisPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            if app.analyses.count > 1 {
                tabStrip
                    .transition(.move(edge: .top).combined(with: .opacity))
                Divider()
            }
            AnalysisView(model: app.analysis)
                .id(app.analysis.id)
                .transition(.opacity)
        }
        .animation(.castleSnappy, value: app.analyses.count)
        .animation(.easeOut(duration: 0.15), value: app.analysisIndex)
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(app.analyses.enumerated()), id: \.element.id) { index, tab in
                    let selected = index == app.analysisIndex
                    HStack(spacing: 6) {
                        Image(systemName: tab.isRunning ? "waveform" : "checkerboard.rectangle")
                            .font(.caption)
                            .symbolEffect(.variableColor.iterative, options: .repeating, isActive: tab.isRunning)
                        Text(tab.title).lineLimit(1).font(.callout)
                        Button {
                            app.closeTab(tab.id)
                        } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                                .frame(width: 16, height: 16)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(PressStyle(scale: 0.8))
                        .foregroundStyle(.secondary)
                        .help("Close tab")
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 6)
                    .padding(.vertical, 5)
                    .background(selected ? AnyShapeStyle(Color.accentColor.opacity(0.22)) : AnyShapeStyle(.quaternary.opacity(0.5)),
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture { app.analysisIndex = index }
                    .contextMenu {
                        Button("Move to New Window", systemImage: "macwindow.badge.plus") {
                            if let id = app.detach(tab.id) { openWindow(id: "analysis", value: id) }
                        }
                        Button("Close Tab", systemImage: "xmark") { app.closeTab(tab.id) }
                    }
                }
                Button {
                    app.newTab()
                } label: {
                    Image(systemName: "plus").frame(width: 26, height: 26).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle(scale: 0.85))
                .help("New tab")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}

struct AnalysisView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow
    let model: AnalysisModel
    var isDetached = false

    @FocusState private var focused: Bool
    @AppStorage("analysisSideTab") private var sideTab = "moves"
    @State private var editing = false
    @State private var exportMessage: String?

    var body: some View {
        let game = model.game
        let _ = game.revision

        HStack(spacing: 0) {
            VStack(spacing: 14) {
                HStack(spacing: 12) {
                    EvalBar(score: model.currentScore, flipped: model.flipped)
                    BoardView(position: game.position, flipped: model.flipped, lastMove: game.current.move,
                              arrows: arrows, shapes: game.current.shapes, movableColor: game.position.turn,
                              onShape: { shape in
                                  game.current.toggle(shape)
                                  game.touch()
                              }) { move in
                        Sound.move(capture: game.position.isCapture(move))
                        game.play(move)
                    }
                }
                HStack(spacing: 10) {
                    NavigationBar(game: game) { withAnimation(.castleSpring) { model.flipped.toggle() } }
                    Toggle(isOn: Binding(get: { model.threatMode }, set: { model.threatMode = $0 })) {
                        Label("Threat", systemImage: "exclamationmark.shield.fill")
                    }
                    .toggleStyle(.button)
                    .controlSize(.small)
                    .help("Show what the opponent threatens if you pass (X)")
                    if !game.current.shapes.isEmpty {
                        Button("Clear Drawings", systemImage: "eraser") {
                            game.current.shapes = []
                            game.touch()
                        }
                        .controlSize(.small)
                        .transition(.pop)
                    }
                }
                .animation(.castleSpring, value: game.current.shapes.isEmpty)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .staggered(0)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                EnginePanel(model: model).staggered(1)
                openingRow(game).staggered(2)
                Picker("Panel", selection: $sideTab.animation(.castleSnappy)) {
                    Text("Moves").tag("moves")
                    Text("Explorer").tag("explorer")
                    Text("Tablebase").tag("tablebase")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .staggered(3)

                Group {
                    switch sideTab {
                    case "explorer":
                        ExplorerPanel(model: model).transition(.opacity)
                    case "tablebase":
                        TablebasePanel(model: model).transition(.opacity)
                    default:
                        VStack(alignment: .leading, spacing: 12) {
                            MoveListView(game: game)
                                .frame(maxHeight: .infinity)
                                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            AnnotationBar(game: game)
                            ReviewPanel(model: model)
                        }
                        .transition(.opacity)
                    }
                }
                .frame(maxHeight: .infinity)
                .staggered(4)
            }
            .padding(16)
            .frame(width: 380)
        }
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(.leftArrow) { game.back(); return .handled }
        .onKeyPress(.rightArrow) { game.forward(); return .handled }
        .onKeyPress(.upArrow) { game.toStart(); return .handled }
        .onKeyPress(.downArrow) { game.toEnd(); return .handled }
        .onKeyPress("x") { model.threatMode.toggle(); return .handled }
        .onAppear { focused = true }
        .onChange(of: game.current.id) { model.refresh() }
        .onChange(of: game.id) { model.refresh(force: true) }
        .toolbar { toolbar }
        .sheet(isPresented: $editing) {
            PositionEditorView(purpose: .setup, initial: game.position) { position, _ in
                model.newGame(from: position)
            }
        }
        .overlay(alignment: .bottom) {
            if let exportMessage {
                Label(exportMessage, systemImage: "checkmark.circle.fill")
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(radius: 8, y: 3)
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .navigationTitle(isDetached ? model.title : "Analysis")
        .navigationSubtitle(subtitle(game))
    }

    private func subtitle(_ game: Game) -> String {
        guard !game.mainline.isEmpty else { return game.isChess960 ? "Chess960" : "New board" }
        return "\(game.tags["White"] ?? "White") – \(game.tags["Black"] ?? "Black")  \(game.result)"
    }

    private var arrows: [BoardArrow] {
        guard model.isRunning else { return [] }
        let limit = model.threatMode ? 1 : 3
        return model.lines.prefix(limit).enumerated().compactMap { i, line in
            Move(uci: line.firstMove).map {
                BoardArrow(from: $0.from, to: $0.to, strength: i == 0 ? 1 : 0.3, tint: model.threatMode ? .red : nil)
            }
        }
    }

    private func flash(_ text: String) {
        withAnimation(.castleSpring) { exportMessage = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            withAnimation(.castleSpring) { exportMessage = nil }
        }
    }

    private func openingRow(_ game: Game) -> some View {
        let opening = app.openings.opening(for: game.current)
        return HStack(spacing: 8) {
            Image(systemName: "book.closed.fill").foregroundStyle(.secondary)
            if let opening {
                Text(opening.eco).font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                Text(opening.name).lineLimit(1)
            } else {
                Text(game.tags["Opening"] ?? (game.current.parent == nil ? "Starting position" : "Unnamed opening")).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .contentTransition(.opacity)
        .animation(.easeInOut(duration: 0.2), value: opening)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if !isDetached {
                Button("New Tab", systemImage: "plus.square.on.square") { app.newTab() }
                    .help("Open another analysis board in a tab")
            }
            Button("Set Up Position", systemImage: "square.grid.3x3.square") { editing = true }
                .help("Place pieces by hand")
            Button("Open PGN", systemImage: "folder") { app.openPGNPanel() }
                .help("Open a PGN file")
            Button("Paste", systemImage: "doc.on.clipboard") { app.paste() }
                .help("Paste a FEN or PGN from the clipboard")
            Menu("Position", systemImage: "scope") {
                Button("Find in Library", systemImage: "magnifyingglass") {
                    app.library.filterExact(model.game.position)
                    app.go(.library)
                }
                Button("Play From Here", systemImage: "flag.checkered") { app.playFromHere(model.game.position) }
                Divider()
                Button("Add Line to White Repertoire", systemImage: "book") { app.repertoire.importLine(model.game, color: .white); flash("Added to the White repertoire") }
                    .disabled(model.game.root.position != .start)
                Button("Add Line to Black Repertoire", systemImage: "book.fill") { app.repertoire.importLine(model.game, color: .black); flash("Added to the Black repertoire") }
                    .disabled(model.game.root.position != .start)
                if !isDetached {
                    Divider()
                    Button("Move to New Window", systemImage: "macwindow.badge.plus") {
                        if let id = app.detach(model.id) { openWindow(id: "analysis", value: id) }
                    }
                }
            }
            Menu("Share", systemImage: "square.and.arrow.up") {
                Button("Copy FEN", systemImage: "number") { app.copy(model.game.position.fen) }
                Button("Copy PGN", systemImage: "doc.text") { app.copy(PGN.write(model.game)) }
                Button("Copy Board Image", systemImage: "photo.on.rectangle") {
                    if BoardExport.copyImage(model.game.position, flipped: model.flipped, lastMove: model.game.current.move) { flash("Board image copied") }
                }
                Divider()
                Button("Save Board Image…", systemImage: "photo") {
                    BoardExport.saveImage(model.game.position, flipped: model.flipped, lastMove: model.game.current.move)
                }
                Button("Save Game as GIF…", systemImage: "film") {
                    if BoardExport.saveGIF(model.game, flipped: model.flipped) { flash("GIF saved") }
                }
                .disabled(model.game.mainline.isEmpty)
                Button("Save PGN…", systemImage: "square.and.arrow.down") { app.savePGNPanel() }
                Button("Add to Library", systemImage: "books.vertical") { app.library.add(model.game); flash("Added to the Library") }
            }
        }
    }
}

/// Move marks and a comment for the move on the board.
private struct AnnotationBar: View {
    let game: Game
    private static let marks: [(Int, String)] = [(3, "!!"), (1, "!"), (5, "!?"), (6, "?!"), (2, "?"), (4, "??")]

    var body: some View {
        let _ = game.revision
        let node = game.current
        HStack(spacing: 6) {
            ForEach(Self.marks, id: \.0) { value, symbol in
                let on = node.nag == value
                Button {
                    node.nag = on ? nil : value
                    game.touch()
                } label: {
                    Text(symbol)
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .frame(width: 26, height: 22)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .background(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary),
                                    in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(PressStyle(scale: 0.85))
                .disabled(node.parent == nil)
            }
            TextField("Comment on this move", text: Binding(get: { node.comment }, set: {
                node.comment = $0
                game.touch()
            }))
            .textFieldStyle(.roundedBorder)
            .id(node.id)
        }
    }
}

private struct EnginePanel: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: AnalysisModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.castleSpring) { model.toggle() }
                } label: {
                    Image(systemName: model.isRunning ? "pause.fill" : "play.fill")
                        .contentTransition(.symbolEffect(.replace))
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(model.isRunning ? Color.orange.gradient : Color.accentColor.gradient, in: Circle())
                }
                .buttonStyle(PressStyle(scale: 0.85))
                .help(model.isRunning ? "Stop the engine" : "Start the engine")
                .keyboardShortcut("e")

                Menu {
                    Picker("Engine", selection: Binding(get: { model.engineID }, set: { model.selectEngine($0) })) {
                        ForEach(app.catalog.available) { e in
                            Text(e.name).tag(e.id)
                        }
                    }
                    .pickerStyle(.inline)
                    Divider()
                    Picker("Lines", selection: $model.multiPV) {
                        ForEach(1...5, id: \.self) { Text("\($0) line\($0 == 1 ? "" : "s")").tag($0) }
                    }
                    Menu("Add Another Engine") {
                        ForEach(app.catalog.available) { e in
                            Button(e.name) { withAnimation(.castleSpring) { model.addEngine(e.id) } }
                        }
                    }
                    .disabled(model.slots.count >= 4)
                    Divider()
                    Button("Manage Engines…", systemImage: "cpu") { app.go(.engines) }
                } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(model.slots.count > 1 ? "\(model.slots.count) engines" : model.engineName).font(.headline)
                        Text(status(model.slots[0])).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()

                Spacer()

                if let score = model.currentScore {
                    Text(score.display)
                        .font(.system(.title2, design: .rounded).weight(.bold).monospacedDigit())
                        .contentTransition(.numericText())
                        .animation(.snappy, value: score)
                }
            }

            if model.isRunning {
                VStack(alignment: .leading, spacing: 6) {
                    if model.threatMode {
                        Label(model.threatUnavailable ? "No threat to show while in check" : "Showing the opponent's threat",
                              systemImage: "exclamationmark.shield.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.red)
                    }
                    ForEach(model.slots) { slot in
                        slotView(slot)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .panel()
        .onChange(of: model.multiPV) { model.refresh(force: true) }
    }

    @ViewBuilder
    private func slotView(_ slot: EngineSlot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.slots.count > 1 {
                HStack(spacing: 6) {
                    Text(slot.name).font(.caption.weight(.semibold)).lineLimit(1)
                    Text(status(slot)).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                    Spacer()
                    Button {
                        withAnimation(.castleSpring) { model.remove(slot) }
                    } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(PressStyle(scale: 0.8))
                    .help("Remove this engine")
                }
                .padding(.top, 2)
            }
            if slot.lines.isEmpty, !model.threatUnavailable {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Thinking…").foregroundStyle(.secondary)
                }
                .font(.callout)
            }
            ForEach(slot.lines) { line in
                Button {
                    guard !model.threatMode else { return }
                    if let m = model.game.position.move(uci: line.firstMove) { model.game.play(m) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.score.display)
                            .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                            .foregroundStyle(line.score.winPercent >= 50 ? Color.black : Color.white)
                            .frame(width: 48)
                            .padding(.vertical, 2)
                            .background(line.score.winPercent >= 50 ? Color(white: 0.95) : Color(white: 0.15),
                                        in: RoundedRectangle(cornerRadius: 4))
                        Text(line.san)
                            .font(.system(size: 12, design: .rounded))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle(scale: 0.97))
                .help("Play the first move of this line")
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeOut(duration: 0.18), value: slot.lines.count)
    }

    private func status(_ slot: EngineSlot) -> String {
        guard model.isRunning else { return "Engine off" }
        guard let best = slot.lines.first else { return "Starting…" }
        let speed = best.nps >= 1_000_000 ? String(format: "%.1f Mn/s", Double(best.nps) / 1_000_000)
                                          : "\(best.nps / 1000) kn/s"
        return "Depth \(best.depth) · \(speed)"
    }
}

private struct ReviewPanel: View {
    @Environment(AppModel.self) private var app
    let model: AnalysisModel

    var body: some View {
        let _ = model.game.revision
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Game Review", systemImage: "sparkle.magnifyingglass").font(.headline)
                Spacer()
                if model.isReviewing {
                    Button("Stop") { model.stopReview() }.controlSize(.small)
                } else {
                    Button(model.summary == nil ? "Review" : "Again") {
                        withAnimation(.castleSpring) { model.startReview() }
                    }
                    .controlSize(.small)
                    .disabled(model.game.mainline.isEmpty)
                }
            }
            if model.isReviewing {
                ProgressView(value: model.reviewProgress)
                    .animation(.linear(duration: 0.2), value: model.reviewProgress)
                    .transition(.opacity)
            }
            if let s = model.summary {
                HStack(spacing: 10) {
                    accuracy(.white, s)
                    accuracy(.black, s)
                }
                .transition(.pop)
                EvalChart(game: model.game)
                    .frame(height: 56)
                    .transition(.opacity)
                let mistakes = model.mistakePuzzles()
                if !mistakes.isEmpty {
                    Button {
                        app.puzzles.addMistakes(mistakes)
                        app.puzzles.setMode(.mistakes)
                        app.go(.puzzles)
                    } label: {
                        Label("Train \(mistakes.count) Mistake\(mistakes.count == 1 ? "" : "s")", systemImage: "target")
                            .frame(maxWidth: .infinity)
                    }
                    .help("Turn every mistake and blunder into a puzzle")
                    .transition(.opacity)
                }
            } else if !model.isReviewing {
                Text("Grades every move, finds blunders and draws the evaluation graph.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .panel()
        .animation(.castleSpring, value: model.summary == nil)
        .animation(.castleSpring, value: model.isReviewing)
    }

    private func accuracy(_ color: PieceColor, _ s: ReviewSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(color == .white ? Color.white : Color(white: 0.12))
                    .overlay(Circle().strokeBorder(.secondary.opacity(0.5)))
                    .frame(width: 10, height: 10)
                Text(String(format: "%.1f%%", s.accuracy[color] ?? 0))
                    .font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
            }
            HStack(spacing: 8) {
                mark("?!", s.inaccuracies[color] ?? 0, Color(red: 0.75, green: 0.6, blue: 0.1))
                mark("?", s.mistakes[color] ?? 0, .orange)
                mark("??", s.blunders[color] ?? 0, .red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func mark(_ symbol: String, _ count: Int, _ tint: Color) -> some View {
        Text("\(count) \(symbol)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(tint)
    }
}
