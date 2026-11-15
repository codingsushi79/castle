import SwiftUI

struct EnginesView: View {
    @Environment(AppModel.self) private var app
    @State private var versions: [String: String] = [:]
    @State private var probes: [UCIEngine] = []
    @State private var options: [String: [UCIOption]] = [:]
    @State private var configuring: EngineEntry?

    var body: some View {
        let catalog = app.catalog
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 14)], spacing: 14) {
                ForEach(Array(catalog.engines.enumerated()), id: \.element.id) { index, engine in
                    card(engine, catalog)
                        .staggered(index)
                }
            }
            .padding(20)
        }
        .toolbar {
            ToolbarItemGroup {
                Button("Rescan", systemImage: "arrow.clockwise") {
                    withAnimation(.castleSpring) { catalog.refresh() }
                    probe()
                }
                .help("Look for installed engines again")
                Button("Add Engine", systemImage: "plus") { addCustom() }
                    .help("Add any UCI engine from disk")
            }
        }
        .onAppear(perform: probe)
        .sheet(item: $configuring) { engine in
            EngineOptionsView(engine: engine, options: options[engine.id] ?? [])
        }
        .navigationTitle("Engines")
        .navigationSubtitle("\(catalog.available.count) of \(catalog.engines.count) ready")
    }

    private func card(_ engine: EngineEntry, _ catalog: EngineCatalog) -> some View {
        let isDefault = catalog.defaultID == engine.id
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: engine.isBundled ? "shippingbox.fill" : engine.isCustom ? "wrench.and.screwdriver.fill" : "cpu.fill")
                    .font(.title2)
                    .foregroundStyle(engine.isAvailable ? AnyShapeStyle(Color.accentColor.gradient) : AnyShapeStyle(.tertiary))
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(engine.name).font(.headline)
                    Text(versions[engine.id] ?? (engine.isAvailable ? "Ready" : "Not installed"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .contentTransition(.opacity)
                }
                Spacer()
                if engine.isBundled { Chip(text: "Built in", symbol: "checkmark.seal.fill", tint: .accentColor) }
                else if engine.isAvailable { Chip(text: "Installed", symbol: "checkmark.circle.fill", tint: .green) }
                else { Chip(text: "Missing", symbol: "questionmark.circle", tint: .secondary) }
            }
            Text(engine.summary)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, minHeight: 34, alignment: .topLeading)
            if let progress = catalog.installing[engine.id] {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(progress).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                .transition(.opacity)
            } else if let error = catalog.installError[engine.id] {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
            } else if !engine.isAvailable, let hint = engine.installHint {
                Text(hint).font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
            HStack {
                if engine.isAvailable {
                    Button {
                        withAnimation(.castleSpring) { catalog.defaultID = engine.id }
                    } label: {
                        Label(isDefault ? "Default" : "Set Default", systemImage: isDefault ? "star.fill" : "star")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .disabled(isDefault)
                    .fixedSize()
                    Button("Analyse", systemImage: "waveform.path.ecg") {
                        app.analysis.selectEngine(engine.id)
                        if !app.analysis.isRunning { app.analysis.toggle() }
                        app.go(.analysis)
                    }
                    .fixedSize()
                    Button("Options", systemImage: "slider.horizontal.3") { configuring = engine }
                        .labelStyle(.iconOnly)
                        .help("Engine options")
                        .disabled(options[engine.id] == nil)
                } else if catalog.formula(for: engine) != nil, EngineCatalog.brewPath != nil {
                    Button("Install", systemImage: "arrow.down.circle.fill") {
                        withAnimation(.castleSpring) { catalog.install(engine) }
                    }
                    .disabled(catalog.installing[engine.id] != nil)
                    .help("Install with Homebrew")
                    .fixedSize()
                }
                Spacer()
                if engine.isCustom {
                    Button("Remove", systemImage: "trash", role: .destructive) {
                        withAnimation(.castleSpring) { catalog.removeCustom(engine.id) }
                    }
                    .labelStyle(.iconOnly)
                } else if !engine.isBundled {
                    Button(engine.isAvailable ? "Change Location" : "Locate…", systemImage: "folder") { locate(engine) }
                        .labelStyle(engine.isAvailable ? AnyLabelStyle(.iconOnly) : AnyLabelStyle(.titleAndIcon))
                        .help("Choose where this engine's binary lives")
                }
                if let path = engine.path, !engine.isBundled {
                    Button("Show in Finder", systemImage: "magnifyingglass") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                    }
                    .labelStyle(.iconOnly)
                    .help(path)
                }
            }
            .controlSize(.small)
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(isDefault ? Color.accentColor.opacity(0.7) : Color.clear, lineWidth: 1.5))
        .opacity(engine.isAvailable ? 1 : 0.75)
    }

    private func chooseBinary() -> URL? {
        let panel = NSOpenPanel()
        panel.message = "Choose a UCI engine binary"
        panel.allowedContentTypes = [.unixExecutable, .executable, .item]
        panel.directoryURL = URL(fileURLWithPath: "/opt/homebrew/bin")
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func locate(_ engine: EngineEntry) {
        guard let url = chooseBinary() else { return }
        withAnimation(.castleSpring) { app.catalog.locate(engine.id, at: url.path) }
        probe()
    }

    private func addCustom() {
        guard let url = chooseBinary() else { return }
        withAnimation(.castleSpring) { app.catalog.addCustom(path: url.path, name: url.lastPathComponent) }
        probe()
    }

    /// Asks each installed engine for its real name and version.
    private func probe() {
        for entry in app.catalog.available where versions[entry.id] == nil {
            guard let path = entry.path else { continue }
            let engine = UCIEngine(path: path)
            probes.append(engine)
            engine.onReady = { [weak engine] in
                guard let engine else { return }
                let author = engine.author.isEmpty ? "" : " · \(engine.author)"
                withAnimation { versions[entry.id] = engine.name + author }
                options[entry.id] = engine.options
                engine.quit()
                probes.removeAll { $0 === engine }
            }
            engine.start()
        }
    }
}

