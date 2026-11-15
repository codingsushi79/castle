import SwiftUI
import WidgetKit

struct PuzzleEntry: TimelineEntry {
    let date: Date
    let puzzle: Puzzle?
}

struct PuzzleProvider: TimelineProvider {
    private static let all = Puzzle.loadBundled()

    func placeholder(in context: Context) -> PuzzleEntry { PuzzleEntry(date: Date(), puzzle: Self.all.first) }

    func getSnapshot(in context: Context, completion: @escaping (PuzzleEntry) -> Void) {
        completion(PuzzleEntry(date: Date(), puzzle: DailyPuzzle.pick(from: Self.all)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PuzzleEntry>) -> Void) {
        let now = Date()
        let midnight = Calendar.current.startOfDay(for: now).addingTimeInterval(86400)
        let entries = [PuzzleEntry(date: now, puzzle: DailyPuzzle.pick(from: Self.all, on: now)),
                       PuzzleEntry(date: midnight, puzzle: DailyPuzzle.pick(from: Self.all, on: midnight.addingTimeInterval(60)))]
        completion(Timeline(entries: entries, policy: .after(midnight.addingTimeInterval(120))))
    }
}

/// The board built from plain views, which widgets render reliably.
private struct WidgetBoard: View {
    let position: Position
    let lastMove: Move?
    let flipped: Bool

    var body: some View {
        let theme = BoardTheme.walnut
        GeometryReader { geo in
            let sq = min(geo.size.width, geo.size.height) / 8
            ZStack(alignment: .topLeading) {
                ForEach(0..<64, id: \.self) { s in
                    let col = flipped ? 7 - (s & 7) : s & 7
                    let row = flipped ? s >> 3 : 7 - (s >> 3)
                    ZStack {
                        Sq.isLight(s) ? theme.light : theme.dark
                        if let m = lastMove, s == m.from || s == m.to { Color.yellow.opacity(0.38) }
                        if let piece = position.board[s] { Image(piece.assetName).resizable() }
                    }
                    .frame(width: sq, height: sq)
                    .offset(x: CGFloat(col) * sq, y: CGFloat(row) * sq)
                }
            }
            .frame(width: sq * 8, height: sq * 8)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct PuzzleWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PuzzleEntry

    var body: some View {
        Group {
            if let puzzle = entry.puzzle, let shown = puzzle.shown {
                let turn = shown.position.turn
                let board = WidgetBoard(position: shown.position, lastMove: shown.lastMove, flipped: turn == .black)
                switch family {
                case .systemSmall:
                    board
                case .systemMedium:
                    HStack(spacing: 14) {
                        board
                        caption(turn, puzzle)
                    }
                default:
                    VStack(alignment: .leading, spacing: 10) {
                        board
                        HStack {
                            Label("\(turn.name) to move", systemImage: turn == .white ? "circle" : "circle.fill").font(.headline)
                            Spacer()
                            Text("Daily Puzzle").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Label("Castle", systemImage: "puzzlepiece.extension.fill")
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "castle://daily"))
    }

    private func caption(_ turn: PieceColor, _ puzzle: Puzzle) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Daily Puzzle", systemImage: "puzzlepiece.extension.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text("\(turn.name) to move").font(.title3.weight(.bold))
            Text(entry.date.formatted(date: .abbreviated, time: .omitted)).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text("Click to solve in Castle").font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@main
struct CastleWidgets: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DailyPuzzle", provider: PuzzleProvider()) { entry in
            PuzzleWidgetView(entry: entry)
        }
        .configurationDisplayName("Daily Puzzle")
        .description("A new chess puzzle every day.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
