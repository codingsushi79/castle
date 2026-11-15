import SwiftUI

struct PuzzleView: View {
    @Environment(AppModel.self) private var app
    @State private var shakes: CGFloat = 0

    var body: some View {
        @Bindable var model = app.puzzles

        HStack(spacing: 0) {
            BoardView(position: model.position, flipped: model.userColor == .black, lastMove: model.lastMove,
                      hintSquare: model.hintSquare, movableColor: model.canMove ? model.userColor : nil) {
                model.attempt($0)
            }
            .modifier(Shake(animatableData: shakes))
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .id(model.puzzle?.id)
            .transition(.opacity.combined(with: .scale(scale: 0.97)))
            .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.puzzle?.id)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                switch model.mode {
                case .rated: ratingCard(model).staggered(0)
                case .rush: rushCard(model).staggered(0)
                case .mistakes: mistakesCard(model).staggered(0)
                case .daily: dailyCard(model).staggered(0)
                }
                if model.status != .rushOver, model.status != .empty {
                    statusCard(model).staggered(1)
                    if let p = model.puzzle { infoCard(model, p).staggered(2) }
                }
                Spacer(minLength: 0)
                if model.mode == .rated {
                    Picker("Theme", selection: $model.theme) {
                        ForEach(model.themes, id: \.self) { Text(PuzzleModel.themeNames[$0] ?? $0).tag($0) }
                    }
                    .staggered(3)
                }
                if model.mode == .rush {
                    rushActions(model).staggered(4)
                } else if model.status != .empty {
                    actions(model).staggered(4)
                }
            }
            .padding(16)
            .frame(width: 340)
            .animation(.castleSpring, value: model.mode)
        }
        .toolbar {
            ToolbarItem {
                Picker("Mode", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                    ForEach(PuzzleModel.Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .help("Rated puzzles, a timed rush, positions from your own games, or today's puzzle")
            }
        }
        .onChange(of: model.status) { _, status in
            if status == .wrong {
                withAnimation(.linear(duration: 0.4)) { shakes += 1 }
            }
        }
        .navigationTitle("Puzzles")
        .navigationSubtitle(model.isLoaded ? "\(model.total.formatted()) puzzles" : "Loading…")
    }

    private func ratingCard(_ model: PuzzleModel) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Your rating").font(.caption).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: "\(model.rating)")
                        .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText(value: Double(model.rating)))
                    if model.lastDelta != 0 {
                        Text(model.lastDelta > 0 ? "+\(model.lastDelta)" : "\(model.lastDelta)")
                            .font(.headline.monospacedDigit())
                            .foregroundStyle(model.lastDelta > 0 ? .green : .red)
                            .transition(.pop)
                    }
                }
                .animation(.castleSpring, value: model.rating)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Label("\(model.streak)", systemImage: "flame.fill")
                    .foregroundStyle(model.streak > 0 ? .orange : .secondary)
                    .symbolEffect(.bounce, value: model.streak)
                    .contentTransition(.numericText())
                Text("\(model.solvedCount) solved · \(model.failedCount) missed")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
        .panel()
    }

    private func rushCard(_ model: PuzzleModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.rushActive ? "Solved" : "Last run").font(.caption).foregroundStyle(.secondary)
                    Text(verbatim: "\(model.rushScore)")
                        .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText(value: Double(model.rushScore)))
                        .animation(.castleSpring, value: model.rushScore)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(PlayModel.clockText(model.rushActive ? model.rushRemaining : Double(model.rushMinutes * 60)))
                        .font(.system(.title2, design: .rounded).monospacedDigit().weight(.semibold))
                        .foregroundStyle(model.rushActive && model.rushRemaining < 20 ? .red : .primary)
                    HStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { i in
                            Image(systemName: i < model.rushStrikes ? "xmark.circle.fill" : "circle")
                                .foregroundStyle(i < model.rushStrikes ? .red : .secondary)
                                .contentTransition(.symbolEffect(.replace))
                        }
                    }
                    .font(.callout)
                }
            }
            Text("Best: \(model.rushBest). Three misses or the clock end the run. Puzzles get harder as you go.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .panel()
    }

    @ViewBuilder
    private func rushActions(_ model: PuzzleModel) -> some View {
        @Bindable var model = model
        if !model.rushActive {
            VStack(spacing: 8) {
                Picker("Length", selection: $model.rushMinutes) {
                    Text("3 minutes").tag(3)
                    Text("5 minutes").tag(5)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                Button {
                    model.startRush()
                } label: {
                    Label("Start Rush", systemImage: "bolt.fill")
                }
                .buttonStyle(.hero)
                .keyboardShortcut(.defaultAction)
                .disabled(!model.isLoaded)
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func mistakesCard(_ model: PuzzleModel) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(model.mistakes.count) position\(model.mistakes.count == 1 ? "" : "s") to fix", systemImage: "target")
                .font(.title3.weight(.semibold))
                .contentTransition(.numericText())
            if model.mistakes.isEmpty {
                Text("Review a game in Analysis, then choose Train Mistakes. Each mistake becomes a puzzle here until you solve it first try.")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Open Analysis", systemImage: "waveform.path.ecg") { app.go(.analysis) }
            } else if let source = model.puzzle?.source {
                Text("From \(source). Find the move you missed.").font(.callout).foregroundStyle(.secondary)
            }
        }
        .panel()
    }

    private func dailyCard(_ model: PuzzleModel) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date.now.formatted(date: .complete, time: .omitted)).font(.caption).foregroundStyle(.secondary)
                Label(model.dailySolved ? "Solved today" : "Today's puzzle",
                      systemImage: model.dailySolved ? "checkmark.seal.fill" : "calendar")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(model.dailySolved ? .green : .primary)
            }
            Spacer()
            Label("\(model.dailyStreak)", systemImage: "flame.fill")
                .foregroundStyle(model.dailyStreak > 0 ? .orange : .secondary)
                .help("Days in a row")
        }
        .panel()
    }

    private func statusCard(_ model: PuzzleModel) -> some View {
        let (symbol, title, detail, tint): (String, String, String, Color) = {
            switch model.status {
            case .loading: return ("hourglass", "Loading puzzles", "One moment…", .secondary)
            case .solving:
                return (model.userColor == .white ? "circle" : "circle.fill",
                        "\(model.userColor.name) to move", "Find the best move.", .primary)
            case .wrong: return ("xmark.circle.fill", "Not that one", "Have another look.", .red)
            case .solved: return ("checkmark.circle.fill", "Solved", "Nicely done.", .green)
            case .revealed: return ("eye.fill", "Solution", "Play through it, then try the next one.", .orange)
            case .empty, .rushOver: return ("hourglass", "", "", .secondary)
            }
        }()
        return HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(tint)
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: model.status == .solved)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title3.weight(.semibold))
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .panel()
        .animation(.castleSpring, value: model.status)
    }

    private func infoCard(_ model: PuzzleModel, _ p: Puzzle) -> some View {
        let finished = model.status == .solved || model.status == .revealed
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Puzzle \(p.id)", systemImage: "number").font(.subheadline.weight(.medium))
                Spacer()
                Text(finished ? "Rated \(p.rating)" : "Rating hidden")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.opacity)
            }
            if finished {
                FlowLayout(spacing: 5, lineSpacing: 5) {
                    ForEach(p.themes.prefix(6), id: \.self) { theme in
                        Chip(text: PuzzleModel.themeNames[theme] ?? theme)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if !model.playedSAN.isEmpty {
                Text(model.playedSAN.joined(separator: "  "))
                    .font(.system(.callout, design: .rounded))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .panel()
        .animation(.castleSpring, value: finished)
    }

    @ViewBuilder
    private func actions(_ model: PuzzleModel) -> some View {
        let finished = model.status == .solved || model.status == .revealed
        VStack(spacing: 8) {
            if finished, model.mode != .daily {
                Button {
                    model.next()
                } label: {
                    Label("Next Puzzle", systemImage: "arrow.right")
                }
                .buttonStyle(.hero)
                .keyboardShortcut(.defaultAction)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack {
                if finished {
                    Button {
                        model.retry()
                    } label: {
                        Label("Retry", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
                    }
                    Button {
                        if let p = model.puzzle, let pos = Position(fen: p.fen) { app.analyse(position: pos) }
                    } label: {
                        Label("Analyse", systemImage: "waveform.path.ecg").frame(maxWidth: .infinity)
                    }
                } else {
                    Button {
                        model.hint()
                    } label: {
                        Label("Hint", systemImage: "lightbulb.fill").frame(maxWidth: .infinity)
                    }
                    .disabled(!model.canMove)
                    Button {
                        model.reveal()
                    } label: {
                        Label("Solution", systemImage: "eye.fill").frame(maxWidth: .infinity)
                    }
                    .disabled(model.status == .loading)
                    if model.mode != .daily {
                        Button {
                            model.next()
                        } label: {
                            Label("Skip", systemImage: "forward.fill").frame(maxWidth: .infinity)
                        }
                        .disabled(model.status == .loading)
                    }
                }
            }
            .controlSize(.large)
        }
        .animation(.castleSpring, value: finished)
    }
}
