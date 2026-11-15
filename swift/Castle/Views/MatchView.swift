import SwiftUI

struct MatchView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("saveMatchGames") private var saveGames = false

    var body: some View {
        @Bindable var model = app.matches
        let game = model.game
        let _ = game.revision

        HStack(spacing: 0) {
            VStack(spacing: 10) {
                let whiteName = model.aIsWhite ? name(model.nameA, model.engineA) : name(model.nameB, model.engineB)
                let blackName = model.aIsWhite ? name(model.nameB, model.engineB) : name(model.nameA, model.engineA)
                PlayerStrip(name: blackName, color: .black, isActive: model.isRunning && game.position.turn == .black,
                            material: max(0, -game.position.materialBalance))
                HStack(spacing: 12) {
                    EvalBar(score: model.score)
                    BoardView(position: game.position, lastMove: game.current.move)
                }
                PlayerStrip(name: whiteName, color: .white, isActive: model.isRunning && game.position.turn == .white,
                            material: max(0, game.position.materialBalance))
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .staggered(0)

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                scoreCard(model).staggered(1)
                if model.isRunning {
                    HStack(spacing: 8) {
                        Image(systemName: "book.closed.fill").foregroundStyle(.secondary)
                        Text(model.opening).lineLimit(1)
                        Spacer()
                        Text("Depth \(model.depth)").foregroundStyle(.secondary).monospacedDigit()
                    }
                    .font(.callout)
                    .transition(.opacity)
                } else {
                    setup(model).staggered(2)
                }
                crosstable(model).staggered(3)
                Button {
                    withAnimation(.castleSpring) { model.isRunning ? model.stop() : model.start() }
                } label: {
                    Label(model.isRunning ? "Stop Match" : (model.records.isEmpty ? "Start Match" : "New Match"),
                          systemImage: model.isRunning ? "stop.fill" : "play.fill")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.hero)
                .disabled(app.catalog.available.isEmpty)
                .staggered(4)
            }
            .padding(16)
            .frame(width: 400)
            .animation(.castleSpring, value: model.isRunning)
        }
        .navigationTitle("Engine Matches")
        .navigationSubtitle(model.isRunning ? "Game \(model.records.count + 1) of \(model.games)" : "\(model.records.count) games played")
    }

    private func name(_ live: String, _ id: String) -> String {
        live.isEmpty ? (app.catalog.entry(id)?.name ?? "Engine") : live
    }

    private func scoreCard(_ model: MatchModel) -> some View {
        let n = model.records.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(model.nameA, model.engineA)).font(.headline).lineLimit(1)
                    Text(verbatim: format(model.pointsA))
                        .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText())
                }
                Spacer()
                Text("–").font(.title).foregroundStyle(.tertiary)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(name(model.nameB, model.engineB)).font(.headline).lineLimit(1)
                    Text(verbatim: format(Double(n) - model.pointsA))
                        .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText())
                }
            }
            .animation(.castleSpring, value: n)
            if n > 0 {
                ResultBar(white: model.winsA, draws: model.draws, black: model.winsB)
                HStack {
                    Text("+\(model.winsA)  =\(model.draws)  −\(model.winsB)").monospacedDigit()
                    Spacer()
                    if let elo = model.elo {
                        Text(String(format: "%+.0f ± %.0f Elo", elo.diff, elo.margin)).monospacedDigit()
                            .foregroundStyle(abs(elo.diff) > elo.margin ? Color.primary : Color.secondary)
                            .help("Rating difference in favour of the first engine, with a 95% margin")
                    }
                }
                .font(.caption.weight(.medium))
            }
        }
        .panel()
    }

    private func format(_ points: Double) -> String {
        points == points.rounded() ? String(Int(points)) : String(format: "%.1f", points)
    }

    private func setup(_ model: MatchModel) -> some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            Picker("First engine", selection: $model.engineA) {
                ForEach(app.catalog.available) { Text($0.name).tag($0.id) }
            }
            Picker("Second engine", selection: $model.engineB) {
                ForEach(app.catalog.available) { Text($0.name).tag($0.id) }
            }
            Stepper("Games: \(model.games)", value: $model.games, in: 2...200, step: 2)
            Picker("Time per move", selection: $model.moveTimeMs) {
                ForEach([50, 100, 200, 500, 1000, 3000], id: \.self) { ms in
                    Text(ms < 1000 ? "\(ms) ms" : "\(ms / 1000) s").tag(ms)
                }
            }
            Toggle("Start from varied openings", isOn: $model.useOpenings)
            Toggle("Save games to the Library", isOn: $saveGames)
            Text("Each engine uses one thread. Every opening is played twice with colours swapped.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .panel()
    }

    private func crosstable(_ model: MatchModel) -> some View {
        ScrollViewReader { proxy in
            List(model.records) { r in
                HStack(spacing: 8) {
                    Text("\(r.number)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 22, alignment: .trailing)
                    Image(systemName: r.scoreA == 1 ? "arrowtriangle.up.fill" : r.scoreA == 0 ? "arrowtriangle.down.fill" : "equal")
                        .font(.caption)
                        .foregroundStyle(r.scoreA == 1 ? .green : r.scoreA == 0 ? .red : .secondary)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(r.white) – \(r.black)").font(.callout).lineLimit(1)
                        Text("\(r.opening) · \((r.plies + 1) / 2) moves · \(r.reason)")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Text(r.result).font(.callout.monospacedDigit().weight(.semibold))
                }
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { app.analyse(r.game) }
                .contextMenu {
                    Button("Open in Analysis", systemImage: "waveform.path.ecg") { app.analyse(r.game) }
                    Button("Add to Library", systemImage: "books.vertical") { app.library.add(r.game) }
                }
                .id(r.id)
            }
            .listStyle(.inset)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                if model.records.isEmpty {
                    ContentUnavailableView("No Games Yet", systemImage: "trophy",
                                           description: Text("Finished games appear here. Double-click one to analyse it."))
                }
            }
            .onChange(of: model.records.count) {
                if let last = model.records.last { withAnimation { proxy.scrollTo(last.id) } }
            }
        }
    }
}
