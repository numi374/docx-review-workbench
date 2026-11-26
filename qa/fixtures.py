from pathlib import Path

from docx import Document
from docx.enum.text import WD_COLOR_INDEX

ROOT = Path(__file__).parent


def create(revised, directory=ROOT):
    doc = Document()
    doc.sections[0].header.paragraphs[0].text = "质量审核部"
    doc.add_heading("数据备份与恢复", 0)
    doc.add_heading("恢复目标", 1)
    paragraph = doc.add_paragraph("该系统")
    wording = paragraph.add_run("能够降低" if revised else "能够完全避免")
    wording.bold = True
    wording.font.highlight_color = WD_COLOR_INDEX.WHITE
    paragraph.add_run("数据丢失")
    paragraph.add_run("的风险。" if revised else "。")
    paragraph.add_run(" SLA 99.9%").italic = True
    if not revised:
        doc.add_comment(wording, text="请核对恢复目标。", author="质量审核", initials="QA")
    if revised:
        doc.add_paragraph("算法验证通过。")
        doc.add_paragraph("报告须归档。")
    else:
        doc.add_paragraph("算法验证通过。报告须归档。")
    doc.add_paragraph()
    doc.add_heading("复核步骤", 2)
    doc.add_paragraph("执行备份", "List Number")
    doc.add_paragraph("验证恢复", "List Bullet")
    table = doc.add_table(rows=3, cols=2)
    table.style = "Table Grid"
    table.cell(0, 0).text = "项目"
    table.cell(0, 1).text = "时长"
    table.cell(1, 0).text = "恢复时间"
    table.cell(1, 1).text = "12 小时" if revised else "24 小时"
    table.cell(2, 0).merge(table.cell(2, 1)).text = "以上结果适用于测试环境。"
    changed_paragraph = doc.add_paragraph()
    changed_paragraph.add_run("补充验证记录。" if revised else "待废弃说明。").font.highlight_color = WD_COLOR_INDEX.WHITE
    doc.add_paragraph("请阅最新的复核记录。")
    doc.save(directory / ("reviewed.docx" if revised else "original.docx"))


def generate(directory=ROOT):
    create(False, directory)
    create(True, directory)
    notes = Document()
    notes.add_heading("修改说明", 1)
    notes.add_paragraph("原因：原表述过于绝对。")
    notes.save(directory / "notes.docx")


if __name__ == "__main__":
    generate()
