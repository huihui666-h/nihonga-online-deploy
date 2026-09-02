import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import school_crawler


class SchoolCrawlerTests(unittest.TestCase):
    def test_fetch_source_percent_encodes_unicode_paths(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/日本画/作品", "日本画")
        requested = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"<html></html>"

        def fake_urlopen(request, timeout):
            requested.append((request.full_url, timeout))
            return Response()

        with patch.object(school_crawler, "robots_allowed", return_value=(True, "robots-not-found")), patch.object(school_crawler, "urlopen", side_effect=fake_urlopen):
            html, status = school_crawler.fetch_source(source, 15, 1, 0)
        self.assertEqual(status, "ok")
        self.assertEqual(html, "<html></html>")
        self.assertNotIn("日本画", requested[0][0])
        self.assertIn("%E6%97%A5%E6%9C%AC%E7%94%BB", requested[0][0])

    def test_parser_supports_password_stdin_without_removing_file_option(self):
        parser = school_crawler.build_parser()
        stdin_args = parser.parse_args(["--push", "--admin-password-stdin"])
        file_args = parser.parse_args(["--push", "--admin-password-file", "secret.txt"])
        self.assertTrue(stdin_args.admin_password_stdin)
        self.assertEqual(file_args.admin_password_file, "secret.txt")

    def test_extract_students_and_excludes_alumni_by_default(self):
        text = "◇学生 博士後期課程2年 馬新風 博士後期課程1年 張雪桐 博士前期課程2年 上野愛佳・王芸霏・佐藤ひとみ・趙彧傑 博士前期課程1年 劉雨詩 学部4年 赤石萌栞・岡田愛生・川島唯佳・福井邑捺 学部3年 貴田実穂・古澤舞 研究生 周茹心・黄澤君 ◇教員 教授 中村寿生 ◇卒業生 王詩晴・黎江"
        people = school_crawler.extract_students(text)
        self.assertEqual(len(people), 15)
        self.assertEqual(people[0]["name"], "馬新風")
        self.assertEqual(people[-1]["name"], "黄澤君")
        self.assertTrue(all(person["status"] in {"student", "researcher"} for person in people))
        self.assertEqual(len(school_crawler.extract_students(text, include_alumni=True)), 17)

    def test_extract_faculty_roles(self):
        text = "◇教員 教授 中村寿生 准教授 繁村周 講師 大橋美舟 助手 曽根美咲 ◇卒業生 王詩晴"
        faculty = school_crawler.extract_faculty(text)
        self.assertEqual([person["name"] for person in faculty], ["中村寿生", "繁村周", "大橋美舟", "曽根美咲"])
        self.assertEqual([person["facultyRole"] for person in faculty], ["教授", "准教授", "講師", "助手"])

    def test_build_artist_has_stable_university_source_without_fake_handle(self):
        source = school_crawler.SchoolSource("文星芸術大学", "栃木", "https://geidai.bunsei.ac.jp/topics/260822-2/", "屏風絵展")
        artist = school_crawler.build_artist(source, {"name": "馬新風", "status": "student", "studyLevel": "博士後期課程", "studyYear": "2年"})
        self.assertEqual(artist["name"], "馬新風")
        self.assertEqual(artist["handle"], "")
        self.assertEqual(artist["linkType"], "university")
        self.assertEqual(artist["school"], "文星芸術大学")
        self.assertEqual(artist["sources"][0]["provider"], "university")
        self.assertEqual(len(artist["sources"]), 1)
        self.assertIn("/260822-2", artist["sourcePage"])
        self.assertNotIn("contact removed", artist["note"])
        self.assertTrue(artist["schoolSourceId"])

    def test_build_artist_prefers_person_source_and_keeps_roman_name(self):
        source = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/faculty", "日本画教員")
        artist = school_crawler.build_artist(source, {
            "name": "武田州左",
            "romanName": "Kunisa Takeda",
            "status": "faculty",
            "facultyRole": "教授",
            "sourcePage": "https://example.test/faculty/kunisa-takeda/",
        })
        self.assertEqual(artist["romanName"], "Kunisa Takeda")
        self.assertEqual(artist["sourcePage"], "https://example.test/faculty/kunisa-takeda")

    def test_person_name_normalization_keeps_cjk_compatibility_ideographs(self):
        self.assertEqual(school_crawler._normalize_person_name("山﨑 結以"), "山﨑結以")

    def test_build_faculty_artist_has_person_type(self):
        source = school_crawler.SchoolSource("文星芸術大学", "栃木", "https://geidai.bunsei.ac.jp/topics/260822-2/", "屏風絵展")
        artist = school_crawler.build_artist(source, {"name": "中村寿生", "status": "faculty", "studyLevel": "教授", "facultyRole": "教授"})
        self.assertEqual(artist["personType"], "faculty")
        self.assertEqual(artist["studentStatus"], "faculty")
        self.assertEqual(artist["facultyRole"], "教授")

    def test_report_filters_existing_name_and_writes_source_status(self):
        source = school_crawler.SchoolSource("文星芸術大学", "栃木", "https://example.test/bunsei", "展览")
        html = "<html><body><h1>日本画</h1><p>◇学生 学部4年 馬新風・新規学生 ◇教員 教授</p></body></html>"
        with patch.object(school_crawler, "fetch_source", return_value=(html, "ok")):
            report = school_crawler.build_report([source], [{"name": "馬新風", "handle": "@existing"}])
        self.assertEqual(report["summary"]["studentsFound"], 2)
        self.assertEqual(report["summary"]["candidates"], 1)
        self.assertEqual(report["newArtists"][0]["name"], "新規学生")
        self.assertEqual(report["sources"][0]["status"], "ok")

    def test_geidai_faculty_parser_scopes_nihonga_table(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/staff", "日本画教員", parser="geidai-nihonga-faculty")
        html = """
        <table><tr><th>研究分野・研究室</th><th>氏名</th><th>職名</th></tr>
        <tr><td>日本画 第1研究室</td><td><a href='/ueda'>植田 一穂</a></td><td>教授</td></tr>
        <tr><td>日本画 第2研究室</td><td><a href='/miyakita'>宮北 千織</a></td><td>准教授</td></tr></table>
        <table><tr><td>油画 第1研究室</td><td>別 人</td><td>教授</td></tr></table>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["植田一穂", "宮北千織"])
        self.assertEqual(people[0]["sourcePage"], "https://example.test/ueda")

    def test_geidai_latest_awards_parser_keeps_only_latest_nihonga_course(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/awards", "買上作品", include_alumni=True, parser="geidai-nihonga-latest-awards")
        html = """
        <h2>令和７年度</h2><table>
        <tr><th>所属</th><th>氏名</th><th>作品名</th></tr>
        <tr><td>美術研究科 絵画専攻 日本画研究分野</td><td>城田 崚吾</td><td>落葉</td></tr>
        <tr><td>文化財保存学専攻 保存修復研究分野 日本画</td><td>対象外</td><td>模写</td></tr>
        </table><h2>令和６年度</h2><table>
        <tr><td>美術研究科 絵画専攻 日本画研究分野</td><td>旧年度</td><td>旧作</td></tr>
        </table>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["城田崚吾"])
        self.assertEqual(people[0]["workTitle"], "落葉")

    def test_geidai_awards_history_parser_reads_all_years_and_skips_placeholders(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/awards", "歴代買上作品", include_alumni=True, parser="geidai-nihonga-awards-history")
        html = """
        <h2>令和７年度</h2><table>
        <tr><td>美術研究科 絵画専攻 日本画研究分野</td><td>城田 崚吾</td><td>落葉</td></tr>
        <tr><td>文化財保存学専攻 保存修復研究分野 日本画</td><td>保存 対象外</td><td>模写</td></tr>
        </table>
        <h2>令和６年度</h2><table>
        <tr><td>美術研究科 絵画専攻 日本画研究分野</td><td>田口 静来</td><td>光</td></tr>
        <tr><td>美術研究科 絵画専攻 日本画研究分野</td><td>１名※</td><td></td></tr>
        </table>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["城田崚吾", "田口静来"])
        self.assertEqual([person["studyYear"] for person in people], ["令和７年度", "令和６年度"])

    def test_geidai_doctoral_parser_scopes_modern_japanese_painting_items(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/2025/departments/01.html", "博士審査展", include_alumni=True, parser="geidai-doctoral-nihonga")
        html = """
        <h1>日本画<i>Japanese Painting</i></h1><ul>
        <li><a href='/2025/catalogue/japanese-painting/a.html'><div class='item_icon'>日本画<i>Japanese Painting</i></div>
        <div class='title'>信号待ち</div><div class='description'>杉本 純久<i>Sugimoto Yoshihisa</i></div></a></li>
        <li><div class='item_icon'>油画<i>Oil Painting</i></div><div class='description'>対象 外</div></li>
        </ul>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["杉本純久"])
        self.assertEqual(people[0]["romanName"], "Sugimoto Yoshihisa")
        self.assertEqual(people[0]["sourcePage"], "https://example.test/2025/catalogue/japanese-painting/a.html")

    def test_geidai_doctoral_parser_supports_legacy_category_and_detail_pages(self):
        category = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/2015/japanese-painting/", "博士審査展", include_alumni=True, parser="geidai-doctoral-nihonga")
        category_html = """
        <h2 id='title'><span>日本画</span> / Japanese Painting</h2><ul id='list'><li>
        <a href='/2015/japanese-painting/makino/'><h3 class='list-title'>鳥</h3><h4 class='list-name'>牧野 香里</h4></a>
        </li></ul>
        """
        detail = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/2017/japanese-painting/work/", "博士審査展", include_alumni=True, parser="geidai-doctoral-nihonga")
        detail_html = "<h2 class='author'>吉田 侑加</h2><div class='part'>Japanese Painting</div>"
        category_people = school_crawler.parse_school_people(category, category_html)
        detail_people = school_crawler.parse_school_people(detail, detail_html)
        self.assertEqual(category_people[0]["name"], "牧野香里")
        self.assertEqual(category_people[0]["workTitle"], "鳥")
        self.assertEqual(detail_people[0]["name"], "吉田侑加")

    def test_geidai_doctoral_parser_supports_2020_thumbnail_names(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/2020/", "博士審査展", include_alumni=True, parser="geidai-doctoral-nihonga")
        html = """
        <h3 id='japanese-painting'>日本画</h3><section><ul>
        <li><a href='/2020/work-a/'><img src='/uploads/1_岩谷晃太_作品画像1.jpg'></a></li>
        <li><a href='/2020/work-b/'><img src='/uploads/2_椎野倫奈_作品画像.jpg'></a></li>
        </ul></section>
        <h3 id='repair_japanpainting'>保存修復・日本画</h3><section><li><img src='/uploads/3_対象外_作品.jpg'></li></section>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["岩谷晃太", "椎野倫奈"])

    def test_geidai_geisai_parser_deduplicates_multiple_works_by_student(self):
        source = school_crawler.SchoolSource("東京藝術大学", "東京", "https://example.test/geisai/", "日本画学部4年展", parser="geidai-geisai-nihonga-students")
        html = """
        <meta name='Description' content='日本画専攻 4 年生による作品展です。'>
        <div class='module_title'><h3>Unryu<br>五十嵐結音Yune Igarashi</h3></div>
        <div class='module_title'><h3>Soushokuka<br>五十嵐結音Yune Igarashi</h3></div>
        <div class='module_title'><h3>上田ひかるHikaru Ueda</h3></div>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["五十嵐結音", "上田ひかる"])
        self.assertEqual(people[0]["romanName"], "Yune Igarashi")

    def test_tamabi_faculty_parser_keeps_profile_metadata(self):
        source = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/faculty/", "日本画教員", parser="tamabi-nihonga-faculty")
        html = """
        <figure class='faculty_rep'><a href='/faculty/takeda'><div class='faculty_rep_text'>
        <h4>武田州左</h4><h4>Kunisa Takeda</h4><p>教授</p></div></a></figure>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual(people[0]["name"], "武田州左")
        self.assertEqual(people[0]["romanName"], "Kunisa Takeda")
        self.assertEqual(people[0]["facultyRole"], "教授")

    def test_tamabi_student_works_parser_tracks_year_and_avoids_caption_duplicate(self):
        source = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/works/", "学生作品", parser="tamabi-nihonga-student-works")
        html = """
        <div id='first_year' class='works_box_title'><h3>1年次</h3></div>
        <figure class='works_rep'><figcaption><h4>大下明日香｜天</h4></figcaption>
        <div class='works_rep_text'><h4>大下明日香｜天</h4></div></figure>
        <div id='graduate_year' class='works_box_title'><h3>大学院</h3></div>
        <figure class='works_rep'><div class='works_rep_text'><h4>鶴田慧｜晦蝕</h4></div></figure>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["大下明日香", "鶴田慧"])
        self.assertEqual([person["studyYear"] for person in people], ["1年次", "大学院"])

    def test_musabi_faculty_parser_keeps_dedicated_and_assistant_sections(self):
        source = school_crawler.SchoolSource("武蔵野美術大学", "東京", "https://example.test/jp/faculty/", "日本画教員", parser="musabi-nihonga-faculty")
        html = """
        <section><div><h2>専任教員</h2></div><ul class='grid'>
        <li><em><span>間島秀徳</span></em><span class='small'>教授（主任）<br>日本画<a href='/majima'>プロフィール</a></span></li>
        </ul></section>
        <section><h3>客員教授</h3><ul class='grid'><li><span>対象外</span></li></ul></section>
        <section><h3>助手</h3><ul class='grid'><li><span>加藤まみ</span></li></ul></section>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["間島秀徳", "加藤まみ"])
        self.assertEqual(people[0]["facultyRole"], "教授（主任）")

    def test_musabi_selected_parser_stays_inside_japanese_painting(self):
        source = school_crawler.SchoolSource("武蔵野美術大学", "東京", "https://example.test/y2025/jp", "優秀作品", include_alumni=True, parser="musabi-selected-nihonga")
        html = """
        <div id='jp' class='work jp'><ul class='works-list'><li><a href='/y2025/jp/s01'><h3 class='title'>青田有</h3></a></li></ul></div>
        <div id='pa' class='work pa'><ul class='works-list'><li><h3 class='title'>油画対象外</h3></li></ul></div>
        """
        people = school_crawler.parse_school_people(source, html)
        self.assertEqual([person["name"] for person in people], ["青田有"])
        self.assertEqual(people[0]["sourcePage"], "https://example.test/y2025/jp/s01")

    def test_report_deduplicates_same_name_across_sources_and_keeps_faculty_first(self):
        faculty = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/faculty", "教員")
        students = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/students", "学生")
        pages = [
            "<p>◇教員 副手 鶴田慧 ◇卒業生</p>",
            "<p>◇学生 博士前期課程2年 鶴田慧 ◇教員 教授</p>",
        ]
        with patch.object(school_crawler, "fetch_source", side_effect=[(pages[0], "ok"), (pages[1], "ok")]):
            report = school_crawler.build_report([faculty, students], [])
        self.assertEqual(len(report["newArtists"]), 1)
        self.assertEqual(report["newArtists"][0]["personType"], "faculty")
        self.assertEqual(report["duplicates"][0]["reason"], "current-run-name")

    def test_report_does_not_treat_shared_school_page_as_person_identity(self):
        source = school_crawler.SchoolSource("多摩美術大学", "東京", "https://example.test/students", "学生")
        html = "<p>◇学生 学部1年 新規学生 ◇教員 教授</p>"
        existing = [{"name": "既存学生", "school": "多摩美術大学", "sourcePage": source.url, "linkType": "university"}]
        with patch.object(school_crawler, "fetch_source", return_value=(html, "ok")):
            report = school_crawler.build_report([source], existing)
        self.assertEqual([artist["name"] for artist in report["newArtists"]], ["新規学生"])


if __name__ == "__main__":
    unittest.main()
