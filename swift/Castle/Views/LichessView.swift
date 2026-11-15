import SwiftUI

struct LichessView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.lichess
        ZStack {
            if model.state == .online {
                LichessSessionView(model: model).transition(.page)
            } else {
                LichessSignInView(model: model).transition(.page)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.state == .online)
        .navigationTitle("Lichess")
        .navigationSubtitle(model.state == .online ? "Signed in as \(model.username)" : "lichess.org")
    }
}

private struct LichessSignInView: View {
    let model: LichessModel
    @State private var token = ""

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "bolt.horizontal.circle.fill")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.accentColor.gradient)
                .symbolEffect(.pulse, options: .repeating, isActive: model.state == .connecting)
                .staggered(0)
            VStack(spacing: 6) {
                Text("Play on Lichess").font(.largeTitle.weight(.bold))
                Text("Sign in with a personal access token to play rated and casual games, and to use the Lichess opening explorer.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 460)
            }
            .multilineTextAlignment(.center)
            .staggered(1)

            VStack(alignment: .leading, spacing: 12) {
                SecureField("Personal access token", text: $token)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(signIn)
                Button(action: signIn) {
                    if model.state == .connecting {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small).tint(.white)
                            Text("Signing in…")
                        }
                    } else {
                        Label("Sign In", systemImage: "person.badge.key.fill")
                    }
                }
                .buttonStyle(.hero)
                .disabled(token.isEmpty || model.state == .connecting)
                if let error = model.errorText {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red).transition(.pop)
                }
                Link(destination: URL(string: "https://lichess.org/account/oauth/token/create?scopes[]=board:play&description=Castle")!) {
                    Label("Create a token on lichess.org", systemImage: "arrow.up.right.square")
                }
                .font(.callout)
            }
            .padding(18)
            .frame(width: 380)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .animation(.castleSpring, value: model.errorText)
            .staggered(2)

            Text("The token needs the \"Play games with the board API\" permission. It is kept in your Mac's keychain.")
                .font(.caption).foregroundStyle(.tertiary)
                .staggered(3)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func signIn() {
        model.signIn(token: token)
        token = ""
    }
}

private struct LichessSessionView: View {
    @Environment(AppModel.self) private var app
    let model: LichessModel
    @State private var rated = false
    @State private var level = 3
    @State private var aiMinutes = 10

    private let pools = [(10, 0), (10, 5), (15, 10), (30, 0), (30, 20)]

    var body: some View {
        let game = model.game
        let _ = game.revision
        let flipped = model.myColor == .black
        HStack(spacing: 0) {
            VStack(spacing: 10) {
                strip(flipped ? .white : .black)
                BoardView(position: model.shownPosition, flipped: flipped,
                          lastMove: model.pendingMove ?? game.current.move,
                          movableColor: model.movableColor, premoveColor: model.premoveColor, premove: model.premove,
                          onPremove: { model.premove = $0 }) { model.play($0) }
                strip(flipped ? .black : .white)
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
                    Label(result, systemImage: "flag.checkered.2.crossed").font(.headline).panel().transition(.pop)
                }
                if let error = model.errorText {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.red)
                        .panel().transition(.pop)
                }
                if model.isPlaying {
                    MoveListView(game: game, allowEditing: false)
                        .frame(maxHeight: .infinity)
                        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    HStack {
                        Button { model.offerDraw() } label: { Label("Draw", systemImage: "equal.circle").frame(maxWidth: .infinity) }
                        Button { model.abort() } label: { Label("Abort", systemImage: "xmark.circle").frame(maxWidth: .infinity) }
                            .disabled(game.mainline.count > 1)
                        Button(role: .destructive) { model.resign() } label: { Label("Resign", systemImage: "flag.fill").frame(maxWidth: .infinity) }
                    }
                    .controlSize(.large)
                } else {
                    lobby
                }
            }
            .padding(16)
            .frame(width: 380)
            .animation(.castleSpring, value: model.isPlaying)
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
                Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") { model.signOut() }
                    .help("Forget the token and sign out")
            }
        }
    }

    private func strip(_ color: PieceColor) -> some View {
        let balance = model.game.lastMainlineNode.position.materialBalance
        return PlayerStrip(name: color == .white ? model.whiteName : model.blackName, color: color,
                           clock: model.hasClock && model.gameID != nil ? model.clocks[color] : nil,
                           isActive: model.isPlaying && model.game.lastMainlineNode.position.turn == color,
                           material: color == .white ? max(0, balance) : max(0, -balance))
    }

    private var lobby: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.ratings.isEmpty {
                HStack(spacing: 8) {
                    ForEach(model.ratings, id: \.name) { r in
                        VStack(spacing: 1) {
                            Text(verbatim: "\(r.rating)").font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
                            Text(r.name).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
                .staggered(0)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Find an opponent", systemImage: "person.2.fill").font(.headline)
                    Spacer()
                    Toggle("Rated", isOn: $rated).toggleStyle(.switch).controlSize(.mini)
                }
                HStack(spacing: 6) {
                    ForEach(pools, id: \.0.description) { pool in
                        Button {
                            model.seek(minutes: pool.0, increment: pool.1, rated: rated)
                        } label: {
                            Text("\(pool.0)+\(pool.1)")
                                .font(.callout.weight(.semibold).monospacedDigit())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(PressStyle(scale: 0.88))
                        .disabled(model.isSeeking)
                    }
                }
                if model.isSeeking {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Looking for an opponent…").font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") { model.cancelSeek() }.controlSize(.small)
                    }
                    .transition(.opacity)
                }
                Text("Lichess allows rapid and classical pairings from outside apps, not blitz or bullet.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .panel()
            .animation(.castleSpring, value: model.isSeeking)
            .staggered(1)

            VStack(alignment: .leading, spacing: 8) {
                Label("Play the Lichess computer", systemImage: "desktopcomputer").font(.headline)
                Stepper("Level \(level) of 8", value: $level, in: 1...8)
                Picker("Minutes each", selection: $aiMinutes) {
                    ForEach([5, 10, 15, 30], id: \.self) { Text("\($0) minutes").tag($0) }
                }
                Button {
                    model.challengeComputer(level: level, minutes: aiMinutes, increment: 0)
                } label: {
                    Label("Start Game", systemImage: "play.fill").frame(maxWidth: .infinity)
                }
                .controlSize(.large)
            }
            .panel()
            .staggered(2)

            Spacer(minLength: 0)
            if model.gameID != nil, !model.game.mainline.isEmpty {
                Button { app.analyse(model.game) } label: {
                    Label("Analyse Last Game", systemImage: "waveform.path.ecg").frame(maxWidth: .infinity)
                }
                .controlSize(.large)
            }
        }
    }
}
