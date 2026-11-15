import SwiftUI

enum BoardTheme: String, CaseIterable, Identifiable {
    case walnut, moss, ocean, slate, rose

    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    var light: Color {
        switch self {
        case .walnut: return Color(red: 0.94, green: 0.85, blue: 0.71)
        case .moss: return Color(red: 0.93, green: 0.93, blue: 0.82)
        case .ocean: return Color(red: 0.87, green: 0.90, blue: 0.93)
        case .slate: return Color(red: 0.82, green: 0.83, blue: 0.85)
        case .rose: return Color(red: 0.96, green: 0.90, blue: 0.88)
        }
    }

    var dark: Color {
        switch self {
        case .walnut: return Color(red: 0.71, green: 0.53, blue: 0.39)
        case .moss: return Color(red: 0.46, green: 0.59, blue: 0.34)
        case .ocean: return Color(red: 0.42, green: 0.55, blue: 0.70)
        case .slate: return Color(red: 0.47, green: 0.49, blue: 0.54)
        case .rose: return Color(red: 0.74, green: 0.49, blue: 0.51)
        }
    }

    /// The theme chosen in Settings.
    static var current: BoardTheme {
        BoardTheme(rawValue: UserDefaults.standard.string(forKey: "boardTheme") ?? "") ?? .walnut
    }
}

/// A board drawn in one pass with no interaction: used for image export, the menu
/// bar puzzle, the widget and Quick Look.
struct BoardSnapshot: View {
    let position: Position
    var flipped = false
    var lastMove: Move? = nil
    var theme: BoardTheme = .walnut
    var coordinates = false
    var cornerRadius: CGFloat = 6

    var body: some View {
        Canvas { ctx, size in
            let sq = min(size.width, size.height) / 8
            for s in 0..<64 {
                let col = flipped ? 7 - (s & 7) : s & 7
                let row = flipped ? s >> 3 : 7 - (s >> 3)
                let r = CGRect(x: CGFloat(col) * sq, y: CGFloat(row) * sq, width: sq, height: sq)
                let light = Sq.isLight(s)
                ctx.fill(Path(r), with: .color(light ? theme.light : theme.dark))
                if let m = lastMove, s == m.from || s == m.to {
                    ctx.fill(Path(r), with: .color(Color.yellow.opacity(0.38)))
                }
                if coordinates {
                    let ink = light ? theme.dark : theme.light
                    let font = Font.system(size: max(7, sq * 0.15), weight: .bold, design: .rounded)
                    if row == 7 {
                        ctx.draw(Text(String(Sq.name(s).first!)).font(font).foregroundColor(ink),
                                 at: CGPoint(x: r.maxX - sq * 0.07, y: r.maxY - sq * 0.04), anchor: .bottomTrailing)
                    }
                    if col == 0 {
                        ctx.draw(Text(String(Sq.name(s).last!)).font(font).foregroundColor(ink),
                                 at: CGPoint(x: r.minX + sq * 0.07, y: r.minY + sq * 0.04), anchor: .topLeading)
                    }
                }
                if let piece = position.board[s] {
                    ctx.draw(ctx.resolve(Image(piece.assetName)), in: r)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}
