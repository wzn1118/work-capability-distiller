from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader


PDF = Path("output/pdf/AI策略产品经理_大模型Agent_160问_含SystemPrompt_可导航面试题库.pdf")


def main():
    reader = PdfReader(str(PDF))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    direct_blocks = re.findall(r"直接回答\s+(.*?)(?=\n\s*追问准备)", text, re.S)
    lengths = [len(re.sub(r"\s", "", block)) for block in direct_blocks]

    stack = list(reader.outline)
    flat = []
    while stack:
        item = stack.pop(0)
        if isinstance(item, list):
            stack = item + stack
        else:
            flat.append(item)

    question_bookmarks = [item for item in flat if getattr(item, "title", "").startswith("Q")]
    link_annotations = sum(
        sum(1 for ref in page.get("/Annots", []) if ref.get_object().get("/Subtype") == "/Link")
        for page in reader.pages
    )
    forbidden = re.findall(r"不是|而是", text)
    orphan_punctuation = [
        line for line in text.splitlines() if re.fullmatch(r"\s*[。；，、,.]\s*", line)
    ]

    print(f"PAGES={len(reader.pages)}")
    print(f"OUTLINE_ITEMS={len(flat)}")
    print(f"QUESTION_BOOKMARKS={len(question_bookmarks)}")
    print(f"LINK_ANNOTATIONS={link_annotations}")
    print(f"DIRECT_BLOCKS={len(direct_blocks)}")
    print(f"DIRECT_MIN={min(lengths) if lengths else -1}")
    print(f"DIRECT_MAX={max(lengths) if lengths else -1}")
    print(f"DIRECT_AVG={round(sum(lengths) / len(lengths), 1) if lengths else -1}")
    print(f"FORBIDDEN_COUNT={len(forbidden)}")
    print(f"ORPHAN_PUNCTUATION={len(orphan_punctuation)}")
    if orphan_punctuation:
        lines = text.splitlines()
        for index, line in enumerate(lines):
            if re.fullmatch(r"\s*[。；，、,.]\s*", line):
                print("ORPHAN_CONTEXT=" + " | ".join(lines[max(0, index - 2): index + 3]))

    assert len(question_bookmarks) == 160
    assert len(direct_blocks) == 160
    assert min(lengths) >= 300 and max(lengths) <= 500
    assert not forbidden
    assert not orphan_punctuation


if __name__ == "__main__":
    main()
