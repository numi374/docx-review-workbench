"""File-level ground truth for change-log ingestion. Runs through the production Edge UI."""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

from docx import Document
from playwright.sync_api import sync_playwright, expect

from workbench import create_inputs, wait_status


def make_docs(folder):
    original, revised, *_ = create_inputs(folder)
    for path, changed in [(original, False), (revised, True)]:
        doc = Document(path)
        for heading in ["第一章 控制规则", "第二章 归档规则"]:
            doc.add_heading(heading, 1)
            doc.add_paragraph("复核期限为五天。" if changed else "复核期限为三天。")
        doc.add_heading("附件 保管办法", 1)
        if changed:
            doc.add_paragraph("归档应登记。取回应签字。")
        else:
            doc.add_paragraph("归档应登记。")
            doc.add_paragraph("取回应签字。")
        doc.add_paragraph("保存审计记录。")
        doc.add_paragraph("乙类凭证必须加盖公章。" if changed else "甲类资料均由专人封存。")
        doc.add_paragraph("登记编号 YELLOW。" if changed else "登记编号 BLUE。")
        doc.add_paragraph("流转标识 GREEN。" if changed else "流转标识 BLACK。")
        if not changed:
            doc.add_paragraph("即将撤销的条款。")
        doc.add_paragraph("所有附件应复核。")
        if changed:
            doc.add_paragraph("另附电子收据。")
        doc.save(path)
    return original, revised


def files(folder):
    inputs = []
    def txt(name, body, expected):
        file = folder / name
        file.write_text(body, encoding="utf-8")
        inputs.append((file,expected))
    txt("规范.md", """# 修改说明
## CHG-001
**原文：** 该系统能够完全避免数据丢失。
**修改后：** 该系统能够降低数据丢失的风险。
**修改原因：** 限定承诺范围。
## 修改2
Before: 甲类资料均由专人封存。
After: 乙类凭证必须加盖公章。
Reason: 替换旧条款。
""", ["scope","rewrite"])
    txt("自然语言.txt", """将「BLUE」改为「YELLOW」，因为编号已经更新。

将“BLACK”替换为“GREEN”，原因是流程调整。

本轮调整了整体行文风格，建议结合业务依据复核。""", ["blue","black",None])
    doc = Document()
    doc.add_heading("修改说明",1)
    table = doc.add_table(rows=3,cols=4)
    for row, values in zip(table.rows, [
        ["序号","修改前内容","修改稿","调整说明"],["001","24","12","统一指标"],
        ["002","即将撤销的条款。","无","旧条款失效"]]):
        for cell,v in zip(row.cells,values):
            cell.text = v
    file = folder/"表格.docx"
    doc.save(file)
    inputs.append((file, ["time","delete"]))
    txt("别名.md", """001
修改前内容：BLUE
修改稿：YELLOW
修改依据：更新编号
---
## 流转颜色
修订前：BLACK
修订内容：GREEN
调整说明：统一用色
""", ["blue","black"])
    txt("缺少引文.txt", """修改1
修改后：YELLOW
原因：核实编号
修改2
章节：第二章
原因：核实规则
修改3
原因：后续由业务人员确认。
修改4
原文：无
二校稿：另附电子收据。
理由：附加材料
""", [None,None,None,"insert"])
    txt("重复句.md", """| 编号 | 位置 | Before | After | Reason |
| --- | --- | --- | --- | --- |
| CHG-1 | | 复核期限为三天。 | 复核期限为五天。 | 调整时限 |
| CHG-2 | 第二章 | 复核期限为三天。 | 复核期限为五天。 | 验证归档时限 |
| 不齐的行 | 缺列 |
| CHG-3 | 第九章 | 复核期限为三天。 | 复核期限为五天。 | 存在矛盾 |
""", [None,"duplicate2",None,None])
    txt("拆分合并.md", """## 拆分验证步骤
原文：算法验证通过。报告须归档。
修改后：算法验证通过。
报告须归档。
修改原因：分段列示。
## 合并保管要求
原文：归档应登记。
取回应签字。
修改后：归档应登记。取回应签字。
修改依据：合并短段。
## 连续两项更新
原文：登记编号 BLUE。
流转标识 BLACK。
修改后：登记编号 YELLOW。
流转标识 GREEN。
原因：更新附件约定。
""", ["split","merge","blue_black"])
    return inputs


def run(url,folder,inspect):
    original,revised = make_docs(folder)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width":1600,"height":1000})
        page.goto(url)
        page.locator("#left-file").set_input_files(original)
        page.locator("#right-file").set_input_files(revised)
        page.locator("#compare").click()
        wait_status(page,"已比较并保存")
        if inspect:
            print(list(enumerate(page.locator("#jump option").all_text_contents(),1)))
        for file, expected in files(folder):
            page.locator("#notes-update-file").set_input_files(file)
            panel = page.locator("#notes-preview")
            try:
                expect(panel).to_be_visible(timeout=12000)
            except AssertionError:
                print(file.name,page.locator("#status").inner_text(),flush=True)
                raise
            rows = panel.locator(".preview-note")
            actual = rows.evaluate_all("(rows) => rows.map((r) => [r.dataset.confidence,r.dataset.targets])")
            print(file.name,actual,flush=True)
            assert len(actual) == len(expected), (file.name, actual)
            if not inspect:
                for (confidence, targets), goal in zip(actual,expected):
                    assert targets == GOLD.get(goal,""), (file.name, goal, confidence, targets)
            page.locator("#preview-cancel").click()
            wait_status(page,"已取消导入")
            expect(page.locator("#compare")).to_be_enabled()
        browser.close()

GOLD = {"scope":"1,2", "split":"3", "time":"4", "duplicate2":"8", "merge":"9",
        "rewrite":"10,11", "blue":"12", "black":"13", "blue_black":"12,13",
        "delete":"14", "insert":"15"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4177/")
    parser.add_argument("--inspect",action="store_true")
    args = parser.parse_args()
    with TemporaryDirectory() as folder:
        run(args.url,Path(folder),args.inspect)

