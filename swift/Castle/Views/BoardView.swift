import SwiftUI

struct BoardArrow: Hashable {
    var from: Square
    var to: Square
    var strength: Double = 1
    var tint: BoardShape.Tint? = nil
}

extension BoardShape.Tint {
    var color: Color {
        switch self {
        case .green: return Color(red: 0.2, green: 0.65, blue: 0.3)
        case .red: return Color(red: 0.85, green: 0.2, blue: 0.2)
        case .blue: return Color(red: 0.15, green: 0.45, blue: 0.9)
        case .yellow: return Color(red: 0.9, green: 0.7, blue: 0.1)
        }
    }
}

struct BoardView: View {
    let position: Position
    var flipped = false
    var lastMove: Move? = nil
    var arrows: [BoardArrow] = []
    var shapes: [BoardShape] = []
    var hintSquare: Square? = nil
    /// The side that may be moved with the mouse; nil makes the board read-only.
    var movableColor: PieceColor? = nil
    /// The side that may queue a move while waiting for the opponent.
    var premoveColor: PieceColor? = nil
    var premove: Move? = nil
    var onPremove: ((Move?) -> Void)? = nil
    /// Called when an arrow or circle is drawn with the right mouse button.
    var onShape: ((BoardShape) -> Void)? = nil
    var onMove: (Move) -> Void = { _ in }

    @AppStorage("boardTheme") private var themeName = BoardTheme.walnut.rawValue
    @AppStorage("showCoordinates") private var showCoordinates = true
    @AppStorage("showLegalMoves") private var showLegalMoves = true

    @State private var selected: Square?
    @State private var dragFrom: Square?
    @State private var dragPoint = CGPoint.zero
    @State private var gestureActive = false
    @State private var wasSelected = false
    @State private var promotion: Move?
    @State private var droppedMove: Move?
    @State private var appeared = false

    private var theme: BoardTheme { BoardTheme(rawValue: themeName) ?? .walnut }

    private struct Placed: Identifiable {
        let square: Square
        let piece: Piece
        var id: String { "\(square)\(piece.assetName)" }
    }

