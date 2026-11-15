import CoreSpotlight
import SwiftUI

@main
struct CastleApp: App {
    @State private var model = AppModel()
    @AppStorage("menuBarPuzzle") private var menuBarPuzzle = true

    init() {
        // An engine that exits must not take the app down with a broken pipe.
        signal(SIGPIPE, SIG_IGN)
    }

    var body: some Scene {
        Window("Castle", id: "main") {
            RootView()
                .environment(model)
                .frame(minWidth: 1040, minHeight: 680)
                .onOpenURL { model.open($0) }
                .onContinueUserActivity(CSSearchableItemActionType) { activity in
                    if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String { model.openSpotlight(id) }
                }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.shutdown()
                }
        }
        .defaultSize(width: 1260, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Analysis Board") {
                    model.analysis.newGame()
                    model.go(.analysis)
                }
                .keyboardShortcut("n")
                Button("New Analysis Tab") {
                    model.newTab()
                    model.go(.analysis)
                }
                .keyboardShortcut("t")
                Button("Close Analysis Tab") { model.closeTab(model.analysis.id) }
                    .keyboardShortcut("w", modifiers: [.command, .shift])
                    .disabled(model.analyses.count < 2)
                Button("New Game") {
                    model.play.backToSetup()
                    model.go(.play)
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                Divider()
                Button("Open PGN…") { model.openPGNPanel() }
                    .keyboardShortcut("o")
            }
            CommandGroup(replacing: .saveItem) {
                Button("Save PGN…") { model.savePGNPanel() }
                    .keyboardShortcut("s")
                Button("Add Game to Library") { model.library.add(model.analysis.game) }
                    .keyboardShortcut("l", modifiers: [.command, .shift])
            }
            CommandGroup(after: .pasteboard) {
                Divider()
                Button("Copy FEN") { model.copy(model.analysis.game.position.fen) }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                Button("Copy PGN") { model.copy(PGN.write(model.analysis.game)) }
                    .keyboardShortcut("c", modifiers: [.command, .option])
                Button("Paste Position or Game") { model.paste() }
                    .keyboardShortcut("v", modifiers: [.command, .shift])
            }
            CommandMenu("Board") {
                Button("Flip Board") { withAnimation(.castleSpring) { model.analysis.flipped.toggle() } }
                    .keyboardShortcut("f", modifiers: [.command, .shift])
                Divider()
                Button("Previous Move") { model.analysis.game.back() }
                    .keyboardShortcut("[")
                Button("Next Move") { model.analysis.game.forward() }
                    .keyboardShortcut("]")
                Button("First Move") { model.analysis.game.toStart() }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Button("Last Move") { model.analysis.game.toEnd() }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Divider()
                Button(model.analysis.isRunning ? "Stop Engine" : "Start Engine") {
                    model.go(.analysis)
                    model.analysis.toggle()
                }
                Button(model.analysis.threatMode ? "Hide Threat" : "Show Threat") {
                    model.go(.analysis)
                    if !model.analysis.isRunning { model.analysis.toggle() }
                    model.analysis.threatMode.toggle()
                }
                Button("Review Game") {
                    model.go(.analysis)
                    model.analysis.startReview()
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            }
            CommandMenu("Go") {
                ForEach(Array(AppSection.allCases.enumerated()), id: \.element) { index, section in
                    if index < 9 {
                        Button(section.title) { model.go(section) }
                            .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")))
                    } else {
                        Button(section.title) { model.go(section) }
                    }
                }
            }
        }

        WindowGroup("Analysis", id: "analysis", for: UUID.self) { $id in
            DetachedAnalysisWindow(id: id)
                .environment(model)
                .frame(minWidth: 900, minHeight: 620)
        }
        .defaultSize(width: 1100, height: 740)

        MenuBarExtra("Castle Daily Puzzle", systemImage: "puzzlepiece.extension.fill", isInserted: $menuBarPuzzle) {
            MenuBarPuzzleView().environment(model)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView().environment(model)
        }
    }
}

/// An analysis board that was moved out of the main window.
private struct DetachedAnalysisWindow: View {
    @Environment(AppModel.self) private var app
    let id: UUID?

    var body: some View {
        if let id, let model = app.detached[id] {
            NavigationStack {
                AnalysisView(model: model, isDetached: true)
            }
            .onDisappear {
                model.shutdown()
                app.detached[id] = nil
            }
        } else {
            ContentUnavailableView("Board Closed", systemImage: "checkerboard.rectangle",
                                   description: Text("This analysis window belonged to an earlier session."))
        }
    }
}
