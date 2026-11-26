"""Exercise the production build against actual OOXML files in Windows Edge."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

from docx import Document
from playwright.sync_api import expect, sync_playwright

import fixtures


def create_inputs(path):
    fixtures.generate(path)
    original = path / "original.docx"
    revised = original.with_name("reviewed.docx")
    second = path / "second.docx"
    doc = Document(revised)
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            if "降低" in run.text:
                run.text = run.text.replace("降低", "减少")
    doc.save(second)
    markdown = path / "changes.md"
    markdown.write_text(
        """# 修改说明

## 修改 01
- **修改前：** 该系统能够完全避免数据丢失。
- **修改后：** 该系统能够降低数据丢失的风险。
- **原因：** 原表述过于绝对。

## 修改 02
原因：此记录只有说明，需要人工核对位置。

## 修改 03
修改前：这是文档中不存在的文字。
修改后：没有现成的对应位置。
原因：应保持未匹配。
""",
        encoding="utf-8",
    )
    word_notes = path / "round-two-notes.docx"
    doc = Document()
    doc.add_heading("修改说明", 1)
    table = doc.add_table(rows=2, cols=4)
    for cell, value in zip(table.rows[0].cells, ["编号", "修改前", "修改后", "修改原因"]):
        cell.text = value
    for cell, value in zip(table.rows[1].cells, ["A-7", "降低", "减少", "改用统一术语。"]):
        cell.text = value
    doc.save(word_notes)
    txt_notes = path / "third-notes.txt"
    txt_notes.write_bytes("记录编号：9\r\n修改前：完全避免\r\n修改后：减少\r\n理由：统一术语并弱化承诺。".encode("gb18030"))
    return original, revised, second, markdown, word_notes, txt_notes


def text_coords(page, quote, side):
    paragraph = page.locator(f"#{side} p:visible, #{side} h1:visible").filter(has_text=quote).first
    paragraph.scroll_into_view_if_needed()
    return paragraph.evaluate(
        """(block, quote) => {
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const offset = node.data.indexOf(quote);
            if (offset < 0 || !node.parentElement.getClientRects().length) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + quote.length);
            const rect = range.getClientRects()[0];
            return [rect.left + 1, rect.right - 1, (rect.top + rect.bottom) / 2];
          }
          throw new Error('Could not select ' + quote);
        }""",
        quote,
    )


def drag_text(page, quote, side="right", through=None):
    x0, x1, y = text_coords(page, quote, side)
    end_y = y
    if through:
        _, x1, end_y = text_coords(page, through, side)
    page.mouse.move(x0, y)
    page.mouse.down()
    page.mouse.move(x1, end_y, steps=10)
    page.mouse.up()


def select_text(page, quote, side="right"):
    drag_text(page, quote, side)
    expect(page.locator("#comment-dialog")).to_be_visible()


def annotation(page, quote, comment, suggestion="", confirmed=False):
    select_text(page, quote)
    expect(page.locator("#quote")).to_have_text(quote)
    page.locator("#comment-text").fill(comment)
    page.locator("#comment-suggestion").fill(suggestion)
    if confirmed:
        page.locator("#comment-status").select_option("confirmed")
    page.locator("#comment-text").press("Control+Enter")
    expect(page.locator("#comment-dialog")).not_to_be_visible()


def wait_status(page, text):
    timeout = 135000 if page.url.startswith("https://") else 60000
    expect(page.locator("#status")).to_contain_text(text, timeout=timeout)


def import_round(page, edited, notes=None, original=None, original_base=False):
    if original:
        page.locator("#left-file").set_input_files(original)
        page.locator("#project-name").fill("恢复流程复核")
    else:
        page.locator("#new-round").click()
        if original_base:
            page.locator("#base-select").select_option("original")
        else:
            assert page.locator("#base-select").input_value() != "original"
    page.locator("#right-file").set_input_files(edited)
    if notes:
        page.locator("#notes-file").set_input_files(notes)
    page.locator("#compare").click()
    if notes:
        page.locator("#preview-apply").click(timeout=60000)
    wait_status(page, "已比较并保存")


def exercise(p, url, folder):
    original, revised, second, markdown, word_notes, txt_notes = create_inputs(folder)
    profile = folder / "edge"
    context = p.chromium.launch_persistent_context(str(profile), channel="msedge",
        viewport={"width": 1600, "height": 1050}, permissions=["clipboard-read", "clipboard-write"])
    page = context.pages[0]
    errors, remote = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: remote.append(request.url) if request.url.startswith("http") and not request.url.startswith(url) else None)
    page.goto(url)
    import_round(page, revised, markdown, original)
    details = page.locator("#details")
    toggle = page.get_by_role("button", name="显示修改记录")
    expect(details).to_be_hidden()
    page.locator("#next").click()
    expect(page.locator("#jump")).to_have_value("1")
    expect(details).to_be_hidden()
    for side, tag, phrase in [("left", "del", "完全避免"), ("right", "ins", "降低")]:
        mark = page.locator(f"#{side} {tag}[data-change-id]:visible").filter(has_text=phrase)
        mark.scroll_into_view_if_needed()
        host = page.locator("#" + side)
        offset = host.evaluate("(el) => el.scrollTop")
        mark.click()
        expect(page.locator("#jump")).to_have_value("1")
        assert host.evaluate("(el) => el.scrollTop") == offset
        expect(details).to_be_hidden()
    page.locator("#prev").click()
    expect(page.locator("#jump")).to_have_value("0")
    expect(details).to_be_hidden()
    expect(page.locator("#change")).to_contain_text("原表述过于绝对")
    expect(page.locator("#change")).to_contain_text("自动匹配")
    card = page.locator("#hover-reasons")
    mode = page.locator("#annotation-mode")
    changed = page.locator("#left p:visible").filter(has_text="完全避免").first
    changed.hover()
    expect(card).to_contain_text("原表述过于绝对。")
    expect(card).to_contain_text("高可信度")
    rect = changed.bounding_box()
    box = card.bounding_box()
    assert (box["y"] + box["height"] <= rect["y"] or box["y"] >= rect["y"] + rect["height"] or
            box["x"] + box["width"] <= rect["x"] or box["x"] >= rect["x"] + rect["width"])
    card.hover()
    expect(card).to_be_visible()
    page.locator("#right p:visible").filter(has_text="请阅最新的复核记录。").first.hover()
    expect(card).to_be_hidden()
    drag_text(page, "降低")
    expect(card).to_be_hidden()
    expect(page.locator("#comment-dialog")).to_be_hidden()
    mode.focus()
    page.keyboard.press("Control+Alt+m")
    expect(mode).to_have_attribute("aria-pressed", "true")
    changed.hover()
    expect(card).to_be_hidden()
    select_text(page, "降低", "right")
    expect(page.locator("#comment-dialog")).to_have_class("document-popover anchored-editor")
    expect(page.locator("#quote")).to_have_text("降低")
    page.get_by_role("button", name="语法错误", exact=True).click()
    expect(page.locator("#comment-text")).to_have_value("语法错误")
    page.keyboard.press("Escape")
    expect(page.locator("#comment-dialog")).to_be_hidden()
    drag_text(page, "降低", through="算法验证通过。")
    expect(page.locator("#quote")).to_contain_text("算法验证通过。")
    page.locator("#cancel").click()
    mode.click()
    expect(mode).to_have_attribute("aria-pressed", "false")
    expect(page.locator("#right td[colspan='2']")).to_contain_text("以上结果")
    for side, tag, phrase, selected_bg, paragraph_class, whole_phrase, paragraph_bg in [
        ("left", "del", "完全避免", "rgb(246, 218, 218)", "not-in-edited", "待废弃说明。", "rgb(252, 232, 232)"),
        ("right", "ins", "降低", "rgb(212, 234, 219)", "not-in-original", "补充验证记录。", "rgb(229, 243, 233)"),
    ]:
        change = page.locator(f"#{side} {tag}[data-change-id]:visible").filter(has_text=phrase)
        expect(change).to_have_css("background-color", selected_bg)
        expect(change).to_have_css("text-decoration-line", "none")
        expect(change.locator("span").filter(has_text=phrase)).to_have_css("background-color", "rgba(0, 0, 0, 0)")
        whole = page.locator(f"#{side} p.{paragraph_class}:visible").filter(has_text=whole_phrase)
        expect(whole).to_have_css("background-color", paragraph_bg)
        expect(whole.locator("span").filter(has_text=whole_phrase)).to_have_css("background-color", "rgba(0, 0, 0, 0)")
        unchanged = page.locator(f"#{side} p:visible").filter(has_text="请阅最新的复核记录。")
        expect(unchanged).to_have_css("background-color", "rgba(0, 0, 0, 0)")
        expect(unchanged.locator("ins, del")).to_have_count(0)
    toggle.click()
    expect(details).to_be_visible()
    expect(page.get_by_role("button", name="隐藏修改记录")).to_have_attribute("aria-expanded", "true")
    page.get_by_role("button", name="隐藏修改记录").click()
    expect(details).to_be_hidden()
    toggle.click()
    page.locator("#notes-details > summary").click()
    list_ = page.locator("#note-list")
    expect(list_).to_contain_text("记录 01")
    expect(list_).to_contain_text("记录 02")
    expect(list_.locator(".note-item").filter(has_text="记录 03")).to_contain_text("未匹配")
    note = list_.locator(".note-item").filter(has_text="记录 02")
    page.locator("#jump").select_option("3")
    expect(page.locator("#change")).to_contain_text("未关联修改说明")
    note.get_by_role("button", name="关联到当前修改 4").click()
    expect(page.locator("#change")).to_contain_text("此记录只有说明")
    expect(page.locator("#change")).to_contain_text("人工匹配")
    note.get_by_role("button", name="解除关联").click()
    expect(page.locator("#change")).to_contain_text("未关联修改说明")
    page.locator("#jump").select_option("0")
    expect(page.locator("#change")).to_contain_text("自动匹配")
    note.get_by_role("button", name="关联到当前修改 1").click()
    expect(page.locator("#change")).to_contain_text("此记录只有说明")
    page.locator("#right p:visible").filter(has_text="降低").first.hover()
    expect(card.locator("article")).to_have_count(2)
    expect(card).to_contain_text("原表述过于绝对")
    expect(card).to_contain_text("此记录只有说明")
    expect(card).to_contain_text("人工确认")
    note.get_by_role("button", name="解除关联").click()
    expect(page.locator("#change")).not_to_contain_text("此记录只有说明")
    page.locator("#change").get_by_role("button", name="解除关联").click()
    expect(page.locator("#change")).to_contain_text("未关联修改说明")
    page.reload()
    wait_status(page, "已恢复")
    expect(details).to_be_hidden()
    toggle.click()
    expect(page.locator("#change")).to_contain_text("未关联修改说明")
    if not page.locator("#notes-details").evaluate("(node) => node.open"):
        page.locator("#notes-details > summary").click()
    list_.locator(".note-item").filter(has_text="记录 01").get_by_role("button", name="关联到当前修改 1").click()
    expect(page.locator("#change")).to_contain_text("人工匹配")

    mode.click()
    annotation(page, "降低", "请核对恢复范围。", "建议说明实际验证范围。")
    annotation(page, "请阅最新的复核记录。", "核对归档链接。")
    annotation(page, "验证恢复", "此处表述已经确认。", confirmed=True)
    expect(page.locator("#comment-count")).to_have_text("人工批注（3）")
    page.locator("#comment-filter").select_option("confirmed")
    expect(page.locator("#comments")).to_contain_text("此处表述已经确认")
    expect(page.locator("#comments")).not_to_contain_text("请核对恢复范围")
    page.locator("#comment-filter").select_option("all")
    drag_text(page, "降低")
    page.locator("#reason-search").fill("恢复范围")
    expect(page.get_by_role("button", name="请核对恢复范围。", exact=True)).to_have_count(1)
    page.get_by_role("button", name="请核对恢复范围。", exact=True).click()
    expect(page.locator("#comment-text")).to_have_value("请核对恢复范围。")
    page.keyboard.press("Escape")
    page.locator("#feedback").click()
    checks = page.locator("#feedback-list input")
    expect(checks).to_have_count(2)
    checks.nth(1).uncheck()
    markdown_text = page.locator("#feedback-preview").input_value()
    assert all(value in markdown_text for value in ["R1-A001", "恢复目标", "原表述过于绝对",
        "完全避免数据丢失", "降低数据丢失", "建议说明实际验证范围"])
    assert "核对归档链接" not in markdown_text and "此处表述已经确认" not in markdown_text
    page.locator("#feedback-copy").click()
    expect(page.locator("#feedback-status")).to_contain_text("已复制全部反馈")
    assert page.evaluate("navigator.clipboard.readText()").replace("\r\n", "\n") == markdown_text
    with page.expect_download() as down:
        page.locator("#feedback-export").click()
    assert Path(down.value.path()).read_text(encoding="utf-8") == markdown_text
    page.locator("#feedback-close").click()

    import_round(page, second, word_notes)
    expect(page.locator("#left-name")).to_have_text(revised.name)
    expect(page.locator("#comment-count")).to_have_text("人工批注（2）")
    expect(page.locator("#change")).to_contain_text("改用统一术语")
    unresolved = page.locator("#comments .item").filter(has_text="请核对恢复范围")
    expect(unresolved).to_contain_text("待重新定位")
    expect(page.locator("#comments .item").filter(has_text="核对归档链接")).not_to_contain_text("待重新定位")
    unresolved.get_by_role("button", name="重新定位").click()
    select_text(page, "减少")
    page.locator("#comment-save").click()
    wait_status(page, "批注已保存")
    expect(unresolved).not_to_contain_text("待重新定位")
    expect(unresolved).to_contain_text("减少")
    unresolved.get_by_role("button", name="确认已处理").click()
    expect(unresolved).to_contain_text("已确认")
    page.locator("#history").click()
    expect(page.locator("#round-list")).to_contain_text("反馈 1 份")
    page.locator("#round-list").get_by_role("button", name="查看反馈 1").click()
    expect(page.locator("#feedback-dialog")).to_be_visible(timeout=60000)
    assert page.locator("#feedback-preview").input_value() == markdown_text
    page.locator("#feedback-close").click()
    expect(page.locator("#comment-count")).to_have_text("人工批注（3）")

    import_round(page, second, txt_notes, original_base=True)
    expect(page.locator("#left-name")).to_have_text(original.name)
    expect(page.locator("#project-summary")).to_contain_text("第 3 / 3 轮")
    expect(page.locator("#change")).to_contain_text("统一术语并弱化承诺")
    page.locator("#history").click()
    with page.expect_download() as backup_download:
        page.locator("#backup").click()
    backup = folder / "project.zip"
    backup_download.value.save_as(backup)
    with ZipFile(backup) as bundle:
        document_hash = sha256(original.read_bytes()).hexdigest()
        assert bundle.read("files/" + document_hash) == original.read_bytes()
        saved = json.loads(bundle.read("project.json"))["project"]
        assert saved["original"]["hash"] == document_hash and len(saved["rounds"]) == 3
        assert saved["rounds"][0]["feedback"][0]["markdown"] == markdown_text
        assert len(saved["rounds"][0]["annotations"]) == 3
        assert saved["rounds"][1]["annotations"][0]["status"] == "confirmed"
        assert saved["rounds"][1]["baseRoundId"] == saved["rounds"][0]["id"]
        assert saved["rounds"][2]["baseRoundId"] is None
        assert len(bundle.namelist()) == 7
        legacy_note = {key: saved["rounds"][0]["annotations"][0][key] for key in
            ("id", "anchor", "side", "start", "end", "quote", "paragraph", "changeId", "createdAt", "comment", "status")}
    context.close()

    reopened = p.chromium.launch_persistent_context(str(profile), channel="msedge", viewport={"width": 1600, "height": 1050})
    page = reopened.pages[0]
    page.goto(url)
    wait_status(page, "已恢复")
    page.get_by_role("button", name="显示修改记录").click()
    expect(page.locator("#project-summary")).to_contain_text("第 3 / 3 轮")
    page.locator("#history").click()
    page.locator("#restore-file").set_input_files(backup)
    wait_status(page, "已恢复备份")
    expect(page.locator("#project-summary")).to_contain_text("恢复流程复核（恢复）")
    expect(page.locator("#project-select option")).to_have_count(3)
    page.locator("#history").click()
    page.get_by_role("button", name="打开第 2 轮").click()
    wait_status(page, "已恢复")
    expect(page.locator("#change")).to_contain_text("改用统一术语")
    expect(page.locator("#comments")).to_contain_text("已确认")
    assert page.evaluate("CSS.highlights.get('review-annotations').size") == 2
    page.locator("#history").click()
    page.locator("#restore-file").set_input_files({"name": "bad.zip", "mimeType": "application/zip", "buffer": b"invalid"})
    wait_status(page, "恢复备份失败")
    expect(page.locator("#comment-count")).to_have_text("人工批注（2）")
    page.locator("#new-round").click()
    page.locator("#right-file").set_input_files({"name": "bad.docx", "mimeType": "application/octet-stream", "buffer": b"invalid"})
    page.locator("#compare").click()
    wait_status(page, "比较失败")
    expect(page.locator("#project-summary")).to_contain_text("第 2 / 3 轮")
    expect(page.locator("#comment-count")).to_have_text("人工批注（2）")
    page.locator("#cancel-import").click()
    page.locator("#notes-update-file").set_input_files(txt_notes)
    page.locator("#preview-apply").click()
    wait_status(page, "已导入修改说明")
    expect(page.locator("#change")).to_contain_text("未关联修改说明")
    expect(page.locator("#comment-count")).to_have_text("人工批注（2）")
    assert not errors, errors
    assert not remote, remote
    reopened.close()

    browser = p.chromium.launch(channel="msedge")
    legacy = browser.new_page(viewport={"width": 1600, "height": 1050})
    legacy.goto(url)
    legacy.locator("#left-file").set_input_files(original)
    legacy.locator("#right-file").set_input_files(revised)
    legacy.locator("#notes-file").set_input_files(markdown)
    legacy.evaluate("""async annotation => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('docx-review-engine-prototype');
        request.onupgradeneeded = () => request.result.createObjectStore('review');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const get = id => document.querySelector(id).files[0];
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('review', 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore('review').put({
          original: get('#left-file'), edited: get('#right-file'), notes: get('#notes-file'),
          annotations: [annotation]
        }, 'current');
      });
      db.close();
    }""", legacy_note)
    legacy.reload()
    wait_status(legacy, "已比较并保存")
    expect(legacy.locator("#comments")).to_contain_text("请核对恢复范围")
    assert legacy.evaluate("CSS.highlights.get('review-annotations').size") == 1
    legacy.locator("#annotation-mode").click()
    select_text(legacy, "降低")
    legacy.locator("#reason-search").fill("恢复范围")
    expect(legacy.get_by_role("button", name="请核对恢复范围。", exact=True)).to_be_visible()
    legacy.keyboard.press("Escape")
    legacy.reload()
    wait_status(legacy, "已恢复")
    expect(legacy.locator("#project-select option")).to_have_count(2)
    browser.close()
    print("PASS: notes, clipboard/export, 3 rounds, re-anchoring, browser restart, ZIP restore and legacy migration.")


def real_sample(p, url, samples):
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page(viewport={"width": 1600, "height": 1050})
    page.goto(url)
    import_round(page, samples / "aramlo-part-2-2025-05-06.edited-until-p257.docx",
        original=samples / "aramlo-part-2-2025-05-06.docx")
    wait_status(page, "598 处修改")
    common_text = []
    for side in ["left", "right"]:
        common = page.locator(f"#{side} .change-common:visible")
        assert common.count() > 0
        common_text.append(common.evaluate_all("""(nodes) => {
            const result = {};
            for (const element of nodes) {
                const id = element.dataset.changeId;
                if (element.dataset.commonNeeds !== '' || getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)') {
                    throw new Error('Common text must match exactly and have no revision background');
                }
                result[id] = (result[id] || '') + element.textContent;
            }
            return result;
        }"""))
        # A formatting marker can share a block with a whole-paragraph insertion or deletion.
        # Such blocks retain the whole-paragraph background.
        whole_class = "not-in-edited" if side == "left" else "not-in-original"
        formatting = page.locator(f"#{side} .change-as-formatting:not(.{whole_class}):visible")
        assert formatting.count() > 0
        assert formatting.evaluate_all("""(nodes) => nodes.every(el =>
            !['rgb(252, 232, 232)', 'rgb(229, 243, 233)'].includes(getComputedStyle(el).backgroundColor)
        )""")
        whole_bg = "rgb(252, 232, 232)" if side == "left" else "rgb(229, 243, 233)"
        overlapping = page.locator(f"#{side} .change-as-formatting.{whole_class}:visible")
        assert overlapping.count() > 0
        assert overlapping.evaluate_all("(nodes, color) => nodes.every(el => getComputedStyle(el).backgroundColor === color)", whole_bg)
    assert common_text[0] == common_text[1], common_text
    page.locator("#jump").select_option(index=50)
    assert page.locator("#left").evaluate("(el) => el.scrollTop") > 0
    def wait_scroll(matches):
        for _ in range(30):
            if matches(page.locator("#right").evaluate("(el) => el.scrollTop")):
                return
            page.wait_for_timeout(50)
        raise AssertionError("Right panel did not follow the left panel")

    page.locator("#left").evaluate("(el) => { el.scrollTop = 0 }")
    wait_scroll(lambda position: position == 0)
    page.locator("#left").evaluate("(el) => { el.scrollTop = el.scrollHeight * .3 }")
    wait_scroll(lambda position: position > 0)
    browser.close()
    print("PASS: actual upstream DOCX pair, 598 changes and synchronized navigation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4177/")
    parser.add_argument("--samples", type=Path, help="docx-diff docs directory containing the upstream sample pair")
    args = parser.parse_args()
    with TemporaryDirectory() as folder, sync_playwright() as p:
        exercise(p, args.url, Path(folder))
        if args.samples:
            real_sample(p, args.url, args.samples.resolve())
