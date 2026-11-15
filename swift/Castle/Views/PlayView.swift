import SwiftUI

struct PlayView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.play
        ZStack {
            if model.phase == .setup {
                PlaySetupView(model: model).transition(.page)
            } else {
                PlayGameView(model: model).transition(.page)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.phase == .setup)
        .navigationTitle("Play")
        .navigationSubtitle(model.phase == .setup ? "New game" : "\(model.name(for: .white)) – \(model.name(for: .black))")
    }
}

private struct PlaySetupView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: PlayModel

    var body: some View {
        HStack(spacing: 0) {
            BoardView(position: model.customStart ?? .start, flipped: model.side == .black)
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("New Game").font(.largeTitle.weight(.bold))
                        Text("Pick an opponent and a pace.").foregroundStyle(.secondary)
                    }
                    .staggered(0)

                    section("Opponent", "person.2.fill") {
                        Picker("Opponent", selection: $model.opponent) {
                            ForEach(Opponent.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()

                        if model.opponent == .engine {
                            Picker("Engine", selection: $model.engineID) {
                                ForEach(app.catalog.available) { Text($0.name).tag($0.id) }
                            }
                            Toggle("Limit playing strength", isOn: $model.limitStrength.animation(.castleSpring))
                            if model.limitStrength {
                                HStack {
                                    Image(systemName: "tortoise.fill").foregroundStyle(.secondary)
                                    Slider(value: $model.elo, in: 600...2800, step: 50)
                                    Image(systemName: "hare.fill").foregroundStyle(.secondary)
                                    Text(verbatim: "\(Int(model.elo))")
                                        .font(.body.monospacedDigit().weight(.semibold))
                                        .contentTransition(.numericText())
                                        .frame(width: 44, alignment: .trailing)
                                        .animation(.snappy, value: model.elo)
                                }
                                .transition(.opacity.combined(with: .move(edge: .top)))
                            }
                        }
                    }
                    .staggered(1)

                    if model.opponent == .engine {
                        section("Play as", "circle.lefthalf.filled") {
                            Picker("Side", selection: $model.side.animation(.castleSpring)) {
                                ForEach(SideChoice.allCases) { Text($0.rawValue).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        .staggered(2)
                    }

                    section("Starting position", "square.grid.3x3.fill") {
                        if let custom = model.customStart {
                            HStack {
                                Label("\(custom.turn.name) to move, from the position you chose", systemImage: "scope")
                                    .font(.callout)
                                Spacer()
                                Button("Reset", systemImage: "xmark.circle.fill") {
                                    withAnimation(.castleSpring) { model.customStart = nil }
                                }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.borderless)
                            }
                        } else {
                            Picker("Variant", selection: $model.variant.animation(.castleSpring)) {
                                ForEach(PlayVariant.allCases) { Text($0.rawValue).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            if model.variant == .chess960 {
                                Text("A random Fischer starting position. Castle by dropping the king on its rook or on its usual castled square.")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .transition(.opacity)
                            }
                        }
                    }
                    .staggered(3)

                    section("Time control", "clock.fill") {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                            ForEach(TimeControl.presets) { tc in
                                let chosen = model.timeControl == tc
                                Button {
                                    withAnimation(.castleSpring) { model.timeControl = tc }
                                } label: {
                                    VStack(spacing: 4) {
                                        Image(systemName: tc.symbol)
                                            .symbolEffect(.bounce, value: chosen)
                                        Text(tc.label).font(.caption.weight(.semibold))
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 9)
                                    .foregroundStyle(chosen ? Color.white : Color.primary)
                                    .background(chosen ? AnyShapeStyle(Color.accentColor.gradient) : AnyShapeStyle(.quaternary),
                                                in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                                }
                                .buttonStyle(PressStyle(scale: 0.9))
                            }
                        }
                    }
                    .staggered(3)

                    Button {
                        model.start()
                    } label: {
                        Label("Start Game", systemImage: "play.fill")
                    }
                    .buttonStyle(.hero)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.opponent == .engine && app.catalog.available.isEmpty)
                    .staggered(4)
                }
                .padding(24)
            }
            .frame(width: 380)
        }
    }

    private func section<Content: View>(_ title: String, _ symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(.headline)
            content()
        }
        .panel()
    }
}

