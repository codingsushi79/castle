import Cocoa
import Quartz
import SwiftUI

/// Quick Look preview for PGN files: the games, a board to step through and the moves.
final class PreviewViewController: NSViewController, QLPreviewingController {
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 560))
    }

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        do {
            let data = try Data(contentsOf: url)
            let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
            let entries = PGN.split(text)
            let host = NSHostingView(rootView: PGNPreview(entries: Array(entries.prefix(500)), total: entries.count))
            host.frame = view.bounds
            host.autoresizingMask = [.width, .height]
            view.addSubview(host)
            handler(nil)
        } catch {
            handler(error)
        }
    }
}

private struct PGNPreview: View {
    let entries: [PGNEntry]
    let total: Int
    @State private var selected: PGNEntry.ID?
    @State private var ply = 0

    var body: some View {
        let entry = entries.first { $0.id == selected } ?? entries.first
        HStack(spacing: 0) {
            if entries.count > 1 {
                List(entries, selection: $selected) { e in
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(e.white) – \(e.black)").font(.callout).lineLimit(1)
                        Text([e.result, e.date, e.event].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .tag(e.id)
                }
                .frame(width: 230)
                Divider()
            }
            if let entry {
                GamePreview(entry: entry, ply: $ply)
                    .id(entry.id)
            } else {
                ContentUnavailableView("No Games", systemImage: "doc.text", description: Text("This file has no games in it."))
            }
        }
        .onChange(of: selected) { ply = 0 }
        .overlay(alignment: .bottomLeading) {
            if total > entries.count {
                Text("Showing the first \(entries.count) of \(total) games").font(.caption).foregroundStyle(.secondary).padding(8)
            }
        }
    }
}

private struct GamePreview: View {
    let entry: PGNEntry
    @Binding var ply: Int

    var body: some View {
        let game = PGN.parse(entry)
        let nodes = [game.root] + game.mainline
        let index = min(ply, nodes.count - 1)
        let node = nodes[index]
        HStack(alignment: .top, spacing: 18) {
            VStack(spacing: 10) {
                BoardSnapshot(position: node.position, lastMove: node.move, coordinates: true)
                HStack {
                    Button { ply = 0 } label: { Image(systemName: "backward.end.fill") }
                    Button { ply = max(0, index - 1) } label: { Image(systemName: "chevron.backward") }
                        .keyboardShortcut(.leftArrow, modifiers: [])
                    Slider(value: Binding(get: { Double(index) }, set: { ply = Int($0.rounded()) }),
                           in: 0...Double(max(1, nodes.count - 1)))
                    Button { ply = min(nodes.count - 1, index + 1) } label: { Image(systemName: "chevron.forward") }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                    Button { ply = nodes.count - 1 } label: { Image(systemName: "forward.end.fill") }
                }
            }
            .frame(maxWidth: 420)
            VStack(alignment: .leading, spacing: 8) {
                Text("\(entry.white) – \(entry.black)").font(.title3.weight(.bold))
                Text([entry.result, entry.event, entry.date, entry.opening].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary)
                ScrollView {
                    Text(moveText(nodes, current: index))
                        .font(.system(size: 13, design: .rounded))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(18)
    }

    private func moveText(_ nodes: [GameNode], current: Int) -> AttributedString {
        var out = AttributedString()
        for (i, node) in nodes.enumerated().dropFirst() {
            var piece = AttributedString((node.parent?.position.turn == .white || i == 1 ? node.moveNumberLabel + " " : "") + node.san + node.nagSymbol + "  ")
            if i == current {
                piece.backgroundColor = .accentColor
                piece.foregroundColor = .white
            }
            out += piece
        }
        return out
    }
}
