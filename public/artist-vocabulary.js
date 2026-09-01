/* Display/search aliases only. Original names, field values and IDs are preserved. */
(function (root) {
  const entries = {
    "東京": ["东京", "Tokyo"], "京都": ["京都", "Kyoto"], "大阪": ["大阪", "Osaka"],
    "石川": ["石川", "Ishikawa"], "山形": ["山形", "Yamagata"], "愛知": ["爱知", "Aichi"],
    "滋賀": ["滋贺", "Shiga"], "栃木": ["栃木", "Tochigi"], "福岡": ["福冈", "Fukuoka"],
    "広島": ["广岛", "Hiroshima"], "島根": ["岛根", "Shimane"], "埼玉": ["埼玉", "Saitama"],
    "東京藝術大学": ["东京艺术大学", "Tokyo University of the Arts", "东京艺大", "東京芸大", "Geidai"],
    "多摩美術大学": ["多摩美术大学", "Tama Art University", "多摩美"],
    "武蔵野美術大学": ["武藏野美术大学", "Musashino Art University", "武藏美", "武蔵美"],
    "女子美術大学": ["女子美术大学", "Joshibi University of Art and Design", "女子美"],
    "京都芸術大学": ["京都艺术大学", "Kyoto University of the Arts"],
    "京都市立芸術大学": ["京都市立艺术大学", "Kyoto City University of Arts"],
    "東京造形大学": ["东京造形大学", "Tokyo Zokei University"],
    "東京学芸大学": ["东京学艺大学", "Tokyo Gakugei University"],
    "金沢美術工芸大学": ["金泽美术工艺大学", "Kanazawa College of Art"],
    "東北芸術工科大学": ["东北艺术工科大学", "Tohoku University of Art and Design"],
    "愛知県立芸術大学": ["爱知县立艺术大学", "Aichi University of the Arts"],
    "大阪芸術大学": ["大阪艺术大学", "Osaka University of Arts"],
    "日本大学芸術学部": ["日本大学艺术学部", "Nihon University College of Art"],
    "京都精華大学": ["京都精华大学", "Kyoto Seika University"],
    "広島市立大学": ["广岛市立大学", "Hiroshima City University"],
    "日本画": ["日本画", "Nihonga"], "日本画家": ["日本画家", "Nihonga artist"],
    "絵画": ["绘画", "Painting"], "人物": ["人物", "Figures"], "動物": ["动物", "Animals"],
    "花鳥": ["花鸟", "Birds and flowers"], "植物": ["植物", "Plants"], "風景": ["风景", "Landscapes"],
    "幻想": ["幻想", "Fantasy"], "抽象": ["抽象", "Abstract"], "中国/華人": ["中国／华人", "Chinese artists"],
    "女性作家": ["女性艺术家", "Women artists"], "若手作家": ["青年艺术家", "Young artists"],
    "現代日本画": ["当代日本画", "Contemporary Nihonga"], "近代日本画": ["近代日本画", "Modern Nihonga"],
    "学生": ["学生", "Student"], "在学": ["在读", "Currently studying"], "修士": ["硕士", "Master’s degree"],
    "博士": ["博士", "Doctorate"], "教授": ["教授", "Professor"], "卒業": ["毕业", "Graduate"],
    "卒展": ["毕业展", "Graduation exhibition"], "卒業制作展": ["毕业作品展", "Graduation exhibition"],
    "修了展": ["结业展", "Completion exhibition"], "修士課程": ["硕士课程", "Master’s program"],
    "博士課程": ["博士课程", "Doctoral program"], "博士後期課程": ["博士后期课程", "Doctoral program"],
    "日本画科": ["日本画专业", "Nihonga department"], "保存修復": ["保护修复", "Conservation and restoration"],
    "絵本": ["绘本", "Picture books"], "美人画": ["美人画", "Bijin-ga"]
  };
  const entry = (value) => Object.prototype.hasOwnProperty.call(entries, value) ? entries[value] : [];
  const values = (value) => [value, ...entry(value)];
  const label = (value, lang) => entry(value)[{ zh: 0, en: 1 }[lang]] || value;
  const searchTerms = (artist) => [artist.region, artist.school, ...(Array.isArray(artist.styles) ? artist.styles : []), ...(Array.isArray(artist.tags) ? artist.tags : [])].filter((value) => typeof value === "string").flatMap(values);
  const api = { label, searchTerms };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ArtistVocabulary = Object.freeze(api);
})(typeof window !== "undefined" ? window : this);