    /// The colour whose pieces respond to the mouse right now, and whether that is a premove.
    private var interactive: (color: PieceColor, premove: Bool)? {
        if let c = movableColor, c == position.turn { return (c, false) }
        if let c = premoveColor, onPremove != nil { return (c, true) }
        return nil
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let sq = side / 8
            let legal = movableColor == position.turn ? position.legalMoves() : []
            let pieces = (0..<64).compactMap { s in position.board[s].map { Placed(square: s, piece: $0) } }

            ZStack(alignment: .topLeading) {
                Canvas { ctx, _ in drawSquares(ctx, sq: sq, legal: legal) }

                ForEach(pieces) { item in
                    let dragging = dragFrom == item.square
                    PieceView(piece: item.piece, size: sq,
                              center: dragging ? dragPoint : center(item.square, sq),
                              slideFrom: slideOrigin(for: item.square, sq: sq),
                              dragging: dragging, appeared: appeared,
                              delay: Double((item.square & 7) + (item.square >> 3)) * 0.018)
                        .zIndex(dragging ? 10 : 1)
                }
                .animation(.spring(response: 0.45, dampingFraction: 0.8), value: flipped)

                Canvas { ctx, _ in drawArrows(ctx, sq: sq) }
                    .allowsHitTesting(false)
                    .animation(.easeOut(duration: 0.2), value: arrows)

                if let onShape {
                    RightDragCatcher { start, end, flags in
                        let tint: BoardShape.Tint = flags.contains(.shift) ? .red : flags.contains(.option) ? .blue
                            : flags.contains(.command) ? .yellow : .green
                        onShape(BoardShape(from: square(at: start, sq), to: square(at: end, sq), tint: tint))
                    }
                    .frame(width: side, height: side)
                }

                if let promotion {
                    promotionPicker(for: promotion, sq: sq)
                        .transition(.pop)
                        .zIndex(20)
                }
            }
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.black.opacity(0.18)))
            .shadow(color: .black.opacity(0.22), radius: 14, y: 6)
            .contentShape(Rectangle())
            .gesture(dragGesture(sq: sq, legal: legal))
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .aspectRatio(1, contentMode: .fit)
        .onChange(of: position) {
            selected = nil
            dragFrom = nil
            promotion = nil
        }
        .onAppear { appeared = true }
    }

    // MARK: Geometry

    private func center(_ s: Square, _ sq: CGFloat) -> CGPoint {
        let col = flipped ? 7 - (s & 7) : s & 7
        let row = flipped ? s >> 3 : 7 - (s >> 3)
        return CGPoint(x: (CGFloat(col) + 0.5) * sq, y: (CGFloat(row) + 0.5) * sq)
    }

    private func rect(_ s: Square, _ sq: CGFloat) -> CGRect {
        let c = center(s, sq)
        return CGRect(x: c.x - sq / 2, y: c.y - sq / 2, width: sq, height: sq)
    }

    private func square(at p: CGPoint, _ sq: CGFloat) -> Square {
        let col = max(0, min(7, Int(p.x / sq))), row = max(0, min(7, Int(p.y / sq)))
        return Sq.make(file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row)
    }

    /// Where the piece now on a square should glide in from, if it just moved.
    private func slideOrigin(for s: Square, sq: CGFloat) -> CGPoint? {
        guard let m = lastMove, m != droppedMove, !position.chess960 else { return nil }
        if s == m.to { return center(m.from, sq) }
        // The rook in castling.
        if position.board[m.to]?.kind == .king, abs((m.to & 7) - (m.from & 7)) == 2, s == (m.from + m.to) / 2 {
            let corner = (m.from >> 3) * 8 + ((m.to & 7) == 6 ? 7 : 0)
            return center(corner, sq)
        }
        return nil
    }

    // MARK: Drawing

    private func drawSquares(_ ctx: GraphicsContext, sq: CGFloat, legal: [Move]) {
        let checked = position.inCheck ? position.kingSquare(position.turn) : nil
        for s in 0..<64 {
            let r = rect(s, sq)
            let light = Sq.isLight(s)
            ctx.fill(Path(r), with: .color(light ? theme.light : theme.dark))
            if let m = lastMove, s == m.from || s == m.to {
                ctx.fill(Path(r), with: .color(Color.yellow.opacity(0.38)))
            }
            if let m = premove, s == m.from || s == m.to {
                ctx.fill(Path(r), with: .color(Color.purple.opacity(0.42)))
            }
            if s == selected {
                ctx.fill(Path(r), with: .color(Color.accentColor.opacity(0.5)))
            }
            if s == checked {
                ctx.fill(Path(ellipseIn: r.insetBy(dx: sq * 0.04, dy: sq * 0.04)),
                         with: .radialGradient(Gradient(colors: [.red.opacity(0.85), .red.opacity(0)]),
                                               center: CGPoint(x: r.midX, y: r.midY), startRadius: sq * 0.1, endRadius: sq * 0.52))
            }
            if s == hintSquare {
                ctx.stroke(Path(roundedRect: r.insetBy(dx: 3, dy: 3), cornerRadius: 6),
                           with: .color(.green), lineWidth: 4)
            }
            if showCoordinates {
                let ink = light ? theme.dark : theme.light
                let font = Font.system(size: max(8, sq * 0.15), weight: .bold, design: .rounded)
                let bottomRank = flipped ? 7 : 0, leftFile = flipped ? 7 : 0
                if (s >> 3) == bottomRank {
                    ctx.draw(Text(String(Sq.name(s).first!)).font(font).foregroundColor(ink),
                             at: CGPoint(x: r.maxX - sq * 0.07, y: r.maxY - sq * 0.04), anchor: .bottomTrailing)
                }
                if (s & 7) == leftFile {
                    ctx.draw(Text(String(Sq.name(s).last!)).font(font).foregroundColor(ink),
                             at: CGPoint(x: r.minX + sq * 0.07, y: r.minY + sq * 0.04), anchor: .topLeading)
                }
            }
        }
        guard showLegalMoves, let from = selected else { return }
        for m in legal where m.from == from {
            let r = rect(m.to, sq)
            if position.isCapture(m) {
                ctx.stroke(Path(ellipseIn: r.insetBy(dx: sq * 0.06, dy: sq * 0.06)),
                           with: .color(.black.opacity(0.22)), lineWidth: sq * 0.08)
            } else {
                ctx.fill(Path(ellipseIn: r.insetBy(dx: sq * 0.35, dy: sq * 0.35)), with: .color(.black.opacity(0.22)))
            }
        }
    }

    private func drawArrows(_ ctx: GraphicsContext, sq: CGFloat) {
        for arrow in arrows {
            let base = arrow.tint?.color ?? Color.accentColor
            drawArrow(ctx, from: arrow.from, to: arrow.to, sq: sq, width: sq * (0.1 + 0.08 * arrow.strength),
                      color: base.opacity(0.35 + 0.45 * arrow.strength))
        }
        for shape in shapes {
            let color = shape.tint.color.opacity(0.8)
            if shape.isCircle {
                ctx.stroke(Path(ellipseIn: rect(shape.from, sq).insetBy(dx: sq * 0.05, dy: sq * 0.05)),
                           with: .color(color), lineWidth: sq * 0.07)
            } else {
                drawArrow(ctx, from: shape.from, to: shape.to, sq: sq, width: sq * 0.15, color: color)
            }
        }
    }

    private func drawArrow(_ ctx: GraphicsContext, from: Square, to: Square, sq: CGFloat, width: CGFloat, color: Color) {
        let a = center(from, sq), b = center(to, sq)
        let dx = b.x - a.x, dy = b.y - a.y
        let length = hypot(dx, dy)
        guard length > 1 else { return }
        let ux = dx / length, uy = dy / length
        let head = sq * 0.36
        let start = CGPoint(x: a.x + ux * sq * 0.28, y: a.y + uy * sq * 0.28)
        let neck = CGPoint(x: b.x - ux * head, y: b.y - uy * head)
        var path = Path()
        path.move(to: start)
        path.addLine(to: neck)
        ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round))
        var tip = Path()
        tip.move(to: b)
        tip.addLine(to: CGPoint(x: neck.x - uy * head * 0.55, y: neck.y + ux * head * 0.55))
        tip.addLine(to: CGPoint(x: neck.x + uy * head * 0.55, y: neck.y - ux * head * 0.55))
        tip.closeSubpath()
        ctx.fill(tip, with: .color(color))
    }

    private func promotionPicker(for move: Move, sq: CGFloat) -> some View {
        ZStack {
            Color.black.opacity(0.35)
                .onTapGesture { withAnimation(.castleSnappy) { promotion = nil } }
            HStack(spacing: 6) {
                ForEach([PieceKind.queen, .knight, .rook, .bishop], id: \.self) { kind in
                    Button {
                        var m = move
                        m.promotion = kind
                        promotion = nil
                        selected = nil
                        onMove(m)
                    } label: {
                        Image(Piece(color: position.turn, kind: kind).assetName)
                            .resizable()
                            .frame(width: sq * 0.95, height: sq * 0.95)
                            .padding(6)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.press)
                }
            }
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(radius: 20, y: 8)
        }
    }

    // MARK: Input

    private func dragGesture(sq: CGFloat, legal: [Move]) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard promotion == nil, let mode = interactive else { return }
                if !gestureActive {
                    gestureActive = true
                    let s = square(at: value.startLocation, sq)
                    let isTarget = selected.map { from in
                        mode.premove ? (from != s && position.board[s]?.color != mode.color)
                                     : legal.contains { $0.from == from && $0.to == s }
                    } ?? false
                    if !isTarget, position.board[s]?.color == mode.color {
                        wasSelected = selected == s
                        selected = s
                        dragFrom = s
                        dragPoint = value.location
                    }
                }
                if dragFrom != nil { dragPoint = value.location }
            }
            .onEnded { value in
                defer { gestureActive = false }
                guard promotion == nil, let mode = interactive else { return }
                let target = square(at: value.location, sq)
                if let from = dragFrom {
                    dragFrom = nil
                    if target != from {
                        attempt(from, target, legal: legal, dropped: true, premove: mode.premove)
                    } else if wasSelected {
                        selected = nil
                    }
                } else if let from = selected {
                    attempt(from, target, legal: legal, dropped: false, premove: mode.premove)
                } else if mode.premove, premove != nil {
                    onPremove?(nil)
                }
            }
    }

    private func attempt(_ from: Square, _ to: Square, legal: [Move], dropped: Bool, premove: Bool) {
        guard premove else {
            tryMove(from, to, legal: legal, dropped: dropped)
            return
        }
        selected = nil
        let promotes = position.board[from]?.kind == .pawn && ((to >> 3) == 0 || (to >> 3) == 7)
        onPremove?(Move(from: from, to: to, promotion: promotes ? .queen : nil))
    }

    private func tryMove(_ from: Square, _ to: Square, legal: [Move], dropped: Bool) {
        var options = legal.filter { $0.from == from && $0.to == to }
        if options.isEmpty, position.chess960 {
            // Dropping the king on its castled square also castles.
            options = legal.filter { $0.from == from && position.isCastling($0) && position.castlingSquares($0).king == to }
        }
        guard let first = options.first else {
            selected = nil
            return
        }
        droppedMove = dropped ? Move(from: from, to: to, promotion: nil) : nil
        if options.count > 1 {
            withAnimation(.castleSpring) { promotion = Move(from: from, to: to) }
            return
        }
        selected = nil
        if dropped { droppedMove = first }
        onMove(first)
    }
}

