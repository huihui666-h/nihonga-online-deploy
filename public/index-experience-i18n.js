/* Account capabilities describe implemented behavior, not promised cloud services. */
const experienceTranslations = {
  zh: {
    accountTitle: "你的浏览空间", accountGuide: "游客与注册账号有什么不同？", accountGuest: "游客", accountMember: "注册用户", accountEntry: "游客 · 登录", accountUnknown: "登录 / 注册",
    guestDescription: "无需注册，也能完整浏览、搜索、筛选和分享画家；推荐画家、信息纠错和收藏需登录。", memberDescription: "使用邮箱账号登录，保存收藏并推荐画家或提交信息纠错。",
    featureLabel: "功能", featureBrowse: "浏览、搜索与分享", featureContribute: "推荐画家与信息纠错", featureHistory: "本标签页浏览进度", featureFavorites: "按账号区分的本机收藏", featureSession: "登录身份与保持登录", featureAvailable: "可用", featureRegister: "登录后可用", featureGuestSession: "仅游客浏览", featureMemberSession: "邮箱登录，可选择保持登录",
    accountScope: "游客可以公开浏览、搜索、筛选和分享；推荐画家、信息纠错与收藏仅对已登录用户开放。收藏仅保存在当前浏览器，按账号区分；不跨设备同步，清除网站数据会丢失。", progressScope: "搜索条件和浏览位置仅在当前标签页记忆，不上传。",
    memberOnlyContribution: "推荐画家和提交信息纠错仅对已登录用户开放。", signInToContribute: "登录后继续",
    signInAction: "登录账号", registerAction: "创建账号", keepBrowsing: "继续浏览", myFavorites: "我的收藏", favoritesCount: (n) => `我的收藏 · ${n}`, showFavorites: "只看我的收藏", allDirectory: "查看全部画家", favoritesEmpty: "还没有收藏。打开画家详情，点击“收藏画家”即可加入。", favoritesNoMatches: "收藏中没有匹配结果。可以重置筛选，或查看全部画家。",
    saveArtist: "收藏画家", removeFavorite: "取消收藏", favoriteSaved: "已加入本机收藏", favoriteRemoved: "已取消收藏", storageUnavailable: "浏览器未允许保存，收藏未更改。请允许网站存储后重试。",
    shareSearch: "分享当前筛选", shareArtist: "分享这个作家", shareTitle: "分享这次发现", shareLinkLabel: "分享链接", copyLink: "复制链接", copiedLink: "链接已复制", copyManually: "未能自动复制。请选中链接后手动复制。", shareHelp: "链接只包含画家或公开筛选条件，不包含账号、收藏或浏览记录。", localShareHelp: "这是本机预览链接，只能在这台电脑上打开。上线后可分享正式地址。", missingArtist: "这位画家暂时不在当前目录中，你仍可浏览其他画家。",
    favoritesScope: "当前账号 · 当前浏览器", imageTitle: "长谷川等伯《松林图屏风》局部", metaDescription: "日本画作家独立索引。从姓名、学校、地区与标签发现作家，并查看公开信息源。",
    demoMemberNotice: "本地注册用户演示 · 虚构体验账号 · 不创建账号、不写入线上数据"
  },
  en: {
    accountTitle: "Your browsing space", accountGuide: "Guest or registered account?", accountGuest: "Guest", accountMember: "Registered user", accountEntry: "Guest · Sign in", accountUnknown: "Sign in / Register",
    guestDescription: "Browse, search, filter and share the full index without registering; sign in to save favorites, recommend artists or report corrections.", memberDescription: "Sign in with an email account to save favorites, recommend artists and report corrections in this browser.",
    featureLabel: "Feature", featureBrowse: "Browse, search and share", featureContribute: "Recommend artists and report information", featureHistory: "Browsing progress in this tab", featureFavorites: "Local favorites separated by account", featureSession: "Account identity and stay signed in", featureAvailable: "Available", featureRegister: "Sign in to use", featureGuestSession: "Guest browsing only", featureMemberSession: "Email sign-in; optional stay signed in",
    accountScope: "Guests can browse, search, filter and share the public index. Sign in to save favorites, recommend artists or report corrections. Favorites stay in this browser, separately for each account; they do not sync across devices and are lost if site data is cleared.", progressScope: "Search and scroll position stay in this tab and are not uploaded.",
    memberOnlyContribution: "Recommending artists and reporting corrections is available after sign-in.", signInToContribute: "Sign in to continue",
    signInAction: "Sign in", registerAction: "Create account", keepBrowsing: "Continue browsing", myFavorites: "My favorites", favoritesCount: (n) => `My favorites · ${n}`, showFavorites: "Only my favorites", allDirectory: "View all artists", favoritesEmpty: "No favorites yet. Open an artist’s details and choose “Save artist”.", favoritesNoMatches: "No favorites match. Reset the filters or view all artists.",
    saveArtist: "Save artist", removeFavorite: "Remove favorite", favoriteSaved: "Saved in this browser", favoriteRemoved: "Favorite removed", storageUnavailable: "Browser storage is unavailable. Favorites were not changed. Allow site storage and try again.",
    shareSearch: "Share these filters", shareArtist: "Share artist", shareTitle: "Share your discovery", shareLinkLabel: "Share link", copyLink: "Copy link", copiedLink: "Link copied", copyManually: "Could not copy automatically. Select the link and copy it manually.", shareHelp: "The link contains an artist or public filters, never your account, favorites or browsing history.", localShareHelp: "This local preview link works only on this computer. Share the public address after deployment.", missingArtist: "This artist is not in the current index. You can still explore other artists.",
    favoritesScope: "This account · This browser", imageTitle: "Detail of Pine Trees by Hasegawa Tohaku", metaDescription: "An independent Nihonga artist index. Discover artists by name, school, region and tag, with links to public sources.",
    demoMemberNotice: "Local registered-user demo · Fictional account · No account creation or production writes"
  },
  ja: {
    accountTitle: "あなたの閲覧スペース", accountGuide: "ゲストと登録ユーザーの違い", accountGuest: "ゲスト", accountMember: "登録ユーザー", accountEntry: "ゲスト · ログイン", accountUnknown: "ログイン / 登録",
    guestDescription: "登録なしで、すべての作家の閲覧・検索・絞り込み・共有ができます。お気に入り、作家の推薦、情報の修正報告はログイン後に利用できます。", memberDescription: "メールアドレスでログインすると、このブラウザにお気に入りを保存し、作家の推薦や修正報告を送れます。",
    featureLabel: "機能", featureBrowse: "閲覧・検索・共有", featureContribute: "作家の推薦・情報の修正報告", featureHistory: "このタブでの閲覧位置の記憶", featureFavorites: "アカウント別のローカルお気に入り", featureSession: "アカウントとログイン状態の保持", featureAvailable: "利用可能", featureRegister: "ログイン後に利用可能", featureGuestSession: "ゲスト閲覧のみ", featureMemberSession: "メールでログイン・状態の保持を選択可能",
    accountScope: "公開の作家一覧はゲストも閲覧・検索・絞り込み・共有できます。お気に入り、作家の推薦、情報の修正報告はログイン後に利用できます。お気に入りはアカウント別にこのブラウザだけに保存され、端末間では同期されません。サイトデータを消去すると失われます。", progressScope: "検索条件と閲覧位置はこのタブにのみ記憶され、送信されません。",
    memberOnlyContribution: "作家の推薦と情報の修正報告はログイン後に利用できます。", signInToContribute: "ログインして続ける",
    signInAction: "ログイン", registerAction: "アカウント作成", keepBrowsing: "閲覧を続ける", myFavorites: "お気に入り", favoritesCount: (n) => `お気に入り · ${n}`, showFavorites: "お気に入りのみ表示", allDirectory: "すべての作家を見る", favoritesEmpty: "お気に入りはまだありません。作家の詳細から「お気に入りに追加」を選んでください。", favoritesNoMatches: "条件に合うお気に入りがありません。条件を解除するか、すべての作家をご覧ください。",
    saveArtist: "お気に入りに追加", removeFavorite: "お気に入りから削除", favoriteSaved: "このブラウザに保存しました", favoriteRemoved: "お気に入りから削除しました", storageUnavailable: "ブラウザに保存できませんでした。お気に入りは変更されていません。サイトの保存を許可して再度お試しください。",
    shareSearch: "絞り込み条件を共有", shareArtist: "この作家をシェア", shareTitle: "出会いを共有する", shareLinkLabel: "共有リンク", copyLink: "リンクをコピー", copiedLink: "リンクをコピーしました", copyManually: "自動コピーできませんでした。リンクを選択して手動でコピーしてください。", shareHelp: "リンクには作家や公開の検索条件のみが含まれます。アカウント・お気に入り・閲覧履歴は含まれません。", localShareHelp: "このプレビューリンクは、このパソコンでのみ開けます。公開後は本番のアドレスを共有できます。", missingArtist: "この作家は現在の一覧にありません。他の作家を引き続きご覧いただけます。",
    favoritesScope: "このアカウント · このブラウザ", imageTitle: "長谷川等伯《松林図屏風》部分", metaDescription: "日本画作家を探すための独立インデックス。名前・学校・地域・タグから作家を探し、公開情報源を確認できます。",
    demoMemberNotice: "ローカル登録ユーザーデモ · 架空の体験アカウント · 登録・本番書き込みなし"
  }
};
Object.entries(experienceTranslations).forEach(([lang, copy]) => Object.assign(I18N.data[lang], copy));