/// Every option an engine reports, saved per engine and applied whenever it starts.
struct EngineOptionsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let engine: EngineEntry
    let options: [UCIOption]
    @State private var filter = ""

    private static let hidden: Set<String> = ["multipv", "uci_chess960", "ponder", "uci_analysemode", "uci_showwdl",
                                              "uci_limitstrength", "uci_elo"]

    var body: some View {
        let catalog = app.catalog
        let _ = catalog.optionsRevision
        let saved = catalog.options(for: engine.id)
        let shown = options.filter { $0.kind != .button && !Self.hidden.contains($0.name.lowercased())
            && (filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter)) }
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(engine.name).font(.title3.weight(.bold))
                    Text("\(saved.count) option\(saved.count == 1 ? "" : "s") changed. Applies the next time the engine starts.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                TextField("Filter", text: $filter).textFieldStyle(.roundedBorder).frame(width: 150)
            }
            .padding(16)
            Divider()
            Form {
                ForEach(shown) { opt in
                    row(opt, value: saved[opt.name] ?? opt.defaultValue, changed: saved[opt.name] != nil)
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Button("Reset All", role: .destructive) { withAnimation { catalog.resetOptions(for: engine.id) } }
                    .disabled(saved.isEmpty)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(14)
        }
        .frame(width: 520, height: 560)
    }

    @ViewBuilder
    private func row(_ opt: UCIOption, value: String, changed: Bool) -> some View {
        let catalog = app.catalog
        let set: (String) -> Void = { new in
            catalog.setOption(opt.name, to: new == opt.defaultValue ? nil : new, for: engine.id)
        }
        let label = Text(opt.name).fontWeight(changed ? .semibold : .regular)
        switch opt.kind {
        case .check:
            Toggle(isOn: Binding(get: { value == "true" }, set: { set($0 ? "true" : "false") })) { label }
        case .spin:
            LabeledContent {
                HStack(spacing: 6) {
                    TextField("", text: Binding(get: { value }, set: { text in
                        guard let n = Int(text) else { return }
                        set(String(min(max(n, opt.min ?? Int.min), opt.max ?? Int.max)))
                    }))
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 90)
                    if let lo = opt.min, let hi = opt.max {
                        Text("\(lo)–\(hi)").font(.caption).foregroundStyle(.tertiary).frame(width: 100, alignment: .leading)
                    }
                }
            } label: { label }
        case .combo:
            Picker(selection: Binding(get: { value }, set: set)) {
                ForEach(opt.choices, id: \.self) { Text($0).tag($0) }
            } label: { label }
        case .string:
            LabeledContent {
                HStack(spacing: 6) {
                    TextField("", text: Binding(get: { value == "<empty>" ? "" : value }, set: { set($0.isEmpty ? opt.defaultValue : $0) }))
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 190)
                    if opt.name.lowercased().contains("path") || opt.name.lowercased().contains("file") {
                        Button("Choose", systemImage: "folder") {
                            let panel = NSOpenPanel()
                            panel.canChooseDirectories = true
                            panel.canChooseFiles = true
                            if panel.runModal() == .OK, let url = panel.url { set(url.path) }
                        }
                        .labelStyle(.iconOnly)
                    }
                }
            } label: { label }
        case .button:
            EmptyView()
        }
    }
}