/// Reports right-button drags over its frame, in top-left coordinates.
private struct RightDragCatcher: NSViewRepresentable {
    var onDrag: (CGPoint, CGPoint, NSEvent.ModifierFlags) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let v = CatcherView()
        v.onDrag = onDrag
        return v
    }

    func updateNSView(_ view: CatcherView, context: Context) { view.onDrag = onDrag }

    final class CatcherView: NSView {
        var onDrag: ((CGPoint, CGPoint, NSEvent.ModifierFlags) -> Void)?
        private var monitor: Any?
        private var start: CGPoint?

        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .rightMouseUp]) { [weak self] event in
                guard let self, event.window === self.window else { return event }
                let point = self.convert(event.locationInWindow, from: nil)
                if event.type == .rightMouseDown {
                    guard self.bounds.contains(point) else { return event }
                    self.start = point
                    return nil
                }
                guard let start = self.start else { return event }
                self.start = nil
                self.onDrag?(start, point, event.modifierFlags)
                return nil
            }
        }

        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}

private struct PieceView: View {
    let piece: Piece
    let size: CGFloat
    let center: CGPoint
    let slideFrom: CGPoint?
    let dragging: Bool
    let appeared: Bool
    let delay: Double

    @State private var offset = CGSize.zero

    var body: some View {
        Image(piece.assetName)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .scaleEffect(dragging ? 1.16 : (appeared ? 1 : 0.3))
            .opacity(appeared ? 1 : 0)
            .shadow(color: .black.opacity(dragging ? 0.35 : 0), radius: 6, y: 5)
            .offset(offset)
            .position(center)
            .animation(.spring(response: 0.45, dampingFraction: 0.62).delay(delay), value: appeared)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: dragging)
            .allowsHitTesting(false)
            .onAppear {
                guard let from = slideFrom, appeared else { return }
                offset = CGSize(width: from.x - center.x, height: from.y - center.y)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { offset = .zero }
            }
    }
}

