import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import school_crawler


class SchoolCrawlerTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
