import Charts
import SwiftUI

private struct MoveToken: Identifiable {
    enum Kind { case move, comment, open, close }
    let id: String
    var kind: Kind
    var text: String
    var node: GameNode?
    var depth: Int
}

/// The game's moves with variations and comments, as wrapping clickable text.
struct MoveListView: View {
    let game: Game
    var allowEditing = true

    var body: some View {
        let _ = game.revision
        let tokens = buildTokens()
        ScrollViewReader { proxy in
            ScrollView {
                if tokens.isEmpty {
                    Text("No moves yet")
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 60)
                } else {
                    FlowLayout(spacing: 1, lineSpacing: 3) {
                        ForEach(tokens) { token in
                            view(for: token)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
            }
            .onChange(of: game.current.id) { _, id in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id.uuidString, anchor: .center) }
            }
        }
    }

    @ViewBuilder
    private func view(for token: MoveToken) -> some View {
        switch token.kind {
        case .move:
            if let node = token.node {
                let isCurrent = game.current === node
                Button {
                    game.go(to: node)
                } label: {
                    Text(token.text)
                        .font(.system(size: 13, weight: token.depth == 0 ? .semibold : .regular, design: .rounded))
                        .foregroundStyle(isCurrent ? Color.white : nagColor(node.nag, depth: token.depth))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(isCurrent ? Color.accentColor : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle(scale: 0.9))
                .animation(.easeOut(duration: 0.12), value: isCurrent)
                .contextMenu {
                    if allowEditing {
                        Button("Promote Variation", systemImage: "arrow.up.to.line") { game.promote(node) }
                        Button("Delete From Here", systemImage: "trash", role: .destructive) { game.delete(node) }
                    }
                }
                .id(token.id)
            }
        case .comment:
            Text(token.text)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
        case .open, .close:
            Text(token.text)
                .font(.system(size: 13))
                .foregroundStyle(.tertiary)
                .padding(.vertical, 2)
        }
    }

    private func nagColor(_ nag: Int?, depth: Int) -> Color {
        switch nag {
        case 4: return .red
        case 2: return .orange
        case 6: return Color(red: 0.75, green: 0.6, blue: 0.1)
        case 1, 3: return .green
        default: return depth == 0 ? .primary : .secondary
        }
    }

    private func buildTokens() -> [MoveToken] {
        var out: [MoveToken] = []
        if !game.root.comment.isEmpty {
            out.append(MoveToken(id: "c-root", kind: .comment, text: game.root.comment, node: nil, depth: 0))
        }
        append(from: game.root, depth: 0, into: &out)
        return out
    }

    private func append(from start: GameNode, depth: Int, into out: inout [MoveToken]) {
        var parent = start
        var needNumber = true
        while let main = parent.children.first {
            add(main, numbered: needNumber, depth: depth, into: &out)
            needNumber = !main.comment.isEmpty
            for alt in parent.children.dropFirst() {
                out.append(MoveToken(id: "o-\(alt.id)", kind: .open, text: "(", node: nil, depth: depth + 1))
                add(alt, numbered: true, depth: depth + 1, into: &out)
                append(from: alt, depth: depth + 1, into: &out)
                out.append(MoveToken(id: "x-\(alt.id)", kind: .close, text: ")", node: nil, depth: depth + 1))
                needNumber = true
            }
            parent = main
        }
    }

    private func add(_ node: GameNode, numbered: Bool, depth: Int, into out: inout [MoveToken]) {
        let whiteMoved = node.parent?.position.turn == .white
        let prefix = whiteMoved || numbered ? node.moveNumberLabel + " " : ""
        out.append(MoveToken(id: node.id.uuidString, kind: .move, text: prefix + node.san + node.nagSymbol,
                             node: node, depth: depth))
        if !node.comment.isEmpty {
            out.append(MoveToken(id: "c-\(node.id)", kind: .comment, text: node.comment, node: nil, depth: depth))
        }
    }
}

/// White's winning chances across the game; click to jump to a move.
struct EvalChart: View {
    let game: Game

    private struct Point: Identifiable {
        let id: Int
        let win: Double
    }

    var body: some View {
        let _ = game.revision
        let nodes = [game.root] + game.mainline
        let points = nodes.enumerated().compactMap { i, n in n.eval.map { Point(id: i, win: $0.winPercent) } }
        let currentIndex = nodes.firstIndex { $0 === game.current }

        Chart {
            ForEach(points) { p in
                AreaMark(x: .value("Move", p.id), yStart: .value("Even", 0), yEnd: .value("White", p.win))
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .interpolationMethod(.monotone)
            }
            RuleMark(y: .value("Even", 50))
                .foregroundStyle(.secondary.opacity(0.6))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            if let currentIndex {
                RuleMark(x: .value("Move", currentIndex))
                    .foregroundStyle(Color.accentColor)
                    .lineStyle(StrokeStyle(lineWidth: 2))
            }
        }
        .chartYScale(domain: 0...100)
        .chartXScale(domain: 0...max(1, nodes.count - 1))
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                        let originX = proxy.plotFrame.map { geo[$0].origin.x } ?? 0
                        if let x: Double = proxy.value(atX: value.location.x - originX) {
                            let i = max(0, min(nodes.count - 1, Int(x.rounded())))
                            game.go(to: nodes[i])
                        }
                    })
            }
        }
        .background(Color.secondary.opacity(0.28), in: RoundedRectangle(cornerRadius: 6))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .animation(.easeOut(duration: 0.25), value: points.count)
    }
}