// MARK: Companions

struct EvalBar: View {
    let score: EngineScore?
    var flipped = false

    var body: some View {
        let white = score?.winPercent ?? 50
        GeometryReader { geo in
            ZStack(alignment: flipped ? .top : .bottom) {
                Color(white: 0.16)
                Rectangle()
                    .fill(Color(white: 0.96))
                    .frame(height: geo.size.height * white / 100)
            }
            .overlay(alignment: white >= 50 ? (flipped ? .top : .bottom) : (flipped ? .bottom : .top)) {
                if let score {
                    Text(score.short)
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(white >= 50 ? Color.black : Color.white)
                        .padding(.vertical, 4)
                        .contentTransition(.numericText())
                }
            }
            .animation(.spring(response: 0.5, dampingFraction: 0.85), value: white)
        }
        .frame(width: 22)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.black.opacity(0.2)))
    }
}

/// The name, material edge and clock shown above and below a board.
struct PlayerStrip: View {
    let name: String
    let color: PieceColor
    var detail: String? = nil
    var clock: Double? = nil
    var isActive = false
    var material = 0

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(color == .white ? Color.white : Color(white: 0.12))
                .overlay(Circle().strokeBorder(.secondary.opacity(0.5)))
                .frame(width: 14, height: 14)
            Text(name).font(.headline).lineLimit(1)
            if let detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
            if material > 0 {
                Text("+\(material)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
            Spacer()
            if isActive, clock == nil {
                Image(systemName: "ellipsis")
                    .symbolEffect(.variableColor.iterative, options: .repeating)
                    .foregroundStyle(.secondary)
            }
            if let clock {
                Text(PlayModel.clockText(clock))
                    .font(.system(.title3, design: .rounded).monospacedDigit().weight(.semibold))
                    .foregroundStyle(isActive ? Color.white : Color.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .background(isActive ? AnyShapeStyle(clock < 20 ? Color.red : Color.accentColor) : AnyShapeStyle(.quaternary),
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .scaleEffect(isActive ? 1.04 : 1)
                    .animation(.castleSpring, value: isActive)
            }
        }
        .frame(height: 30)
    }
}

/// Step controls under a board.
struct NavigationBar: View {
    let game: Game
    var onFlip: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 4) {
            button("backward.end.fill", "Start") { game.toStart() }.disabled(game.current.parent == nil)
            button("chevron.backward", "Back") { game.back() }.disabled(game.current.parent == nil)
            button("chevron.forward", "Forward") { game.forward() }.disabled(game.current.children.isEmpty)
            button("forward.end.fill", "End") { game.toEnd() }.disabled(game.current.children.isEmpty)
            if let onFlip {
                Divider().frame(height: 16).padding(.horizontal, 4)
                button("arrow.up.arrow.down", "Flip board", action: onFlip)
            }
        }
        .padding(4)
        .background(.quaternary.opacity(0.5), in: Capsule())
    }

    private func button(_ symbol: String, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 34, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.82))
        .help(help)
    }
}
