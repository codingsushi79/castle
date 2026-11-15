import Charts
import SwiftUI
import UniformTypeIdentifiers

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @State private var selection: Set<PGNEntry.ID> = []
    @State private var search = ""
    @State private var patternSearch = false
    @State private var showStats = false

    private var filtered: [PGNEntry] {
        var all = app.library.entries
        if let f = app.library.filter { all = all.filter { f.ids.contains($0.id) } }
        guard !search.isEmpty else { return all }
        return all.filter { e in
            [e.white, e.black, e.event, e.opening, e.date].contains { $0.localizedCaseInsensitiveContains(search) }
        }
    }

    var body: some View {
        let rows = filtered
        VStack(spacing: 0) {
            if let f = app.library.filter {
                HStack(spacing: 8) {
                    Image(systemName: "scope").foregroundStyle(Color.accentColor)
                    Text("\(f.label): \(f.ids.count) game\(f.ids.count == 1 ? "" : "s")").font(.callout.weight(.medium))
                    Spacer()
                    Button("Clear Filter", systemImage: "xmark.circle.fill") {
                        withAnimation(.castleSnappy) { app.library.filter = nil }
                    }
                    .controlSize(.small)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.12))
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if app.library.isSearching {
                ProgressView("Searching every game…").controlSize(.small).padding(8)
            }
            Table(rows, selection: $selection) {
                TableColumn("White") { e in
                    Label(e.white, systemImage: "circle").labelStyle(.titleAndIcon)
                }
                TableColumn("Black") { e in
                    Label(e.black, systemImage: "circle.fill").labelStyle(.titleAndIcon)
                }
                TableColumn("Result") { e in
                    Text(e.result).monospacedDigit().foregroundStyle(e.result == "*" ? .secondary : .primary)
                }
                .width(70)
                TableColumn("Date", value: \.date).width(90)
                TableColumn("Event", value: \.event)
                TableColumn("Opening", value: \.opening)
            }
            .contextMenu(forSelectionType: PGNEntry.ID.self) { ids in
                Button("Open in Analysis", systemImage: "waveform.path.ecg") { open(ids) }
                Button("Copy PGN", systemImage: "doc.on.doc") {
                    app.copy(app.library.entries.filter { ids.contains($0.id) }.map(\.text).joined(separator: "\n\n"))
                }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) {
                    withAnimation { app.library.remove(ids) }
                }
            } primaryAction: { ids in
                open(ids)
            }
        }
        .animation(.castleSnappy, value: app.library.filter)
        .overlay {
            if app.library.entries.isEmpty {
                ContentUnavailableView {
                    Label("No Games Yet", systemImage: "books.vertical")
                } description: {
                    Text("Games you play are saved here automatically. You can also import PGN files, drop them on this window, or download your online games from the Accounts page.")
                } actions: {
                    Button("Import PGN…") { app.openPGNPanel() }
                    Button("Open Accounts") { app.go(.accounts) }
                }
                .transition(.opacity)
            } else if rows.isEmpty {
                if search.isEmpty {
                    ContentUnavailableView("No Matching Games", systemImage: "scope",
                                           description: Text("No game in the library fits the position filter."))
                } else {
                    ContentUnavailableView.search(text: search)
                }
            }
        }
        .searchable(text: $search, prompt: "Players, events, openings")
        .dropDestination(for: URL.self) { urls, _ in
            var added = 0
            for url in urls where url.pathExtension.lowercased() == "pgn" { added += app.library.importFile(url) }
            return added > 0
        }
        .toolbar {
            ToolbarItemGroup {
                Button("Import PGN", systemImage: "square.and.arrow.down") { app.openPGNPanel() }
                    .help("Import games from a PGN file")
                Button("Search Position", systemImage: "scope") { patternSearch = true }
                    .help("Find games by the pieces on the board")
                    .disabled(app.library.entries.isEmpty)
                Button("Player Stats", systemImage: "chart.bar.xaxis") { showStats = true }
                    .help("Results by player, colour and opening")
                    .disabled(app.library.entries.isEmpty)
                Button("Open", systemImage: "waveform.path.ecg") { open(selection) }
                    .disabled(selection.isEmpty)
                    .help("Open the selected game in Analysis")
                Button("Delete", systemImage: "trash") {
                    withAnimation { app.library.remove(selection) }
                    selection = []
                }
                .disabled(selection.isEmpty)
                .help("Delete the selected games")
            }
        }
        .sheet(isPresented: $patternSearch) {
            PositionEditorView(purpose: .pattern, initial: .start) { _, pattern in
                app.library.filterPartial(pattern)
            }
        }
        .sheet(isPresented: $showStats) { PlayerStatsView() }
        .navigationTitle("Library")
        .navigationSubtitle("\(app.library.entries.count.formatted()) games")
    }

    private func open(_ ids: Set<PGNEntry.ID>) {
        guard let entry = app.library.entries.first(where: { ids.contains($0.id) }) else { return }
        app.analyse(PGN.parse(entry))
    }
}

/// Results for any player in the library, split by colour and opening.
struct PlayerStatsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var player = ""

    var body: some View {
        let players = app.library.players
        let name = player.isEmpty ? (players.first?.name ?? "") : player
        let record = app.library.record(for: name)
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Player Stats").font(.title2.weight(.bold))
                Spacer()
                Picker("Player", selection: Binding(get: { name }, set: { player = $0 })) {
                    ForEach(players.prefix(200), id: \.name) { p in
                        Text("\(p.name) (\(p.games))").tag(p.name)
                    }
                }
                .frame(width: 260)
            }
            HStack(spacing: 12) {
                card("As White", record.white, "circle")
                card("As Black", record.black, "circle.fill")
            }
            Text("By opening").font(.headline)
            if record.openings.isEmpty {
                Text("No games.").foregroundStyle(.secondary)
            } else {
                Chart(record.openings.prefix(10), id: \.name) { item in
                    BarMark(x: .value("Wins", item.record.wins), y: .value("Opening", item.name))
                        .foregroundStyle(by: .value("Result", "Won"))
                    BarMark(x: .value("Draws", item.record.draws), y: .value("Opening", item.name))
                        .foregroundStyle(by: .value("Result", "Drawn"))
                    BarMark(x: .value("Losses", item.record.losses), y: .value("Opening", item.name))
                        .foregroundStyle(by: .value("Result", "Lost"))
                }
                .chartForegroundStyleScale(["Won": Color.green, "Drawn": Color.gray, "Lost": Color.red])
                .chartYAxis { AxisMarks { _ in AxisValueLabel().font(.caption) } }
                .frame(height: CGFloat(min(10, record.openings.count)) * 30 + 40)
                .animation(.castleSpring, value: name)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 620)
    }

    private func card(_ title: String, _ r: LibraryModel.PlayerRecord, _ symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.medium))
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(r.games == 0 ? "–" : String(format: "%.0f%%", r.score * 100))
                    .font(.system(size: 28, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText())
                Text("\(r.games) games").font(.caption).foregroundStyle(.secondary)
            }
            ResultBar(white: r.wins, draws: r.draws, black: r.losses)
            Text("\(r.wins) won · \(r.draws) drawn · \(r.losses) lost").font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .panel()
    }
}
