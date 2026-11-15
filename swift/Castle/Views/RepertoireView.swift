import SwiftUI

struct RepertoireView: View {
    @Environment(AppModel.self) private var app
    @State private var shakes: CGFloat = 0
    @State private var confirmClear = false

    var body: some View {
        @Bindable var model = app.repertoire
        ZStack {
            if model.isTraining {
                trainer(model).transition(.page)
            } else {
                builder(model).transition(.page)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.isTraining)
        .toolbar {
            ToolbarItemGroup {
                Picker("Colour", selection: $model.color) {
                    Text("White").tag(PieceColor.white)
                    Text("Black").tag(PieceColor.black)
                }
                .pickerStyle(.segmented)
                .disabled(model.isTraining)
                .help("Which repertoire to work on")
            }
        }
        .navigationTitle("Repertoire")
        .navigationSubtitle("\(model.color.name): \(model.positions(for: model.color).count) positions, \(model.due(for: model.color).count) due")
    }

    // MARK: Building

    private func builder(_ model: RepertoireModel) -> some View {
        let game = model.game
        let _ = game.revision
        let total = model.positions(for: model.color).count
        let due = model.due(for: model.color).count
        return HStack(spacing: 0) {
            VStack(spacing: 14) {
                BoardView(position: game.position, flipped: model.color == .black, lastMove: game.current.move,
                          shapes: game.current.shapes, movableColor: game.position.turn,
                          onShape: { game.current.toggle($0); game.touch() }) { move in
                    Sound.move(capture: game.position.isCapture(move))
                    game.play(move)
                    model.save()
                }
                NavigationBar(game: game)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .id(model.color)
            .staggered(0)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    stat("\(total)", "Positions", "square.stack.3d.up.fill", .accentColor)
                    stat("\(due)", "Due", "clock.badge.exclamationmark.fill", due > 0 ? .orange : .secondary)
                    stat("\(model.learned(for: model.color))", "Learned", "checkmark.seal.fill", .green)
                }
                .staggered(1)

                if let opening = app.openings.opening(for: game.current) {
                    HStack(spacing: 8) {
                        Image(systemName: "book.closed.fill").foregroundStyle(.secondary)
                        Text(opening.eco).font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                        Text(opening.name).lineLimit(1)
                    }
                    .font(.callout)
                }

                MoveListView(game: game)
                    .frame(maxHeight: .infinity)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        if game.mainline.isEmpty {
                            ContentUnavailableView("Empty Repertoire", systemImage: "book",
                                                   description: Text("Play moves on the board to add lines. Add several replies for the opponent, one for yourself."))
                        }
                    }
                    .staggered(2)

                let library = app.library.explorer(for: game.position)
                if !library.moves.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Played in your library").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        FlowLayout(spacing: 5, lineSpacing: 5) {
                            ForEach(library.moves.prefix(8)) { m in
                                Button {
                                    if let move = game.position.move(san: m.san) { game.play(move); model.save() }
                                } label: {
                                    Chip(text: "\(m.san)  \(m.total)")
                                }
                                .buttonStyle(.press)
                            }
                        }
                    }
                    .panel()
                }

                HStack {
                    Button("Import PGN…", systemImage: "square.and.arrow.down") { importPGN(model) }
                    Button("From Analysis", systemImage: "waveform.path.ecg") {
                        model.importLine(app.analysis.game, color: model.color)
                    }
                    .help("Add the lines on the current analysis board")
                    .disabled(app.analysis.game.mainline.isEmpty || app.analysis.game.root.position != .start)
                    Spacer()
                    Button("Clear", systemImage: "trash", role: .destructive) { confirmClear = true }
                        .labelStyle(.iconOnly)
                        .disabled(game.mainline.isEmpty)
                        .help("Delete this repertoire")
                }
                .controlSize(.small)

                Button {
                    model.startTraining()
                } label: {
                    Label(due > 0 ? "Train \(min(due, 30)) Due Position\(due == 1 ? "" : "s")" : "Nothing Due", systemImage: "brain.head.profile")
                }
                .buttonStyle(.hero)
                .disabled(due == 0)
                .staggered(3)
            }
            .padding(16)
            .frame(width: 380)
        }
        .onChange(of: game.revision) { model.save() }
        .confirmationDialog("Delete the whole \(model.color.name) repertoire?", isPresented: $confirmClear) {
            Button("Delete Repertoire", role: .destructive) { model.clear(model.color) }
        } message: {
            Text("This removes every line. It cannot be undone.")
        }
    }

    private func stat(_ value: String, _ label: String, _ symbol: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(verbatim: value).font(.system(size: 24, weight: .bold, design: .rounded).monospacedDigit())
                .contentTransition(.numericText())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .panel()
    }

    private func importPGN(_ model: RepertoireModel) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "pgn") ?? .plainText, .plainText]
        guard panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        for entry in PGN.split(text) { model.importLine(PGN.parse(entry), color: model.color) }
    }

    // MARK: Training

    private func trainer(_ model: RepertoireModel) -> some View {
        HStack(spacing: 0) {
            BoardView(position: model.trainPosition, flipped: model.color == .black,
                      lastMove: model.trainStatus == .correct ? model.answer : model.trainNode?.move,
                      movableColor: model.trainStatus == .asking || model.trainStatus == .wrong ? model.color : nil) {
                model.attempt($0)
            }
            .modifier(Shake(animatableData: shakes))
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Session").font(.headline)
                        Spacer()
                        Text("\(model.sessionDone) of \(model.sessionTotal)").monospacedDigit().foregroundStyle(.secondary)
                    }
                    ProgressView(value: Double(model.sessionDone), total: Double(max(1, model.sessionTotal)))
                        .animation(.castleSpring, value: model.sessionDone)
                }
                .panel()

                statusCard(model)

                if let node = model.trainNode, let opening = app.openings.opening(for: node) {
                    Label(opening.name, systemImage: "book.closed.fill").font(.callout).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Button {
                    model.stopTraining()
                } label: {
                    Label(model.trainStatus == .finished ? "Done" : "End Session", systemImage: model.trainStatus == .finished ? "checkmark" : "xmark")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .keyboardShortcut(model.trainStatus == .finished ? .defaultAction : .cancelAction)
            }
            .padding(16)
            .frame(width: 340)
        }
        .onChange(of: model.trainStatus) { _, status in
            if status == .wrong { withAnimation(.linear(duration: 0.4)) { shakes += 1 } }
        }
    }

    private func statusCard(_ model: RepertoireModel) -> some View {
        let (symbol, title, detail, tint): (String, String, String, Color) = {
            switch model.trainStatus {
            case .asking: return ("questionmark.circle.fill", "Your move", "Play the reply from your repertoire.", .accentColor)
            case .correct: return ("checkmark.circle.fill", "Correct", "On to the next one.", .green)
            case .wrong: return ("xmark.circle.fill", "Not in your repertoire",
                                 "You prepared \(model.expected.joined(separator: " or ")). Play it to continue.", .red)
            case .finished: return ("party.popper.fill", "Session complete",
                                    "\(model.sessionTotal) positions reviewed, \(model.sessionMisses) missed.", .green)
            case .idle: return ("hourglass", "Ready", "", .secondary)
            }
        }()
        return HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(tint)
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: model.trainStatus == .correct)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title3.weight(.semibold))
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .panel()
        .animation(.castleSpring, value: model.trainStatus)
    }
}
