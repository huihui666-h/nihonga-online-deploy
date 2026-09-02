/* Index-only copy; the existing authentication and admin translations stay intact. */
const indexTranslations = {
  zh: {
    skipToArtists: "跳到画家目录", navArtists: "画家目录", navExplore: "探索画家", navNews: "Nihonga Now", navNewsAria: "进入 Nihonga Now 日本画新闻", navAbout: "关于", navContribute: "参与共建",
    newsHomeEyebrow: "NIHONGA NOW", newsHomeTitle: "日本画新闻", newsHomeLede: "展览、公募与画家动态，及时汇集。", newsHomeMore: "查看全部新闻",
    logEyebrow: "HUI LOG", logTitle: "更新日志", logDescription: "记录 NIHONGA INDEX 如何一点点生长。", logEntryOneTitle: "NIHONGA NOW 上线", logEntryOneText: "新增汇集展览、公募与画家动态的日本画新闻栏目。", logEntryTwoTitle: "整理最近加入的画家", logEntryTwoText: "有加入日期时按新到旧显示，没有日期时保留清晰说明。", logEntryThreeTitle: "让搜索成为入口", logEntryThreeText: "从作家名、学校、地区和关键词开始发现日本画家。",
    indexSubtitle: "从作家、题材与学校，发现日本画。", indexSearchPlaceholder: "作家名、学校、地区或关键词…", browseByTag: "从标签开始",
    featuredTitle: "从这里开始认识", featuredDaily: "每日从已收录画家中轮换，发现新的名字。", featuredManual: "HUI 的特别推荐，以及更多值得认识的名字。",
    recentTitle: "最近加入", recentDescription: "新的发现，持续收录。", recentUnavailable: "加入时间暂不可用。你仍可在画家目录中浏览所有作家。",
    randomTitle: "偶然の出会い", randomDescription: "不必知道名字，让下一位画家带来灵感。", randomButton: "随机发现一位画家", randomAgain: "再遇见一位", randomInvitation: "在熟悉的视线之外。",
    directoryTitle: "画家目录", directorySearch: "在全部画家中搜索", viewLabel: "查看方式", tagFilter: "标签", loadMore: "查看更多画家",
    rankingContext: "今日站内作家资料查看记录。", aboutTitle: "从一次发现，到下一次相遇。",
    aboutDescription: "我们从大学、展览、公募、画廊、官方网站、SNS 等多个公开信息源收集并整理日本画作家的资料。",
    contributeTitle: "一起，让索引更好。", backToTop: "返回顶部 ↑", closeDialog: "关闭", cardDetails: "认识作家", cardOpenIG: "Instagram ↗", cardReport: "本人吗？信息修正", correctField: "修改项目", correctValue: "修改后的内容", correctReference: "参考来源 URL", correctContact: "联系方式（可选）", sourceNote: "收录资料", cardAdded: "加入于",
    loadingArtists: "正在加载画家…", loadFailed: "暂时无法加载画家。请重试。", retryLoad: "重新加载", noArtists: "暂时没有已收录的画家。", noDiscovery: "加载画家后，即可开始发现。", loadingRanking: "正在读取今日记录…",
    removeFilter: (label) => `移除筛选：${label}`, showingArtists: (shown, total) => `已显示 ${shown} / ${total} 位画家`, searchResultsLink: (n) => `查看 ${n} 位匹配画家 →`,
    finderTitle: "你想寻找怎样的日本画家？", finderDescription: "未来，你可以描述题材与氛围，从本站收录的真实画家中寻找灵感。", finderInputLabel: "描述你的想法", finderPlaceholder: "例如：想找擅长人物与幻想题材的日本画家。", finderSend: "探索作家", finderComingSoon: "AI 画家发现助手正在准备中。现在可以使用普通搜索和标签发现画家。", finderPrivacy: "当前仅为界面预览。输入不会发送，不连接 AI 服务，也不会产生费用。",
    finderPrompts: ["人物画作家", "幻想题材", "动物题材", "东京艺大出身", "安静的氛围", "类似松井冬子的作家"]
  },
  en: {
    skipToArtists: "Skip to artists", navArtists: "Artists", navExplore: "Explore", navNews: "Nihonga Now", navNewsAria: "Open Nihonga Now news", navAbout: "About", navContribute: "Contribute",
    newsHomeEyebrow: "NIHONGA NOW", newsHomeTitle: "Nihonga news", newsHomeLede: "Exhibitions, open calls and artist updates, gathered in one place.", newsHomeMore: "View all news",
    logEyebrow: "HUI LOG", logTitle: "Site log", logDescription: "A record of how NIHONGA INDEX grows, one update at a time.", logEntryOneTitle: "NIHONGA NOW goes live", logEntryOneText: "A news desk for exhibitions, open calls and artist updates joins the index.", logEntryTwoTitle: "Recently added artists, clarified", logEntryTwoText: "Artists with dates sort newest first; artists without dates keep a clear explanation.", logEntryThreeTitle: "Search becomes the starting point", logEntryThreeText: "Start discovering through artist names, schools, regions and keywords.",
    indexSubtitle: "Discover Nihonga through artists, subjects and schools.", indexSearchPlaceholder: "Artist, school, region or keyword…", browseByTag: "START WITH A TAG",
    featuredTitle: "A place to begin", featuredDaily: "A daily rotation from the index. A few new names to discover.", featuredManual: "HUI’s featured artists, alongside more names to discover.",
    recentTitle: "New to the index", recentDescription: "New discoveries, continually collected.", recentUnavailable: "Addition dates are not available yet. All artists are available in the directory.",
    randomTitle: "A chance encounter", randomDescription: "No name in mind? Let the next artist surprise you.", randomButton: "Discover a random artist", randomAgain: "Discover another artist", randomInvitation: "Beyond the familiar.",
    directoryTitle: "Find your next artist", directorySearch: "Search all artists", viewLabel: "Display mode", tagFilter: "Tags", loadMore: "Show more artists",
    rankingContext: "Today’s artist profile views in this index.", aboutTitle: "One discovery leads to another.",
    aboutDescription: "We collect and organize Nihonga artist information from universities, exhibitions, open calls, galleries, official sites, social media and other public sources.",
    contributeTitle: "Help the index grow.", backToTop: "Back to top ↑", closeDialog: "Close", cardDetails: "Meet the artist", cardOpenIG: "Instagram ↗", cardReport: "Are you this artist? Correct information", correctField: "Field to change", correctValue: "Corrected value", correctReference: "Reference URL", correctContact: "Contact (optional)", sourceNote: "Source notes", cardAdded: "Added",
    loadingArtists: "Loading artists…", loadFailed: "Artists could not be loaded. Please try again.", retryLoad: "Try again", noArtists: "No artists have been added yet.", noDiscovery: "Discovery will be available when artists load.", loadingRanking: "Loading today’s activity…",
    removeFilter: (label) => `Remove filter: ${label}`, showingArtists: (shown, total) => `Showing ${shown} of ${total} artists`, searchResultsLink: (n) => `Explore ${n} matching artists →`,
    finderTitle: "What kind of artist are you looking for?", finderDescription: "Describe a subject or atmosphere. In the future, the finder will suggest real artists from this index.", finderInputLabel: "Describe your idea", finderPlaceholder: "For example: artists who paint figures and imagined worlds.", finderSend: "Find artists", finderComingSoon: "AI Artist Finder is coming soon. For now, discover artists through search and tags.", finderPrivacy: "Interface preview only. Your text stays here. No AI service, requests or charges.",
    finderPrompts: ["Figurative painters", "Imagined worlds", "Animal subjects", "Tokyo University of the Arts", "A quiet atmosphere", "Artists like Fuyuko Matsui"]
  },
  ja: {
    skipToArtists: "作家一覧へ", navArtists: "作家一覧", navExplore: "作家を探す", navNews: "Nihonga Now", navNewsAria: "Nihonga Now 日本画ニュースへ", navAbout: "このサイトについて", navContribute: "情報提供",
    newsHomeEyebrow: "NIHONGA NOW", newsHomeTitle: "日本画ニュース", newsHomeLede: "展覧会、公募、作家の動きを、いち早く。", newsHomeMore: "すべて見る",
    logEyebrow: "HUI LOG", logTitle: "更新記録", logDescription: "NIHONGA INDEX が少しずつ育っていく記録。", logEntryOneTitle: "NIHONGA NOW を公開", logEntryOneText: "展覧会、公募、作家動向を集める日本画ニュース欄を追加。", logEntryTwoTitle: "最近追加された作家を整理", logEntryTwoText: "追加日がある作家は新しい順に。未設定でも案内を保って表示。", logEntryThreeTitle: "検索を入口に", logEntryThreeText: "作家名、学校、地域、キーワードから日本画家を探せます。",
    indexSubtitle: "日本画を、作家・題材・学校から探す。", indexSearchPlaceholder: "作家名、学校、地域、キーワード…", browseByTag: "タグから探す",
    featuredTitle: "おすすめ作家", featuredDaily: "収録作家から日替わりでご紹介。新しい名前との出会いを。", featuredManual: "HUI のおすすめと、出会ってほしい作家たち。",
    recentTitle: "最近追加された作家", recentDescription: "新たな発見を、少しずつ。", recentUnavailable: "新たに加わった作家を、順次こちらで紹介します。",
    randomTitle: "偶然の出会い", randomDescription: "名前を知らなくても。次の作家から、ひらめきを。", randomButton: "作家をランダムに探す", randomAgain: "もう一人と出会う", randomInvitation: "いつもの視線の、その先に。",
    directoryTitle: "すべての作家", directorySearch: "作家一覧を検索", viewLabel: "表示形式", tagFilter: "タグ", loadMore: "もっと見る",
    rankingContext: "本日の作家情報の閲覧記録。", aboutTitle: "ひとつの発見から、次の出会いへ。",
    aboutDescription: "大学・展覧会・公募・画廊・公式サイト・SNS など複数の公開情報源から、日本画作家の情報を収集・整理しています。",
    contributeTitle: "索引を、ともに育てる。", backToTop: "ページ上部へ ↑", closeDialog: "閉じる", cardDetails: "作家を知る", cardOpenIG: "Instagram ↗", cardReport: "本人ですか？情報を修正", correctField: "修正する項目", correctValue: "修正後の内容", correctReference: "参考 URL", correctContact: "連絡先（任意）", sourceNote: "収録メモ", cardAdded: "追加日",
    loadingArtists: "作家を読み込んでいます…", loadFailed: "読み込めませんでした。もう一度お試しください。", retryLoad: "再読み込み", noArtists: "まだ作家が登録されていません。", noDiscovery: "読み込み後に作家を探せます。", loadingRanking: "本日の記録を読み込んでいます…",
    removeFilter: (label) => `条件を解除：${label}`, showingArtists: (shown, total) => `${total} 名中 ${shown} 名を表示`, searchResultsLink: (n) => `${n} 名の作家を見る →`,
    finderTitle: "どんな日本画作家を探していますか？", finderDescription: "題材や雰囲気を言葉に。今後、この索引に収録された作家からご提案します。", finderInputLabel: "探したい作家について", finderPlaceholder: "例：人物と幻想を描く作家を探したい", finderSend: "作家を探す", finderComingSoon: "AI 日本画作家ナビは準備中です。今は検索とタグから作家を探せます。", finderPrivacy: "現在は UI プレビューです。入力は送信されません。AI 接続・リクエスト・費用は発生しません。",
    finderPrompts: ["人物画の作家", "幻想的な作家", "動物を描く作家", "東京藝術大学出身", "静かな雰囲気", "松井冬子に近い作家"]
  }
};
const indexLabels = {
  zh: {
    indexName: "日本画作家インデックス", indexBrand: "NIHONGA INDEX", navAiFinder: "AI 找画家",
    featuredEyebrow: "精选画家", recentEyebrow: "最近加入", randomEyebrow: "随机发现", directoryEyebrow: "全部画家",
    rankingEyebrow: "今日查看排行", statisticsEyebrow: "索引数据", aboutEyebrow: "HUI 的话", contributeEyebrow: "参与共建", submitEyebrow: "推荐画家", correctEyebrow: "信息纠错",
    gridView: "网格", listView: "列表", artistDetailEyebrow: "画家 / 日本画索引", huiNoteLabel: "HUI 推荐语", cardIndexLabel: "日本画",
    finderEyebrow: "AI 画家发现助手", comingSoon: "准备中", publicDomainDetail: "公有领域 · 局部", publicDomainCredit: "長谷川等伯《松林図屏風》 · 公有领域",
    curatedBy: "A project by HUI STUDIO", welcomeSubtitle: "走进由画笔与矿物颜料织就的千年之美", enterSite: "进入", accessEyebrow: "HUI STUDIO · 访问入口",
    mainNavigation: "主导航", homeLink: "NIHONGA INDEX — 首页", activeFiltersLabel: "当前筛选条件", activityLabel: "索引动态", statisticsLabel: "数据统计", privateEntrance: "管理入口",
    previewNotice: "本地只读预览 · 不写入线上数据"
  },
  en: {
    indexName: "NIHONGA INDEX", indexBrand: "NIHONGA INDEX", navAiFinder: "AI Finder",
    featuredEyebrow: "FEATURED ARTISTS", recentEyebrow: "RECENTLY ADDED", randomEyebrow: "RANDOM DISCOVERY", directoryEyebrow: "ALL ARTISTS",
    rankingEyebrow: "TODAY RANKING", statisticsEyebrow: "THE INDEX, IN NUMBERS", aboutEyebrow: "A NOTE FROM HUI", contributeEyebrow: "CONTRIBUTE", submitEyebrow: "SUBMIT", correctEyebrow: "REPORT",
    gridView: "Grid", listView: "List", artistDetailEyebrow: "ARTIST / NIHONGA INDEX", huiNoteLabel: "HUI NOTE", cardIndexLabel: "NIHONGA",
    finderEyebrow: "AI ARTIST FINDER", comingSoon: "COMING SOON", publicDomainDetail: "PUBLIC DOMAIN · DETAIL", publicDomainCredit: "Hasegawa Tohaku · Pine Trees · Public Domain",
    curatedBy: "A project by HUI STUDIO", welcomeSubtitle: "Into the thousand-year beauty woven by brush and mineral pigment", enterSite: "Enter", accessEyebrow: "HUI STUDIO · ACCESS",
    mainNavigation: "Main navigation", homeLink: "NIHONGA INDEX — Home", activeFiltersLabel: "Active filters", activityLabel: "Index activity", statisticsLabel: "Statistics", privateEntrance: "Private entrance",
    previewNotice: "Read-only local preview · No production writes"
  },
  ja: {
    indexName: "日本画作家インデックス", indexBrand: "NIHONGA INDEX", navAiFinder: "AI作家ナビ",
    featuredEyebrow: "おすすめ作家", recentEyebrow: "最近追加された作家", randomEyebrow: "偶然の出会い", directoryEyebrow: "すべての作家",
    rankingEyebrow: "本日の閲覧ランキング", statisticsEyebrow: "数字で見る索引", aboutEyebrow: "HUI より", contributeEyebrow: "情報を寄せる", submitEyebrow: "作家を推薦", correctEyebrow: "情報の修正",
    gridView: "グリッド", listView: "リスト", artistDetailEyebrow: "作家 / 日本画索引", huiNoteLabel: "HUI のひとこと", cardIndexLabel: "日本画",
    finderEyebrow: "AI 日本画作家ナビ", comingSoon: "準備中", publicDomainDetail: "パブリックドメイン · 部分", publicDomainCredit: "長谷川等伯《松林図屏風》 · パブリックドメイン",
    curatedBy: "A project by HUI STUDIO", welcomeSubtitle: "筆と岩絵具が織りなす、千年の美の世界へ", enterSite: "入る", accessEyebrow: "HUI STUDIO · 入り口",
    mainNavigation: "メインナビゲーション", homeLink: "NIHONGA INDEX — ホーム", activeFiltersLabel: "選択中の条件", activityLabel: "索引の動き", statisticsLabel: "収録データ", privateEntrance: "管理者入口",
    previewNotice: "ローカル閲覧専用プレビュー · 本番データへの書き込みなし"
  }
};
Object.entries(indexTranslations).forEach(([lang, copy]) => Object.assign(I18N.data[lang], copy, indexLabels[lang]));
