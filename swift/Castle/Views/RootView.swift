import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var launched = false
    @State private var splashGone = false
    @State private var selection: AppSection?

    var body: some View {
        @Bindable var app = app

        NavigationSplitView {
            List(selection: $selection) {
                Section("Play") {
                    row(.play)
                    row(.lichess)
                    row(.fics)
                    row(.matches)
                }
                Section("Study") {
                    row(.analysis)
                    row(.puzzles)
                    row(.repertoire)
                    row(.progress)
                }
                Section("Collection") {
                    row(.library)
                    row(.accounts)
                    row(.engines)
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
        } detail: {
            ZStack {
                page(app.section)
                    .id(app.section)
                    .transition(.page)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .scaleEffect(launched ? 1 : 0.94)
        .blur(radius: launched ? 0 : 14)
        .opacity(launched ? 1 : 0)
        .overlay {
            if !splashGone { SplashView(leaving: launched) }
        }
        .onChange(of: selection) { _, new in
            if let new, new != app.section { app.go(new) }
        }
        .onChange(of: app.section, initial: true) { _, new in selection = new }
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.8).delay(0.75)) { launched = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { splashGone = true }
        }
    }

    private func row(_ section: AppSection) -> some View {
        Label {
            Text(section.title)
        } icon: {
            Image(systemName: section.symbol)
                .symbolEffect(.bounce, value: app.section == section)
        }
        .badge(badge(for: section))
        .tag(section)
    }

    private func badge(for section: AppSection) -> Int {
        switch section {
        case .library: return app.library.entries.count
        case .analysis: return app.analyses.count > 1 ? app.analyses.count : 0
        case .repertoire: return app.repertoire.due(for: .white).count + app.repertoire.due(for: .black).count
        case .puzzles: return app.puzzles.mistakes.count
        default: return 0
        }
    }

    @ViewBuilder
    private func page(_ section: AppSection) -> some View {
        switch section {
        case .play: PlayView()
        case .fics: FICSView()
        case .lichess: LichessView()
        case .matches: MatchView()
        case .analysis: AnalysisPage()
        case .puzzles: PuzzleView()
        case .repertoire: RepertoireView()
        case .progress: TrainingProgressView()
        case .library: LibraryView()
        case .accounts: AccountsView()
        case .engines: EnginesView()
        }
    }
}

/// The rook that drops in when the app opens.
private struct SplashView: View {
    let leaving: Bool
    @State private var landed = false

    var body: some View {
        VStack(spacing: 14) {
            Image("wR")
                .resizable()
                .frame(width: 112, height: 112)
                .shadow(color: .black.opacity(0.3), radius: 14, y: 10)
                .offset(y: landed ? 0 : -60)
                .scaleEffect(landed ? 1 : 0.6)
                .rotationEffect(.degrees(landed ? 0 : -14))
            Text("Castle")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .opacity(landed ? 1 : 0)
                .offset(y: landed ? 0 : 10)
        }
        .scaleEffect(leaving ? 1.5 : 1)
        .opacity(leaving ? 0 : 1)
        .allowsHitTesting(false)
        .onAppear {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) { landed = true }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("boardTheme") private var themeName = BoardTheme.walnut.rawValue
    @AppStorage("showCoordinates") private var showCoordinates = true
    @AppStorage("showLegalMoves") private var showLegalMoves = true
    @AppStorage("soundEnabled") private var soundEnabled = true
    @AppStorage("menuBarPuzzle") private var menuBarPuzzle = true
    @AppStorage("engineThreads") private var threads = max(1, ProcessInfo.processInfo.activeProcessorCount / 2)
    @AppStorage("engineHash") private var hash = 256

    var body: some View {
        TabView {
            Form {
                Section("Board") {
                    LabeledContent("Colours") {
                        HStack(spacing: 10) {
                            ForEach(BoardTheme.allCases) { theme in
                                Button {
                                    withAnimation(.castleSpring) { themeName = theme.rawValue }
                                } label: {
                                    swatch(theme, selected: themeName == theme.rawValue)
                                }
                                .buttonStyle(PressStyle(scale: 0.85))
                                .help(theme.title)
                            }
                        }
                    }
                    Toggle("Show coordinates", isOn: $showCoordinates)
                    Toggle("Show legal moves for the selected piece", isOn: $showLegalMoves)
                }
                Section("Sound") {
                    Toggle("Play sounds for moves and results", isOn: $soundEnabled)
                }
                Section("Menu bar") {
                    Toggle("Show the daily puzzle in the menu bar", isOn: $menuBarPuzzle)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("General", systemImage: "gearshape") }

            Form {
                Section("Defaults") {
                    Picker("Default engine", selection: Binding(get: { app.catalog.defaultID },
                                                                set: { app.catalog.defaultID = $0 })) {
                        ForEach(app.catalog.available) { Text($0.name).tag($0.id) }
                    }
                }
                Section {
                    Stepper("Threads: \(threads)", value: $threads, in: 1...ProcessInfo.processInfo.activeProcessorCount)
                    Picker("Hash", selection: $hash) {
                        ForEach([64, 128, 256, 512, 1024, 2048, 4096], id: \.self) { Text("\($0) MB").tag($0) }
                    }
                } header: {
                    Text("Resources")
                } footer: {
                    Text("Applies the next time an engine starts.")
                }
            }
            .formStyle(.grouped)
            .tabItem { Label("Engines", systemImage: "cpu") }
        }
        .frame(width: 480, height: 400)
    }

    private func swatch(_ theme: BoardTheme, selected: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) { theme.light; theme.dark }
            HStack(spacing: 0) { theme.dark; theme.light }
        }
        .frame(width: 34, height: 34)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
            .strokeBorder(selected ? Color.accentColor : Color.black.opacity(0.15), lineWidth: selected ? 3 : 1))
        .scaleEffect(selected ? 1.08 : 1)
    }
}
