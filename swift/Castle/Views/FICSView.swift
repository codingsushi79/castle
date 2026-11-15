import SwiftUI

struct FICSView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.fics
        ZStack {
            if model.state == .online {
                FICSSessionView(model: model).transition(.page)
            } else {
                FICSLoginView(model: model).transition(.page)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.state == .online)
        .navigationTitle("FICS")
        .navigationSubtitle(model.state == .online ? "Signed in as \(model.handle)" : "Free Internet Chess Server")
    }
}

private struct FICSLoginView: View {
    @Bindable var model: FICSModel
    @State private var password = ""

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "globe")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.accentColor.gradient)
                .symbolEffect(.pulse, options: .repeating, isActive: model.state != .disconnected)
                .staggered(0)
            VStack(spacing: 6) {
                Text("Free Internet Chess Server").font(.largeTitle.weight(.bold))
                Text("Play and watch live games on freechess.org, free of charge since 1995.")
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .staggered(1)

            VStack(alignment: .leading, spacing: 12) {
                Picker("Sign in", selection: $model.asGuest.animation(.castleSpring)) {
                    Text("Guest").tag(true)
                    Text("FICS Account").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                if !model.asGuest {
                    VStack(spacing: 8) {
                        TextField("Username", text: $model.username)
                            .textContentType(.username)
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .onSubmit(connect)
                    }
                    .textFieldStyle(.roundedBorder)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Text("Guests can play unrated games and watch anything.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }

                Button(action: connect) {
                    if model.state == .disconnected {
                        Label("Connect", systemImage: "network")
                    } else {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small).tint(.white)
                            Text(model.state == .connecting ? "Connecting…" : "Signing in…")
                        }
                    }
                }
                .buttonStyle(.hero)
                .disabled(model.state != .disconnected || (!model.asGuest && (model.username.isEmpty || password.isEmpty)))

                if let error = model.errorText {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.red)
                        .transition(.pop)
                }
            }
            .padding(18)
            .frame(width: 360)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .animation(.castleSpring, value: model.errorText)
            .staggered(2)

            Text("The connection is plain telnet, as FICS requires. Your password is sent once and never stored.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .staggered(3)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func connect() {
        model.connect(password: model.asGuest ? "" : password)
        password = ""
    }
}

private struct FICSSessionView: View {
    @Environment(AppModel.self) private var app
    let model: FICSModel
    @State private var tab = 0
    @State private var command = ""
    @State private var rated = false