private struct PlayGameView: View {
    @Environment(AppModel.self) private var app
    let model: PlayModel

    var body: some View {
        let game = model.game
        let top: PieceColor = model.flipped ? .white : .black
        let balance = game.lastMainlineNode.position.materialBalance
        let liveTurn = game.lastMainlineNode.position.turn

        HStack(spacing: 0) {
            VStack(spacing: 10) {
                strip(top, balance: balance, liveTurn: liveTurn)
                BoardView(position: game.position, flipped: model.flipped, lastMove: game.current.move,
                          movableColor: model.movableColor) { model.humanMove($0) }
                strip(top.opposite, balance: balance, liveTurn: liveTurn)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                statusCard
                if let opening = app.openings.opening(for: game.lastMainlineNode) {
                    HStack(spacing: 8) {
                        Image(systemName: "book.closed.fill").foregroundStyle(.secondary)
                        Text(opening.name).lineLimit(1)
                    }
                    .font(.callout)
                    .transition(.opacity)
                }
                MoveListView(game: game, allowEditing: false)
                    .frame(maxHeight: .infinity)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                HStack {
                    NavigationBar(game: game)
                    Spacer()
                }
                actions
            }
            .padding(16)
            .frame(width: 340)
        }
    }

    private func strip(_ color: PieceColor, balance: Int, liveTurn: PieceColor) -> some View {
        PlayerStrip(name: model.name(for: color), color: color,
                    detail: model.opponent == .engine && color != model.humanColor && model.limitStrength
                        ? "\(Int(model.elo))" : nil,
                    clock: model.hasClock ? model.clocks[color] : nil,
                    isActive: model.phase == .playing && liveTurn == color,
                    material: color == .white ? max(0, balance) : max(0, -balance))
    }

    @ViewBuilder
    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let outcome = model.outcome {
                Label(outcome.result, systemImage: "flag.checkered.2.crossed")
                    .font(.system(.title, design: .rounded).weight(.bold))
                    .symbolEffect(.bounce, value: model.phase == .finished)
                Text(outcome.summary).foregroundStyle(.secondary)
            } else if model.isThinking {
                Label("\(model.engineName) is thinking", systemImage: "brain")
                    .font(.headline)
                    .symbolEffect(.pulse, options: .repeating)
                Text(model.thinkingLine.isEmpty ? " " : model.thinkingLine)
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            } else {
                Label("\(model.game.lastMainlineNode.position.turn.name) to move", systemImage: "hand.point.up.left.fill")
                    .font(.headline)
                Text(model.game.lastMainlineNode.position.inCheck ? "Check" : " ")
                    .font(.caption).foregroundStyle(.red)
            }
        }
        .panel()
        .animation(.castleSpring, value: model.isThinking)
        .animation(.castleSpring, value: model.phase == .finished)
    }

    @ViewBuilder
    private var actions: some View {
        if model.phase == .finished {
            VStack(spacing: 8) {
                Button {
                    app.analyse(model.game)
                } label: {
                    Label("Analyse Game", systemImage: "waveform.path.ecg")
                }
                .buttonStyle(.hero)
                HStack {
                    Button {
                        model.start()
                    } label: {
                        Label("Rematch", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
                    }
                    Button {
                        model.backToSetup()
                    } label: {
                        Label("New Game", systemImage: "plus").frame(maxWidth: .infinity)
                    }
                }
                .controlSize(.large)
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
            HStack {
                Button {
                    model.takeBack()
                } label: {
                    Label("Take Back", systemImage: "arrow.uturn.backward").frame(maxWidth: .infinity)
                }
                .disabled(model.isThinking || model.game.mainline.isEmpty)
                Button(role: .destructive) {
                    model.resign()
                } label: {
                    Label("Resign", systemImage: "flag.fill").frame(maxWidth: .infinity)
                }
            }
            .controlSize(.large)
        }
    }
}
