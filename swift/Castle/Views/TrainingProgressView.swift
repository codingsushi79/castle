import Charts
import SwiftUI

/// Puzzle rating over time, accuracy by theme and what the repertoire trainer has coming up.
struct TrainingProgressView: View {
    @Environment(AppModel.self) private var app

    private struct ThemeRow: Identifiable {
        var id: String
        var name: String
        var accuracy: Double
        var attempts: Int
    }

    var body: some View {
        let puzzles = app.puzzles
        let stats = puzzles.stats
        let themes = stats.themes
            .filter { $0.value.attempts >= 3 && PuzzleModel.themeNames[$0.key] != nil }
            .map { ThemeRow(id: $0.key, name: PuzzleModel.themeNames[$0.key] ?? $0.key,
                            accuracy: Double($0.value.solved) / Double($0.value.attempts) * 100, attempts: $0.value.attempts) }
            .sorted { $0.accuracy < $1.accuracy }
        let attempts = puzzles.solvedCount + puzzles.failedCount

        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
                    tile("Puzzle rating", "\(puzzles.rating)", "chart.line.uptrend.xyaxis", .accentColor).staggered(0)
                    tile("Solved first try", attempts == 0 ? "–" : "\(puzzles.solvedCount * 100 / attempts)%",
                         "checkmark.circle.fill", .green).staggered(1)
                    tile("Best rush", "\(puzzles.rushBest)", "bolt.fill", .orange).staggered(2)
                    tile("Daily streak", "\(puzzles.dailyStreak)", "flame.fill", .red).staggered(3)
                }

                section("Puzzle rating", "chart.xyaxis.line") {
                    if stats.ratingHistory.count < 2 {
                        placeholder("Solve a few rated puzzles to start the graph.")
                    } else {
                        let points = Array(stats.ratingHistory.suffix(300).enumerated())
                        let values = points.map(\.element.rating)
                        Chart(points, id: \.offset) { i, p in
                            LineMark(x: .value("Puzzle", i), y: .value("Rating", p.rating))
                                .interpolationMethod(.monotone)
                                .foregroundStyle(Color.accentColor)
                            AreaMark(x: .value("Puzzle", i), yStart: .value("Floor", (values.min() ?? 0) - 20), yEnd: .value("Rating", p.rating))
                                .interpolationMethod(.monotone)
                                .foregroundStyle(Color.accentColor.opacity(0.15))
                        }
                        .chartYScale(domain: ((values.min() ?? 0) - 20)...((values.max() ?? 0) + 20))
                        .chartXAxis(.hidden)
                        .frame(height: 180)
                    }
                }
                .staggered(4)

                section("Accuracy by theme", "square.grid.2x2.fill") {
                    if themes.isEmpty {
                        placeholder("Themes appear once you have tried each at least three times.")
                    } else {
                        Chart(themes) { row in
                            BarMark(x: .value("Accuracy", row.accuracy), y: .value("Theme", row.name))
                                .foregroundStyle(row.accuracy < 50 ? Color.red.gradient : row.accuracy < 75 ? Color.orange.gradient : Color.green.gradient)
                                .annotation(position: .trailing) {
                                    Text("\(Int(row.accuracy))% of \(row.attempts)").font(.caption2).foregroundStyle(.secondary)
                                }
                        }
                        .chartXScale(domain: 0...115)
                        .chartXAxis(.hidden)
                        .frame(height: CGFloat(themes.count) * 26 + 10)
                        if let weakest = themes.first, weakest.accuracy < 75 {
                            Button("Practise \(weakest.name)", systemImage: "target") {
                                puzzles.setMode(.rated)
                                puzzles.theme = weakest.id
                                app.go(.puzzles)
                            }
                            .controlSize(.small)
                        }
                    }
                }
                .staggered(5)

                HStack(alignment: .top, spacing: 12) {
                    section("Repertoire reviews ahead", "calendar") {
                        let forecast = app.repertoire.forecast()
                        if forecast.allSatisfy({ $0.count == 0 }) {
                            placeholder("Build a repertoire to see upcoming reviews.")
                        } else {
                            Chart(forecast, id: \.day) { item in
                                BarMark(x: .value("Day", item.day == 0 ? "Now" : "+\(item.day)"), y: .value("Positions", item.count))
                                    .foregroundStyle(item.day == 0 ? Color.orange.gradient : Color.accentColor.gradient)
                            }
                            .frame(height: 140)
                        }
                    }
                    section("Puzzle rush scores", "bolt.fill") {
                        if stats.rushScores.isEmpty {
                            placeholder("Play a rush to record a score.")
                        } else {
                            Chart(Array(stats.rushScores.suffix(30).enumerated()), id: \.offset) { i, score in
                                BarMark(x: .value("Run", i + 1), y: .value("Score", score))
                                    .foregroundStyle(Color.orange.gradient)
                            }
                            .chartXAxis(.hidden)
                            .frame(height: 140)
                        }
                    }
                }
                .staggered(6)
            }
            .padding(20)
        }
        .navigationTitle("Progress")
        .navigationSubtitle("\(attempts.formatted()) puzzles attempted · \(puzzles.mistakes.count) mistakes to train")
    }

    private func tile(_ label: String, _ value: String, _ symbol: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol).font(.title3).foregroundStyle(tint)
            Text(verbatim: value).font(.system(size: 30, weight: .bold, design: .rounded).monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .panel()
    }

    private func section<Content: View>(_ title: String, _ symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(.headline)
            content()
        }
        .panel()
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
    }
}
