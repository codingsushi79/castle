import SwiftUI

/// Today's puzzle, solvable straight from the menu bar.
struct MenuBarPuzzleView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow
    @State private var position = Position.start
    @State private var lastMove: Move?
    @State private var step = 0
    @State private var loadedID: String?
    @State private var wrong = false
    @State private var shakes: CGFloat = 0

    var body: some View {
        let puzzles = app.puzzles
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Daily Puzzle").font(.headline)
                    Text(Date.now.formatted(date: .abbreviated, time: .omitted)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Label("\(puzzles.dailyStreak)", systemImage: "flame.fill")
                    .foregroundStyle(puzzles.dailyStreak > 0 ? .orange : .secondary)
                    .font(.callout)
            }
            if let puzzle = puzzles.daily {
                let solution = puzzle.solution
                let done = step >= solution.count
                BoardView(position: position, flipped: (puzzle.shown?.position.turn ?? .white) == .black,
                          lastMove: lastMove, movableColor: done ? nil : position.turn) { move in
                    attempt(move, puzzle)
                }
                .modifier(Shake(animatableData: shakes))
                .frame(width: 300, height: 300)
                HStack {
                    Image(systemName: done ? "checkmark.circle.fill" : wrong ? "xmark.circle.fill" : "circle.dotted")
                        .foregroundStyle(done ? .green : wrong ? .red : .secondary)
                        .contentTransition(.symbolEffect(.replace))
                    Text(done ? "Solved. See you tomorrow." : wrong ? "Not that one, try again." : "\(position.turn.name) to move")
                        .font(.callout)
                    Spacer()
                    Button("Open Castle") {
                        openWindow(id: "main")
                        NSApp.activate(ignoringOtherApps: true)
                        app.go(.puzzles)
                    }
                    .controlSize(.small)
                }
                .onAppear { reset(puzzle) }
                .onChange(of: puzzle.id) { reset(puzzle) }
            } else {
                ProgressView().frame(width: 300, height: 300)
            }
        }
        .padding(14)
        .frame(width: 328)
    }

    private func reset(_ puzzle: Puzzle) {
        guard loadedID != puzzle.id, let shown = puzzle.shown else { return }
        loadedID = puzzle.id
        position = shown.position
        lastMove = shown.lastMove
        step = 0
        wrong = false
        if app.puzzles.dailySolved { playOut(puzzle) }
    }

    /// Shows the finished line when today's puzzle was already solved.
    private func playOut(_ puzzle: Puzzle) {
        for uci in puzzle.solution {
            guard let m = position.move(uci: uci) else { break }
            position.apply(m)
            lastMove = m
        }
        step = puzzle.solution.count
    }

    private func attempt(_ move: Move, _ puzzle: Puzzle) {
        let solution = puzzle.solution
        guard step < solution.count else { return }
        let after = position.applying(move)
        guard move.uci == solution[step] || after.isCheckmate else {
            wrong = true
            Sound.error()
            withAnimation(.linear(duration: 0.4)) { shakes += 1 }
            return
        }
        wrong = false
        Sound.move(capture: position.isCapture(move))
        position = after
        lastMove = move
        step = after.isCheckmate ? solution.count : step + 1
        if step >= solution.count {
            app.puzzles.markDailySolved()
            Sound.success()
            return
        }
        let reply = solution[step]
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            guard let m = position.move(uci: reply) else { return }
            position.apply(m)
            lastMove = m
            step += 1
            if step >= solution.count { app.puzzles.markDailySolved() }
        }
    }
}
