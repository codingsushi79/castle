import SwiftUI

struct AccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var site = ChessAccount.Site.lichess
    @State private var username = ""
    @AppStorage("accountDownloadMax") private var maxGames = 200

    var body: some View {
        let model = app.accounts
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Picker("Site", selection: $site) {
                        ForEach(ChessAccount.Site.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .labelsHidden()
                    .frame(width: 130)
                    TextField("Username", text: $username)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 240)
                        .onSubmit(add)
                    Button("Add Account", systemImage: "plus", action: add)
                        .disabled(username.trimmingCharacters(in: .whitespaces).isEmpty)
                    Spacer()
                    Picker("Download", selection: $maxGames) {
                        ForEach([50, 200, 500, 1000, 3000], id: \.self) { Text("Latest \($0) games").tag($0) }
                    }
                    .frame(width: 230)
                }
                .panel()
                .staggered(0)

                if model.accounts.isEmpty {
                    ContentUnavailableView {
                        Label("No Accounts", systemImage: "person.crop.circle.badge.plus")
                    } description: {
                        Text("Add your Lichess or Chess.com username to see your ratings and download your games into the Library. Only public data is read; no password is needed.")
                    }
                    .frame(maxWidth: .infinity, minHeight: 320)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 340, maximum: 520), spacing: 14)], spacing: 14) {
                        ForEach(Array(model.accounts.enumerated()), id: \.element.id) { index, account in
                            card(account, model).staggered(index + 1)
                        }
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("Accounts")
        .navigationSubtitle("\(model.accounts.count) account\(model.accounts.count == 1 ? "" : "s")")
    }

    private func add() {
        withAnimation(.castleSpring) { app.accounts.add(site: site, username: username) }
        username = ""
    }

    private func card(_ account: ChessAccount, _ model: AccountsModel) -> some View {
        let ratings = model.ratings[account.id] ?? []
        let busy = model.busy.contains(account.id)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: account.site == .lichess ? "bolt.horizontal.circle.fill" : "pawprint.circle.fill")
                    .font(.title)
                    .foregroundStyle(Color.accentColor.gradient)
                VStack(alignment: .leading, spacing: 1) {
                    Text(account.username).font(.headline)
                    Text("\(account.site.rawValue) · \(model.gameCount(account)) games in Library")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Remove", systemImage: "trash", role: .destructive) {
                    withAnimation(.castleSpring) { model.remove(account) }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
            }
            if ratings.isEmpty {
                Text("No ratings yet").font(.callout).foregroundStyle(.secondary).frame(height: 44)
            } else {
                HStack(spacing: 8) {
                    ForEach(ratings) { r in
                        VStack(spacing: 1) {
                            Text(verbatim: "\(r.rating)").font(.system(.title3, design: .rounded).weight(.bold).monospacedDigit())
                            Text(r.label).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .help("\(r.games) games")
                    }
                }
                .transition(.opacity)
            }
            HStack {
                Button {
                    model.download(account, max: maxGames)
                } label: {
                    Label(busy ? "Downloading…" : "Download Games", systemImage: "arrow.down.circle.fill")
                        .symbolEffect(.pulse, options: .repeating, isActive: busy)
                }
                .disabled(busy)
                Button("Stats", systemImage: "chart.bar.xaxis") {
                    app.go(.library)
                }
                .help("Open the Library, then Player Stats")
                Button("Refresh", systemImage: "arrow.clockwise") { model.refresh(account) }
                    .labelStyle(.iconOnly)
                Spacer()
            }
            .controlSize(.small)
            if let status = model.status[account.id] {
                Text(status).font(.caption).foregroundStyle(.secondary).transition(.opacity)
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .animation(.castleSpring, value: model.status[account.id])
    }
}