    private let quickSeeks = [(1, 0), (3, 0), (5, 0), (10, 5), (15, 10)]

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 10) {
                let top: PieceColor = model.flipped ? .white : .black
                strip(top)
                BoardView(position: model.shownPosition, flipped: model.flipped,
                          lastMove: model.pendingMove ?? model.lastMove,
                          movableColor: model.movableColor, premoveColor: model.premoveColor, premove: model.premove,
                          onPremove: { model.premove = $0 }) { model.play($0) }
                strip(top.opposite)
                if model.pendingMove != nil {
                    ConfirmMoveBar(confirm: { model.confirmPending() }, cancel: { model.pendingMove = nil })
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.castleSpring, value: model.pendingMove)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                if let result = model.resultText {
                    Label(result, systemImage: "flag.checkered.2.crossed")
                        .font(.headline)
                        .panel()
                        .transition(.pop)
                }
                Picker("View", selection: $tab.animation(.castleSnappy)) {
                    Label("Find a Game", systemImage: "person.2.wave.2.fill").tag(0)
                    Label("Console", systemImage: "terminal.fill").tag(1)
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                if tab == 0 {
                    seekTab.transition(.opacity.combined(with: .move(edge: .leading)))
                } else {
                    consoleTab.transition(.opacity.combined(with: .move(edge: .trailing)))
                }
                gameActions
            }
            .padding(16)
            .frame(width: 380)
            .animation(.castleSpring, value: model.resultText)
        }
        .toolbar {
            ToolbarItem {
                Toggle(isOn: Binding(get: { model.confirmMoves }, set: { model.confirmMoves = $0 })) {
                    Label("Confirm Moves", systemImage: "checkmark.shield")
                }
                .help("Ask before sending each move")
            }
            ToolbarItem {
                Button("Disconnect", systemImage: "bolt.horizontal.circle") { model.disconnect() }
                    .help("Leave FICS")
            }
        }
    }

    private func strip(_ color: PieceColor) -> some View {
        let g = model.game
        return PlayerStrip(name: g.map { color == .white ? $0.white : $0.black } ?? color.name, color: color,
                           clock: g.map { color == .white ? $0.whiteTime : $0.blackTime },
                           isActive: (g?.clockRunning ?? false) && model.position.turn == color,
                           material: color == .white ? max(0, model.position.materialBalance)
                                                     : max(0, -model.position.materialBalance))
    }

    private var seekTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Quick pairing", systemImage: "bolt.fill").font(.headline)
                    Spacer()
                    Toggle("Rated", isOn: $rated).toggleStyle(.switch).controlSize(.mini)
                }
                HStack(spacing: 6) {
                    ForEach(quickSeeks, id: \.0) { minutes, inc in
                        Button {
                            model.seek(minutes: minutes, increment: inc, rated: rated)
                        } label: {
                            Text("\(minutes)+\(inc)")
                                .font(.callout.weight(.semibold).monospacedDigit())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(PressStyle(scale: 0.88))
                    }
                }
            }
            .panel()

            HStack {
                Label("Open challenges", systemImage: "list.bullet").font(.headline)
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { model.refreshSeeks() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            }
            List(model.seeks) { seek in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(seek.name).font(.callout.weight(.medium))
                        Text("\(seek.rating) · \(seek.type) · \(seek.rated ? "rated" : "casual")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(seek.time)+\(seek.increment)").font(.callout.monospacedDigit())
                    Button("Play") { model.accept(seek) }.controlSize(.small)
                }
            }
            .listStyle(.inset)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                if model.seeks.isEmpty {
                    ContentUnavailableView("No open challenges", systemImage: "moon.zzz",
                                           description: Text("Post a quick pairing above, or refresh."))
                }
            }
        }
    }

    private var consoleTab: some View {
        VStack(spacing: 8) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(model.console) { line in
                            Text(line.kind == .sent ? "› " + line.text : line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(line.kind == .server ? AnyShapeStyle(.primary)
                                                 : line.kind == .sent ? AnyShapeStyle(Color.accentColor)
                                                 : AnyShapeStyle(.secondary))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(8)
                }
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .onChange(of: model.console.count) {
                    if let last = model.console.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .onAppear {
                    if let last = model.console.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            HStack {
                TextField("Command, for example: games, observe 12, tell 50 hello", text: $command)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .onSubmit(sendCommand)
                Button("Send", systemImage: "paperplane.fill", action: sendCommand)
                    .labelStyle(.iconOnly)
                    .disabled(command.isEmpty)
            }
        }
    }

    private func sendCommand() {
        model.send(command)
        command = ""
    }

    @ViewBuilder
    private var gameActions: some View {
        if model.isPlaying {
            HStack {
                Button { model.send("draw") } label: {
                    Label("Draw", systemImage: "equal.circle").frame(maxWidth: .infinity)
                }
                Button { model.send("abort") } label: {
                    Label("Abort", systemImage: "xmark.circle").frame(maxWidth: .infinity)
                }
                Button(role: .destructive) { model.send("resign") } label: {
                    Label("Resign", systemImage: "flag.fill").frame(maxWidth: .infinity)
                }
            }
            .controlSize(.large)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if model.game != nil {
            HStack {
                Button { app.analyse(model.record) } label: {
                    Label("Analyse", systemImage: "waveform.path.ecg").frame(maxWidth: .infinity)
                }
                Button { model.send("observe /b") } label: {
                    Label("Watch Top Blitz", systemImage: "eye.fill").frame(maxWidth: .infinity)
                }
            }
            .controlSize(.large)
        } else {
            Button { model.send("observe /b") } label: {
                Label("Watch the Top Blitz Game", systemImage: "eye.fill").frame(maxWidth: .infinity)
            }
            .controlSize(.large)
        }
    }
}

/// Shown under the board while a move waits to be confirmed.
struct ConfirmMoveBar: View {
    let confirm: () -> Void
    let cancel: () -> Void

    var body: some View {
        HStack {
            Button(action: cancel) {
                Label("Cancel", systemImage: "xmark").frame(maxWidth: .infinity)
            }
            .keyboardShortcut(.cancelAction)
            Button(action: confirm) {
                Label("Confirm Move", systemImage: "checkmark").frame(maxWidth: .infinity)
            }
            .keyboardShortcut(.defaultAction)
        }
        .controlSize(.large)
    }
}
